// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import CodeRuntime from '@deepseek-ai/dsh-code-runtime'
import LlmRuntime, {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  LlmAdapter,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as SessionCheckpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'

import { createDeepseekProvider } from '../packages/core/src/providers/deepseek.ts'
import { persist } from '../packages/core/src/persist.ts'
import { createQueryApi } from '../packages/core/src/query.ts'
import { makeTempDir } from './temp-dirs.mjs'

const ContextWindowPlugin = await import('../packages/dsh-plugin/dist/context-window.js')
const { decideContextWindowBudget } = await import('../packages/dsh-plugin/dist/context-window-budget.js')
const { contextWindowProjectionDefinition } = await import('../packages/dsh-plugin/dist/context-window-state.js')
const { recoveryAnchors } = await import('../packages/dsh-plugin/dist/context-window-identity.js')
const identity = await import('../packages/dsh-plugin/dist/deepseek-identity.js')
const coreIdentity = await import('../packages/core/src/providers/deepseek-identity.ts')
const {
  canonicalDeepseekMemberAssistantMessageUuid,
  canonicalDeepseekTreeSessionId,
  deepseekProjectScope,
} = identity

const pluginRoot = resolve(import.meta.dirname, '..', 'packages', 'dsh-plugin')
const coreSchema = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8')

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

  constructor(script, { contextWindow = 100_000, defaultMaxTokens = 4_096, models } = {}) {
    super()
    this.script = [...script]
    this.contextWindow = contextWindow
    this.defaultMaxTokens = defaultMaxTokens
    this.models = models
  }

  resolveModel(provider, model) {
    const selected = this.models?.[model]
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: selected?.contextWindow ?? this.contextWindow },
      defaultMaxTokens: selected?.defaultMaxTokens ?? this.defaultMaxTokens,
    })
  }

  imageRequestPricing(_provider, model) {
    const visualTokens = this.models?.[model]?.imageTokens
    if (visualTokens === undefined) return undefined
    return {
      priceImages: images => images.map(() => ({ visualTokens, text: '' })),
    }
  }

  async * stream(options) {
    this.requests.push(options)
    const chunks = this.script.shift()
    if (chunks === undefined) throw new Error('script exhausted')
    if (chunks instanceof Error) throw chunks
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
    if (request.program.includes('attempt-other')) {
      try {
        await tools?.functions.other_tool?.({})
      } catch {
        // The fallback guard must reject this; continue to the required handoff.
      }
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
  assert.equal(manifest.dependencies?.['@obelisk/core'], undefined)
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-skill'], '0.1.2-alpha.4')
  const bundle = readFileSync(resolve(pluginRoot, 'obelisk.cordis.yml'), 'utf8')
  assert.doesNotMatch(bundle, /context-window/)
  const skill = readFileSync(resolve(pluginRoot, 'skill', 'SKILL.md'), 'utf8')
  assert.match(skill, /Treat its `session_id` as the default scope/)
  assert.match(skill, /call\s+`context\(\)` with the supplied `message_uuid`/)
})

test('keeps packaged recovery identities compatible with the Obelisk provider', () => {
  const cwd = resolve('project', 'with spaces')
  const scope = identity.deepseekProjectScope(cwd)
  assert.equal(scope, coreIdentity.deepseekProjectScope(cwd))
  assert.equal(
    identity.canonicalDeepseekMemberAssistantMessageUuid('member/id', scope, 2, 3, 'tool_use'),
    coreIdentity.canonicalDeepseekMemberAssistantMessageUuid('member/id', scope, 2, 3, 'tool_use'),
  )
})

test('loads the built context-window package subpath', async () => {
  const built = await import(`../packages/dsh-plugin/dist/context-window.js?test=${Date.now()}`)
  assert.equal(built.name, '@obelisk/dsh-obelisk-plugin/context-window')
  assert.equal(typeof built.apply, 'function')
})

