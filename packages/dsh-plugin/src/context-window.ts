// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type Message } from '@deepseek-ai/dsh-llm'
import type { EpochHeader } from '@deepseek-ai/dsh-session'
import {
  renderPrompt,
  type PromptAssembly,
} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-compaction'

import {
  decideContextWindowBudget,
  type ContextWindowBudgetDecision,
  type ContextWindowBudgetPolicy,
} from './context-window-budget.ts'
import { recoverySessionId } from './context-window-identity.ts'
import { CONTEXT_WINDOW_GUIDANCE } from './context-window-prompt.ts'
import {
  applyForcedRollover,
  ensureRolloverFlushed,
  handlePreStep,
  queueForcedRolloverStep,
} from './context-window-rollover.ts'
import { contextWindowProjectionDefinition } from './context-window-state.ts'

export const name = '@obelisk/dsh-obelisk-plugin/context-window'
export const inject = ['llm', 'tools', 'systemPrompt', 'sessions', 'sessionProjections', 'tokenMeter']

export interface Config {
  /** Defaults to the effective model maxTokens for the current request. */
  reminderThresholdTokens?: number
  /** Defaults to the effective model maxTokens for the current request. */
  fallbackReserveTokens?: number
  /** Defaults to the effective model maxTokens for the current request. */
  outputReserveTokens?: number
}

interface AssemblyBudgetPlan {
  readonly requestHeader?: EpochHeader
  decide(additionalTokens?: number): ContextWindowBudgetDecision | undefined
}

type RequestImage = Parameters<
  NonNullable<ReturnType<Context['llm']['imageRequestPricing']>>['priceImages']
>[0][number]

const output = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

function optionalPositiveTokens(name: string, value: unknown): void {
  if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)) {
    throw new TypeError(`context-window ${name} must be a positive safe integer`)
  }
}

function validateConfig(config: unknown): asserts config is Config {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new TypeError('context-window config must be an object')
  }
  const known = new Set(['reminderThresholdTokens', 'fallbackReserveTokens', 'outputReserveTokens'])
  const unknown = Object.keys(config).filter(key => !known.has(key))
  if (unknown.length > 0) throw new TypeError(`context-window config has unknown key ${JSON.stringify(unknown[0])}`)
  optionalPositiveTokens('reminderThresholdTokens', Reflect.get(config, 'reminderThresholdTokens'))
  optionalPositiveTokens('fallbackReserveTokens', Reflect.get(config, 'fallbackReserveTokens'))
  optionalPositiveTokens('outputReserveTokens', Reflect.get(config, 'outputReserveTokens'))
}

/** Reject the one known competing automatic surface-pressure owner. */
export function assertCompatibleCompaction(ctx: Context): void {
  const compaction = ctx.get('compaction') as { config?: { auto?: unknown } } | undefined
  if (compaction?.config?.auto === true) {
    throw new Error('context-window cannot run while compaction-basic.auto is enabled; set auto: false')
  }
}

function effectivePolicy(
  agent: Agent,
  config: Config,
  selectedMaxTokens?: number,
): ContextWindowBudgetPolicy {
  const maxTokens = selectedMaxTokens
    ?? agent.session.requestHeader()?.config.maxTokens
    ?? agent.options.maxTokens
  const outputReserveTokens = config.outputReserveTokens ?? maxTokens
  if (outputReserveTokens === undefined) {
    throw new Error('context-window: set outputReserveTokens when the effective model has no maxTokens')
  }
  return {
    outputReserveTokens,
    fallbackReserveTokens: config.fallbackReserveTokens ?? maxTokens ?? outputReserveTokens,
    reminderThresholdTokens: config.reminderThresholdTokens ?? maxTokens ?? outputReserveTokens,
  }
}

