// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'

import { topLevelRecoveryAnchors } from './context-window-identity.ts'
import { renderContextHandoff } from './context-window-prompt.ts'
import type { PendingRollover } from './context-window-state.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'obelisk-context-handoff': {
      kind: 'obelisk-context-handoff'
      rootCallId: string
      sessionId: string
      previousContextMessageUuid: string
    }
  }
}

/** Replace the complete active surface with one durable prose handoff. */
export async function applyExplicitRollover(
  ctx: Context,
  agent: Agent,
  pending: PendingRollover,
): Promise<void> {
  const { session } = agent
  const nodes = session.surface.nodes
  if (nodes.length === 0) throw new Error('context-window: cannot replace an empty active surface')
  const anchors = topLevelRecoveryAnchors(session, pending.turn, pending.step)
  const message = createUserMessage({
    content: [{
      type: 'text',
      text: renderContextHandoff(anchors.sessionId, anchors.messageUuid, pending.handoff),
    }],
    source: {
      kind: 'obelisk-context-handoff',
      rootCallId: pending.rootCallId,
      sessionId: anchors.sessionId,
      previousContextMessageUuid: anchors.messageUuid,
    },
  })
  session.append('user/message', message, {
    surfaceOp: { op: 'replace', start: nodes[0]!, end: nodes.at(-1)! },
    sourceEventSeqs: [...nodes],
  })
  await ctx.sessions.flush(session)
}

/** Consume one pending explicit rollover before delegating the proposed step. */
export async function handlePreStep(
  ctx: Context,
  agent: Agent,
  next: () => Promise<PreStepDecision>,
): Promise<PreStepDecision> {
  const state = ctx.sessionProjections.stateOf(agent.session, 'obeliskContextWindow')
  if (state?.pending !== undefined
    && !state.appliedRootCallIds.includes(state.pending.rootCallId)) {
    await applyExplicitRollover(ctx, agent, state.pending)
  }
  return next()
}
