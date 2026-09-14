// Runs every Electron regression suite against one build and reports a single
// summary. Each suite already prints its own PASS/FAIL lines; this exists so a
// new suite is covered by one command instead of only being run by whoever
// remembers it is there.

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const suites = [
  'electron-concurrency.mjs',
  'electron-session-catalogue.mjs',
  'electron-session-images.mjs',
  'electron-session-virtualization.mjs',
  'electron-session-reader-state.mjs',
  'electron-file-references.mjs',
]

const failed = []
for (const suite of suites) {
  console.log(`\n=== ${suite} ===`)
  const result = spawnSync(electron, ['--no-sandbox', path.join('tests', suite)], {
    cwd: appRoot,
    stdio: 'inherit',
  })
  if (result.status !== 0) failed.push(`${suite} (exit ${result.status ?? 'signal'})`)
}

console.log(`\n${suites.length - failed.length}/${suites.length} Electron suites passed`)
for (const failure of failed) console.error(`FAILED: ${failure}`)
process.exit(failed.length ? 1 : 0)
