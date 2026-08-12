import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { ATTUNE_MEMORY_COLUMNS, ATTUNE_MEMORY_TRIGGERS } from '../packages/core/src/db.ts';

test('canonical transcript persistence schema changes only by explicit decision', () => {
  const schema = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url));
  assert.equal(
    createHash('sha256').update(schema).digest('hex'),
    // 2026-08-11: added idx_messages_time on messages(timestamp) so the
    // invocation-nonce resolver can bound its tool_calls scan to recent rows.
    '712df79e346a09f753deeb951f975c36f0148bfe047df68830fbc7e172aec09a',
  );
});

test('attune memory-layer expectations stay in sync with schema.sql', () => {
  const schema = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');
  const memoriesBlock = schema.match(/CREATE TABLE IF NOT EXISTS memories \(([^;]+)\);/s)?.[1];
  assert.ok(memoriesBlock);
  const columns = memoriesBlock.split(',').map(part => part.trim().split(/\s+/)[0]);
  assert.deepEqual([...ATTUNE_MEMORY_COLUMNS], columns);

  const triggers = [...schema.matchAll(/CREATE TRIGGER IF NOT EXISTS (memories_fts_\w+)/g)].map(match => match[1]);
  assert.deepEqual([...ATTUNE_MEMORY_TRIGGERS], triggers);
});
