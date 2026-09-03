// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Codex provider adapter in Core (see docs/adr/0001).
//
// Pure: discovers Codex rollout files and parses one into a record stream. It
// never touches the Obelisk database. A prefix-hash checkpoint lets append-only
// growth parse just the new bytes; replacements, truncations, legacy cursors,
// and unterminated tails fall back to a complete snapshot. The whole-file scan
// remains necessary for event_msg ↔ response_item dedup, but it retains only
// bounded checkpoint state instead of every parsed JSON object.

import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, relative } from 'node:path';

import {
  trunc, truncJson, readLines,
  discoverCodexJsonlFiles, normalizeObservedCwd, projectSlugFromPath,
  codexRawId, codexDbId, codexCallId, codexLineUuid, codexParentThreadId,
  codexIsGuardianThread, codexAgentNickname, codexAgentRole, codexUsage,
  codexEventText, codexMessagePayloadText, codexVisibleMessageKey,
  codexToolInput, codexToolOutput,
  extractMessageIsMeta, isSkillInstructions,
  readCodexGuardianThreadInfo,
} from '../parsing.ts';

import type {
  Cursor,
  DiscoverContext,
  TranscriptRecord,
  IndexUnit,
  MessageRecord,
  ProviderAdapter,
  RawLookup,
  RawRecord,
} from './types.ts';

export const name = 'codex';
const CODEX_CANONICAL_TRANSCRIPT_MARKER = '__codex_canonical_transcript_v3__';
const CODEX_SESSIONS_DIR = 'sessions';
const CODEX_ARCHIVED_SESSIONS_DIR = 'archived_sessions';

const HIDDEN_CONTEXT_ENVELOPE_RE = /^\s*<(environment_context|codex_internal_context)\b[^>]*>[\s\S]*<\/\1>\s*$/;
const CODEX_SCAN_HINT_RE = /"(?:session_meta|event_msg|function_call|custom_tool_call|tool_search_call|web_search_call|codex-auto-review)"/;

function messageVisibility(role: string, text: string | null): 'visible' | 'hidden' {
  return role === 'user' && typeof text === 'string' && HIDDEN_CONTEXT_ENVELOPE_RE.test(text)
    ? 'hidden'
    : 'visible';
}

function codexTranscriptDirs(rootDir: string): string[] {
  return [
    join(rootDir, CODEX_SESSIONS_DIR),
    join(rootDir, CODEX_ARCHIVED_SESSIONS_DIR),
  ];
}

// Cursor format: `${mtime}:${lines}:${size}:${ctimeMs}:${ino}`. The
// mtime+ctime+size+inode signature (CONTRIBUTING: cursors must detect
// same-millisecond rewrites) lets a same-mtime tail completion or a
// same-mtime replacement back into discovery. Unlike claude's legacy gate
// (#102), two-part cursors here fail closed: codex never shipped a five-part
// cursor before v3, so every legacy cursor can only prove "mtime not older",
// never "unchanged" — it re-parses once and upgrades to the full signature.
function codexCursorSignatureDiffers(cursor: string, filePath: string): boolean {
  const stat = statSync(filePath);
  const parts = cursor.split(':');
  if (parts.length < 5) return true;
  return Number(parts[0]) !== stat.mtimeMs
    || Number(parts[2]) !== stat.size
    || Number(parts[3]) !== stat.ctimeMs
    || Number(parts[4]) !== stat.ino;
}

