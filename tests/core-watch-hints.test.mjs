// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Tests for readRecentTranscriptHints (ADR-0009 hot-set seeding): hints are
// the most recently written transcripts read from index_state — markers
// excluded, missing keys dropped, directory unit keys (Kimi session dirs)
// expanded to the transcripts they contain.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';

import { readRecentTranscriptHints } from '../packages/core/src/provider-indexing.ts';
import { makeTempDir } from './temp-dirs.mjs';

function fakeDb(rows) {
  const captured = { sql: null };
  const db = {
    prepare(sql) {
      captured.sql = sql;
      return { all: (limit) => rows.slice(0, limit) };
    },
  };
  return { db, captured };
}

test('hints are most-recent-first, markers excluded by the query', () => {
  const root = makeTempDir('obelisk-hints-core-');
  const fileA = join(root, 'a.jsonl');
  const fileB = join(root, 'b.jsonl');
  fs.writeFileSync(fileA, '{}\n');
  fs.writeFileSync(fileB, '{}\n');
  const { db, captured } = fakeDb([{ jsonl_path: fileB }, { jsonl_path: fileA }]);

  const hints = readRecentTranscriptHints(db);
  assert.deepEqual(hints, [fileB, fileA], 'rows arrive mtime-ordered from the query');
  assert.match(captured.sql, /NOT LIKE/, 'marker rows are excluded in SQL');
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

  const { db } = fakeDb([
    { jsonl_path: file },
    { jsonl_path: sessionDir },
    { jsonl_path: gone },
  ]);

  const hints = readRecentTranscriptHints(db);
  assert.ok(hints.includes(file), 'plain file keys pass through');
  assert.ok(hints.includes(wire), 'a directory key expands to the wire transcript inside');
  assert.ok(!hints.includes(sessionDir), 'the directory key itself is not a hint');
  assert.ok(!hints.includes(gone), 'a key deleted after the build is dropped');
});
