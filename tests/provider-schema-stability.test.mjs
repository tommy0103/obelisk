// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { ATTUNE_MEMORY_COLUMNS, ATTUNE_MEMORY_TRIGGERS } from '../packages/core/src/db.ts';

test('canonical transcript persistence schema changes only by explicit decision', () => {
  const schema = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url));
  assert.equal(
    createHash('sha256').update(schema).digest('hex'),
    // 2026-08-24: indexed Activity queries and the visible main session timeline.
    '0417d1a044a574a9adc8f347db5f46428a984e89900504bb082ce7366ebb1d4a',
  );
});

test('attune memory-layer expectations derive from schema.sql', () => {
  // The attune compatibility check derives its expected memory-layer shape
  // from schema.sql at module load. Pin the derivation result so a schema
  // evolution (or a format change that breaks the derivation) surfaces here
  // as an explicit decision, never as a silent behavior change.
  assert.deepEqual([...ATTUNE_MEMORY_COLUMNS], [
    'id', 'session_id', 'project', 'message_start', 'message_end',
    'path', 'anchors', 'summary', 'created_at', 'deleted_at', 'deleted_reason',
  ]);
  assert.deepEqual([...ATTUNE_MEMORY_TRIGGERS], [
    'memories_fts_ai', 'memories_fts_ad', 'memories_fts_au',
  ]);
});