function discoverAt(rootDir: string, ctx: DiscoverContext): IndexUnit[] {
  const [sessionsDir, archivedSessionsDir] = codexTranscriptDirs(rootDir);
  if (!existsSync(sessionsDir) && (ctx.indexedSessions?.().length ?? 0) > 0) {
    ctx.reportIncompleteInventory?.({ path: sessionsDir, error: 'Source folder is unavailable' });
  }
  const sessionIndexPath = normalize(join(rootDir, 'session_index.jsonl'));
  const sessionIndex = new Map<string, { title: string; updatedAt: string | null }>();
  if (existsSync(sessionIndexPath)) {
    readLines(sessionIndexPath, (line: string) => {
      try {
        const item = JSON.parse(line);
        if (item?.id && item?.thread_name) {
          sessionIndex.set(codexRawId(item.id) as string, {
            title: item.thread_name,
            updatedAt: item.updated_at || null,
          });
        }
      } catch { /* malformed session-index entry */ }
    });
  }
  const changedFiles = new Set<string>();
  let sessionIndexChanged = false;
  for (const changedPath of ctx.changedPaths ?? []) {
    const rootRelative = isAbsolute(changedPath)
      ? normalize(changedPath)
      : normalize(join(rootDir, changedPath));
    if (rootRelative === sessionIndexPath) sessionIndexChanged = true;
    for (const transcriptDir of [sessionsDir, archivedSessionsDir]) {
      const absolute = isAbsolute(changedPath)
        ? normalize(changedPath)
        : normalize(join(transcriptDir, changedPath));
      const inside = relative(transcriptDir, absolute);
      if (!inside || inside.startsWith('..') || isAbsolute(inside)) continue;
      if (absolute.toLowerCase().endsWith('.jsonl')) changedFiles.add(absolute);
    }
  }
  return codexTranscriptDirs(rootDir).flatMap((transcriptDir) => (
    discoverCodexJsonlFiles(transcriptDir, ctx.reportIncompleteInventory).flatMap((file) => {
      const fileChanged = changedFiles.has(normalize(file.path));
      if (ctx.changedPaths !== undefined && !sessionIndexChanged && !fileChanged) return [];
      const cursor = ctx.lastCursor(file.path);
      // Skip unchanged files before paying for guardian detection: guardian
      // status is content-derived, so a file whose cursor signature still
      // matches cannot have changed status. Pre-v3 databases may still hold
      // guardian session rows; the v3 marker bump forces one full replay that
      // retracts them.
      if (!sessionIndexChanged && !fileChanged && cursor !== null && !codexCursorSignatureDiffers(cursor, file.path)) {
        return [];
      }
      const guardian = readCodexGuardianThreadInfo(file.path);
      let meta: any = null;
      readLines(file.path, (line: string) => {
        try {
          const record = JSON.parse(line);
          if (record?.type === 'session_meta' && record.payload?.id) {
            meta = record.payload;
            return false;
          }
        } catch { /* malformed source line */ }
      });
      const rawId = meta ? codexRawId(meta.id) : null;
      const parentId = meta ? codexParentThreadId(meta) : null;
      const indexed = rawId ? sessionIndex.get(rawId) : undefined;
      return [{
        key: file.path,
        sessionId: guardian === null ? codexDbId(parentId || rawId) ?? '' : '',
        meta: {
          source: 'codex',
          guardian: guardian !== null,
          indexedTitle: indexed?.title,
          indexedUpdatedAt: indexed?.updatedAt,
        },
      }];
    })
  ));
}

export function discover(ctx: DiscoverContext): IndexUnit[] {
  return discoverAt(join(homedir(), '.codex'), ctx);
}

const CODEX_CURSOR_STATE_VERSION = 4;
const CODEX_FINGERPRINT_CHUNK_BYTES = 8 * 1024 * 1024;
const CODEX_DEDUP_BLOOM_BYTES = 32 * 1024;
const CODEX_DEDUP_BLOOM_PROBES = 6;

