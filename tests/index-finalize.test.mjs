// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';

import {
  FTS_TRIGGERS_READY_MARKER,
  PROJECT_PATH_BACKFILL_MARKER,
  backfillUnresolvedSessionProjectPathsOnce,
  ensureFtsReady,
  refreshSessionProjectPaths,
} from '../packages/core/src/index-finalize.ts';
import { persist } from '../packages/core/src/persist.ts';
import { runCli } from './cli-test-helpers.mjs';
import { makeTempDir } from './temp-dirs.mjs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');
const REAL_PI_FIXTURE = new URL('./fixtures/pi/real-model-session.jsonl', import.meta.url);

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

function insertPathSession(db, id, project, projectPath = '/stale/project') {
  db.prepare('INSERT INTO sessions (id, project, project_path, source) VALUES (?, ?, ?, ?)')
    .run(id, project, projectPath, 'claude');
}

function insertCwd(db, id, sequence, cwd, timestamp = `2026-08-31T00:00:0${sequence}Z`) {
  db.prepare(`
    INSERT INTO messages (uuid, session_id, type, timestamp, role, text, content_type, cwd, source)
    VALUES (?, ?, 'user', ?, 'user', ?, 'text', ?, 'claude')
  `).run(`cwd-${id}-${sequence}`, id, timestamp, `text-${id}-${sequence}`, cwd);
}

function sessionProjectPath(db, id) {
  return db.prepare('SELECT project_path FROM sessions WHERE id = ?').get(id).project_path;
}

function* sessionRecords(text) {
  yield {
    kind: 'message', uuid: 'persisted-message', session_id: 'persisted-session',
    type: 'assistant', parent_uuid: null, timestamp: '2026-08-31T00:00:00Z',
    role: 'assistant', text, content_type: 'text', is_meta: 0, visibility: 'visible',
    model: null, is_sidechain: 0, agent_id: null, input_tokens: null,
    output_tokens: null, cwd: '/work/persisted', skill: null, source: 'claude',
  };
  yield {
    kind: 'session', id: 'persisted-session', title: null, project: '-work-persisted',
    started_at: '2026-08-31T00:00:00Z', ended_at: '2026-08-31T00:00:00Z',
    git_branch: null, version: null, message_count: 1, countMode: 'total',
    jsonl_path: '/source/persisted.jsonl', source: 'claude',
  };
  return '1:1';
}

function* deletionRecords() {
  yield { kind: 'delete-session', sessionId: 'persisted-session' };
  return '2:1';
}

const PERSIST_UNIT = {
  key: '/source/persisted.jsonl',
  sessionId: 'persisted-session',
  project: '-work-persisted',
};

test('ordinary scoped project-path refresh derives unresolved affected sessions only', () => {
  const db = freshDb();
  insertSession(db, 'affected', null);
  insertSession(db, 'resolved', '/stable/resolved');
  insertSession(db, 'unaffected', null);

  refreshSessionProjectPaths(db, new Set(['affected', 'resolved']));

  assert.equal(sessionProjectPath(db, 'affected'), normalize('/work/affected'));
  assert.equal(sessionProjectPath(db, 'resolved'), '/stable/resolved');
  assert.equal(sessionProjectPath(db, 'unaffected'), null);
  db.close();
});

test('force project-path refresh recomputes an already resolved stable root', () => {
  const db = freshDb();
  insertPathSession(db, 'repair', '-Users-me-quiet-zero', '/stale/project');
  insertCwd(db, 'repair', 1, '/Users/me/quiet-zero');
  insertCwd(db, 'repair', 2, '/Users/me/quiet-zero/apps');
  insertCwd(db, 'repair', 3, '/Users/me/quiet-zero');

  refreshSessionProjectPaths(db, new Set(['repair']), { recompute: true });

  assert.equal(sessionProjectPath(db, 'repair'), normalize('/Users/me/quiet-zero'));
  db.close();
});

