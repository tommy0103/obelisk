// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// DeepSeek Harness provider adapter in Core (see docs/adr/0001 and
// docs/adr/0011 for the architecture this file implements).
//
// Pure: discovers DeepSeek Harness session trees and parses one tree into a
// canonical record stream. It never touches the Obelisk database.
//
// Source layout ($DSH_HOME/sessions, default ~/.dsh/sessions):
//   <root>/--<normalized-cwd>--/<session-id>/session.jsonl.zstd   (default)
//   <root>/--<normalized-cwd>--/<session-id>/session.jsonl        (compression: none)
//
// A log is one immutable `SessionHeader` line followed by contiguous
// `SessionEvent` lines ({type, seq, time, data}). The default artifact is a
// concatenation of independent checksummed zstd frames (header frame + one
// frame per append batch); the framing scanner and decoders are vendored from
// DeepSeek Harness (see ../vendor/dsh-zstd.ts) and decode each complete frame,
// tolerating a torn final frame (the durable backend repairs such a tail on
// its own load, so the trailing bytes carry no committed events).
//
// ARCHITECTURE (ADR-0011). One IndexUnit is a whole ROOT SESSION TREE: a root
// session file plus every descendant subagent file, grouped at discovery by
// project-scoped ancestry. The cursor is a checkpoint (`mtime:count` prefix
// for persist's index_state columns, then opaque base64url JSON): per-member
// { agentId, headerHash, inode, count, prefixHash } plus per-member
// lastMessageUuid (+ its own parent) and the steps with an emitted tool_use
// anchor. Parse has two paths:
//
//   FAST PATH — every member satisfies strict preconditions (same member set,
//   same identities, unchanged inodes, non-decreasing counts, and the stored
//   cumulative prefix hash still matches the current committed prefix).
//   Only new frames/lines are decoded; parent chains resume from the
//   checkpointed lastMessageUuid; records emit with countMode 'delta'.
//
//   SNAPSHOT FALLBACK — anything else (member added/removed, replacement,
//   truncation, identity change). The unit first emits delete-session for the
//   root (the cascade is safe: the whole tree is re-emitted by this same
//   unit), then a complete re-parse with countMode 'total'.
//
// Event identity is deterministic from the log content: user messages use
// `<dbId>:u<data.id>`, assistant messages `<dbId>:t<turn>:s<step>:<kind>`,
// where dbId = `deepseek:<encodeURIComponent(id)>:<sha256(cwd)>` (composite
// project-scoped identity, mirroring pi — CONTRIBUTING: session identity must
// not be the source id alone). Upstream persists a step's assistant/message
// before the durable tool/call of the tool it ordered (session-checkpoint
// policy), so a provisional tool_use anchor is only ever followed by the
// canonical row — and the cursor checkpoints which steps already have an
// anchor, so a later-window tool/call never rewrites it.
//
// Packed chunk rows (`text-chunks`/`reasoning-chunks`/`tool-call-chunks`) are
// NOT expanded during projection: their members duplicate the step-final
// assistant/message, which always carries the assembled content. The vendored
// codec (../vendor/dsh-chunk-rows.ts) remains available for raw
// reconstruction but is not on the indexing path.

import { closeSync, existsSync, fstatSync, openSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, sep } from 'node:path';

import { filePath, normalizeObservedCwd, projectSlugFromPath, sourceInventoryIssue, trunc, truncJson } from '../parsing.ts';
import { createZstdFrameDecoder, scanZstdFrames } from '../vendor/dsh-zstd.ts';

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
const DEEPSEEK_CANONICAL_TRANSCRIPT_MARKER = '__deepseek_canonical_transcript_v2__';

const SESSION_FILENAMES = ['.jsonl.zstd', '.jsonl'];
const SUBAGENT_RESULT_RE = /started\s+subagent\s+(\S+)/;

