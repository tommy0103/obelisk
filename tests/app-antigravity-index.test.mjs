// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// The Antigravity provider through the app indexer and the built CLI, using the
// captured step log in fixtures/antigravity (see its README).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildIndex } from '../app/src/main/indexer.ts';
import { antigravitySessionId } from '../packages/core/src/providers/antigravity.ts';
import { runCli } from './cli-test-helpers.mjs';
import { makeTempDir } from './temp-dirs.mjs';

const fixture = name => readFileSync(new URL(`./fixtures/antigravity/${name}`, import.meta.url), 'utf8');
const CONVERSATION = '0f0e0d0c-0b0a-4908-8706-050403020100';
const SESSION = antigravitySessionId(CONVERSATION);

function seedTranscript(root) {
  const dir = join(root, 'brain', CONVERSATION, '.system_generated', 'logs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'transcript_full.jsonl'), fixture('conversation-a.jsonl'));
}

// conversation_summaries.db as Antigravity defines it.
function seedSummaries(root, title) {
  const path = join(root, 'conversation_summaries.db');
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  db.exec(fixture('conversation_summaries.sql'));
  db.prepare('INSERT INTO conversation_summaries (conversation_id, title, workspace_uris, last_modified_time, last_user_input_time) VALUES (?, ?, ?, ?, ?)')
    .run(CONVERSATION, title, '', '2026-01-02 03:04:05+00:00', '2026-01-02 03:04:05+00:00');
  db.close();
  return path;
}

test('the app indexer reads conversation_summaries.db through its own read-only SQLite binding', () => {
  const home = makeTempDir('obelisk-antigravity-app-');
  const root = join(home, '.gemini', 'antigravity');
  seedTranscript(root);
  const summaries = seedSummaries(root, 'Example conversation title');
  const before = readFileSync(summaries);
  const opened = [];
  // Stands in for better-sqlite3, which the app passes to every store-backed provider.
  class RecordingDatabase {
    constructor(path, options) {
      opened.push([path, options]);
      this.db = new DatabaseSync(path, options?.readonly ? { readOnly: true } : {});
    }
    pragma(statement) { this.db.exec(`PRAGMA ${statement}`); }
    exec(sql) { return this.db.exec(sql); }
    prepare(sql) { return this.db.prepare(sql); }
    close() { return this.db.close(); }
  }
  const indexPath = join(home, '.obelisk', 'obelisk.sqlite');
  buildIndex({ claudeDir: join(home, '.claude'), providerRoots: { antigravity: root }, dbPath: indexPath, DatabaseImpl: RecordingDatabase });
  assert.deepEqual(opened.filter(([path]) => path === summaries).map(([, options]) => options),
    [{ readonly: true, fileMustExist: true, timeout: 500 }]);
  assert.deepEqual(readFileSync(summaries), before);
  const index = new DatabaseSync(indexPath, { readOnly: true });
  try {
    assert.deepEqual({ ...index.prepare("SELECT id, title, message_count FROM sessions WHERE source = 'antigravity'").get() },
      { id: SESSION, title: 'Example conversation title', message_count: 24 });
  } finally {
    index.close();
  }
});

test('the CLI indexes the default Antigravity root and finds a request through search()', () => {
  const home = makeTempDir('obelisk-antigravity-cli-');
  const root = join(home, '.gemini', 'antigravity');
  seedTranscript(root);
  seedSummaries(root, 'Example conversation title');
  writeFileSync(join(home, 'q.mjs'), `return {
    sessions: sessions({ source: 'antigravity' }).map(row => [row.id, row.title]),
    hits: search('request a57', { source: 'antigravity', limit: 5 }).map(hit => hit.message.uuid),
  };`);
  const result = runCli(['--query', join(home, 'q.mjs')], { home });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const out = JSON.parse(result.stdout);
  assert.deepEqual(out.sessions, [[SESSION, 'Example conversation title']]);
  assert.ok(out.hits.includes(`${SESSION}:L000036`), JSON.stringify(out));
});
