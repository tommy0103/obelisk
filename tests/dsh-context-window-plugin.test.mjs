// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

import * as ContextWindowPlugin from '../packages/dsh-plugin/src/context-window.ts'
import { contextWindowProjectionDefinition } from '../packages/dsh-plugin/src/context-window-state.ts'
import {
  canonicalDeepseekMemberAssistantMessageUuid,
  canonicalDeepseekTreeSessionId,
  deepseekProjectScope,
} from '../packages/core/src/providers/deepseek-identity.ts'

const pluginRoot = resolve(import.meta.dirname, '..', 'packages', 'dsh-plugin')

function textResponse(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCallResponse(id, name, args) {
  const callId = ToolCallId(id)
  const raw = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: raw },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: raw } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

class ScriptedAdapter extends LlmAdapter {
  requests = []

  constructor(script) {
    super()
    this.script = [...script]
  }

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100_000 } })
  }

  async * stream(options) {
    this.requests.push(options)
    const chunks = this.script.shift()
    if (chunks === undefined) throw new Error('script exhausted')
    yield* chunks
  }
}

async function harness(adapter) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { persona: 'test' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ContextWindowPlugin)
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx, agent) {
  return new Promise((resolveIdle) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'idle') return
      dispose()
      resolveIdle()
    })
  })
}

test('exports context-window as an opt-in package subpath without mounting it in the default bundle', () => {
  const manifest = JSON.parse(readFileSync(resolve(pluginRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.exports['./context-window'], './dist/context-window.js')
  const bundle = readFileSync(resolve(pluginRoot, 'obelisk.cordis.yml'), 'utf8')
  assert.doesNotMatch(bundle, /context-window/)
})

test('derives a pending PTC rollover only after nested and enclosing calls succeed', () => {
  const apply = contextWindowProjectionDefinition.apply
  let state = contextWindowProjectionDefinition.init({})
  state = apply(state, {
    type: 'tool/call', seq: 1, time: 1, surfaceOp: undefined,
    data: { turn: 2, step: 4, callId: 'run-1', name: 'run_code', arguments: '{}' },
  })
  state = apply(state, {
    type: 'tool/code-dispatch-start', seq: 2, time: 2,
    data: {
      rootCallId: 'run-1', parentCallId: 'run-1', subCallId: 'run-1:code:0',
      name: 'new_context', arguments: { handoff: 'PTC handoff' },
    },
  })
  state = apply(state, {
    type: 'tool/code-dispatch', seq: 3, time: 3,
    data: {
      rootCallId: 'run-1', parentCallId: 'run-1', subCallId: 'run-1:code:0',
      name: 'new_context', arguments: { handoff: 'PTC handoff' }, isError: false, content: [],
    },
  })
  assert.equal(state.pending, undefined)
  state = apply(state, {
    type: 'tool/result', seq: 4, time: 4, surfaceOp: 'append', sourceEventSeqs: [1],
    data: {
      turn: 2, step: 4,
      message: {
        id: 'result-1', role: 'user', source: { kind: 'tool', callId: 'run-1' },
        content: [{ type: 'tool-result', toolCallId: 'run-1', content: [], isError: false }],
      },
    },
  })
  assert.deepEqual(state.pending, {
    rootCallId: 'run-1', handoff: 'PTC handoff', turn: 2, step: 4,
  })
})

test('applies a successful new_context handoff at the next pre-step', async () => {
  const handoff = 'Goal: finish the parser. Progress: tests added. Next: implement the remaining cases.'
  const adapter = new ScriptedAdapter([
    toolCallResponse('new-context-1', 'new_context', { handoff }),
    textResponse('continued in fresh context'),
  ])
  const ctx = await harness(adapter)
  const agent = ctx.agentLoop.create(SessionId('rollover-session'), { provider: 'mock', model: 'mock' })
  const idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'old context request' }],
    source: { kind: 'user' },
  }))
  await idle

  assert.equal(adapter.requests.length, 2)
  const secondText = JSON.stringify(adapter.requests[1].messages)
  assert.doesNotMatch(secondText, /old context request/)
  assert.match(secondText, /Goal: finish the parser/)

  const scope = deepseekProjectScope(undefined)
  const sessionId = canonicalDeepseekTreeSessionId('rollover-session', scope)
  const messageUuid = canonicalDeepseekMemberAssistantMessageUuid(
    'rollover-session', scope, 1, 1, 'tool_use',
  )
  assert.match(secondText, new RegExp(sessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(secondText, new RegExp(messageUuid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

  const replacement = agent.session.snapshotEvents().find(event =>
    event.type === 'user/message' && event.data.source.kind === 'obelisk-context-handoff')
  assert.ok(replacement)
  assert.equal(replacement.surfaceOp.op, 'replace')
})

test('does not rollover a failed new_context call', async () => {
  const adapter = new ScriptedAdapter([
    toolCallResponse('new-context-empty', 'new_context', { handoff: '   ' }),
    textResponse('recovered from the tool error'),
  ])
  const ctx = await harness(adapter)
  const agent = ctx.agentLoop.create(SessionId('failed-rollover'), { provider: 'mock', model: 'mock' })
  const idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'keep this context' }],
    source: { kind: 'user' },
  }))
  await idle

  assert.equal(adapter.requests.length, 2)
  assert.match(JSON.stringify(adapter.requests[1].messages), /keep this context/)
  assert.equal(agent.session.snapshotEvents().some(event =>
    event.type === 'user/message' && event.data.source.kind === 'obelisk-context-handoff'), false)
})

test('does not reapply a committed rollover on a later turn', async () => {
  const adapter = new ScriptedAdapter([
    toolCallResponse('new-context-once', 'new_context', { handoff: 'Continue once.' }),
    textResponse('first fresh response'),
    textResponse('later response'),
  ])
  const ctx = await harness(adapter)
  const agent = ctx.agentLoop.create(SessionId('one-rollover'), { provider: 'mock', model: 'mock' })
  let idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'start' }], source: { kind: 'user' } }))
  await idle

  idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'later turn' }], source: { kind: 'user' } }))
  await idle

  const replacements = agent.session.snapshotEvents().filter(event =>
    event.type === 'user/message' && event.data.source.kind === 'obelisk-context-handoff')
  assert.equal(replacements.length, 1)
})
