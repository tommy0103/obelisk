// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// MiniMax Code (mcode) v2 provider adapter.
//
// Source layout:
// - Root: `$MINIMAX_DATA_DIR` > `$MAVIS_DATA_DIR` > `~/.minimax`
// - Sessions: `<root>/v2/sessions/YYYY/MM/DD/<sessionDir>/` with `manifest.json`,
//   `messages.jsonl`, and optional `snapshots/gNNNNNNNNNNNN--<compactionId>.jsonl`
// - Metadata: `<root>/v2/sqlite/runtime-state.sqlite` (`local_runtime_sessions`, WAL mode)
//
// Three-tier indexing strategy (aligned with codex / deepseek):
// 1. Metadata-only patch: when `messages.jsonl` is unchanged and only SQLite
//    `title` / `updatedAtMs` advanced, emit a single `session` record (zero delete).
// 2. Case A steady-state append: same generation, device, inode, non-decreasing
//    size, and matching prefix (`tailHash` in `normal` mode, full `prefixHash` in
//    `strict` mode when `prefixVerified` holds) append only new complete lines
//    (`countMode: 'total'`, zero delete).
// 3. Case C safety net: compactions (`llm_checkpoint`, `tool_archive`, `tool_trim`),
//    rewinds, directory switches, structural metadata changes, or failed/unverified
//    prefix checks emit `delete-session` and replay the reachable snapshot chain.

import { createHash } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  type BigIntStats,
  type Dirent,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

import {
  filePath as toolFilePath,
  normalizeObservedCwd,
  projectSlugFromPath,
  sourceInventoryIssue,
  trunc,
  truncJson,
} from '../parsing.ts';
import type { SqliteDb } from '../sqlite-types.ts';
import type {
  Cursor,
  DiscoverContext,
  HarnessKind,
  IndexUnit,
  InventoryIssue,
  MessageRecord,
  MessageVisibility,
  ProviderAdapter,
  RawLookup,
  RawRecord,
  SummaryRecord,
  ToolCallRecord,
  ToolResultRecord,
  TranscriptRecord,
  WatchTarget,
} from './types.ts';

export type MinimaxDatabaseOpener = (path: string) => SqliteDb;

const SOURCE = 'minimax';
const MINIMAX_CANONICAL_TRANSCRIPT_MARKER = '__minimax_canonical_transcript_v1__';
const CURSOR_TAG = 'minimax-v3';
const TOMBSTONE_CURSOR = `0:0:${CURSOR_TAG}:tombstone`;
const SNAPSHOT_FILE_RE = /^g(\d{12})--([A-Za-z0-9][A-Za-z0-9._-]*)\.jsonl$/;
const TAIL_HASH_BYTES = 512;
const PREFIX_HASH_CHUNK_BYTES = 64 * 1024;
const MAX_FIRST_ENVELOPE_BYTES = 64 * 1024 * 1024;
const MAX_CURSOR_SEEN_IDS = 10_000;
const BUSY_TIMEOUT_MS = 500;
const MAX_SNAPSHOT_DEPTH = 10_000;
const WORKTREE_FORK_REMINDER_RE = /^<system-reminder>[\s\S]*<\/system-reminder>$/;
const TITLE_WRAPPER_TAGS = [
  'system-reminder',
  'user_info',
  'command-name',
  'command-message',
  'command-args',
  'local-command-stdout',
  'local-command-stderr',
] as const;

type JsonRecord = Record<string, unknown>;

interface MinimaxManifest {
  readonly schemaVersion: number;
  readonly sessionId: string;
  readonly createdAtMs: number | null;
  readonly updatedAtMs: number | null;
}

type ManifestReadResult =
  | { readonly kind: 'ok'; readonly manifest: MinimaxManifest }
  | { readonly kind: 'missing' }
  | { readonly kind: 'io-error'; readonly error: unknown }
  | { readonly kind: 'corrupt'; readonly error: string }
  | { readonly kind: 'unsupported'; readonly schemaVersion: unknown; readonly sessionId: string | null };

interface MinimaxSqliteMeta {
  readonly title: string | null;
  readonly cwd: string | null;
  readonly sessionKind: string | null;
  readonly visibility: string | null;
  readonly historyRelativeDir: string | null;
  readonly createdAtMs: number | null;
  readonly updatedAtMs: number | null;
}

type SqliteMetadataResult =
  | { readonly ok: true; readonly bySessionId: Map<string, MinimaxSqliteMeta> }
  | { readonly ok: false; readonly issue: InventoryIssue };

interface MinimaxUnitMeta {
  readonly kind: 'session' | 'tombstone';
  readonly sessionDir: string;
  readonly rawSessionId: string;
  readonly title: string | null;
  readonly cwd: string | null;
  readonly startedBy: 'agent' | null;
  readonly createdAtMs: number | null;
  readonly updatedAtMs: number | null;
  readonly structuralMetaHash: string;
  readonly replaceExisting: boolean;
  readonly readMode?: 'normal' | 'strict';
}

interface MinimaxCursorState {
  readonly v: 3;
  readonly generation: number;
  readonly dev: string;
  readonly ino: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly offset: number;
  readonly tailHash: string;
  readonly tailLen: number;
  readonly prefixHash: string;
  readonly prefixVerified: boolean;
  readonly lastMessageId: string | null;
  readonly lastMessageUuid: string | null;
  readonly seenIdHashes: readonly string[];
  readonly seenTruncated: boolean;
  readonly pendingTools: ReadonlyArray<readonly [string, string | null]>;
  readonly visibleCount: number;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly maxMessageTimestamp: string | null;
  readonly derivedTitle: string | null;
  readonly sqliteTitle: string | null;
  readonly sqliteUpdatedAtMs: number | null;
  readonly structuralMetaHash: string;
}

interface ParentSnapshotRef {
  readonly generation: number;
  readonly compactionId: string;
  readonly revision: string | null;
}

interface HistoryArtifactHead {
  readonly supported: boolean;
  readonly schemaVersion: unknown;
  readonly generation: number;
  readonly producedBy: string | null;
  readonly parentSnapshot: ParentSnapshotRef | null;
}

interface ParsedEnvelopeLine {
  readonly raw: string;
  readonly messageId: string;
  readonly turnId: string | null;
  readonly message: JsonRecord;
  readonly historyArtifact: HistoryArtifactHead | null;
}

type FirstEnvelopeResult =
  | { readonly kind: 'ok'; readonly envelope: ParsedEnvelopeLine | null }
  | { readonly kind: 'oversized' };

type SnapshotPathResult =
  | { readonly kind: 'ok'; readonly path: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'error'; readonly path: string; readonly error: unknown; readonly isIoError: boolean };

type ReachableFilesResult =
  | { readonly ok: true; readonly files: string[] }
  | { readonly ok: false; readonly path: string; readonly error: unknown; readonly isIoError: boolean };

interface ProjectionState {
  lastMessageUuid: string | null;
  readonly pendingTools: Map<string, string | null>;
  readonly seenIdHashes: Set<string>;
  visibleCount: number;
  startedAt: string | null;
  maxMessageTimestamp: string | null;
  derivedTitle: string | null;
}

const require = createRequire(import.meta.url);

function defaultOpenDatabase(dbPath: string): SqliteDb {
  // Defer node:sqlite so Electron bundlers do not hoist the Node-only binding.
  const specifier = ['node', 'sqlite'].join(':');
  const { DatabaseSync } = require(specifier) as {
    DatabaseSync: new (path: string, options: { readOnly: boolean; timeout: number }) => SqliteDb;
  };
  return new DatabaseSync(dbPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
}

function expandHome(rawPath: string, homeDir: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === '~') return homeDir;
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return join(homeDir, trimmed.slice(2));
  }
  return trimmed;
}

/** @internal Exported for tests. */
export function defaultMinimaxRoot({
  homeDir = homedir(),
  env = process.env,
}: {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
} = {}): string {
  const minimaxDir = env['MINIMAX_DATA_DIR']?.trim();
  if (minimaxDir) return resolve(expandHome(minimaxDir, homeDir));
  const mavisDir = env['MAVIS_DATA_DIR']?.trim();
  if (mavisDir) return resolve(expandHome(mavisDir, homeDir));
  return resolve(join(homeDir, '.minimax'));
}

function resolveMinimaxRoot(rootDir: string | undefined, homeDir: string): string {
  const trimmed = rootDir?.trim() ?? '';
  if (trimmed.length > 0) return resolve(expandHome(trimmed, homeDir));
  return defaultMinimaxRoot({ homeDir });
}

/** @internal Exported for tests. */
export function minimaxSessionId(rawSessionId: string): string {
  return `${SOURCE}:${encodeURIComponent(rawSessionId)}`;
}

function isInsideDir(parentDir: string, targetPath: string): boolean {
  const rel = relative(normalize(parentDir), normalize(targetPath));
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function safeRealpath(targetPath: string): string | null {
  try {
    return realpathSync(targetPath);
  } catch {
    // Missing paths or dangling symlinks have no resolved target.
    return null;
  }
}

function watchPathOnDisk(targetPath: string): string {
  // Resolve the closest surviving ancestor so deleted paths under symlinked roots still match physical paths.
  let ancestor = normalize(targetPath);
  for (;;) {
    const resolved = safeRealpath(ancestor);
    if (resolved !== null) return normalize(join(resolved, relative(ancestor, targetPath)));
    const parent = dirname(ancestor);
    if (parent === ancestor) return normalize(targetPath);
    ancestor = parent;
  }
}

function pathInsideRoot(rootDir: string, candidatePath: string): boolean {
  if (isInsideDir(rootDir, candidatePath)) return true;
  return isInsideDir(watchPathOnDisk(rootDir), watchPathOnDisk(candidatePath));
}

function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeTime(value: unknown): string | null {
  // Upstream uses timestamp: 0 for synthetic worktree-fork control messages; treat <= 0 as absent.
  if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 8.64e15) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string' && value.trim().length > 0 && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return null;
}

function minIso(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

function maxIso(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function messageIdDigest(messageId: string): string {
  return sha256Hex(messageId).slice(0, 16);
}

function toWellFormedText(s: string): string {
  // Replace lone UTF-16 surrogates with U+FFFD so in-memory records match SQLite UTF-8 storage (ADR-0007).
  const fn = (s as unknown as { toWellFormed?: () => string }).toWellFormed;
  if (typeof fn === 'function') return fn.call(s);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s[i]! + s[i + 1]!;
        i++;
      } else {
        out += '\ufffd';
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += '\ufffd';
    } else {
      out += s[i]!;
    }
  }
  return out;
}

