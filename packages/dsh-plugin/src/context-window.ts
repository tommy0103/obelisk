// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import {
  defineTool,
  renderToolsSdk,
  renderToolsSdkPy,
} from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-code-runtime'

import {
  decideContextWindowBudget,
  type ContextWindowBudgetDecision,
  type ContextWindowBudgetPolicy,
} from './context-window-budget.ts'
import { recoverySessionId } from './context-window-identity.ts'
import { CONTEXT_WINDOW_GUIDANCE } from './context-window-prompt.ts'
import { handlePreStep, queueForcedRolloverStep } from './context-window-rollover.ts'
import { contextWindowProjectionDefinition } from './context-window-state.ts'

export const name = '@obelisk/dsh-obelisk-plugin/context-window'
export const inject = ['tools', 'systemPrompt', 'sessions', 'sessionProjections', 'tokenMeter']

export interface Config {
  /** Defaults to the effective model maxTokens for the current request. */
  reminderThresholdTokens?: number
  /** Defaults to the effective model maxTokens for the current request. */
  fallbackReserveTokens?: number
  /** Defaults to the effective model maxTokens for the current request. */
  outputReserveTokens?: number
}

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

function effectivePolicy(agent: Agent, config: Config): ContextWindowBudgetPolicy {
  const maxTokens = agent.session.requestHeader()?.config.maxTokens ?? agent.options.maxTokens
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
): ContextWindowBudgetDecision | undefined {
  const pressure = ctx.sessionProjections.stateOf(agent.session, 'contextPressure')
  if (pressure?.contextWindow === undefined) return undefined
  const state = ctx.sessionProjections.stateOf(agent.session, 'obeliskContextWindow')
  return decideContextWindowBudget({
    contextWindow: pressure.contextWindow,
    totalTokens: ctx.tokenMeter.measure(agent.session).totalTokens,
    explicitRolloverPending: state?.pending !== undefined,
    reminderClaimed: state?.reminderClaimed ?? false,
    fallbackClaimed: state?.fallbackClaimed ?? false,
    policy: effectivePolicy(agent, config),
  })
}

function sdkSchema(definition: ToolDefinition) {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    output: definition.output.schema,
  }
}

/** Restrict one fallback request to the new_context capability and PTC transport. */
export function fallbackAssembly(ctx: Context, assembly: PromptAssembly, agent: Agent): PromptAssembly {
  const definition = ctx.tools.get('new_context', agent)
  if (definition === undefined) throw new Error('context-window: new_context is unavailable during fallback')
  const tools = assembly.tools.filter(tool => tool.name === 'new_context' || tool.name === 'run_code')
  const hasPtc = tools.some(tool => tool.name === 'run_code')
  if (!hasPtc) return { ...assembly, tools }
  const runtime = ctx.get('codeRuntime')
  if (runtime === undefined) throw new Error('context-window: PTC fallback requires a code runtime')
  const text = runtime.language === 'python'
    ? renderToolsSdkPy([sdkSchema(definition)])
    : renderToolsSdk([sdkSchema(definition)])
  return {
    ...assembly,
    tools,
    sections: assembly.sections.map(section => (
      section.name === 'tools:sdk' ? { ...section, text } : section
    )),
  }
}

/** Register the opt-in prose handoff, pressure policy, and safe-boundary rollover path. */
export function apply(ctx: Context, config: unknown = {}): void {
  validateConfig(config)
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
    const resolved = await next()
    const agent = context.agent
    return agent !== undefined && budgetDecision(ctx, agent, config)?.kind === 'fallback'
      ? fallbackAssembly(ctx, resolved, agent)
      : resolved
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
  ctx.on('agent/pre-step', ({ agent, signal }, next) => (
    handlePreStep(ctx, agent, signal, budgetDecision(ctx, agent, config), next)
  ), { prepend: true })
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