test('loads the built extra plugin through a real Cordis YAML composition', async () => {
  const root = makeTempDir('obelisk-context-loader-')
  const configPath = resolve(root, 'cordis.yml')
  writeFileSync(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-token-meter'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@obelisk/dsh-obelisk-plugin/context-window'",
    '  config:',
    '    reminderThresholdTokens: 100',
    '    fallbackReserveTokens: 200',
    '    outputReserveTokens: 100',
    '',
  ].join('\n'))
  const built = await import(`../packages/dsh-plugin/dist/context-window.js?loader=${Date.now()}`)
  const ctx = new Context()
  ctx.baseUrl = `${pathToFileURL(root).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-token-meter', TokenMeter],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@obelisk/dsh-obelisk-plugin/context-window', built],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  }
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()

  const unloaded = [...ctx.loader.entries()]
    .filter(entry => entry.fiber === undefined && !entry.disabled)
    .map(entry => entry.options.name)
  assert.deepEqual(unloaded, [])
  assert.ok(ctx.tools.get('new_context'))
  await ctx.fiber.dispose()
})

test('rejects a competing automatic compaction policy', () => {
  assert.throws(() => ContextWindowPlugin.assertCompatibleCompaction({
    get: service => service === 'compaction' ? { config: { auto: true } } : undefined,
  }), /compaction-basic\.auto is enabled/)
  assert.doesNotThrow(() => ContextWindowPlugin.assertCompatibleCompaction({
    get: service => service === 'compaction' ? { config: { auto: false } } : undefined,
  }))
})

test('blocks the first request when automatic compaction is mounted later', async () => {
  const adapter = new ScriptedAdapter([])
  const ctx = await harness(adapter)
  ctx.provide('compaction', { config: { auto: true } })
  const agent = ctx.agentLoop.create(SessionId('compaction-conflict'), { provider: 'mock', model: 'mock' })
  const idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'must not dispatch' }], source: { kind: 'user' } }))
  await idle
  assert.equal(adapter.requests.length, 0)
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
    reminderThresholdTokens: 800,
    fallbackReserveTokens: 200,
    outputReserveTokens: 100,
  }
  const adapter = new ScriptedAdapter([
    textResponse('first response', { inputTokens: 1_000, outputTokens: 1 }),
    textResponse('continued after reminder'),
  ], { contextWindow: 2_000, defaultMaxTokens: 100 })
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

test('uses the model selected for this assembly instead of the previous request capacity', async () => {
  const adapter = new ScriptedAdapter([
    textResponse('large-model response', { inputTokens: 1_500, outputTokens: 1 }),
    textResponse('continued on the small model'),
  ], {
    models: {
      large: { contextWindow: 10_000, defaultMaxTokens: 100 },
      small: { contextWindow: 1_000, defaultMaxTokens: 100 },
    },
  })
  const policy = {
    reminderThresholdTokens: 100,
    fallbackReserveTokens: 200,
    outputReserveTokens: 100,
  }
  const ctx = await harness(adapter, policy)
  const agent = ctx.agentLoop.create(SessionId('model-switch-session'), { provider: 'mock', model: 'large' })
  let selectedModel = 'large'
  agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next()
    return {
      ...assembly,
      variables: { ...assembly.variables, provider: 'mock', model: selectedModel },
    }
  })
  agent.ctx.on('agent/request', async (_payload, next) => ({
    ...await next(),
    provider: 'mock',
    model: selectedModel,
  }))

  let idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: `large model context ${'x'.repeat(4_000)}` }],
    source: { kind: 'user' },
  }))
  await idle

  selectedModel = 'small'
  idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue after switching' }], source: { kind: 'user' } }))
  await idle

  assert.equal(adapter.requests[1].model, 'small')
  const secondMessages = JSON.stringify(adapter.requests[1].messages)
  assert.match(secondMessages, /No prose handoff was produced/)
  assert.doesNotMatch(secondMessages, /large model context/)
})

test('prices retained images with the model selected for this assembly', async () => {
  const adapter = new ScriptedAdapter([
    textResponse('old-route response', { inputTokens: 20, outputTokens: 1 }),
    textResponse('continued after route-priced rollover'),
  ], {
    models: {
      cheap: { contextWindow: 1_000, defaultMaxTokens: 100, imageTokens: 1 },
      expensive: { contextWindow: 1_000, defaultMaxTokens: 100, imageTokens: 900 },
    },
  })
  const ctx = await harness(adapter, {
    reminderThresholdTokens: 100,
    fallbackReserveTokens: 200,
    outputReserveTokens: 100,
  })
  const agent = ctx.agentLoop.create(SessionId('route-pricing-session'), { provider: 'mock', model: 'cheap' })
  let selectedModel = 'cheap'
  agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next()
    return {
      ...assembly,
      variables: { ...assembly.variables, provider: 'mock', model: selectedModel },
    }
  })
  agent.ctx.on('agent/request', async (_payload, next) => ({
    ...await next(),
    provider: 'mock',
    model: selectedModel,
  }))

  let idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({
    content: [
      { type: 'text', text: 'retain this image only in the old context' },
      {
        type: 'image',
        attachment: {
          attachmentId: 'route-pricing-image',
          mediaType: 'image/png',
          bytes: 4,
          width: 1,
          height: 1,
        },
      },
    ],
    source: { kind: 'user' },
  }))
  await idle

  selectedModel = 'expensive'
  idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'continue after switching image pricing' }],
    source: { kind: 'user' },
  }))
  await idle

  assert.equal(adapter.requests[1].model, 'expensive')
  assert.match(JSON.stringify(adapter.requests[1].messages), /No prose handoff was produced/)
  assert.doesNotMatch(JSON.stringify(adapter.requests[1].messages), /route-pricing-image/)
})

test('includes newly claimed input in the pre-step pressure decision', async () => {
  const adapter = new ScriptedAdapter([
    textResponse(`response before rollover ${'r'.repeat(8_000)}`, { inputTokens: 1, outputTokens: 1 }),
    textResponse('continued with pending input on the fresh surface'),
  ], { contextWindow: 2_500, defaultMaxTokens: 100 })
  const ctx = await harness(adapter, {
    reminderThresholdTokens: 100,
    fallbackReserveTokens: 200,
    outputReserveTokens: 100,
  })
  const agent = ctx.agentLoop.create(SessionId('pending-input-session'), { provider: 'mock', model: 'mock' })
  let idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'old surface sentinel' }],
    source: { kind: 'user' },
  }))
  await idle

  idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'fit after rollover' }],
    source: { kind: 'user' },
  }))
  await idle

  const request = JSON.stringify(adapter.requests[1].messages)
  assert.match(request, /No prose handoff was produced/)
  assert.match(request, /fit after rollover/)
  assert.doesNotMatch(request, /old surface sentinel/)
})

test('preserves pending input instead of dispatching when it cannot fit a fresh context', async () => {
  const adapter = new ScriptedAdapter([], { contextWindow: 1_000, defaultMaxTokens: 100 })
  const ctx = await harness(adapter, {
    reminderThresholdTokens: 100,
    fallbackReserveTokens: 200,
    outputReserveTokens: 100,
  })
  const agent = ctx.agentLoop.create(SessionId('impossible-input-session'), { provider: 'mock', model: 'mock' })
  const impossible = createUserMessage({
    content: [{ type: 'text', text: `cannot fit fresh context ${'x'.repeat(4_000)}` }],
    source: { kind: 'user' },
  })
  const idle = waitForIdle(ctx, agent)
  agent.followup(impossible)
  await idle

  assert.equal(adapter.requests.length, 0)
  assert.ok(agent.session.snapshotEvents().some(event =>
    event.type === 'user/message' && event.data.id === impossible.id))
})

test('replays downstream middleware without persisting duplicate output', async () => {
  const adapter = new ScriptedAdapter([
    textResponse('continued once on the larger model'),
  ], {
    models: {
      small: { contextWindow: 1_000, defaultMaxTokens: 100 },
      large: { contextWindow: 10_000, defaultMaxTokens: 100 },
    },
  })
  const ctx = await harness(adapter, {
    reminderThresholdTokens: 100,
    fallbackReserveTokens: 200,
    outputReserveTokens: 100,
  })
  const downstream = createUserMessage({
    content: [{ type: 'text', text: `one-shot downstream context ${'x'.repeat(4_000)}` }],
    source: { kind: 'plugin', plugin: 'test', form: 'instructions' },
  })
  const agent = ctx.agentLoop.create(SessionId('late-rollover-retry'), { provider: 'mock', model: 'small' })
  let selectedModel = 'small'
  agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next()
    return {
      ...assembly,
      variables: { ...assembly.variables, provider: 'mock', model: selectedModel },
    }
  })
  agent.ctx.on('agent/request', async (_payload, next) => ({
    ...await next(),
    provider: 'mock',
    model: selectedModel,
  }))
  agent.ctx.on('agent/pre-step', async (_payload, next) => {
    const decision = await next()
    return decision.kind === 'reject'
      ? decision
      : { ...decision, messages: [...decision.messages, downstream] }
  })
  const user = createUserMessage({
    content: [{ type: 'text', text: 'keep this claimed input too' }],
    source: { kind: 'user' },
  })
  let idle = waitForIdle(ctx, agent)
  agent.followup(user)
  await idle

  assert.equal(adapter.requests.length, 0)
  const durableIds = new Set(agent.session.snapshotEvents()
    .filter(event => event.type === 'user/message')
    .map(event => event.data.id))
  assert.ok(durableIds.has(user.id))
  assert.equal(durableIds.has(downstream.id), false)

  selectedModel = 'large'
  idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'retry on the larger model' }],
    source: { kind: 'user' },
  }))
  await idle

  assert.equal(adapter.requests.length, 1)
  const request = JSON.stringify(adapter.requests[0].messages)
  assert.equal(request.match(/one-shot downstream context/g)?.length, 1)
})

test('retries a failed recovery-message flush before later pre-step work', async () => {
  const adapter = new ScriptedAdapter([], { contextWindow: 1_000, defaultMaxTokens: 100 })
  const ctx = await harness(adapter, {
    reminderThresholdTokens: 100,
    fallbackReserveTokens: 200,
    outputReserveTokens: 100,
  })
  const agent = ctx.agentLoop.create(SessionId('recovery-flush-retry'), { provider: 'mock', model: 'mock' })
  let flushAttempts = 0
  ctx.on('session/flush', session => {
    if (session !== agent.session) return
    flushAttempts += 1
    if (flushAttempts === 1) throw new Error('simulated recovery persistence failure')
  })
  let idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: `cannot fit or flush ${'x'.repeat(4_000)}` }],
    source: { kind: 'user' },
  }))
  await idle
  assert.equal(adapter.requests.length, 0)
  assert.equal(flushAttempts, 1)

  idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'retry after persistence recovery' }],
    source: { kind: 'user' },
  }))
  await idle
  assert.equal(flushAttempts, 3)
  assert.equal(adapter.requests.length, 0)
})

test('measures the final messages produced by downstream pre-step listeners', async () => {
  const adapter = new ScriptedAdapter([
    textResponse(`response before downstream context ${'r'.repeat(7_600)}`, { inputTokens: 1, outputTokens: 1 }),
    textResponse('continued with downstream context on the fresh surface'),
  ], { contextWindow: 2_500, defaultMaxTokens: 100 })
  const ctx = await harness(adapter, {
    reminderThresholdTokens: 100,
    fallbackReserveTokens: 200,
    outputReserveTokens: 100,
  })
  const agent = ctx.agentLoop.create(SessionId('downstream-input-session'), { provider: 'mock', model: 'mock' })
  let addDownstreamContext = false
  agent.ctx.on('agent/pre-step', async (_payload, next) => {
    const decision = await next()
    if (!addDownstreamContext || decision.kind === 'reject') return decision
    return {
      ...decision,
      messages: [...decision.messages, createUserMessage({
        content: [{ type: 'text', text: `downstream runtime context ${'z'.repeat(1_000)}` }],
        source: { kind: 'plugin', plugin: 'test', form: 'instructions' },
      })],
    }
  })

  let idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'old downstream surface' }],
    source: { kind: 'user' },
  }))
  await idle

  addDownstreamContext = true
  idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'continue with downstream context' }],
    source: { kind: 'user' },
  }))
  await idle

  const request = JSON.stringify(adapter.requests[1].messages)
  assert.match(request, /No prose handoff was produced/)
  assert.match(request, /downstream runtime context/)
  assert.doesNotMatch(request, /old downstream surface/)
})

test('replaces pending image structure cost with route pricing', async () => {
  const adapter = new ScriptedAdapter([
    textResponse('response before cheap image', { inputTokens: 20, outputTokens: 1 }),
    textResponse('continued without an unnecessary rollover'),
  ], {
    models: {
      cheap: { contextWindow: 1_000, defaultMaxTokens: 100, imageTokens: 1 },
    },
  })
  const ctx = await harness(adapter, {
    reminderThresholdTokens: 100,
    fallbackReserveTokens: 200,
    outputReserveTokens: 100,
  })
  const agent = ctx.agentLoop.create(SessionId('pending-image-pricing'), { provider: 'mock', model: 'cheap' })
  let idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'keep the existing surface' }],
    source: { kind: 'user' },
  }))
  await idle

  idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({
    content: [{
      type: 'image',
      attachment: {
        attachmentId: 'cheap-pending-image',
        mediaType: 'image/png',
        bytes: 4,
        width: 1,
        height: 1,
        name: `structurally-expensive-${'x'.repeat(3_000)}`,
      },
    }],
    source: { kind: 'user' },
  }))
  await idle

  const request = JSON.stringify(adapter.requests[1].messages)
  assert.match(request, /keep the existing surface/)
  assert.match(request, /cheap-pending-image/)
  assert.doesNotMatch(request, /No prose handoff was produced/)
})

test('remeasures a policy message before allowing fallback inference', async () => {
  const adapter = new ScriptedAdapter([
    textResponse(`large prior response ${'r'.repeat(2_800)}`, { inputTokens: 20, outputTokens: 720 }),
    textResponse('continued after policy-safe rollover'),
  ], { contextWindow: 1_000, defaultMaxTokens: 100 })
  const ctx = await harness(adapter, {
    reminderThresholdTokens: 100,
    fallbackReserveTokens: 200,
    outputReserveTokens: 100,
  })
  const agent = ctx.agentLoop.create(SessionId('policy-message-fit'), { provider: 'mock', model: 'mock' })
  let idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'establish pressure near the fallback boundary' }],
    source: { kind: 'user' },
  }))
  await idle

  idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'continue safely' }],
    source: { kind: 'user' },
  }))
  await idle

  const request = JSON.stringify(adapter.requests[1].messages)
  assert.match(request, /No prose handoff was produced/)
  assert.doesNotMatch(request, /fallback reserve is active/)
})

test('limits fallback inference to new_context and rolls over on success', async () => {
  const policy = {
    reminderThresholdTokens: 100,
    fallbackReserveTokens: 500,
    outputReserveTokens: 100,
  }
  const adapter = new ScriptedAdapter([
    // Enter fallback at the normal-budget boundary with room for the full handoff contract.
    textResponse('first response', { inputTokens: 9_400, outputTokens: 1 }),
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

test('PTC fallback guard permits only new_context through run_code and completes rollover', async () => {
  const policy = {
    reminderThresholdTokens: 100,
    fallbackReserveTokens: 500,
    outputReserveTokens: 100,
  }
  const adapter = new ScriptedAdapter([
    // Enter fallback at the normal-budget boundary with room for the full handoff contract.
    textResponse('first response', { inputTokens: 9_400, outputTokens: 1 }),
    toolCallResponse('fallback-program', 'run_code', {
      code: '/* attempt-other */ return await tools.new_context({ handoff: "PTC fallback handoff." })',
      description: 'Prepare context handoff',
    }),
    textResponse('continued after PTC rollover'),
  ], { contextWindow: 10_000, defaultMaxTokens: 100 })
  const ctx = await harness(adapter, policy, { mode: 'ptc' })
  let otherRan = false
  ctx.tools.register(defineTool({
    name: 'other_tool',
    description: 'Must be hidden during fallback.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      otherRan = true
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
  assert.equal(otherRan, false)
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
    fallbackReserveTokens: 500,
    outputReserveTokens: 100,
  }
  const adapter = new ScriptedAdapter([
    textResponse('first response', { inputTokens: 2_450, outputTokens: 1 }),
    textResponse(`incorrect final instead of handoff ${'q'.repeat(9_000)}`, { inputTokens: 1, outputTokens: 1 }),
    textResponse('continued after forced rollover'),
  ], { contextWindow: 3_000, defaultMaxTokens: 100 })
  const ctx = await harness(adapter, policy)
  const agent = ctx.agentLoop.create(SessionId('forced-session'), { provider: 'mock', model: 'mock' })
  let idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'start' }], source: { kind: 'user' } }))
  await idle

  idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
  await idle

  assert.match(JSON.stringify(adapter.requests[1]?.messages), /normal task budget is exhausted/)
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

test('fallback request failure forces rollover and retries within the same user turn', async () => {
  const policy = {
    reminderThresholdTokens: 100,
    fallbackReserveTokens: 1_200,
    outputReserveTokens: 100,
  }
  const adapter = new ScriptedAdapter([
    // Leave enough reserve to dispatch the complete fallback handoff contract before transport fails.
    textResponse('first response', { inputTokens: 730, outputTokens: 1 }),
    new Error('simulated fallback transport failure'),
    textResponse('continued after failed fallback request'),
  ], { contextWindow: 2_000, defaultMaxTokens: 100 })
  const ctx = await harness(adapter, policy)
  const agent = ctx.agentLoop.create(SessionId('fallback-request-error'), { provider: 'mock', model: 'mock' })
  let idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'start' }], source: { kind: 'user' } }))
  await idle

  idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
  await idle

  assert.equal(adapter.requests.length, 3)
  assert.match(JSON.stringify(adapter.requests[2].messages), /No prose handoff was produced/)
  const secondTurnStarts = agent.session.snapshotEvents().filter(event => event.type === 'turn/start')
  assert.equal(secondTurnStarts.length, 2)
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

test('resolves persisted parent lineage by project scope when native ids collide', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const cwd = '/tmp/dsh-context-window-scoped-child'
  const otherCwd = '/tmp/dsh-context-window-other-project'
  const parentId = SessionId('shared-parent-id')
  const child = ctx.sessions.create(SessionId('scoped-child'), {
    meta: {
      cwd,
      parentSession: parentId,
      isSeeded: false,
      origin: 'subagent',
    },
  })
  const persistence = {
    async list() {
      return [
        { version: 0, id: parentId, createdAt: 1, cwd, isSeeded: false },
        { version: 0, id: parentId, createdAt: 2, cwd: otherCwd, isSeeded: false },
      ]
    },
  }
  const identityContext = {
    sessions: { get: () => ({ header: { cwd: otherCwd } }) },
    get: service => service === 'sessionPersistence' ? persistence : undefined,
  }

  const anchors = await recoveryAnchors(identityContext, child, 6, 7)
  assert.equal(anchors.sessionId, canonicalDeepseekTreeSessionId(parentId, deepseekProjectScope(cwd)))
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
  const firstRequest = JSON.stringify(adapter.requests[0])
  assert.match(firstRequest, /SPEC-CONFIRMED REQUIREMENTS/)
  assert.match(firstRequest, /AGENT INFERENCES/)
  assert.match(firstRequest, /UNRESOLVED CONFLICTS/)
  assert.match(firstRequest, /UNVERIFIED ACCEPTANCE CRITERIA/)
  assert.match(firstRequest, /never `LOCKED DESIGN`/)
  assert.match(firstRequest, /confirmed by repetition/)
  const secondText = JSON.stringify(adapter.requests[1].messages)
  assert.doesNotMatch(secondText, /old context request/)
  assert.match(secondText, /Goal: finish the parser/)
  assert.match(secondText, /Treat this handoff as a checkpoint, not an exhaustive history/)
  assert.match(secondText, /load the `obelisk` skill before re-deriving it/)
  assert.match(secondText, /Scope searches to `session_id`/)
  assert.match(secondText, /use `context\(message_uuid\)` to expand from the previous-window boundary/)
  assert.match(secondText, /Do not use global history search for this task/)
  assert.match(secondText, /Treat unsectioned or `LOCKED DESIGN` claims as `AGENT INFERENCES`/)
  assert.match(secondText, /direct user, spec, or source evidence/)

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
  const replayed = agent.session.snapshotEvents().reduce(
    (state, event) => contextWindowProjectionDefinition.apply(state, event),
    contextWindowProjectionDefinition.init({}),
  )
  assert.deepEqual(
    replayed,
    ctx.sessionProjections.stateOf(agent.session, 'obeliskContextWindow'),
  )
  const checkpoint = ctx.sessionProjections.checkpoint(agent.session)
  const floor = ctx.sessionProjections.restoreFloor(checkpoint)
  assert.notEqual(floor, undefined)
  const restored = ctx.sessionProjections.restore(
    checkpoint,
    agent.session.snapshotEvents(floor),
    floor,
    agent.session.header,
    agent.session.inheritedEventCount,
  )
  assert.deepEqual(
    restored.checkpoint.obeliskContextWindow.val,
    ctx.sessionProjections.stateOf(agent.session, 'obeliskContextWindow'),
  )
})

test('restores unchanged runtime context after replacing the old surface', async () => {
  const adapter = new ScriptedAdapter([
    toolCallResponse('runtime-context-rollover', 'new_context', { handoff: 'Continue with runtime context.' }),
    textResponse('continued with restored runtime context'),
  ])
  const ctx = await harness(adapter)
  ctx.systemPrompt.context({
    name: 'test:stable-runtime-context',
    order: 10,
    text: 'Stable runtime context must survive rollover.',
  })
  const agent = ctx.agentLoop.create(SessionId('runtime-context-rollover'), { provider: 'mock', model: 'mock' })
  const idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'start with runtime context' }],
    source: { kind: 'user' },
  }))
  await idle

  assert.match(JSON.stringify(adapter.requests[0].messages), /Stable runtime context must survive rollover/)
  assert.match(JSON.stringify(adapter.requests[1].messages), /Stable runtime context must survive rollover/)
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

test('a persisted crash after prune but before replacement converges on resume', async () => {
  const root = makeTempDir('obelisk-context-rollover-crash-')
  const cwd = resolve(root, 'project')
  const sessionId = SessionId('rollover-crash-session')
  const callId = ToolCallId('rollover-crash-call')

  const first = new Context()
  await first.plugin(SessionStore)
  await first.plugin(SessionProjectionRegistry)
  await first.plugin(TokenMeter)
  await first.plugin(JsonlSessionPersistence, {
    root,
    compression: 'none',
    packChunks: false,
    writeBatchMaxDelayMs: 1,
  })
  const session = first.sessions.create(sessionId, { meta: { cwd } })
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'work before crash' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{
        type: 'tool-call',
        id: callId,
        name: 'new_context',
        arguments: JSON.stringify({ handoff: 'Resume the work after the crash.' }),
      }],
      source: { provider: 'mock', model: 'mock' },
    }),
    usage: { inputTokens: 20, outputTokens: 5 },
  }, { surfaceOp: 'append' })
  const call = session.append('tool/call', {
    turn: 1,
    step: 1,
    callId,
    name: 'new_context',
    arguments: JSON.stringify({ handoff: 'Resume the work after the crash.' }),
  })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId,
      content: [{ type: 'text', text: 'accepted' }],
      isError: false,
    }),
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  session.append('step/end', { turn: 1, step: 1 })
  const measured = first.tokenMeter.measure(session)
  const nodes = session.surface.nodes
  session.append('compaction/prune', {
    shadowedRange: { start: nodes[0], end: nodes.at(-1) },
    shadowedSeqs: [...nodes],
    shadowedTokenCount: measured.nodes.reduce((total, node) => total + node.heuristicTokens, 0),
  })
  await first.sessions.flush(session)

  const adapter = new ScriptedAdapter([textResponse('continued after crash recovery')])
  const second = new Context()
  await second.plugin(LlmRuntime)
  await second.plugin(SessionStore)
  await second.plugin(SessionProjectionRegistry)
  await second.plugin(TokenMeter)
  await second.plugin(SystemPrompt, { persona: 'test' })
  await second.plugin(ToolRuntime)
  await second.plugin(JsonlSessionPersistence, {
    root,
    compression: 'none',
    packChunks: false,
    writeBatchMaxDelayMs: 1,
  })
  await second.plugin(SessionCheckpointPolicy)
  await second.plugin(AgentRegistry)
  await second.plugin(AgentLoop, { agents: [] })
  await second.plugin(ContextWindowPlugin)
  second.llm.registerAdapter(['mock'], adapter)
  const handle = await second.agents.resume({
    resumeSessionId: sessionId,
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  const agent = handle.agent
  const idle = waitForIdle(second, agent)
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'continue the interrupted task' }],
    source: { kind: 'user' },
  }))
  await idle

  assert.equal(adapter.requests.length, 1)
  const request = JSON.stringify(adapter.requests[0].messages)
  assert.match(request, /Resume the work after the crash/)
  assert.doesNotMatch(request, /work before crash/)
  const replacements = agent.session.snapshotEvents().filter(event =>
    event.type === 'user/message' && event.data.source.kind === 'obelisk-context-handoff')
  assert.equal(replacements.length, 1)
  const replacementSource = replacements[0].data.source
  await handle.dispose()

  const provider = createDeepseekProvider({ rootDir: root })
  const unit = provider.discover({ lastCursor: () => null })[0]
  assert.ok(unit)
  const db = new DatabaseSync(':memory:')
  db.exec(coreSchema)
  persist(db, unit, provider.parse(unit, null))
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE id=?').get(
    replacementSource.sessionId,
  ).count, 1)
  const api = createQueryApi(db)
  assert.equal(
    api.context(replacementSource.previousContextMessageUuid).message.uuid,
    replacementSource.previousContextMessageUuid,
  )
  const scoped = api.search('work before crash', {
    sessionId: replacementSource.sessionId,
    limit: 10,
  })
  assert.ok(scoped.length > 0)
  assert.ok(scoped.every(hit => hit.session.id === replacementSource.sessionId))
  db.close()
})

test('flush failure blocks dispatch until the rollover flush succeeds', async () => {
  const adapter = new ScriptedAdapter([
    toolCallResponse('flush-failure', 'new_context', { handoff: 'Persist before continuing.' }),
    textResponse('continued after persistence recovered'),
  ])
  const ctx = await harness(adapter)
  const agent = ctx.agentLoop.create(SessionId('flush-failure-session'), { provider: 'mock', model: 'mock' })
  let flushAttempts = 0
  ctx.on('session/flush', session => {
    if (session !== agent.session) return
    flushAttempts += 1
    if (flushAttempts === 1) throw new Error('simulated persistence failure')
  })
  let idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'start' }], source: { kind: 'user' } }))
  await idle

  assert.equal(adapter.requests.length, 1)
  assert.equal(flushAttempts, 1)
  assert.equal(agent.session.snapshotEvents().filter(event =>
    event.type === 'user/message' && event.data.source.kind === 'obelisk-context-handoff').length, 1)

  idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'retry after persistence recovers' }], source: { kind: 'user' } }))
  await idle

  assert.equal(flushAttempts, 2)
  assert.equal(adapter.requests.length, 2)
  assert.match(JSON.stringify(adapter.requests[1].messages), /retry after persistence recovers/)
})
