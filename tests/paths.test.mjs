// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveObeliskPaths, warnLegacyStorageIgnored } from '../packages/core/src/paths.ts';
import { runCli } from './cli-test-helpers.mjs';
import { makeTempDir } from './temp-dirs.mjs';

test('OBELISK_HOME has highest precedence and expands a leading tilde', () => {
  const paths = resolveObeliskPaths({
    homeDir: '/home/probe',
    env: {
      OBELISK_HOME: '~/portable/obelisk',
      OBELISK_USE_XDG: '1',
      XDG_CONFIG_HOME: '/xdg/config',
      XDG_DATA_HOME: '/xdg/data',
    },
    pathExists: path => path === '/home/probe/.obelisk',
  });

  assert.equal(paths.layout, 'custom');
  assert.equal(paths.configDir, '/home/probe/portable/obelisk');
  assert.equal(paths.dataDir, '/home/probe/portable/obelisk');
  assert.equal(paths.settingsPath, '/home/probe/portable/obelisk/settings.json');
  assert.equal(paths.dbPath, '/home/probe/portable/obelisk/obelisk.sqlite');
  assert.equal(paths.writerLockPath, '/home/probe/portable/obelisk/writer.lock.sqlite');
  assert.equal(paths.recapDir, '/home/probe/portable/obelisk/recap');
});

test('OBELISK_HOME must resolve to an absolute path', () => {
  assert.throws(
    () => resolveObeliskPaths({
      homeDir: '/home/probe',
      env: { OBELISK_HOME: 'portable/obelisk' },
    }),
    /OBELISK_HOME must be an absolute path or begin with ~/,
  );
});

test('an existing legacy directory wins over opt-in XDG paths', () => {
  const paths = resolveObeliskPaths({
    homeDir: '/home/probe',
    env: {
      OBELISK_USE_XDG: '1',
      XDG_CONFIG_HOME: '/xdg/config',
      XDG_DATA_HOME: '/xdg/data',
    },
    pathExists: path => path === '/home/probe/.obelisk',
  });

  assert.equal(paths.layout, 'legacy');
  assert.equal(paths.configDir, '/home/probe/.obelisk');
  assert.equal(paths.dataDir, '/home/probe/.obelisk');
});

test('OBELISK_USE_XDG splits settings from index data', () => {
  const paths = resolveObeliskPaths({
    homeDir: '/home/probe',
    env: {
      OBELISK_USE_XDG: '1',
      XDG_CONFIG_HOME: '/xdg/config',
      XDG_DATA_HOME: '/xdg/data',
    },
    pathExists: () => false,
  });

  assert.equal(paths.layout, 'xdg');
  assert.equal(paths.configDir, '/xdg/config/obelisk');
  assert.equal(paths.dataDir, '/xdg/data/obelisk');
  assert.equal(paths.settingsPath, '/xdg/config/obelisk/settings.json');
  assert.equal(paths.dbPath, '/xdg/data/obelisk/obelisk.sqlite');
  assert.equal(paths.writerLockPath, '/xdg/data/obelisk/writer.lock.sqlite');
  assert.equal(paths.recapDir, '/xdg/data/obelisk/recap');
});

test('missing or relative XDG directories fall back to per-user defaults', () => {
  const paths = resolveObeliskPaths({
    homeDir: '/home/probe',
    env: {
      OBELISK_USE_XDG: '1',
      XDG_CONFIG_HOME: 'relative/config',
      XDG_DATA_HOME: '',
    },
    pathExists: () => false,
  });

  assert.equal(paths.configDir, '/home/probe/.config/obelisk');
  assert.equal(paths.dataDir, '/home/probe/.local/share/obelisk');
});

test('XDG is opt-in and other flag values keep the legacy default', () => {
  const paths = resolveObeliskPaths({
    homeDir: '/home/probe',
    env: { OBELISK_USE_XDG: 'true' },
    pathExists: () => false,
  });

  assert.equal(paths.layout, 'legacy');
  assert.equal(paths.configDir, '/home/probe/.obelisk');
  assert.equal(paths.dataDir, '/home/probe/.obelisk');
});

test('custom layouts warn instead of copying an old Claude database', () => {
  const home = makeTempDir('obelisk-custom-storage-');
  const legacyDbPath = join(home, '.claude', 'obelisk.sqlite');
  const configHome = join(home, 'xdg-config');
  const dataHome = join(home, 'xdg-data');
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(legacyDbPath, 'legacy database sentinel');

  const result = runCli(['--build'], {
    home,
    env: {
      OBELISK_HOME: '',
      OBELISK_USE_XDG: '1',
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(
    JSON.parse(result.stdout).db,
    join(dataHome, 'obelisk', 'obelisk.sqlite'),
  );
  assert.equal(readFileSync(legacyDbPath, 'utf8'), 'legacy database sentinel');
  assert.equal(
    existsSync(join(dataHome, 'obelisk', 'obelisk.sqlite')),
    true,
  );
  assert.match(result.stderr, /was not copied to the selected layout/);
  assert.match(result.stderr, /advanced-configuration/);
});

test('legacy storage warning reports the advanced configuration documentation', () => {
  const paths = resolveObeliskPaths({
    homeDir: '/home/probe',
    env: { OBELISK_HOME: '/portable/obelisk' },
    pathExists: path => path === '/home/probe/.claude/obelisk.sqlite',
  });
  const warnings = [];

  assert.equal(
    warnLegacyStorageIgnored(paths, {
      pathExists: path => path === paths.legacyDbPath,
      warn: message => warnings.push(message),
    }),
    paths.legacyDbPath,
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /https:\/\/github\.com\/tommy0103\/obelisk#advanced-configuration/);
});

test('an existing legacy directory alone does not trigger a Claude database warning', () => {
  const paths = resolveObeliskPaths({
    homeDir: '/home/probe',
    env: { OBELISK_HOME: '/portable/obelisk' },
    pathExists: () => false,
  });

  const warnings = [];
  assert.equal(
    warnLegacyStorageIgnored(paths, {
      pathExists: path => path === paths.legacyDir,
      warn: message => warnings.push(message),
    }),
    null,
  );
  assert.deepEqual(warnings, []);
});
