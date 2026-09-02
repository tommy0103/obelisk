// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { posix, win32 } from 'node:path'
import { z } from 'zod'

export const RELATED_FILE_ROLES = [
  'spec',
  'decision',
  'implementation',
  'test',
  'handoff',
  'other',
] as const

const relatedFilePathSchema = z.string().superRefine((path, context) => {
  if (path === '' || path !== path.trim()) {
    context.addIssue({
      code: 'custom',
      message: 'new_context related_files path must be a non-empty trimmed string',
    })
    return
  }
  if ([...path].some(character => character.charCodeAt(0) <= 0x1F)) {
    context.addIssue({
      code: 'custom',
      message: 'new_context related_files path must not contain control characters',
    })
    return
  }
  const portable = path.replaceAll('\\', '/')
  const normalized = posix.normalize(portable)
  if (posix.isAbsolute(portable) || win32.parse(path).root !== ''
    || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    context.addIssue({
      code: 'custom',
      message: 'new_context related_files path must stay within the workspace',
    })
    return
  }
  if (normalized !== portable) {
    context.addIssue({
      code: 'custom',
      message: 'new_context related_files path must be normalized',
    })
  }
})

export const relatedFileSchema = z.object({
  path: relatedFilePathSchema,
  reason: z.string().refine(reason => reason.trim() !== '', {
    message: 'new_context related_files reason must be non-empty',
  }),
  role: z.enum(RELATED_FILE_ROLES),
}).strict()

export type RelatedFile = z.infer<typeof relatedFileSchema>

/** Reject ambiguous or workspace-escaping references before rollover commits them. */
export function validateRelatedFiles(files: unknown): asserts files is readonly RelatedFile[] | undefined {
  const result = z.array(relatedFileSchema).optional().safeParse(files)
  if (result.success) return
  throw new TypeError(result.error.issues[0]?.message ?? 'new_context related_files are invalid')
}
