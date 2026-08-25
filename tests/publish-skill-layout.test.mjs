// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './temp-dirs.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stageScript = join(repoRoot, 'packaging', 'stage-skill-repo.sh');

test('skill release staging produces the npx skills repository layout', () => {
  const root = makeTempDir('obelisk-skill-release-');
  const artifact = join(root, 'artifact');
  const target = join(root, 'repo');
  try {
    mkdirSync(join(artifact, 'references'), { recursive: true });
    mkdirSync(join(target, '.git'), { recursive: true });
    writeFileSync(join(artifact, 'SKILL.md'), '---\nname: obelisk\ndescription: test\n---\n');
    writeFileSync(join(artifact, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(artifact, 'references', 'api-reference.md'), '# API\n');
    writeFileSync(join(target, '.git', 'keep'), 'preserved\n');
    writeFileSync(join(target, 'stale.txt'), 'remove me\n');

    const result = spawnSync('bash', [stageScript, target, artifact], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    assert.deepEqual(readdirSync(target).sort(), ['.git', 'LICENSE', 'README.md', 'skills']);
    assert.deepEqual(readdirSync(join(target, 'skills')).sort(), ['obelisk']);
    for (const relativePath of [
      'SKILL.md',
      'package.json',
      'references/api-reference.md',
    ]) {
      assert.equal(existsSync(join(target, 'skills', 'obelisk', relativePath)), true);
    }
    assert.equal(existsSync(join(target, '.git', 'keep')), true);
    assert.equal(existsSync(join(target, 'stale.txt')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CI and local publish use the same skill repository staging step', () => {
  const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'publish-skill.yml'), 'utf8');
  const localPublish = readFileSync(join(repoRoot, 'packaging', 'publish-skill.sh'), 'utf8');

  assert.match(workflow, /packaging\/stage-skill-repo\.sh/);
  assert.match(localPublish, /packaging\/stage-skill-repo\.sh/);
  assert.doesNotMatch(localPublish, /SKILL_ARTIFACT\/scripts/);
});
