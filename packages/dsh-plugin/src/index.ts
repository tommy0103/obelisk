// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DeepSeek Harness provider for the plugin-owned Obelisk agent skill.
 *
 * The plugin adds no model tool and no prompt fragment of its own. DSH exposes
 * this packaged skill through its standard catalog and `skill` tool; after the
 * model loads it, Obelisk keeps the same Bash-based invocation contract used by
 * every other supported agent harness.
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'
import { parse as parseYaml } from 'yaml'

/** Cordis plugin name used by Loader diagnostics. */
export const name = '@obelisk/dsh-obelisk-plugin'

/** The standard DSH skill registry is the plugin's only dependency. */
export const inject = ['skills']

const PACKAGED_SKILL_ROOT = new URL('./skill/', import.meta.url)
const SOURCE_SKILL_ROOT = new URL('../skill/', import.meta.url)

interface ParsedSkill {
  readonly name: string
  readonly description: string
  readonly content: string
}

function skillRoot(): URL {
  for (const candidate of [PACKAGED_SKILL_ROOT, SOURCE_SKILL_ROOT]) {
    if (existsSync(fileURLToPath(new URL('SKILL.md', candidate)))) return candidate
  }
  const expected = [PACKAGED_SKILL_ROOT, SOURCE_SKILL_ROOT]
    .map(candidate => fileURLToPath(new URL('SKILL.md', candidate)))
    .join(' or ')
  throw new Error(`Obelisk DSH plugin skill bundle is missing; expected SKILL.md at ${expected}`)
}

function parseSkill(raw: string): ParsedSkill {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0 || raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') {
    throw new Error('bundled Obelisk skill is missing YAML frontmatter')
  }
  let lineStart = firstLineEnd + 1
  let closingStart = -1
  let bodyStart = -1
  while (lineStart <= raw.length) {
    const newline = raw.indexOf('\n', lineStart)
    const lineEnd = newline < 0 ? raw.length : newline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      closingStart = lineStart
      bodyStart = newline < 0 ? raw.length : newline + 1
      break
    }
    if (newline < 0) break
    lineStart = newline + 1
  }
  if (closingStart < 0 || bodyStart < 0) {
    throw new Error('bundled Obelisk skill has unterminated YAML frontmatter')
  }
  const data = parseYaml(raw.slice(firstLineEnd + 1, closingStart)) as unknown
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('bundled Obelisk skill frontmatter must be an object')
  }
  const skillName = Reflect.get(data, 'name')
  const description = Reflect.get(data, 'description')
  if (skillName !== 'obelisk' || typeof description !== 'string' || description.trim() === '') {
    throw new Error('bundled Obelisk skill frontmatter must define the obelisk name and description')
  }
  return { name: skillName, description, content: raw.slice(bodyStart).trim() }
}

/**
 * Register the plugin-owned skill as a runtime contribution. DSH's standard
 * precedence keeps project skills above it and user-global skills below it.
 */
export function apply(ctx: Context): void {
  const root = skillRoot()
  const bodyUrl = new URL('SKILL.md', root)
  const resourceBase = { kind: 'directory', path: fileURLToPath(root) } as const
  const skill = parseSkill(readFileSync(bodyUrl, 'utf8'))
  const registration: SkillRegistration = {
    name: skill.name,
    description: skill.description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: name,
    source: 'runtime',
    resourceBase,
    content: skill.content,
  }
  ctx.skills.register(registration)
}
