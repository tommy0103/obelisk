// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-compaction/types'
import type {} from '@deepseek-ai/dsh-token-meter'

import type { ContextWindowBudgetDecision } from './context-window-budget.ts'
import { recoveryAnchors } from './context-window-identity.ts'
import {
  CONTEXT_WINDOW_FALLBACK,
  CONTEXT_WINDOW_REMINDER,
  renderContextHandoff,
  renderMissingContextHandoff,
} from './context-window-prompt.ts'
import type { PendingRollover } from './context-window-state.ts'

export type ContextRolloverTrigger =
  | { kind: 'model'; rootCallId: string }
  | { kind: 'hard-limit' }

const unflushedRollovers = new WeakSet<Session>()

/** Retry a previously failed rollover flush before any later request work runs. */
export async function ensureRolloverFlushed(
  ctx: Context,
  agent: Agent,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  if (!unflushedRollovers.has(agent.session)) return
  await ctx.sessions.flush(agent.session)
  unflushedRollovers.delete(agent.session)
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'obelisk-context-pressure': {
      kind: 'obelisk-context-pressure'
      phase: 'reminder' | 'fallback'
      generation: number
    }
    'obelisk-context-handoff': {
      kind: 'obelisk-context-handoff'
      trigger: ContextRolloverTrigger
      handoffStatus: 'present' | 'missing'
      sessionId: string
      previousContextMessageUuid: string
    }
  }
}

function assistantKind(session: Session): {
  turn: number
  step: number
  kind: 'reasoning' | 'text' | 'tool_use'
} {
  for (let index = session.surface.nodes.length - 1; index >= 0; index -= 1) {
    const seq = session.surface.nodes[index]
    if (seq === undefined) continue
    const event = session.eventAt(seq)
    if (event?.type !== 'assistant/message') continue
    const content = event.data.message.content
    const kind = content.some(block => block.type === 'tool-call')
      ? 'tool_use'
      : content.some(block => block.type === 'text')
        ? 'text'
        : content.some(block => block.type === 'reasoning')
          ? 'reasoning'
          : 'text'
    return { turn: event.data.turn, step: event.data.step, kind }
  }
  throw new Error('context-window: forced rollover requires a previous assistant message')
}

export function contextPressureMessage(phase: 'reminder' | 'fallback', generation: number) {
  return createUserMessage({
    content: [{
      type: 'text',
      text: phase === 'reminder' ? CONTEXT_WINDOW_REMINDER : CONTEXT_WINDOW_FALLBACK,
    }],
    source: { kind: 'obelisk-context-pressure' as const, phase, generation },
  })
}

function validateShadowPrice(ctx: Context, session: Session): {
  nodes: typeof session.surface.nodes
  shadowedTokenCount: number
} {
  const nodes = session.surface.nodes
  if (nodes.length === 0) throw new Error('context-window: cannot replace an empty active surface')
  const measured = ctx.tokenMeter.measure(session)
  if (measured.nodes.length !== nodes.length
    || measured.nodes.some((node, index) => node.seq !== nodes[index])) {
    throw new Error('context-window: token measurement does not match the active surface')
  }
  return {
    nodes,
    shadowedTokenCount: measured.nodes.reduce((total, node) => total + node.heuristicTokens, 0),
  }
}

/** Replace the complete active surface with one durable recovery handoff. */
async function applyRollover(
  ctx: Context,
  agent: Agent,
  source: {
    kind: 'obelisk-context-handoff'
    trigger: ContextRolloverTrigger
    handoffStatus: 'present' | 'missing'
    sessionId: string
    previousContextMessageUuid: string
  },
  text: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  const { session } = agent
  const { nodes, shadowedTokenCount } = validateShadowPrice(ctx, session)
  const message = createUserMessage({ content: [{ type: 'text', text }], source })
  signal?.throwIfAborted()
  session.append('compaction/prune', {
    shadowedRange: { start: nodes[0]!, end: nodes.at(-1)! },
    shadowedSeqs: [...nodes],
    shadowedTokenCount,
  })
  session.append('user/message', message, {
    surfaceOp: { op: 'replace', start: nodes[0]!, end: nodes.at(-1)! },
    sourceEventSeqs: [...nodes],
  })
  unflushedRollovers.add(session)
  await ctx.sessions.flush(session)
  unflushedRollovers.delete(session)
}

/** Replace the complete active surface with the model-authored prose handoff. */
export async function applyExplicitRollover(
  ctx: Context,
  agent: Agent,
  pending: PendingRollover,
  signal?: AbortSignal,
): Promise<void> {
  const anchors = await recoveryAnchors(
    ctx,
    agent.session,
    pending.turn,
    pending.step,
    'tool_use',
    signal,
  )
  await applyRollover(ctx, agent, {
    kind: 'obelisk-context-handoff',
    trigger: { kind: 'model', rootCallId: pending.rootCallId },
    handoffStatus: 'present',
    sessionId: anchors.sessionId,
    previousContextMessageUuid: anchors.messageUuid,
  }, renderContextHandoff(anchors.sessionId, anchors.messageUuid, pending.handoff), signal)
}

/** Replace the complete active surface with a host-authored recovery instruction. */
export async function applyForcedRollover(
  ctx: Context,
  agent: Agent,
  signal?: AbortSignal,
): Promise<void> {
  const latest = assistantKind(agent.session)
  const anchors = await recoveryAnchors(
    ctx,
    agent.session,
    latest.turn,
    latest.step,
    latest.kind,
    signal,
  )
  await applyRollover(ctx, agent, {
    kind: 'obelisk-context-handoff',
    trigger: { kind: 'hard-limit' },
    handoffStatus: 'missing',
    sessionId: anchors.sessionId,
    previousContextMessageUuid: anchors.messageUuid,
  }, renderMissingContextHandoff(anchors.sessionId, anchors.messageUuid), signal)
}

/** Apply rollover or add one durable pressure instruction at the pre-step boundary. */
export async function handlePreStep(
  ctx: Context,
  agent: Agent,
  signal: AbortSignal,
  budget: ContextWindowBudgetDecision | undefined,
  next: () => Promise<PreStepDecision>,
): Promise<PreStepDecision> {
  await ensureRolloverFlushed(ctx, agent, signal)
  const state = ctx.sessionProjections.stateOf(agent.session, 'obeliskContextWindow')
  if (state?.pending !== undefined) {
    await applyExplicitRollover(ctx, agent, state.pending, signal)
  } else if (budget?.kind === 'rollover' && budget.reason === 'hard-limit') {
    await applyForcedRollover(ctx, agent, signal)
  }
  const decision = await next()
  if (budget?.kind !== 'remind' && budget?.kind !== 'fallback') return decision
  if (decision.kind === 'reject') return decision
  return {
    ...decision,
    messages: [...decision.messages, contextPressureMessage(
      budget.kind === 'remind' ? 'reminder' : 'fallback',
      state?.generation ?? 0,
    )],
  }
}

/** Keep the current user turn alive long enough to apply a forced rollover. */
export function queueForcedRolloverStep(agent: Agent): void {
  agent.inject(createUserMessage({
    content: [{ type: 'text', text: 'Continue the current task from the recovery handoff.' }],
    source: { kind: 'plugin', plugin: '@obelisk/dsh-obelisk-plugin/context-window', form: 'instructions' },
  }))
}