function cleanTrunc(s: string, limit?: number): string {
  return trunc(toWellFormedText(s), limit);
}

function cleanTruncJson(value: unknown, limit?: number): string | null {
  const serialized = truncJson(value, limit);
  return serialized === null ? null : toWellFormedText(serialized);
}

function fullJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const serialized = JSON.stringify(value);
  return serialized === undefined ? null : toWellFormedText(serialized);
}

function deriveTitleFromText(text: string): string | null {
  let cleaned = toWellFormedText(text).trim();
  for (const tag of TITLE_WRAPPER_TAGS) {
    cleaned = cleaned.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'gi'), ' ');
  }
  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('<')) continue;
    return trunc(line, 200);
  }
  return null;
}

function computeStructuralMetaHash(fields: {
  sessionId: string;
  schemaVersion: number;
  createdAtMs: number | null;
  cwd: string | null;
  startedBy: 'agent' | null;
}): string {
  return sha256Hex(JSON.stringify(fields)).slice(0, 24);
}

function utcSessionRelativeDir(sessionId: string, createdAtMs: number): string {
  const date = new Date(createdAtMs);
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  const mmm = String(date.getUTCMilliseconds()).padStart(3, '0');
  const encoded = `session_${Buffer.from(sessionId || 'unknown-session', 'utf8')
    .toString('base64url')
    .slice(0, 180)}`;
  return `${year}/${month}/${day}/${hh}-${mm}-${ss}-${mmm}-${encoded}`;
}

function readTailHash(filePath: string, offset: number): { tailHash: string; tailLen: number } {
  if (offset <= 0) return { tailHash: sha256Hex(Buffer.alloc(0)), tailLen: 0 };
  const tailLen = Math.min(offset, TAIL_HASH_BYTES);
  const start = offset - tailLen;
  const buf = Buffer.allocUnsafe(tailLen);
  const fd = openSync(filePath, 'r');
  try {
    let totalRead = 0;
    while (totalRead < tailLen) {
      const n = readSync(fd, buf, totalRead, tailLen - totalRead, start + totalRead);
      if (n <= 0) break;
      totalRead += n;
    }
    return {
      tailHash: sha256Hex(buf.subarray(0, totalRead)),
      tailLen: totalRead,
    };
  } finally {
    closeSync(fd);
  }
}

