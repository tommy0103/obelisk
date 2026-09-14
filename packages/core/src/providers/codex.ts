// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Codex provider adapter in Core (see docs/adr/0001).
//
// Pure: discovers Codex rollout files and parses one into a record stream. It
// never touches the Obelisk database. A v4 checkpoint supports a cooperative
// append path that reads only new bytes; the existing prefix-hash path remains
// available for verified appends, while replacements, truncations, legacy
// cursors, and unterminated tails fall back to a complete snapshot. The whole-
// file scan remains necessary for event_msg ↔ response_item dedup, but it
// retains only bounded checkpoint state instead of every parsed JSON object.

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

// Cursor format: `${mtime}:${lines}:${completeLineOffset}:${ctimeMs}:${ino}`.
// mtime+ctime+source identity still let discovery notice same-millisecond
// rewrites. The provider state carries sourceSize because the outer size field
// is now the safe restart offset, not the current EOF.
function codexCursorSignatureDiffers(cursor: string, filePath: string): boolean {
  const stat = statSync(filePath);
  const parts = cursor.split(':');
  if (parts.length < 5) return true;
  let sourceSize = Number(parts[2]);
  try {
    const state = JSON.parse(Buffer.from(parts[5]!, 'base64url').toString('utf8'));
    if (Number.isSafeInteger(state?.sourceSize) && state.sourceSize >= 0) sourceSize = state.sourceSize;
  } catch { /* legacy or malformed cursor: force replay */ }
  return Number(parts[0]) !== stat.mtimeMs
    || sourceSize !== stat.size
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
      const unchangedSource = cursor !== null && !codexCursorSignatureDiffers(cursor, file.path);
      // A session-index-only refresh must update the aggregate, but a
      // strengthened cursor already contains the identity needed to construct
      // the normal-session unit. Avoid reopening every historical rollout for
      // guardian classification when its source signature is unchanged.
      if (sessionIndexChanged && !fileChanged && unchangedSource) {
        const checkpoint = decodeCodexCursor(cursor);
        if (checkpoint !== null) {
          const parentId = codexParentThreadId(checkpoint.meta);
          const indexed = sessionIndex.get(checkpoint.threadRawId);
          return [{
            key: file.path,
            sessionId: codexDbId(parentId || checkpoint.threadRawId) ?? '',
            meta: {
              source: 'codex', guardian: false,
              indexedTitle: indexed?.title,
              indexedUpdatedAt: indexed?.updatedAt,
            },
          }];
        }
      }
      // Skip unchanged files before paying for guardian detection: guardian
      // status is content-derived, so a file whose cursor signature still
      // matches cannot have changed status. Pre-v3 databases may still hold
      // guardian session rows; the v3 marker bump forces one full replay that
      // retracts them.
      if (!sessionIndexChanged && !fileChanged && unchangedSource) return [];
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
// A verified cursor may retain only a bounded prefix fingerprint. Larger
// sources deliberately lose the verified fast path and use snapshot replay on
// the next verification request; cooperative append still remains available.
const CODEX_MAX_CURSOR_CHUNK_HASHES = 128;
const CODEX_MAX_OPEN_CALLS = 4096;

interface CodexCursorState {
  v: number;
  threadRawId: string;
  meta: Record<string, any>;
  // Present only on the cooperative-capable v4 subformat. Old #148 v4
  // cursors are deliberately rejected for offset resumption.
  completeLineOffset?: number;
  sourceSize?: number;
  dev?: string;
  sourceInode?: string;
  verifiedPrefix?: boolean;
  stateComplete?: boolean;
  indexedTitle?: string;
  indexedUpdatedAt?: string | null;
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
  ctimeMs: number;
  inode: number;
}

/** Test/benchmark-only observation of source work for one parse invocation. */
export interface CodexParseMetrics {
  sourceBytesRead: number;
  suffixBytesRead: number;
  jsonLinesParsed: number;
  emittedRecords: number;
  plan: 'snapshot' | 'verified-append' | 'cooperative-append' | 'noop' | null;
}

export function createCodexParseMetrics(): CodexParseMetrics {
  return { sourceBytesRead: 0, suffixBytesRead: 0, jsonLinesParsed: 0, emittedRecords: 0, plan: null };
}

/** Deterministic test seam for source mutation checks; never used by production callers. */
export interface CodexParseTestHooks {
  beforeScan?(): void;
  afterScan?(): void;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, max = 1024): string | null {
  return typeof value === 'string' ? value.slice(0, max) : null;
}

function checkpointMeta(meta: Record<string, any>): Record<string, any> {
  const source = isRecord(meta.source) ? meta.source : null;
  const subagent = source && isRecord(source.subagent) ? source.subagent : null;
  const threadSpawn = subagent && isRecord(subagent.thread_spawn) ? subagent.thread_spawn : null;
  return {
    id: boundedString(meta.id),
    cwd: boundedString(meta.cwd),
    timestamp: boundedString(meta.timestamp),
    cli_version: boundedString(meta.cli_version),
    thread_source: boundedString(meta.thread_source),
    forked_from_id: boundedString(meta.forked_from_id),
    agent_nickname: boundedString(meta.agent_nickname),
    agent_role: boundedString(meta.agent_role),
    git: isRecord(meta.git) ? { branch: boundedString(meta.git.branch) } : null,
    source: subagent ? {
      subagent: {
        other: boundedString(subagent.other),
        parent_thread_id: boundedString(subagent.parent_thread_id),
        thread_spawn: threadSpawn ? {
          parent_thread_id: boundedString(threadSpawn.parent_thread_id),
          agent_nickname: boundedString(threadSpawn.agent_nickname),
          agent_role: boundedString(threadSpawn.agent_role),
        } : null,
      },
    } : null,
  };
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function usableSourceIdentity(stat: Stats): boolean {
  return Number.isSafeInteger(stat.dev) && stat.dev > 0
    && Number.isSafeInteger(stat.ino) && stat.ino > 0;
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
  const ctimeMs = Number(parts[3]);
  const inode = Number(parts[4]);
  if (!Number.isSafeInteger(lineCount) || !Number.isSafeInteger(size)
    || !Number.isFinite(ctimeMs) || !Number.isFinite(inode)) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(parts[5]!, 'base64url').toString('utf8'));
    if (!isRecord(value)
      || value.v !== CODEX_CURSOR_STATE_VERSION
      || typeof value.threadRawId !== 'string'
      || !isRecord(value.meta)
      || (value.completeLineOffset !== undefined && (!Number.isSafeInteger(value.completeLineOffset) || value.completeLineOffset < 0))
      || (value.sourceSize !== undefined && (!Number.isSafeInteger(value.sourceSize) || value.sourceSize < 0))
      || (value.dev !== undefined && typeof value.dev !== 'string')
      || (value.sourceInode !== undefined && typeof value.sourceInode !== 'string')
      || (value.verifiedPrefix !== undefined && typeof value.verifiedPrefix !== 'boolean')
      || (value.stateComplete !== undefined && typeof value.stateComplete !== 'boolean')
      || (value.indexedTitle !== undefined && typeof value.indexedTitle !== 'string')
      || (value.indexedUpdatedAt !== undefined && !nullableString(value.indexedUpdatedAt))
      || !Array.isArray(value.chunkHashes)
      || value.chunkHashes.length > CODEX_MAX_CURSOR_CHUNK_HASHES
      || !value.chunkHashes.every(item => typeof item === 'string')
      || decodeBloom(value.eventMessageBloom) === null
      || decodeBloom(value.responseMessageBloom) === null
      || !isRecord(value.openCallMessageUuids)
      || Object.keys(value.openCallMessageUuids).length > CODEX_MAX_OPEN_CALLS
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
    // Keep #148 v4 cursors readable. They simply lack the strengthened offset
    // identity and therefore cannot enter cooperative mode.
    return {
      ...(value as unknown as CodexCursorState),
      lineCount,
      size,
      ctimeMs,
      inode,
    };
  } catch {
    return null;
  }
}

function encodeCodexCursor(
  stat: Stats,
  lineCount: number,
  completeLineOffset: number,
  state: CodexCursorState,
): string {
  const encoded = Buffer.from(JSON.stringify(state)).toString('base64url');
  return `${stat.mtimeMs}:${lineCount}:${completeLineOffset}:${stat.ctimeMs}:${stat.ino}:${encoded}`;
}

function sameStat(a: Stats, b: Stats): boolean {
  return a.dev === b.dev
    && a.mtimeMs === b.mtimeMs
    && a.ctimeMs === b.ctimeMs
    && a.size === b.size
    && a.ino === b.ino;
}

function sameSource(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
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
  metrics?: CodexParseMetrics,
): { chunkHashes: string[]; prefixMatches: boolean; bytesRead: number; complete: boolean } {
  const fd = openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(CODEX_FINGERPRINT_CHUNK_BYTES);
  const chunkHashes: string[] = [];
  let fingerprintBounded = true;
  // `size` is the restart offset for strengthened v4. Fingerprints, however,
  // cover the source bytes that produced the checkpoint, including an
  // unterminated tail; use sourceSize when available.
  const priorSourceSize = prior === null ? 0 : (prior.sourceSize ?? prior.size);
  const priorChunks = prior === null ? 0 : Math.ceil(priorSourceSize / CODEX_FINGERPRINT_CHUNK_BYTES);
  const completePriorChunks = prior === null ? 0 : Math.floor(priorSourceSize / CODEX_FINGERPRINT_CHUNK_BYTES);
  const priorTailBytes = prior === null ? 0 : priorSourceSize % CODEX_FINGERPRINT_CHUNK_BYTES;
  let prefixMatches = prior !== null && priorSourceSize <= size && prior.chunkHashes.length === priorChunks;
  let position = 0;
  try {
    while (position < size) {
      const wanted = Math.min(buffer.length, size - position);
      let filled = 0;
      while (filled < wanted) {
        const count = readSync(fd, buffer, filled, wanted - filled, position + filled);
        if (count === 0) break;
        filled += count;
        if (metrics) metrics.sourceBytesRead += count;
      }
      if (filled === 0) break;
      const index = chunkHashes.length;
      const bytes = buffer.subarray(0, filled);
      if (index >= CODEX_MAX_CURSOR_CHUNK_HASHES) {
        fingerprintBounded = false;
        position += filled;
        continue;
      }
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
  return {
    chunkHashes,
    prefixMatches: fingerprintBounded && prefixMatches && position === size,
    bytesRead: position,
    complete: fingerprintBounded,
  };
}

export function* parse(
  unit: IndexUnit,
  _cursor: Cursor,
  metrics?: CodexParseMetrics,
  testHooks?: CodexParseTestHooks,
): Generator<TranscriptRecord, Cursor> {
  const stat = statSync(unit.key);
  const prior = decodeCodexCursor(_cursor);
  const readMode = unit.meta && typeof unit.meta === 'object' && 'readMode' in unit.meta
    && (unit.meta as { readMode?: unknown }).readMode === 'strict'
    ? 'strict'
    : 'normal';
  // Discovery has already classified this source as a guardian. That is an
  // explicit source invalidation, not an append: force a complete scan so the
  // canonical guardian retraction can remove this child contribution.
  const guardianInvalidation = unit.meta && typeof unit.meta === 'object'
    && (unit.meta as { guardian?: unknown }).guardian === true;
  // The cooperative path deliberately trusts Codex's normal append-only writer:
  // same device/inode, a complete-line checkpoint, and monotonic growth let us
  // seek to the suffix without reading the old prefix. Any failed gate falls
  // through to #148's fingerprinted verification/snapshot behavior.
  const cooperativeCandidate = !guardianInvalidation && readMode === 'normal'
    && prior !== null
    && usableSourceIdentity(stat)
    && prior.completeLineOffset !== undefined
    && prior.sourceSize !== undefined
    && prior.dev !== undefined
    && prior.sourceInode !== undefined
    && prior.stateComplete !== false
    && prior.threadRawId === codexRawId(prior.meta.id)
    && prior.dev === String(stat.dev)
    && prior.sourceInode === String(stat.ino)
    && prior.inode === stat.ino
    && prior.terminated
    && prior.completeLineOffset === prior.size
    && prior.sourceSize === prior.size
    && stat.size >= prior.completeLineOffset;
  // Growth is the normal append signal; ctime necessarily changes when bytes
  // are appended. For same-size sources, require the unchanged ctime before
  // treating the file as a no-op, otherwise let fingerprinting detect rewrites.
  const sameCheckpoint = !guardianInvalidation && cooperativeCandidate && stat.size === prior.size;
  const indexedMeta = unit.meta as { indexedTitle?: string; indexedUpdatedAt?: string | null } | undefined;
  const metadataChanged = sameCheckpoint && (
    prior.indexedTitle !== indexedMeta?.indexedTitle
    || prior.indexedUpdatedAt !== (indexedMeta?.indexedUpdatedAt ?? undefined)
  );
  if (sameCheckpoint && stat.ctimeMs === prior.ctimeMs) {
    if (!metadataChanged) {
      if (metrics) metrics.plan = 'noop';
      return _cursor;
    }
    const parentRawId = codexParentThreadId(prior.meta);
    // A child has no independent session aggregate to patch. It must be
    // re-planned with the parent projection rather than replace its parent.
    if (parentRawId) return _cursor;
    const endedAt = indexedMeta?.indexedUpdatedAt && (!prior.endedAt || indexedMeta.indexedUpdatedAt > prior.endedAt)
      ? indexedMeta.indexedUpdatedAt
      : prior.endedAt;
    yield {
      kind: 'session', id: codexDbId(prior.threadRawId) as string,
      title: prior.threadTitle ?? indexedMeta?.indexedTitle ?? null,
      project: projectSlugFromPath(normalizeObservedCwd(prior.meta.cwd)),
      started_at: prior.startedAt, ended_at: endedAt, git_branch: prior.gitBranch,
      version: prior.version, message_count: prior.messageCount, countMode: 'total',
      jsonl_path: unit.key, source: 'codex',
    };
    const { lineCount, size, ctimeMs: _ctimeMs, inode: _inode, ...state } = prior;
    return encodeCodexCursor(stat, lineCount, size, {
      ...state,
      indexedTitle: indexedMeta?.indexedTitle,
      indexedUpdatedAt: indexedMeta?.indexedUpdatedAt ?? undefined,
      endedAt,
    });
  }
  const cooperativeAppend = cooperativeCandidate && stat.size > prior.size;
  const fingerprint = cooperativeAppend
    ? {
      chunkHashes: prior!.chunkHashes,
      prefixMatches: false,
      bytesRead: 0,
      complete: stat.size <= CODEX_MAX_CURSOR_CHUNK_HASHES * CODEX_FINGERPRINT_CHUNK_BYTES,
    }
    : fingerprintCodexFile(unit.key, stat.size, prior, metrics);
  const afterFingerprint = statSync(unit.key);
  if ((!cooperativeAppend && (fingerprint.bytesRead !== stat.size || !sameStat(stat, afterFingerprint)))
    || (cooperativeAppend && !sameSource(stat, afterFingerprint))) return _cursor;
  const appendCandidate = !guardianInvalidation && (cooperativeAppend || (prior !== null
    && prior.verifiedPrefix === true
    && prior.threadRawId === codexRawId(prior.meta.id)
    && prior.dev === String(stat.dev)
    && prior.sourceInode === String(stat.ino)
    && prior.inode === stat.ino
    && prior.terminated
    && prior.stateComplete !== false
    && prior.completeLineOffset !== undefined
    && prior.completeLineOffset === prior.size
    && fingerprint.prefixMatches));
  const eventMessageKeys = new Set<string>();
  const appendedEventMessageKeys = new Set<string>();
  const appendedResponseMessageKeys = new Set<string>();
  let metaRecord: { lineNum: number; obj: any } | null = !appendCandidate
    ? null
    : { lineNum: 1, obj: { timestamp: prior.startedAt, payload: prior.meta } };
  let sawAutoReviewModel = false;
  const scan = (start: number, collectAppendedResponses: boolean): {
    lineCount: number; completeLineCount: number; completeLineOffset: number; terminated: boolean; malformed: boolean;
  } => {
    let scannedLineNum = start === 0 ? 0 : (appendCandidate ? prior!.lineCount : 0);
    let scannedCompleteLineCount = start === 0 ? 0 : (appendCandidate ? prior!.lineCount : 0);
    let scannedCompleteLineOffset = start === 0 ? 0 : (appendCandidate ? prior!.completeLineOffset! : 0);
    let scannedTerminated = start === 0 ? true : (appendCandidate ? prior!.terminated : true);
    let malformed = false;
    readLines(unit.key, (line: string, lineTerminated: boolean, endOffset?: number) => {
      scannedTerminated = lineTerminated;
      if (!lineTerminated) return;
      scannedLineNum++;
      scannedCompleteLineCount++;
      if (endOffset !== undefined) scannedCompleteLineOffset = endOffset;
      // Parse every completed record before emitting anything. A malformed
      // complete JSONL line is not a partial tail and must not publish a
      // replacement assembled from only a source prefix.
      let obj: any;
      try {
        obj = JSON.parse(line);
        if (metrics) metrics.jsonLinesParsed++;
      } catch {
        malformed = true;
        return;
      }
      if (metaRecord === null && obj?.type === 'session_meta' && obj.payload?.id) {
        metaRecord = { lineNum: scannedLineNum, obj };
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
    }, {
      start,
      onBytesRead: (bytes) => {
        if (metrics) {
          metrics.sourceBytesRead += bytes;
          if (start > 0) metrics.suffixBytesRead += bytes;
        }
      },
    });
    return {
      lineCount: scannedLineNum,
      completeLineCount: scannedCompleteLineCount,
      completeLineOffset: scannedCompleteLineOffset,
      terminated: scannedTerminated,
      malformed,
    };
  };
  testHooks?.beforeScan?.();
  let scanResult = scan(appendCandidate ? prior.size : 0, appendCandidate);
  testHooks?.afterScan?.();
  const afterScan = statSync(unit.key);
  if (!sameStat(stat, afterScan) || scanResult.malformed) return _cursor;
  const priorCompleteLineOffset = appendCandidate ? prior!.completeLineOffset! : null;
  if (priorCompleteLineOffset !== null && (afterScan.size < prior!.size || scanResult.completeLineOffset < priorCompleteLineOffset)) return _cursor;
  // Bytes without a final newline are not a consumable append. Keep the old
  // cursor and emit no aggregate so the next pass re-reads that partial line.
  if (priorCompleteLineOffset !== null && scanResult.completeLineOffset === priorCompleteLineOffset) return _cursor;
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
  if (metrics) metrics.plan = fast
    ? (cooperativeAppend ? 'cooperative-append' : 'verified-append')
    : 'snapshot';
  if (appendCandidate && !fast) {
    eventMessageKeys.clear();
    metaRecord = null;
    sawAutoReviewModel = false;
    scanResult = scan(0, false);
    if (!sameStat(stat, statSync(unit.key)) || scanResult.malformed) return _cursor;
  }
  const { lineCount: lineNum, completeLineCount, completeLineOffset, terminated } = scanResult;
  const eventMessageBloom = fast ? priorEventBloom : emptyBloom();
  const responseMessageBloom = fast ? priorResponseBloom : emptyBloom();
  for (const key of eventMessageKeys) bloomAdd(eventMessageBloom, key);
  const previous = fast ? prior : null;
  const basicCursor = `${stat.mtimeMs}:${completeLineCount}:${completeLineOffset}:${stat.ctimeMs}:${stat.ino}`;
  const capturedMeta = metaRecord as { lineNum: number; obj: any } | null;
  if (capturedMeta === null) return basicCursor;

  const rawMeta = capturedMeta.obj.payload as Record<string, any>;
  const meta = checkpointMeta(rawMeta);
  const threadRawId = codexRawId(rawMeta.id) as string;
  if (codexIsGuardianThread(meta, sawAutoReviewModel ? [{ lineNum: 0, obj: { model: 'codex-auto-review' } }] : [])) {
    // Guardian children previously contributed rows to their parent projection.
    // `delete-session` is intentionally keyed by the child db id: persist()
    // deletes rows where that value is `agent_id`, while preserving the shared
    // parent session and sibling/root contributions.
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
  // A full snapshot can reconstruct open calls from the whole source even if
  // the previous cooperative checkpoint deliberately marked its state partial.
  let stateComplete = appendCandidate ? previous?.stateComplete !== false : true;
  const rememberOpenCall = (toolId: string, uuid: string): void => {
    if (!stateComplete) return;
    openCallMessageUuids.set(toolId, uuid);
    if (openCallMessageUuids.size > CODEX_MAX_OPEN_CALLS) {
      stateComplete = false;
      openCallMessageUuids.clear();
    }
  };

  const out: TranscriptRecord[] = [];
  // A child rollout contributes to its parent projection. Replaying only this
  // child cannot safely retract the whole parent session; leave destructive
  // replacement to orchestration that replays the complete contributing tree.
  const canRetract = _cursor !== null && !fast && !agentId;
  if (canRetract) out.push({ kind: 'delete-session', sessionId });
  const msgByUuid = new Map<string, MessageRecord>();
  const emittedMessageUuids = new Set<string>();
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
        rememberOpenCall(toolId, uuid);
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
      rememberOpenCall(toolId, uuid);
      return;
    }
    if (['function_call_output', 'custom_tool_call_output', 'tool_search_output'].includes(payload.type) && payload.call_id) {
      const toolId = codexCallId(threadRawId, payload.call_id) as string;
      const messageUuid = callMessageUuids.get(toolId) || '';
      // Preserve the source result even when malformed input has no matching
      // call. An empty anchor is explicit evidence of the missing association;
      // silently dropping the source record would create a timeline hole.
      out.push({ kind: 'tool_result', tool_use_id: toolId, message_uuid: messageUuid, session_id: sessionId, content: trunc(codexToolOutput(payload) || ''), file_path: null, is_error: payload.is_error ? 1 : 0 });
      openCallMessageUuids.delete(toolId);
    }
  };

  let currentLine = fast ? prior!.lineCount : 0;
  const emitStart = fast ? prior!.size : 0;
  readLines(unit.key, (line: string, lineTerminated: boolean) => {
    if (!lineTerminated) return;
    currentLine++;
    try {
      processRecord(currentLine, JSON.parse(line));
      if (metrics) metrics.jsonLinesParsed++;
    } catch { /* pre-scan already rejected malformed complete lines */ }
  }, {
    start: emitStart,
    onBytesRead: (bytes) => {
      if (metrics) {
        metrics.sourceBytesRead += bytes;
        if (emitStart > 0) metrics.suffixBytesRead += bytes;
      }
    },
  });
  const afterParse = statSync(unit.key);
  // `out` is only a staging buffer. If the source changed during the second
  // pass, abandon before adding aggregates or yielding anything; returning an
  // old cursor after emitting a mixed view would split source and projection.
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

  const checkpointSize = completeLineOffset;
  const outCursor = encodeCodexCursor(stat, completeLineCount, checkpointSize, {
    v: CODEX_CURSOR_STATE_VERSION,
    threadRawId,
    meta,
    completeLineOffset: checkpointSize,
    sourceSize: stat.size,
    dev: String(stat.dev),
    sourceInode: String(stat.ino),
    // A complete initial snapshot is verified by definition. Cooperative
    // append keeps the old hashes only as stale metadata and must not claim
    // that the enlarged prefix was verified.
    verifiedPrefix: !cooperativeCandidate
      && fingerprint.complete
      && (prior === null || fingerprint.prefixMatches),
    stateComplete,
    indexedTitle: indexedMeta?.indexedTitle,
    indexedUpdatedAt: indexedMeta?.indexedUpdatedAt ?? undefined,
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
  if (metrics) metrics.emittedRecords += out.length;
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
