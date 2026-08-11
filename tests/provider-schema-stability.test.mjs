import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

test('canonical transcript persistence schema changes only by explicit decision', () => {
  const schema = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url));
  assert.equal(
    createHash('sha256').update(schema).digest('hex'),
    // 2026-08-11: added idx_messages_time on messages(timestamp) so the
    // invocation-nonce resolver can bound its tool_calls scan to recent rows.
    '712df79e346a09f753deeb951f975c36f0148bfe047df68830fbc7e172aec09a',
  );
});
