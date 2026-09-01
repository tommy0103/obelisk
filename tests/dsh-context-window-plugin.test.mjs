// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import CodeRuntime from '@deepseek-ai/dsh-code-runtime'
import LlmRuntime, { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'

const identityModule = await import('../packages/core/src/providers/deepseek-identity.ts')
const identity = {
  canonicalDeepseekAssistantMessageUuid: identityModule.canonicalDeepseekAssistantMessageUuid,
  canonicalDeepseekMemberAssistantMessageUuid: identityModule.canonicalDeepseekMemberAssistantMessageUuid,
  canonicalDeepseekTreeSessionId: identityModule.canonicalDeepseekTreeSessionId,
  deepseekProjectScope: identityModule.deepseekProjectScope,
}
mock.module('@obelisk/core/providers/deepseek-identity', { exports: identity })

const ContextWindowPlugin = await import('../packages/dsh-plugin/src/context-window.ts')
const { decideContextWindowBudget } = await import('../packages/dsh-plugin/src/context-window-budget.ts')
const { contextWindowProjectionDefinition } = await import('../packages/dsh-plugin/src/context-window-state.ts')
const { recoveryAnchors } = await import('../packages/dsh-plugin/src/context-window-identity.ts')
const {
  canonicalDeepseekMemberAssistantMessageUuid,
  canonicalDeepseekTreeSessionId,
  deepseekProjectScope,
} = identity

const pluginRoot = resolve(import.meta.dirname, '..', 'packages', 'dsh-plugin')

function textResponse(text, usage = { inputTokens: 10, outputTokens: text.length }) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage },
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

  constructor(script, { contextWindow = 100_000, defaultMaxTokens = 4_096 } = {}) {
    super()
    this.script = [...script]
    this.contextWindow = contextWindow
    this.defaultMaxTokens = defaultMaxTokens
  }

  resolveModel(provider, model) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: this.contextWindow },
      defaultMaxTokens: this.defaultMaxTokens,
    })
  }

  async * stream(options) {
    this.requests.push(options)
    const chunks = this.script.shift()
    if (chunks === undefined) throw new Error('script exhausted')
    yield* chunks
  }
}

class HandoffCodeRuntime extends CodeRuntime {
  language = 'typescript'
  isolation = 'test'

  async run(request) {
    const tools = request.bindings.find(binding => binding.global === 'tools')
    const newContext = tools?.functions.new_context
    if (newContext === undefined) {
      return { logs: [], error: { kind: 'exception', message: 'new_context binding missing' } }
    }
    return {
      logs: [],
      value: await newContext({ handoff: 'PTC fallback handoff.' }),
    }
  }
}

async function harness(adapter, config = {}, { mode = 'native' } = {}) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(SystemPrompt, { persona: 'test' })
  if (mode === 'ptc') await ctx.plugin(HandoffCodeRuntime)
  await ctx.plugin(ToolRuntime, { mode })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ContextWindowPlugin, config)
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
  const skill = readFileSync(resolve(pluginRoot, 'skill', 'SKILL.md'), 'utf8')
  assert.match(skill, /Treat its `session_id` as the default scope/)
  assert.match(skill, /call\s+`context\(\)` with the supplied `message_uuid`/)
})

test('resolves reminder, fallback reserve, and forced rollover from host pressure', () => {
  const policy = {
    reminderThresholdTokens: 100,
    fallbackReserveTokens: 200,
    outputReserveTokens: 100,
  }
  const decide = (totalTokens, claims = {}) => decideContextWindowBudget({
    contextWindow: 1_000,
    totalTokens,
    explicitRolloverPending: false,
    reminderClaimed: false,
    fallbackClaimed: false,
    policy,
    ...claims,
  })

  assert.equal(decide(599).kind, 'continue')
  assert.equal(decide(600).kind, 'remind')
  assert.equal(decide(600, { reminderClaimed: true }).kind, 'continue')
  assert.equal(decide(700).kind, 'fallback')
  assert.deepEqual(decide(701, { fallbackClaimed: true }), { kind: 'rollover', reason: 'hard-limit' })
  assert.deepEqual(decide(900), { kind: 'rollover', reason: 'hard-limit' })
  assert.deepEqual(decide(100, { explicitRolloverPending: true }), { kind: 'rollover', reason: 'model' })
})

