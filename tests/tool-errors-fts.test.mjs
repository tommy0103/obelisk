// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureFtsReady, TOOL_ERRORS_READY_MARKER } from '../packages/core/src/index-finalize.ts';
import { migrateFtsTokenizer } from '../packages/core/src/schema-migrations.ts';
import { persist } from '../packages/core/src/persist.ts';
import { runWriteTransaction, nodeSqliteTransactionAdapter, betterSqliteTransactionAdapter } from '../packages/core/src/tx.ts';
import { runCli } from './cli-test-helpers.mjs';
import { makeTempDir } from './temp-dirs.mjs';

const require = createRequire(import.meta.url);
const BetterSqlite = require('../app/node_modules/better-sqlite3');
const schema = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');
const oldSchema = schema.replace(/-- Only failed tool output[\s\S]*?(?=CREATE INDEX IF NOT EXISTS idx_messages_session)/, '');
const unit = { key: '/stored/session.jsonl', sessionId: 'session' };
function* resultRecords(content, is_error = 1) {
  yield { kind: 'tool_result', tool_use_id: 'call', message_uuid: 'message', session_id: 'session', content, file_path: null, is_error };
  return '1:1';
}
function hits(db, term) {
  return db.prepare('SELECT tool_use_id FROM tool_errors_fts WHERE tool_errors_fts MATCH ?').all(term).map(r => r.tool_use_id);
}
function insertResult(db, content = 'legacyneedle failure') {
  db.prepare('INSERT INTO tool_results(tool_use_id,session_id,content,is_error) VALUES(?,?,?,1)').run('call', 'session', content);
}

