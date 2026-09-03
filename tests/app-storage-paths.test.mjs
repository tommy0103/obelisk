// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { makeTempDir } from './temp-dirs.mjs';

const repoRoot = join(import.meta.dirname, '..');
const appIndexerUrl = pathToFileURL(join(repoRoot, 'app', 'src', 'main', 'indexer.ts')).href;
const registryUrl = pathToFileURL(join(repoRoot, 'packages', 'core', 'src', 'providers', 'registry.ts')).href;

function buildAppIndex(home, env = {}) {
  const script = `
    const { buildIndex } = await import(${JSON.stringify(appIndexerUrl)});
    const { createProviderRegistry } = await import(${JSON.stringify(registryUrl)});
    const result = buildIndex({ providerRegistry: createProviderRegistry([]) });
    process.stdout.write(JSON.stringify(result));
  `;
  return spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        OBELISK_HOME: '',
        OBELISK_USE_XDG: '',
        XDG_CONFIG_HOME: '',
        XDG_DATA_HOME: '',
        ...env,
      },
      encoding: 'utf8',
    },
  );
}

test('Electron indexer uses the shared OBELISK_HOME database path', () => {
  const home = makeTempDir('obelisk-app-storage-');
  const customHome = join(home, 'portable', 'obelisk');
  const result = buildAppIndex(home, { OBELISK_HOME: customHome });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).complete, true);
  assert.equal(existsSync(join(customHome, 'obelisk.sqlite')), true);
  assert.equal(existsSync(join(customHome, 'writer.lock.sqlite')), true);
  assert.equal(existsSync(join(home, '.obelisk', 'obelisk.sqlite')), false);
});

test('Electron indexer uses XDG data when explicitly opted in', () => {
  const home = makeTempDir('obelisk-app-xdg-storage-');
  const configHome = join(home, 'config');
  const dataHome = join(home, 'data');
  const result = buildAppIndex(home, {
    OBELISK_USE_XDG: '1',
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).complete, true);
  assert.equal(existsSync(join(configHome, 'obelisk', 'settings.json')), false);
  assert.equal(existsSync(join(dataHome, 'obelisk', 'obelisk.sqlite')), true);
  assert.equal(existsSync(join(dataHome, 'obelisk', 'writer.lock.sqlite')), true);
  assert.equal(existsSync(join(home, '.obelisk', 'obelisk.sqlite')), false);
});
