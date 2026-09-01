// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto'
import { isAbsolute, normalize } from 'node:path'

export type DeepseekAssistantMessageKind = 'reasoning' | 'text' | 'tool_use'

function normalizeObservedCwd(cwd: unknown): string | null {
  if (typeof cwd !== 'string' || !cwd.trim() || !isAbsolute(cwd)) return null
  return normalize(cwd)
}

/** Keep DSH recovery anchors identical to the canonical Obelisk provider identity. */
export function deepseekProjectScope(cwd: unknown): string {
  const normalized = normalizeObservedCwd(cwd) ?? (typeof cwd === 'string' ? cwd : '')
  return createHash('sha256').update('deepseek-cwd-v1\0').update(normalized).digest('hex')
}

/** Return the canonical Obelisk session/member id inside one DeepSeek project scope. */
export function canonicalDeepseekTreeSessionId(nativeSessionId: string, scope: string): string {
  return `deepseek:${encodeURIComponent(nativeSessionId)}:${scope}`
}

/** Return one assistant uuid from an already-canonical DeepSeek member id. */
export function canonicalDeepseekAssistantMessageUuid(
  memberId: string,
  turn: unknown,
  step: unknown,
  kind: DeepseekAssistantMessageKind,
): string {
  return `${memberId}:t${turn}:s${step}:${kind}`
}

/** Return the canonical Obelisk assistant uuid for one DeepSeek tree member. */
export function canonicalDeepseekMemberAssistantMessageUuid(
  memberNativeSessionId: string,
  scope: string,
  turn: unknown,
  step: unknown,
  kind: DeepseekAssistantMessageKind,
): string {
  return canonicalDeepseekAssistantMessageUuid(
    canonicalDeepseekTreeSessionId(memberNativeSessionId, scope),
    turn,
    step,
    kind,
  )
}