for (const [name, Database, adapter] of [
  ['node:sqlite', DatabaseSync, nodeSqliteTransactionAdapter],
  ['better-sqlite3', BetterSqlite, betterSqliteTransactionAdapter],
]) {
  test(`${name}: failed output follows real persist UPSERTs, recovery and session retraction without finalize`, () => {
    const db = new Database(':memory:');
    try {
      db.exec(schema);
      persist(db, unit, resultRecords('oldneedle failure'));
      assert.deepEqual(hits(db, 'oldneedle'), ['call']);
      persist(db, unit, resultRecords('newneedle failure'));
      persist(db, unit, resultRecords('newneedle failure'));
      assert.deepEqual(hits(db, 'oldneedle'), []);
      assert.deepEqual(hits(db, 'newneedle'), ['call']);
      assert.equal(db.prepare('SELECT count(*) n FROM tool_errors_fts').get().n, 1);
      persist(db, unit, resultRecords('successfulneedle output', 0));
      assert.deepEqual(hits(db, 'newneedle'), []);
      assert.deepEqual(hits(db, 'successfulneedle'), []);
      persist(db, unit, resultRecords('againneedle failure'));
      persist(db, unit, (function* () { yield { kind: 'delete-session', sessionId: 'session' }; return '2:1'; })());
      assert.deepEqual(hits(db, 'againneedle'), []);
    } finally { db.close(); }
  });

  test(`${name}: old ready indexes backfill once and interrupted finalize rolls back before healing`, () => {
    const db = new Database(':memory:');
    try {
      db.exec(oldSchema);
      insertResult(db);
      db.exec("INSERT INTO index_state(jsonl_path,mtime,lines_processed) VALUES('__fts_triggers_ready__',1,0)");
      db.exec(schema);
      const failing = {
        prepare: db.prepare.bind(db), close() {},
        exec(sql) { if (sql.startsWith('INSERT INTO tool_errors_fts(rowid')) throw new Error('injected backfill failure'); return db.exec(sql); },
      };
      assert.throws(() => runWriteTransaction(adapter(db), () => ensureFtsReady(failing)), /injected backfill failure/);
      assert.equal(db.prepare('SELECT 1 FROM index_state WHERE jsonl_path=?').get(TOOL_ERRORS_READY_MARKER), undefined);
      assert.deepEqual(hits(db, 'legacyneedle'), []);
      assert.equal(runWriteTransaction(adapter(db), () => ensureFtsReady(db)), true);
      assert.deepEqual(hits(db, 'legacyneedle'), ['call']);
      db.exec("INSERT INTO tool_errors_fts(rowid,content) VALUES(9999,'poisonneedle')");
      assert.equal(runWriteTransaction(adapter(db), () => ensureFtsReady(db)), false);
      assert.equal(hits(db, 'poisonneedle').length, 1, 'ordinary finalize performs no full refresh');
      assert.equal(runWriteTransaction(adapter(db), () => ensureFtsReady(db, { force: true })), true);
      assert.deepEqual(hits(db, 'poisonneedle'), []);
      assert.deepEqual(hits(db, 'legacyneedle'), ['call']);
    } finally { db.close(); }
  });

  test(`${name}: tokenizer swaps refill the contentful filtered index and roll back all indexes on failure`, () => {
    const db = new Database(':memory:');
    try {
      db.exec(schema);
      insertResult(db, '中文故障定位线索');
      db.exec("INSERT INTO messages(uuid,text) VALUES('m','unchangedneedle')");
      const before = db.prepare("SELECT sql FROM sqlite_master WHERE name='messages_fts'").get().sql;
      const wrapped = {
        prepare: db.prepare.bind(db), close() {},
        exec(sql) { if (sql.startsWith('INSERT INTO tool_errors_fts(rowid')) throw new Error('injected filtered refill failure'); return db.exec(sql); },
      };
      const stateKey = name === 'node:sqlite' ? 'isTransaction' : 'inTransaction';
      Object.defineProperty(wrapped, stateKey, { get: () => db[stateKey] });
      assert.throws(() => migrateFtsTokenizer(wrapped, 'trigram'), /injected filtered refill failure/);
      assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE name='messages_fts'").get().sql, before);
      assert.deepEqual(hits(db, '中文故障定位线索'), ['call']);
      migrateFtsTokenizer(db, 'trigram');
      assert.deepEqual(hits(db, '故障定位'), ['call']);
      persist(db, unit, resultRecords('更新故障线索'));
      assert.deepEqual(hits(db, '故障定位'), []);
      assert.deepEqual(hits(db, '更新故障'), ['call']);
      migrateFtsTokenizer(db, 'unicode61');
      assert.deepEqual(hits(db, '更新故障线索'), ['call']);
    } finally { db.close(); }
  });
}

test('CLI upgrades an existing ready index and force repairs failed-result FTS through its public entry point', () => {
  const home = makeTempDir('obelisk-cli-error-fts-');
  const dir = join(home, '.obelisk');
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'obelisk.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(oldSchema);
  insertResult(db);
  db.exec("INSERT INTO index_state(jsonl_path,mtime,lines_processed) VALUES('__fts_triggers_ready__',1,0)");
  db.close();
  const script = join(home, 'query.mjs');
  writeFileSync(script, "return sql(\"SELECT tool_use_id FROM tool_errors_fts WHERE tool_errors_fts MATCH ?\", 'legacyneedle');");
  const result = runCli(['--query', script], { home, env: { OBELISK_FTS_TOKENIZER: '' } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [{ tool_use_id: 'call' }]);
  const check = new DatabaseSync(dbPath);
  assert.ok(check.prepare('SELECT 1 FROM index_state WHERE jsonl_path=?').get(TOOL_ERRORS_READY_MARKER));
  check.exec("INSERT INTO tool_errors_fts(rowid,content) VALUES(9999,'poisonneedle')");
  check.close();
  const forced = runCli(['--build', '--force'], { home, env: { OBELISK_FTS_TOKENIZER: '' } });
  assert.equal(forced.status, 0, forced.stdout + forced.stderr);
  const after = new DatabaseSync(dbPath, { readOnly: true });
  assert.deepEqual(hits(after, 'poisonneedle'), []);
  after.close();
});

