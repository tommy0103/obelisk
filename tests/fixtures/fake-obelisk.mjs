#!/usr/bin/env node
// Fake obelisk CLI for plugin tests. Behavior is selected through
// FAKE_OBELISK_MODE: ok (default), fail, garbage, or large.

import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const mode = process.env.FAKE_OBELISK_MODE ?? 'ok'

if (mode === 'fail') {
  process.stderr.write('fake obelisk failure\n')
  process.exit(2)
}

if (mode === 'garbage') {
  process.stdout.write('not-json{')
  process.exit(0)
}

if (args[0] !== '--query' || !args[1]) {
  process.stderr.write(`unexpected args: ${args.join(' ')}\n`)
  process.exit(3)
}

let content = ''
try {
  content = readFileSync(args[1], 'utf8')
} catch {
  process.stderr.write('query file missing\n')
  process.exit(4)
}

if (mode === 'large') {
  process.stdout.write(JSON.stringify({ ok: true, mode, padding: 'x'.repeat(50_000) }, null, 2))
  process.exit(0)
}

process.stdout.write(JSON.stringify({
  ok: true,
  mode,
  sawQuery: content.length,
  head: content.slice(0, 40),
}, null, 2))
process.exit(0)
