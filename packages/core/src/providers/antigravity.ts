// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Native Antigravity conversations. Antigravity keeps one append-only step log
// per conversation at
//   <root>/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl
// (transcript.jsonl is the same log with long fields cut). Titles and workspace
// folders live in <root>/conversation_summaries.db, which is only ever opened
// read-only. Each unit replaces one session: the log is re-projected in full
// whenever its stat fingerprint or its summary metadata changes.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, type Stats } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeObservedCwd, normalizeTranscriptTimestamp, projectSlugFromPath, sourceInventoryIssue, trunc, truncJson,
} from '../parsing.ts';
import type { SqliteDb } from '../sqlite-types.ts';
import type {
  Cursor, DiscoverContext, HarnessKind, IndexUnit, MessageRecord, ProviderAdapter,
  RawLookup, RawRecord, TranscriptRecord, WatchTarget,
} from './types.ts';

const name = 'antigravity';
const ANTIGRAVITY_CANONICAL_TRANSCRIPT_MARKER = '__antigravity_canonical_transcript_v1__';
export type AntigravityDatabaseOpener = (path: string) => SqliteDb;

const CURSOR_TAG = 'antigravity-snapshot-v1';
const BRAIN_DIR = 'brain';
const LOG_SUBPATH = join('.system_generated', 'logs');
const TRANSCRIPT_FILES = ['transcript_full.jsonl', 'transcript.jsonl'] as const;
const SUMMARY_DB = 'conversation_summaries.db';
const CONVERSATION_DIR = /^[0-9a-f-]{36}$/i;

type JsonObject = Record<string, any>;

interface ConversationMeta {
  readonly title: string | null;
  readonly cwd: string | null;
  /** A sub-agent created this conversation; its requests are the parent agent's tasks. */
  readonly startedByAgent: boolean;
}

const NO_META: ConversationMeta = { title: null, cwd: null, startedByAgent: false };
// Read only the columns this schema version has, so a release that drops or
// renames one costs that field instead of every title and workspace.
const SUMMARY_COLUMNS = ['conversation_id', 'title', 'workspace_uris', 'parent_conversation_id', 'nesting_depth'] as const;

interface TranscriptUnitMeta extends ConversationMeta {
  readonly conversationId: string;
  readonly path: string;
  readonly tombstone?: undefined;
}

interface TombstoneUnitMeta {
  readonly tombstone: true;
}

type UnitMeta = TranscriptUnitMeta | TombstoneUnitMeta;

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

const require = createRequire(import.meta.url);

