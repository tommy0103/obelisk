// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  canonicalDeepseekMemberAssistantMessageUuid,
  canonicalDeepseekTreeSessionId,
  deepseekProjectScope,
} from '@obelisk/core/providers/deepseek-identity'
import type { Session } from '@deepseek-ai/dsh-session'

export interface ContextRecoveryAnchors {
  sessionId: string
  messageUuid: string
}

/** Derive top-level recovery anchors without waiting for an Obelisk refresh. */
export function topLevelRecoveryAnchors(
  session: Session,
  turn: number,
  step: number,
): ContextRecoveryAnchors {
  if (session.header.parentSession !== undefined) {
    throw new Error('context-window: subagent root-tree identity resolution is not implemented')
  }
  const scope = deepseekProjectScope(session.header.cwd)
  return {
    sessionId: canonicalDeepseekTreeSessionId(session.id, scope),
    messageUuid: canonicalDeepseekMemberAssistantMessageUuid(
      session.id,
      scope,
      turn,
      step,
      'tool_use',
    ),
  }
}
