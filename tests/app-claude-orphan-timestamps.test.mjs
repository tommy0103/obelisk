// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildIndex } from '../app/src/main/indexer.ts';
import { createClaudeProvider, CLAUDE_CANONICAL_TRANSCRIPT_MARKER } from '../packages/core/src/providers/claude.ts';
import { createProviderRegistry } from '../packages/core/src/providers/registry.ts';
import { createQueryApi } from '../packages/core/src/query.ts';
import { runCli } from './cli-test-helpers.mjs';
import { makeTempDir } from './temp-dirs.mjs';

const Database = createRequire(new URL('../app/package.json', import.meta.url))('better-sqlite3');
const captured = readFileSync(new URL('./fixtures/claude/custom-title-session.jsonl', import.meta.url), 'utf8')
  .trim().split('\n').map(JSON.parse).find(record => record.type === 'user');

for (const runtime of ['built CLI', 'App SQLite']) for (const version of [3, 4]) {
  test(`${runtime}: retained v${version} history remains retrievable by UTC time after refresh and rebuild`, () => {
    const home = makeTempDir('obelisk-orphan-time-migration-');
    const claudeDir = join(home, '.claude');
    const project = join(claudeDir, 'projects', 'project');
    const children = join(project, 'session', 'subagents');
    mkdirSync(children, { recursive: true });
    const main = join(project, 'session.jsonl');
    const removed = join(children, 'agent-b.jsonl');
    const write = (path, uuid, timestamp) => writeFileSync(path, JSON.stringify({
      ...captured, uuid, timestamp, sessionId: 'session', cwd: '/work/project',
    }) + '\n');
    write(main, 'cached-main', '2026-06-10T17:00:00+08:00');
    write(join(children, 'agent-a.jsonl'), 'readable-child', '2026-06-10T03:00:00-07:00');
    write(removed, 'cached-child', '2026-06-10T19:00:00+08:00');
    let dbPath = join(home, '.obelisk', 'obelisk.sqlite');
    const providerRegistry = createProviderRegistry([createClaudeProvider({ rootDir: claudeDir })]);
    const options = { sessionId: 'session', after: '2026-06-10T08:30:00.000Z', before: '2026-06-10T09:30:00.000Z' };
    const query = join(home, 'query.mjs');
    writeFileSync(query, `return messages(${JSON.stringify(options)});`);
    const inspect = work => { const db = new DatabaseSync(dbPath); try { return work(db); } finally { db.close(); } };
    const build = (force = false, preserveDbPath) => {
      if (runtime === 'built CLI') {
        const result = runCli(force ? ['--build'] : ['--query', query], { home });
        assert.equal(result.status, 0, result.stderr + result.stdout);
      } else {
        const result = buildIndex({ claudeDir, dbPath, providerRegistry, DatabaseImpl: Database, force, preserveDbPath });
        assert.equal(result.complete, true, JSON.stringify(result));
      }
    };
    build(true);
    inspect(db => {
      // Historical cached records use the installed schema but retain values
      // written before timestamp normalization. Source shape comes from capture.
      db.prepare('INSERT INTO summaries(id,session_id,timestamp,content) VALUES(?,?,?,?)')
        .run('cached-summary', 'session', '2026-06-10T17:00:00+08:00', 'retained summary');
      db.prepare('INSERT INTO workflows(run_id,session_id,timestamp,script) VALUES(?,?,?,?)')
        .run('cached-workflow', 'session', '2026-06-10T17:00:00+08:00', 'retained workflow');
    });
    unlinkSync(main);
    unlinkSync(removed);
    for (const mode of runtime === 'built CLI' ? ['refresh', 'force'] : ['refresh', 'force', 'replacement']) {
      inspect(db => {
        db.prepare("UPDATE messages SET timestamp='2026-06-10T17:00:00+08:00' WHERE uuid='cached-main'").run();
        db.prepare("UPDATE messages SET timestamp='2026-06-10T19:00:00+08:00' WHERE uuid='cached-child'").run();
        db.prepare("UPDATE sessions SET started_at='2026-06-10T17:00:00+08:00',ended_at='2026-06-10T19:00:00+08:00' WHERE id='session'").run();
        for (const table of ['summaries', 'workflows']) db.prepare(`UPDATE ${table} SET timestamp='2026-06-10T17:00:00+08:00' WHERE session_id='session'`).run();
        db.exec("DELETE FROM index_state WHERE jsonl_path LIKE '__claude_canonical_transcript_v%__' OR jsonl_path='__last_build__'");
        db.prepare('INSERT INTO index_state(jsonl_path,mtime,lines_processed) VALUES(?,0,0)')
          .run(`__claude_canonical_transcript_v${version}__`);
      });
      const previous = dbPath;
      if (mode === 'replacement') dbPath = join(home, 'replacement.sqlite');
      build(mode !== 'refresh', mode === 'replacement' ? previous : undefined);
      const snapshot = () => {
        // Node24 enforces the query API's read-only authorizer. Keep its
        // connection separate from writable FTS integrity inspection below.
        const queryDb = new DatabaseSync(dbPath, { readOnly: true });
        try {
          assert.deepEqual(createQueryApi(queryDb).messages(options).messages.map(row => row.uuid), ['cached-main'], mode);
        } finally { queryDb.close(); }
        return inspect(db => {
          assert.deepEqual(db.prepare('SELECT uuid,timestamp FROM messages ORDER BY uuid').all().map(row => [row.uuid, row.timestamp]), [
            ['cached-child', '2026-06-10T11:00:00.000Z'], ['cached-main', '2026-06-10T09:00:00.000Z'], ['readable-child', '2026-06-10T10:00:00.000Z'],
          ]);
          const session = db.prepare("SELECT message_count,started_at,ended_at FROM sessions WHERE id='session'").get();
          assert.equal(session.message_count, 3);
          assert.equal(session.started_at, '2026-06-10T09:00:00.000Z');
          assert.equal(session.ended_at, '2026-06-10T11:00:00.000Z');
          assert.equal(db.prepare("SELECT timestamp FROM summaries WHERE id='cached-summary'").get().timestamp, '2026-06-10T09:00:00.000Z');
          assert.equal(db.prepare("SELECT timestamp FROM workflows WHERE run_id='cached-workflow'").get().timestamp, '2026-06-10T09:00:00.000Z');
          assert.ok(db.prepare('SELECT 1 FROM index_state WHERE jsonl_path=?').get(CLAUDE_CANONICAL_TRANSCRIPT_MARKER));
          db.exec("INSERT INTO messages_fts(messages_fts,rank) VALUES('integrity-check',1)");
          return db.prepare('SELECT uuid,timestamp,text FROM messages ORDER BY uuid').all();
        });
      };
      const before = snapshot();
      build(mode !== 'refresh');
      assert.deepEqual(snapshot(), before, 'repeated refresh/rebuild preserves the repaired history');
      if (runtime === 'built CLI') {
        const result = runCli(['--query', query], { home });
        assert.equal(result.status, 0, result.stderr + result.stdout);
        assert.deepEqual(JSON.parse(result.stdout).messages.map(row => row.uuid), ['cached-main']);
      }
    }
  });
}