function defaultOpenDatabase(path: string): SqliteDb {
  // Like Kiro and ZCode, defer the Node binding so Electron bundlers do not
  // hoist it; the app injects better-sqlite3 with the same structural shape.
  const specifier = ['node', 'sqlite'].join(':');
  const { DatabaseSync } = require(specifier) as {
    DatabaseSync: new (path: string, options: { readOnly: boolean }) => SqliteDb;
  };
  return new DatabaseSync(path, { readOnly: true });
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

// Antigravity reports input_tokens without the cached prefix it read
// (cache_read_tokens is usually the larger of the two); Obelisk stores the total.
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

// The conversation id is the random UUID Antigravity mints for the conversation
// directory. It is not project-local: a conversation may have no workspace, or
// gain one later in conversation_summaries.db, so the cwd is not part of it.
function antigravitySessionId(conversationId: string): string {
  return `${name}:${conversationId}`;
}

function workspacePath(uri: unknown): string | null {
  if (typeof uri !== 'string' || !uri.startsWith('file:')) return null;
  try {
    // Antigravity writes lowercase drive letters; other providers record uppercase.
    const path = fileURLToPath(uri).replace(/^([a-z]):/, (_, drive: string) => `${drive.toUpperCase()}:`);
    return normalizeObservedCwd(path);
  } catch {
    // Not a local file URI this platform can map (for example a remote workspace).
    return null;
  }
}

// Conversation titles and workspaces. A missing or locked database only costs
// metadata, so it never marks the transcript inventory incomplete.
function readSummaries(rootDir: string, openDatabase: AntigravityDatabaseOpener): Map<string, ConversationMeta> {
  const path = join(rootDir, SUMMARY_DB);
  const out = new Map<string, ConversationMeta>();
  if (!existsSync(path)) return out;
  let db: SqliteDb | undefined;
  try {
    db = openDatabase(path);
    const present = new Set(db.prepare('PRAGMA table_info(conversation_summaries)').all().map((row) => String(row.name)));
    if (!present.has('conversation_id')) return out;
    const columns = SUMMARY_COLUMNS.filter((column) => present.has(column)).join(', ');
    const rows = db.prepare(`SELECT ${columns} FROM conversation_summaries`).all();
    for (const row of rows) {
      const id = text(row.conversation_id);
      if (id === null) continue;
      let uris: unknown[] = [];
      try {
        const parsed: unknown = JSON.parse(String(row.workspace_uris || '[]'));
        if (Array.isArray(parsed)) uris = parsed;
      } catch { /* Empty or malformed: the conversation has no usable workspace. */ }
      const cwd = uris.map(workspacePath).find((value) => value !== null) ?? null;
      const title = text(row.title)?.trim() || null;
      const startedByAgent = Boolean(text(row.parent_conversation_id)) || Number(row.nesting_depth ?? 0) > 0;
      out.set(id, { title, cwd, startedByAgent });
    }
  } catch {
    // Unreadable metadata degrades to untitled, workspace-less sessions.
    return out;
  } finally {
    try { db?.close(); } catch { /* Closing a read-only handle has nothing to roll back. */ }
  }
  return out;
}

function isAbsence(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

// Only absence means "no transcript"; any other stat failure is reported, so
// an unreadable conversation is never mistaken for a deleted one.
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

function metaDigest(meta: ConversationMeta): string {
  return createHash('sha256')
    .update(`${meta.title ?? ''}\0${meta.cwd ?? ''}\0${meta.startedByAgent ? 'agent' : ''}`)
    .digest('base64url').slice(0, 16);
}

// mtime + ctime + size + inode, so a same-millisecond rewrite still changes it.
function cursorFor(stat: Stats, meta: ConversationMeta): string {
  return `${stat.mtimeMs}:0:${CURSOR_TAG}:${stat.ctimeMs}:${stat.size}:${stat.ino}:${metaDigest(meta)}`;
}

// Only complete lines count; a line still being written is picked up next time.
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

// Antigravity stores each tool argument as a JSON-encoded string.
function decodeArgs(args: unknown): unknown {
  const value = object(args);
  if (value === null) return args ?? {};
  const out: JsonObject = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string') {
      try {
        out[key] = JSON.parse(raw);
        continue;
      } catch { /* Not JSON: keep the raw string. */ }
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

const toolsUuid = (id: string, lineIndex: number): string => `${id}:L${lineTag(lineIndex)}:3-tools`;
const callIdOf = (toolsMessage: string, callIndex: number): string => `${toolsMessage}:c${String(callIndex + 1).padStart(3, '0')}`;

// Output k of the response at step n is logged as step n + k, but Antigravity
// sometimes writes that output before the response line itself. Pair by step
// index first; fall back to log order only when no response fits. A resent
// request restarts step numbering, so one step index can name several
// responses: the one nearest the output in the log owns it.
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
    if (step.type !== 'GENERIC') continue;
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
    const message: MessageRecord = {
      kind: 'message', uuid, session_id: id, type: role, parent_uuid: parent,
      timestamp, role, text: body === null ? null : trunc(body), content_type: contentType,
      is_meta: harnessKind === null ? 0 : 1, harness_kind: harnessKind, visibility: 'visible',
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
      addMessage(base, 'user', body, body === null ? 'unknown' : 'text', at);
      continue;
    }

    if (type === 'PLANNER_RESPONSE') {
      // Token usage belongs to the response once, on its first projected message.
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
            session_id: id, content: trunc(output.content), file_path: null, is_error: output.failed ? 1 : 0,
          });
        }
      }
      // A response that left no text and no call still records that the model ran.
      if (!thinking && !content && calls.length === 0) {
        addMessage(`${base}:empty`, 'assistant', null, 'unknown', at, takeUsage());
      }
      continue;
    }

    if (type === 'GENERIC') {
      if (outputCall.has(lineIndex)) continue;
      const body = text(step.content) ?? text(step.error) ?? '';
      if (body || hasMedia(step)) {
        addMessage(`${base}:output`, 'system', body || null, body ? 'text' : 'unknown', at, { harnessKind: 'result' });
      }
      continue;
    }

    const harnessKind = (type !== null ? HARNESS_STEPS[type] : undefined) ?? 'other';
    const body = text(step.content) ?? text(step.error);
    // A compaction checkpoint is a model call of the harness's own; keep its usage.
    const usage = type === 'CHECKPOINT' ? usageOf(step) : {};
    addMessage(`${base}:${harnessKind}`, 'system', body, body === null ? 'unknown' : 'text', at, { harnessKind, ...usage });
  }

  // A conversation with no projected message still pins its workspace, so the
  // session resolves to the right project.
  if (messageCount === 0 && cwd !== null) {
    out.push({
      kind: 'message', uuid: `${id}:workspace`, session_id: id, type: 'system', parent_uuid: null,
      timestamp: firstAt, role: 'system', text: null, content_type: 'unknown', is_meta: 1,
      harness_kind: 'other', visibility: 'hidden', model: null, is_sidechain: 0, agent_id: null,
      input_tokens: null, output_tokens: null, cwd, skill: null, source: name,
    });
  }
  const fallbackTitle = firstUserText ? firstUserText.replace(/\s+/g, ' ').trim().slice(0, 80) : null;
  out.push({
    kind: 'session', id, title: snapshot.title ?? fallbackTitle, project: projectSlugFromPath(cwd),
    started_at: firstAt, ended_at: lastAt, git_branch: null, version: null,
    message_count: messageCount, countMode: 'total', jsonl_path: snapshot.path, source: name,
    started_by: snapshot.startedByAgent ? 'agent' : null,
  });
  return out;
}