/** Resolve current host pressure without scanning the session log. */
export function budgetDecision(
  ctx: Context,
  agent: Agent,
  config: Config,
  additionalTokens = 0,
): ContextWindowBudgetDecision | undefined {
  const pressure = ctx.sessionProjections.stateOf(agent.session, 'contextPressure')
  if (pressure?.contextWindow === undefined) return undefined
  const state = ctx.sessionProjections.stateOf(agent.session, 'obeliskContextWindow')
  return decideContextWindowBudget({
    contextWindow: pressure.contextWindow,
    totalTokens: ctx.tokenMeter.measure(agent.session).totalTokens + additionalTokens,
    explicitRolloverPending: state?.pending !== undefined,
    reminderClaimed: state?.reminderClaimed ?? false,
    fallbackClaimed: state?.fallbackClaimed ?? false,
    policy: effectivePolicy(agent, config),
  })
}

function decideForCapacity(
  ctx: Context,
  agent: Agent,
  config: Config,
  contextWindow: number,
  requestHeader: EpochHeader,
  maxTokens?: number,
  additionalTokens = 0,
): ContextWindowBudgetDecision {
  const state = ctx.sessionProjections.stateOf(agent.session, 'obeliskContextWindow')
  return decideContextWindowBudget({
    contextWindow,
    totalTokens: ctx.tokenMeter.measure(agent.session, requestHeader).totalTokens + additionalTokens,
    explicitRolloverPending: state?.pending !== undefined,
    reminderClaimed: state?.reminderClaimed ?? false,
    fallbackClaimed: state?.fallbackClaimed ?? false,
    policy: effectivePolicy(agent, config, maxTokens),
  })
}

function collectImages(message: Message): RequestImage[] {
  const images: RequestImage[] = []
  const visit = (content: Message['content']): void => {
    for (const block of content) {
      if (block.type === 'image') images.push(block.attachment)
      if (block.type === 'tool-result') visit(block.content)
    }
  }
  visit(message.content)
  return images
}

function withoutImages(content: Message['content']): Message['content'] {
  const stripped: Message['content'][number][] = []
  for (const block of content) {
    if (block.type === 'image') continue
    stripped.push(block.type === 'tool-result'
      ? { ...block, content: withoutImages(block.content) }
      : block)
  }
  return stripped
}

function estimateTextBlock(ctx: Context, text: string): number {
  const source = { kind: 'user' as const }
  const withText = createUserMessage({ content: [{ type: 'text', text }], source })
  const withoutText = createUserMessage({ content: [], source })
  return ctx.tokenMeter.estimateMessage(withText) - ctx.tokenMeter.estimateMessage(withoutText)
}

function pendingMessageTokens(
  ctx: Context,
  messages: readonly Message[],
  requestHeader?: EpochHeader,
): number {
  if (requestHeader === undefined) {
    return messages.reduce((sum, message) => sum + ctx.tokenMeter.estimateMessage(message), 0)
  }
  const pricing = ctx.llm.imageRequestPricing(
    requestHeader.config.provider,
    requestHeader.config.model,
  )
  if (pricing === undefined) {
    return messages.reduce((sum, message) => sum + ctx.tokenMeter.estimateMessage(message), 0)
  }
  let total = 0
  const images: RequestImage[] = []
  for (const message of messages) {
    const messageImages = collectImages(message)
    images.push(...messageImages)
    total += messageImages.length === 0
      ? ctx.tokenMeter.estimateMessage(message)
      : ctx.tokenMeter.estimateMessage({ ...message, content: withoutImages(message.content) })
  }
  const prices = pricing.priceImages(images)
  if (prices.length !== images.length) {
    throw new Error(`context-window: route image pricing returned ${prices.length} prices for ${images.length} images`)
  }
  for (const price of prices) {
    total += price.visualTokens + estimateTextBlock(ctx, price.text)
  }
  return total
}

