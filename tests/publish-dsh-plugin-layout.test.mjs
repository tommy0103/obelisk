// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeTempDir } from './temp-dirs.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const stageScript = join(repoRoot, 'packaging', 'stage-dsh-plugin-repo.sh')

test('DSH plugin release staging produces an installable standalone repository', () => {
  const root = makeTempDir('obelisk-dsh-plugin-release-')
  const artifact = join(root, 'artifact')
  const target = join(root, 'repo')
  try {
    mkdirSync(join(artifact, 'dist'), { recursive: true })
    mkdirSync(join(target, '.git'), { recursive: true })
    writeFileSync(join(artifact, 'package.json'), '{"name":"@obelisk/dsh-obelisk-plugin"}\n')
    writeFileSync(join(artifact, 'obelisk.cordis.yml'), 'plugins: []\n')
    writeFileSync(join(artifact, 'dist', 'index.js'), 'export default {}\n')
    writeFileSync(join(artifact, 'dist', 'index.d.ts'), 'declare const plugin: object\nexport default plugin\n')
    writeFileSync(join(target, '.git', 'keep'), 'preserved\n')
    writeFileSync(join(target, 'stale.txt'), 'remove me\n')

    const result = spawnSync('bash', [stageScript, target, artifact], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)

    assert.deepEqual(readdirSync(target).sort(), [
      '.git',
      'LICENSE',
      'README.md',
      'dist',
      'obelisk.cordis.yml',
      'package.json',
    ])
    for (const relativePath of [
      'dist/index.js',
      'dist/index.d.ts',
      'obelisk.cordis.yml',
      'package.json',
      'README.md',
      'LICENSE',
    ]) {
      assert.equal(existsSync(join(target, relativePath)), true, relativePath)
    }
    assert.equal(existsSync(join(target, '.git', 'keep')), true)
    assert.equal(existsSync(join(target, 'stale.txt')), false)
    assert.match(readFileSync(join(target, 'README.md'), 'utf8'), /generated from the Obelisk monorepo/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('DSH plugin publication builds and stages the standalone mirror', () => {
  const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'publish-dsh-plugin.yml'), 'utf8')

  assert.match(workflow, /npm run build:core/)
  assert.match(workflow, /npm run build --workspace @obelisk\/dsh-obelisk-plugin/)
  assert.match(workflow, /packaging\/stage-dsh-plugin-repo\.sh/)
  assert.match(workflow, /tommy0103\/obelisk-dsh-plugin\.git/)
  assert.match(workflow, /secrets\.DSH_PLUGIN_REPO_DEPLOY_KEY/)
  assert.match(workflow, /git push --force origin HEAD:main/)
  assert.doesNotMatch(workflow, /stage-skill-repo/)
})