interface CodexCursorState {
  v: number;
  threadRawId: string;
  meta: Record<string, any>;
  chunkHashes: string[];
  eventMessageBloom: string;
  responseMessageBloom: string;
  openCallMessageUuids: Record<string, string>;
  terminated: boolean;
  currentCwd: string | null;
  currentModel: string | null;
  lastMessageUuid: string | null;
  lastTextAssistant: MessageRecord | null;
  startedAt: string | null;
  endedAt: string | null;
  gitBranch: string | null;
  version: string | null;
  threadTitle: string | null;
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

interface DecodedCodexCursor extends CodexCursorState {
  lineCount: number;
  size: number;
  inode: number;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function decodeBloom(value: unknown): Buffer | null {
  if (typeof value !== 'string') return null;
  try {
    const filter = Buffer.from(value, 'base64url');
    return filter.length === CODEX_DEDUP_BLOOM_BYTES ? filter : null;
  } catch {
    return null;
  }
}

function emptyBloom(): Buffer {
  return Buffer.alloc(CODEX_DEDUP_BLOOM_BYTES);
}

function bloomAdd(filter: Buffer, key: string): void {
  const digest = Buffer.from(key, 'base64url');
  const first = digest.readUInt32LE(0);
  const step = (digest.readUInt32LE(4) | 1) >>> 0;
  const bits = filter.length * 8;
  for (let probe = 0; probe < CODEX_DEDUP_BLOOM_PROBES; probe++) {
    const bit = ((first + Math.imul(probe, step)) >>> 0) % bits;
    filter[bit >>> 3]! |= 1 << (bit & 7);
  }
}

function bloomMightContain(filter: Buffer, key: string): boolean {
  const digest = Buffer.from(key, 'base64url');
  const first = digest.readUInt32LE(0);
  const step = (digest.readUInt32LE(4) | 1) >>> 0;
  const bits = filter.length * 8;
  for (let probe = 0; probe < CODEX_DEDUP_BLOOM_PROBES; probe++) {
    const bit = ((first + Math.imul(probe, step)) >>> 0) % bits;
    if ((filter[bit >>> 3]! & (1 << (bit & 7))) === 0) return false;
  }
  return true;
}

function isCheckpointMessage(value: unknown): value is MessageRecord {
  if (!isRecord(value)) return false;
  return value.kind === 'message'
    && typeof value.uuid === 'string'
    && typeof value.session_id === 'string'
    && typeof value.type === 'string'
    && nullableString(value.parent_uuid)
    && nullableString(value.timestamp)
    && nullableString(value.role)
    && nullableString(value.text)
    && nullableString(value.content_type)
    && (value.is_meta === 0 || value.is_meta === 1)
    && ['visible', 'inactive', 'hidden'].includes(value.visibility)
    && nullableString(value.model)
    && (value.is_sidechain === 0 || value.is_sidechain === 1)
    && nullableString(value.agent_id)
    && (value.input_tokens === null || typeof value.input_tokens === 'number')
    && (value.output_tokens === null || typeof value.output_tokens === 'number')
    && nullableString(value.cwd)
    && nullableString(value.skill)
    && typeof value.source === 'string';
}

function decodeCodexCursor(cursor: Cursor): DecodedCodexCursor | null {
  if (cursor === null) return null;
  const parts = cursor.split(':');
  if (parts.length < 6) return null;
  const lineCount = Number(parts[1]);
  const size = Number(parts[2]);
  const inode = Number(parts[4]);
  if (!Number.isSafeInteger(lineCount) || !Number.isSafeInteger(size) || !Number.isFinite(inode)) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(parts[5]!, 'base64url').toString('utf8'));
    if (!isRecord(value)
      || value.v !== CODEX_CURSOR_STATE_VERSION
      || typeof value.threadRawId !== 'string'
      || !isRecord(value.meta)
      || !Array.isArray(value.chunkHashes)
      || !value.chunkHashes.every(item => typeof item === 'string')
      || decodeBloom(value.eventMessageBloom) === null
      || decodeBloom(value.responseMessageBloom) === null
      || !isRecord(value.openCallMessageUuids)
      || !Object.values(value.openCallMessageUuids).every(item => typeof item === 'string')
      || typeof value.terminated !== 'boolean'
      || !nullableString(value.currentCwd)
      || !nullableString(value.currentModel)
      || !nullableString(value.lastMessageUuid)
      || (value.lastTextAssistant !== null && !isCheckpointMessage(value.lastTextAssistant))
      || !nullableString(value.startedAt)
      || !nullableString(value.endedAt)
      || !nullableString(value.gitBranch)
      || !nullableString(value.version)
      || !nullableString(value.threadTitle)
      || !Number.isSafeInteger(value.messageCount)
      || !Number.isFinite(value.totalInputTokens)
      || !Number.isFinite(value.totalOutputTokens)) {
      return null;
    }
    return { ...(value as unknown as CodexCursorState), lineCount, size, inode };
  } catch {
    return null;
  }
}

function encodeCodexCursor(
  stat: Stats,
  lineCount: number,
  state: CodexCursorState,
): string {
  const encoded = Buffer.from(JSON.stringify(state)).toString('base64url');
  return `${stat.mtimeMs}:${lineCount}:${stat.size}:${stat.ctimeMs}:${stat.ino}:${encoded}`;
}

function sameStat(a: Stats, b: Stats): boolean {
  return a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.size === b.size && a.ino === b.ino;
}

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('base64url');
}

function visibleMessageDigest(role: unknown, text: unknown): string {
  return sha256(codexVisibleMessageKey(role, text));
}

