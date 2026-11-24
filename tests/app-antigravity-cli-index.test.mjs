// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { buildIndex } from '../app/src/main/indexer.ts';
import { createBuiltinProviderRegistry } from '../packages/core/src/providers/builtins.ts';
import { antigravityCliSessionId } from '../packages/core/src/providers/antigravity-cli.ts';
import { makeTempDir } from './temp-dirs.mjs';

const requireFromApp = createRequire(new URL('../app/package.json', import.meta.url));
const BetterSqlite = requireFromApp('better-sqlite3');

function isolatedSettings(antigravityCliRoot) {
  const providerRoots = Object.fromEntries(
    createBuiltinProviderRegistry().catalog().map((descriptor) => [descriptor.id, '']),
  );
  providerRoots['antigravity-cli'] = antigravityCliRoot;
  return { providerRoots };
}

function seedSummaryDb(rootDir, rows) {
  const dbPath = join(rootDir, 'conversation_summaries.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      workspace_uris TEXT NOT NULL DEFAULT '[]',
      parent_conversation_id TEXT NOT NULL DEFAULT '',
      nesting_depth INTEGER NOT NULL DEFAULT 0
    );
  `);
  const insert = db.prepare(`
    INSERT INTO conversation_summaries (conversation_id, title, workspace_uris, parent_conversation_id, nesting_depth)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    insert.run(
      row.id,
      row.title ?? '',
      JSON.stringify(row.workspaceUris ?? []),
      row.parentConversationId ?? '',
      row.nestingDepth ?? 0,
    );
  }
  db.close();
  return dbPath;
}

function seedTranscript(rootDir, conversationId, lines) {
  const logsDir = join(rootDir, 'brain', conversationId, '.system_generated', 'logs');
  mkdirSync(logsDir, { recursive: true });
  const filePath = join(logsDir, 'transcript_full.jsonl');
  writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return filePath;
}

function clearDebounce(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("DELETE FROM index_state WHERE jsonl_path='__last_build__'").run();
  } finally {
    db.close();
  }
}

function queryRows(dbPath, sql, ...params) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all(...params).map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

test('app indexer indexes antigravity-cli via better-sqlite3, preserves metadata under lock, and retains deleted transcripts', () => {
  const home = makeTempDir('obelisk-app-ag-cli-');
  const cliRoot = join(home, 'antigravity-cli');
  const workspaceDir = join(home, 'repo-one');
  mkdirSync(cliRoot, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });

  const convId = '66666666-6666-4666-8666-666666666666';
  const sessionId = antigravityCliSessionId(convId);
  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
  const providerSettings = isolatedSettings(cliRoot);

  const summaryDbPath = seedSummaryDb(cliRoot, [
    {
      id: convId,
      title: 'App Initial Title',
      workspaceUris: [pathToFileURL(workspaceDir).href],
    },
  ]);
  const transcriptPath = seedTranscript(cliRoot, convId, [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-23T10:00:00Z',
      content: '<USER_REQUEST>\nApp indexer smoke check\n</USER_REQUEST>',
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-23T10:00:02Z',
      content: 'App indexer reply.',
    },
  ]);

  const runBuild = (force = false) => {
    if (!force) clearDebounce(dbPath);
    return buildIndex({
      claudeDir: join(home, '.claude'),
      dbPath,
      providerSettings,
      force,
    });
  };

  // 1. Initial build via real better-sqlite3 opener
  const first = runBuild(true);
  assert.equal(first.complete, true);
  assert.deepEqual(first.incompleteProviders, []);

  const readSession = () => queryRows(
    dbPath,
    'SELECT id, title, project, source, message_count FROM sessions WHERE id = ?',
    sessionId,
  )[0];
  const initialSession = readSession();
  assert.equal(initialSession.title, 'App Initial Title');
  assert.equal(initialSession.source, 'antigravity-cli');
  assert.equal(initialSession.message_count, 2);
  assert.ok(initialSession.project);
  const expectedProject = initialSession.project;

  // 2. Real exclusive write lock on conversation_summaries.db preserves title and project
  const locker = new BetterSqlite(summaryDbPath);
  locker.exec('BEGIN EXCLUSIVE');
  try {
    const locked = runBuild(false);
    assert.equal(locked.complete, false);
    assert.equal(locked.incompleteProviders.includes('antigravity-cli'), true);
    assert.equal(readSession().title, 'App Initial Title');
    assert.equal(readSession().project, expectedProject);

    locker.prepare('UPDATE conversation_summaries SET title = ? WHERE conversation_id = ?')
      .run('App Updated Title', convId);
    locker.exec('COMMIT');
  } finally {
    locker.close();
  }

  // 3. Unlock picks up the updated title cleanly
  const unlocked = runBuild(false);
  assert.equal(unlocked.complete, true);
  assert.deepEqual(unlocked.incompleteProviders, []);
  assert.equal(readSession().title, 'App Updated Title');
  assert.equal(readSession().project, expectedProject);

  // 4. Deleting the source transcript retains cached history across normal and force builds
  rmSync(transcriptPath);
  const afterDelete = runBuild(false);
  assert.equal(afterDelete.complete, true);
  assert.equal(readSession().title, 'App Updated Title');

  const afterForce = runBuild(true);
  assert.equal(afterForce.complete, true);
  assert.equal(readSession().title, 'App Updated Title');
  assert.equal(
    queryRows(dbPath, 'SELECT COUNT(*) AS count FROM messages WHERE session_id = ?', sessionId)[0].count,
    2,
  );
});
