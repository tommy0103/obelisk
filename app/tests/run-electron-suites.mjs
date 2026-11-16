// Runs every Electron regression suite against one build and reports a single
// summary. Each suite already prints its own PASS/FAIL lines; this exists so a
// new suite is covered by one command instead of only being run by whoever
// remembers it is there.

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Every tests/electron-*.mjs is a suite unless it is listed here.
const notSuites = new Set([
  'electron-concurrency-child.mjs', // spawned by electron-concurrency.mjs
  'electron-vite-schema-asset.mjs', // a node --test file run directly by CI
])
const suites = readdirSync(path.join(appRoot, 'tests'))
  .filter(name => /^electron-.+\.mjs$/.test(name) && !notSuites.has(name))
  .sort()

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