function fingerprintCodexFile(
  filePath: string,
  size: number,
  prior: DecodedCodexCursor | null,
): { chunkHashes: string[]; prefixMatches: boolean; bytesRead: number } {
  const fd = openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(CODEX_FINGERPRINT_CHUNK_BYTES);
  const chunkHashes: string[] = [];
  const priorChunks = prior === null ? 0 : Math.ceil(prior.size / CODEX_FINGERPRINT_CHUNK_BYTES);
  const completePriorChunks = prior === null ? 0 : Math.floor(prior.size / CODEX_FINGERPRINT_CHUNK_BYTES);
  const priorTailBytes = prior === null ? 0 : prior.size % CODEX_FINGERPRINT_CHUNK_BYTES;
  let prefixMatches = prior !== null && prior.size <= size && prior.chunkHashes.length === priorChunks;
  let position = 0;
  try {
    while (position < size) {
      const wanted = Math.min(buffer.length, size - position);
      let filled = 0;
      while (filled < wanted) {
        const count = readSync(fd, buffer, filled, wanted - filled, position + filled);
        if (count === 0) break;
        filled += count;
      }
      if (filled === 0) break;
      const index = chunkHashes.length;
      const bytes = buffer.subarray(0, filled);
      const digest = sha256(bytes);
      chunkHashes.push(digest);
      if (prior !== null && prefixMatches) {
        if (index < completePriorChunks) {
          prefixMatches = digest === prior.chunkHashes[index];
        } else if (index === completePriorChunks && priorTailBytes > 0) {
          prefixMatches = sha256(bytes.subarray(0, priorTailBytes)) === prior.chunkHashes[index];
        }
      }
      position += filled;
    }
  } finally {
    closeSync(fd);
  }
  return { chunkHashes, prefixMatches: prefixMatches && position === size, bytesRead: position };
}