test('project-path inference normalizes, filters, counts, and orders cwd observations', () => {
  const db = freshDb();
  insertPathSession(db, 'matrix', '-Users-me-repo', null);
  insertCwd(db, 'matrix', 1, '/repo/ignored');
  insertCwd(db, 'matrix', 2, '/repo/app/../app');
  insertCwd(db, 'matrix', 3, null);
  insertCwd(db, 'matrix', 4, 'relative/path');
  insertCwd(db, 'matrix', 5, '');
  insertCwd(db, 'matrix', 6, '/repo/app');
  insertCwd(db, 'matrix', 7, '/repo/app');

  refreshSessionProjectPaths(db, new Set(['matrix']));

  assert.equal(sessionProjectPath(db, 'matrix'), normalize('/repo/app'));
  db.close();
});

test('project-path inference uses first observation to break frequency ties', () => {
  const db = freshDb();
  insertPathSession(db, 'tie', '-Users-me-repo', null);
  insertCwd(db, 'tie', 1, '/repo/first', '2026-08-31T00:00:02Z');
  insertCwd(db, 'tie', 2, '/repo/second', '2026-08-31T00:00:01Z');
  insertCwd(db, 'tie', 3, '/repo/first', '2026-08-31T00:00:03Z');
  insertCwd(db, 'tie', 4, '/repo/second', '2026-08-31T00:00:04Z');
  insertCwd(db, 'tie', 5, '/repo/late-null', null);

  refreshSessionProjectPaths(db, new Set(['tie']));

  assert.equal(sessionProjectPath(db, 'tie'), normalize('/repo/second'));
  db.close();
});

test('project-path inference falls back to the legacy project slug when cwd is unusable', () => {
  const db = freshDb();
  insertPathSession(db, 'legacy', '-Users-me-repo', null);
  insertCwd(db, 'legacy', 1, null);
  insertCwd(db, 'legacy', 2, 'relative/path');
  insertCwd(db, 'legacy', 3, '');

  refreshSessionProjectPaths(db, new Set(['legacy']));

  assert.equal(sessionProjectPath(db, 'legacy'), '/Users/me/repo');
  db.close();
});

test('project-path inference leaves the existing path when cwd and slug are unusable', () => {
  const db = freshDb();
  insertPathSession(db, 'unknown', '', '/existing/unknown');
  insertCwd(db, 'unknown', 1, 'relative/path');

  refreshSessionProjectPaths(db, new Set(['unknown']));

  assert.equal(sessionProjectPath(db, 'unknown'), '/existing/unknown');
  db.close();
});

test('project-path inference gives non-null timestamps precedence over null timestamps', () => {
  const db = freshDb();
  insertPathSession(db, 'null-order', '-Users-me-repo', null);
  insertCwd(db, 'null-order', 1, '/repo/null-first', null);
  insertCwd(db, 'null-order', 2, '/repo/timestamped', '2026-08-31T00:00:01Z');

  refreshSessionProjectPaths(db, new Set(['null-order']));

  assert.equal(sessionProjectPath(db, 'null-order'), normalize('/repo/timestamped'));
  db.close();
});

test('legacy unresolved project paths are backfilled once, not on every finalize', () => {
  const db = freshDb();
  insertSession(db, 'repairable', null);
  db.prepare("INSERT INTO sessions (id, project, project_path, source) VALUES ('permanent', NULL, NULL, 'claude')").run();

  assert.equal(backfillUnresolvedSessionProjectPathsOnce(db), true);
  assert.equal(
    db.prepare("SELECT project_path FROM sessions WHERE id='repairable'").get().project_path,
    normalize('/work/repairable'),
  );
  assert.equal(db.prepare("SELECT project_path FROM sessions WHERE id='permanent'").get().project_path, null);
  assert.ok(db.prepare('SELECT 1 FROM index_state WHERE jsonl_path = ?').get(PROJECT_PATH_BACKFILL_MARKER));

  insertSession(db, 'later', null);
  assert.equal(backfillUnresolvedSessionProjectPathsOnce(db), false);
  assert.equal(db.prepare("SELECT project_path FROM sessions WHERE id='later'").get().project_path, null);
  refreshSessionProjectPaths(db, new Set(['later']));
  assert.equal(
    db.prepare("SELECT project_path FROM sessions WHERE id='later'").get().project_path,
    normalize('/work/later'),
    'the backfill marker never blocks the affected-unit repair path',
  );
  db.close();
});