export function createAntigravityProvider({
  homeDir = homedir(),
  rootDir = join(homeDir, '.gemini', 'antigravity'),
  openDatabase = defaultOpenDatabase,
}: { rootDir?: string; homeDir?: string; openDatabase?: AntigravityDatabaseOpener } = {}): ProviderAdapter {
  const brainRoot = join(rootDir, BRAIN_DIR);

  function discover(ctx: DiscoverContext): IndexUnit[] {
    // Only sessions read from this root are this scan's to retire: a root that
    // is no longer selected is not evidence that its conversations were deleted.
    const indexed = (ctx.indexedSessions?.() ?? []).filter((session) => inside(brainRoot, session.jsonlPath));
    let complete = true;
    const issue = (path: string, error: unknown): void => {
      complete = false;
      ctx.reportIncompleteInventory?.(sourceInventoryIssue(path, error));
    };
    let entries;
    try {
      entries = readdirSync(brainRoot, { withFileTypes: true });
    } catch (error) {
      // A missing root is an empty source until something was indexed from it.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || indexed.length > 0) issue(brainRoot, error);
      return [];
    }
    const summaries = readSummaries(rootDir, openDatabase);
    const indexedByPath = new Map(indexed.map((session) => [normalize(session.jsonlPath), session.sessionId]));
    const live = new Set<string>();
    const units: IndexUnit[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || !CONVERSATION_DIR.test(entry.name)) continue;
      const path = transcriptPath(join(brainRoot, entry.name), issue);
      if (path === null) continue;
      let stat: Stats;
      try {
        stat = statSync(path);
      } catch (error) {
        issue(path, error);
        continue;
      }
      const id = antigravitySessionId(entry.name);
      const key = normalize(path);
      live.add(id);
      const meta = summaries.get(entry.name) ?? NO_META;
      const cursor = cursorFor(stat, meta);
      const priorId = indexedByPath.get(key);
      const hinted = ctx.changedPaths?.some((changed) => normalize(changed) === key) ?? false;
      if (!hinted && ctx.lastCursor(key) === cursor && (priorId === undefined || priorId === id)) continue;
      const unitMeta: TranscriptUnitMeta = { ...meta, conversationId: entry.name, path };
      units.push({
        key, sessionId: id, project: projectSlugFromPath(meta.cwd) ?? undefined, meta: unitMeta,
        retractSessionIds: priorId && priorId !== id ? [priorId, id] : [id],
      });
    }
    // Retire sessions whose transcript is gone, but only from a complete scan.
    const gone = indexed.filter((old) => {
      if (live.has(old.sessionId)) return false;
      try {
        statSync(old.jsonlPath);
        return false;
      } catch (error) {
        if (isAbsence(error)) return true;
        issue(old.jsonlPath, error);
        return false;
      }
    });
    if (complete) {
      for (const old of gone) {
        const tombstone: TombstoneUnitMeta = { tombstone: true };
        units.push({
          key: normalize(old.jsonlPath), sessionId: old.sessionId,
          retractSessionIds: [old.sessionId], meta: tombstone,
        });
      }
    }
    return units;
  }

  function* parse(unit: IndexUnit, _cursor: Cursor): Generator<TranscriptRecord, Cursor> {
    const meta = unit.meta as UnitMeta;
    if (meta.tombstone) return `0:0:${CURSOR_TAG}:tombstone`;
    // Read whatever is complete now; a conversation that keeps growing is
    // simply re-read on the next refresh instead of failing this one.
    const before = statSync(meta.path);
    const lines = readCompleteLines(meta.path);
    yield* projectedRecords({ ...meta, lines }, unit.sessionId);
    return cursorFor(before, meta);
  }

  function raw(input: RawLookup): RawRecord | null {
    try {
      const path = text(input.session?.jsonl_path);
      const id = text(input.session?.id);
      if (path === null || id === null || !inside(brainRoot, path) || !input.messageUuid.startsWith(`${id}:`)) return null;
      const match = /:L(\d{6})(?::[\w-]+)?$/.exec(input.messageUuid);
      if (match === null) return null;
      const line = readCompleteLines(path)[Number(match[1]) - 1];
      if (line === undefined) return null;
      let messageText: string | null = null;
      try {
        const step = object(JSON.parse(line));
        messageText = step?.type === 'USER_INPUT' ? userRequestText(step.content) : text(step?.content);
      } catch { /* The raw line is still returned without a message text. */ }
      return { text: line, totalLength: line.length, offset: 0, limit: line.length, hasMore: false, messageText };
    } catch {
      // The transcript moved or vanished since it was indexed.
      return null;
    }
  }

  return {
    name,
    descriptor: { id: name, name: 'Antigravity', vendor: 'Google', defaultRoot: rootDir, color: '#4f8cff' },
    indexVersionMarker: ANTIGRAVITY_CANONICAL_TRANSCRIPT_MARKER,
    watchTargets: (configuredRoot: string): WatchTarget[] => [
      { kind: 'tree', path: join(configuredRoot, BRAIN_DIR), fileNames: [...TRANSCRIPT_FILES] },
      // Titles and workspaces can change without a transcript append.
      { kind: 'file', path: join(configuredRoot, SUMMARY_DB) },
      { kind: 'file', path: join(configuredRoot, `${SUMMARY_DB}-wal`) },
    ],
    discover,
    parse,
    raw,
  };
}

export { /** @internal Exported for tests. */ antigravitySessionId };