export function* parse(unit: IndexUnit, _cursor: Cursor): Generator<TranscriptRecord, Cursor> {
  const stat = statSync(unit.key);
  const prior = decodeCodexCursor(_cursor);
  const fingerprint = fingerprintCodexFile(unit.key, stat.size, prior);
  const afterFingerprint = statSync(unit.key);
  if (fingerprint.bytesRead !== stat.size || !sameStat(stat, afterFingerprint)) return _cursor;
  const appendCandidate = prior !== null
    && prior.threadRawId === codexRawId(prior.meta.id)
    && prior.inode === stat.ino
    && prior.terminated
    && fingerprint.prefixMatches;
  const eventMessageKeys = new Set<string>();
  const appendedEventMessageKeys = new Set<string>();
  const appendedResponseMessageKeys = new Set<string>();
  let lineNum = appendCandidate ? prior.lineCount : 0;
  let terminated = appendCandidate ? prior.terminated : true;
  let metaRecord: { lineNum: number; obj: any } | null = !appendCandidate
    ? null
    : { lineNum: 1, obj: { timestamp: prior.startedAt, payload: prior.meta } };
  let sawAutoReviewModel = false;
  const scan = (start: number, collectAppendedResponses: boolean): void => {
    readLines(unit.key, (line: string, lineTerminated: boolean) => {
      lineNum++;
      terminated = lineTerminated;
      // Full snapshots can skip unrelated JSON during dedup/link discovery;
      // append tails are parsed once here so both sides of a boundary duplicate
      // are known before any records are emitted.
      const head = line.length > 1024 ? line.slice(0, 1024) : line;
      if (!collectAppendedResponses && !CODEX_SCAN_HINT_RE.test(head)) return;
      let obj: any;
      try { obj = JSON.parse(line); } catch { return; }
      if (metaRecord === null && obj?.type === 'session_meta' && obj.payload?.id) {
        metaRecord = { lineNum, obj };
      }
      sawAutoReviewModel ||= obj?.payload?.model === 'codex-auto-review'
        || obj?.model === 'codex-auto-review';
      const payload = obj?.payload || {};
      if (obj?.type === 'event_msg') {
        if (payload.type === 'user_message' || payload.type === 'agent_message') {
          const text = codexEventText(payload);
          if (text !== null) {
            const key = visibleMessageDigest(payload.type === 'user_message' ? 'user' : 'assistant', text);
            eventMessageKeys.add(key);
            if (collectAppendedResponses) appendedEventMessageKeys.add(key);
          }
        }
      } else if (collectAppendedResponses && obj?.type === 'response_item'
        && payload.type === 'message' && payload.role !== 'developer') {
        const text = codexMessagePayloadText(payload);
        if (text !== null) appendedResponseMessageKeys.add(visibleMessageDigest(payload.role || 'assistant', text));
      }
    }, { start });
  };
  scan(appendCandidate ? prior.size : 0, appendCandidate);
  const afterScan = statSync(unit.key);
  if (!sameStat(stat, afterScan)) return _cursor;
  const priorEventBloom = appendCandidate ? decodeBloom(prior.eventMessageBloom)! : emptyBloom();
  const priorResponseBloom = appendCandidate ? decodeBloom(prior.responseMessageBloom)! : emptyBloom();
  // Bloom filters have no false negatives. A possible cross-boundary duplicate
  // therefore falls back to the exact full replay; false positives cost time,
  // never rows. This keeps the cursor bounded without weakening deduplication.
  const possibleCrossBoundaryDuplicate = appendCandidate && (
    [...appendedEventMessageKeys].some(key => bloomMightContain(priorResponseBloom, key))
      || [...appendedResponseMessageKeys].some(key => bloomMightContain(priorEventBloom, key))
  );
  const fast = appendCandidate && !possibleCrossBoundaryDuplicate;
  if (appendCandidate && !fast) {
    eventMessageKeys.clear();
    lineNum = 0;
    terminated = true;
    metaRecord = null;
    sawAutoReviewModel = false;
    scan(0, false);
    if (!sameStat(stat, statSync(unit.key))) return _cursor;
  }
  const eventMessageBloom = fast ? priorEventBloom : emptyBloom();
  const responseMessageBloom = fast ? priorResponseBloom : emptyBloom();
  for (const key of eventMessageKeys) bloomAdd(eventMessageBloom, key);
  const previous = fast ? prior : null;
  const basicCursor = `${stat.mtimeMs}:${lineNum}:${stat.size}:${stat.ctimeMs}:${stat.ino}`;
  const capturedMeta = metaRecord as { lineNum: number; obj: any } | null;
  if (capturedMeta === null) return basicCursor;

  const meta = capturedMeta.obj.payload;
  const threadRawId = codexRawId(meta.id) as string;
  if (codexIsGuardianThread(meta, sawAutoReviewModel ? [{ lineNum: 0, obj: { model: 'codex-auto-review' } }] : [])) {
    yield { kind: 'delete-session', sessionId: codexDbId(threadRawId) as string };
    return basicCursor;
  }

  const parentRawId = codexParentThreadId(meta);
  const sessionId = codexDbId(parentRawId || threadRawId) as string;
  const agentId = (parentRawId ? codexDbId(threadRawId) : null) as string | null;
  const isSidechain: 0 | 1 = agentId ? 1 : 0;
  const project = projectSlugFromPath(normalizeObservedCwd(meta.cwd));
  const lineUuid = (n: number): string => codexLineUuid(threadRawId, n) as string;
  const callMessageUuids = new Map(Object.entries(previous?.openCallMessageUuids ?? {}));
  const openCallMessageUuids = new Map(callMessageUuids);

  const out: TranscriptRecord[] = [];
  if (_cursor !== null && !fast) out.push({ kind: 'delete-session', sessionId });
  const msgByUuid = new Map<string, MessageRecord>();
  const emittedMessageUuids = new Set<string>();
  const indexedMeta = unit.meta as { indexedTitle?: string; indexedUpdatedAt?: string | null } | undefined;
  const initialTimestamp = (meta.timestamp || capturedMeta.obj.timestamp || null) as string | null;
  const indexedUpdatedAt = indexedMeta?.indexedUpdatedAt ?? null;
  const sm = {
    started_at: previous?.startedAt ?? initialTimestamp,
    ended_at: previous?.endedAt ?? initialTimestamp,
    git_branch: previous?.gitBranch ?? (meta.git?.branch || null) as string | null,
    version: previous?.version ?? (meta.cli_version || null) as string | null,
    threadTitle: previous?.threadTitle ?? null,
    n: previous?.messageCount ?? 0,
    lastMessageUuid: previous?.lastMessageUuid ?? null,
    lastTextAssistantUuid: previous?.lastTextAssistant?.uuid ?? null,
    totalInputTokens: previous?.totalInputTokens ?? 0,
    totalOutputTokens: previous?.totalOutputTokens ?? 0,
  };
  if (indexedUpdatedAt && (!sm.ended_at || indexedUpdatedAt > sm.ended_at)) sm.ended_at = indexedUpdatedAt;

  let currentCwd = previous?.currentCwd ?? normalizeObservedCwd(meta.cwd);
  let currentModel = previous?.currentModel ?? null;
  let lastTextAssistant = previous?.lastTextAssistant === null || previous?.lastTextAssistant === undefined
    ? null
    : { ...previous.lastTextAssistant };
  if (lastTextAssistant !== null) msgByUuid.set(lastTextAssistant.uuid, lastTextAssistant);

  const updateBounds = (ts: string | null) => {
    if (!ts) return;
    if (!sm.started_at || ts < sm.started_at) sm.started_at = ts;
    if (!sm.ended_at || ts > sm.ended_at) sm.ended_at = ts;
  };

  const insertMessage = ({ uuid, type, role, text = null, contentType = 'text', timestamp, isMeta = 0 }: {
    uuid: string; type: string; role: string; text?: string | null; contentType?: string; timestamp: string | null; isMeta?: 0 | 1;
  }) => {
    const visibility = messageVisibility(role, text);
    const skillInstructions = role === 'user' && isSkillInstructions(text);
    const rec: MessageRecord = {
      kind: 'message', uuid, session_id: sessionId, type, parent_uuid: sm.lastMessageUuid,
      timestamp: timestamp || null, role, text: trunc(text),
      content_type: skillInstructions ? 'skill_instructions' : contentType,
      is_meta: visibility === 'hidden' || skillInstructions ? 1 : (isMeta || extractMessageIsMeta({}, text)), visibility,
      model: currentModel, is_sidechain: isSidechain, agent_id: agentId,
      input_tokens: null, output_tokens: null, cwd: currentCwd, skill: null, source: 'codex',
    };
    out.push(rec);
    emittedMessageUuids.add(uuid);
    msgByUuid.set(uuid, rec);
    sm.lastMessageUuid = uuid;
    if (!agentId && visibility === 'visible') sm.n++;
    if (type === 'assistant' && contentType === 'text') {
      sm.lastTextAssistantUuid = uuid;
      lastTextAssistant = rec;
    }
    updateBounds(timestamp);
    return uuid;
  };

  const processRecord = (currentLine: number, obj: any): void => {
    const ts = obj.timestamp || null;
    if (obj.type === 'session_meta') {
      if (obj.payload?.cwd) currentCwd = normalizeObservedCwd(obj.payload.cwd) || currentCwd;
      if (obj.payload?.git?.branch) sm.git_branch = obj.payload.git.branch;
      if (obj.payload?.cli_version) sm.version = obj.payload.cli_version;
      updateBounds(obj.payload?.timestamp || ts);
      return;
    }
    if (obj.type === 'turn_context') {
      currentCwd = normalizeObservedCwd(obj.payload?.cwd) || currentCwd;
      currentModel = obj.payload?.model || currentModel;
      updateBounds(ts);
      return;
    }
    if (obj.type === 'event_msg') {
      const payload = obj.payload || {};
      if (payload.type === 'user_message' || payload.type === 'agent_message' || payload.type === 'agent_reasoning') {
        const text = codexEventText(payload);
        if (text === null) return;
        const isReasoning = payload.type === 'agent_reasoning';
        insertMessage({
          uuid: lineUuid(currentLine),
          type: payload.type === 'user_message' ? 'user' : 'assistant',
          role: payload.type === 'user_message' ? 'user' : 'assistant',
          text, contentType: isReasoning ? 'thinking' : 'text', timestamp: ts,
        });
        return;
      }
      if (payload.type === 'collab_agent_spawn_end' && payload.call_id && payload.new_thread_id) {
        const uuid = insertMessage({ uuid: lineUuid(currentLine), type: 'assistant', role: 'assistant', text: null, contentType: 'tool_use', timestamp: ts });
        const toolId = codexCallId(threadRawId, payload.call_id) as string;
        const description = payload.new_agent_nickname || payload.new_agent_role || 'Agent';
        const input = {
          description, subagent_type: payload.new_agent_role || 'Agent', prompt: payload.prompt || '',
          new_thread_id: payload.new_thread_id, model: payload.model || null, reasoning_effort: payload.reasoning_effort || null,
        };
        out.push({ kind: 'tool_call', id: toolId, message_uuid: uuid, session_id: sessionId, name: 'Agent', presentation: 'default', input_json: truncJson(input) as string, file_path: null });
        callMessageUuids.set(toolId, uuid);
        openCallMessageUuids.set(toolId, uuid);
        out.push({ kind: 'subagent', agent_id: codexDbId(payload.new_thread_id) as string, session_id: sessionId, parent_tool_use_id: toolId, agent_type: payload.new_agent_role || null, description });
        return;
      }
      if (payload.type === 'task_complete') {
        if (sm.lastTextAssistantUuid && payload.duration_ms !== undefined) {
          out.push({ kind: 'message-turn-duration', uuid: sm.lastTextAssistantUuid, turn_duration_ms: payload.duration_ms || null });
        }
        updateBounds(ts);
        return;
      }
      if (payload.type === 'token_count') {
        const usage = codexUsage(payload);
        if (usage.inputTokens != null) sm.totalInputTokens = usage.inputTokens;
        if (usage.outputTokens != null) sm.totalOutputTokens = usage.outputTokens;
        if (sm.lastTextAssistantUuid && (usage.inputTokens != null || usage.outputTokens != null)) {
          const rec = msgByUuid.get(sm.lastTextAssistantUuid);
          if (rec) {
            rec.input_tokens = usage.inputTokens;
            rec.output_tokens = usage.outputTokens;
            if (!emittedMessageUuids.has(rec.uuid)) {
              out.push(rec);
              emittedMessageUuids.add(rec.uuid);
            }
          }
        }
        return;
      }
      if (payload.type === 'thread_name_updated' && payload.thread_name) sm.threadTitle = payload.thread_name;
      return;
    }
    if (obj.type !== 'response_item') return;
    const payload = obj.payload || {};
    if (payload.type === 'message' && payload.role !== 'developer') {
      const text = codexMessagePayloadText(payload);
      const role = payload.role || 'assistant';
      const key = text === null ? null : visibleMessageDigest(role, text);
      if (text !== null && key !== null && !eventMessageKeys.has(key)) {
        insertMessage({ uuid: lineUuid(currentLine), type: role === 'user' ? 'user' : 'assistant', role, text, contentType: 'text', timestamp: ts });
        bloomAdd(responseMessageBloom, key);
      }
      return;
    }
    if (['function_call', 'custom_tool_call', 'tool_search_call', 'web_search_call'].includes(payload.type) && payload.call_id) {
      const uuid = insertMessage({ uuid: lineUuid(currentLine), type: 'assistant', role: 'assistant', text: null, contentType: 'tool_use', timestamp: ts });
      const name = payload.name || payload.tool || payload.type.replace(/_call$/, '');
      const toolId = codexCallId(threadRawId, payload.call_id) as string;
      out.push({ kind: 'tool_call', id: toolId, message_uuid: uuid, session_id: sessionId, name, presentation: name === 'Skill' ? 'skill' : 'default', input_json: truncJson(codexToolInput(payload)) as string, file_path: null });
      callMessageUuids.set(toolId, uuid);
      openCallMessageUuids.set(toolId, uuid);
      return;
    }
    if (['function_call_output', 'custom_tool_call_output', 'tool_search_output'].includes(payload.type) && payload.call_id) {
      const toolId = codexCallId(threadRawId, payload.call_id) as string;
      out.push({ kind: 'tool_result', tool_use_id: toolId, message_uuid: callMessageUuids.get(toolId) || '', session_id: sessionId, content: trunc(codexToolOutput(payload) || ''), file_path: null, is_error: payload.is_error ? 1 : 0 });
      openCallMessageUuids.delete(toolId);
    }
  };

  let currentLine = fast ? prior!.lineCount : 0;
  readLines(unit.key, (line: string) => {
    currentLine++;
    try { processRecord(currentLine, JSON.parse(line)); } catch { /* skip malformed */ }
  }, { start: fast ? prior!.size : 0 });
  const afterParse = statSync(unit.key);
  if (currentLine !== lineNum || !sameStat(stat, afterParse)) return _cursor;

  if (agentId) {
    const started = sm.started_at ? new Date(sm.started_at).getTime() : null;
    const ended = sm.ended_at ? new Date(sm.ended_at).getTime() : null;
    const tokenTotal = (sm.totalInputTokens || 0) + (sm.totalOutputTokens || 0);
    out.push({
      kind: 'subagent', agent_id: agentId, session_id: sessionId,
      agent_type: codexAgentRole(meta), description: codexAgentNickname(meta),
      duration_ms: started && ended ? ended - started : null, total_tokens: tokenTotal || null,
    });
  } else {
    out.push({
      kind: 'session', id: sessionId, title: sm.threadTitle ?? indexedMeta?.indexedTitle ?? null, project,
      started_at: sm.started_at, ended_at: sm.ended_at, git_branch: sm.git_branch, version: sm.version,
      message_count: sm.n, countMode: 'total', jsonl_path: unit.key, source: 'codex',
    });
  }

  const outCursor = encodeCodexCursor(stat, lineNum, {
    v: CODEX_CURSOR_STATE_VERSION,
    threadRawId,
    meta,
    chunkHashes: fingerprint.chunkHashes,
    eventMessageBloom: eventMessageBloom.toString('base64url'),
    responseMessageBloom: responseMessageBloom.toString('base64url'),
    openCallMessageUuids: Object.fromEntries(openCallMessageUuids),
    terminated,
    currentCwd,
    currentModel,
    lastMessageUuid: sm.lastMessageUuid,
    lastTextAssistant,
    startedAt: sm.started_at,
    endedAt: sm.ended_at,
    gitBranch: sm.git_branch,
    version: sm.version,
    threadTitle: sm.threadTitle,
    messageCount: sm.n,
    totalInputTokens: sm.totalInputTokens,
    totalOutputTokens: sm.totalOutputTokens,
  });
  yield* out;
  return outCursor;
}

