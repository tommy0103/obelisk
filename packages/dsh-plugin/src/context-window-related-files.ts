// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { isAbsolute, posix, win32 } from 'node:path'
import { z } from 'zod'

export const RELATED_FILE_ROLES = [
  'spec',
  'decision',
  'implementation',
  'test',
  'handoff',
  'other',
] as const

export const relatedFileSchema = z.object({
  path: z.string(),
  reason: z.string(),
  role: z.enum(RELATED_FILE_ROLES),
}).strict()

export type RelatedFile = z.infer<typeof relatedFileSchema>

/** Reject ambiguous or workspace-escaping references before rollover commits them. */
export function validateRelatedFiles(files: readonly RelatedFile[] | undefined): void {
  const seen = new Set<string>()
  for (const file of files ?? []) {
    if (file.path === '' || file.path !== file.path.trim()) {
      throw new TypeError('new_context related_files path must be a non-empty trimmed string')
    }
    if ([...file.path].some(character => character.charCodeAt(0) <= 0x1F)) {
      throw new TypeError('new_context related_files path must not contain control characters')
    }
    const portable = file.path.replaceAll('\\', '/')
    const normalized = posix.normalize(portable)
    if (isAbsolute(file.path) || win32.isAbsolute(file.path)
      || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
      throw new TypeError('new_context related_files path must stay within the workspace')
    }
    if (normalized !== portable) {
      throw new TypeError('new_context related_files path must be normalized')
    }
    if (file.reason.trim() === '') {
      throw new TypeError('new_context related_files reason must be non-empty')
    }
    if (seen.has(normalized)) {
      throw new TypeError(`new_context related_files contains duplicate path ${JSON.stringify(normalized)}`)
    }
    seen.add(normalized)
  }
}
