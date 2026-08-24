// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  deriveObeliskRow,
  summarizeQuery,
} from '../packages/dsh-plugin/src/client/row-model.ts'

const settled = (overrides = {}) => ({
  kind: 'tool-result',
  seq: 2,
  time: 2,
  callId: 'call-1',
  call: { name: 'obelisk_query', argsRaw: '{"query":"return overview({ limit: 2 })"}' },
  callTime: 1,
  content: [{ type: 'text', text: '{"projects":[]}' }],
  isError: false,
  callView: null,
  resultView: null,
  subCalls: [],
  ...overrides,
})

test('running call derives state, query, and bounded summary', () => {
  const model = deriveObeliskRow({
    callId: 'call-1',
    name: 'obelisk_query',
    argsRaw: '{"query":"return overview({ limit: 2 })"}',
    turn: 1,
    step: 1,
    time: 1,
    callView: null,
    subCalls: [],
  })
  assert.equal(model.state, 'running')
  assert.equal(model.query, 'return overview({ limit: 2 })')
  assert.equal(model.summary, 'return overview({ limit: 2 })')
  assert.equal(model.output, null)
  assert.equal(model.errorLabel, null)
})

test('settled ok call derives text output', () => {
  const model = deriveObeliskRow(settled())
  assert.equal(model.state, 'ok')
  assert.equal(model.output, '{"projects":[]}')
  assert.equal(model.errorLabel, null)
})

test('settled error call surfaces the error label as the summary', () => {
  const model = deriveObeliskRow(settled({
    isError: true,
    error: { name: 'SandboxError', code: 'E_SANDBOX' },
    content: [{ type: 'text', text: 'boom' }],
  }))
  assert.equal(model.state, 'error')
  assert.equal(model.errorLabel, 'SandboxError')
  assert.equal(model.summary, 'SandboxError')
  assert.equal(model.output, 'boom')
})

test('unreadable args degrade to null query and a neutral summary', () => {
  const model = deriveObeliskRow(settled({ call: { name: 'obelisk_query', argsRaw: 'not-json{' } }))
  assert.equal(model.query, null)
  assert.equal(model.summary, 'query')
})

test('non-text content blocks are ignored', () => {
  const model = deriveObeliskRow(settled({ content: [{ type: 'image', url: 'x' }] }))
  assert.equal(model.output, null)
})

test('summarizeQuery takes the first meaningful line and bounds long ones', () => {
  assert.equal(summarizeQuery('  \n\n  return search("x")  \nmore', 20), 'return search("x")')
  assert.equal(summarizeQuery('x'.repeat(60), 10), `${'x'.repeat(9)}…`)
  assert.equal(summarizeQuery(null), 'query')
  assert.equal(summarizeQuery('   \n'), 'query')
})
