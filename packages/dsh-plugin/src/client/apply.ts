// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Browser half of the obelisk plugin: register the distinct card for
// first-party `obelisk_query` tool calls. The key is the tool's own wire
// name, so no other tool's rendering is claimed or changed.

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { ObeliskRow } from './obelisk-row.tsx'

/** Cordis service the registration needs (provided by the conversation layer). */
export const inject = ['slots']

/** Register the obelisk card into the tool-owned keyed view slot. */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register({ name: 'tool.call.toolview', key: 'obelisk_query' }, ObeliskRow))
}