function assemblyRequestHeader(
  agent: Agent,
  assembly: PromptAssembly,
  provider: string,
  model: string,
  defaultMaxTokens?: number,
): EpochHeader {
  const previous = agent.session.requestHeader()
  const config = { ...previous?.config, provider, model }
  if (previous?.adapterDefaults?.reasoningEffort === true) delete config.reasoningEffort
  if (previous?.adapterDefaults?.maxTokens === true) delete config.maxTokens
  if (agent.options.reasoningEffort !== undefined) config.reasoningEffort = agent.options.reasoningEffort
  const maxTokens = agent.options.maxTokens ?? defaultMaxTokens
  if (maxTokens !== undefined) config.maxTokens = maxTokens
  const system = renderPrompt(assembly)
  return {
    config,
    ...(agent.options.maxTokens === undefined && defaultMaxTokens !== undefined
      ? { adapterDefaults: { maxTokens: true as const } }
      : {}),
    ...(system === '' ? {} : { system }),
    ...(assembly.tools.length === 0 ? {} : { tools: assembly.tools }),
  }
}

/** Resolve the route captured by this exact prompt assembly before applying pressure policy. */
async function assemblyBudgetPlan(
  ctx: Context,
  agent: Agent,
  config: Config,
  assembly: PromptAssembly,
  signal?: AbortSignal,
): Promise<AssemblyBudgetPlan> {
  const previous = agent.session.requestHeader()?.config
  const provider = assembly.variables.provider ?? agent.options.provider ?? previous?.provider
  const model = assembly.variables.model ?? agent.options.model ?? previous?.model
  if (provider === undefined || provider.length === 0 || model === undefined || model.length === 0) {
    return { decide: additionalTokens => budgetDecision(ctx, agent, config, additionalTokens) }
  }
  const selected = await ctx.llm.resolveModelInfo(provider, model, signal)
  const contextWindow = selected.context?.contextWindow
  if (contextWindow === undefined) {
    return { decide: additionalTokens => budgetDecision(ctx, agent, config, additionalTokens) }
  }
  const maxTokens = agent.options.maxTokens ?? selected.defaultMaxTokens
  const requestHeader = assemblyRequestHeader(agent, assembly, provider, model, selected.defaultMaxTokens)
  return {
    requestHeader,
    decide: additionalTokens => decideForCapacity(
        ctx,
        agent,
        config,
        contextWindow,
        requestHeader,
        maxTokens,
        additionalTokens,
      ),
  }
}

/** Restrict one fallback request to the new_context capability and PTC transport. */
export function fallbackAssembly(ctx: Context, assembly: PromptAssembly, agent: Agent): PromptAssembly {
  const definition = ctx.tools.get('new_context', agent)
  if (definition === undefined) throw new Error('context-window: new_context is unavailable during fallback')
  const tools = assembly.tools.filter(tool => tool.name === 'new_context' || tool.name === 'run_code')
  return { ...assembly, tools }
}