function findCodexFile(rootDir: string, rawThreadId: string): string | null {
  const stack = codexTranscriptDirs(rootDir);
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (!existsSync(current)) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && entry.name.endsWith(`${rawThreadId}.jsonl`)) return path;
    }
  }
  return null;
}

function rawCodex(rootDir: string, input: RawLookup): RawRecord | null {
  const match = /^codex:([^:]+):(\d+)$/.exec(input.messageUuid);
  if (match === null) return null;
  const path = input.agentId === null && typeof input.session?.jsonl_path === 'string'
    ? input.session.jsonl_path
    : findCodexFile(rootDir, match[1]!);
  if (path === null || !existsSync(path)) return null;
  let lineNumber = 0;
  let found: string | null = null;
  readLines(path, (line: string) => {
    lineNumber++;
    if (lineNumber !== Number(match[2])) return;
    found = line;
    return false;
  });
  const raw = found as string | null;
  let messageText: string | null = null;
  if (raw !== null) {
    try {
      const obj = JSON.parse(raw);
      const payload = obj?.payload ?? {};
      if (obj?.type === 'event_msg') {
        messageText = typeof payload.message === 'string'
          ? payload.message
          : typeof payload.text === 'string'
            ? payload.text
            : null;
      } else if (obj?.type === 'response_item' && payload.type === 'message' && Array.isArray(payload.content)) {
        messageText = codexMessagePayloadText(payload);
      }
    } catch { /* malformed source line */ }
  }
  return raw === null
    ? null
    : { text: raw, totalLength: raw.length, offset: 0, limit: raw.length, hasMore: false, messageText };
}

export function createCodexProvider({ rootDir = join(homedir(), '.codex') }: { rootDir?: string } = {}): ProviderAdapter {
  return {
    name,
    descriptor: { id: name, name: 'Codex', vendor: 'OpenAI', defaultRoot: rootDir, color: '#10a37f' },
    indexVersionMarker: CODEX_CANONICAL_TRANSCRIPT_MARKER,
    watchTargets: (configuredRoot) => [
      ...codexTranscriptDirs(configuredRoot).map((dir) => ({ kind: 'tree' as const, path: dir })),
      { kind: 'file', path: join(configuredRoot, 'session_index.jsonl') },
    ],
    discover: (ctx) => discoverAt(rootDir, ctx),
    parse,
    raw: (input) => rawCodex(rootDir, input),
  };
}

export const codexProvider = createCodexProvider();
