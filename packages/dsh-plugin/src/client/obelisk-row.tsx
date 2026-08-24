// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Client-side card for first-party obelisk_query tool calls (ADR-0009).
// This file exists only in the browser plugin half: it changes how the HUMAN
// sees the call, never what the model receives or what the session records.

import { useState, type KeyboardEvent } from 'react'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { deriveObeliskRow } from './row-model.ts'
import css from './obelisk-row.module.css'

/** Compact tapered-monolith mark; the card's only fixed brand color. */
function Glyph() {
  return (
    <svg
      width="12"
      height="14"
      viewBox="0 0 12 14"
      aria-hidden="true"
      focusable="false"
      className={css.glyph}
    >
      <path d="M6 1 1.7 12h8.6L6 1Z" fill="currentColor" fillOpacity="0.92" />
      <path d="M1.7 12h8.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      aria-hidden="true"
      focusable="false"
      className={open ? css.chevronOpen : css.chevron}
    >
      <path d="m3.5 5.25 3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * Obelisk tool card: glyph + "Obelisk" + bounded query summary on the shared
 * row geometry; expanding reveals the QUERY and RESULT sections. The durable
 * record and the model-facing tool surface are untouched by this file.
 */
export function ObeliskRow({ block, inspect }: ToolCallViewProps) {
  const model = deriveObeliskRow(block)
  const [expanded, setExpanded] = useState(false)
  const expandable = model.query !== null || model.output !== null
  const open = expanded && expandable
  const toggle = () => {
    if (expandable) setExpanded(value => !value)
  }
  const toggleFromKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!expandable || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    toggle()
  }
  return (
    <div className={css.card}>
      <div
        className={css.root}
        data-sample="obelisk"
        data-variant="obelisk"
        data-state={model.state}
        data-expandable={expandable || undefined}
        role={expandable ? 'button' : undefined}
        tabIndex={expandable ? 0 : undefined}
        aria-expanded={expandable ? open : undefined}
        onClick={expandable ? toggle : undefined}
        onKeyDown={expandable ? toggleFromKeyboard : undefined}
      >
        <span className={css.leading}><Glyph /></span>
        <span className={css.title}>Obelisk</span>
        <span className={css.sep} aria-hidden />
        <span className={css.summary} data-error={model.state === 'error' || undefined}>
          {model.summary}
        </span>
        {model.state !== 'ok' && (
          <span className={css.dot} data-state={model.state} aria-hidden />
        )}
        {expandable && <Chevron open={open} />}
      </div>
      {open && (
        <div className={css.bodyWrap}>
          {model.query !== null && (
            <div className={css.ioCard}>
              <div className={css.ioSection}>
                <span className={css.ioLabel}>QUERY</span>
                <pre className={css.ioText}>{model.query}</pre>
              </div>
            </div>
          )}
          {model.output !== null && (
            <div className={css.ioCard}>
              <div className={css.ioSection}>
                <span className={css.ioLabel}>RESULT</span>
                <pre className={css.ioText} data-error={model.state === 'error' || undefined}>
                  {model.output}
                </pre>
              </div>
            </div>
          )}
          {inspect !== undefined && (
            <button type="button" className={css.inspectButton} onClick={inspect}>
              Inspect
            </button>
          )}
        </div>
      )}
    </div>
  )
}