function sha256FilePrefix(filePath: string, offset: number): string | null {
  if (offset < 0) return null;
  if (offset === 0) return sha256Hex(Buffer.alloc(0));
  const hash = createHash('sha256');
  const buf = Buffer.allocUnsafe(Math.min(offset, PREFIX_HASH_CHUNK_BYTES));
  const fd = openSync(filePath, 'r');
  let remaining = offset;
  let pos = 0;
  try {
    while (remaining > 0) {
      const want = Math.min(remaining, buf.length);
      const n = readSync(fd, buf, 0, want, pos);
      if (n <= 0) return null;
      hash.update(buf.subarray(0, n));
      pos += n;
      remaining -= n;
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

function encodeCursor(stat: BigIntStats, state: MinimaxCursorState): string {
  const mtimeMs = Number(stat.mtimeNs / 1_000_000n);
  return `${mtimeMs}:${state.offset}:${CURSOR_TAG}:${JSON.stringify(state)}`;
}

function decodeCursor(cursor: Cursor): MinimaxCursorState | null {
  if (!cursor) return null;
  const tagMarker = `:${CURSOR_TAG}:`;
  const idx = cursor.indexOf(tagMarker);
  if (idx < 0) return null;
  try {
    const parsed = JSON.parse(cursor.slice(idx + tagMarker.length)) as unknown;
    const obj = asRecord(parsed);
    if (
      obj === null ||
      obj['v'] !== 3 ||
      typeof obj['generation'] !== 'number' ||
      typeof obj['dev'] !== 'string' ||
      typeof obj['ino'] !== 'string' ||
      typeof obj['size'] !== 'string' ||
      typeof obj['mtimeNs'] !== 'string' ||
      typeof obj['ctimeNs'] !== 'string' ||
      typeof obj['offset'] !== 'number' ||
      !Number.isSafeInteger(obj['offset']) ||
      obj['offset'] < 0 ||
      typeof obj['tailHash'] !== 'string' ||
      typeof obj['tailLen'] !== 'number' ||
      typeof obj['prefixHash'] !== 'string' ||
      typeof obj['prefixVerified'] !== 'boolean' ||
      !Array.isArray(obj['seenIdHashes']) ||
      typeof obj['seenTruncated'] !== 'boolean' ||
      !Array.isArray(obj['pendingTools']) ||
      typeof obj['visibleCount'] !== 'number' ||
      typeof obj['structuralMetaHash'] !== 'string'
    ) {
      return null;
    }
    return parsed as MinimaxCursorState;
  } catch {
    // Unknown or legacy cursor formats degrade cleanly to a full replay.
    return null;
  }
}

function statMatchesCursor(stat: BigIntStats, cursor: MinimaxCursorState): boolean {
  return (
    String(stat.dev) === cursor.dev &&
    String(stat.ino) === cursor.ino &&
    String(stat.size) === cursor.size &&
    String(stat.mtimeNs) === cursor.mtimeNs &&
    String(stat.ctimeNs) === cursor.ctimeNs
  );
}

// ---- SQLite enrichment (fail-closed when present but unreadable) -----------

function parseLegacyRecordJson(raw: unknown): JsonRecord | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    // Malformed legacy record_json degrades to missing fields for that row.
    return null;
  }
}

function readSqliteMetadata(
  root: string,
  openDatabase: MinimaxDatabaseOpener,
): SqliteMetadataResult {
  const result = new Map<string, MinimaxSqliteMeta>();
  const dbPath = join(root, 'v2', 'sqlite', 'runtime-state.sqlite');
  let info;
  try {
    info = lstatSync(dbPath);
  } catch (error) {
    if (isMissingError(error)) {
      return { ok: true, bySessionId: result };
    }
    return { ok: false, issue: sourceInventoryIssue(dbPath, error) };
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    return {
      ok: false,
      issue: { path: dbPath, error: 'MiniMax SQLite store is not a regular file' },
    };
  }

  let db: SqliteDb;
  try {
    db = openDatabase(dbPath);
  } catch (error) {
    return { ok: false, issue: sourceInventoryIssue(dbPath, error) };
  }
  try {
    const columns = new Set(
      db.prepare('PRAGMA table_info(local_runtime_sessions)').all().map((row) => String(row['name'])),
    );
    if (!columns.has('session_id')) {
      return {
        ok: false,
        issue: { path: dbPath, error: 'MiniMax SQLite store is missing local_runtime_sessions.session_id' },
      };
    }
    const optionalCols = [
      'record_json',
      'columnar_version',
      'title',
      'workspace_dir',
      'project_workspace_dir',
      'session_kind',
      'visibility',
      'history_relative_dir',
      'created_at_ms',
      'updated_at_ms',
    ].filter((col) => columns.has(col));
    const selectList = ['session_id', ...optionalCols].join(', ');
    const rows = db.prepare(`SELECT ${selectList} FROM local_runtime_sessions`).all();
    for (const row of rows) {
      const sid = asNonEmptyString(row['session_id']);
      if (sid === null) continue;
      const columnarVersion = asFiniteNumber(row['columnar_version']);
      const useLegacyJson = columnarVersion === null || columnarVersion < 3;
      const legacy = useLegacyJson ? parseLegacyRecordJson(row['record_json']) : null;

      const rawTitle = asNonEmptyString(row['title']) ?? asNonEmptyString(legacy?.['title']);
      const title = rawTitle !== null ? toWellFormedText(rawTitle) : null;
      const cwd =
        normalizeObservedCwd(row['workspace_dir']) ??
        normalizeObservedCwd(row['project_workspace_dir']) ??
        normalizeObservedCwd(legacy?.['workspaceDir']) ??
        normalizeObservedCwd(legacy?.['projectWorkspaceDir']);
      const colKind = asNonEmptyString(row['session_kind']);
      const sessionKind =
        (colKind !== null && colKind !== 'unknown' ? colKind : null) ??
        asNonEmptyString(legacy?.['sessionKind']) ??
        colKind;
      const visibility =
        (useLegacyJson ? asNonEmptyString(legacy?.['visibility']) : null) ??
        asNonEmptyString(row['visibility']) ??
        asNonEmptyString(legacy?.['visibility']);
      const historyRelativeDir =
        asNonEmptyString(row['history_relative_dir']) ??
        asNonEmptyString(legacy?.['historyRelativeDir']);
      const createdAtMs =
        asFiniteNumber(row['created_at_ms']) ?? asFiniteNumber(legacy?.['createdAtMs']);
      const updatedAtMs =
        asFiniteNumber(row['updated_at_ms']) ?? asFiniteNumber(legacy?.['updatedAtMs']);

      result.set(sid, {
        title,
        cwd,
        sessionKind,
        visibility,
        historyRelativeDir,
        createdAtMs,
        updatedAtMs,
      });
    }
    return { ok: true, bySessionId: result };
  } catch (error) {
    return { ok: false, issue: sourceInventoryIssue(dbPath, error) };
  } finally {
    try {
      db.close();
    } catch {
      // Closing a read-only handle must not mask discovery.
    }
  }
}

// ---- Manifest & Directory Discovery ---------------------------------------

function readManifestFile(manifestPath: string): ManifestReadResult {
  let info;
  try {
    info = lstatSync(manifestPath);
  } catch (error) {
    if (isMissingError(error)) return { kind: 'missing' };
    return { kind: 'io-error', error };
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    return { kind: 'corrupt', error: 'MiniMax manifest.json is not a regular file' };
  }

  let text: string;
  try {
    text = readFileSync(manifestPath, 'utf8');
  } catch (error) {
    if (isMissingError(error)) return { kind: 'missing' };
    return { kind: 'io-error', error };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      kind: 'corrupt',
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const obj = asRecord(raw);
  if (obj === null) {
    return { kind: 'corrupt', error: 'MiniMax manifest.json root value must be an object' };
  }

  const rawSessionId = asNonEmptyString(obj['sessionId']);
  if (Object.prototype.hasOwnProperty.call(obj, 'schemaVersion')) {
    const version = obj['schemaVersion'];
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version !== 1) {
      return { kind: 'unsupported', schemaVersion: version, sessionId: rawSessionId };
    }
  }

  if (rawSessionId === null) {
    return { kind: 'corrupt', error: 'Missing or invalid sessionId in MiniMax manifest.json' };
  }

  return {
    kind: 'ok',
    manifest: {
      schemaVersion: 1,
      sessionId: rawSessionId,
      createdAtMs: asFiniteNumber(obj['createdAtMs']),
      updatedAtMs: asFiniteNumber(obj['updatedAtMs']),
    },
  };
}

interface DiscoveredSessionDir {
  readonly sessionDir: string;
  readonly relativeDir: string;
  readonly manifestPath: string;
  readonly messagesPath: string;
  readonly manifest: MinimaxManifest;
  readonly stat: BigIntStats;
  readonly head: ParsedEnvelopeLine | null;
}

function listSubdirs(
  dirPath: string,
  onError: (issue: InventoryIssue) => void,
): string[] | 'missing' {
  let entries: Dirent[];
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch (error) {
    if (isMissingError(error)) return 'missing';
    onError(sourceInventoryIssue(dirPath, error));
    return [];
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    dirs.push(join(dirPath, entry.name));
  }
  return dirs.sort();
}

function enumerateSessionDirs(
  sessionsDir: string,
  onError: (issue: InventoryIssue) => void,
): { dirs: string[]; rootMissing: boolean } {
  const years = listSubdirs(sessionsDir, onError);
  if (years === 'missing') return { dirs: [], rootMissing: true };
  const sessionDirs: string[] = [];
  for (const yearDir of years) {
    const months = listSubdirs(yearDir, onError);
    if (months === 'missing') continue;
    for (const monthDir of months) {
      const days = listSubdirs(monthDir, onError);
      if (days === 'missing') continue;
      for (const dayDir of days) {
        const candidates = listSubdirs(dayDir, onError);
        if (candidates === 'missing') continue;
        for (const candidate of candidates) sessionDirs.push(candidate);
      }
    }
  }
  return { dirs: sessionDirs, rootMissing: false };
}

function candidateMatchesUtcDir(
  candidate: DiscoveredSessionDir,
  sqliteMeta: MinimaxSqliteMeta | undefined,
): boolean {
  const createdMs = candidate.manifest.createdAtMs ?? sqliteMeta?.createdAtMs;
  if (createdMs === null || createdMs === undefined) return false;
  return candidate.relativeDir === utcSessionRelativeDir(candidate.manifest.sessionId, createdMs);
}

function compareCandidates(
  left: DiscoveredSessionDir,
  right: DiscoveredSessionDir,
  sqliteMeta: MinimaxSqliteMeta | undefined,
): number {
  const preferredRel = sqliteMeta?.historyRelativeDir ?? null;
  if (preferredRel !== null) {
    const leftMatches = left.relativeDir === preferredRel;
    const rightMatches = right.relativeDir === preferredRel;
    if (leftMatches !== rightMatches) return leftMatches ? -1 : 1;
  }
  if (left.stat.mtimeNs !== right.stat.mtimeNs) {
    return left.stat.mtimeNs > right.stat.mtimeNs ? -1 : 1;
  }
  const leftUtc = candidateMatchesUtcDir(left, sqliteMeta);
  const rightUtc = candidateMatchesUtcDir(right, sqliteMeta);
  if (leftUtc !== rightUtc) return leftUtc ? -1 : 1;
  return left.sessionDir.localeCompare(right.sessionDir);
}

function pathMatchesTarget(normTarget: string, diskTarget: string, changed: string): boolean {
  const normChanged = normalize(changed);
  if (normChanged === normTarget || isInsideDir(normTarget, normChanged) || isInsideDir(normChanged, normTarget)) {
    return true;
  }
  const diskChanged = watchPathOnDisk(normChanged);
  return (
    diskChanged === diskTarget ||
    isInsideDir(diskTarget, diskChanged) ||
    isInsideDir(diskChanged, diskTarget) ||
    normChanged === diskTarget ||
    isInsideDir(diskTarget, normChanged) ||
    isInsideDir(normChanged, diskTarget)
  );
}

function pathAffected(targetPath: string, changedPaths: readonly string[]): boolean {
  const normTarget = normalize(targetPath);
  const diskTarget = watchPathOnDisk(normTarget);
  for (const rawChanged of changedPaths) {
    if (pathMatchesTarget(normTarget, diskTarget, rawChanged)) return true;
  }
  return false;
}

// ---- Envelope & Snapshot Chain Parsing ------------------------------------

function parseParentSnapshot(rawParent: unknown): ParentSnapshotRef | null {
  const parent = asRecord(rawParent);
  if (
    parent !== null &&
    typeof parent['generation'] === 'number' &&
    Number.isSafeInteger(parent['generation']) &&
    parent['generation'] >= 0 &&
    typeof parent['compactionId'] === 'string'
  ) {
    return {
      generation: parent['generation'],
      compactionId: parent['compactionId'],
      revision: typeof parent['revision'] === 'string' ? parent['revision'] : null,
    };
  }
  return null;
}

function parseHistoryArtifact(value: unknown, message: JsonRecord): HistoryArtifactHead | null {
  const artifact = asRecord(value);
  if (artifact !== null) {
    const schemaVersion = artifact['schemaVersion'];
    if (Object.prototype.hasOwnProperty.call(artifact, 'schemaVersion') && schemaVersion !== 1) {
      return {
        supported: false,
        schemaVersion,
        generation: 0,
        producedBy: null,
        parentSnapshot: null,
      };
    }
    const gen = artifact['generation'];
    if (typeof gen === 'number' && Number.isSafeInteger(gen) && gen >= 0) {
      return {
        supported: true,
        schemaVersion: schemaVersion ?? 1,
        generation: gen,
        producedBy: typeof artifact['producedBy'] === 'string' ? artifact['producedBy'] : null,
        parentSnapshot: parseParentSnapshot(artifact['parentSnapshot']),
      };
    }
  }
  // Fallback for legacy v2 archonCompaction v2 markers on first envelope.
  const archon = asRecord(message['archonCompaction']);
  if (
    archon !== null &&
    archon['schemaVersion'] === 2 &&
    typeof archon['generation'] === 'number' &&
    Number.isSafeInteger(archon['generation']) &&
    archon['generation'] >= 0
  ) {
    return {
      supported: true,
      schemaVersion: 2,
      generation: archon['generation'],
      producedBy: null,
      parentSnapshot: parseParentSnapshot(archon['parentSnapshot']),
    };
  }
  return null;
}

function parseEnvelopeLine(rawLine: string): ParsedEnvelopeLine | null {
  const trimmed = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
  if (trimmed.trim().length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const obj = asRecord(parsed);
  if (obj === null) return null;
  const messageId = asNonEmptyString(obj['message_id']);
  const message = asRecord(obj['message']);
  if (messageId === null || message === null) return null;
  return {
    raw: trimmed,
    messageId,
    turnId: asNonEmptyString(obj['turn_id']),
    message,
    historyArtifact: parseHistoryArtifact(obj['history_artifact'], message),
  };
}

function readCompleteLinesFromOffset(
  filePath: string,
  startOffset: number,
  endOffset: number,
  { includeValidTrailingLine = false }: { includeValidTrailingLine?: boolean } = {},
): { lines: string[]; nextOffset: number } {
  if (endOffset <= startOffset) return { lines: [], nextOffset: startOffset };
  const length = endOffset - startOffset;
  const buf = Buffer.allocUnsafe(length);
  const fd = openSync(filePath, 'r');
  let totalRead = 0;
  try {
    while (totalRead < length) {
      const n = readSync(fd, buf, totalRead, length - totalRead, startOffset + totalRead);
      if (n <= 0) break;
      totalRead += n;
    }
  } finally {
    closeSync(fd);
  }
  const slice = buf.subarray(0, totalRead);
  const lastNewline = slice.lastIndexOf(10);
  if (lastNewline < 0) {
    if (includeValidTrailingLine) {
      const candidate = slice.toString('utf8');
      if (parseEnvelopeLine(candidate) !== null) {
        return { lines: [candidate], nextOffset: startOffset + totalRead };
      }
    }
    // Only an incomplete trailing line exists so far; wait until it finishes.
    return { lines: [], nextOffset: startOffset };
  }
  const completeBytes = slice.subarray(0, lastNewline);
  const lines = completeBytes.toString('utf8').split('\n').filter((l) => l.trim().length > 0);
  let nextOffset = startOffset + lastNewline + 1;
  if (includeValidTrailingLine && lastNewline + 1 < totalRead) {
    const trailing = slice.subarray(lastNewline + 1).toString('utf8');
    if (parseEnvelopeLine(trailing) !== null) {
      lines.push(trailing);
      nextOffset = startOffset + totalRead;
    }
  }
  return { lines, nextOffset };
}

function readAllEnvelopes(filePath: string): ParsedEnvelopeLine[] {
  const raw = readFileSync(filePath, 'utf8');
  const envelopes: ParsedEnvelopeLine[] = [];
  for (const line of raw.split('\n')) {
    const parsed = parseEnvelopeLine(line);
    if (parsed !== null) envelopes.push(parsed);
  }
  return envelopes;
}

function readFirstEnvelope(filePath: string): FirstEnvelopeResult {
  const fd = openSync(filePath, 'r');
  try {
    const chunkBuf = Buffer.allocUnsafe(64 * 1024);
    let lineChunks: Buffer[] = [];
    let lineBytes = 0;

    const tryParseLine = (): ParsedEnvelopeLine | null => {
      if (lineBytes === 0) return null;
      const lineStr = Buffer.concat(lineChunks, lineBytes).toString('utf8');
      lineChunks = [];
      lineBytes = 0;
      return parseEnvelopeLine(lineStr);
    };

    for (;;) {
      const n = readSync(fd, chunkBuf, 0, chunkBuf.length, null);
      if (n <= 0) break;
      let start = 0;
      while (start < n) {
        const nl = chunkBuf.indexOf(10, start);
        const end = nl >= 0 && nl < n ? nl : n;
        const segment = chunkBuf.subarray(start, end);
        if (segment.length > 0) {
          if (lineBytes + segment.length > MAX_FIRST_ENVELOPE_BYTES) {
            return { kind: 'oversized' };
          }
          lineChunks.push(Buffer.from(segment));
          lineBytes += segment.length;
        }
        if (nl >= 0 && nl < n) {
          const parsed = tryParseLine();
          if (parsed !== null) return { kind: 'ok', envelope: parsed };
          lineChunks = [];
          lineBytes = 0;
          start = nl + 1;
        } else {
          break;
        }
      }
    }
    return { kind: 'ok', envelope: tryParseLine() };
  } finally {
    closeSync(fd);
  }
}

function snapshotFilePath(
  sessionDir: string,
  sessionsDir: string,
  ref: ParentSnapshotRef,
): SnapshotPathResult {
  const fileName = `g${String(ref.generation).padStart(12, '0')}--${ref.compactionId}.jsonl`;
  if (!SNAPSHOT_FILE_RE.test(fileName)) {
    return { kind: 'error', path: join(sessionDir, 'snapshots', fileName), error: new Error('Invalid MiniMax snapshot filename'), isIoError: false };
  }
  const snapshotsDir = join(sessionDir, 'snapshots');
  let dirInfo;
  try {
    dirInfo = lstatSync(snapshotsDir);
  } catch (error) {
    if (isMissingError(error)) return { kind: 'missing' };
    return { kind: 'error', path: snapshotsDir, error, isIoError: true };
  }
  if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) {
    return {
      kind: 'error',
      path: snapshotsDir,
      error: new Error(`MiniMax snapshots directory is not a regular directory: ${snapshotsDir}`),
      isIoError: false,
    };
  }

  const fullPath = join(snapshotsDir, fileName);
  let info;
  try {
    info = lstatSync(fullPath);
  } catch (error) {
    if (isMissingError(error)) return { kind: 'missing' };
    return { kind: 'error', path: fullPath, error, isIoError: true };
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    return {
      kind: 'error',
      path: fullPath,
      error: new Error(`MiniMax snapshot is not a regular file: ${fullPath}`),
      isIoError: false,
    };
  }

  const realSessionsDir = safeRealpath(sessionsDir);
  const realFullPath = safeRealpath(fullPath);
  if (realSessionsDir === null || realFullPath === null || !isInsideDir(realSessionsDir, realFullPath)) {
    return {
      kind: 'error',
      path: fullPath,
      error: new Error(`MiniMax snapshot resolves outside sessionsDir: ${fullPath}`),
      isIoError: false,
    };
  }
  return { kind: 'ok', path: fullPath };
}

function resolveReachableFiles(
  sessionDir: string,
  sessionsDir: string,
  activePath: string,
  firstHead?: ParsedEnvelopeLine | null,
): ReachableFilesResult {
  const chain: string[] = [activePath];
  const visited = new Set<string>([activePath]);
  let head: ParsedEnvelopeLine | null;
  if (firstHead !== undefined) {
    head = firstHead;
  } else {
    const res = readFirstEnvelope(activePath);
    if (res.kind === 'oversized') {
      return {
        ok: false,
        path: activePath,
        error: new Error(`MiniMax first envelope exceeds ${MAX_FIRST_ENVELOPE_BYTES} bytes: ${activePath}`),
        isIoError: false,
      };
    }
    head = res.envelope;
  }

  for (let depth = 0; depth < MAX_SNAPSHOT_DEPTH && head?.historyArtifact?.supported && head.historyArtifact.parentSnapshot; depth++) {
    const parentRef = head.historyArtifact.parentSnapshot;
    const snapRes = snapshotFilePath(sessionDir, sessionsDir, parentRef);
    if (snapRes.kind === 'missing') break;
    if (snapRes.kind === 'error') {
      return { ok: false, path: snapRes.path, error: snapRes.error, isIoError: snapRes.isIoError };
    }
    const parentPath = snapRes.path;
    if (visited.has(parentPath)) break;
    visited.add(parentPath);
    chain.unshift(parentPath);

    let firstRes: FirstEnvelopeResult;
    try {
      firstRes = readFirstEnvelope(parentPath);
    } catch (error) {
      return { ok: false, path: parentPath, error, isIoError: !isMissingError(error) };
    }
    if (firstRes.kind === 'oversized') {
      return {
        ok: false,
        path: parentPath,
        error: new Error(`MiniMax snapshot first envelope exceeds ${MAX_FIRST_ENVELOPE_BYTES} bytes: ${parentPath}`),
        isIoError: false,
      };
    }
    head = firstRes.envelope;
  }
  return { ok: true, files: chain };
}

// ---- Message Content & Usage Projection -----------------------------------

function mediaPlaceholder(mediaType: string, part: JsonRecord): string {
  const mime = asNonEmptyString(part['mimeType']) ?? asNonEmptyString(part['mediaType']) ?? 'unknown';
  const chars = typeof part['data'] === 'string' ? part['data'].length : 0;
  return `[${mediaType} ${toWellFormedText(mime)}; base64 chars=${chars}]`;
}

function extractCanonicalUserText(message: JsonRecord): string | null {
  if (Object.prototype.hasOwnProperty.call(message, 'genuineUserQueryText')) {
    const genuine = message['genuineUserQueryText'];
    if (typeof genuine === 'string') return toWellFormedText(genuine);
  }
  if (Object.prototype.hasOwnProperty.call(message, 'canonicalTextRange')) {
    const range = asRecord(message['canonicalTextRange']);
    const startOffset = range?.['startOffset'];
    const endOffset = range?.['endOffset'];
    if (
      typeof startOffset === 'number' &&
      typeof endOffset === 'number' &&
      Number.isSafeInteger(startOffset) &&
      Number.isSafeInteger(endOffset) &&
      startOffset >= 0 &&
      endOffset >= startOffset
    ) {
      const content = message['content'];
      let singleText: string | null = null;
      if (typeof content === 'string') {
        singleText = content;
      } else if (Array.isArray(content)) {
        const textBlocks = content.filter(
          (b): b is JsonRecord => asRecord(b)?.['type'] === 'text' && typeof (b as JsonRecord)['text'] === 'string',
        );
        if (textBlocks.length === 1) {
          singleText = textBlocks[0]!['text'] as string;
        }
      }
      if (singleText !== null && endOffset <= singleText.length) {
        return toWellFormedText(singleText.slice(startOffset, endOffset));
      }
    }
  }
  return null;
}

function contentToRawText(content: unknown): string | null {
  if (typeof content === 'string') return toWellFormedText(content);
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    const obj = asRecord(block);
    if (obj === null) continue;
    const type = obj['type'];
    if (type === 'text' && typeof obj['text'] === 'string') parts.push(toWellFormedText(obj['text']));
    else if (type === 'thinking' && typeof obj['thinking'] === 'string') parts.push(toWellFormedText(obj['thinking']));
    else if (type === 'image' || type === 'video' || type === 'audio' || type === 'file') {
      parts.push(mediaPlaceholder(type, obj));
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

function bashPresentation(message: JsonRecord): string {
  const command = typeof message['command'] === 'string' ? toWellFormedText(message['command']) : '';
  const output = typeof message['output'] === 'string' ? toWellFormedText(message['output']) : '';
  let text = `Ran \`${command}\`\n${output.length > 0 ? `\`\`\`\n${output}\n\`\`\`` : '(no output)'}`;
  if (message['cancelled'] === true) text += '\n\n(command cancelled)';
  else if (typeof message['exitCode'] === 'number' && message['exitCode'] !== 0) {
    text += `\n\nCommand exited with code ${message['exitCode']}`;
  }
  if (
    message['truncated'] === true &&
    typeof message['fullOutputPath'] === 'string' &&
    message['fullOutputPath'].length > 0
  ) {
    text += `\n\n[Output truncated. Full output: ${toWellFormedText(message['fullOutputPath'])}]`;
  }
  return text;
}

function extractUsage(message: JsonRecord): { input: number | null; output: number | null } {
  const usage = asRecord(message['usage']);
  if (usage === null) return { input: null, output: null };
  const inputVal = asFiniteNumber(usage['input']);
  const cacheRead = asFiniteNumber(usage['cacheRead']);
  const cacheWrite = asFiniteNumber(usage['cacheWrite']);
  const inputs = [inputVal, cacheRead, cacheWrite].filter((v): v is number => v !== null);
  const output = asFiniteNumber(usage['output']);
  return {
    input: inputs.length > 0 ? inputs.reduce((a, b) => a + b, 0) : null,
    output,
  };
}

function customHarnessKind(message: JsonRecord): HarnessKind {
  const customType = asNonEmptyString(message['customType']);
  if (customType === 'background_task_read_settlement') return 'result';
  if (
    customType === 'execution_budget_reminder' ||
    customType === 'session_identity_reminder' ||
    customType === 'todo_cadence_reminder' ||
    customType === 'background_cadence' ||
    customType === 'background_task_cadence_reminder' ||
    customType === 'btw_side_boundary' ||
    customType === 'plugin_hook_context' ||
    message['display'] === false
  ) {
    return 'reminder';
  }
  return 'other';
}

function blockUuid(sessionId: string, messageId: string, blockIndex: number): string {
  return `${sessionId}:${messageId}:b${String(blockIndex).padStart(4, '0')}`;
}

function summaryUuid(sessionId: string, messageId: string): string {
  return `${sessionId}:${messageId}:summary`;
}

function toolCallUuid(sessionId: string, nativeCallId: string): string {
  return `${sessionId}:${nativeCallId}`;
}

const MINIMAX_FILE_TOOLS = new Set(['read', 'edit', 'write']);

function extractToolFilePath(name: string, input: JsonRecord | null): string | null {
  if (input !== null && MINIMAX_FILE_TOOLS.has(name.toLowerCase())) {
    const p = asNonEmptyString(input['file_path']) ?? asNonEmptyString(input['path']);
    if (p !== null) return toWellFormedText(p);
  }
  const fromShared = toolFilePath(name, input);
  return fromShared !== null ? toWellFormedText(fromShared) : null;
}

function isMediaBlockType(type: unknown): type is 'image' | 'video' | 'audio' | 'file' {
  return type === 'image' || type === 'video' || type === 'audio' || type === 'file';
}

function* projectEnvelope(
  envelope: ParsedEnvelopeLine,
  sessionId: string,
  cwd: string | null,
  state: ProjectionState,
): Generator<TranscriptRecord> {
  const idDigest = messageIdDigest(envelope.messageId);
  if (state.seenIdHashes.has(idDigest)) return;
  state.seenIdHashes.add(idDigest);

  const { message, messageId } = envelope;
  const role = asNonEmptyString(message['role']) ?? 'unknown';
  const timestamp = normalizeTime(message['timestamp']);
  if (timestamp !== null) {
    state.startedAt = minIso(state.startedAt, timestamp);
    state.maxMessageTimestamp = maxIso(state.maxMessageTimestamp, timestamp);
  }

  const emitMessage = (
    blockIndex: number,
    fields: {
      type: string;
      role: string;
      text: string | null;
      content_type: string;
      is_meta: 0 | 1;
      harness_kind: HarnessKind | null;
      visibility: MessageVisibility;
      model: string | null;
      input_tokens?: number | null;
      output_tokens?: number | null;
    },
  ): MessageRecord => {
    const uuid = blockUuid(sessionId, messageId, blockIndex);
    const record: MessageRecord = {
      kind: 'message',
      uuid,
      session_id: sessionId,
      type: fields.type,
      parent_uuid: state.lastMessageUuid,
      timestamp,
      role: fields.role,
      text: fields.text !== null ? toWellFormedText(fields.text) : null,
      content_type: fields.content_type,
      is_meta: fields.is_meta,
      harness_kind: fields.harness_kind,
      visibility: fields.visibility,
      model: fields.model,
      is_sidechain: 0,
      agent_id: null,
      input_tokens: fields.input_tokens ?? null,
      output_tokens: fields.output_tokens ?? null,
      cwd,
      skill: null,
      source: SOURCE,
    };
    state.lastMessageUuid = uuid;
    if (fields.visibility === 'visible') state.visibleCount += 1;
    return record;
  };

  if (role === 'compactionSummary' || role === 'branchSummary') {
    const summaryText = typeof message['summary'] === 'string' ? message['summary'] : '';
    const usage = extractUsage(message);
    yield {
      kind: 'summary',
      id: summaryUuid(sessionId, messageId),
      session_id: sessionId,
      timestamp,
      source: role === 'branchSummary' ? `${SOURCE}:branch_summary` : `${SOURCE}:compaction`,
      content: cleanTrunc(summaryText),
      visibility: 'visible',
      input_tokens: usage.input,
      output_tokens: usage.output,
    } satisfies SummaryRecord;
    return;
  }

  if (role === 'user') {
    // Only archonCompaction records carrying an actual summary string are summaries;
    // v2 generation markers without `summary` are regular user messages carrying a boundary tag.
    const archon = asRecord(message['archonCompaction']);
    if (archon !== null && typeof archon['summary'] === 'string') {
      yield {
        kind: 'summary',
        id: summaryUuid(sessionId, messageId),
        session_id: sessionId,
        timestamp,
        source: `${SOURCE}:compaction`,
        content: cleanTrunc(archon['summary']),
        visibility: 'visible',
      } satisfies SummaryRecord;
      return;
    }

    const hostMeta = asRecord(message['hostMetadata']);
    const isBgNotification =
      Object.prototype.hasOwnProperty.call(message, 'backgroundTaskOrigin') ||
      (hostMeta !== null &&
        (Object.prototype.hasOwnProperty.call(hostMeta, 'backgroundTaskOrigin') ||
          Object.prototype.hasOwnProperty.call(hostMeta, 'backgroundTask')));
    const rawCanonicalText = extractCanonicalUserText(message);
    // Upstream background task notifications often pair `<background-task-finished>` with an empty canonical range.
    const canonicalText =
      isBgNotification && rawCanonicalText === '' ? null : rawCanonicalText;

    const rawTextFallback = contentToRawText(message['content']);
    const isWorktreeForkReminder =
      message['timestamp'] === 0 &&
      rawTextFallback !== null &&
      WORKTREE_FORK_REMINDER_RE.test(rawTextFallback.trim());

    const isMeta: 0 | 1 = isBgNotification || isWorktreeForkReminder ? 1 : 0;
    const harnessKind: HarnessKind | null = isBgNotification
      ? 'notification'
      : isWorktreeForkReminder
        ? 'reminder'
        : null;
    const userVisibility: MessageVisibility = isWorktreeForkReminder ? 'hidden' : 'visible';
    const allowDerivedTitle = !isBgNotification && !isWorktreeForkReminder;

    const content = message['content'];
    if (typeof content === 'string') {
      const effectiveText = canonicalText ?? content;
      if (allowDerivedTitle && state.derivedTitle === null) {
        const derived = deriveTitleFromText(effectiveText);
        if (derived !== null) state.derivedTitle = derived;
      }
      yield emitMessage(0, {
        type: 'user',
        role: 'user',
        text: effectiveText.length > 0 ? cleanTrunc(effectiveText) : null,
        content_type: effectiveText.length > 0 ? 'text' : 'unknown',
        is_meta: isMeta,
        harness_kind: harnessKind,
        visibility: userVisibility,
        model: null,
      });
      return;
    }

    if (Array.isArray(content) && content.length > 0) {
      let emitted = 0;
      let appliedCanonicalText = false;
      for (let i = 0; i < content.length; i++) {
        const part = asRecord(content[i]);
        const partType = part?.['type'];
        if (partType === 'text' && typeof part?.['text'] === 'string') {
          const t = canonicalText !== null && !appliedCanonicalText ? canonicalText : part['text'];
          appliedCanonicalText = true;
          if (allowDerivedTitle && state.derivedTitle === null) {
            const derived = deriveTitleFromText(t);
            if (derived !== null) state.derivedTitle = derived;
          }
          yield emitMessage(i, {
            type: 'user',
            role: 'user',
            text: t.length > 0 ? cleanTrunc(t) : null,
            content_type: t.length > 0 ? 'text' : 'unknown',
            is_meta: isMeta,
            harness_kind: harnessKind,
            visibility: userVisibility,
            model: null,
          });
          emitted += 1;
        } else if (part !== null && isMediaBlockType(partType)) {
          yield emitMessage(i, {
            type: 'user',
            role: 'user',
            text: mediaPlaceholder(partType, part),
            content_type: partType,
            is_meta: isMeta,
            harness_kind: harnessKind,
            visibility: userVisibility,
            model: null,
          });
          emitted += 1;
        } else {
          yield emitMessage(i, {
            type: 'user',
            role: 'user',
            text: cleanTruncJson(part) ?? null,
            content_type: 'unknown',
            is_meta: isMeta,
            harness_kind: harnessKind,
            visibility: userVisibility,
            model: null,
          });
          emitted += 1;
        }
      }
      if (emitted === 0) {
        yield emitMessage(0, {
          type: 'user',
          role: 'user',
          text: canonicalText !== null && canonicalText.length > 0 ? cleanTrunc(canonicalText) : null,
          content_type: canonicalText !== null && canonicalText.length > 0 ? 'text' : 'unknown',
          is_meta: isMeta,
          harness_kind: harnessKind,
          visibility: userVisibility,
          model: null,
        });
      }
      return;
    }

    yield emitMessage(0, {
      type: 'user',
      role: 'user',
      text: canonicalText !== null && canonicalText.length > 0 ? cleanTrunc(canonicalText) : null,
      content_type: canonicalText !== null && canonicalText.length > 0 ? 'text' : 'unknown',
      is_meta: isMeta,
      harness_kind: harnessKind,
      visibility: userVisibility,
      model: null,
    });
    return;
  }

  if (role === 'assistant') {
    const model = asNonEmptyString(message['responseModel']) ?? asNonEmptyString(message['model']);
    const usage = extractUsage(message);
    const content = Array.isArray(message['content']) ? message['content'] : [];
    const emittedRecords: MessageRecord[] = [];
    const pendingCalls: ToolCallRecord[] = [];

    for (let i = 0; i < content.length; i++) {
      const part = asRecord(content[i]);
      if (part === null) continue;
      if (part['type'] === 'thinking' && typeof part['thinking'] === 'string') {
        if (part['thinking'].length === 0) continue;
        emittedRecords.push(emitMessage(i, {
          type: 'assistant',
          role: 'assistant',
          text: cleanTrunc(part['thinking']),
          content_type: 'thinking',
          is_meta: 0,
          harness_kind: null,
          visibility: 'visible',
          model,
        }));
      } else if (part['type'] === 'text' && typeof part['text'] === 'string') {
        emittedRecords.push(emitMessage(i, {
          type: 'assistant',
          role: 'assistant',
          text: cleanTrunc(part['text']),
          content_type: 'text',
          is_meta: 0,
          harness_kind: null,
          visibility: 'visible',
          model,
        }));
      } else if (
        part['type'] === 'toolCall' &&
        typeof part['id'] === 'string' &&
        part['id'].length > 0 &&
        typeof part['name'] === 'string' &&
        part['name'].length > 0
      ) {
        const msgRec = emitMessage(i, {
          type: 'assistant',
          role: 'assistant',
          text: null,
          content_type: 'tool_use',
          is_meta: 0,
          harness_kind: null,
          visibility: 'visible',
          model,
        });
        emittedRecords.push(msgRec);
        const input = asRecord(part['arguments']) ?? {};
        const fp = extractToolFilePath(part['name'], input);
        const callId = toolCallUuid(sessionId, part['id']);
        state.pendingTools.set(part['id'], fp);
        pendingCalls.push({
          kind: 'tool_call',
          id: callId,
          message_uuid: msgRec.uuid,
          session_id: sessionId,
          name: part['name'],
          presentation: part['name'].toLowerCase() === 'skill' ? 'skill' : 'default',
          input_json: cleanTruncJson(input) ?? '{}',
          file_path: fp,
        });
      } else {
        emittedRecords.push(emitMessage(i, {
          type: 'assistant',
          role: 'assistant',
          text: cleanTruncJson(part) ?? null,
          content_type: 'unknown',
          is_meta: 1,
          harness_kind: 'other',
          visibility: 'visible',
          model,
        }));
      }
    }

    const errorMessage = asNonEmptyString(message['errorMessage']);
    if (errorMessage !== null) {
      emittedRecords.push(emitMessage(content.length, {
        type: 'assistant',
        role: 'assistant',
        text: cleanTrunc(errorMessage),
        content_type: 'error',
        is_meta: 0,
        harness_kind: 'error',
        visibility: 'visible',
        model,
      }));
    }

    if (emittedRecords.length === 0) {
      emittedRecords.push(emitMessage(0, {
        type: 'assistant',
        role: 'assistant',
        text: null,
        content_type: 'unknown',
        is_meta: 0,
        harness_kind: null,
        visibility: 'visible',
        model,
      }));
    }

    const last = emittedRecords.at(-1)!;
    last.input_tokens = usage.input;
    last.output_tokens = usage.output;

    for (const rec of emittedRecords) yield rec;
    for (const call of pendingCalls) yield call;
    return;
  }

  if (role === 'toolResult') {
    const nativeCallId = asNonEmptyString(message['toolCallId']);
    const rawText = contentToRawText(message['content']) ?? '';
    const details = asRecord(message['details']);
    const textFile = asRecord(details?.['textFile']);
    const detailPath = asNonEmptyString(textFile?.['path']);
    const mappedPath = nativeCallId !== null ? state.pendingTools.get(nativeCallId) ?? null : null;
    if (nativeCallId !== null) state.pendingTools.delete(nativeCallId);
    const resolvedPath = mappedPath ?? (detailPath !== null ? toWellFormedText(detailPath) : null);

    const msgRec = emitMessage(0, {
      type: 'user',
      role: 'toolResult',
      text: rawText.length > 0 ? cleanTrunc(rawText) : null,
      content_type: 'tool_result',
      is_meta: 0,
      harness_kind: null,
      visibility: 'visible',
      model: null,
    });
    yield msgRec;

    if (nativeCallId !== null) {
      yield {
        kind: 'tool_result',
        tool_use_id: toolCallUuid(sessionId, nativeCallId),
        message_uuid: msgRec.uuid,
        session_id: sessionId,
        content: cleanTrunc(rawText),
        file_path: resolvedPath,
        is_error: message['isError'] === true ? 1 : 0,
      } satisfies ToolResultRecord;
    }
    return;
  }

  if (role === 'bashExecution') {
    yield emitMessage(0, {
      type: 'user',
      role: 'bashExecution',
      text: cleanTrunc(bashPresentation(message)),
      content_type: 'bash_execution',
      is_meta: 0,
      harness_kind: 'command',
      visibility: 'visible',
      model: null,
    });
    return;
  }

  if (role === 'custom') {
    const visibility: MessageVisibility = message['display'] === false ? 'hidden' : 'visible';
    const rawText = contentToRawText(message['content']);
    yield emitMessage(0, {
      type: 'system',
      role: 'custom',
      text: rawText !== null ? cleanTrunc(rawText) : null,
      content_type: 'custom',
      is_meta: 1,
      harness_kind: customHarnessKind(message),
      visibility,
      model: null,
    });
    return;
  }

  const fallbackText = contentToRawText(message['content']);
  yield emitMessage(0, {
    type: 'system',
    role,
    text: fallbackText !== null ? cleanTrunc(fallbackText) : null,
    content_type: 'unknown',
    is_meta: 1,
    harness_kind: 'other',
    visibility: 'visible',
    model: null,
  });
}

// ---- Raw Lookup -----------------------------------------------------------

function rawBlockText(message: JsonRecord, blockIndex: number): string | null {
  const role = asNonEmptyString(message['role']) ?? 'unknown';
  if (role === 'user') {
    const hostMeta = asRecord(message['hostMetadata']);
    const isBgNotification =
      Object.prototype.hasOwnProperty.call(message, 'backgroundTaskOrigin') ||
      (hostMeta !== null &&
        (Object.prototype.hasOwnProperty.call(hostMeta, 'backgroundTaskOrigin') ||
          Object.prototype.hasOwnProperty.call(hostMeta, 'backgroundTask')));
    const rawCanonical = extractCanonicalUserText(message);
    const canonical = isBgNotification && rawCanonical === '' ? null : rawCanonical;
    const content = message['content'];
    if (typeof content === 'string') return canonical ?? toWellFormedText(content);
    if (Array.isArray(content)) {
      if (content.length === 0) {
        return blockIndex === 0 ? canonical : null;
      }
      const part = asRecord(content[blockIndex]);
      if (part === null) return null;
      const partType = part['type'];
      if (partType === 'text' && typeof part['text'] === 'string') {
        const firstTextIdx = content.findIndex(
          (b) => asRecord(b)?.['type'] === 'text' && typeof (b as JsonRecord)['text'] === 'string',
        );
        return blockIndex === firstTextIdx
          ? (canonical ?? toWellFormedText(part['text']))
          : toWellFormedText(part['text']);
      }
      if (isMediaBlockType(partType)) return mediaPlaceholder(partType, part);
      return fullJson(part);
    }
    return blockIndex === 0 ? (canonical ?? contentToRawText(content)) : null;
  }
  if (role === 'assistant') {
    const content = Array.isArray(message['content']) ? message['content'] : [];
    const part = asRecord(content[blockIndex]);
    if (part !== null) {
      if (part['type'] === 'thinking' && typeof part['thinking'] === 'string') {
        return part['thinking'].length > 0 ? toWellFormedText(part['thinking']) : null;
      }
      if (part['type'] === 'text' && typeof part['text'] === 'string') {
        return toWellFormedText(part['text']);
      }
      if (part['type'] === 'toolCall') return null;
      return fullJson(part);
    }
    if (blockIndex === content.length && typeof message['errorMessage'] === 'string') {
      return toWellFormedText(message['errorMessage']);
    }
    return null;
  }
  if (role === 'bashExecution') return bashPresentation(message);
  if (role === 'compactionSummary' || role === 'branchSummary') return null;
  return contentToRawText(message['content']);
}

function parseRawUuid(sessionId: string, messageUuid: string): { messageId: string; blockIndex: number } | null {
  const prefix = `${sessionId}:`;
  if (!messageUuid.startsWith(prefix)) return null;
  const rest = messageUuid.slice(prefix.length);
  const match = /^(.+):b(\d+)$/.exec(rest);
  if (match === null) return null;
  return { messageId: match[1]!, blockIndex: Number(match[2]!) };
}

function lookupRawMessage(input: RawLookup, sessionsDir: string): RawRecord | null {
  if (input.source !== SOURCE) return null;
  const jsonlPath = asNonEmptyString(input.session?.['jsonl_path']);
  const sessionId = asNonEmptyString(input.session?.['id']);
  if (jsonlPath === null || sessionId === null) return null;
  if (!pathInsideRoot(sessionsDir, jsonlPath)) return null;

  const realSessionsDir = safeRealpath(sessionsDir);
  const realJsonlPath = safeRealpath(jsonlPath);
  if (realSessionsDir === null || realJsonlPath === null || !isInsideDir(realSessionsDir, realJsonlPath)) {
    return null;
  }

  let info;
  try {
    info = lstatSync(jsonlPath);
  } catch {
    return null;
  }
  if (info.isSymbolicLink() || !info.isFile()) return null;

  const sessionDir = dirname(normalize(jsonlPath));
  const parsedUuid = parseRawUuid(sessionId, input.messageUuid);
  if (parsedUuid === null) return null;

  const chainRes = resolveReachableFiles(sessionDir, sessionsDir, jsonlPath);
  if (!chainRes.ok) return null;

  for (const filePath of chainRes.files) {
    let rawContent: string;
    try {
      rawContent = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    for (const line of rawContent.split('\n')) {
      if (!line.includes(parsedUuid.messageId) && !line.includes('\\')) continue;
      const envelope = parseEnvelopeLine(line);
      if (envelope === null || envelope.messageId !== parsedUuid.messageId) continue;
      return {
        text: envelope.raw,
        totalLength: envelope.raw.length,
        offset: 0,
        limit: envelope.raw.length,
        hasMore: false,
        messageText: rawBlockText(envelope.message, parsedUuid.blockIndex),
      };
    }
  }
  return null;
}

// ---- Provider Factory -----------------------------------------------------

export function createMinimaxProvider({
  rootDir,
  homeDir = homedir(),
  openDatabase = defaultOpenDatabase,
}: {
  rootDir?: string;
  homeDir?: string;
  openDatabase?: MinimaxDatabaseOpener;
} = {}): ProviderAdapter {
  const root = resolveMinimaxRoot(rootDir, homeDir);
  const sessionsDir = join(root, 'v2', 'sessions');
  const sqlitePath = join(root, 'v2', 'sqlite', 'runtime-state.sqlite');

  return {
    name: SOURCE,
    descriptor: {
      id: SOURCE,
      name: 'MiniMax Code',
      vendor: 'MiniMax',
      defaultRoot: root,
      color: '#f43f5e',
    },
    indexVersionMarker: MINIMAX_CANONICAL_TRANSCRIPT_MARKER,
    sessionUnitKey: ({ jsonlPath }) => dirname(normalize(jsonlPath)),
    watchHints: (unitKey) => (
      pathInsideRoot(sessionsDir, unitKey)
        ? [join(unitKey, 'messages.jsonl'), join(unitKey, 'manifest.json')]
        : []
    ),
    watchTargets: (configuredRoot) => {
      const targetRoot = resolveMinimaxRoot(configuredRoot, homeDir);
      const targetSqlite = join(targetRoot, 'v2', 'sqlite', 'runtime-state.sqlite');
      return [
        { kind: 'tree', path: join(targetRoot, 'v2', 'sessions'), fileNames: ['manifest.json', 'messages.jsonl'] },
        { kind: 'file', path: targetSqlite },
        { kind: 'file', path: `${targetSqlite}-wal` },
      ] satisfies WatchTarget[];
    },

    discover(ctx: DiscoverContext): IndexUnit[] {
      const indexedSessions = ctx.indexedSessions?.() ?? [];
      const scopedIndexed = indexedSessions.filter((item) => pathInsideRoot(sessionsDir, item.jsonlPath));
      const indexedPathBySessionId = new Map(
        scopedIndexed.map((item) => [item.sessionId, watchPathOnDisk(item.jsonlPath)]),
      );
      const indexedSessionByDir = new Map(
        scopedIndexed.map((item) => [watchPathOnDisk(dirname(normalize(item.jsonlPath))), item.sessionId]),
      );

      let inventoryComplete = true;
      let allowTombstones = true;
      const reportIssue = (issue: InventoryIssue): void => {
        inventoryComplete = false;
        ctx.reportIncompleteInventory?.(issue);
      };

      const { dirs, rootMissing } = enumerateSessionDirs(sessionsDir, reportIssue);
      if (rootMissing && scopedIndexed.length > 0) {
        reportIssue({ path: sessionsDir, error: 'MiniMax sessions directory is unavailable' });
      }

      const sqliteResult = readSqliteMetadata(root, openDatabase);
      if (!sqliteResult.ok) {
        reportIssue(sqliteResult.issue);
        for (const indexed of scopedIndexed) {
          ctx.retainSession?.(indexed.sessionId);
        }
        return [];
      }
      const sqliteBySessionId = sqliteResult.bySessionId;

      const candidatesBySessionId = new Map<string, DiscoveredSessionDir[]>();
      const unhealthyIds = new Set<string>();
      const retainIndexedDir = (sessionDir: string): boolean => {
        const existingId = indexedSessionByDir.get(watchPathOnDisk(sessionDir));
        if (existingId !== undefined) {
          unhealthyIds.add(existingId);
          return true;
        }
        return false;
      };

      for (const sessionDir of dirs) {
        const manifestPath = join(sessionDir, 'manifest.json');
        const manifestRes = readManifestFile(manifestPath);
        if (manifestRes.kind === 'missing') continue;
        if (manifestRes.kind === 'io-error') {
          retainIndexedDir(sessionDir);
          reportIssue(sourceInventoryIssue(manifestPath, manifestRes.error));
          continue;
        }
        if (manifestRes.kind === 'corrupt') {
          if (!retainIndexedDir(sessionDir)) {
            allowTombstones = false;
          }
          ctx.reportSkippedArtifact?.({ path: manifestPath, error: manifestRes.error });
          continue;
        }
        if (manifestRes.kind === 'unsupported') {
          if (manifestRes.sessionId !== null) {
            unhealthyIds.add(minimaxSessionId(manifestRes.sessionId));
          } else if (!retainIndexedDir(sessionDir)) {
            allowTombstones = false;
          }
          ctx.reportSkippedArtifact?.({
            path: manifestPath,
            error: `Unsupported MiniMax manifest schemaVersion ${String(manifestRes.schemaVersion)}`,
          });
          continue;
        }

        const manifest = manifestRes.manifest;
        const canonicalId = minimaxSessionId(manifest.sessionId);
        const messagesPath = join(sessionDir, 'messages.jsonl');
        let stat: BigIntStats;
        try {
          stat = lstatSync(messagesPath, { bigint: true });
        } catch (error) {
          if (isMissingError(error)) continue;
          unhealthyIds.add(canonicalId);
          reportIssue(sourceInventoryIssue(messagesPath, error));
          continue;
        }
        if (stat.isSymbolicLink() || !stat.isFile()) {
          unhealthyIds.add(canonicalId);
          ctx.reportSkippedArtifact?.({
            path: messagesPath,
            error: 'MiniMax messages.jsonl is not a regular file',
          });
          continue;
        }

        let headRes: FirstEnvelopeResult;
        try {
          headRes = readFirstEnvelope(messagesPath);
        } catch (error) {
          if (isMissingError(error)) continue;
          unhealthyIds.add(canonicalId);
          reportIssue(sourceInventoryIssue(messagesPath, error));
          continue;
        }
        if (headRes.kind === 'oversized') {
          unhealthyIds.add(canonicalId);
          ctx.reportSkippedArtifact?.({
            path: messagesPath,
            error: `MiniMax first envelope exceeds ${MAX_FIRST_ENVELOPE_BYTES} bytes`,
          });
          continue;
        }
        const head = headRes.envelope;
        if (head?.historyArtifact && !head.historyArtifact.supported) {
          unhealthyIds.add(canonicalId);
          ctx.reportSkippedArtifact?.({
            path: messagesPath,
            error: `Unsupported MiniMax history_artifact schemaVersion ${String(head.historyArtifact.schemaVersion)}`,
          });
          continue;
        }

        if (head?.historyArtifact?.parentSnapshot) {
          const chainCheck = resolveReachableFiles(sessionDir, sessionsDir, messagesPath, head);
          if (!chainCheck.ok) {
            unhealthyIds.add(canonicalId);
            if (chainCheck.isIoError) {
              reportIssue(sourceInventoryIssue(chainCheck.path, chainCheck.error));
            } else {
              ctx.reportSkippedArtifact?.({
                path: chainCheck.path,
                error: chainCheck.error instanceof Error ? chainCheck.error.message : String(chainCheck.error),
              });
            }
            continue;
          }
        }

        const relativeDir = relative(sessionsDir, sessionDir).split(sep).join('/');
        const entry: DiscoveredSessionDir = {
          sessionDir,
          relativeDir,
          manifestPath,
          messagesPath,
          manifest,
          stat,
          head,
        };
        const list = candidatesBySessionId.get(manifest.sessionId) ?? [];
        list.push(entry);
        candidatesBySessionId.set(manifest.sessionId, list);
      }

      const changedPaths = ctx.changedPaths;
      const diskSqliteDir = watchPathOnDisk(dirname(sqlitePath));
      const sqliteChanged =
        changedPaths !== undefined &&
        changedPaths.some((p) => {
          const norm = normalize(p);
          const disk = watchPathOnDisk(norm);
          return (
            norm === sqlitePath ||
            norm === `${sqlitePath}-wal` ||
            disk === watchPathOnDisk(sqlitePath) ||
            disk === watchPathOnDisk(`${sqlitePath}-wal`) ||
            disk === diskSqliteDir
          );
        });
      const filterByChanged = changedPaths !== undefined && !sqliteChanged;
      const readMode = ctx.readMode === 'strict' ? 'strict' : 'normal';

      const liveSessionIds = new Set<string>();
      const units: IndexUnit[] = [];

      for (const [rawSessionId, group] of candidatesBySessionId) {
        const sqliteMeta = sqliteBySessionId.get(rawSessionId);
        const sessionKind = sqliteMeta?.sessionKind ?? null;
        const visibility = sqliteMeta?.visibility ?? null;
        if (
          sessionKind === 'peek' ||
          sessionKind === 'cron' ||
          (visibility === 'hidden' && sessionKind !== 'task')
        ) {
          continue;
        }
        const canonicalId = minimaxSessionId(rawSessionId);

        group.sort((a, b) => compareCandidates(a, b, sqliteMeta));
        const winner = group[0]!;
        liveSessionIds.add(canonicalId);

        const title = sqliteMeta?.title ?? null;
        const cwd = sqliteMeta?.cwd ?? null;
        const startedBy: 'agent' | null = sessionKind === 'task' ? 'agent' : null;
        const createdAtMs = winner.manifest.createdAtMs ?? sqliteMeta?.createdAtMs ?? null;
        const updatedAtMs = sqliteMeta?.updatedAtMs ?? winner.manifest.updatedAtMs ?? null;
        const structuralMetaHash = computeStructuralMetaHash({
          sessionId: rawSessionId,
          schemaVersion: winner.manifest.schemaVersion,
          createdAtMs,
          cwd,
          startedBy,
        });

        const indexedPath = indexedPathBySessionId.get(canonicalId);
        const pathMatches = indexedPath === undefined || indexedPath === watchPathOnDisk(winner.messagesPath);
        const replaceExisting = indexedPath !== undefined && !pathMatches;

        if (filterByChanged && pathMatches && !pathAffected(winner.sessionDir, changedPaths)) {
          continue;
        }

        const storedCursor = decodeCursor(ctx.lastCursor(winner.sessionDir));
        let skipUnchanged =
          !filterByChanged &&
          pathMatches &&
          storedCursor !== null &&
          storedCursor.structuralMetaHash === structuralMetaHash &&
          storedCursor.sqliteTitle === title &&
          storedCursor.sqliteUpdatedAtMs === updatedAtMs &&
          statMatchesCursor(winner.stat, storedCursor);
        if (skipUnchanged && readMode === 'strict' && storedCursor !== null) {
          try {
            skipUnchanged =
              storedCursor.prefixVerified &&
              sha256FilePrefix(winner.messagesPath, storedCursor.offset) === storedCursor.prefixHash;
          } catch {
            // Re-enter parse() on read error rather than falsely skipping.
            skipUnchanged = false;
          }
        }
        if (skipUnchanged) continue;

        units.push({
          key: winner.sessionDir,
          sessionId: canonicalId,
          project: projectSlugFromPath(cwd) ?? undefined,
          meta: {
            kind: 'session',
            sessionDir: winner.sessionDir,
            rawSessionId,
            title,
            cwd,
            startedBy,
            createdAtMs,
            updatedAtMs,
            structuralMetaHash,
            replaceExisting,
            ...(readMode === 'strict' ? { readMode: 'strict' } : {}),
          } satisfies MinimaxUnitMeta,
        });
      }

      const retainedUnhealthy = new Set<string>();
      for (const unhealthyId of unhealthyIds) {
        if (!liveSessionIds.has(unhealthyId)) {
          retainedUnhealthy.add(unhealthyId);
          ctx.retainSession?.(unhealthyId);
        }
      }

      if (inventoryComplete && allowTombstones) {
        for (const indexed of scopedIndexed) {
          if (liveSessionIds.has(indexed.sessionId) || retainedUnhealthy.has(indexed.sessionId)) {
            continue;
          }
          const indexedDir = dirname(normalize(indexed.jsonlPath));
          if (filterByChanged && !pathAffected(indexedDir, changedPaths)) {
            continue;
          }
          units.push({
            key: indexedDir,
            sessionId: indexed.sessionId,
            retractSessionIds: [indexed.sessionId],
            meta: {
              kind: 'tombstone',
              sessionDir: indexedDir,
              rawSessionId: indexed.sessionId,
              title: null,
              cwd: null,
              startedBy: null,
              createdAtMs: null,
              updatedAtMs: null,
              structuralMetaHash: '',
              replaceExisting: false,
            } satisfies MinimaxUnitMeta,
          });
        }
      }

      return units.sort((a, b) => {
        const keyCmp = a.key.localeCompare(b.key);
        if (keyCmp !== 0) return keyCmp;
        const aTomb = (a.meta as MinimaxUnitMeta).kind === 'tombstone' ? 0 : 1;
        const bTomb = (b.meta as MinimaxUnitMeta).kind === 'tombstone' ? 0 : 1;
        if (aTomb !== bTomb) return aTomb - bTomb;
        return a.sessionId.localeCompare(b.sessionId);
      });
    },

    *parse(unit: IndexUnit, cursor: Cursor): Generator<TranscriptRecord, Cursor> {
      const meta = unit.meta as MinimaxUnitMeta;
      if (meta.kind === 'tombstone') {
        return TOMBSTONE_CURSOR;
      }

      const messagesPath = join(meta.sessionDir, 'messages.jsonl');
      const beforeStat = lstatSync(messagesPath, { bigint: true });
      if (beforeStat.isSymbolicLink() || !beforeStat.isFile()) {
        throw new Error(`MiniMax messages.jsonl is not a regular file: ${messagesPath}`);
      }
      const headRes = readFirstEnvelope(messagesPath);
      if (headRes.kind === 'oversized') {
        throw new Error(`MiniMax first envelope exceeds ${MAX_FIRST_ENVELOPE_BYTES} bytes: ${messagesPath}`);
      }
      const activeHead = headRes.envelope;
      if (activeHead?.historyArtifact && !activeHead.historyArtifact.supported) {
        throw new Error(`Unsupported MiniMax history_artifact schemaVersion ${String(activeHead.historyArtifact.schemaVersion)}`);
      }
      const activeGeneration = activeHead?.historyArtifact?.generation ?? 0;
      const readMode = meta.readMode === 'strict' ? 'strict' : 'normal';
      const prevCursor = meta.replaceExisting ? null : decodeCursor(cursor);

      const finishCursor = (
        offset: number,
        state: ProjectionState,
        totalVisibleCount: number,
        lastMessageId: string | null,
        prefixVerified: boolean,
      ): Cursor => {
        const afterStat = lstatSync(messagesPath, { bigint: true });
        if (
          afterStat.isSymbolicLink() ||
          !afterStat.isFile() ||
          afterStat.dev !== beforeStat.dev ||
          afterStat.ino !== beforeStat.ino ||
          afterStat.size !== beforeStat.size ||
          afterStat.mtimeNs !== beforeStat.mtimeNs ||
          afterStat.ctimeNs !== beforeStat.ctimeNs
        ) {
          throw new Error(`MiniMax session changed while indexing: ${messagesPath}`);
        }
        const { tailHash, tailLen } = readTailHash(messagesPath, offset);
        const prefixHash = sha256FilePrefix(messagesPath, offset);
        if (prefixHash === null) {
          throw new Error(`MiniMax session shrunk while hashing prefix: ${messagesPath}`);
        }
        const endedAt = maxIso(state.maxMessageTimestamp, normalizeTime(meta.updatedAtMs));
        const seenTruncated = state.seenIdHashes.size > MAX_CURSOR_SEEN_IDS;
        const seenIdHashes = seenTruncated
          ? [...state.seenIdHashes].slice(-MAX_CURSOR_SEEN_IDS)
          : [...state.seenIdHashes];
        const nextState: MinimaxCursorState = {
          v: 3,
          generation: activeGeneration,
          dev: String(afterStat.dev),
          ino: String(afterStat.ino),
          size: String(afterStat.size),
          mtimeNs: String(afterStat.mtimeNs),
          ctimeNs: String(afterStat.ctimeNs),
          offset,
          tailHash,
          tailLen,
          prefixHash,
          prefixVerified,
          lastMessageId,
          lastMessageUuid: state.lastMessageUuid,
          seenIdHashes,
          seenTruncated,
          pendingTools: [...state.pendingTools.entries()],
          visibleCount: totalVisibleCount,
          startedAt: state.startedAt,
          endedAt,
          maxMessageTimestamp: state.maxMessageTimestamp,
          derivedTitle: state.derivedTitle,
          sqliteTitle: meta.title,
          sqliteUpdatedAtMs: meta.updatedAtMs,
          structuralMetaHash: meta.structuralMetaHash,
        };
        return encodeCursor(afterStat, nextState);
      };

      const checkPrefixMatches = (prev: MinimaxCursorState): boolean => {
        try {
          if (readMode === 'strict') {
            return prev.prefixVerified && sha256FilePrefix(messagesPath, prev.offset) === prev.prefixHash;
          }
          return readTailHash(messagesPath, prev.offset).tailHash === prev.tailHash;
        } catch {
          // Any TOCTOU read failure falls back cleanly to Case C.
          return false;
        }
      };

      const canPatchMetadataWithoutDelete = (prev: MinimaxCursorState): boolean => {
        if (prev.sqliteTitle !== null && meta.title === null && prev.derivedTitle === null) {
          return false;
        }
        const nextEndedAt = maxIso(prev.maxMessageTimestamp, normalizeTime(meta.updatedAtMs));
        if (prev.endedAt !== null && (nextEndedAt === null || nextEndedAt < prev.endedAt)) {
          return false;
        }
        return true;
      };

      // Tier 1: Metadata-only patch / no-op (zero delete-session, zero file reads beyond head).
      if (
        prevCursor !== null &&
        prevCursor.structuralMetaHash === meta.structuralMetaHash &&
        prevCursor.generation === activeGeneration &&
        statMatchesCursor(beforeStat, prevCursor) &&
        canPatchMetadataWithoutDelete(prevCursor) &&
        (readMode === 'normal' || checkPrefixMatches(prevCursor))
      ) {
        if (prevCursor.sqliteTitle === meta.title && prevCursor.sqliteUpdatedAtMs === meta.updatedAtMs) {
          return cursor;
        }
        const endedAt = maxIso(prevCursor.maxMessageTimestamp, normalizeTime(meta.updatedAtMs));
        yield {
          kind: 'session',
          id: unit.sessionId,
          title: meta.title ?? prevCursor.derivedTitle,
          project: projectSlugFromPath(meta.cwd),
          started_at: prevCursor.startedAt,
          ended_at: endedAt,
          git_branch: null,
          version: null,
          message_count: prevCursor.visibleCount,
          countMode: 'total',
          jsonl_path: messagesPath,
          source: SOURCE,
          started_by: meta.startedBy,
        };
        return encodeCursor(beforeStat, {
          ...prevCursor,
          endedAt,
          sqliteTitle: meta.title,
          sqliteUpdatedAtMs: meta.updatedAtMs,
        });
      }

      // Tier 2 (Case A): Steady-state byte-offset append on the same generation/file.
      if (
        prevCursor !== null &&
        !prevCursor.seenTruncated &&
        prevCursor.structuralMetaHash === meta.structuralMetaHash &&
        prevCursor.generation === activeGeneration &&
        String(beforeStat.dev) === prevCursor.dev &&
        String(beforeStat.ino) === prevCursor.ino &&
        Number(beforeStat.size) >= prevCursor.offset &&
        canPatchMetadataWithoutDelete(prevCursor) &&
        checkPrefixMatches(prevCursor)
      ) {
        const fileSize = Number(beforeStat.size);
        const state: ProjectionState = {
          lastMessageUuid: prevCursor.lastMessageUuid,
          pendingTools: new Map(prevCursor.pendingTools),
          seenIdHashes: new Set(prevCursor.seenIdHashes),
          visibleCount: 0,
          startedAt: minIso(prevCursor.startedAt, normalizeTime(meta.createdAtMs)),
          maxMessageTimestamp: prevCursor.maxMessageTimestamp,
          derivedTitle: prevCursor.derivedTitle,
        };
        const { lines, nextOffset } = readCompleteLinesFromOffset(messagesPath, prevCursor.offset, fileSize);
        let lastMessageId = prevCursor.lastMessageId;
        for (const line of lines) {
          const envelope = parseEnvelopeLine(line);
          if (envelope === null) continue;
          yield* projectEnvelope(envelope, unit.sessionId, meta.cwd, state);
          lastMessageId = envelope.messageId;
        }
        const totalVisible = prevCursor.visibleCount + state.visibleCount;
        yield {
          kind: 'session',
          id: unit.sessionId,
          title: meta.title ?? state.derivedTitle,
          project: projectSlugFromPath(meta.cwd),
          started_at: state.startedAt,
          ended_at: maxIso(state.maxMessageTimestamp, normalizeTime(meta.updatedAtMs)),
          git_branch: null,
          version: null,
          message_count: totalVisible,
          countMode: 'total',
          jsonl_path: messagesPath,
          source: SOURCE,
          started_by: meta.startedBy,
        };
        const prefixVerified = readMode === 'strict' && prevCursor.prefixVerified;
        return finishCursor(nextOffset, state, totalVisible, lastMessageId, prefixVerified);
      }

      // Tier 3 (Case C): Safety net — full reachable-chain replay (`delete-session` + `countMode: 'total'`).
      const chainRes = resolveReachableFiles(meta.sessionDir, sessionsDir, messagesPath, activeHead);
      if (!chainRes.ok) {
        throw chainRes.error instanceof Error ? chainRes.error : new Error(String(chainRes.error));
      }

      if (cursor !== null || meta.replaceExisting) {
        yield { kind: 'delete-session', sessionId: unit.sessionId };
      }

      const state: ProjectionState = {
        lastMessageUuid: null,
        pendingTools: new Map(),
        seenIdHashes: new Set(),
        visibleCount: 0,
        startedAt: normalizeTime(meta.createdAtMs),
        maxMessageTimestamp: null,
        derivedTitle: null,
      };

      let activeOffset = 0;
      let lastMessageId: string | null = null;
      for (const filePath of chainRes.files) {
        if (filePath === messagesPath) {
          const activeSize = Number(beforeStat.size);
          const { lines, nextOffset } = readCompleteLinesFromOffset(messagesPath, 0, activeSize, {
            includeValidTrailingLine: true,
          });
          activeOffset = nextOffset;
          for (const line of lines) {
            const env = parseEnvelopeLine(line);
            if (env === null) continue;
            yield* projectEnvelope(env, unit.sessionId, meta.cwd, state);
            lastMessageId = env.messageId;
          }
        } else {
          for (const env of readAllEnvelopes(filePath)) {
            yield* projectEnvelope(env, unit.sessionId, meta.cwd, state);
            lastMessageId = env.messageId;
          }
        }
      }

      yield {
        kind: 'session',
        id: unit.sessionId,
        title: meta.title ?? state.derivedTitle,
        project: projectSlugFromPath(meta.cwd),
        started_at: state.startedAt,
        ended_at: maxIso(state.maxMessageTimestamp, normalizeTime(meta.updatedAtMs)),
        git_branch: null,
        version: null,
        message_count: state.visibleCount,
        countMode: 'total',
        jsonl_path: messagesPath,
        source: SOURCE,
        started_by: meta.startedBy,
      };
      return finishCursor(activeOffset, state, state.visibleCount, lastMessageId, true);
    },

    raw(input: RawLookup): RawRecord | null {
      return lookupRawMessage(input, sessionsDir);
    },
  };
}
