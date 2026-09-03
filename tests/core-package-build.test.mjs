// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const coreDist = join(repoRoot, 'packages', 'core', 'dist');

test('build:core emits an importable package with its schema resource', async () => {
  execFileSync('npm', ['run', 'build:core'], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' });

  assert.ok(existsSync(join(coreDist, 'schema.sql')), 'compiled Core is missing schema.sql');
  const core = await import(`${pathToFileURL(join(coreDist, 'core.js')).href}?test=${Date.now()}`);
  assert.equal(typeof core.buildIndex, 'function');
  assert.equal(typeof core.searchText, 'function');
  assert.equal(typeof core.executeQuery, 'function');
  assert.equal(typeof core.executeAttune, 'function');

  const omp = await import(`${pathToFileURL(join(coreDist, 'providers', 'omp.js')).href}?test=${Date.now()}`);
  assert.equal(typeof omp.createOmpProvider, 'function');
  assert.equal(omp.ompProvider.descriptor.id, 'omp');

  const pi = await import(`${pathToFileURL(join(coreDist, 'providers', 'pi.js')).href}?test=${Date.now()}`);
  assert.equal(typeof pi.createPiProvider, 'function');
  assert.equal(pi.piProvider.descriptor.id, 'pi');
});
