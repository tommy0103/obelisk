// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// DeepSeek Harness provider adapter in Core (see docs/adr/0001).
//
// Pure: discovers DeepSeek Harness session logs and parses one into a record
// stream. It never touches the Obelisk database.
//
// Source layout (~/.dsh/sessions by default):
//   <root>/--<normalized-cwd>--/<session-id>/session.jsonl.zstd   (default)
//   <root>/--<normalized-cwd>--/<session-id>/session.jsonl        (compression: none)
//
// A log is one immutable `SessionHeader` line followed by contiguous
// `SessionEvent` lines ({type, seq, time, data}). The default artifact is a
// concatenation of independent Zstandard frames (header frame + one frame per
// append batch); the framing scanner and decoders are vendored from DeepSeek
// Harness (see ../vendor/dsh-zstd.ts) and decode each complete frame,
// tolerating a torn final frame (the durable backend repairs such a tail on its
// own load, so the trailing bytes carry no committed events).
//
// INCREMENTAL INDEXING. Unlike codex, dsh's append-only contiguous-seq log has
// no dedup that forces whole-file knowledge, so this adapter is incremental:
// committed frames are immutable and only appended (crash repair truncates a
// torn tail, never rewrites committed frames), so the cursor records how many
// complete frames are indexed and a refresh decodes and re-emits ONLY the new
// frames' events (countMode 'delta'; persist accumulates message_count). If the
// file shrank below the cursor (a repair truncated committed frames), the
// adapter falls back to a full reparse (countMode 'total'). Cross-event linkage
// needs no in-run state because message identity is deterministic from the
// event's own fields: every `assistant/message`, `tool/call`, and
// `tool/result` for one step carries the same `{turn, step}` as the assistant
// message that ordered the calls, so a tool result can compute the uuid of its
// tool_use anchor from its own `(turn, step)`.
//
// Subagents: a session whose header carries `parentSession` is a subagent
// transcript. Following the codex model, subagent messages fold into the ROOT
// parent session as sidechain messages (agent_id = the subagent's own id,
// is_sidechain = 1), and the `subagents` table records the delegation. The
// parent session contributes parent_tool_use_id (detected from the `subagent`
// tool result text `started subagent <id>`); the child session contributes
// agent_type/description/duration (from its `subagent/descriptor` and log
// stats). Both contributions share one (agent_id, session_id) key and persist
// merges them column-wise. Subagent total tokens are NOT stored: the shared
// query layer derives them from the sidechain messages' input/output usage.
//
// Packed chunk rows (`text-chunks` / `reasoning-chunks` / `tool-call-chunks`)
// are decoded to their exact member events by the vendored codec
// (../vendor/dsh-chunk-rows.ts). The parse loop does not project stream deltas
// into messages — every step also persists a final `assistant/message` carrying
// the assembled content — so expanded chunk events are skipped, but the decoder
// is exercised here and available to raw()/future reconstruction.
//
// Message identities are deterministic from the log content (stable across
// full and incremental parses): user messages use `deepseek:<id>:u<data.id>`,
// assistant messages use `deepseek:<id>:t<turn>:s<step>:<kind>`.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, sep } from 'node:path';

import { filePath, projectSlugFromPath, sourceInventoryIssue, trunc, truncJson } from '../parsing.ts';
import { createZstdFrameDecoder, scanZstdFrames } from '../vendor/dsh-zstd.ts';
import { decodeStorageRecord } from '../vendor/dsh-chunk-rows.ts';

import type {
  Cursor,
  DiscoverContext,
  IndexUnit,
  MessageRecord,
  ProviderAdapter,
  RawLookup,
  RawRecord,
  TranscriptRecord,
} from './types.ts';

export const name = 'deepseek';
const DEEPSEEK_CANONICAL_TRANSCRIPT_MARKER = '__deepseek_canonical_transcript_v1__';

