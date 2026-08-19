// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// The wholesale messages_fts rebuild no longer runs in every incremental
// finalize: the schema triggers (ai/au/ad) plus persist's upsert keep the index
// consistent row-by-row, and the one-time heal is recorded under the
// __messages_fts_synced__ marker in index_state.
//
// The "did the rebuild run?" probe is a poison posting: a row inserted straight
// into messages_fts with no counterpart in messages. A wholesale rebuild
// regenerates the index from the content table and clears it; trigger-only
// maintenance leaves it alone. So poison surviving an incremental build proves
// the rebuild was skipped, and poison vanishing across a force build proves the
// full path kept its last line of defence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, appendFileSync, utimesSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

import { runCli } from './cli-test-helpers.mjs';
import { makeTempDir } from './temp-dirs.mjs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');
const SYNC_MARKER = '__messages_fts_synced__';

function line(uuid, type, ts, text = `${type} ${uuid}`) {
  return JSON.stringify({ uuid, type, timestamp: ts, cwd: '/tmp/proj', message: { role: type, content: text } });
}

function withDb(home, fn) {
  const db = new DatabaseSync(join(home, '.obelisk', 'obelisk.sqlite'));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function clearBuildDebounce(home) {
  withDb(home, (db) => db.prepare("DELETE FROM index_state WHERE jsonl_path='__last_build__'").run());
}

function ftsHits(db, query) {
  return db.prepare('SELECT COUNT(*) c FROM messages_fts WHERE messages_fts MATCH ?').get(query).c;
}

function markerPresent(db) {
  return db.prepare('SELECT 1 ok FROM index_state WHERE jsonl_path=?').get(SYNC_MARKER) !== undefined;
}

function assertFtsMatchesContentTable(db) {
  // rank=1 makes FTS5 verify the index against the external content table;
  // a stale or orphaned posting raises SQLITE_CORRUPT_VTAB.
  db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1)");
}

test('incremental build keeps messages_fts consistent without the wholesale rebuild', () => {
  const home = makeTempDir('obelisk-ftsmark-');
  const projDir = join(home, '.claude', 'projects', '-tmp-proj');
  mkdirSync(projDir, { recursive: true });
  const jsonl = join(projDir, 'sess.jsonl');

  writeFileSync(jsonl, [line('u1', 'user', '2026-06-10T10:00:00Z'), line('a1', 'assistant', '2026-06-10T10:00:05Z')].join('\n') + '\n');
  assert.equal(runCli(['--build'], { home }).status, 0);

  withDb(home, (db) => {
    assert.equal(markerPresent(db), true, 'the force build records the one-time FTS sync marker');
    // Poison: a posting with no messages row behind it.
    db.prepare('INSERT INTO messages_fts(rowid, uuid, session_id, text) VALUES (?,?,?,?)')
      .run(999999, 'poison', 'sess', 'poisonword');
    assert.equal(ftsHits(db, 'poisonword'), 1, 'poison posting is searchable before the incremental build');
  });

  appendFileSync(jsonl, line('u2', 'user', '2026-06-10T10:01:00Z', 'freshneedle content') + '\n');
  const t = statSync(jsonl).mtimeMs / 1000 + 10;
  utimesSync(jsonl, t, t);
  clearBuildDebounce(home);

  // --query triggers the non-force incremental build before answering.
  writeFileSync(join(home, 'q.mjs'), "return { hits: sql(\"SELECT COUNT(*) c FROM messages_fts WHERE messages_fts MATCH 'freshneedle'\")[0].c };");
  const r = runCli(['--query', join(home, 'q.mjs')], { home });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.equal(JSON.parse(r.stdout).hits, 1, 'the appended message is searchable via the triggers alone');

  withDb(home, (db) => {
    assert.equal(ftsHits(db, 'poisonword'), 1, 'poison survived: the incremental build did not run the wholesale rebuild');
  });
});

test('force build keeps the wholesale rebuild and re-records the marker it wiped', () => {
  const home = makeTempDir('obelisk-ftsmark-force-');
  const projDir = join(home, '.claude', 'projects', '-tmp-proj');
  mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, 'sess.jsonl'), line('u1', 'user', '2026-06-10T10:00:00Z') + '\n');
  assert.equal(runCli(['--build'], { home }).status, 0);

  withDb(home, (db) => {
    db.prepare('INSERT INTO messages_fts(rowid, uuid, session_id, text) VALUES (?,?,?,?)')
      .run(999999, 'poison', 'sess', 'poisonword');
  });
  clearBuildDebounce(home);
  assert.equal(runCli(['--build'], { home }).status, 0);

  withDb(home, (db) => {
    assert.equal(ftsHits(db, 'poisonword'), 0, 'the force build regenerated the index from the content table');
    assert.equal(markerPresent(db), true, 'the marker is re-recorded after DELETE FROM index_state');
    assertFtsMatchesContentTable(db);
  });
});

test('a pre-marker index gets exactly one healing rebuild on its next incremental build', () => {
  const home = makeTempDir('obelisk-ftsmark-heal-');
  const projDir = join(home, '.claude', 'projects', '-tmp-proj');
  mkdirSync(projDir, { recursive: true });
  const jsonl = join(projDir, 'sess.jsonl');
  writeFileSync(jsonl, line('u1', 'user', '2026-06-10T10:00:00Z') + '\n');
  assert.equal(runCli(['--build'], { home }).status, 0);

  // Simulate an index written before trigger-only maintenance: drop the marker
  // and poison the index, the way stale postings from INSERT OR REPLACE looked.
  withDb(home, (db) => {
    db.prepare('DELETE FROM index_state WHERE jsonl_path=?').run(SYNC_MARKER);
    db.prepare('INSERT INTO messages_fts(rowid, uuid, session_id, text) VALUES (?,?,?,?)')
      .run(999999, 'poison', 'sess', 'poisonword');
  });

  appendFileSync(jsonl, line('u2', 'user', '2026-06-10T10:01:00Z') + '\n');
  const t = statSync(jsonl).mtimeMs / 1000 + 10;
  utimesSync(jsonl, t, t);
  clearBuildDebounce(home);
  writeFileSync(join(home, 'q.mjs'), 'return sql("SELECT COUNT(*) c FROM messages")[0].c;');
  assert.equal(runCli(['--query', join(home, 'q.mjs')], { home }).status, 0);

  withDb(home, (db) => {
    assert.equal(ftsHits(db, 'poisonword'), 0, 'the marker-less index was healed by a one-time rebuild');
    assert.equal(markerPresent(db), true, 'the heal recorded the marker');
    assertFtsMatchesContentTable(db);
  });
});

test("persist's upsert and delete write shapes keep the triggers truthful", () => {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);

  // Same conflict clause shape as persist.ts st.msg — the write the finalize
  // rebuild used to bail out.
  const upsert = db.prepare(`
    INSERT INTO messages (uuid, session_id, text) VALUES (?,?,?)
    ON CONFLICT(uuid) DO UPDATE SET text=excluded.text`);
  upsert.run('m1', 's1', 'oldword here');
  assert.equal(ftsHits(db, 'oldword'), 1, 'insert path indexes the text');

  upsert.run('m1', 's1', 'newword here');
  assert.equal(ftsHits(db, 'oldword'), 0, 'the AU trigger removed the replaced text');
  assert.equal(ftsHits(db, 'newword'), 1, 'the AU trigger indexed the replacement');

  db.prepare('DELETE FROM messages WHERE session_id=?').run('s1');
  assert.equal(ftsHits(db, 'newword'), 0, 'the AD trigger removed deleted rows from the index');
  assertFtsMatchesContentTable(db);
  db.close();
});
