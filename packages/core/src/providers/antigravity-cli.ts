// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Native Google Antigravity CLI conversations (`agy`).
//
// Each session lives at:
//   <root>/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl
// (falling back to transcript.jsonl). Titles, workspaces, and sub-agent parent
// links come from <root>/conversation_summaries.db, opened read-only.
// Cached sessions stay searchable even after Antigravity prunes local logs,
// and temporary summary DB locks preserve previously observed metadata.

import { existsSync, readFileSync, readdirSync, statSync, type Stats } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeObservedCwd, normalizeTranscriptTimestamp, projectSlugFromPath, sourceInventoryIssue, trunc, truncJson,
} from '../parsing.ts';
import type { SqliteDb } from '../sqlite-types.ts';
import { RetryableSourceReadError } from './source-read-error.ts';
import type {
  Cursor, DiscoverContext, HarnessKind, IndexUnit, MessageRecord, ProviderAdapter,
  RawLookup, RawRecord, TranscriptRecord, WatchTarget,
} from './types.ts';

const name = 'antigravity-cli';
const ANTIGRAVITY_CLI_CANONICAL_TRANSCRIPT_MARKER = '__antigravity_cli_canonical_transcript_v1__';
export type AntigravityCliDatabaseOpener = (path: string) => SqliteDb;

const CURSOR_TAG = 'antigravity-cli-snapshot-v1';
const BRAIN_DIR = 'brain';
const LOG_SUBPATH = join('.system_generated', 'logs');
const TRANSCRIPT_FILES = ['transcript_full.jsonl', 'transcript.jsonl'] as const;
const SUMMARY_DB = 'conversation_summaries.db';
const BUSY_TIMEOUT_MS = 500;
const CONVERSATION_DIR = /^[0-9a-f-]{36}$/i;

type JsonObject = Record<string, any>;

interface ConversationMeta {
  readonly title: string | null;
  readonly cwd: string | null;
  /** A sub-agent created this conversation; its requests are the parent agent's tasks. */
  readonly startedByAgent: boolean;
}

const NO_META: ConversationMeta = { title: null, cwd: null, startedByAgent: false };
// Probe existing columns so schema changes only omit missing fields.
const SUMMARY_COLUMNS = ['conversation_id', 'title', 'workspace_uris', 'parent_conversation_id', 'nesting_depth'] as const;

interface TranscriptUnitMeta extends ConversationMeta {
  readonly conversationId: string;
  readonly path: string;
  readonly expectedFingerprint: string;
  readonly currentCursor: string;
}

interface TranscriptSnapshot extends ConversationMeta {
  readonly path: string;
  readonly lines: readonly string[];
}

interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
}

interface MessageOptions extends Partial<Usage> {
  harnessKind?: HarnessKind | null;
}

type SummariesReadResult =
  | { readonly ok: true; readonly summaries: Map<string, ConversationMeta> }
  | { readonly ok: false; readonly error: unknown };

const require = createRequire(import.meta.url);

