// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { repoRoot } from './cli-test-helpers.mjs';
import { makeTempDir } from './temp-dirs.mjs';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const shell = process.platform === 'win32';
const packageVersion = JSON.parse(readFileSync(join(repoRoot, 'packages/cli/package.json'), 'utf8')).version;
let tarball;

before(() => {
  const destination = makeTempDir('obelisk-skill-tarball-');
  const packed = JSON.parse(execFileSync(npm, [
    'pack', '--workspace', '@obelisk-apps/cli', '--ignore-scripts', '--json', '--pack-destination', destination,
  ], { cwd: repoRoot, env: { ...process.env, npm_config_cache: join(destination, 'cache') }, shell, encoding: 'utf8', stdio: 'pipe' }));
  assert.ok(packed[0].files.some(file => file.path === 'scripts/postinstall.mjs'));
  tarball = join(destination, packed[0].filename);
});

function install({ global = false, skip = false, fail = false } = {}) {
  const root = makeTempDir('obelisk-npm-skill-');
  const userDir = join(root, 'user');
  const project = join(root, 'project');
  const prefix = join(root, 'prefix');
  const bin = join(root, 'bin');
  const capture = join(root, 'skills-call.json');
  const fakeInstaller = join(root, 'skills.mjs');
  for (const path of [userDir, project, bin]) mkdirSync(path, { recursive: true });
  writeFileSync(fakeInstaller, `
import { writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
writeFileSync(process.env.OBELISK_TEST_SKILLS_CAPTURE, JSON.stringify({
  args: process.argv.slice(2), cwd: process.cwd(), global: process.env.npm_config_global,
}));
if (process.env.OBELISK_TEST_SKILLS_FAIL === '1') process.exit(7);
const destination = join(process.argv.includes('--global') ? homedir() : process.cwd(), '.agents', 'skills', 'obelisk');
mkdirSync(destination, { recursive: true });
cpSync(process.env.OBELISK_TEST_SKILL_SOURCE, destination, { recursive: true });
`);
  if (shell) {
    writeFileSync(join(bin, 'npx.cmd'), `@echo off\r\n"${process.execPath}" "${fakeInstaller}" %*\r\n`);
  } else {
    const command = join(bin, 'npx');
    writeFileSync(command, `#!/bin/sh\nexec "${process.execPath}" "${fakeInstaller}" "$@"\n`);
    chmodSync(command, 0o755);
  }
  const env = {
    ...process.env,
    HOME: userDir, USERPROFILE: userDir,
    XDG_CONFIG_HOME: join(userDir, '.config'), APPDATA: join(userDir, 'AppData', 'Roaming'),
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    npm_config_cache: join(root, 'cache'),
    OBELISK_SKIP_SKILL_INSTALL: skip ? '1' : '',
    OBELISK_TEST_SKILLS_CAPTURE: capture,
    OBELISK_TEST_SKILLS_FAIL: fail ? '1' : '',
    OBELISK_TEST_SKILL_SOURCE: join(repoRoot, 'skill-doc'),
  };
  delete env.npm_config_ignore_scripts;
  delete env.npm_config_global;
  const args = ['install', '--foreground-scripts', '--no-audit', '--no-fund', ...(global
    ? ['--global', '--prefix', prefix] : []), tarball];
  const result = spawnSync(npm, args, { cwd: project, env, shell, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const entry = global
    ? join(prefix, ...(shell ? [] : ['lib']), 'node_modules', '@obelisk-apps', 'cli', 'dist', 'cli', 'src', 'obelisk.js')
    : join(project, 'node_modules', '@obelisk-apps', 'cli', 'dist', 'cli', 'src', 'obelisk.js');
  const version = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', entry, '--version'], { env, encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), packageVersion);
  return { root, userDir, project, capture, result, env };
}

for (const global of [false, true]) {
  test(`npm ${global ? 'global' : 'project'} installation also installs the official skill in the matching scope`, () => {
    const { userDir, project, capture } = install({ global });
    const call = JSON.parse(readFileSync(capture, 'utf8'));
    assert.deepEqual(call.args, [
      '--yes', 'skills', 'add', 'tommy0103/obelisk-skill', '--skill', 'obelisk', '--yes',
      ...(global ? ['--global'] : []),
    ]);
    assert.equal(realpathSync(call.cwd), realpathSync(project), 'project guidance is not installed inside the npm package');
    assert.equal(call.global, 'false', 'npx resolves its own tool locally');
    const skillPath = join(global ? userDir : project, '.agents', 'skills', 'obelisk');
    assert.equal(readFileSync(join(skillPath, 'SKILL.md'), 'utf8'), readFileSync(join(repoRoot, 'skill-doc/SKILL.md'), 'utf8'));
    assert.match(readFileSync(join(skillPath, 'references/api-reference.md'), 'utf8'), /messages\(optsOrUuid\)/);
    assert.equal(existsSync(join(global ? project : userDir, '.agents', 'skills', 'obelisk')), false);
  });
}

test('npm installation opt-out leaves the CLI usable and does not invoke the skill installer', () => {
  const { capture } = install({ global: true, skip: true });
  assert.equal(existsSync(capture), false);
});

for (const global of [false, true]) {
  test(`failed ${global ? 'global' : 'project'} skill installation preserves the npm CLI and provides a scoped retry`, () => {
    const { result, capture } = install({ global, fail: true });
    assert.ok(existsSync(capture));
    assert.match(result.stderr + result.stdout, /skills installer exited with code 7/);
    assert.ok((result.stderr + result.stdout).includes(global
      ? 'obelisk install --global --yes' : 'npx --no-install obelisk install --yes'));
  });
}

test('repository dependency installation does not run the skill installer', () => {
  const root = makeTempDir('obelisk-checkout-postinstall-');
  const result = spawnSync(process.execPath, [join(repoRoot, 'packages/cli/scripts/postinstall.mjs')], {
    cwd: repoRoot,
    env: { ...process.env, PATH: root, OBELISK_SKIP_SKILL_INSTALL: '', npm_config_global: 'true' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
});