test('legacy project-path backfill retries cleanly after transaction rollback', () => {
  const db = freshDb();
  insertSession(db, 'rollback', null);

  db.exec('BEGIN');
  assert.equal(backfillUnresolvedSessionProjectPathsOnce(db), true);
  db.exec('ROLLBACK');
  assert.equal(db.prepare("SELECT project_path FROM sessions WHERE id='rollback'").get().project_path, null);
  assert.equal(db.prepare('SELECT 1 FROM index_state WHERE jsonl_path = ?').get(PROJECT_PATH_BACKFILL_MARKER), undefined);

  db.exec('BEGIN');
  assert.equal(backfillUnresolvedSessionProjectPathsOnce(db), true);
  db.exec('COMMIT');
  assert.equal(
    db.prepare("SELECT project_path FROM sessions WHERE id='rollback'").get().project_path,
    normalize('/work/rollback'),
  );
  assert.ok(db.prepare('SELECT 1 FROM index_state WHERE jsonl_path = ?').get(PROJECT_PATH_BACKFILL_MARKER));
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

test('persist update and delete shapes keep trigger-maintained FTS consistent', () => {
  const db = freshDb();
  persist(db, PERSIST_UNIT, sessionRecords('oldword'));
  ensureFtsReady(db);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages_fts WHERE messages_fts MATCH 'oldword'").get().count, 1);

  persist(db, PERSIST_UNIT, sessionRecords('newword'));
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages_fts WHERE messages_fts MATCH 'oldword'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages_fts WHERE messages_fts MATCH 'newword'").get().count, 1);

  persist(db, PERSIST_UNIT, deletionRecords());
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages_fts WHERE messages_fts MATCH 'newword'").get().count, 0);
  db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1)");
  db.close();
});

test('ordinary Core build skips corpus-wide FTS and project-path work', () => {
  const home = makeTempDir('obelisk-finalize-integration-');
  const piDir = join(home, '.pi', 'agent', 'sessions', 'project');
  mkdirSync(piDir, { recursive: true });
  copyFileSync(REAL_PI_FIXTURE, join(piDir, 'session.jsonl'));
  assert.equal(runCli(['--build'], { home }).status, 0);

  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
  let db = new DatabaseSync(dbPath);
  const session = db.prepare("SELECT id FROM sessions WHERE source='pi'").get();
  assert.ok(session?.id);
  db.prepare('INSERT INTO messages_fts(rowid, uuid, session_id, text) VALUES (?,?,?,?)')
    .run(999999, 'poison', session.id, 'poisonword');
  db.prepare('UPDATE sessions SET project_path = ? WHERE id = ?').run('/stale/unaffected', session.id);
  db.prepare("DELETE FROM index_state WHERE jsonl_path='__last_build__'").run();
  db.close();

  const result = runCli(['--search', 'REAL_PI_PROBE_OK', '--nonce', 'REAL_PI_PROBE_OK'], { home });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  db = new DatabaseSync(dbPath);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM messages_fts WHERE messages_fts MATCH 'poisonword'").get().count,
    1,
    'poison survives because ordinary finalize did not rebuild the complete FTS index',
  );
  assert.equal(
    db.prepare('SELECT project_path FROM sessions WHERE id = ?').get(session.id).project_path,
    '/stale/unaffected',
    'an unchanged session is not included in ordinary project-path refresh',
  );
  db.close();
});
