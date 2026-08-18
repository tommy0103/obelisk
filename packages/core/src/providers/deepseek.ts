// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only
// DeepSeek Harness provider adapter in Core (see docs/adr/0001).
//
// Pure: discovers DeepSeek Harness session artifacts and parses one into a
// canonical record stream. It never touches the Obelisk database.
//
// DeepSeek Harness persists one append-only JSONL per session under
// `$DSH_HOME/sessions` (default `~/.dsh/sessions`), grouped by a human-
// readable project directory:
//
//   <root>/--<project-slug>--/<encoded-session-id>/session.jsonl.zstd
//                                                 (or session.jsonl)
//
// The first JSONL line is a `session` header; subsequent lines are events
// `{type, seq, time, data}` with contiguous seq, or packed chunk rows
// (`text-chunks`/`reasoning-chunks`/`tool-call-chunks`) that expand to
// `assistant/chunk` events. Unlike Codex, the log is single-carrier and
// append-only, so the adapter is line-incremental like claude: it skips
// already-indexed lines and yields only new records (countMode 'delta'),
// falling back to a full reparse ('total') on the first index or when a
// crash repair truncated the artifact below the indexed line count.
// Subagent child sessions are their own artifacts whose header carries
// `origin: 'subagent'` and `parentSession`; they project into the parent
// session as sidechain messages plus a subagent row.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, relative } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

import {
  isDir, normalizeObservedCwd, projectSlugFromPath, sourceInventoryIssue, trunc, truncJson,
} from '../parsing.ts';
import { decodeZstdArtifact, scanZstdFrames } from '../zstd.ts';
import type {
  Cursor, DiscoverContext, IndexUnit, ProviderAdapter, RawLookup, RawRecord,
  TranscriptRecord,
} from './types.ts';

export const name = 'deepseek';

const DEEPSEEK_CANONICAL_TRANSCRIPT_MARKER = '__deepseek_canonical_transcript_v1__';
const SESSION_FILE_SUFFIXES = ['.jsonl.zstd', '.jsonl'] as const;
/** DeepSeek Harness tool names whose arguments name a local file. */
const FILE_TOOLS = new Set(['read', 'edit', 'write']);

/** Header line of a DeepSeek Harness session artifact. */
interface DeepseekHeaderLine {
  type: 'session'
  version: number
  id: string
  createdAt: number
  cwd?: string
  parentSession?: string
  origin?: 'subagent'
  delegationDepth: number
  agentPreset?: string
}

/** Resolve the DeepSeek Harness sessions root: `$DSH_HOME/sessions` or `~/.dsh/sessions`. */
function deepseekSessionsRoot(): string {
  const env = process.env.DSH_HOME;
  const home = env !== undefined && env.trim().length > 0 ? env : join(homedir(), '.dsh');
  return join(home, 'sessions');
}

/** Parse the artifact's header line; `undefined` when it is not a well-formed session header. */
function parseHeaderLine(line: string): DeepseekHeaderLine | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { return undefined; }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const h = parsed as Record<string, unknown>;
  if (h.type !== 'session' || typeof h.id !== 'string' || typeof h.version !== 'number'
    || typeof h.createdAt !== 'number' || typeof h.delegationDepth !== 'number') return undefined;
  return {
    type: 'session',
    version: h.version,
    id: h.id,
    createdAt: h.createdAt,
    ...typeof h.cwd === 'string' ? { cwd: h.cwd } : {},
    ...typeof h.parentSession === 'string' ? { parentSession: h.parentSession } : {},
    ...(h.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
    delegationDepth: h.delegationDepth,
    ...typeof h.agentPreset === 'string' ? { agentPreset: h.agentPreset } : {},
  };
}

/** Read just the first JSONL line (the header) without decoding the whole artifact. */
function readFirstLine(path: string): string | undefined {
  const buffer = readFileSync(path);
  if (path.endsWith('.zstd')) {
    const { frames } = scanZstdFrames(buffer, 1);
    if (frames.length === 0) return undefined;
    const frame = frames[0]!;
    let plaintext: Buffer;
    try { plaintext = zstdDecompressSync(buffer.subarray(frame.start, frame.end)); } catch { return undefined; }
    const nl = plaintext.indexOf(0x0a);
    if (nl === -1) return undefined;
    return plaintext.subarray(0, nl).toString('utf8');
  }
  const nl = buffer.indexOf(0x0a);
  return nl === -1 ? undefined : buffer.subarray(0, nl).toString('utf8');
}