test('injects one durable reminder near the normal budget', async () => {
  const policy = {
    reminderThresholdTokens: 100,
    fallbackReserveTokens: 200,
    outputReserveTokens: 100,
  }
  const adapter = new ScriptedAdapter([
    textResponse('first response', { inputTokens: 620, outputTokens: 1 }),
    textResponse('continued after reminder'),
  ], { contextWindow: 1_000, defaultMaxTokens: 100 })
  const ctx = await harness(adapter, policy)
  const agent = ctx.agentLoop.create(SessionId('reminder-session'), { provider: 'mock', model: 'mock' })
  let idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'start' }], source: { kind: 'user' } }))
  await idle

  idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
  await idle

  assert.match(JSON.stringify(adapter.requests[1].messages), /approaching its normal task budget/)
  const reminders = agent.session.snapshotEvents().filter(event =>
    event.type === 'user/message'
    && event.data.source.kind === 'obelisk-context-pressure'
    && event.data.source.phase === 'reminder')
  assert.equal(reminders.length, 1)
})

test('limits fallback inference to new_context and rolls over on success', async () => {
  const policy = {
    reminderThresholdTokens: 100,
    fallbackReserveTokens: 200,
    outputReserveTokens: 100,
  }
  const adapter = new ScriptedAdapter([
    textResponse('first response', { inputTokens: 9_750, outputTokens: 1 }),
    toolCallResponse('fallback-handoff', 'new_context', { handoff: 'Continue the pressured task.' }),
    textResponse('continued after fallback rollover'),
  ], { contextWindow: 10_000, defaultMaxTokens: 100 })
  const ctx = await harness(adapter, policy)
  const agent = ctx.agentLoop.create(SessionId('fallback-session'), { provider: 'mock', model: 'mock' })
  let idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'start' }], source: { kind: 'user' } }))
  await idle

  idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
  await idle

  assert.deepEqual(adapter.requests[1].tools.map(tool => tool.name), ['new_context'])
  assert.match(JSON.stringify(adapter.requests[1].messages), /normal task budget is exhausted/)
  assert.match(JSON.stringify(adapter.requests[2].messages), /Continue the pressured task/)
  assert.equal(agent.session.snapshotEvents().filter(event =>
    event.type === 'user/message' && event.data.source.kind === 'obelisk-context-handoff').length, 1)
})

test('PTC fallback exposes only new_context through run_code and completes rollover', async () => {
  const policy = {
    reminderThresholdTokens: 100,
    fallbackReserveTokens: 200,
    outputReserveTokens: 100,
  }
  const adapter = new ScriptedAdapter([
    textResponse('first response', { inputTokens: 9_750, outputTokens: 1 }),
    toolCallResponse('fallback-program', 'run_code', {
      code: 'return await tools.new_context({ handoff: "PTC fallback handoff." })',
      description: 'Prepare context handoff',
    }),
    textResponse('continued after PTC rollover'),
  ], { contextWindow: 10_000, defaultMaxTokens: 100 })
  const ctx = await harness(adapter, policy, { mode: 'ptc' })
  ctx.tools.register(defineTool({
    name: 'other_tool',
    description: 'Must be hidden during fallback.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      return 'other'
    },
  }))
  const agent = ctx.agentLoop.create(SessionId('ptc-fallback-session'), { provider: 'mock', model: 'mock' })
  let idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'start' }], source: { kind: 'user' } }))
  await idle

  idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
  await idle

  assert.deepEqual(adapter.requests[1].tools.map(tool => tool.name), ['run_code'])
  assert.match(JSON.stringify(adapter.requests[1].messages), /normal task budget is exhausted/)
  assert.match(adapter.requests[1].system, /new_context/)
  assert.doesNotMatch(adapter.requests[1].system, /other_tool/)
  assert.match(JSON.stringify(adapter.requests[2].messages), /PTC fallback handoff/)
  const replacement = agent.session.snapshotEvents().find(event =>
    event.type === 'user/message'
    && event.data.source.kind === 'obelisk-context-handoff'
    && event.data.source.trigger.kind === 'model')
  assert.ok(replacement)
  assert.equal(replacement.data.source.trigger.rootCallId, 'fallback-program')
})

