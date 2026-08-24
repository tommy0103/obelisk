// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import { apply } from '../packages/dsh-plugin/src/index.ts'

const fakeCli = fileURLToPath(new URL('./fixtures/fake-obelisk.mjs', import.meta.url))

function boot(config = {}) {
  let registered = null
  let section = null
  const ctx = {
    tools: { register: definition => { registered = definition } },
    systemPrompt: { section: value => { section = value } },
  }
  apply(ctx, { cliPath: fakeCli, ...config })
  return { registered, section }
}

const sampleQuery = 'return overview({ limit: 2 })'

test('registers the obelisk_query tool and a guidance section', () => {
  const { registered, section } = boot({ timeoutMs: 1234 })
  assert.ok(registered)
  assert.equal(registered.name, 'obelisk_query')
  assert.equal(registered.timeoutMs, 1234)
  assert.equal(registered.parameters.type, 'object')
  assert.equal(registered.parameters.properties.query.type, 'string')
  assert.deepEqual(registered.parameters.required, ['query'])
  assert.equal(section.name, 'tool:obelisk-query')
  assert.equal(section.order, 114)
  assert.match(section.text, /obelisk_query/)
})

test('executes a query through the CLI and returns JSON text', async () => {
  const { registered } = boot()
  const result = await registered.execute({ query: sampleQuery }, {})
  const value = JSON.parse(result)
  assert.equal(value.ok, true)
  assert.equal(value.mode, 'ok')
  assert.equal(value.sawQuery, sampleQuery.length)
})

test('surfaces CLI failures with exit code and stderr', async () => {
  const { registered } = boot()
  process.env.FAKE_OBELISK_MODE = 'fail'
  try {
    const result = await registered.execute({ query: sampleQuery }, {})
    assert.match(result, /Obelisk query failed \(exit 2\)/)
    assert.match(result, /fake obelisk failure/)
  } finally {
    delete process.env.FAKE_OBELISK_MODE
  }
})

test('passes through non-JSON stdout instead of throwing', async () => {
  const { registered } = boot()
  process.env.FAKE_OBELISK_MODE = 'garbage'
  try {
    const result = await registered.execute({ query: sampleQuery }, {})
    assert.match(result, /not-json/)
  } finally {
    delete process.env.FAKE_OBELISK_MODE
  }
})

test('caps oversized output at maxResultChars with a truncation note', async () => {
  const max = 1000
  const { registered } = boot({ maxResultChars: max })
  process.env.FAKE_OBELISK_MODE = 'large'
  try {
    const result = await registered.execute({ query: sampleQuery }, {})
    const full = JSON.stringify({ ok: true, mode: 'large', padding: 'x'.repeat(50_000) })
    const expected = `${full.slice(0, max)}\n... [output truncated: ${full.length - max} characters omitted]`
    assert.equal(result, expected)
  } finally {
    delete process.env.FAKE_OBELISK_MODE
  }
})

test('reports spawn failures as a readable error', async () => {
  const { registered } = boot({ cliPath: '/definitely/not/a/real/obelisk-binary' })
  const result = await registered.execute({ query: sampleQuery }, {})
  assert.match(result, /Obelisk query could not run/)
  assert.match(result, /cliPath/)
})
