// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Pure derivation for the client-side obelisk_query tool card. Presentation
// only: it reads the same frozen call slice the generic tool row reads and
// never touches the model-facing surface or the durable session record. The
// card is what the HUMAN sees; the model sees the plain tool call exactly as
// before, and the session history stays an ordinary obelisk_query event.

import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'

export type ObeliskRowState = 'running' | 'ok' | 'error'

export interface ObeliskRowModel {
  readonly state: ObeliskRowState
  /** Collapsed summary: the query's first meaningful line, bounded. */
  readonly summary: string
  /** Full query text when the call's arguments were readable. */
  readonly query: string | null
  /** Joined text output of the settled result, null while running. */
  readonly output: string | null
  /** Settled error label, null unless the result reported an error. */
  readonly errorLabel: string | null
}

/** Default collapsed-summary bound in characters. */
export const OBELISK_SUMMARY_MAX = 96

function parseQueryArg(argsRaw: string | null | undefined): string | null {
  if (!argsRaw) return null
  try {
    const value = JSON.parse(argsRaw) as { query?: unknown }
    return typeof value.query === 'string' ? value.query : null
  } catch {
    return null
  }
}

/** First meaningful trimmed line of the query, bounded; 'query' when unknown. */
export function summarizeQuery(query: string | null, max: number = OBELISK_SUMMARY_MAX): string {
  if (query === null) return 'query'
  const first = query.split('\n').map(line => line.trim()).find(Boolean) ?? ''
  if (!first) return 'query'
  return first.length <= max ? first : `${first.slice(0, max - 1)}…`
}

function textOf(part: { type?: unknown; text?: unknown }): string | null {
  return part.type === 'text' && typeof part.text === 'string' ? part.text : null
}

/** One frozen call slice → the card's presentation model. */
export function deriveObeliskRow(block: ToolCallBlock): ObeliskRowModel {
  // Running form carries no `kind`; the settled form is a tool-result node.
  if (!('kind' in block)) {
    const query = parseQueryArg(block.argsRaw)
    return { state: 'running', summary: summarizeQuery(query), query, output: null, errorLabel: null }
  }
  const query = parseQueryArg(block.call?.argsRaw)
  const output = block.content
    .map(part => textOf(part as { type?: unknown; text?: unknown }))
    .filter((text): text is string => text !== null)
    .join('\n') || null
  const errorLabel = block.isError ? (block.error?.name ?? 'query failed') : null
  return {
    state: block.isError ? 'error' : 'ok',
    summary: errorLabel ?? summarizeQuery(query),
    query,
    output,
    errorLabel,
  }
}
