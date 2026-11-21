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
  assert.equal(omp.createOmpProvider().descriptor.id, 'omp');

  const pi = await import(`${pathToFileURL(join(coreDist, 'providers', 'pi.js')).href}?test=${Date.now()}`);
  assert.equal(typeof pi.createPiProvider, 'function');
  assert.equal(pi.createPiProvider().descriptor.id, 'pi');

  const copilot = await import(`${pathToFileURL(join(coreDist, 'providers', 'copilot.js')).href}?test=${Date.now()}`);
  assert.equal(typeof copilot.createCopilotProvider, 'function');
  assert.equal(copilot.createCopilotProvider().descriptor.id, 'copilot');

  const usf = await import('@obelisk/core/usf');
  const assembled = usf.assembleUsf([{
    kind: 'message', uuid: 'package-usf', session_id: 'package-session', role: 'user',
    timestamp: null, text: 'hello', visibility: 'visible', source: 'test',
  }]);
  assert.equal(assembled.sessions[0].session.turns[0].steps[0].content, 'hello');
  assert.deepEqual(usf.validateUsf(assembled.sessions[0].session), []);
  assert.deepEqual(usf.validateUsf(usf.publishedUsf(assembled.sessions[0].session), { profile: 'published' }), []);
});
