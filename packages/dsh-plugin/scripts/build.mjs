// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { execFileSync } from 'node:child_process'
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(pluginRoot, '../..')
const outDir = resolve(pluginRoot, 'dist')
const tsc = resolve(repoRoot, 'node_modules/typescript/bin/tsc')

rmSync(outDir, { recursive: true, force: true })
execFileSync(process.execPath, [tsc, '-p', resolve(pluginRoot, 'tsconfig.build.json')], {
  cwd: repoRoot,
  stdio: 'inherit',
})
const coreIdentityRoot = resolve(repoRoot, 'packages/core/dist/providers')
for (const extension of ['js', 'd.ts']) {
  cpSync(
    resolve(coreIdentityRoot, `deepseek-identity.${extension}`),
    resolve(outDir, `deepseek-identity.${extension}`),
  )
}
const identityAdapter = resolve(outDir, 'context-window-identity.js')
const externalIdentitySpecifier = "'@obelisk/core/providers/deepseek-identity'"
const identityAdapterSource = readFileSync(identityAdapter, 'utf8')
if (!identityAdapterSource.includes(externalIdentitySpecifier)) {
  throw new Error('DSH plugin build could not locate the shared identity import to vendor')
}
writeFileSync(
  identityAdapter,
  identityAdapterSource.replace(externalIdentitySpecifier, "'./deepseek-identity.js'"),
)
cpSync(resolve(pluginRoot, 'skill'), resolve(outDir, 'skill'), { recursive: true })