function defaultOpenDatabase(path: string): SqliteDb {
  // Defer node:sqlite so Electron bundlers do not hoist it; the desktop app
  // injects better-sqlite3 with the same structural shape.
  const specifier = ['node', 'sqlite'].join(':');
  const { DatabaseSync } = require(specifier) as {
    DatabaseSync: new (path: string, options: { readOnly: boolean; timeout?: number }) => SqliteDb;
  };
  return new DatabaseSync(path, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// Antigravity reports input_tokens separately from cache_read_tokens;
// Obelisk stores the total input tokens.
function usageOf(step: JsonObject): Usage {
  const input = numberOrNull(step.input_tokens);
  return {
    inputTokens: input === null ? null : input + (numberOrNull(step.cache_read_tokens) ?? 0),
    outputTokens: numberOrNull(step.output_tokens),
  };
}

function hasMedia(step: JsonObject): boolean {
  return Array.isArray(step.media) && step.media.length > 0;
}

/** @internal Exported for tests. */
export function antigravityCliSessionId(conversationId: string): string {
  return `${name}:${conversationId}`;
}

function workspacePath(uri: unknown): string | null {
  if (typeof uri !== 'string' || !uri.startsWith('file:')) return null;
  try {
    const path = fileURLToPath(uri).replace(/^([a-z]):/, (_, drive: string) => `${drive.toUpperCase()}:`);
    return normalizeObservedCwd(path);
  } catch {
    // Non-local URIs (e.g. remote workspaces) do not resolve to a local path.
    return null;
  }
}

function readSummaries(rootDir: string, openDatabase: AntigravityCliDatabaseOpener): SummariesReadResult {
  const path = join(rootDir, SUMMARY_DB);
  const out = new Map<string, ConversationMeta>();
  if (!existsSync(path)) return { ok: true, summaries: out };
  let db: SqliteDb | undefined;
  try {
    db = openDatabase(path);
    const present = new Set(db.prepare('PRAGMA table_info(conversation_summaries)').all().map((row) => String(row.name)));
    if (!present.has('conversation_id')) return { ok: true, summaries: out };
    const columns = SUMMARY_COLUMNS.filter((column) => present.has(column)).join(', ');
    const rows = db.prepare(`SELECT ${columns} FROM conversation_summaries`).all();
    for (const row of rows) {
      const id = text(row.conversation_id);
      if (id === null) continue;
      let uris: unknown[] = [];
      try {
        const parsed: unknown = JSON.parse(String(row.workspace_uris || '[]'));
        if (Array.isArray(parsed)) uris = parsed;
      } catch {
        // Empty or malformed workspace_uris yields no workspace.
      }
      const cwd = uris.map(workspacePath).find((value) => value !== null) ?? null;
      const title = text(row.title)?.trim() || null;
      const startedByAgent = Boolean(text(row.parent_conversation_id)) || Number(row.nesting_depth ?? 0) > 0;
      out.set(id, { title, cwd, startedByAgent });
    }
    return { ok: true, summaries: out };
  } catch (error) {
    // Distinguish a locked/unreadable summary DB from an absent row so
    // callers preserve prior metadata and keep the provider retryable.
    return { ok: false, error };
  } finally {
    try {
      db?.close();
    } catch {
      // Closing a read-only handle has nothing to roll back.
    }
  }
}

function isAbsence(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function transcriptPath(conversationDir: string, onError: (path: string, error: unknown) => void): string | null {
  for (const file of TRANSCRIPT_FILES) {
    const candidate = join(conversationDir, LOG_SUBPATH, file);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch (error) {
      if (!isAbsence(error)) {
        onError(candidate, error);
        return null;
      }
    }
  }
  return null;
}

function encodeMeta(meta: ConversationMeta): string {
  return Buffer.from(JSON.stringify([meta.title, meta.cwd, meta.startedByAgent ? 1 : 0])).toString('base64url');
}

function decodeCursorMeta(cursor: Cursor | undefined): ConversationMeta | null {
  if (typeof cursor !== 'string') return null;
  const parts = cursor.split(':');
  if (parts.length < 7 || parts[2] !== CURSOR_TAG) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[6], 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length < 3) return null;
    const title = typeof parsed[0] === 'string' ? parsed[0] : null;
    const cwd = typeof parsed[1] === 'string' ? parsed[1] : null;
    const startedByAgent = parsed[2] === 1 || parsed[2] === true;
    return { title, cwd, startedByAgent };
  } catch {
    // Unrecognized legacy or corrupt cursor metadata cannot be reused.
    return null;
  }
}

function fileFingerprint(stat: Stats): string {
  return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`;
}

// mtime + ctime + size + inode + encoded metadata so a rewrite or summary
// update triggers re-projection, while DB locks preserve prior metadata.
function cursorFor(stat: Stats, meta: ConversationMeta): string {
  return `${stat.mtimeMs}:0:${CURSOR_TAG}:${stat.ctimeMs}:${stat.size}:${stat.ino}:${encodeMeta(meta)}`;
}

// Node's SQLite binding truncates TEXT at embedded NULs; escape them in
// canonical fields so direct assembly and persisted rows stay identical.
function escapeNul(value: string): string {
  return value.replaceAll('\0', '\\^@');
}

type TranscriptValidation =
  | { readonly ok: true; readonly lines: string[] }
  | { readonly ok: false; readonly reason: string };

// Reject empty, truncated, or malformed transcripts before replacing indexed
// history or certifying an empty inventory.
function validateTranscriptBuffer(buffer: Buffer): TranscriptValidation {
  if (buffer.length === 0) {
    return { ok: false, reason: 'Antigravity CLI transcript is empty' };
  }
  const end = buffer.lastIndexOf(0x0a);
  const trailing = (end < 0 ? buffer : buffer.subarray(end + 1)).toString('utf8');
  if (trailing.trim().length > 0) {
    return { ok: false, reason: 'Antigravity CLI transcript has an incomplete trailing line' };
  }
  const body = end < 0 ? '' : buffer.subarray(0, end + 1).toString('utf8');
  const lines = body.length > 0 ? body.split('\n').slice(0, -1) : [];
  let validSteps = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const step = object(JSON.parse(line));
      if (step === null || typeof step.type !== 'string') {
        return { ok: false, reason: 'Antigravity CLI transcript contains a non-step JSON line' };
      }
      validSteps++;
    } catch {
      return { ok: false, reason: 'Antigravity CLI transcript contains invalid JSON' };
    }
  }
  if (validSteps === 0) {
    return { ok: false, reason: 'Antigravity CLI transcript has no steps' };
  }
  return { ok: true, lines };
}

function readCompleteLines(path: string): string[] {
  const buffer = readFileSync(path);
  const end = buffer.lastIndexOf(0x0a);
  const body = end < 0 ? '' : buffer.subarray(0, end + 1).toString('utf8');
  return body.length > 0 ? body.split('\n').slice(0, -1) : [];
}

function userRequestText(content: unknown): string | null {
  if (typeof content !== 'string') return null;
  const requests = [...content.matchAll(/<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/g)].map((match) => match[1]);
  if (requests.length > 0) {
    const joined = requests.join('\n\n');
    return joined.trim() ? joined : null;
  }
  return content
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '')
    .trim() || null;
}

function decodeArgs(args: unknown): unknown {
  const value = object(args);
  if (value === null) return args ?? {};
  const out: JsonObject = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string') {
      try {
        out[key] = JSON.parse(raw);
        continue;
      } catch {
        // Non-JSON string argument stays as raw text.
      }
    }
    out[key] = raw;
  }
  return out;
}

function lineTag(lineIndex: number): string {
  return String(lineIndex + 1).padStart(6, '0');
}

const HARNESS_STEPS: Readonly<Record<string, HarnessKind>> = {
  SYSTEM_MESSAGE: 'reminder',
  CHECKPOINT: 'compaction',
  ERROR_MESSAGE: 'error',
};

interface ParsedLine {
  readonly lineIndex: number;
  readonly step: JsonObject;
}

interface ToolOutput {
  readonly content: string;
  readonly failed: boolean;
}

function parsedLines(lines: readonly string[]): ParsedLine[] {
  const out: ParsedLine[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const step = object(JSON.parse(line));
      if (step !== null) out.push({ lineIndex, step });
    } catch {
      // A malformed line cannot be projected; raw() still serves it by line number.
    }
  }
  return out;
}

function isToolOutputStep(step: JsonObject): boolean {
  return step.type === 'GENERIC' || (step.source === 'MODEL' && step.type !== 'PLANNER_RESPONSE');
}

const toolsUuid = (id: string, lineIndex: number): string => `${id}:L${lineTag(lineIndex)}:3-tools`;
const callIdOf = (toolsMessage: string, callIndex: number): string => `${toolsMessage}:c${String(callIndex + 1).padStart(3, '0')}`;

// Tool output k of a PLANNER_RESPONSE at step n is logged as step n + k
// (e.g. VIEW_FILE, RUN_COMMAND, CODE_ACTION, GREP_SEARCH, LIST_DIRECTORY, GENERIC).
// Pair by step index with the nearest response first, falling back to log order.
function pairOutputs(steps: readonly ParsedLine[], id: string): Map<number, string> {
  const responsesByStep = new Map<number, { lineIndex: number; calls: string[] }[]>();
  let widest = 0;
  for (const { lineIndex, step } of steps) {
    const index = numberOrNull(step.step_index);
    if (step.type !== 'PLANNER_RESPONSE' || index === null || !Array.isArray(step.tool_calls)) continue;
    const calls = step.tool_calls.map((_: unknown, callIndex: number) => callIdOf(toolsUuid(id, lineIndex), callIndex));
    responsesByStep.set(index, [...(responsesByStep.get(index) ?? []), { lineIndex, calls }]);
    widest = Math.max(widest, calls.length);
  }
  const answered = new Set<string>();
  const outputs = new Map<number, string>();
  let pending: string[] = [];
  for (const { lineIndex, step } of steps) {
    if (step.type === 'USER_INPUT') pending = [];
    if (step.type === 'PLANNER_RESPONSE') {
      pending = Array.isArray(step.tool_calls)
        ? step.tool_calls.map((_: unknown, callIndex: number) => callIdOf(toolsUuid(id, lineIndex), callIndex))
        : [];
    }
    if (!isToolOutputStep(step)) continue;
    const index = numberOrNull(step.step_index);
    let callId: string | undefined;
    let distance = Infinity;
    for (let offset = 1; index !== null && offset <= widest; offset++) {
      for (const response of responsesByStep.get(index - offset) ?? []) {
        const candidate = response.calls[offset - 1];
        const gap = Math.abs(response.lineIndex - lineIndex);
        if (candidate === undefined || answered.has(candidate) || gap >= distance) continue;
        callId = candidate;
        distance = gap;
      }
    }
    callId ??= pending.find((candidate) => !answered.has(candidate));
    if (callId === undefined) continue;
    answered.add(callId);
    outputs.set(lineIndex, callId);
  }
  return outputs;
}

function projectedRecords(snapshot: TranscriptSnapshot, id: string): TranscriptRecord[] {
  const out: TranscriptRecord[] = [];
  const cwd = snapshot.cwd;
  let parent: string | null = null;
  let messageCount = 0;
  let firstAt: string | null = null;
  let lastAt: string | null = null;
  let firstUserText: string | null = null;
  const seenRequests = new Set<string>();
  const steps = parsedLines(snapshot.lines);
  const outputCall = pairOutputs(steps, id);
  const outputs = new Map<string, ToolOutput>();
  for (const { lineIndex, step } of steps) {
    const callId = outputCall.get(lineIndex);
    if (callId === undefined) continue;
    outputs.set(callId, {
      content: text(step.content) ?? text(step.error) ?? '',
      failed: Boolean(step.error) || step.status === 'ERROR' || step.status === 'INVALID',
    });
  }

  const addMessage = (
    uuid: string,
    role: 'user' | 'assistant' | 'system',
    body: string | null,
    contentType: string,
    timestamp: string | null,
    { harnessKind = null, inputTokens = null, outputTokens = null }: MessageOptions = {},
  ): void => {
    const isMeta: 0 | 1 = harnessKind === null || (role === 'user' && harnessKind === 'task') ? 0 : 1;
    const message: MessageRecord = {
      kind: 'message', uuid, session_id: id, type: role, parent_uuid: parent,
      timestamp, role, text: body === null ? null : trunc(escapeNul(body)), content_type: contentType,
      is_meta: isMeta, harness_kind: harnessKind, visibility: 'visible',
      model: null, is_sidechain: 0, agent_id: null, input_tokens: inputTokens, output_tokens: outputTokens,
      cwd, skill: null, source: name,
    };
    out.push(message);
    parent = uuid;
    messageCount++;
  };

  for (const { lineIndex, step } of steps) {
    const type = text(step.type);
    const at = normalizeTranscriptTimestamp(step.created_at);
    if (at !== null) {
      firstAt ??= at;
      lastAt = at;
    }
    const base = `${id}:L${lineTag(lineIndex)}`;

    if (type === 'USER_INPUT') {
      const body = userRequestText(step.content);
      const key = `${String(step.step_index)}\0${body}`;
      // Antigravity logs a resent request again under its original step index.
      if ((body === null && !hasMedia(step)) || seenRequests.has(key)) continue;
      seenRequests.add(key);
      firstUserText ??= body;
      addMessage(base, 'user', body, body === null ? 'unknown' : 'text', at, {
        harnessKind: snapshot.startedByAgent ? 'task' : null,
      });
      continue;
    }

    if (type === 'PLANNER_RESPONSE') {
      // Suffixes sort in the order the parts are emitted.
      let usage: Usage = usageOf(step);
      const takeUsage = (): Usage => {
        const current = usage;
        usage = { inputTokens: null, outputTokens: null };
        return current;
      };
      const thinking = text(step.thinking);
      if (thinking) addMessage(`${base}:1-thinking`, 'assistant', thinking, 'thinking', at, takeUsage());
      const content = text(step.content);
      if (content) addMessage(`${base}:2-text`, 'assistant', content, 'text', at, takeUsage());
      const calls: unknown[] = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      if (calls.length > 0) {
        const uuid = toolsUuid(id, lineIndex);
        addMessage(uuid, 'assistant', null, 'tool_use', at, takeUsage());
        for (const [callIndex, candidate] of calls.entries()) {
          const call = object(candidate) ?? {};
          const callId = callIdOf(uuid, callIndex);
          const args = decodeArgs(call.args);
          const argObject = object(args);
          const pathArg = text(argObject?.Path) ?? text(argObject?.AbsolutePath);
          out.push({
            kind: 'tool_call', id: callId, message_uuid: uuid, session_id: id,
            name: text(call.name) ?? 'tool', presentation: 'default',
            input_json: truncJson(args) ?? '{}', file_path: pathArg,
          });
        }
        for (const [callIndex] of calls.entries()) {
          const callId = callIdOf(uuid, callIndex);
          const output = outputs.get(callId);
          if (output === undefined) continue;
          out.push({
            kind: 'tool_result', tool_use_id: callId, message_uuid: uuid,
            session_id: id, content: trunc(escapeNul(output.content)), file_path: null, is_error: output.failed ? 1 : 0,
          });
        }
      }
      if (!thinking && !content && calls.length === 0) {
        addMessage(`${base}:empty`, 'assistant', null, 'unknown', at, takeUsage());
      }
      continue;
    }

    if (isToolOutputStep(step)) {
      if (outputCall.has(lineIndex)) continue;
      const body = text(step.content) ?? text(step.error) ?? '';
      if (body || hasMedia(step)) {
        addMessage(`${base}:output`, 'system', body || null, body ? 'text' : 'unknown', at, { harnessKind: 'result' });
      }
      continue;
    }

    const harnessKind = (type !== null ? HARNESS_STEPS[type] : undefined) ?? 'other';
    const body = text(step.content) ?? text(step.error);
    const usage = type === 'CHECKPOINT' ? usageOf(step) : {};
    addMessage(`${base}:${harnessKind}`, 'system', body, body === null ? 'unknown' : 'text', at, { harnessKind, ...usage });
  }

  // Pin workspace even if no visible message projected.
  if (messageCount === 0 && cwd !== null) {
    out.push({
      kind: 'message', uuid: `${id}:workspace`, session_id: id, type: 'system', parent_uuid: null,
      timestamp: firstAt, role: 'system', text: null, content_type: 'unknown', is_meta: 1,
      harness_kind: 'other', visibility: 'hidden', model: null, is_sidechain: 0, agent_id: null,
      input_tokens: null, output_tokens: null, cwd, skill: null, source: name,
    });
  }
  const fallbackTitle = firstUserText
    ? trunc(escapeNul(firstUserText).replace(/\s+/g, ' ').trim(), 80)
    : null;
  const rawTitle = snapshot.title ?? fallbackTitle;
  out.push({
    kind: 'session', id, title: rawTitle === null ? null : trunc(escapeNul(rawTitle)), project: projectSlugFromPath(cwd),
    started_at: firstAt, ended_at: lastAt, git_branch: null, version: null,
    message_count: messageCount, countMode: 'total', jsonl_path: snapshot.path, source: name,
    started_by: snapshot.startedByAgent ? 'agent' : null,
  });
  return out;
}

export function createAntigravityCliProvider({
  homeDir = homedir(),
  rootDir = join(homeDir, '.gemini', 'antigravity-cli'),
  openDatabase = defaultOpenDatabase,
}: { rootDir?: string; homeDir?: string; openDatabase?: AntigravityCliDatabaseOpener } = {}): ProviderAdapter {
  const brainRoot = join(rootDir, BRAIN_DIR);

  function discover(ctx: DiscoverContext): IndexUnit[] {
    const indexed = (ctx.indexedSessions?.() ?? []).filter((session) => inside(brainRoot, session.jsonlPath));
    const retainAll = (): void => {
      for (const session of indexed) ctx.retainSession?.(session.sessionId);
    };
    let entries;
    try {
      entries = readdirSync(brainRoot, { withFileTypes: true });
    } catch (error) {
      // Missing transcripts or brain root retain previously indexed history.
      if (!isAbsence(error)) ctx.reportIncompleteInventory?.(sourceInventoryIssue(brainRoot, error));
      retainAll();
      return [];
    }

    const summariesResult = readSummaries(rootDir, openDatabase);
    if (!summariesResult.ok) {
      ctx.reportIncompleteInventory?.(sourceInventoryIssue(join(rootDir, SUMMARY_DB), summariesResult.error));
    }

    const indexedById = new Map(indexed.map((session) => [session.sessionId, session]));
    const live = new Set<string>();
    const units: IndexUnit[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || !CONVERSATION_DIR.test(entry.name)) continue;
      const file = transcriptPath(join(brainRoot, entry.name), (path, error) => {
        ctx.reportIncompleteInventory?.(sourceInventoryIssue(path, error));
      });
      if (file === null) continue;
      const id = antigravityCliSessionId(entry.name);
      const prior = indexedById.get(id);
      // Never downgrade a session previously indexed from transcript_full.jsonl
      // to the truncated transcript.jsonl fallback; retain it until full returns.
      if (prior && basename(prior.jsonlPath) === TRANSCRIPT_FILES[0] && basename(file) !== TRANSCRIPT_FILES[0]) {
        continue;
      }
      let stat: Stats;
      try {
        stat = statSync(file);
      } catch (error) {
        if (!isAbsence(error)) ctx.reportIncompleteInventory?.(sourceInventoryIssue(file, error));
        continue;
      }
      const key = normalize(file);
      const priorKey = prior ? normalize(prior.jsonlPath) : null;
      const priorMeta = decodeCursorMeta(
        ctx.previousCursor?.(key)
        ?? ctx.lastCursor(key)
        ?? (priorKey && priorKey !== key ? (ctx.previousCursor?.(priorKey) ?? ctx.lastCursor(priorKey)) : null),
      );
      const meta = summariesResult.ok
        ? (summariesResult.summaries.get(entry.name) ?? NO_META)
        : (priorMeta ?? NO_META);
      const cursor = cursorFor(stat, meta);
      if (ctx.lastCursor(key) === cursor) {
        live.add(id);
        continue;
      }

      let validation: TranscriptValidation;
      try {
        validation = validateTranscriptBuffer(readFileSync(file));
      } catch (error) {
        ctx.reportIncompleteInventory?.(sourceInventoryIssue(file, error));
        continue;
      }
      if (!validation.ok) {
        ctx.reportIncompleteInventory?.(sourceInventoryIssue(file, validation.reason));
        continue;
      }
      live.add(id);

      units.push({
        key,
        sessionId: id,
        project: projectSlugFromPath(meta.cwd) ?? undefined,
        meta: {
          ...meta,
          conversationId: entry.name,
          path: file,
          expectedFingerprint: fileFingerprint(stat),
          currentCursor: cursor,
        } satisfies TranscriptUnitMeta,
        retractSessionIds: [id],
      });
    }

    // Cached sessions stay searchable if Antigravity removes source transcripts.
    for (const session of indexed) {
      if (!live.has(session.sessionId)) ctx.retainSession?.(session.sessionId);
    }
    return units;
  }

  function* parse(unit: IndexUnit, _cursor: Cursor): Generator<TranscriptRecord, Cursor> {
    const meta = unit.meta as TranscriptUnitMeta;
    const assertStable = (): Stats => {
      let current: Stats;
      try {
        current = statSync(meta.path);
      } catch (error) {
        throw new RetryableSourceReadError(meta.path, 'Antigravity CLI transcript is unavailable', { cause: error });
      }
      if (fileFingerprint(current) !== meta.expectedFingerprint) {
        throw new RetryableSourceReadError(meta.path, 'Antigravity CLI transcript changed during indexing');
      }
      return current;
    };
    const before = assertStable();
    let buffer: Buffer;
    try {
      buffer = readFileSync(meta.path);
    } catch (error) {
      assertStable();
      throw new RetryableSourceReadError(meta.path, 'Antigravity CLI transcript is unavailable', { cause: error });
    }
    assertStable();
    const validation = validateTranscriptBuffer(buffer);
    if (!validation.ok) {
      throw new RetryableSourceReadError(meta.path, validation.reason);
    }
    yield* projectedRecords({ ...meta, lines: validation.lines }, unit.sessionId);
    return cursorFor(before, meta);
  }

  function raw(input: RawLookup): RawRecord | null {
    try {
      const path = text(input.session?.jsonl_path);
      const id = text(input.session?.id);
      if (path === null || id === null || !inside(brainRoot, path) || !input.messageUuid.startsWith(`${id}:`)) return null;
      const match = /:L(\d{6})(?::([\w-]+))?$/.exec(input.messageUuid);
      if (match === null) return null;
      const line = readCompleteLines(path)[Number(match[1]) - 1];
      if (line === undefined) return null;
      const suffix = match[2] ?? null;
      let messageText: string | null = null;
      try {
        const step = object(JSON.parse(line));
        if (step?.type === 'USER_INPUT') {
          messageText = userRequestText(step.content);
        } else if (suffix === '1-thinking') {
          messageText = text(step?.thinking);
        } else if (suffix === '2-text') {
          messageText = text(step?.content);
        } else if (suffix === '3-tools' || suffix === 'empty') {
          messageText = null;
        } else {
          messageText = text(step?.content) ?? text(step?.error);
        }
      } catch {
        // Malformed JSON still returns the raw line without parsed messageText.
      }
      return { text: line, totalLength: line.length, offset: 0, limit: line.length, hasMore: false, messageText };
    } catch {
      // The transcript moved or vanished since indexing.
      return null;
    }
  }

  return {
    name,
    descriptor: { id: name, name: 'Antigravity CLI', vendor: 'Google', defaultRoot: rootDir, color: '#4f8cff' },
    indexVersionMarker: ANTIGRAVITY_CLI_CANONICAL_TRANSCRIPT_MARKER,
    watchTargets: (configuredRoot: string): WatchTarget[] => [
      { kind: 'tree', path: join(configuredRoot, BRAIN_DIR), fileNames: [...TRANSCRIPT_FILES] },
      // Titles and workspaces can update in SQLite without a transcript append.
      { kind: 'file', path: join(configuredRoot, SUMMARY_DB) },
      { kind: 'file', path: join(configuredRoot, `${SUMMARY_DB}-wal`) },
    ],
    discover,
    parse,
    raw,
  };
}