test('forces a recoverable rollover in the same user turn when fallback produces no handoff', async () => {
  const policy = {
    reminderThresholdTokens: 100,
    fallbackReserveTokens: 200,
    outputReserveTokens: 100,
  }
  const adapter = new ScriptedAdapter([
    textResponse('first response', { inputTokens: 730, outputTokens: 1 }),
    textResponse('incorrect final instead of handoff', { inputTokens: 760, outputTokens: 1 }),
    textResponse('continued after forced rollover'),
  ], { contextWindow: 1_000, defaultMaxTokens: 100 })
  const ctx = await harness(adapter, policy)
  const agent = ctx.agentLoop.create(SessionId('forced-session'), { provider: 'mock', model: 'mock' })
  let idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'start' }], source: { kind: 'user' } }))
  await idle

  idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
  await idle

  assert.equal(adapter.requests.length, 3)
  const third = JSON.stringify(adapter.requests[2].messages)
  assert.match(third, /No prose handoff was produced/)
  assert.doesNotMatch(third, /incorrect final instead of handoff/)
  const replacement = agent.session.snapshotEvents().find(event =>
    event.type === 'user/message'
    && event.data.source.kind === 'obelisk-context-handoff'
    && event.data.source.trigger.kind === 'hard-limit')
  assert.ok(replacement)
  assert.equal(replacement.data.source.handoffStatus, 'missing')
})

test('execution guard rejects non-handoff tools after fallback is claimed', async () => {
  const adapter = new ScriptedAdapter([])
  const ctx = await harness(adapter)
  let ran = false
  ctx.tools.register(defineTool({
    name: 'other_tool',
    description: 'Must not run during fallback.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      ran = true
      return 'ran'
    },
  }))
  const agent = ctx.agentLoop.create(SessionId('guard-session'), { provider: 'mock', model: 'mock' })
  agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'fallback' }],
    source: { kind: 'obelisk-context-pressure', phase: 'fallback', generation: 0 },
  }), { surfaceOp: 'append' })

  const result = await ctx.tools.execute({
    callId: ToolCallId('guarded-call'),
    name: 'other_tool',
    arguments: {},
    agent,
    signal: new AbortController().signal,
  })
  assert.equal(result.isError, true)
  assert.equal(ran, false)
  assert.match(JSON.stringify(result.content), /only permits new_context/)
})

test('derives a child message anchor inside its live root task session', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const cwd = '/tmp/dsh-context-window-child'
  const root = ctx.sessions.create(SessionId('root-session'), { meta: { cwd } })
  const child = ctx.sessions.create(SessionId('child-session'), {
    meta: {
      cwd,
      parentSession: root.id,
      isSeeded: false,
      origin: 'subagent',
    },
  })
  const anchors = await recoveryAnchors(ctx, child, 2, 3)
  const scope = deepseekProjectScope(cwd)
  assert.equal(anchors.sessionId, canonicalDeepseekTreeSessionId(root.id, scope))
  assert.equal(anchors.messageUuid, canonicalDeepseekMemberAssistantMessageUuid(
    child.id, scope, 2, 3, 'tool_use',
  ))
})

test('resolves a resumed child root from persistence metadata when the parent is not live', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const cwd = '/tmp/dsh-context-window-resumed-child'
  const parentId = SessionId('persisted-root')
  const child = ctx.sessions.create(SessionId('resumed-child'), {
    meta: {
      cwd,
      parentSession: parentId,
      isSeeded: false,
      origin: 'subagent',
    },
  })
  const persistence = {
    async list() {
      return [{
        version: 0,
        id: parentId,
        createdAt: 1,
        cwd,
        isSeeded: false,
      }]
    },
  }
  const identityContext = {
    sessions: { get: () => undefined },
    get: service => service === 'sessionPersistence' ? persistence : undefined,
  }
  const anchors = await recoveryAnchors(identityContext, child, 4, 5)
  const scope = deepseekProjectScope(cwd)
  assert.equal(anchors.sessionId, canonicalDeepseekTreeSessionId(parentId, scope))
  assert.equal(anchors.messageUuid, canonicalDeepseekMemberAssistantMessageUuid(
    child.id, scope, 4, 5, 'tool_use',
  ))
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

test('flush failure prevents dispatching the fresh-context request', async () => {
  const adapter = new ScriptedAdapter([
    toolCallResponse('flush-failure', 'new_context', { handoff: 'Persist before continuing.' }),
    textResponse('must not dispatch'),
  ])
  const ctx = await harness(adapter)
  const agent = ctx.agentLoop.create(SessionId('flush-failure-session'), { provider: 'mock', model: 'mock' })
  ctx.on('session/flush', session => {
    if (session === agent.session) throw new Error('simulated persistence failure')
  })
  const idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'start' }], source: { kind: 'user' } }))
  await idle

  assert.equal(adapter.requests.length, 1)
  assert.equal(agent.session.snapshotEvents().filter(event =>
    event.type === 'user/message' && event.data.source.kind === 'obelisk-context-handoff').length, 1)
})