const SESSION_FILENAMES = ['.jsonl.zstd', '.jsonl'];
const SUBAGENT_RESULT_RE = /started\s+subagent\s+(\S+)/;

interface DshHeader {
  id?: unknown;
  createdAt?: unknown;
  cwd?: unknown;
  parentSession?: unknown;
  origin?: unknown;
  delegationDepth?: unknown;
}

interface SessionFile {
  path: string;
  projectDir: string;
  sessionDir: string;
}

interface LogRecord {
  seq: number;
  type: string;
  time: number | null;
  data: Record<string, unknown>;
}

function dshDbId(rawId: string): string {
  return `deepseek:${rawId}`;
}

function assistantMessageUuid(rawSessionId: string, turn: unknown, step: unknown, kind: 'reasoning' | 'text' | 'tool_use'): string {
  return `deepseek:${rawSessionId}:t${turn}:s${step}:${kind}`;
}

function toolUseUuid(rawSessionId: string, turn: unknown, step: unknown): string {
  return assistantMessageUuid(rawSessionId, turn, step, 'tool_use');
}

function userMessageUuid(rawSessionId: string, nativeId: unknown, seq: number): string {
  return `deepseek:${rawSessionId}:u${typeof nativeId === 'string' && nativeId.length > 0 ? nativeId : seq}`;
}

