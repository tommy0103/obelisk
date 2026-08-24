import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

test('canonical transcript persistence schema changes only by explicit decision', () => {
  const schema = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url));
  assert.equal(
    createHash('sha256').update(schema).digest('hex'),
    '12c54c5a75f3feb6b3dcedca9377f45c7746ecbde3d210a2276c14fa7c875e6c',
  );
});
