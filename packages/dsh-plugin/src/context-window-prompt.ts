// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import type { RelatedFile } from './context-window-related-files.ts'

const CONTEXT_WINDOW_EVIDENCE_STATUS = [
  'Use handoff sections `SPEC-CONFIRMED REQUIREMENTS` (goal, progress, next steps; cite user, spec, or source), `AGENT INFERENCES` (never `LOCKED DESIGN` or confirmed by repetition), `UNRESOLVED CONFLICTS`, and `UNVERIFIED ACCEPTANCE CRITERIA`.',
].join(' ')

export const CONTEXT_WINDOW_OBELISK_SCOPE = 'Scope Obelisk recovery to the supplied `session_id` and use `context(message_uuid)` at the previous-window boundary; do not search global history or other sessions.'

/** Stable model guidance for prose handoff and scoped Obelisk recovery. */
export const CONTEXT_WINDOW_GUIDANCE = [
  'Before context pressure becomes critical, call `new_context` with a concise prose handoff.',
  'Cover the current goal, decisions and rationale, completed and in-progress work, learnings, concrete next steps, every unresolved user request, and important actions or tool results.',
  CONTEXT_WINDOW_EVIDENCE_STATUS,
  'Do not copy the transcript: older evidence remains available through Obelisk.',
  `After rollover: ${CONTEXT_WINDOW_OBELISK_SCOPE}`,
].join(' ')

export const CONTEXT_WINDOW_REMINDER = [
  'The active context is approaching its normal task budget.',
  'Prepare a concise prose handoff and call `new_context` soon.',
  'Cover the current goal, decisions and rationale, completed and in-progress work, learnings, concrete next steps, every unresolved user request, and important actions or tool results.',
  CONTEXT_WINDOW_EVIDENCE_STATUS,
].join(' ')

export const CONTEXT_WINDOW_FALLBACK = [
  'The normal task budget is exhausted. Stop ordinary task execution and do not give a final answer.',
  'Use this reserved step only to prepare a concise prose handoff covering the current goal, decisions and rationale, completed and in-progress work, learnings, concrete next steps, every unresolved user request, and important actions or tool results.',
  CONTEXT_WINDOW_EVIDENCE_STATUS,
  'Then call `new_context` exactly once. Do not call any other tool, and make `new_context` the final operation in a PTC program.',
].join(' ')

const CONTEXT_WINDOW_RECOVERY = [
  'Treat this handoff as a checkpoint, not an exhaustive history.',
  'If a required detail is missing, uncertain, or based on an earlier decision, load the `obelisk` skill before re-deriving it.',
  CONTEXT_WINDOW_OBELISK_SCOPE,
  'Treat unsectioned or `LOCKED DESIGN` claims as `AGENT INFERENCES` until this session supplies direct user, spec, or source evidence; preserve conflicts and unverified criteria.',
].join(' ')

/** Render the only model-visible message retained across an explicit rollover. */
export function renderContextHandoff(
  sessionId: string,
  messageUuid: string,
  handoff: string,
  relatedFiles: readonly RelatedFile[] = [],
): string {
  return [
    'Previous context is available in Obelisk.',
    `session_id: ${sessionId}`,
    `message_uuid: ${messageUuid}`,
    '',
    '<handoff>',
    handoff,
    '</handoff>',
    ...relatedFiles.length === 0
      ? []
      : ['', '<related_files>', JSON.stringify(relatedFiles, null, 2), '</related_files>'],
    '',
    CONTEXT_WINDOW_RECOVERY,
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
    '',
    CONTEXT_WINDOW_RECOVERY,
  ].join('\n')
}
