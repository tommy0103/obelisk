// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
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
  generation: z.number().int().nonnegative(),
  calls: z.record(z.string(), candidateSchema),
  rootCalls: z.record(z.string(), z.object({
    turn: z.number().int().nonnegative(),
    step: z.number().int().positive(),
  }).strict()),
  ptcCalls: z.record(z.string(), candidateSchema),
  ptcSettled: z.record(z.string(), candidateSchema),
  pending: candidateSchema.optional(),
  reminderClaimed: z.boolean(),
  fallbackClaimed: z.boolean(),
}).strict()

export type ContextWindowState = z.infer<typeof stateSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    obeliskContextWindow: ContextWindowState
  }
}

function handoffFrom(raw: string): string | undefined {
  try {
    return handoffFromValue(JSON.parse(raw))
  } catch {
    return undefined
  }
}

function handoffFromValue(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const handoff = Reflect.get(value, 'handoff')
  return typeof handoff === 'string' && handoff.trim() !== '' ? handoff : undefined
}

function resultFailed(event: SessionEvent<'tool/result'>): boolean {
  return event.data.message.content.some(block => block.isError === true)
}

/** Fold existing native tool facts and committed handoff sources into rollover state. */
export const contextWindowProjectionDefinition = {
  key: 'obeliskContextWindow',
  stateVersion: 2,
  stateSchema,
  init: (): ContextWindowState => ({
    generation: 0,
    calls: {},
    rootCalls: {},
    ptcCalls: {},
    ptcSettled: {},
    reminderClaimed: false,
    fallbackClaimed: false,
  }),
  apply: (state, event): ContextWindowState => {
    if (event.type === 'tool/call') {
      const rootCalls = {
        ...state.rootCalls,
        [event.data.callId]: { turn: event.data.turn, step: event.data.step },
      }
      if (event.data.name !== 'new_context') return { ...state, rootCalls }
      const handoff = handoffFrom(event.data.arguments)
      if (handoff === undefined) return { ...state, rootCalls }
      return {
        ...state,
        rootCalls,
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
    if (event.type === 'tool/code-dispatch-start' && event.data.name === 'new_context') {
      const handoff = handoffFromValue(event.data.arguments)
      const position = state.rootCalls[event.data.rootCallId]
      if (handoff === undefined || position === undefined) return state
      return {
        ...state,
        ptcCalls: {
          ...state.ptcCalls,
          [event.data.subCallId]: {
            rootCallId: event.data.rootCallId,
            handoff,
            turn: position.turn,
            step: position.step,
          },
        },
      }
    }
    if (event.type === 'tool/code-dispatch' && event.data.name === 'new_context') {
      const candidate = state.ptcCalls[event.data.subCallId]
      if (candidate === undefined) return state
      const ptcCalls = { ...state.ptcCalls }
      delete ptcCalls[event.data.subCallId]
      return event.data.isError
        ? { ...state, ptcCalls }
        : {
            ...state,
            ptcCalls,
            ptcSettled: { ...state.ptcSettled, [event.data.rootCallId]: candidate },
          }
    }
    if (event.type === 'tool/result') {
      const callId = event.data.message.source.callId
      const candidate = state.calls[callId]
      const ptcCandidate = state.ptcSettled[callId]
      const calls = { ...state.calls }
      delete calls[callId]
      const rootCalls = { ...state.rootCalls }
      delete rootCalls[callId]
      const ptcSettled = { ...state.ptcSettled }
      delete ptcSettled[callId]
      const accepted = candidate ?? ptcCandidate
      return accepted === undefined || resultFailed(event)
        ? { ...state, calls, rootCalls, ptcSettled }
        : { ...state, calls, rootCalls, ptcSettled, pending: accepted }
    }
    if (event.type === 'user/message' && event.data.source.kind === 'obelisk-context-pressure') {
      return event.data.source.phase === 'reminder'
        ? { ...state, reminderClaimed: true }
        : { ...state, fallbackClaimed: true }
    }
    if (event.type === 'user/message'
      && event.data.source.kind === 'obelisk-context-handoff') {
      const rootCallId = event.data.source.trigger.kind === 'model'
        ? event.data.source.trigger.rootCallId
        : undefined
      const calls = { ...state.calls }
      if (rootCallId !== undefined) delete calls[rootCallId]
      return {
        generation: state.generation + 1,
        calls,
        rootCalls: {},
        ptcCalls: {},
        ptcSettled: {},
        reminderClaimed: false,
        fallbackClaimed: false,
      }
    }
    return state
  },
} satisfies ProjectionDefinition<'obeliskContextWindow', ContextWindowState>
