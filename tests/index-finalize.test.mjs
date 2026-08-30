// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

import {
  FTS_TRIGGERS_READY_MARKER,
  ensureFtsReady,
  refreshSessionProjectPaths,
} from '../packages/core/src/index-finalize.ts';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}

function insertSession(db, id, projectPath) {
  db.prepare('INSERT INTO sessions (id, project, project_path, source) VALUES (?, ?, ?, ?)')
    .run(id, `-${id}`, projectPath, 'claude');
  db.prepare(`
    INSERT INTO messages (uuid, session_id, type, timestamp, role, text, content_type, cwd, source)
    VALUES (?, ?, 'user', '2026-08-31T00:00:00Z', 'user', ?, 'text', ?, 'claude')
  `).run(`message-${id}`, id, `text-${id}`, `/work/${id}`);
}

test('scoped project-path refresh touches affected and unresolved sessions only', () => {
  const db = freshDb();
  insertSession(db, 'affected', '/stale/affected');
  insertSession(db, 'unaffected', '/stale/unaffected');
  insertSession(db, 'unresolved', null);

  refreshSessionProjectPaths(db, new Set(['affected']));

  const projectPath = id => db.prepare('SELECT project_path FROM sessions WHERE id = ?').get(id).project_path;
  assert.equal(projectPath('affected'), '/work/affected');
  assert.equal(projectPath('unresolved'), '/work/unresolved');
  assert.equal(projectPath('unaffected'), '/stale/unaffected');
  db.close();
});

test('FTS readiness skips ordinary rebuilds and force repairs the complete index', () => {
  const db = freshDb();
  insertSession(db, 'indexed', '/work/indexed');

  assert.equal(ensureFtsReady(db), true);
  assert.ok(db.prepare('SELECT 1 FROM index_state WHERE jsonl_path = ?').get(FTS_TRIGGERS_READY_MARKER));

  db.prepare('INSERT INTO messages_fts(rowid, uuid, session_id, text) VALUES (?, ?, ?, ?)')
    .run(999999, 'poison', 'indexed', 'poisonword');
  db.prepare(`
    INSERT INTO messages (uuid, session_id, type, role, text, content_type, source)
    VALUES ('fresh', 'indexed', 'user', 'user', 'freshneedle', 'text', 'claude')
  `).run();

  assert.equal(ensureFtsReady(db), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages_fts WHERE messages_fts MATCH 'poisonword'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages_fts WHERE messages_fts MATCH 'freshneedle'").get().count, 1);

  assert.equal(ensureFtsReady(db, { force: true }), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages_fts WHERE messages_fts MATCH 'poisonword'").get().count, 0);
  db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1)");
  db.close();
});
