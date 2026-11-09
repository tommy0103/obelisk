// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { repoRoot, runCli } from './cli-test-helpers.mjs';
import { makeTempDir } from './temp-dirs.mjs';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const cliPackage = JSON.parse(readFileSync(join(repoRoot, 'packages', 'cli', 'package.json'), 'utf8'));

test('the packaged obelisk command preserves the runtime query envelope', () => {
  const home = makeTempDir('obelisk-cli-package-');
  const query = join(home, 'query.mjs');
  writeFileSync(query, 'return { answer: 42 };');

  const result = runCli(['--query', query], { home });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, '{\n  "answer": 42\n}\n');
});

test('obelisk --version reports the installed CLI package version', () => {
  const result = runCli(['--version']);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, `${cliPackage.version}\n`);
  assert.equal(result.stderr, '');
});

test('CLI test process suppresses only Node ExperimentalWarning output', () => {
  const home = makeTempDir('obelisk-cli-warning-');
  const preload = join(home, 'warnings.cjs');
  writeFileSync(preload, `
    process.emitWarning('simulated SQLite warning', 'ExperimentalWarning');
    process.emitWarning('ordinary warning stays visible', 'ObeliskTestWarning');
  `);

  const result = runCli(['--version'], {
    home,
    env: { NODE_OPTIONS: `--require=${preload}` },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stderr, /simulated SQLite warning/);
  assert.match(result.stderr, /ordinary warning stays visible/);
});

test('obelisk install delegates official skill installation to the skills CLI', () => {
  const home = makeTempDir('obelisk-cli-install-');
  const fakeBin = join(home, 'bin');
  const capture = join(home, 'args.json');
  const captureScript = join(home, 'capture.mjs');
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(captureScript, `import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.OBELISK_TEST_CAPTURE, JSON.stringify(process.argv.slice(2)));\n`);

  if (process.platform === 'win32') {
    writeFileSync(
      join(fakeBin, 'npx.cmd'),
      `@echo off\r\n"${process.execPath}" "${captureScript}" %*\r\n`,
    );
  } else {
    const fakeNpx = join(fakeBin, 'npx');
    writeFileSync(fakeNpx, `#!/bin/sh\nexec "${process.execPath}" "${captureScript}" "$@"\n`);
    chmodSync(fakeNpx, 0o755);
  }

  const result = runCli(['install', '--global', '--agent', 'codex'], {
    home,
    env: {
      PATH: `${fakeBin}${delimiter}${process.env.PATH || ''}`,
      OBELISK_TEST_CAPTURE: capture,
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')), [
    '--yes',
    'skills',
    'add',
    'tommy0103/obelisk-skill',
    '--global',
    '--agent',
    'codex',
  ]);
});

test('npm pack installs one platform-neutral CLI with its schema resource', () => {
  const root = makeTempDir('obelisk-cli-pack-');
  const packDir = join(root, 'pack');
  const prefix = join(root, 'prefix');
  const npmCache = join(root, 'npm-cache');
  const npmEnv = { ...process.env, npm_config_cache: npmCache };
  mkdirSync(packDir, { recursive: true });

  const packed = JSON.parse(execFileSync(
    npmCommand,
    [
      'pack',
      '--workspace',
      '@obelisk-apps/cli',
      '--pack-destination',
      packDir,
      '--json',
      '--ignore-scripts',
    ],
    {
      cwd: repoRoot,
      env: npmEnv,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ));
  const metadata = packed[0];
  const paths = metadata.files.map(file => file.path);
  assert.ok(paths.includes('dist/cli/src/obelisk.js'));
  assert.ok(paths.includes('dist/core/src/schema.sql'));
  assert.equal(paths.some(path => path.endsWith('.ts')), false);

  const tarball = join(packDir, metadata.filename);
  execFileSync(
    npmCommand,
    ['install', '--global', '--prefix', prefix, tarball, '--ignore-scripts'],
    {
      cwd: repoRoot,
      env: npmEnv,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      stdio: 'pipe',
    },
  );

  const installedBin = process.platform === 'win32'
    ? join(prefix, 'obelisk.cmd')
    : join(prefix, 'bin', 'obelisk');
  const result = spawnSync(installedBin, ['--version'], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), cliPackage.version);
});
