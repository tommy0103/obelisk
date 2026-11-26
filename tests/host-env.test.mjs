// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { repoRoot } from './cli-test-helpers.mjs';
import { HOST_STORE_ENV_KEYS } from './host-env.mjs';

// Variables the code reads that name no store a test could leak into.
const NOT_A_STORE = new Set([
  // Windows system directories; tests that depend on them set them explicitly.
  'APPDATA', 'LOCALAPPDATA',
  // Electron dev-server URLs.
  'ELECTRON_RENDERER_URL', 'OBELISK_DEV_SERVER_URL',
]);

function sourceFiles(dir) {
  return readdirSync(dir, { recursive: true })
    .filter(name => /\.(ts|mts|js|mjs|vue)$/.test(name) && !name.endsWith('.d.ts'))
    .map(name => join(dir, name));
}

test('test processes start without host store variables', () => {
  for (const key of HOST_STORE_ENV_KEYS) {
    assert.equal(process.env[key], undefined, `${key} is inherited; run the suite with npm test`);
  }
});

test('every environment variable the code reads is cleared for tests or names no store', () => {
  const roots = ['packages/core/src', 'packages/cli/src', 'app/src'].map(dir => join(repoRoot, dir));
  const read = new Set();
  for (const file of roots.flatMap(sourceFiles)) {
    for (const match of readFileSync(file, 'utf8').matchAll(/\benv(?:\.|\[['"])([A-Z][A-Z0-9_]{2,})\b/g)) {
      read.add(match[1]);
    }
  }
  const uncovered = [...read].filter(key => !HOST_STORE_ENV_KEYS.includes(key) && !NOT_A_STORE.has(key));
  assert.deepEqual(uncovered, [], 'add each variable to HOST_STORE_ENV_KEYS in tests/host-env.mjs, or to NOT_A_STORE here');
});
