// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(pluginRoot, '../..')
const root = mkdtempSync(join(tmpdir(), 'obelisk-dsh-install-'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run(command, args, cwd) {
  execFileSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, npm_config_cache: join(root, 'npm-cache') },
  })
}

function initProject(path) {
  writeFileSync(join(path, 'package.json'), JSON.stringify({ private: true }, null, 2))
}

try {
  run(npm, ['pack', '--workspace', '@obelisk/dsh-obelisk-plugin', '--pack-destination', root], repoRoot)
  const tarball = join(root, readdirSync(root).find(file => file.endsWith('.tgz')) ?? '')
  if (!tarball.endsWith('.tgz')) throw new Error('DSH plugin pack did not produce a tarball')

  const manifest = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'))
  if (manifest.dependencies?.['@obelisk/core'] !== undefined) {
    throw new Error('distributable DSH plugin must not depend on private @obelisk/core')
  }

  const npmProject = join(root, 'npm-project')
  const pnpmProject = join(root, 'pnpm-project')
  for (const project of [npmProject, pnpmProject]) {
    mkdirSync(project)
    initProject(project)
  }
  run(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], npmProject)
  run(npm, [
    'exec', '--yes', '--package=pnpm@11.1.2', '--',
    'pnpm', 'add', '--ignore-scripts', '--store-dir', join(root, 'pnpm-store'), tarball,
  ], pnpmProject)
} finally {
  rmSync(root, { recursive: true, force: true })
}
