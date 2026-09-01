// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

/** Stable model guidance for prose handoff and scoped Obelisk recovery. */
export const CONTEXT_WINDOW_GUIDANCE = [
  'Before context pressure becomes critical, call `new_context` with a concise prose handoff.',
  'Cover the current goal, decisions and rationale, completed and in-progress work, learnings, concrete next steps, every unresolved user request, and important actions or tool results.',
  'Do not copy the transcript: older evidence remains available through Obelisk.',
  'After rollover, use the supplied `session_id` as the default Obelisk search scope and pass the supplied `message_uuid` to `context(uuid)` when you need to expand from the previous context boundary.',
].join(' ')

export const CONTEXT_WINDOW_REMINDER = [
  'The active context is approaching its normal task budget.',
  'Prepare a concise prose handoff and call `new_context` soon.',
  'Cover the current goal, decisions and rationale, completed and in-progress work, learnings, concrete next steps, every unresolved user request, and important actions or tool results.',
].join(' ')

export const CONTEXT_WINDOW_FALLBACK = [
  'The normal task budget is exhausted. Stop ordinary task execution and do not give a final answer.',
  'Use this reserved step only to prepare a concise prose handoff covering the current goal, decisions and rationale, completed and in-progress work, learnings, concrete next steps, every unresolved user request, and important actions or tool results.',
  'Then call `new_context` exactly once. Do not call any other tool, and make `new_context` the final operation in a PTC program.',
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

/** Render a host-authored recovery message when the model did not produce a handoff. */
export function renderMissingContextHandoff(sessionId: string, messageUuid: string): string {
  return [
    'No prose handoff was produced before the hard context limit.',
    'Recover the current task from this Obelisk session and message anchor.',
    '',
    `session_id: ${sessionId}`,
    `message_uuid: ${messageUuid}`,
  ].join('\n')
}
