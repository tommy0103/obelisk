// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { CONTEXT_WINDOW_GUIDANCE } from './context-window-prompt.ts'
import { handlePreStep } from './context-window-rollover.ts'
import { contextWindowProjectionDefinition } from './context-window-state.ts'

export const name = '@obelisk/dsh-obelisk-plugin/context-window'
export const inject = ['tools', 'systemPrompt', 'sessions', 'sessionProjections']

const output = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

/** Register the opt-in prose handoff and safe-boundary rollover path. */
export function apply(ctx: Context): void {
  ctx.sessionProjections.register(contextWindowProjectionDefinition)
  ctx.systemPrompt.section({
    name: 'obelisk:context-window',
    order: 700,
    text: CONTEXT_WINDOW_GUIDANCE,
  })
  ctx.tools.register(defineTool({
    name: 'new_context',
    description: 'Start a fresh context after preserving a prose handoff for continuing the current task.',
    parameters: {
      handoff: {
        type: 'string',
        required: true,
        description: 'Concise prose covering goal, decisions, progress, learnings, next steps, unresolved requests, and important actions.',
      },
    },
    output,
    async execute(args) {
      if (typeof args.handoff !== 'string' || args.handoff.trim() === '') {
        throw new TypeError('new_context handoff must be a non-empty prose string')
      }
      return 'A fresh context will start after this sampling step.'
    },
  }))
  ctx.on('agent/pre-step', ({ agent }, next) => handlePreStep(ctx, agent, next), { prepend: true })
}