function callId(rawSessionId: string, nativeCallId: string): string {
  return `deepseek:${rawSessionId}:${nativeCallId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// ---- log reading ----

/** Decode complete frames [fromFrame, frames.length) into plaintext. */
function decodeFrames(buffer: Buffer, frames: Array<{ start: number; end: number }>, fromFrame: number): string {
  if (fromFrame >= frames.length) return '';
  const tailStart = frames[fromFrame].start;
  const tailSource = buffer.subarray(tailStart);
  const tailFrames = frames.slice(fromFrame).map((frame) => ({ start: frame.start - tailStart, end: frame.end - tailStart }));
  const decoder = createZstdFrameDecoder();
  let out = '';
  try {
    for (const decoded of decoder.decode(tailSource, tailFrames)) {
      out += decoded.toString('utf8');
    }
  } finally {
    decoder.close();
  }
  return out;
}

/**
 * Resolve the events this run must process and the mode to emit them in.
 * Committed frames are immutable and only appended, so the cursor's frame count
 * delimits exactly the new events; a file that shrank below the cursor (a
 * repair truncated committed frames) forces a full reparse. Returns a null
 * window when no new committed events exist.
 */
function incrementalWindow(path: string, cursor: Cursor): { window: { text: string } | null; fullReparse: boolean; mtime: number; totalCount: number } {
  const mtime = statSync(path).mtimeMs;
  const full = cursor === null;
  if (path.endsWith('.jsonl.zstd')) {
    const buffer = readFileSync(path);
    const { frames } = scanZstdFrames(buffer);
    const totalCount = frames.length;
    const cursorCount = full ? 0 : (Number(cursor.split(':')[1]) || 0);
    const fullReparse = full || totalCount < cursorCount;
    const fromFrame = fullReparse ? 0 : cursorCount;
    if (!fullReparse && totalCount === cursorCount) return { window: null, fullReparse, mtime, totalCount };
    return { window: { text: decodeFrames(buffer, frames, fromFrame) }, fullReparse, mtime, totalCount };
  }
  // Plaintext logs have no frames; the cursor is the processed line count.
  const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim().length > 0);
  const totalCount = lines.length;
  const cursorCount = full ? 0 : (Number(cursor.split(':')[1]) || 0);
  const fullReparse = full || totalCount < cursorCount;
  const fromLine = fullReparse ? 0 : cursorCount;
  if (!fullReparse && totalCount === cursorCount) return { window: null, fullReparse, mtime, totalCount };
  return { window: { text: lines.slice(fromLine).join('\n') }, fullReparse, mtime, totalCount };
}

function firstNonEmptyLine(text: string): string | null {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/** Read just the immutable header frame (or the first line for plaintext). */
function readDshHeader(path: string): DshHeader | null {
  try {
    let text: string;
    if (path.endsWith('.jsonl.zstd')) {
      const buffer = readFileSync(path);
      const { frames } = scanZstdFrames(buffer);
      if (frames.length === 0) return null;
      const decoder = createZstdFrameDecoder();
      try {
        const first = decoder.decode(buffer, [frames[0]]).next();
        text = first.done ? '' : (first.value as Buffer).toString('utf8');
      } finally {
        decoder.close();
      }
    } else {
      text = readFileSync(path, 'utf8');
    }
    const line = firstNonEmptyLine(text);
    if (line === null) return null;
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function readLogRecords(plaintext: string): LogRecord[] {
  const records: LogRecord[] = [];
  for (const line of plaintext.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(value) || typeof value.type !== 'string') continue;
    // Expand packed chunk rows so the event stream is faithful; parse skips
    // the reconstructed assistant/chunk deltas (final messages carry content).
    for (const event of decodeStorageRecord(value)) {
      records.push({
        seq: event.seq,
        type: event.type,
        time: typeof event.time === 'number' ? event.time : null,
        data: isRecord(event.data) ? event.data : {},
      });
    }
  }
  return records;
}

// ---- content helpers ----

function joinPartText(content: unknown, partType: string): string | null {
  if (!Array.isArray(content)) return null;
  const parts = content
    .filter(part => isRecord(part) && part.type === partType && typeof part.text === 'string')
    .map(part => (part as { text: string }).text);
  return parts.length > 0 ? parts.join('\n') : null;
}

function parseToolArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function toolResultContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    if (block.type === 'tool-result' && Array.isArray(block.content)) {
      parts.push(toolResultContent(block.content));
    }
  }
  return parts.join('\n');
}

function toolResultIsError(data: Record<string, unknown>, content: unknown): 0 | 1 {
  if (data.error !== undefined) return 1;
  if (!Array.isArray(content)) return 0;
  return content.some(block => isRecord(block) && block.isError === true) ? 1 : 0;
}

function totalInputTokens(usage: unknown): number | null {
  if (!isRecord(usage)) return null;
  const fields = ['inputTokens', 'cacheReadTokens'];
  let seen = false;
  let total = 0;
  for (const field of fields) {
    const value = usage[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    seen = true;
    total += value;
  }
  return seen ? total : null;
}

function outputTokens(usage: unknown): number | null {
  if (!isRecord(usage)) return null;
  const value = usage.outputTokens;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// ---- discovery ----

function collectSessionFiles(sessionsDir: string, reportIssue: ((issue: { path: string; error: string }) => void) | undefined): SessionFile[] {
  const result: SessionFile[] = [];
  if (!existsSync(sessionsDir)) return result;
  let projects;
  try {
    projects = readdirSync(sessionsDir, { withFileTypes: true });
  } catch (error) {
    reportIssue?.(sourceInventoryIssue(sessionsDir, error));
    return result;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = join(sessionsDir, project.name);
    let sessions;
    try {
      sessions = readdirSync(projectDir, { withFileTypes: true });
    } catch (error) {
      reportIssue?.(sourceInventoryIssue(projectDir, error));
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const sessionDir = join(projectDir, session.name);
      for (const suffix of SESSION_FILENAMES) {
        const path = join(sessionDir, `session${suffix}`);
        if (existsSync(path)) {
          result.push({ path, projectDir: project.name, sessionDir });
          break;
        }
      }
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

function findSessionFile(rootDir: string, rawSessionId: string): string | null {
  const files = collectSessionFiles(rootDir, undefined);
  for (const file of files) {
    if (file.sessionDir.endsWith(sep + rawSessionId)) return file.path;
    const header = readDshHeader(file.path);
    if (header?.id === rawSessionId) return file.path;
  }
  return null;
}

function changedSessionFiles(sessionsDir: string, changedPaths: string[]): Set<string> {
  const result = new Set<string>();
  for (const changedPath of changedPaths) {
    const absolute = isAbsolute(changedPath)
      ? normalize(changedPath)
      : normalize(join(sessionsDir, changedPath));
    for (const suffix of SESSION_FILENAMES) {
      if (absolute.endsWith(suffix)) result.add(absolute);
    }
  }
  return result;
}

function resolveRootSessionId(rawId: string, header: DshHeader, headersByRawId: Map<string, DshHeader>): string {
  let root = rawId;
  const seen = new Set<string>();
  let current: DshHeader | undefined = header;
  while (
    current !== undefined
    && typeof current.parentSession === 'string'
    && current.parentSession.length > 0
    && !seen.has(current.parentSession)
  ) {
    seen.add(current.parentSession);
    root = current.parentSession;
    current = headersByRawId.get(root);
  }
  return root;
}

function discoverAt(rootDir: string, ctx: DiscoverContext): IndexUnit[] {
  const sessionsDir = rootDir;
  if (!existsSync(sessionsDir) && (ctx.indexedSessions?.().length ?? 0) > 0) {
    ctx.reportIncompleteInventory?.({ path: sessionsDir, error: 'Source folder is unavailable' });
  }
  const files = collectSessionFiles(sessionsDir, ctx.reportIncompleteInventory);
  const changedFiles = ctx.changedPaths === undefined
    ? null
    : changedSessionFiles(sessionsDir, ctx.changedPaths);

  const headersByRawId = new Map<string, DshHeader>();
  for (const file of files) {
    const header = readDshHeader(file.path);
    const rawId = header && typeof header.id === 'string' ? header.id : file.sessionDir.split(sep).pop() ?? '';
    if (rawId) headersByRawId.set(rawId, header ?? {});
  }

  const units: IndexUnit[] = [];
  for (const file of files) {
    if (changedFiles !== null && !changedFiles.has(file.path)) continue;
    const mtime = statSync(file.path).mtimeMs;
    const cursor = ctx.lastCursor(file.path);
    if (changedFiles === null && cursor !== null && Number(cursor.split(':')[0]) >= mtime) continue;
    const header = readDshHeader(file.path);
    if (header === null) continue;
    const rawId = typeof header.id === 'string' ? header.id : file.sessionDir.split(sep).pop() ?? '';
    if (!rawId) continue;
    const isSubagent = typeof header.parentSession === 'string' && header.parentSession.length > 0;
    const rootRawId = resolveRootSessionId(rawId, header, headersByRawId);
    units.push({
      key: file.path,
      sessionId: dshDbId(rootRawId),
      ...(isSubagent ? { agentId: dshDbId(rawId), isSubagent: true } : {}),
      project: projectSlugFromPath(typeof header.cwd === 'string' ? header.cwd : null) ?? undefined,
      meta: { kind: 'session', rawSessionId: rawId, header, isSubagent },
    });
  }
  return units;
}

// ---- parse ----

function* parse(unit: IndexUnit, cursor: Cursor): Generator<TranscriptRecord, Cursor> {
  const meta = unit.meta as { rawSessionId: string; header: DshHeader; isSubagent: boolean };
  const rawSessionId = meta.rawSessionId;
  const header = meta.header;
  const sessionId = unit.sessionId;
  const agentId = unit.agentId ?? null;
  const isSubagent = meta.isSubagent;
  const cwd = typeof header.cwd === 'string' ? header.cwd : null;

  const { window, fullReparse, mtime, totalCount } = incrementalWindow(unit.key, cursor);
  if (window === null) return `${mtime}:${totalCount}`;
  const records = readLogRecords(window.text);

  const recordsOut: TranscriptRecord[] = [];
  let title: string | null = null;
  const startedAt = typeof header.createdAt === 'number' ? new Date(header.createdAt).toISOString() : null;
  let endedAt: string | null = null;
  let mainMessageCount = 0;
  let lastMessageUuid: string | null = null;
  let currentModel: string | null = null;

  const updateEndedAt = (timestamp: string | null): void => {
    if (timestamp !== null && (endedAt === null || timestamp > endedAt)) endedAt = timestamp;
  };

  const pushMessage = (record: MessageRecord): void => {
    recordsOut.push(record);
    lastMessageUuid = record.uuid;
    if (agentId === null && record.visibility === 'visible') mainMessageCount++;
    updateEndedAt(record.timestamp);
  };

  const timestampOf = (record: LogRecord): string | null => (
    typeof record.time === 'number' && Number.isFinite(record.time)
      ? new Date(record.time).toISOString()
      : null
  );

  let subagentDescriptor: Record<string, unknown> | null = null;

  for (const record of records) {
    const timestamp = timestampOf(record);
    updateEndedAt(timestamp);
    switch (record.type) {
      case 'request/header': {
        const config = isRecord(record.data.header) ? record.data.header.config : undefined;
        if (isRecord(config) && typeof config.model === 'string') currentModel = config.model;
        break;
      }
      case 'subagent/descriptor': {
        if (isRecord(record.data)) subagentDescriptor = record.data;
        break;
      }
      case 'session/title': {
        const candidate = record.data.title;
        if (typeof candidate === 'string' && candidate.length > 0) title = candidate;
        break;
      }
      case 'user/message': {
        const content = record.data.content;
        const text = joinPartText(content, 'text');
        const sourceKind = isRecord(record.data.source) ? record.data.source.kind : undefined;
        const isMeta = sourceKind !== 'user' ? 1 : 0;
        const uuid = userMessageUuid(rawSessionId, record.data.id, record.seq);
        pushMessage({
          kind: 'message', uuid, session_id: sessionId, type: 'user', parent_uuid: lastMessageUuid,
          timestamp, role: 'user', text: trunc(text), content_type: 'text', is_meta: isMeta,
          visibility: 'visible', model: null, is_sidechain: isSubagent ? 1 : 0, agent_id: agentId,
          input_tokens: null, output_tokens: null, cwd, skill: null, source: 'deepseek',
        });
        break;
      }
      case 'assistant/message': {
        const message = isRecord(record.data.message) ? record.data.message : {};
        const content = message.content;
        const turn = record.data.turn;
        const step = record.data.step;
        const reasoningText = joinPartText(content, 'reasoning');
        const visibleText = joinPartText(content, 'text');
        const hasToolCalls = Array.isArray(content)
          && content.some(part => isRecord(part) && part.type === 'tool-call' && typeof part.id === 'string');
        const usage = record.data.usage;
        const inTokens = totalInputTokens(usage);
        const outTokens = outputTokens(usage);
        const model = isRecord(message.source) && typeof message.source.model === 'string'
          ? message.source.model
          : currentModel;

        const reasoningUuid = reasoningText !== null ? assistantMessageUuid(rawSessionId, turn, step, 'reasoning') : null;
        const textUuid = visibleText !== null ? assistantMessageUuid(rawSessionId, turn, step, 'text') : null;
        const toolUseUuid = hasToolCalls ? assistantMessageUuid(rawSessionId, turn, step, 'tool_use') : null;
        // Usage lands on the primary (visible) message for this step: the text
        // message when present, else the tool_use anchor, else the thinking one.
        const tokensUuid = textUuid ?? toolUseUuid ?? reasoningUuid;
        const tokensFor = (uuid: string | null) => (uuid !== null && uuid === tokensUuid ? inTokens : null);
        const tokensOutFor = (uuid: string | null) => (uuid !== null && uuid === tokensUuid ? outTokens : null);

        const base = {
          session_id: sessionId, type: 'assistant', timestamp, role: 'assistant', is_meta: 0,
          visibility: 'visible', model, is_sidechain: isSubagent ? 1 : 0, agent_id: agentId,
          cwd, skill: null, source: 'deepseek',
        } as const;
        if (reasoningUuid !== null) {
          pushMessage({
            kind: 'message', uuid: reasoningUuid, parent_uuid: lastMessageUuid, text: trunc(reasoningText),
            content_type: 'thinking', input_tokens: tokensFor(reasoningUuid), output_tokens: tokensOutFor(reasoningUuid), ...base,
          });
        }
        if (textUuid !== null) {
          pushMessage({
            kind: 'message', uuid: textUuid, parent_uuid: lastMessageUuid, text: trunc(visibleText),
            content_type: 'text', input_tokens: tokensFor(textUuid), output_tokens: tokensOutFor(textUuid), ...base,
          });
        }
        if (toolUseUuid !== null) {
          pushMessage({
            kind: 'message', uuid: toolUseUuid, parent_uuid: lastMessageUuid, text: null,
            content_type: 'tool_use', input_tokens: tokensFor(toolUseUuid), output_tokens: tokensOutFor(toolUseUuid), ...base,
          });
        }
        // tool_call records come from the durable tool/call events, not from the
        // content parts (a step's tool/call may land in a later frame).
        break;
      }
      // The durable tool/call event carries the call's identity and the nonce
      // that identifies the invoking session (ADR-0008). Its message anchor is
      // the deterministic tool_use uuid for the same (turn, step) — no state.
      case 'tool/call': {
        const data = record.data;
        const nativeCallId = typeof data.callId === 'string' ? data.callId : null;
        if (nativeCallId === null) break;
        const toolName = typeof data.name === 'string' ? data.name : 'tool';
        const args = parseToolArguments(data.arguments);
        recordsOut.push({
          kind: 'tool_call', id: callId(rawSessionId, nativeCallId),
          message_uuid: toolUseUuid(rawSessionId, data.turn, data.step), session_id: sessionId,
          name: toolName, presentation: toolName === 'Skill' ? 'skill' : 'default',
          input_json: truncJson(args) ?? '{}', file_path: filePath(toolName, isRecord(args) ? args : null),
        });
        break;
      }
      case 'tool/result': {
        const message = isRecord(record.data.message) ? record.data.message : {};
        const source = isRecord(message.source) ? message.source : {};
        if (typeof source.callId !== 'string') break;
        const toolId = callId(rawSessionId, source.callId);
        const content = toolResultContent(message.content);
        recordsOut.push({
          kind: 'tool_result', tool_use_id: toolId,
          message_uuid: toolUseUuid(rawSessionId, record.data.turn, record.data.step),
          session_id: sessionId, content: trunc(content), file_path: null,
          is_error: toolResultIsError(record.data, message.content),
        });
        // Subagent spawns are self-contained in their result text, so the link
        // survives incremental indexing (the spawn tool/call may be in a prior
        // frame).
        const match = SUBAGENT_RESULT_RE.exec(content);
        if (match !== null && match[1]) {
          recordsOut.push({
            kind: 'subagent', agent_id: dshDbId(match[1]), session_id: sessionId,
            parent_tool_use_id: toolId,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  if (isSubagent) {
    const descriptor = subagentDescriptor ?? {};
    const agentType = typeof descriptor.agentProvider === 'string'
      ? descriptor.agentProvider
      : typeof descriptor.agentModel === 'string'
        ? descriptor.agentModel
        : null;
    const description = typeof descriptor.label === 'string' ? descriptor.label : null;
    const startedMs = typeof header.createdAt === 'number' ? header.createdAt : null;
    const endedMs = endedAt !== null ? new Date(endedAt).getTime() : null;
    recordsOut.push({
      kind: 'subagent', agent_id: agentId as string, session_id: sessionId,
      agent_type: agentType, description,
      duration_ms: startedMs !== null && endedMs !== null ? Math.max(0, endedMs - startedMs) : null,
      // total_tokens is derived at query time from the sidechain messages.
    });
  } else {
    recordsOut.push({
      kind: 'session', id: sessionId, title, project: unit.project ?? null,
      started_at: startedAt, ended_at: endedAt, git_branch: null, version: null,
      message_count: mainMessageCount, countMode: fullReparse ? 'total' : 'delta',
      jsonl_path: unit.key, source: 'deepseek',
    });
  }

  yield* recordsOut;
  return `${mtime}:${totalCount}`;
}

// ---- raw ----

function rawDeepseek(rootDir: string, input: RawLookup): RawRecord | null {
  const uuid = input.messageUuid;
  let rawSessionId: string | null = null;
  let finder: ((value: Record<string, unknown>) => boolean) | null = null;
  const userMatch = /^deepseek:([^:]+):u(.+)$/.exec(uuid);
  const assistantMatch = /^deepseek:([^:]+):t(\d+):s(\d+):(reasoning|text|tool_use)$/.exec(uuid);
  if (userMatch !== null) {
    rawSessionId = userMatch[1];
    const captured = userMatch[2];
    finder = (value) => (
      value.type === 'user/message'
      && isRecord(value.data)
      && (value.data.id === captured || value.seq === Number(captured))
    );
  } else if (assistantMatch !== null) {
    rawSessionId = assistantMatch[1];
    const turn = Number(assistantMatch[2]);
    const step = Number(assistantMatch[3]);
    finder = (value) => (
      value.type === 'assistant/message'
      && isRecord(value.data)
      && value.data.turn === turn
      && value.data.step === step
    );
  }
  if (rawSessionId === null || finder === null) return null;
  if (input.agentId !== null && typeof input.agentId === 'string') {
    const agentMatch = /^deepseek:(.+)$/.exec(input.agentId);
    if (agentMatch !== null && agentMatch[1]) rawSessionId = agentMatch[1];
  }
  const path = typeof input.session?.jsonl_path === 'string' && input.agentId === null
    ? input.session.jsonl_path
    : findSessionFile(rootDir, rawSessionId);
  if (path === null || !existsSync(path)) return null;

  let found: string | null = null;
  let text: string;
  if (path.endsWith('.jsonl.zstd')) {
    const buffer = readFileSync(path);
    const { frames } = scanZstdFrames(buffer);
    text = decodeFrames(buffer, frames, 0);
  } else {
    text = readFileSync(path, 'utf8');
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (isRecord(value) && finder(value)) {
      found = line;
      break;
    }
  }
  if (found === null) return null;

  let messageText: string | null = null;
  try {
    const value: unknown = JSON.parse(found);
    if (isRecord(value)) {
      const data = isRecord(value.data) ? value.data : {};
      if (value.type === 'user/message') {
        messageText = joinPartText(data.content, 'text');
      } else if (value.type === 'assistant/message') {
        const message = isRecord(data.message) ? data.message : {};
        messageText = joinPartText(message.content, 'text');
      }
    }
  } catch {
    /* malformed source line */
  }
  return { text: found, totalLength: found.length, offset: 0, limit: found.length, hasMore: false, messageText };
}

export function createDeepseekProvider({ rootDir = join(homedir(), '.dsh', 'sessions') }: { rootDir?: string } = {}): ProviderAdapter {
  return {
    name,
    descriptor: {
      id: name,
      name: 'DeepSeek Harness',
      vendor: 'DeepSeek',
      defaultRoot: rootDir,
      color: '#4d6bfe',
    },
    indexVersionMarker: DEEPSEEK_CANONICAL_TRANSCRIPT_MARKER,
    watchTargets: (configuredRoot) => [{ kind: 'tree', path: configuredRoot }],
    discover: (ctx) => discoverAt(rootDir, ctx),
    parse,
    raw: (input) => rawDeepseek(rootDir, input),
  };
}

export const deepseekProvider = createDeepseekProvider();

// Re-export the vendored chunk-row decoder under the name tests and callers use.
export { decodeStorageRecord as decodeChunkRow } from '../vendor/dsh-chunk-rows.ts';
