// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  canonicalDeepseekMemberAssistantMessageUuid,
  canonicalDeepseekTreeSessionId,
  deepseekProjectScope,
} from './deepseek-identity.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'

export interface ContextRecoveryAnchors {
  sessionId: string
  messageUuid: string
}

async function rootNativeSessionId(
  ctx: Context,
  session: Session,
  signal?: AbortSignal,
): Promise<string> {
  const scope = deepseekProjectScope(session.header.cwd)
  const seen = new Set<string>([session.id])
  let header: SessionHeader = session.header
  let persisted: Map<string, SessionHeader> | undefined
  while (header.parentSession !== undefined) {
    signal?.throwIfAborted()
    const parentId = header.parentSession
    if (seen.has(parentId)) throw new Error('context-window: cyclic DSH parentSession lineage')
    seen.add(parentId)
    const live = ctx.sessions.get(parentId)
    if (live !== undefined) {
      header = live.header
    } else {
      const persistence = ctx.get('sessionPersistence')
      if (persistence === undefined) {
        throw new Error('context-window: persisted parent lineage requires sessionPersistence')
      }
      persisted ??= new Map((await persistence.list(signal)).map(candidate => [
        `${deepseekProjectScope(candidate.cwd)}\0${candidate.id}`,
        candidate,
      ]))
      const stored = persisted.get(`${scope}\0${parentId}`)
      if (stored === undefined) {
        throw new Error(`context-window: parent session ${JSON.stringify(parentId)} is unavailable`)
      }
      header = stored
    }
    if (deepseekProjectScope(header.cwd) !== scope) {
      throw new Error('context-window: DSH parentSession lineage crosses project scopes')
    }
  }
  return header.id
}

/** Resolve the canonical Obelisk root-tree session id for one live DSH member. */
export async function recoverySessionId(
  ctx: Context,
  session: Session,
  signal?: AbortSignal,
): Promise<string> {
  const scope = deepseekProjectScope(session.header.cwd)
  return canonicalDeepseekTreeSessionId(await rootNativeSessionId(ctx, session, signal), scope)
}

/** Derive root-tree and member-message recovery anchors without waiting for an Obelisk refresh. */
export async function recoveryAnchors(
  ctx: Context,
  session: Session,
  turn: number,
  step: number,
  kind: 'reasoning' | 'text' | 'tool_use' = 'tool_use',
  signal?: AbortSignal,
): Promise<ContextRecoveryAnchors> {
  const scope = deepseekProjectScope(session.header.cwd)
  return {
    sessionId: await recoverySessionId(ctx, session, signal),
    messageUuid: canonicalDeepseekMemberAssistantMessageUuid(
      session.id,
      scope,
      turn,
      step,
      kind,
    ),
  }
}