/** Decode one artifact to its JSONL text (zstd frames or plaintext). */
function artifactText(path: string, buffer: Buffer): string {
  return path.endsWith('.zstd') ? decodeZstdArtifact(buffer).text : buffer.toString('utf8');
}

/** Concatenate every `text`-typed block's payload. */
function textFromBlocks(blocks: unknown, type: 'text' | 'reasoning'): string {
  if (!Array.isArray(blocks)) return '';
  const parts: string[] = [];
  for (const block of blocks) {
    if (block && typeof block === 'object'
      && (block as { type?: unknown }).type === type
      && typeof (block as { text?: unknown }).text === 'string') {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join('\n');
}

/** Recursively concatenate `text` blocks inside a (possibly nested) content array. */
function resultText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  const parts: string[] = [];
  const walk = (list: unknown[]): void => {
    for (const block of list) {
      if (!block || typeof block !== 'object') continue;
      const b = block as { type?: unknown; text?: unknown; content?: unknown };
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      else if (Array.isArray(b.content)) walk(b.content as unknown[]);
    }
  };
  walk(blocks);
  return parts.join('\n');
}

/** Parse a tool-call `arguments` JSON string, preserving invalid JSON as text. */
function parseArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return {};
  try { return raw.length > 0 ? JSON.parse(raw) : {}; } catch { return raw; }
}

/** Whether a user-role message is injected (plugin/model context) rather than a direct human prompt. */
function userMessageIsMeta(data: unknown): 0 | 1 {
  if (typeof data !== 'object' || data === null) return 0;
  const kind = (data as { source?: { kind?: unknown } }).source?.kind;
  return kind === 'user' ? 0 : 1;
}

/** The tool-result call id, which lives on the single `tool-result` block of the result message. */
function resultCallId(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const message = (data as { message?: { content?: unknown } }).message;
  if (typeof message !== 'object' || message === null) return null;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const block = content[0] as { type?: unknown; toolCallId?: unknown } | undefined;
  if (block === null || typeof block !== 'object') return null;
  return block?.type === 'tool-result' && typeof block?.toolCallId === 'string' ? block.toolCallId : null;
}

/** The file a tool call operated on, when the tool arguments name one. */
function toolFilePath(name: string, input: unknown): string | null {
  if (!FILE_TOOLS.has(name) || typeof input !== 'object' || input === null) return null;
  const path = (input as { file_path?: unknown }).file_path;
  return typeof path === 'string' ? path : null;
}

function cursorToSkip(cursor: Cursor): number {
  if (!cursor) return 0;
  const n = Number(cursor.split(':')[1]);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Discover every session artifact needing (re)indexing under the sessions root. */
function discoverAt(rootDir: string, ctx: DiscoverContext): IndexUnit[] {
  if (!existsSync(rootDir)) {
    if ((ctx.indexedSessions?.().length ?? 0) > 0) {
      ctx.reportIncompleteInventory?.({ path: rootDir, error: 'Source folder is unavailable' });
    }
    return [];
  }
  const changedFiles = new Set<string>();
  for (const changedPath of ctx.changedPaths ?? []) {
    const absolute = isAbsolute(changedPath) ? normalize(changedPath) : normalize(join(rootDir, changedPath));
    const inside = relative(rootDir, absolute);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) continue;
    if (absolute.endsWith('.jsonl') || absolute.endsWith('.jsonl.zstd')) changedFiles.add(absolute);
  }

  const units: IndexUnit[] = [];
  let projects: string[];
  try { projects = readdirSync(rootDir); } catch (error) {
    ctx.reportIncompleteInventory?.(sourceInventoryIssue(rootDir, error));
    return units;
  }
  for (const project of projects) {
    const projectPath = join(rootDir, project);
    if (!isDir(projectPath)) continue;
    let sessions: string[];
    try { sessions = readdirSync(projectPath); } catch (error) {
      ctx.reportIncompleteInventory?.(sourceInventoryIssue(projectPath, error));
      continue;
    }
    for (const session of sessions) {
      const sessionPath = join(projectPath, session);
      if (!isDir(sessionPath)) continue;
      for (const suffix of SESSION_FILE_SUFFIXES) {
        const file = join(sessionPath, `session${suffix}`);
        if (!existsSync(file)) continue;
        const normalizedFile = normalize(file);
        if (ctx.changedPaths !== undefined && !changedFiles.has(normalizedFile)) continue;
        const cursor = ctx.lastCursor(file);
        if (ctx.changedPaths === undefined && cursor !== null
          && Number(cursor.split(':')[0]) >= statSync(file).mtimeMs) continue;
        const headerLine = readFirstLine(file);
        const header = headerLine === undefined ? undefined : parseHeaderLine(headerLine);
        if (header === undefined) continue; // malformed or half-written artifact
        const isSubagent = header.origin === 'subagent';
        const parent = header.parentSession;
        units.push({
          key: file,
          sessionId: parent ?? header.id, // sidechain: child messages join the parent session
          project: header.cwd !== undefined ? (projectSlugFromPath(header.cwd) ?? undefined) : undefined,
          isSubagent: isSubagent ? true : undefined,
          agentId: isSubagent ? header.id : undefined,
          meta: { header },
        });
        break; // one artifact per session directory
      }
    }
  }
  return units;
}

