// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Tests for readRecentTranscriptHints (ADR-0009 hot-set seeding). The SQL
// semantics (mtime ordering, marker exclusion, LIMIT) run against a real
// in-memory SQLite — a fake db with pre-ordered rows would pass even if the
// ORDER BY were deleted. Directory expansion uses temp files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { readRecentTranscriptHints } from '../packages/core/src/provider-indexing.ts';
import { makeTempDir } from './temp-dirs.mjs';

function hintsDb(rows) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE index_state (jsonl_path TEXT, mtime INTEGER, lines_processed INTEGER, cursor TEXT)');
  const insert = db.prepare('INSERT INTO index_state (jsonl_path, mtime, lines_processed) VALUES (?, ?, 0)');
  for (const row of rows) insert.run(row.path, row.mtime);
  return db;
}

test('hints are the most recently written transcripts, markers excluded, limit honored', () => {
  const root = makeTempDir('obelisk-hints-sql-');
  // 70 real transcript files with shuffled mtimes, plus two marker rows
  // whose Date.now() mtimes would sort first if markers leaked through.
  const files = Array.from({ length: 70 }, (_, i) => {
    const file = join(root, `session-${String(i).padStart(3, '0')}.jsonl`);
    fs.writeFileSync(file, '{}\n');
    return file;
  });
  const rows = files.map((path, i) => ({ path, mtime: (i * 37) % 70 }));
  rows.push({ path: '__last_build__', mtime: Date.now() });
  rows.push({ path: '__claude_canonical_transcript_v1__', mtime: Date.now() });
  const db = hintsDb(rows);

  const hints = readRecentTranscriptHints(db);
  assert.equal(hints.length, 64, 'the hint limit applies');
  assert.ok(hints.every((h) => !h.startsWith('__')), 'marker rows never leak into hints');
  const mtimeOf = (file) => (files.indexOf(file) * 37) % 70;
  const mtimes = hints.map(mtimeOf);
  assert.deepEqual(mtimes, [...mtimes].sort((a, b) => b - a),
    'hints arrive in non-increasing mtime order');
  assert.equal(mtimes[0], 69, 'the most recently written transcript sorts first');
  db.close();
});

test('missing keys are dropped and directory keys expand to contained transcripts', () => {
  const root = makeTempDir('obelisk-hints-dir-');
  const file = join(root, 'plain.jsonl');
  fs.writeFileSync(file, '{}\n');
  // A Kimi-style unit key: a session directory with a nested wire file.
  const sessionDir = join(root, 'session-1');
  const wire = join(sessionDir, 'agents', 'main', 'wire.jsonl');
  fs.mkdirSync(join(sessionDir, 'agents', 'main'), { recursive: true });
  fs.writeFileSync(wire, '{}\n');
  const gone = join(root, 'deleted.jsonl');

  const db = hintsDb([
    { path: file, mtime: 300 },
    { path: sessionDir, mtime: 200 },
    { path: gone, mtime: 100 },
  ]);

  const hints = readRecentTranscriptHints(db);
  assert.ok(hints.includes(file), 'plain file keys pass through');
  assert.ok(hints.includes(wire), 'a directory key expands to the wire transcript inside');
  assert.ok(!hints.includes(sessionDir), 'the directory key itself is not a hint');
  assert.ok(!hints.includes(gone), 'a key deleted after the build is dropped');
  db.close();
});

test('directory expansion ranks wire files by mtime, not readdir order', () => {
  // A real Kimi session dir holds several wire files; the actively appended
  // main wire is the most recently written one. DFS order would pick stale
  // agent wires first and never seed the main transcript.
  const root = makeTempDir('obelisk-hints-order-');
  const sessionDir = join(root, 'session-9');
  const mainDir = join(sessionDir, 'agents', 'main');
  fs.mkdirSync(mainDir, { recursive: true });
  const mainWire = join(mainDir, 'wire.jsonl');
  fs.writeFileSync(mainWire, '{}\n');
  const agentWires = [];
  for (let i = 0; i < 7; i++) {
    const wire = join(sessionDir, 'agents', `agent-${i}`, 'wire.jsonl');
    fs.mkdirSync(join(sessionDir, 'agents', `agent-${i}`), { recursive: true });
    fs.writeFileSync(wire, '{}\n');
    agentWires.push(wire);
  }
  // agent-* wires sort before main in readdir order; give them all OLDER
  // mtimes and make the main wire the newest.
  const old = new Date('2026-08-01T00:00:00Z');
  for (const wire of agentWires) fs.utimesSync(wire, old, old);
  fs.utimesSync(mainWire, new Date(), new Date());

  const db = hintsDb([{ path: sessionDir, mtime: 100 }]);
  const hints = readRecentTranscriptHints(db);
  assert.ok(hints.includes(mainWire), 'the actively written main wire is selected');
  assert.ok(hints.length <= 4, 'directory expansion stays bounded');
  db.close();
});
