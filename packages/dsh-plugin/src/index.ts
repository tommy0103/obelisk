// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// DeepSeek Harness plugin exposing the local Obelisk archive to the model
// through one read-only query tool (see docs/adr/0009-obelisk-as-dsh-optional-
// retrieval-plugin.md). The plugin is deliberately thin: it translates the
// model's bounded JavaScript query into an `obelisk --query` invocation and
// translates the sandbox result back into text. The Obelisk skill itself is
// not re-taught here; it stays the single source of query semantics and is
// loaded through DSH's skill system (`obelisk install` + the `skill` tool).

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Cordis plugin name used by Loader diagnostics. */
export const name = '@obelisk/dsh-plugin'

/** Capability services required by the model-facing consumer. */
export const inject = ['tools', 'systemPrompt']

/** Default CLI command used to run queries. */
export const DEFAULT_CLI_PATH = 'obelisk'

/** Default cooperative deadline for one query invocation. */
export const DEFAULT_TIMEOUT_MS = 30_000

/** Default maximum characters returned to the model per invocation. */
export const DEFAULT_MAX_RESULT_CHARS = 24_000

/** Deployment-owned query bounds. */
export interface Config {
  /** Command used to run the Obelisk CLI. Defaults to `obelisk`. */
  cliPath?: string
  /** Cooperative subprocess deadline in milliseconds. Defaults to 30000. */
  timeoutMs?: number
  /** Maximum characters returned to the model per invocation. Defaults to 24000. */
  maxResultChars?: number
}

/** Schemastery config for Loader defaults and generated configuration docs. */
export const Config: z<Config> = z.object({
  cliPath: z.string().default(DEFAULT_CLI_PATH),
  timeoutMs: z.number().step(1).min(1_000).max(120_000).default(DEFAULT_TIMEOUT_MS),
  maxResultChars: z.number().step(1).min(1_000).max(1_000_000).default(DEFAULT_MAX_RESULT_CHARS),
})

interface ResolvedConfig {
  readonly cliPath: string
  readonly timeoutMs: number
  readonly maxResultChars: number
}

interface ObeliskQueryArgs {
  query: string
}

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

const PROMPT_TEXT =
  'Use obelisk_query to search past coding-agent sessions from other tools (Claude Code, Codex, Kimi Code, Pi) '
  + 'and previously saved memories in the local Obelisk archive. session_search covers this tool\'s own prior '
  + 'sessions; obelisk_query covers the cross-tool archive and the durable memory layer. Write one bounded '
  + 'JavaScript query — overview({ limit }) to orient, then search(), memories(), context(), or sql() — and '
  + 'return compact evidence with stable ids. Load the `obelisk` skill with the skill tool before writing '
  + 'your first query.'

function resolveConfig(config: Config): ResolvedConfig {
  return {
    cliPath: config.cliPath ?? DEFAULT_CLI_PATH,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxResultChars: config.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS,
  }
}

function capText(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n... [output truncated: ${text.length - max} characters omitted]`
}

function presentResult(child: ReturnType<typeof spawnSync>, resolved: ResolvedConfig): string {
  if (child.error) {
    const code = (child.error as { code?: unknown }).code
    return `Obelisk query could not run (${String(code ?? 'spawn error')}: ${child.error.message}). `
      + 'Verify the plugin cliPath resolves to the installed obelisk CLI.'
  }
  const stdout = String(child.stdout ?? '').trim()
  if (child.status !== 0 || child.signal) {
    const detail = [stdout, String(child.stderr ?? '').trim()].filter(Boolean).join('\n')
    const label = child.signal
      ? `Obelisk query was terminated (${child.signal}).`
      : `Obelisk query failed (exit ${child.status}).`
    return detail ? `${label}\n${capText(detail, resolved.maxResultChars)}` : label
  }
  if (!stdout) return 'Obelisk query returned no output.'
  try {
    const value = JSON.parse(stdout) as unknown
    return capText(JSON.stringify(value), resolved.maxResultChars)
  } catch {
    return capText(stdout, resolved.maxResultChars)
  }
}

async function executeObeliskQuery(args: ObeliskQueryArgs, resolved: ResolvedConfig): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'obelisk-dsh-'))
  const file = join(dir, 'query.mjs')
  let output: string
  try {
    writeFileSync(file, args.query, 'utf8')
    const child = spawnSync(resolved.cliPath, ['--query', file], {
      encoding: 'utf8',
      timeout: resolved.timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    })
    output = presentResult(child, resolved)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  return output
}

/** Register the query tool and its shared model guidance. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  ctx.systemPrompt.section({
    name: 'tool:obelisk-query',
    order: 114,
    text: PROMPT_TEXT,
  })

  ctx.tools.register(defineTool({
    name: 'obelisk_query',
    description:
      'Search past coding-agent sessions from other tools (Claude Code, Codex, Kimi Code, Pi) and previously '
      + 'saved memories in the local Obelisk archive. Accepts one bounded read-only JavaScript query body; the '
      + 'body runs as an async IIFE in the Obelisk sandbox (30s limit) and its `return` value is echoed as JSON. '
      + 'Available helpers: overview(opts), search(text, opts), memories(opts), sessions(opts), summaries(opts), '
      + 'context(uuid), trace(uuid), thread(sessionId, opts), raw(uuid, opts), fileHistory(path, opts), and '
      + 'sql(query, ...params) for exact joins. Memory mutation is not available here; it stays on the '
      + 'human-approved flow of the obelisk skill.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description:
          'Bounded read-only JavaScript query body. Use `return` to emit compact JSON evidence with stable '
          + 'ids. Prefer helpers over raw SQL; start with overview({ limit }) unless the target is already known.',
      },
    },
    output: TEXT_OUTPUT,
    timeoutMs: resolved.timeoutMs,
    execute: (args, _exec) => executeObeliskQuery(args as ObeliskQueryArgs, resolved),
  }))
}
