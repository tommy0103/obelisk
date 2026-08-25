// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Phase 5b-2b: verifies incremental (resume) indexing through the full rewired
// buildIndex path (needsReindex → cursor → claude.parse → persist). A force
// --build re-scans everything (skip=0) and never exercises resume, so this
// appends new lines to an already-indexed session and drives an incremental
// build. The 30s shouldSkipBuild debounce is cleared between steps (it would
// otherwise skip a build this soon after the previous one).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, appendFileSync, utimesSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { runCli } from './cli-test-helpers.mjs';
import { makeTempDir } from './temp-dirs.mjs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

function runRuntime(args, home) {
  return runCli(args, { home });
}

function line(uuid, type, ts) {
  return JSON.stringify({ uuid, type, timestamp: ts, cwd: '/tmp/proj', message: { role: type, content: `${type} ${uuid}` } });
}

function clearBuildDebounce(home) {
  const db = new DatabaseSync(join(home, '.obelisk', 'obelisk.sqlite'));
  db.prepare("DELETE FROM index_state WHERE jsonl_path='__last_build__'").run();
  db.close();
}

function counts(home) {
  writeFileSync(join(home, 'q.mjs'), "return { mc: sql(\"SELECT message_count FROM sessions WHERE id='sess'\")[0]?.message_count ?? null, n: sql('SELECT COUNT(*) c FROM messages')[0].c, lp: sql(\"SELECT lines_processed lp FROM index_state WHERE jsonl_path LIKE '%sess.jsonl'\")[0]?.lp ?? null };");
  const r = runRuntime(['--query', join(home, 'q.mjs')], home);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return JSON.parse(r.stdout);
}

test('incremental buildIndex resumes from cursor and accumulates message_count', () => {
  const home = makeTempDir('obelisk-incr-');
  const projDir = join(home, '.claude', 'projects', '-tmp-proj');
  mkdirSync(projDir, { recursive: true });
  const jsonl = join(projDir, 'sess.jsonl');

  writeFileSync(jsonl, [line('u1', 'user', '2026-06-10T10:00:00Z'), line('a1', 'assistant', '2026-06-10T10:00:05Z')].join('\n') + '\n');
  assert.equal(runRuntime(['--build'], home).status, 0);

  const afterBuild = counts(home);
  assert.equal(afterBuild.mc, 2, 'full build indexed both messages');
  assert.equal(afterBuild.n, 2);
  assert.equal(afterBuild.lp, 2, 'cursor recorded 2 lines processed');

  // Append two messages; bump mtime so needsReindex detects the change.
  appendFileSync(jsonl, [line('u2', 'user', '2026-06-10T10:01:00Z'), line('a2', 'assistant', '2026-06-10T10:01:05Z')].join('\n') + '\n');
  const t = statSync(jsonl).mtimeMs / 1000 + 10;
  utimesSync(jsonl, t, t);
  clearBuildDebounce(home);

  // Incremental build: resume at line 2, add exactly the two new messages.
  // mc=4 proves resume+accumulate; 6 would mean re-count from stale base, 2 a miss.
  const afterAppend = counts(home);
  assert.equal(afterAppend.mc, 4, 'message_count accumulated to 4');
  assert.equal(afterAppend.n, 4, 'exactly four messages, no duplicates');
  assert.equal(afterAppend.lp, 4, 'cursor advanced to 4 lines');
});

test('force build purges sessions for deleted files and preserves memories', () => {
  const home = makeTempDir('obelisk-force-');
  const projDir = join(home, '.claude', 'projects', '-tmp-proj');
  mkdirSync(projDir, { recursive: true });
  const keep = join(projDir, 'keep.jsonl');
  const gone = join(projDir, 'gone.jsonl');
  writeFileSync(keep, line('k1', 'user', '2026-06-10T10:00:00Z') + '\n');
  writeFileSync(gone, line('g1', 'user', '2026-06-10T10:00:00Z') + '\n');
  assert.equal(runRuntime(['--build'], home).status, 0);

  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
  let db = new DatabaseSync(dbPath);
  // Seed a durable memory that must survive a clean rebuild.
  db.prepare("INSERT INTO memories (id, path, summary, created_at) VALUES ('mem-keep', '/tmp/proj/.obelisk/memories/x.md', 'durable note', '2026-06-10T10:00:00Z')").run();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sessions').get().c, 2, 'both sessions indexed initially');
  db.close();

  // Delete one transcript, then force a clean rebuild (`--build` is always force).
  rmSync(gone);
  clearBuildDebounce(home);
  assert.equal(runRuntime(['--build'], home).status, 0);

  db = new DatabaseSync(dbPath);
  const sessionIds = db.prepare('SELECT id FROM sessions ORDER BY id').all().map(r => r.id);
  const messageCount = db.prepare('SELECT COUNT(*) c FROM messages').get().c;
  const memoryAlive = db.prepare("SELECT COUNT(*) c FROM memories WHERE id='mem-keep' AND deleted_at IS NULL").get().c;
  db.close();

  assert.deepEqual(sessionIds, ['keep'], 'stale session for the deleted file is purged');
  assert.equal(messageCount, 1, 'only the surviving file\'s message remains');
  assert.equal(memoryAlive, 1, 'the durable memory survived the force rebuild');
});