/** Register the opt-in prose handoff, pressure policy, and safe-boundary rollover path. */
export function apply(ctx: Context, config: unknown = {}): void {
  validateConfig(config)
  assertCompatibleCompaction(ctx)
  const assemblies = new WeakMap<Agent, {
    assembly: PromptAssembly
    decision: ContextWindowBudgetDecision | undefined
    budgetPlan: AssemblyBudgetPlan
    fullTools: PromptAssembly['tools']
  }>()
  ctx.sessionProjections.register(contextWindowProjectionDefinition)
  ctx.systemPrompt.section({
    name: 'obelisk:context-window',
    order: 700,
    text: CONTEXT_WINDOW_GUIDANCE,
  })
  ctx.tools.register(defineTool({
    name: 'new_context',
    description: 'Start a fresh context after preserving a prose handoff for continuing the current task.',
    parameters: {
      handoff: {
        type: 'string',
        required: true,
        description: 'Concise prose covering goal, decisions, progress, learnings, next steps, unresolved requests, and important actions.',
      },
    },
    output,
    async execute(args, exec) {
      if (typeof args.handoff !== 'string' || args.handoff.trim() === '') {
        throw new TypeError('new_context handoff must be a non-empty prose string')
      }
      if (exec.agent === undefined) throw new Error('new_context requires an agent-owned execution')
      await recoverySessionId(ctx, exec.agent.session, exec.signal)
      return 'A fresh context will start after this sampling step.'
    },
  }))
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    assertCompatibleCompaction(ctx)
    const resolved = await next()
    const agent = context.agent
    if (agent === undefined) return resolved
    const budgetPlan = await assemblyBudgetPlan(ctx, agent, config, resolved, context.signal)
    const decision = budgetPlan.decide()
    const selected = decision?.kind === 'fallback'
      ? fallbackAssembly(ctx, resolved, agent)
      : resolved
    assemblies.set(agent, { assembly: selected, decision, budgetPlan, fullTools: resolved.tools })
    return selected
  }, { prepend: true })
  ctx.tools.guard(exec => {
    const agent = exec.agent
    if (agent === undefined) return undefined
    const state = ctx.sessionProjections.stateOf(agent.session, 'obeliskContextWindow')
    if (state?.fallbackClaimed !== true) return undefined
    if (exec.name === 'new_context' || (exec.name === 'run_code' && exec.parent === undefined)) {
      return undefined
    }
    return 'The context-window fallback reserve only permits new_context.'
  })
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    assertCompatibleCompaction(ctx)
    await ensureRolloverFlushed(ctx, agent, signal)
    const captured = assemblies.get(agent)
    const decide = (additionalTokens = 0): ContextWindowBudgetDecision | undefined => (
      captured === undefined
        ? budgetDecision(ctx, agent, config, additionalTokens)
        : captured.budgetPlan.decide(additionalTokens)
    )
    let decision = decide()
    const applySchemas = (): void => {
      if (captured === undefined) return
      captured.decision = decision
      captured.assembly.tools = decision?.kind === 'fallback'
        ? fallbackAssembly(ctx, { ...captured.assembly, tools: captured.fullTools }, agent).tools
        : [...captured.fullTools]
    }
    const knownRollover = decision?.kind === 'rollover'
    if (knownRollover) applySchemas()
    let resolved = knownRollover
      ? await handlePreStep(ctx, agent, signal, decision, next)
      : await next()
    if (resolved.kind === 'reject') return resolved

    const pendingTokens = pendingMessageTokens(
      ctx,
      resolved.messages,
      captured?.budgetPlan.requestHeader,
    )
    decision = decide(pendingTokens)
    if (decision?.kind === 'rollover' && !knownRollover) {
      applySchemas()
      resolved = await handlePreStep(
        ctx,
        agent,
        signal,
        decision,
        () => Promise.resolve(resolved),
      )
      decision = decide(pendingTokens)
    }
    if (decision?.kind === 'rollover' && decision.reason === 'hard-limit') {
      for (const message of messages) agent.inject(message)
      throw new Error(
        'context-window: pending input exceeds the fresh context capacity; '
        + 'the input was preserved for retry with a larger model or smaller request',
      )
    }
    applySchemas()
    return handlePreStep(
      ctx,
      agent,
      signal,
      decision,
      () => Promise.resolve(resolved),
    )
  }, { prepend: true })
  ctx.on('agent/request-error', async ({ agent, signal }, next) => {
    const downstream = await next()
    if (downstream?.kind === 'retry' || signal.aborted) return downstream
    const state = ctx.sessionProjections.stateOf(agent.session, 'obeliskContextWindow')
    const captured = assemblies.get(agent)
    if (state?.fallbackClaimed !== true || captured?.decision?.kind !== 'fallback') return downstream
    await applyForcedRollover(ctx, agent, signal)
    captured.assembly.tools = [...captured.fullTools]
    return { kind: 'retry' }
  })
  ctx.on('agent/turn-stopping', ({ agent }) => {
    const state = ctx.sessionProjections.stateOf(agent.session, 'obeliskContextWindow')
    const decision = budgetDecision(ctx, agent, config)
    if (state?.fallbackClaimed === true
      && state.pending === undefined
      && decision?.kind === 'rollover'
      && decision.reason === 'hard-limit') {
      queueForcedRolloverStep(agent)
    }
  })
}
