// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildIndex as buildAppIndex } from '../app/src/main/indexer.ts';
import { persist } from '../packages/core/src/persist.ts';
import { makeTempDir } from './temp-dirs.mjs';
const require = createRequire(import.meta.url);
const BetterSqlite = require('../app/node_modules/better-sqlite3');
const schema = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');
const oldSchema = schema.replace(/-- Only failed tool output[\s\S]*?(?=CREATE INDEX IF NOT EXISTS idx_messages_session)/, '');
const unit = { key: '/stored/session.jsonl', sessionId: 'session' };
function* resultRecords(content) {
  yield { kind: 'tool_result', tool_use_id: 'call', message_uuid: 'message', session_id: 'session', content, file_path: null, is_error: 1 };
  return '1:1';
}
function hits(db, term) {
  return db.prepare('SELECT tool_use_id FROM tool_errors_fts WHERE tool_errors_fts MATCH ?').all(term).map(r => r.tool_use_id);
}
function insertResult(db) {
  db.prepare('INSERT INTO tool_results(tool_use_id,session_id,content,is_error) VALUES(?,?,?,1)').run('call', 'session', 'legacyneedle failure');
}

test('app existing-index backfill, incremental trigger maintenance and force repair share the same policy', () => {
  const home = makeTempDir('obelisk-app-error-fts-');
  const dbPath = join(home, 'index.sqlite');
  const db = new BetterSqlite(dbPath);
  db.exec(oldSchema);
  insertResult(db);
  db.exec("INSERT INTO index_state(jsonl_path,mtime,lines_processed) VALUES('__fts_triggers_ready__',1,0)");
  db.close();
  const options = { dbPath, claudeDir: join(home, '.claude'), providerSettings: {} };
  assert.equal(buildAppIndex(options).ftsRebuilt, true);
  const check = new BetterSqlite(dbPath);
  assert.deepEqual(hits(check, 'legacyneedle'), ['call']);
  persist(check, unit, resultRecords('incrementalneedle failure'));
  assert.deepEqual(hits(check, 'legacyneedle'), []);
  assert.deepEqual(hits(check, 'incrementalneedle'), ['call']);
  check.exec("INSERT INTO tool_errors_fts(rowid,content) VALUES(9999,'poisonneedle')");
  check.close();
  assert.equal(buildAppIndex(options).ftsRebuilt, false);
  assert.equal(buildAppIndex({ ...options, force: true }).ftsRebuilt, true);
  const after = new BetterSqlite(dbPath);
  assert.deepEqual(hits(after, 'poisonneedle'), []);
  after.close();
});