/**
 * Parse one session artifact into canonical records, resuming from `cursor`
 * (`mtime:lines`, same encoding as claude). Lines up to the cursor are
 * skipped; a truncation below the indexed line count forces a full reparse.
 * @param unit - the discovered artifact unit.
 * @param cursor - opaque resume token from a previous run.
 * @returns the record stream, then the new cursor.
 */
export function* parse(unit: IndexUnit, cursor: Cursor): Generator<TranscriptRecord, Cursor> {
  const path = unit.key;
  const mtime = statSync(path).mtimeMs;
  const skip = cursorToSkip(cursor);
  const lines = artifactText(path, readFileSync(path)).split('\n');
  // Only non-empty lines are JSONL records (split() leaves a trailing empty
  // fragment after the final newline); line numbers must match that view so a
  // resume cursor stays aligned with a re-parse.
  const recordCount = lines.reduce((n, line) => n + (line === '' ? 0 : 1), 0);
  const effectiveSkip = recordCount < skip ? 0 : skip;

  const header = parseHeaderLine(lines[0] ?? '');
  if (header === undefined) return cursor; // malformed; keep the old cursor
  const isSubagent = header.origin === 'subagent';
  const sessionId = unit.sessionId;
  const agentId = isSubagent ? header.id : null;
  const cwd = normalizeObservedCwd(header.cwd);
  const parentSession = header.parentSession ?? null;

  const records: TranscriptRecord[] = [];
  const sm = {
    title: null as string | null,
    ended_at: null as string | null,
    model: null as string | null,
    n: 0,
  };
  const callMessageUuids = new Map<string, string>();
  let descriptor: { provider?: unknown; label?: unknown } | null = null;

  const insertMessage = (
    uuid: string,
    type: string,
    role: string | null,
    text: string | null,
    contentType: string,
    timestamp: string | null,
    isMeta: 0 | 1,
    inputTokens: number | null,
    outputTokens: number | null,
  ): string => {
    records.push({
      kind: 'message', uuid, session_id: sessionId, type, parent_uuid: null,
      timestamp, role, text: trunc(text), content_type: contentType, is_meta: isMeta,
      visibility: 'visible', model: sm.model, is_sidechain: isSubagent ? 1 : 0, agent_id: agentId,
      input_tokens: inputTokens, output_tokens: outputTokens, cwd, skill: null, source: 'deepseek',
    });
    return uuid;
  };

  let lineNum = 0;
  for (const line of lines) {
    if (line === '') continue; // split() trailing fragment after the final newline
    lineNum++;
    if (lineNum === 1) continue; // header line
    if (lineNum <= effectiveSkip) continue;
    let obj: unknown;
    try { obj = JSON.parse(line); } catch { continue; }
    if (typeof obj !== 'object' || obj === null) continue;
    const event = obj as { type?: unknown; time?: unknown; data?: unknown };
    if (typeof event.type !== 'string') continue;
    const timestamp = typeof event.time === 'number'
      ? new Date(event.time).toISOString()
      : null;
    if (timestamp !== null && (sm.ended_at === null || timestamp > sm.ended_at)) sm.ended_at = timestamp;
    const data = event.data;

    switch (event.type) {
      case 'user/message': {
        const message = (data as { message?: unknown }).message ?? data;
        const content = (message as { content?: unknown }).content;
        const text = Array.isArray(content) ? textFromBlocks(content, 'text') : '';
        sm.n++;
        insertMessage(
          `deepseek:${header.id}:${lineNum}`, 'user', 'user',
          text || null, 'text', timestamp, userMessageIsMeta(data), null, null,
        );
        continue;
      }
      case 'assistant/message': {
        const message = (data as { message?: unknown }).message;
        const content = typeof message === 'object' && message !== null
          ? (message as { content?: unknown }).content
          : undefined;
        const usage = typeof data === 'object' && data !== null
          ? (data as { usage?: unknown }).usage
          : undefined;
        const inputTokens = usage !== null && typeof usage === 'object'
          ? (usage as { inputTokens?: unknown }).inputTokens ?? null
          : null;
        const outputTokens = usage !== null && typeof usage === 'object'
          ? (usage as { outputTokens?: unknown }).outputTokens ?? null
          : null;
        sm.n++;
        if (Array.isArray(content)) {
          const reasoning = textFromBlocks(content, 'reasoning');
          if (reasoning.length > 0) {
            // `:0` sorts before the text message's `:1` at the same timestamp,
            // which is the order assembleSessionDetail expects (thinking folds
            // into the assistant message that follows it).
            insertMessage(
              `deepseek:${header.id}:${lineNum}:0`, 'assistant', 'assistant',
              reasoning, 'thinking', timestamp, 0,
              typeof inputTokens === 'number' ? inputTokens : null,
              typeof outputTokens === 'number' ? outputTokens : null,
            );
          }
          const text = textFromBlocks(content, 'text');
          insertMessage(
            `deepseek:${header.id}:${lineNum}:1`, 'assistant', 'assistant',
            text || null, 'text', timestamp, 0,
            typeof inputTokens === 'number' ? inputTokens : null,
            typeof outputTokens === 'number' ? outputTokens : null,
          );
        }
        continue;
      }
      case 'tool/call': {
        const call = data as { callId?: unknown; name?: unknown; arguments?: unknown };
        if (typeof call.callId !== 'string') continue;
        const name = typeof call.name === 'string' ? call.name : 'unknown';
        const uuid = insertMessage(
          `deepseek:${header.id}:${lineNum}`, 'assistant', 'assistant',
          null, 'tool_use', timestamp, 0, null, null,
        );
        const input = parseArguments(call.arguments);
        records.push({
          kind: 'tool_call', id: call.callId, message_uuid: uuid, session_id: sessionId,
          name, presentation: name === 'skill' ? 'skill' : 'default',
          input_json: truncJson(input) as string, file_path: toolFilePath(name, input),
        });
        callMessageUuids.set(call.callId, uuid);
        continue;
      }
      case 'tool/result': {
        const callId = resultCallId(data);
        if (callId === null) continue;
        const message = (data as { message?: { content?: unknown } }).message;
        const content = typeof message === 'object' && message !== null
          ? (message as { content?: unknown }).content
          : undefined;
        const error = typeof data === 'object' && data !== null
          ? (data as { error?: unknown }).error
          : undefined;
        records.push({
          kind: 'tool_result', tool_use_id: callId,
          message_uuid: callMessageUuids.get(callId) ?? '',
          session_id: sessionId, content: trunc(resultText(content) || ''),
          file_path: null, is_error: error !== undefined ? 1 : 0,
        });
        continue;
      }
      case 'session/title': {
        const title = (data as { title?: unknown }).title;
        if (typeof title === 'string') sm.title = title;
        continue;
      }
      case 'request/header': {
        const headerData = (data as { header?: unknown }).header;
        if (typeof headerData === 'object' && headerData !== null) {
          const config = (headerData as { config?: unknown }).config;
          if (typeof config === 'object' && config !== null) {
            const model = (config as { model?: unknown }).model;
            if (typeof model === 'string') sm.model = model;
          }
        }
        continue;
      }
      case 'subagent/descriptor': {
        if (typeof data === 'object' && data !== null) {
          descriptor = data as { provider?: unknown; label?: unknown };
        }
        continue;
      }
      default:
        // Everything else — turn/step markers, assistant/chunk + packed chunk
        // rows, approval/permission/sandbox state, todo/write, agent/inbox
        // control plane — is log-only or duplicated by an indexed event.
        continue;
    }
  }

  if (isSubagent && parentSession !== null) {
    records.push({
      kind: 'subagent', agent_id: header.id, session_id: parentSession,
      parent_tool_use_id: null,
      agent_type: typeof descriptor?.provider === 'string' ? descriptor.provider : null,
      description: typeof descriptor?.label === 'string' ? descriptor.label : null,
      duration_ms: null, total_tokens: null,
    });
  } else if (!isSubagent) {
    records.push({
      kind: 'session', id: sessionId,
      title: sm.title,
      project: projectSlugFromPath(normalizeObservedCwd(header.cwd)) ?? unit.project ?? null,
      started_at: new Date(header.createdAt).toISOString(), ended_at: sm.ended_at,
      git_branch: null, version: String(header.version),
      message_count: sm.n, countMode: effectiveSkip > 0 ? 'delta' : 'total',
      jsonl_path: path, source: 'deepseek',
    });
  }

  yield* records;
  return `${mtime}:${lineNum}`;
}

