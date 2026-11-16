// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const rendererRoot = join(repoRoot, 'app', 'src', 'renderer');

function rendererSources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return rendererSources(path);
    return /\.(vue|js|mjs|html)$/.test(entry.name) ? [path] : [];
  });
}

// Virtualized rows already mount near the viewport; lazy loading only moves
// image decode into the scroll itself (CONTRIBUTING, renderer changes).
test('renderer images never opt into lazy loading', () => {
  const lazy = /\bloading\s*(=|:)\s*["'`]lazy["'`]|setAttribute\(\s*["'`]loading["'`]\s*,\s*["'`]lazy["'`]/;
  const offenders = rendererSources(rendererRoot)
    .filter(path => lazy.test(readFileSync(path, 'utf8')))
    .map(path => relative(repoRoot, path));
  assert.deepEqual(offenders, []);
});