interface DshHeader {
  id?: unknown;
  version?: unknown;
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

/**
 * Deterministic project discriminator for session identity (CONTRIBUTING:
 * "session identity must not be the source id alone"). Mirrors pi's scheme so
 * two projects reusing the same raw session id cannot overwrite each other.
 */
function projectScope(cwd: unknown): string {
  const normalized = normalizeObservedCwd(cwd) ?? (typeof cwd === 'string' ? cwd : '');
  return createHash('sha256').update('deepseek-cwd-v1\0').update(normalized).digest('hex');
}

/** Database identity for one raw session id inside one project scope. */
function dshDbId(scope: string, rawId: string): string {
  return `deepseek:${encodeURIComponent(rawId)}:${scope}`;
}

function assistantMessageUuid(dbId: string, turn: unknown, step: unknown, kind: 'reasoning' | 'text' | 'tool_use'): string {
  return `${dbId}:t${turn}:s${step}:${kind}`;
}

function toolUseUuid(dbId: string, turn: unknown, step: unknown): string {
  return assistantMessageUuid(dbId, turn, step, 'tool_use');
}

function userMessageUuid(dbId: string, nativeId: unknown, seq: number): string {
  return `${dbId}:u${typeof nativeId === 'string' && nativeId.length > 0 ? nativeId : seq}`;
}

function callId(dbId: string, nativeCallId: string): string {
  return `${dbId}:${encodeURIComponent(nativeCallId)}`;
}

/** The "t<turn>:s<step>" key encoded in an assistant-family uuid, else null. */
function stepKeyOf(uuid: string | null): string | null {
  if (uuid === null) return null;
  const match = /:t(\d+):s(\d+):(reasoning|text|tool_use)$/.exec(uuid);
  return match === null ? null : `t${match[1]}:s${match[2]}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// ---- log reading ----

/** Decode complete frames [fromFrame, frames.length) into plaintext. */
function decodeFrames(buffer: Buffer, frames: Array<{ start: number; end: number }>, fromFrame: number): string {
  if (fromFrame >= frames.length) return '';
  const tailStart = frames[fromFrame]!.start;
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
        const first = decoder.decode(buffer, [frames[0]!]).next();
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
    // Packed chunk rows are skipped whole: their members duplicate the
    // step-final assistant/message (ADR-0011). A malformed row is skipped
    // like any unparseable line instead of aborting the session.
    if (!isRecord(value) || typeof value.type !== 'string') continue;
    records.push({
      seq: typeof value.seq === 'number' ? value.seq : -1,
      type: value.type,
      time: typeof value.time === 'number' ? value.time : null,
      data: isRecord(value.data) ? value.data : {},
    });
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

/** Classify an assistant message's content parts (shared by projection and seeding). */
interface AssistantClassification {
  reasoningText: string | null;
  visibleText: string | null;
  hasToolCalls: boolean;
}

function classifyAssistantContent(content: unknown): AssistantClassification {
  return {
    reasoningText: joinPartText(content, 'reasoning'),
    visibleText: joinPartText(content, 'text'),
    hasToolCalls: Array.isArray(content)
      && content.some(part => isRecord(part) && part.type === 'tool-call' && typeof part.id === 'string'),
  };
}

function parseToolArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** DeepSeek Harness tool names whose arguments name a local file (lowercase, unlike Claude's). */
const DSH_FILE_TOOLS = new Set(['read', 'edit', 'write']);

function dshToolFilePath(toolName: string, input: Record<string, unknown> | null): string | null {
  if (input !== null && DSH_FILE_TOOLS.has(toolName) && typeof input.file_path === 'string') {
    return input.file_path;
  }
  return filePath(toolName, input);
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

// ---- discovery: files → root session trees ----

/** 'gone' only on ENOENT/ENOTDIR; anything else (EACCES, EIO, ...) is 'error'. */
function probePath(path: string): 'present' | 'gone' | 'error' {
  try {
    statSync(path);
    return 'present';
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'gone' : 'error';
  }
}

function collectSessionFiles(sessionsDir: string, reportIssue: ((issue: { path: string; error: string }) => void) | undefined): SessionFile[] {
  const result: SessionFile[] = [];
  if (probePath(sessionsDir) !== 'present') return result;
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
        const probe = probePath(path);
        if (probe === 'error') {
          // A permission/transient I/O error is NOT a deletion — record it so
          // the inventory stays uncertified and no tombstone can fire.
          reportIssue?.({ path, error: 'Session artifact is present but not stat-able' });
        }
        if (probe !== 'gone') {
          result.push({ path, projectDir: project.name, sessionDir });
          break;
        }
      }
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

function findSessionFile(rootDir: string, rawSessionId: string, scope: string | null): string | null {
  const files = collectSessionFiles(rootDir, undefined);
  for (const file of files) {
    const header = readDshHeader(file.path);
    if (file.sessionDir.endsWith(sep + rawSessionId) || header?.id === rawSessionId) {
      // Raw ids may collide across projects: disambiguate by scope (cwd hash)
      // when the caller's identity carries one.
      if (scope === null || projectScope(header?.cwd) === scope) return file.path;
    }
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

/** One member file of a root session tree, with its resolved header. */
interface TreeMember {
  path: string;
  rawId: string;
  dbId: string;
  agentId: string | null;
  isSubagent: boolean;
  header: DshHeader;
}

interface TreeUnitMeta {
  kind: 'session-tree';
  scope: string;
  rootRawId: string;
  /** Members in stable order: root first, then subagents by path. */
  members: TreeMember[];
}

function resolveRootRawId(rawId: string, header: DshHeader, headersByScopedId: Map<string, DshHeader>): string {
  // The parent chain stays inside the session's own project scope.
  const scope = projectScope(header.cwd);
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
    current = headersByScopedId.get(`${scope}\0${root}`);
  }
  return root;
}

function discoverAt(rootDir: string, ctx: DiscoverContext): IndexUnit[] {
  const sessionsDir = rootDir;
  // Track every inventory problem: tombstones are destructive and may only
  // fire when the inventory is fully certified (CONTRIBUTING: fail closed).
  let inventoryProblem = false;
  const reportIssue = (issue: { path: string; error: string }) => {
    inventoryProblem = true;
    ctx.reportIncompleteInventory?.(issue);
  };
  const innerCtx = { ...ctx, reportIncompleteInventory: reportIssue };
  if (!existsSync(sessionsDir) && (ctx.indexedSessions?.().length ?? 0) > 0) {
    reportIssue({ path: sessionsDir, error: 'Source folder is unavailable' });
  }
  const files = collectSessionFiles(sessionsDir, reportIssue);
  const changedFiles = ctx.changedPaths === undefined
    ? null
    : changedSessionFiles(sessionsDir, ctx.changedPaths);

  // Raw ids may collide across projects, so ancestry is tracked per project
  // scope — otherwise a nested subagent could fold along another project's
  // chain into a phantom root.
  const headersByScopedId = new Map<string, DshHeader>();
  const fileByPath = new Map<string, SessionFile>();
  const headerByPath = new Map<string, DshHeader>();
  const rawIdByPath = new Map<string, string>();
  const unreadable: SessionFile[] = [];
  for (const file of files) {
    // A headerless artifact (header frame not yet flushed / corrupt) cannot
    // establish identity or scope — but excluding it from its tree would let a
    // fallback retract its last-good rows. Defer it: attach it to its project
    // directory's tree below so parse can fail closed, and always record the
    // inventory issue (CONTRIBUTING: skip and record, fail closed).
    const header = readDshHeader(file.path);
    if (header === null || typeof header.id !== 'string' || header.id.length === 0) {
      reportIssue({ path: file.path, error: 'Session artifact has no readable header' });
      unreadable.push(file);
      fileByPath.set(file.path, file);
      continue;
    }
    // Version gate (CONTRIBUTING: tolerate the unknown — skip and record,
    // never parse a higher format as v0).
    if (header.version !== undefined && header.version !== 0) {
      reportIssue({ path: file.path, error: `Unsupported session format version ${String(header.version)}` });
      unreadable.push(file);
      fileByPath.set(file.path, file);
      continue;
    }
    const rawId = header.id;
    fileByPath.set(file.path, file);
    rawIdByPath.set(file.path, rawId);
    headerByPath.set(file.path, header);
    headersByScopedId.set(`${projectScope(header.cwd)}\0${rawId}`, header);
  }

  // Group files into root session trees.
  const membersByRootKey = new Map<string, { scope: string; rootRawId: string; paths: string[] }>();
  for (const [path, rawId] of rawIdByPath) {
    const header = headerByPath.get(path)!;
    const scope = projectScope(header.cwd);
    const rootRawId = resolveRootRawId(rawId, header, headersByScopedId);
    const key = `${scope}\0${rootRawId}`;
    const group = membersByRootKey.get(key) ?? { scope, rootRawId, paths: [] };
    group.paths.push(path);
    membersByRootKey.set(key, group);
  }
  // Two files with the SAME scoped identity (e.g. a copied session file) are
  // one logical member: keeping both would upsert the same uuids twice and
  // double-count aggregates. Byte-identical copies dedupe to the first sorted
  // path; DIVERGENT copies have no safe authority rule, so the whole tree
  // fails closed (suppressed this round) and the anomaly is recorded.
  const divergentGroups = new Set<string>();
  for (const [groupKey, group] of membersByRootKey) {
    const byIdentity = new Map<string, string[]>();
    for (const path of group.paths) {
      const rawId = rawIdByPath.get(path)!;
      const header = headerByPath.get(path)!;
      const isSub = typeof header.parentSession === 'string' && header.parentSession.length > 0;
      const identity = `${isSub}\0${rawId}`;
      byIdentity.set(identity, [...(byIdentity.get(identity) ?? []), path]);
    }
    const keptPaths: string[] = [];
    for (const paths of byIdentity.values()) {
      const sorted = [...paths].sort();
      const canonical = sorted[0]!;
      const canonicalBytes = readFileSync(canonical);
      for (const dup of sorted.slice(1)) {
        if (!readFileSync(dup).equals(canonicalBytes)) {
          divergentGroups.add(groupKey);
          reportIssue({ path: dup, error: 'Divergent session artifacts share one scoped identity' });
        }
      }
      keptPaths.push(canonical);
    }
    group.paths = keptPaths;
  }

  // An unreadable-but-present file cannot prove which tree it belongs to in a
  // multi-tree project, so attaching it would be a guess. Instead suppress ALL
  // trees sharing its project directory for this round (their cursors keep the
  // last-good state) — never publish a partial tree.
  const suppressedProjectDirs = new Set(unreadable.map((file) => file.projectDir));

  // A changed path that routes to no current group (e.g. the watcher reported
  // only the OLD path of a moved tree) means we cannot tell which trees were
  // touched — reconcile all of them rather than leaving provenance stale.
  const unroutableChange = changedFiles !== null && [...changedFiles].some((path) =>
    ![...membersByRootKey.values()].some((group) =>
      group.paths.includes(path)
      || path.startsWith(join(sessionsDir, fileByPath.get(group.paths[0]!)?.projectDir ?? '') + sep)));

  const units: IndexUnit[] = [];
  for (const [groupKey, group] of membersByRootKey.entries()) {
    if (divergentGroups.has(groupKey)) continue; // divergent copies: fail closed
    if (suppressedProjectDirs.has(fileByPath.get(group.paths[0]!)?.projectDir ?? '')) continue;
    const rootPath = group.paths.find((path) => rawIdByPath.get(path) === group.rootRawId);
    // The root file is gone (deleted) while children survive: this tree cannot
    // emit a valid session row, and promoting a child would publish a phantom
    // snapshot. Skip the live unit; the tombstone path retracts the identity.
    if (rootPath === undefined) continue;
    const sessionId = dshDbId(group.scope, group.rootRawId);
    const members: TreeMember[] = group.paths
      .sort((a, b) => (a === rootPath ? -1 : b === rootPath ? 1 : a.localeCompare(b)))
      .map((path) => {
        const header = headerByPath.get(path) ?? {};
        const rawId = rawIdByPath.get(path) ?? path.split(sep).slice(-2, -1)[0]!;
        const isSubagent = typeof header.parentSession === 'string' && header.parentSession.length > 0;
        return {
          path,
          rawId,
          dbId: dshDbId(group.scope, rawId),
          agentId: isSubagent ? dshDbId(group.scope, rawId) : null,
          isSubagent,
          header,
        };
      });
    const rootHeader = headerByPath.get(rootPath) ?? {};
    const cursor = ctx.lastCursor(rootPath);
    // Skip only when the checkpoint says the whole tree is unchanged.
    if (changedFiles === null && cursor !== null) {
      const state = decodeCursorState(cursor);
      if (state !== null && treeMatchesState(members, state)) continue;
    }
    // A changed path that matches no current member (e.g. a DELETED child
    // file) still belongs to this tree's project directory — route it here so
    // the tree reparses and the stale rows retract.
    const projectDir = join(sessionsDir, fileByPath.get(group.paths[0]!)?.projectDir ?? '');
    const touched = changedFiles !== null && (
      unroutableChange
      || group.paths.some((path) => changedFiles.has(path))
      || [...changedFiles].some((path) => path.startsWith(projectDir + sep))
    );
    if (changedFiles !== null && !touched) continue;
    units.push({
      key: rootPath,
      sessionId,
      project: projectSlugFromPath(typeof rootHeader.cwd === 'string' ? rootHeader.cwd : null) ?? undefined,
      meta: { kind: 'session-tree', scope: group.scope, rootRawId: group.rootRawId, members } satisfies TreeUnitMeta,
    });
  }

  // Tombstones: indexed deepseek sessions whose IDENTITY no longer exists on
  // disk. Path alone is not enough — a moved root yields a new unit at a new
  // path with the same session id, and a path-keyed tombstone would delete the
  // fresh snapshot right after it was written. And tombstones are only safe
  // when the inventory is complete: an unreadable file or an offline source
  // root must never cascade into deleting last-good snapshots.
  // Identity liveness is computed from ALL groups with a root member —
  // BEFORE the changed-path filter. A cross-directory move reported by the
  // watcher as only the OLD path must not tombstone the moved session.
  const inventoryComplete = existsSync(sessionsDir) && !inventoryProblem;
  const liveSessionIds = new Set(
    [...membersByRootKey.values()]
      .filter((group) => group.paths.some((path) => rawIdByPath.get(path) === group.rootRawId))
      .map((group) => dshDbId(group.scope, group.rootRawId)),
  );
  for (const indexed of inventoryComplete ? (ctx.indexedSessions?.() ?? []) : []) {
    if (liveSessionIds.has(indexed.sessionId)) continue; // moved or still indexed
    const jsonlPath = indexed.jsonlPath;
    if (fileByPath.has(jsonlPath)) continue; // still a member of a discovered tree
    if (probePath(jsonlPath) !== 'gone') continue; // present — or unreachable: keep last-good
    units.push({
      key: jsonlPath,
      sessionId: indexed.sessionId,
      retractSessionIds: [indexed.sessionId],
      meta: { kind: 'session-tree', scope: '', rootRawId: '', members: [] },
    });
  }
  return units;
}

// ---- cursor checkpoint ----

interface MemberCheckpoint {
  agentId: string | null;
  /** sha256 of the header line — identity (id, cwd, createdAt) must not change. */
  headerHash: string;
  inode: number;
  /** Committed frame count (zstd) or non-empty line count (plaintext). */
  count: number;
  /** sha256 over ALL committed entry bytes [0, count) — prefix continuity must
   * cover every committed frame, not just the boundary one: an in-place edit
   * of an earlier frame with an append on top must not read as pure growth. */
  prefixHash: string;
}

const CURSOR_STATE_VERSION = 1;

interface TreeCursorState {
  /** Shape version; an unrecognized/older checkpoint decodes as null and the
   * parse falls back to a full snapshot (self-healing, no migration). */
  v: number;
  /** The session id this checkpoint belongs to — identity changes retract it. */
  sessionId: string;
  members: Record<string, MemberCheckpoint>;
  /** Last message-bearing uuid emitted per member path (parent-chain seed). */
  lastMessageUuid: Record<string, string>;
  /** The seed's own parent per member path: when the first message of a new
   * window belongs to the SAME step as the seed (a step straddling the
   * boundary), its parent is the seed's parent — linking to the seed itself
   * would create a parent cycle once the step's anchor is re-emitted. */
  lastMessageParentUuid: Record<string, string | null>;
  /** Per member path, the "turn:step" steps that already have a tool_use
   * anchor message (canonical or provisional). A durable tool/call lands
   * after its step's assistant/message upstream, and an aborted step's
   * provisional anchor may see further tool/calls in later windows — without
   * this checkpoint both cases re-emit the anchor, downgrading model/usage or
   * rewriting its parent/timestamp. */
  anchorSteps: Record<string, string[]>;
}

function decodeCursorState(cursor: Cursor): TreeCursorState | null {
  if (cursor === null) return null;
  const encoded = cursor.split(':')[2];
  if (encoded === undefined) return null; // legacy or foreign cursor: no state
  try {
    const value: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!isRecord(value) || value.v !== CURSOR_STATE_VERSION) return null;
    if (typeof value.sessionId !== 'string' || !isRecord(value.members)) return null;
    // Defensive defaults for the optional maps — never throw on a missing key.
    return {
      v: CURSOR_STATE_VERSION,
      sessionId: value.sessionId,
      members: value.members as TreeCursorState['members'],
      lastMessageUuid: isRecord(value.lastMessageUuid) ? value.lastMessageUuid as Record<string, string> : {},
      lastMessageParentUuid: isRecord(value.lastMessageParentUuid) ? value.lastMessageParentUuid as Record<string, string | null> : {},
      anchorSteps: isRecord(value.anchorSteps) ? value.anchorSteps as Record<string, string[]> : {},
    };
  } catch {
    return null;
  }
}

function encodeCursor(mtime: number, totalCount: number, state: TreeCursorState): string {
  return `${mtime}:${totalCount}:${Buffer.from(JSON.stringify(state)).toString('base64url')}`;
}

interface MemberSnapshot {
  stat: { mtimeMs: number; size: number; ctimeMs: number; ino: number };
  count: number;
  prefixHash: string;
  headerHash: string;
  /** zstd buffer + frames, or plaintext lines, loaded once per parse. */
  zstd?: { buffer: Buffer; frames: Array<{ start: number; end: number }> };
  lines?: string[];
}

function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

function headerHashOf(header: DshHeader): string {
  return sha256(JSON.stringify([
    header.id ?? null, header.createdAt ?? null, normalizeObservedCwd(header.cwd) ?? null,
    header.parentSession ?? null, header.version ?? null,
  ]));
}

/** Parse the header line out of an already-read artifact buffer (no second read). */
function headerFromBuffer(path: string, buffer: Buffer): DshHeader | null {
  try {
    let firstLine: string | null;
    if (path.endsWith('.jsonl.zstd')) {
      const { frames } = scanZstdFrames(buffer);
      if (frames.length === 0) return null;
      const decoder = createZstdFrameDecoder();
      try {
        const first = decoder.decode(buffer, [frames[0]!]).next();
        firstLine = first.done ? null : firstNonEmptyLine((first.value as Buffer).toString('utf8'));
      } finally {
        decoder.close();
      }
    } else {
      firstLine = firstNonEmptyLine(buffer.toString('utf8'));
    }
    if (firstLine === null) return null;
    const value: unknown = JSON.parse(firstLine);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** sha256 over the committed prefix [0, count) of a snapshot. */
function prefixHashOf(snap: MemberSnapshot, count: number): string {
  const hash = createHash('sha256');
  if (snap.zstd) {
    const end = count === 0 ? 0 : (snap.zstd.frames[count - 1]?.end ?? 0);
    hash.update(snap.zstd.buffer.subarray(0, end));
  } else {
    hash.update((snap.lines ?? []).slice(0, count).join('\n'));
  }
  return hash.digest('hex');
}

/** Load a member file once and compute its fresh checkpoint fields. The stat
 * and the content are read under ONE file descriptor, so a replacement
 * mid-snapshot cannot mix generations (TOCTOU). */
function snapshotMember(path: string): MemberSnapshot | null {
  try {
    // openSync+fstatSync+readFileSync(fd) pin a single file generation.
    const fd = openSync(path, 'r');
    let stat;
    let buffer: Buffer;
    try {
      stat = fstatSync(fd);
      buffer = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
    const header = headerFromBuffer(path, buffer);
    if (header === null) return null;
    if (path.endsWith('.jsonl.zstd')) {
      const buffer = readFileSync(path);
      const { frames } = scanZstdFrames(buffer);
      const snap: MemberSnapshot = {
        stat: { mtimeMs: stat.mtimeMs, size: stat.size, ctimeMs: stat.ctimeMs, ino: stat.ino },
        count: frames.length,
        prefixHash: '',
        headerHash: headerHashOf(header),
        zstd: { buffer, frames },
      };
      snap.prefixHash = prefixHashOf(snap, snap.count);
      return snap;
    }
    const lines = buffer.toString('utf8').split('\n').filter((line) => line.trim().length > 0);
    const snap: MemberSnapshot = {
      stat: { mtimeMs: stat.mtimeMs, size: stat.size, ctimeMs: stat.ctimeMs, ino: stat.ino },
      count: lines.length,
      prefixHash: '',
      headerHash: headerHashOf(header),
      lines,
    };
    snap.prefixHash = prefixHashOf(snap, snap.count);
    return snap;
  } catch {
    return null;
  }
}

/** Fast-path preconditions for one member against its checkpoint. */
function memberMatchesCheckpoint(member: TreeMember, snap: MemberSnapshot, cp: MemberCheckpoint): boolean {
  return snap.headerHash === cp.headerHash
    && snap.stat.ino === cp.inode
    && snap.count >= cp.count
    && prefixHashOf(snap, cp.count) === cp.prefixHash;
}

/** Whether the whole tree matches the checkpoint (used by discovery's skip gate). */
function treeMatchesState(members: TreeMember[], state: TreeCursorState): boolean {
  const statePaths = Object.keys(state.members).sort();
  const memberPaths = members.map((member) => member.path).sort();
  if (statePaths.length !== memberPaths.length || statePaths.some((path, i) => path !== memberPaths[i])) return false;
  for (const member of members) {
    const cp = state.members[member.path]!;
    const snap = snapshotMember(member.path);
    if (snap === null) return false;
    if (snap.headerHash !== cp.headerHash || snap.stat.ino !== cp.inode) return false;
    if (snap.count !== cp.count || snap.prefixHash !== cp.prefixHash) return false;
    if ((member.agentId ?? null) !== cp.agentId) return false;
  }
  return true;
}

// ---- parse: two paths over one root tree ----

function memberText(snap: MemberSnapshot, fromCount: number): string {
  if (snap.zstd) return decodeFrames(snap.zstd.buffer, snap.zstd.frames, fromCount);
  return (snap.lines ?? []).slice(fromCount).join('\n');
}

const timestampOfMs = (time: number | null): string | null => (
  time !== null && Number.isFinite(time) ? new Date(time).toISOString() : null
);

function* parse(unit: IndexUnit, cursor: Cursor): Generator<TranscriptRecord, Cursor> {
  const meta = unit.meta as TreeUnitMeta;
  if (meta.members.length === 0) return null; // tombstone: persist retracts via retractSessionIds

  const sessionId = unit.sessionId;
  const prior = decodeCursorState(cursor);
  const snaps = new Map<string, MemberSnapshot>();
  for (const member of meta.members) {
    const snap = snapshotMember(member.path);
    if (snap === null) {
      // Fail closed (ADR-0001): a member that exists in discovery but cannot be
      // read/snapshotted right now must not produce a partial tree — and must
      // never trigger the fallback's delete-session. Keep the last-good state.
      return cursor;
    }
    // TOCTOU guard: the unit's identity was resolved from a header read at
    // discovery time; if the file was replaced between that read and this
    // snapshot, mixing the stale identity with fresh content would publish a
    // mixed-generation snapshot. Bail — the next discovery re-reads headers
    // and routes the new identity correctly.
    if (snap.headerHash !== headerHashOf(member.header)) return cursor;
    snaps.set(member.path, snap);
  }

  const priorPaths = prior === null ? [] : Object.keys(prior.members).sort();
  const memberPaths = meta.members.map((member) => member.path).sort();
  const sameMemberSet = priorPaths.length === memberPaths.length && priorPaths.every((path, i) => path === memberPaths[i]);
  const fast = prior !== null && sameMemberSet && meta.members.every((member) => {
    const snap = snaps.get(member.path);
    const cp = prior.members[member.path];
    return snap !== undefined && cp !== undefined && memberMatchesCheckpoint(member, snap, cp);
  });

  const recordsOut: TranscriptRecord[] = [];
  if (!fast) {
    // Snapshot fallback always retracts before re-emitting — including the
    // prior-less case, which covers a MOVED tree (the new path has no cursor,
    // but the identity's old rows may be stale or truncated-away). The cascade
    // is safe because this unit re-emits the whole tree below. The prior
    // identity may differ from the current one when the header's id/cwd
    // changed; retract both.
    recordsOut.push({ kind: 'delete-session', sessionId });
    if (prior !== null && prior.sessionId !== sessionId) {
      recordsOut.push({ kind: 'delete-session', sessionId: prior.sessionId });
    }
  }

  let title: string | null = null;
  let endedAt: string | null = null;
  let mainMessageCount = 0;
  // Subagent rows are contributed by both sides of the delegation (the parent's
  // spawn result text carries parent_tool_use_id; the child's descriptor
  // carries metadata) — collect both and emit ONE merged record per agent so a
  // fresh parse assembles exactly like the persisted COALESCE merge (ADR-0007).
  const subagentParts = new Map<string, {
    parent_tool_use_id?: string | null;
    agent_type?: string | null;
    description?: string | null;
    duration_ms?: number | null;
  }>();
  const subagentPart = (agent: string) => {
    const part = subagentParts.get(agent) ?? {};
    subagentParts.set(agent, part);
    return part;
  };
  let maxMtime = 0;
  let totalCount = 0;
  const nextState: TreeCursorState = { v: CURSOR_STATE_VERSION, sessionId, members: {}, lastMessageUuid: {}, lastMessageParentUuid: {}, anchorSteps: {} };

  for (const member of meta.members) {
    const snap = snaps.get(member.path);
    if (snap === undefined) continue;
    const { header, dbId } = member;
    const agentId = member.agentId;
    const isSubagent = member.isSubagent;
    const cwd = typeof header.cwd === 'string' ? header.cwd : null;
    const fromCount = fast ? prior!.members[member.path]!.count : 0;
    const records = readLogRecords(memberText(snap, fromCount));

    // Steps whose assistant/message is inside this window emit their own
    // canonical tool_use anchor; a durable tool/call for such a step must not
    // emit a provisional anchor over it (the canonical row carries model/usage).
    const stepsWithCanonicalAnchor = new Set<string>();
    for (const record of records) {
      if (record.type !== 'assistant/message') continue;
      const message = isRecord(record.data.message) ? record.data.message : {};
      if (classifyAssistantContent(message.content).hasToolCalls) {
        stepsWithCanonicalAnchor.add(`${record.data.turn}:${record.data.step}`);
      }
    }

    let lastMessageUuid: string | null = fast ? (prior!.lastMessageUuid[member.path] ?? null) : null;
    let lastMessageParentUuid: string | null = fast ? (prior!.lastMessageParentUuid[member.path] ?? null) : null;
    // The checkpointed seed belongs to the previous window; if the first
    // message of this window is from the SAME step (a step straddling the
    // boundary), its parent is the seed's parent — linking to the seed would
    // create a parent cycle once the step's anchor is re-emitted.
    let seedPending = fast && lastMessageUuid !== null;
    const seedUuid = lastMessageUuid;
    const seedParentUuid = lastMessageParentUuid;
    let currentModel: string | null = null;
    let memberEndedAt: string | null = null;
    const emittedAnchors = new Set<string>();
    const anchorSteps = new Set<string>(fast ? (prior!.anchorSteps[member.path] ?? []) : []);
    const hasAnchor = (turn: unknown, step: unknown) => anchorSteps.has(`${turn}:${step}`);
    let subagentDescriptor: Record<string, unknown> | null = null;

    const updateEndedAt = (timestamp: string | null): void => {
      if (timestamp !== null && (endedAt === null || timestamp > endedAt)) endedAt = timestamp;
    };
    const pushMessage = (record: MessageRecord): void => {
      if (seedPending && seedUuid !== null && record.parent_uuid === seedUuid
        && stepKeyOf(record.uuid) !== null && stepKeyOf(record.uuid) === stepKeyOf(seedUuid)) {
        record.parent_uuid = seedParentUuid;
      }
      seedPending = false;
      // A re-emitted anchor can be its own seeded parent (two tool/calls of one
      // step straddling the checkpoint): never self-link, or trace()/context()
      // would loop forever.
      if (record.parent_uuid === record.uuid) record.parent_uuid = null;
      recordsOut.push(record);
      lastMessageUuid = record.uuid;
      lastMessageParentUuid = record.parent_uuid;
      // Synthetic tool_use anchors are structural, not transcript content, and
      // are re-emittable across runs (a step's tool/call and assistant/message
      // can land in different windows): counting them would inflate
      // message_count on every straddle.
      if (agentId === null && record.visibility === 'visible' && record.content_type !== 'tool_use') mainMessageCount++;
      updateEndedAt(record.timestamp);
    };

    for (const record of records) {
      const timestamp = timestampOfMs(record.time);
      updateEndedAt(timestamp);
      if (timestamp !== null && (memberEndedAt === null || timestamp > memberEndedAt)) memberEndedAt = timestamp;
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
          if (!isSubagent && typeof candidate === 'string' && candidate.length > 0) title = candidate;
          break;
        }
        case 'user/message': {
          const content = record.data.content;
          const text = joinPartText(content, 'text');
          const sourceKind = isRecord(record.data.source) ? record.data.source.kind : undefined;
          const isMeta = sourceKind !== 'user' ? 1 : 0;
          pushMessage({
            kind: 'message', uuid: userMessageUuid(dbId, record.data.id, record.seq),
            session_id: sessionId, type: 'user', parent_uuid: lastMessageUuid,
            timestamp, role: 'user', text: trunc(text),
            content_type: text !== null ? 'text' : 'unknown', is_meta: isMeta,
            visibility: 'visible', model: null, is_sidechain: isSubagent ? 1 : 0, agent_id: agentId,
            input_tokens: null, output_tokens: null, cwd, skill: null, source: 'deepseek',
          });
          break;
        }
        case 'assistant/message': {
          const message = isRecord(record.data.message) ? record.data.message : {};
          const turn = record.data.turn;
          const step = record.data.step;
          const { reasoningText, visibleText, hasToolCalls } = classifyAssistantContent(message.content);
          const usage = record.data.usage;
          const inTokens = totalInputTokens(usage);
          const outTokens = outputTokens(usage);
          const model = isRecord(message.source) && typeof message.source.model === 'string'
            ? message.source.model
            : currentModel;

          const reasoningUuid = reasoningText !== null ? assistantMessageUuid(dbId, turn, step, 'reasoning') : null;
          // A step with no projectable parts still emits a (text-less) message
          // so its usage is never dropped (CONTRIBUTING: content_type 'unknown').
          const textUuid = visibleText !== null || (reasoningText === null && !hasToolCalls)
            ? assistantMessageUuid(dbId, turn, step, 'text')
            : null;
          const toolUseAnchor = hasToolCalls ? toolUseUuid(dbId, turn, step) : null;
          // Usage lands on the primary (visible) message for this step: the text
          // message when present, else the tool_use anchor, else the thinking one.
          const tokensUuid = textUuid ?? toolUseAnchor ?? reasoningUuid;
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
              content_type: visibleText !== null ? 'text' : 'unknown',
              input_tokens: tokensFor(textUuid), output_tokens: tokensOutFor(textUuid), ...base,
            });
          }
          if (toolUseAnchor !== null) {
            emittedAnchors.add(toolUseAnchor);
            anchorSteps.add(`${turn}:${step}`);
            pushMessage({
              kind: 'message', uuid: toolUseAnchor, parent_uuid: lastMessageUuid, text: null,
              content_type: 'tool_use', input_tokens: tokensFor(toolUseAnchor), output_tokens: tokensOutFor(toolUseAnchor), ...base,
            });
          }
          // tool_call records come from the durable tool/call events, not from
          // the content parts (a step's tool/call may land in an earlier frame).
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
          const anchor = toolUseUuid(dbId, data.turn, data.step);
          // The anchor message must exist even when this step's assistant/message
          // has no tool-call part (or never landed): tool_calls and tool_results
          // are filtered by message_uuid downstream, and the ADR-0008 nonce
          // resolver walks this anchor to the session.
          if (!emittedAnchors.has(anchor) && !stepsWithCanonicalAnchor.has(`${data.turn}:${data.step}`) && !hasAnchor(data.turn, data.step)) {
            emittedAnchors.add(anchor);
            anchorSteps.add(`${data.turn}:${data.step}`);
            pushMessage({
              kind: 'message', uuid: anchor, session_id: sessionId, type: 'assistant',
              parent_uuid: lastMessageUuid, timestamp, role: 'assistant', text: null,
              content_type: 'tool_use', is_meta: 0, visibility: 'visible', model: currentModel,
              is_sidechain: isSubagent ? 1 : 0, agent_id: agentId,
              input_tokens: null, output_tokens: null, cwd, skill: null, source: 'deepseek',
            });
          }
          recordsOut.push({
            kind: 'tool_call', id: callId(dbId, nativeCallId),
            message_uuid: anchor, session_id: sessionId,
            name: toolName, presentation: toolName === 'skill' ? 'skill' : 'default',
            input_json: truncJson(args) ?? '{}', file_path: dshToolFilePath(toolName, isRecord(args) ? args : null),
          });
          break;
        }
        case 'tool/result': {
          const message = isRecord(record.data.message) ? record.data.message : {};
          const source = isRecord(message.source) ? message.source : {};
          if (typeof source.callId !== 'string') break;
          const toolId = callId(dbId, source.callId);
          const content = toolResultContent(message.content);
          recordsOut.push({
            kind: 'tool_result', tool_use_id: toolId,
            message_uuid: toolUseUuid(dbId, record.data.turn, record.data.step),
            session_id: sessionId, content: trunc(content), file_path: null,
            is_error: toolResultIsError(record.data, message.content),
          });
          // Subagent spawns are self-contained in their result text, so the link
          // survives any parse window (the spawn tool/call may be in an earlier frame).
          const match = SUBAGENT_RESULT_RE.exec(content);
          if (match !== null && match[1]) {
            subagentPart(dshDbId(meta.scope, match[1])).parent_tool_use_id = toolId;
          }
          break;
        }
        default:
          break;
      }
    }

    if (isSubagent) {
      const descriptor = subagentDescriptor ?? {};
      // Continuable-mode descriptors carry agentProvider/agentModel; one-shot
      // descriptors only carry `provider` (the subagents provider name).
      const agentType = typeof descriptor.agentProvider === 'string'
        ? descriptor.agentProvider
        : typeof descriptor.agentModel === 'string'
          ? descriptor.agentModel
          : typeof descriptor.provider === 'string'
            ? descriptor.provider
            : null;
      const part = subagentPart(agentId as string);
      part.agent_type = agentType;
      part.description = typeof descriptor.label === 'string' ? descriptor.label : null;
      const startedMs = typeof header.createdAt === 'number' ? header.createdAt : null;
      // Duration spans the member's own events, not the tree-wide endedAt.
      const endedMs = memberEndedAt !== null ? new Date(memberEndedAt).getTime() : null;
      part.duration_ms = startedMs !== null && endedMs !== null ? Math.max(0, endedMs - startedMs) : null;
      // total_tokens is derived at query time from the sidechain messages (ADR-0010).
    }
    if (lastMessageUuid !== null) {
      nextState.lastMessageUuid[member.path] = lastMessageUuid;
      nextState.lastMessageParentUuid[member.path] = lastMessageParentUuid;
    }
    if (anchorSteps.size > 0) nextState.anchorSteps[member.path] = [...anchorSteps];
    nextState.members[member.path] = {
      agentId: member.agentId,
      headerHash: snap.headerHash,
      inode: snap.stat.ino,
      count: snap.count,
      prefixHash: snap.prefixHash,
    };
    maxMtime = Math.max(maxMtime, snap.stat.mtimeMs);
    totalCount += snap.count;
  }

  for (const [agent, part] of subagentParts) {
    recordsOut.push({ kind: 'subagent', agent_id: agent, session_id: sessionId, ...part });
  }

  const rootHeader = meta.members[0]?.header ?? {};
  recordsOut.push({
    kind: 'session', id: sessionId, title,
    project: projectSlugFromPath(typeof rootHeader.cwd === 'string' ? rootHeader.cwd : null) ?? unit.project ?? null,
    started_at: typeof rootHeader.createdAt === 'number' ? new Date(rootHeader.createdAt).toISOString() : null,
    ended_at: endedAt, git_branch: null,
    version: typeof rootHeader.version === 'number' ? String(rootHeader.version) : null,
    message_count: mainMessageCount, countMode: fast ? 'delta' : 'total',
    jsonl_path: unit.key, source: 'deepseek',
  });

  // A tree is one session timeline: emit messages in the same canonical
  // (timestamp, uuid) order the SQLite round-trip uses, so a fresh parse and
  // a persisted read assemble identically (ADR-0007). Non-message records are
  // keyed maps downstream; their emission order is irrelevant.
  const messages = recordsOut.filter((r) => r.kind === 'message') as MessageRecord[];
  messages.sort((a, b) => (a.timestamp ?? '') === (b.timestamp ?? '')
    ? a.uuid.localeCompare(b.uuid)
    : (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
  const others = recordsOut.filter((r) => r.kind !== 'message');
  yield* [...others, ...messages];
  return encodeCursor(maxMtime, totalCount, nextState);
}

// ---- raw ----

function rawDeepseek(rootDir: string, input: RawLookup): RawRecord | null {
  const uuid = input.messageUuid;
  let rawSessionId: string | null = null;
  let scope: string | null = null;
  let finder: ((value: Record<string, unknown>) => boolean) | null = null;
  const userMatch = /^deepseek:([^:]+):([0-9a-f]{64}):u(.+)$/.exec(uuid);
  const assistantMatch = /^deepseek:([^:]+):([0-9a-f]{64}):t(\d+):s(\d+):(reasoning|text|tool_use)$/.exec(uuid);
  if (userMatch !== null) {
    rawSessionId = decodeURIComponent(userMatch[1]!);
    scope = userMatch[2]!;
    const captured = userMatch[3]!;
    finder = (value) => (
      value.type === 'user/message'
      && isRecord(value.data)
      && (value.data.id === captured || value.seq === Number(captured))
    );
  } else if (assistantMatch !== null) {
    rawSessionId = decodeURIComponent(assistantMatch[1]!);
    scope = assistantMatch[2]!;
    const turn = Number(assistantMatch[3]);
    const step = Number(assistantMatch[4]);
    finder = (value) => (
      value.type === 'assistant/message'
      && isRecord(value.data)
      && value.data.turn === turn
      && value.data.step === step
    );
  }
  if (rawSessionId === null || finder === null) return null;
  if (input.agentId !== null && typeof input.agentId === 'string') {
    const agentMatch = /^deepseek:([^:]+):([0-9a-f]{64})$/.exec(input.agentId);
    if (agentMatch !== null && agentMatch[1]) {
      rawSessionId = decodeURIComponent(agentMatch[1]);
      scope = agentMatch[2]!;
    }
  }
  const path = typeof input.session?.jsonl_path === 'string' && input.agentId === null
    ? input.session.jsonl_path
    : findSessionFile(rootDir, rawSessionId, scope);
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

/** Resolve the DeepSeek Harness sessions root: `$DSH_HOME/sessions` or `~/.dsh/sessions`. */
function deepseekSessionsRoot(): string {
  const env = process.env.DSH_HOME;
  const home = env !== undefined && env.trim().length > 0 ? env : join(homedir(), '.dsh');
  return join(home, 'sessions');
}

export function createDeepseekProvider({ rootDir = deepseekSessionsRoot() }: { rootDir?: string } = {}): ProviderAdapter {
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