/** Locate a session artifact by raw session id across the project directories. */
function findDeepseekFile(rootDir: string, sessionId: string): string | null {
  if (!existsSync(rootDir)) return null;
  for (const project of readdirSync(rootDir)) {
    const projectPath = join(rootDir, project);
    if (!isDir(projectPath)) continue;
    for (const suffix of SESSION_FILE_SUFFIXES) {
      const candidate = join(projectPath, sessionId, `session${suffix}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Return the raw artifact line for a message uuid (`deepseek:<sessionId>:<line>[:0|:1]`). */
function rawDeepseek(rootDir: string, input: RawLookup): RawRecord | null {
  const match = /^deepseek:([^:]+):(\d+)(?::[01])?$/.exec(input.messageUuid);
  if (match === null) return null;
  const sessionId = match[1]!;
  const lineNumber = Number(match[2]);
  const path = typeof input.session?.jsonl_path === 'string' && existsSync(input.session.jsonl_path)
    ? input.session.jsonl_path
    : findDeepseekFile(rootDir, sessionId);
  if (path === null || !existsSync(path)) return null;
  const lines = artifactText(path, readFileSync(path)).split('\n');
  let raw: string | undefined;
  let recordNum = 0;
  for (const line of lines) {
    if (line === '') continue;
    recordNum++;
    if (recordNum === lineNumber) { raw = line; break; }
  }
  if (raw === undefined || raw === '') return null;
  let messageText: string | null = null;
  try {
    const obj = JSON.parse(raw) as { type?: unknown; data?: unknown };
    if (obj?.type === 'user/message' || obj?.type === 'assistant/message') {
      const message = (obj.data as { message?: { content?: unknown } } | undefined)?.message;
      const content = typeof message === 'object' && message !== null
        ? (message as { content?: unknown }).content
        : undefined;
      messageText = Array.isArray(content) ? textFromBlocks(content, 'text') : null;
    }
  } catch { /* malformed source line */ }
  return { text: raw, totalLength: raw.length, offset: 0, limit: raw.length, hasMore: false, messageText };
}

export function createDeepseekProvider({ rootDir = deepseekSessionsRoot() } = {}): ProviderAdapter {
  return {
    name,
    descriptor: { id: name, name: 'DeepSeek Harness', vendor: 'DeepSeek', defaultRoot: rootDir, color: '#4d6bfe' },
    indexVersionMarker: DEEPSEEK_CANONICAL_TRANSCRIPT_MARKER,
    watchRoots: (configuredRoot) => [configuredRoot],
    discover: (ctx) => discoverAt(rootDir, ctx),
    parse,
    raw: (input) => rawDeepseek(rootDir, input),
  };
}

export const deepseekProvider = createDeepseekProvider();
