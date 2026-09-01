// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

/** Stable model guidance for prose handoff and scoped Obelisk recovery. */
export const CONTEXT_WINDOW_GUIDANCE = [
  'Before context pressure becomes critical, call `new_context` with a concise prose handoff.',
  'Cover the current goal, decisions and rationale, completed and in-progress work, learnings, concrete next steps, every unresolved user request, and important actions or tool results.',
  'Do not copy the transcript: older evidence remains available through Obelisk.',
  'After rollover, use the supplied `session_id` as the default Obelisk search scope and pass the supplied `message_uuid` to `context(uuid)` when you need to expand from the previous context boundary.',
].join(' ')

/** Render the only model-visible message retained across an explicit rollover. */
export function renderContextHandoff(sessionId: string, messageUuid: string, handoff: string): string {
  return [
    'Previous context is available in Obelisk.',
    `session_id: ${sessionId}`,
    `message_uuid: ${messageUuid}`,
    '',
    '<handoff>',
    handoff,
    '</handoff>',
  ].join('\n')
}
