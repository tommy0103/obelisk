// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-tools/types'
import { z } from 'zod'

const candidateSchema = z.object({
  rootCallId: z.string(),
  handoff: z.string(),
  turn: z.number().int().nonnegative(),
  step: z.number().int().positive(),
}).strict()

export type PendingRollover = z.infer<typeof candidateSchema>

const stateSchema = z.object({
  calls: z.record(z.string(), candidateSchema),
  pending: candidateSchema.optional(),
  appliedRootCallIds: z.array(z.string()),
}).strict()

export type ContextWindowState = z.infer<typeof stateSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    obeliskContextWindow: ContextWindowState
  }
}

function handoffFrom(raw: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const handoff = Reflect.get(parsed, 'handoff')
    return typeof handoff === 'string' && handoff.trim() !== '' ? handoff : undefined
  } catch {
    return undefined
  }
}

/** Fold existing native tool facts and committed handoff sources into rollover state. */
export const contextWindowProjectionDefinition = {
  key: 'obeliskContextWindow',
  stateVersion: 1,
  stateSchema,
  init: (): ContextWindowState => ({ calls: {}, appliedRootCallIds: [] }),
  apply: (state, event): ContextWindowState => {
    if (event.type === 'tool/call' && event.data.name === 'new_context') {
      const handoff = handoffFrom(event.data.arguments)
      if (handoff === undefined) return state
      return {
        ...state,
        calls: {
          ...state.calls,
          [event.data.callId]: {
            rootCallId: event.data.callId,
            handoff,
            turn: event.data.turn,
            step: event.data.step,
          },
        },
      }
    }
    if (event.type === 'tool/result') {
      const callId = event.data.message.source.callId
      const candidate = state.calls[callId]
      if (candidate === undefined) return state
      const failed = event.data.message.content.some(block => block.isError === true)
      const calls = { ...state.calls }
      delete calls[callId]
      return failed ? { ...state, calls } : { ...state, calls, pending: candidate }
    }
    if (event.type === 'user/message'
      && event.data.source.kind === 'obelisk-context-handoff') {
      const rootCallId = event.data.source.rootCallId
      const calls = { ...state.calls }
      delete calls[rootCallId]
      return {
        calls,
        appliedRootCallIds: [...state.appliedRootCallIds, rootCallId],
      }
    }
    return state
  },
} satisfies ProjectionDefinition<'obeliskContextWindow', ContextWindowState>