test('retained legacy history repairs all UTC rows without changing unknown times, other sources or canonical rows again', async () => {
  const { repairOrphanedSessionMetadata, ensureFtsReady } = await import('../packages/core/src/index-finalize.ts');
  const db = new DatabaseSync(':memory:');
  const home = makeTempDir('obelisk-orphan-time-batches-');
  const readable = join(home, 'readable.jsonl');
  writeFileSync(readable, JSON.stringify(captured) + '\n');
  db.exec(readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8'));
  const session = db.prepare('INSERT INTO sessions(id,source,jsonl_path,message_count,started_at,ended_at) VALUES(?,?,?,?,?,?)');
  session.run('orphan', 'claude', join(home, 'gone.jsonl'), 603, '2026-06-10T17:00:00+08:00', '2026-06-10T17:00:00+08:00');
  session.run('hermes', 'hermes', 'store.db#session', 1, null, null);
  session.run('readable', 'claude', readable, 1, null, null);
  const message = db.prepare('INSERT INTO messages(uuid,session_id,agent_id,source,timestamp,text) VALUES(?,?,?,?,?,?)');
  const summary = db.prepare('INSERT INTO summaries(id,session_id,timestamp,content) VALUES(?,?,?,?)');
  const workflow = db.prepare('INSERT INTO workflows(run_id,session_id,timestamp,script) VALUES(?,?,?,?)');
  db.exec('BEGIN');
  for (let index = 0; index < 600; index++) {
    message.run(`message-${index}`, 'orphan', 'child', 'claude', '2026-06-10T17:00:00+08:00', 'cached evidence');
    summary.run(`summary-${index}`, 'orphan', '2026-06-10T17:00:00+08:00', 'cached summary');
    workflow.run(`workflow-${index}`, 'orphan', '2026-06-10T17:00:00+08:00', 'cached workflow');
  }
  for (const [id, timestamp] of [['naive', '2026-06-10T17:00:00'], ['unknown', 'not-a-date'], ['null', null]]) {
    message.run(id, 'orphan', 'child', 'claude', timestamp, 'unchanged timestamp evidence');
  }
  for (const id of ['hermes', 'readable']) message.run(id, id, 'child', id === 'hermes' ? 'hermes' : 'claude', '2026-06-10T17:00:00+08:00', 'unchanged source');
  db.exec('COMMIT');
  try {
    ensureFtsReady(db);
    assert.equal(repairOrphanedSessionMetadata(db), 1);
    for (const table of ['messages', 'summaries', 'workflows']) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id='orphan' AND timestamp='2026-06-10T09:00:00.000Z'`).get().n, 600);
    }
    for (const [id, timestamp] of [['naive', '2026-06-10T17:00:00'], ['unknown', 'not-a-date'], ['null', null]]) {
      assert.equal(db.prepare('SELECT timestamp FROM messages WHERE uuid=?').get(id).timestamp, timestamp);
    }
    for (const id of ['hermes', 'readable']) assert.equal(db.prepare('SELECT timestamp FROM messages WHERE uuid=?').get(id).timestamp, '2026-06-10T17:00:00+08:00');
    const totalChanges = () => db.prepare('SELECT total_changes() AS n').get().n;
    const before = totalChanges();
    assert.equal(repairOrphanedSessionMetadata(db), 0);
    assert.equal(totalChanges(), before, 'already-repaired history does not churn FTS or canonical tables');
    db.exec("INSERT INTO messages_fts(messages_fts,rank) VALUES('integrity-check',1)");
  } finally { db.close(); }
});
