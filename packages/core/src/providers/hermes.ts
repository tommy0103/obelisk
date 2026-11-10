// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Hermes Agent session source.
//
// Hermes persists one conversation per session into a single SQLite database per
// install (or per named profile): `state.db`, WAL mode, at `get_hermes_home()` —
// `HERMES_HOME` when set, else `~/.hermes` on Linux/macOS and
// `%LOCALAPPDATA%/hermes` on Windows — with named profiles under `profiles/<name>/`.
// The earlier per-session JSONL files are no longer written or read upstream, so the
// database is the only transcript source. This adapter never writes the database: every
// connection is opened read-only, used for one operation, and closed. (SQLite itself may
// create or reuse the `-shm`/`-wal` sidecars a WAL read needs; the store's own bytes are
// never touched.)
//
// Change detection has two levels, because one store holds every session. A store-level
// gate (mtime + ctime + size + inode of `state.db` and `state.db-wal`, persisted under a
// `__`-prefixed pseudo key when the store has been certified) decides whether the store
// has to be opened at all. A per-session cursor — the mutable session fields, the
// session's message watermark, and an exact digest of the rows it projects — decides
// which sessions are scheduled. Both levels are needed: the gate keeps an idle store
// from being opened, and the per-session cursor keeps one session's write from
// invalidating every other session in the store.
//
// The database opener is injected (`HermesStoreOpener`), because Core runs under both
// `node:sqlite` (CLI) and better-sqlite3 (Electron) — see copilot.ts for the same seam.

import { createHash, randomUUID } from 'node:crypto';
import type { SqliteDb, SqliteRow } from '../sqlite-types.ts';
import type {
  Cursor,
  DiscoverContext,
  IndexUnit,
  MessageVisibility,
  ProviderAdapter,
  RawLookup,
  RawRecord,
  SessionRecord,
  SubagentRecord,
  SummaryRecord,
  TranscriptRecord,
  WatchTarget,
} from './types.ts';
import { dirname, isAbsolute, join, normalize, relative } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { normalizeObservedCwd, projectSlugFromPath, trunc } from '../parsing.ts';

export const name = 'hermes';
// v7: the exact message digest now frames every projected field unambiguously. An older digest
// could mistake a control character in reasoning text for a field boundary, certify the store,
// and leave changed thinking text stale. Replay those sessions before trusting the new digest.
export const HERMES_CANONICAL_TRANSCRIPT_MARKER = '__hermes_canonical_transcript_v7__';

const CURSOR_TAG = 'hermes-snapshot-v2';
const STORE_FILE = 'state.db';
const WAL_FILE = `${STORE_FILE}-wal`;
const PROFILES_DIR = 'profiles';
const TOMBSTONE_CURSOR = '0:0:hermes-tombstone';
const SESSION_PATH_PREFIX = 'session:';
// The store gate lives in `index_state` under a `__`-prefixed pseudo key, the way the
// provider markers do: `readRecentTranscriptHints` skips `__` keys, so it is never
// mistaken for a transcript path, and a force rebuild recreates it with everything else.
const STORE_GATE_PREFIX = '__hermes_store_v1__:';
const STORE_CURSOR_TAG = 'hermes-store-v2';
// Ordinary refreshes audit a fair, persisted slice; the first refresh after
// this deadline performs a complete audit. Strict CLI reads never defer it.
const AUDIT_BATCH_SESSIONS = 64;
const AUDIT_MAX_AGE_MS = 60_000;
// v2: the watermark counts non-NULL projected columns instead of summing their text lengths, so
// the per-store pass reads record headers rather than every message body. The input changes once,
// which replays a session the first time discovery compares it against an older cursor.
const WATERMARK_VERSION = 2;

// CLI-side read-only opener
export type HermesStoreOpener = (path: string) => SqliteDb;

type JsonObject = Record<string, unknown>;

interface HermesStoreSession {
  row: SqliteRow;
  dbPath: string;
  profile: string;
  fingerprint: string;
}

interface HermesUnitMeta {
  dbPath: string;
  profile: string;
  /** The store-level profile hint discovery resolved this store's rows with. The parent link
   * needs it because the parent row resolves its own profile from it, not from the child's. */
  profileHint: string | null;
  rawSessionId: string;
  sessionId: string;
  cwd: string | null;
  fingerprint: string;
  schemaVersion: number;
  currentCursor: Cursor;
  tombstone?: boolean;
  /** Set on the store-level gate unit, which carries no records. */
  storeGate?: boolean;
  /** A source observation is acknowledged only with this unit's commit. */
  auditToken?: string;
}

/** One session of a store read, with the identity and stored cursor discovery compares it by. */
interface StoreSessionEntry {
  session: HermesStoreSession;
  rawSessionId: string;
  sessionId: string;
  cursor: HermesCursor | null;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Like stringValue, but also accepts the numeric ids SQLite returns for INTEGER columns. */
function scalarValue(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();
  return stringValue(value);
}

/** SQLite message ids are INTEGER; the uuid carries them as text, so bind them back as numbers. */
function numericId(value: string): string | number {
  return /^\d+$/.test(value) ? Number(value) : value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * The path operations a containment check needs. They are injected so the Windows branch can be
 * exercised from any host: on Windows `relative` is separator- and case-aware, where comparing
 * against a literal "/" misses an indexed `C:\...\state.db#session:...`.
 */
export interface ContainmentPathOps {
  readonly caseInsensitive: boolean;
  normalize(path: string): string;
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
}

const nativePathOps: ContainmentPathOps = {
  caseInsensitive: process.platform === 'win32',
  normalize,
  relative,
  isAbsolute,
};

function samePathWithin(ops: ContainmentPathOps, left: string, right: string): boolean {
  const a = ops.normalize(left);
  const b = ops.normalize(right);
  return ops.caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** True when `candidate` (a store path, or a `<store>#session:<id>` source path) sits under `root`. */
export function pathInside(
  root: string,
  candidate: string,
  ops: ContainmentPathOps = nativePathOps,
): boolean {
  const base = ops.normalize(root);
  const target = ops.normalize(candidate);
  if (samePathWithin(ops, base, target)) return true;
  // relative() is platform-aware, where a literal "/" comparison would skip the
  // incomplete-inventory report for a Windows home that became unavailable.
  const remainder = ops.relative(base, target);
  if (remainder.length === 0) return false;
  return !ops.isAbsolute(remainder) && !/(^|[/\\])\.\.([/\\]|$)/.test(remainder);
}

function isoFromEpochSeconds(value: unknown): string | null {
  const seconds = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function expandRoot(rootDir: string, homeDir: string): string {
  const trimmed = rootDir.trim();
  if (trimmed === '~') return homeDir;
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(homeDir, trimmed.slice(2));
  return normalize(trimmed);
}

export function defaultHermesHome(homeDir: string = homedir()): string {
  const fromEnv = process.env['HERMES_HOME'];
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0 && isAbsolute(fromEnv.trim())) {
    return normalize(fromEnv.trim());
  }
  if (process.platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'];
    if (typeof localAppData === 'string' && localAppData.trim().length > 0) {
      return join(normalize(localAppData.trim()), 'hermes');
    }
  }
  return join(homeDir, '.hermes');
}

function profileKey(row: SqliteRow, profileDir: string | null): string {
  const declared = stringValue(row['profile_name']);
  if (declared !== null) return declared;
  return profileDir ?? 'default';
}

export function hermesSessionId(rawSessionId: string, profile: string, dbPath: string): string {
  // Scope by the store as well as the profile, the way copilot.ts scopes chronicle sessions by
  // their root: two stores can share a profile name, and then a copied session would collide.
  return `hermes:${encodeURIComponent(rawSessionId)}:${sha256(`hermes-store-v1\0${profile}\0${normalize(dbPath)}`)}`;
}

function messageUuid(sessionId: string, rawMessageId: string, projection: string): string {
  return `${sessionId}:${projection}:${encodeURIComponent(rawMessageId)}`;
}

function toolCallId(sessionId: string, rawToolCallId: string): string {
  return `${sessionId}:tool:${encodeURIComponent(rawToolCallId)}`;
}

function sourcePathFor(dbPath: string, rawSessionId: string): string {
  return `${dbPath}#${SESSION_PATH_PREFIX}${encodeURIComponent(rawSessionId)}`;
}

/**
 * Decode a session-scoped source path (`<store>#session:<raw id>`). The daemon's changed-path
 * hints are filesystem paths, but an indexed session's own `jsonl_path` can be fed back as one;
 * naming a single session must not be allowed to schedule its whole store.
 */
function rawSessionIdFromSourcePath(dbPath: string, candidate: string): string | null {
  const prefix = normalize(`${dbPath}#${SESSION_PATH_PREFIX}`);
  const target = normalize(candidate);
  const comparable = nativePathOps.caseInsensitive ? target.toLowerCase() : target;
  const base = nativePathOps.caseInsensitive ? prefix.toLowerCase() : prefix;
  if (!comparable.startsWith(base)) return null;
  try {
    return decodeURIComponent(target.slice(prefix.length));
  } catch {
    return null;
  }
}

function storeMtime(dbPath: string): number {
  const read = (path: string): number => {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return 0;
    }
  };
  return Math.max(read(dbPath), read(`${dbPath}-wal`));
}

/**
 * Session-level token totals, for lineage rows only: per-message usage is not recorded upstream.
 * Older stores may lack these columns; absent values leave the link intact without usage.
 * Cache and reasoning tokens are already accounted for by the session's input/output totals.
 */
function sessionTotalTokens(row: SqliteRow): number | null {
  const input = Number(row['input_tokens'] ?? 0);
  const output = Number(row['output_tokens'] ?? 0);
  const total = (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0);
  return total > 0 ? total : null;
}

/** mtime + ctime + size + inode of one store file, per the cursor rule in CONTRIBUTING. */
function fileSignature(path: string): string {
  try {
    const stat = statSync(path);
    // A zero-length file carries no rows. SQLite may leave an empty WAL after a checkpoint, and
    // counting its identity would move the gate from a read that changed nothing. A zero-length
    // database can never be certified: opening it fails before any gate is written.
    if (stat.size === 0) return 'absent';
    return [stat.mtimeMs, stat.ctimeMs, stat.size, stat.ino].join(':');
  } catch {
    return 'absent';
  }
}

/**
 * The store-level gate: mtime + ctime + size + inode of the database and its WAL, so a
 * same-millisecond rewrite that leaves the content fingerprints untouched still moves it.
 * It is a property of the STORE, not of a session: putting it into every session cursor
 * made any write invalidate every session in the store, and one appended line replayed
 * the whole database.
 */
function storeGate(dbPath: string): string {
  return sha256(`${fileSignature(dbPath)}|${fileSignature(`${dbPath}-wal`)}`);
}

function storeGateKey(dbPath: string): string {
  return `${STORE_GATE_PREFIX}${sha256(`${STORE_CURSOR_TAG}\0${normalize(dbPath)}`)}`;
}

/**
 * Whether the store file is there, gone, or there but not describable. `existsSync` answers the
 * first two and folds EACCES on any component into "absent", which must not be read as a deletion
 * (skill's `existsSync` trap, and the reason the unreadable case still reports an incomplete
 * inventory instead of retracting).
 */
function storeFileState(dbPath: string): 'present' | 'missing' | 'unreadable' {
  try {
    statSync(dbPath);
    return 'present';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
  }
}

interface HermesStoreCursor {
  /** The store gate the whole store was last examined at. */
  gate: string;
  /** Digest of the session ids the store enumerated at that gate. */
  sessions: string;
  /** True when that examination scheduled nothing, so the store can be skipped outright. */
  complete: boolean;
  audit: HermesAudit;
}

interface HermesAudit {
  token: string;
  after: string | null;
  startedAt: number;
  startGate: string;
}

/** `${mtime}:0:${STORE_CURSOR_TAG}:${gate}:${sessions}:${auditBase64}:0|1`. */
function parseStoreCursor(cursor: Cursor): HermesStoreCursor | null {
  if (cursor === null) return null;
  const parts = cursor.split(':');
  if (parts.length !== 7 || parts[2] !== STORE_CURSOR_TAG || !/^[01]$/.test(parts[6]!)
    || !/^[0-9a-f]{64}$/.test(parts[3]!) || !/^[0-9a-f]{64}$/.test(parts[4]!)) return null;
  try {
    const audit = JSON.parse(Buffer.from(parts[5]!, 'base64url').toString('utf8')) as Partial<HermesAudit>;
    if (typeof audit.token !== 'string' || !/^[0-9a-f-]{36}$/.test(audit.token)
      || (audit.after !== null && typeof audit.after !== 'string')
      || !Number.isSafeInteger(audit.startedAt) || audit.startedAt! < 0
      || typeof audit.startGate !== 'string' || !/^[0-9a-f]{64}$/.test(audit.startGate)) return null;
    return { gate: parts[3]!, sessions: parts[4]!, complete: parts[6] === '1', audit: audit as HermesAudit };
  } catch { return null; }
}

function storeCursor(dbPath: string, gate: string, sessions: string, audit: HermesAudit, complete: boolean): Cursor {
  return [String(storeMtime(dbPath)), '0', STORE_CURSOR_TAG, gate, sessions,
    Buffer.from(JSON.stringify(audit)).toString('base64url'), complete ? '1' : '0'].join(':');
}

/**
 * Digest of a store's session-id set. The gate alone proves the file did not move; this
 * proves the INDEX's set for the store is the one the store enumerated when the gate was
 * written, so skipping a certified store can never hide a session that needs retracting.
 */
function sessionsDigest(sessionIds: Iterable<string>): string {
  return sha256([...sessionIds].sort().join('\n'));
}

interface HermesCursor {
  /** The store gate this cursor was written at. */
  gate: string;
  /** The session fingerprint (mutable session fields + message watermark). */
  fingerprint: string;
  /** The exact digest of the session's projected rows, when one has been computed. */
  digest: string | null;
  auditToken: string | null;
}

/** `${mtime}:0:${CURSOR_TAG}:${gate}:${fingerprint}[:${digest}[:${auditToken}]]`. */
function parseHermesCursor(cursor: Cursor): HermesCursor | null {
  if (cursor === null) return null;
  const parts = cursor.split(':');
  if (parts.length < 5 || parts.length > 7 || parts[2] !== CURSOR_TAG
    || !/^[0-9a-f]{64}$/.test(parts[3]!) || !/^[0-9a-f]{64}$/.test(parts[4]!)
    || (parts[5] && !/^[0-9a-f]{64}$/.test(parts[5]))
    || (parts[6] && !/^[0-9a-f-]{36}$/.test(parts[6]))) return null;
  return { gate: parts[3]!, fingerprint: parts[4]!, digest: parts[5] || null, auditToken: parts[6] || null };
}

function sessionCursor(
  dbPath: string,
  gate: string,
  fingerprint: string,
  digest: string | null,
  auditToken: string | null = null,
): Cursor {
  // The first field stays the store mtime: persist() reads it into index_state.mtime.
  const parts = [String(storeMtime(dbPath)), '0', CURSOR_TAG, gate, fingerprint];
  if (digest !== null || auditToken !== null) parts.push(digest ?? '');
  if (auditToken !== null) parts.push(auditToken);
  return parts.join(':');
}

function storePaths(home: string): {
  stores: { dbPath: string; profile: string }[];
  errors: { path: string; error: string }[];
} {
  const stores = [{ dbPath: join(home, STORE_FILE), profile: 'default' }];
  const profilesDir = join(home, PROFILES_DIR);
  let entries: string[];
  try {
    entries = readdirSync(profilesDir);
  } catch (error) {
    // A missing profiles directory is normal: most installs never create one, and a directory
    // that is really gone means its sessions are gone too, so they follow the retraction path.
    // Any other read failure (EACCES, an unmounted share, a sandbox) means the inventory is
    // incomplete, and an incomplete inventory must never retract sessions that are merely
    // unreachable.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { stores, errors: [] };
    return { stores, errors: [{ path: profilesDir, error: describeError(error) }] };
  }
  const named: { dbPath: string; profile: string }[] = [];
  const errors: { path: string; error: string }[] = [];
  for (const entry of entries.sort()) {
    const profileDir = join(profilesDir, entry);
    try {
      if (!statSync(profileDir).isDirectory()) continue;
    } catch (error) {
      // readdir just returned this name, so ENOENT here is an enumeration/stat race (or a
      // dangling symlink), never evidence that the profile was deleted: treat every stat
      // failure as an incomplete inventory and keep going. A profile that is really gone is
      // confirmed by the next stable scan, where readdir no longer lists it at all.
      errors.push({ path: profileDir, error: describeError(error) });
      continue;
    }
    named.push({ dbPath: join(profileDir, STORE_FILE), profile: entry });
  }
  return { stores: [...named, ...stores], errors };
}

function readSchemaVersion(db: SqliteDb): number | null {
  const rows = db.prepare('SELECT * FROM schema_version LIMIT 1').all();
  const row = rows[0];
  if (!row) return null;
  // By name, never by position: a table that declared another column first would otherwise have
  // that column read as the version. A store that does not name it has no version to report, and a
  // guess here would feed a wrong number into every session fingerprint.
  // The null check is not redundant with the NaN one: `Number(null)` is 0, so a NULL version would
  // otherwise read as version zero and be accepted.
  const value = row['version'];
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The columns this adapter cannot work without. Together they are the real contract: a store that
 * has them can be projected whatever its `schema_version` says, because every upstream release so
 * far has only ADDED columns (hermes_cli/session_schema_history.py). A version ceiling therefore
 * reported nothing but the passing of time — it rejected every store written by a newer Hermes even
 * when the shape was unchanged, and cost a code change per upstream release.
 *
 * Reading the shape instead means a new Hermes version needs a patch only when it removes or
 * renames something projected here, which is when a patch is actually owed. This is the same rule
 * `sessionColumns()` already applies to the optional usage columns.
 *
 * These are also the SELECT lists they guard, so "the shape check passed" and "parse() can read
 * every column it names" cannot drift apart.
 */
const SESSION_COLUMNS = [
  'id', 'source', 'model', 'title', 'parent_session_id', 'started_at', 'ended_at', 'end_reason',
  'message_count', 'tool_call_count', 'cwd', 'git_branch', 'profile_name', 'archived', 'hidden',
] as const;

/** Every column parse() projects from a message row; the digest pass reads exactly these too. */
const PROJECTED_MESSAGE_COLUMNS = [
  'id', 'role', 'content', 'tool_calls', 'tool_call_id', 'tool_name', 'timestamp',
  'reasoning', 'reasoning_content', 'active', 'compacted', 'display_kind',
  'codex_message_items', '_compressed_summary',
] as const;

/** As above, plus the session column the per-session reads scan on. */
const REQUIRED_MESSAGES_COLUMNS = ['session_id', ...PROJECTED_MESSAGE_COLUMNS];

/**
 * The columns `table` is missing from `required`, or `null` when the table cannot be introspected
 * at all. A read-only store answers `PRAGMA table_info`; a database that does not is not one this
 * adapter can project.
 */
function missingColumns(db: SqliteDb, table: string, required: readonly string[]): string[] | null {
  let present: Set<string>;
  try {
    present = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row['name'])));
  } catch {
    return null;
  }
  if (present.size === 0) return null;
  return required.filter(column => !present.has(column));
}

/**
 * `null` when this store's shape can be projected, otherwise the reason it cannot. Replaces the
 * former `schemaVersion > SUPPORTED_SCHEMA_VERSION` gate: a store is rejected for what it lacks,
 * not for how new it claims to be.
 */
function unreadableShape(db: SqliteDb, schemaVersion: number): string | null {
  for (const [table, required] of [
    ['sessions', SESSION_COLUMNS],
    ['messages', REQUIRED_MESSAGES_COLUMNS],
  ] as const) {
    const missing = missingColumns(db, table, required);
    if (missing === null) {
      return `Hermes state store (schema version ${schemaVersion}) has no readable ${table} table`;
    }
    if (missing.length > 0) {
      return `Unsupported Hermes schema version ${schemaVersion}: ${table} is missing ${missing.join(', ')}`;
    }
  }
  return null;
}

/** Add optional usage columns only where the source schema has them. */
function sessionColumns(db: SqliteDb): string {
  const present = new Set(db.prepare('PRAGMA table_info(sessions)').all().map(row => String(row['name'])));
  const usage = ['input_tokens', 'output_tokens'].filter(column => present.has(column));
  return [...SESSION_COLUMNS, ...usage].join(', ');
}

function readSessionRows(db: SqliteDb): SqliteRow[] {
  return db
    .prepare(
      `SELECT ${sessionColumns(db)} FROM sessions ORDER BY started_at, id`,
    )
    .all();
}

/**
 * A per-session fingerprint: the mutable session fields plus a row-shape message watermark.
 * parse() re-derives it and refuses to write records for a session that changed after discovery.
 * The watermark reads no message body, and every aggregate below is answerable from the record
 * header or the rowid. That rules out `timestamp`, `active` and `compacted`: upstream stores them
 * after the large text columns, so reading any of them walks the text's overflow pages. An
 * in-place edit to one of those, or to a body, reaches the index only through the exact digest,
 * which runs when the store moved without an explained session change. `typeof` is the only NULL
 * test SQLite answers from the header; `x IS NOT NULL` and `COUNT(x)` materialize the value.
 */
const WATERMARK_AGGREGATES = `
      COUNT(*) AS total, MAX(rowid) AS last_rowid, MAX(id) AS last_id,
      SUM(typeof(content) <> 'null') AS content_rows,
      SUM(typeof(tool_calls) <> 'null') AS calls_rows,
      SUM(typeof(display_kind) <> 'null') AS display_rows`;

/**
 * Every session's watermark in one grouped query. Discovery runs this once per store
 * instead of once per session: it measured ~38 ms over ~122 sessions, where the
 * per-session form cost the whole cold-start read.
 */
function sessionWatermarks(db: SqliteDb): Map<string, SqliteRow> {
  const rows = db
    .prepare(`SELECT session_id, ${WATERMARK_AGGREGATES} FROM messages GROUP BY session_id`)
    .all();
  const watermarks = new Map<string, SqliteRow>();
  for (const row of rows) watermarks.set(String(row['session_id']), row);
  return watermarks;
}

function sessionWatermark(db: SqliteDb, sessionId: unknown): SqliteRow | undefined {
  return db
    .prepare(`SELECT ${WATERMARK_AGGREGATES} FROM messages WHERE session_id = ?`)
    .get(sessionId);
}

/**
 * What a subagent's fingerprint carries beyond its own row: the raw id of its parent and the
 * profile key that names it. A child's own row does not move when its parent is deleted or
 * restored (owner's #198 ZCode P1), so without this input the child is skipped on the next scan
 * and the link its parent's return should rebuild is never re-emitted. Absent for every other
 * session: a compression-triggered split also carries a parent but emits no link, and a parent
 * that is not in this store cannot be named at all, so neither has a link to keep in step.
 */
function parentSignature(row: SqliteRow, parentRow: SqliteRow | undefined, hint: string | null): string | null {
  if (stringValue(row['source']) !== 'subagent') return null;
  const rawParentId = stringValue(row['parent_session_id']);
  if (rawParentId === null || parentRow === undefined) return null;
  return `${rawParentId}\u0000${profileKey(parentRow, hint)}`;
}

/** The parent row a child's link needs, read from the same snapshot as the child's own row. */
function readParentRow(db: SqliteDb, rawParentId: string): SqliteRow | undefined {
  return db.prepare('SELECT id, profile_name FROM sessions WHERE id = ?').get(rawParentId);
}

function sessionFingerprint(
  row: SqliteRow,
  profile: string,
  watermark: SqliteRow | undefined,
  parent: string | null,
  schemaVersion: number,
): string {
  return sha256(
    JSON.stringify({
      profile,
      schemaVersion,
      // Omitted rather than written as null, so a session that never had a parent in this store
      // keeps the fingerprint it already had instead of being replayed once for nothing.
      ...(parent === null ? {} : { parent }),
      session: [
        row['id'],
        row['source'],
        row['model'],
        row['title'],
        row['parent_session_id'],
        row['started_at'],
        row['ended_at'],
        row['end_reason'],
        row['message_count'],
        row['tool_call_count'],
        row['cwd'],
        row['git_branch'],
        row['archived'],
        row['hidden'],
        row['input_tokens'] ?? null,
        row['output_tokens'] ?? null,
      ],
      messages: [
        WATERMARK_VERSION,
        Number(watermark?.['total'] ?? 0),
        watermark?.['last_rowid'] ?? null,
        watermark?.['last_id'] ?? null,
        Number(watermark?.['content_rows'] ?? 0),
        Number(watermark?.['calls_rows'] ?? 0),
        Number(watermark?.['display_rows'] ?? 0),
      ],
    }),
  );
}

/** The fingerprint of a session whose watermark has to be read on its own (parse()). */
function sessionFingerprintOf(
  db: SqliteDb,
  row: SqliteRow,
  profile: string,
  parent: string | null,
  schemaVersion: number,
): string {
  return sessionFingerprint(row, profile, sessionWatermark(db, row['id']), parent, schemaVersion);
}

function digestOfMessages(rows: readonly SqliteRow[]): string {
  const hash = createHash('sha256');
  for (const row of rows) {
    for (const column of PROJECTED_MESSAGE_COLUMNS) {
      const value = row[column];
      if (value === null || value === undefined) {
        hash.update('N');
        continue;
      }
      // A separator can occur inside provider text. Type and byte-length frames make the digest
      // unambiguous even for NUL, control characters, and a rewritten pair of adjacent columns.
      const bytes = value instanceof Uint8Array ? value : Buffer.from(String(value));
      const type = value instanceof Uint8Array ? 'B' : typeof value;
      hash.update(`${type}:${bytes.byteLength}:`);
      hash.update(bytes);
    }
    hash.update('\u0002');
  }
  return hash.digest('hex');
}

/**
 * The exact digest of one session's projected rows. Strict refresh verifies every
 * unproven session; ordinary refresh rotates a bounded slice and verifies fully
 * at its deadline. Header aggregates cannot attribute hidden edits, even beside
 * another session's append. SQLite exposes no built-in hash, so digest in JS.
 */
function exactSessionDigest(db: SqliteDb, sessionId: unknown): string {
  const rows = db
    .prepare(
      `SELECT ${PROJECTED_MESSAGE_COLUMNS.join(', ')} FROM messages WHERE session_id = ? ORDER BY rowid`,
    )
    .all(sessionId);
  return digestOfMessages(rows);
}

function readStoreSessions(
  dbPath: string,
  profileHint: string | null,
  openStore: HermesStoreOpener,
): { schemaVersion: number; sessions: HermesStoreSession[] } | { error: string } {
  let db: SqliteDb | null = null;
  try {
    db = openStore(dbPath);
    // One read transaction for schema version, sessions and watermarks: a WAL writer can
    // commit between two statements, and "old session metadata + new messages" must not be
    // handed to a caller as one store image.
    db.exec('BEGIN');
    const schemaVersion = readSchemaVersion(db);
    if (schemaVersion === null) return { error: 'Hermes state store has no schema_version.version column' };
    const unreadable = unreadableShape(db, schemaVersion);
    if (unreadable !== null) return { error: unreadable };
    const watermarks = sessionWatermarks(db);
    const rows = readSessionRows(db);
    // A subagent's fingerprint includes its parent's liveness and profile, so the parent has to be
    // resolved from the same snapshot: index the rows once instead of one query per child.
    const rowsById = new Map<string, SqliteRow>();
    for (const row of rows) {
      const rowId = stringValue(row['id']);
      if (rowId !== null) rowsById.set(rowId, row);
    }
    const sessions: HermesStoreSession[] = [];
    for (const row of rows) {
      const rawSessionId = stringValue(row['id']);
      if (rawSessionId === null) continue;
      const profile = profileKey(row, profileHint);
      const rawParentId = stringValue(row['parent_session_id']);
      const parent = parentSignature(row, rawParentId === null ? undefined : rowsById.get(rawParentId), profileHint);
      sessions.push({
        row,
        dbPath,
        profile,
        fingerprint: sessionFingerprint(row, profile, watermarks.get(rawSessionId), parent, schemaVersion),
      });
    }
    db.exec('COMMIT');
    return { schemaVersion, sessions };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    try {
      db?.close();
    } catch {
      /* a failed close must not mask the read result */
    }
  }
}

function messageVisibility(row: SqliteRow): MessageVisibility {
  // `display_kind` is not one thing: upstream suppresses only `hidden` in display history
  // (tui_gateway/session_history.py), while the other kinds are timeline markers that stay in the
  // conversation. The real store's `async_delegation_complete` rows carry the delegation result
  // back into the session as ordinary user text, so hiding every kind would drop real turns from
  // search and from the timeline.
  if (stringValue(row['display_kind']) === 'hidden') return 'hidden';
  return Number(row['active'] ?? 1) === 0 ? 'inactive' : 'visible';
}

function toolInputJson(value: unknown): string {
  if (typeof value === 'string') return trunc(value);
  try {
    const encoded = JSON.stringify(value ?? {});
    return encoded === undefined ? '{}' : trunc(encoded);
  } catch {
    return '{}';
  }
}

interface HermesParseDeps {
  openStore?: HermesStoreOpener;
}

/** Upstream keeps the text of those parts only (codex_responses_adapter._OUTPUT_TEXT_TYPES). */
const OUTPUT_TEXT_TYPES = new Set(['output_text', 'text']);

/**
 * Text of a Reply that Hermes stored only as Responses message items: an assistant `content`
 * array whose parts are `output_text` / `text`. Returns null when the column carries nothing
 * projectable, so a genuinely textless row still emits `text: null`.
 */
function codexMessageText(row: SqliteRow): string | null {
  const raw = stringValue(row['codex_message_items']);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const parts: string[] = [];
  for (const item of parsed) {
    if (!isObject(item)) continue;
    if (stringValue(item['type']) !== 'message' || stringValue(item['role']) !== 'assistant') continue;
    const content = item['content'];
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!isObject(part)) continue;
      const partType = stringValue(part['type']);
      if (partType === null || !OUTPUT_TEXT_TYPES.has(partType)) continue;
      const text = stringValue(part['text']);
      if (text !== null) parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

function readToolCalls(row: SqliteRow): { id: string; name: string; input: unknown }[] {
  const rawCalls = stringValue(row['tool_calls']);
  if (rawCalls === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawCalls);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const calls: { id: string; name: string; input: unknown }[] = [];
  for (const entry of parsed) {
    if (!isObject(entry)) continue;
    const fn = isObject(entry['function']) ? entry['function'] : entry;
    const callName = stringValue(fn['name']);
    if (callName === null) continue;
    // Upstream resolves Codex Responses calls as `call_id || id`, and tool rows carry the
    // call_id, so that is the id the pairing has to use.
    const callId = stringValue(entry['call_id']) ?? stringValue(entry['id']);
    calls.push({
      id: callId ?? `${String(row['id'])}:call-${String(calls.length).padStart(3, '0')}`,
      name: callName,
      input: fn['arguments'],
    });
  }
  return calls;
}

/**
 * Upstream classifies a compaction handoff by content as well as by the private
 * `_compressed_summary` flag, because rows an older build wrote carry the text without the flag.
 * `ContextCompressor.classify_summary_content` calls a row that begins with a handoff prefix
 * *standalone* — so a text that merely quotes the marker stays an ordinary record — and a row
 * that carries real text, then the delimiter, then the handoff *merged*. A row that opens with
 * the merged header counts as a carrier too, the way upstream's own `_looks_like_compaction_summary`
 * treats it: collapsing one would drop the preserved text it carries. That is deliberately wider
 * than `classify_summary_content`, which calls a row merged only when the text after the delimiter
 * begins with a prefix; where the two disagree the row stays a message, so a flagged row whose tail
 * was rewritten is kept rather than collapsed. Upstream keeps a carrier's preserved tail as a
 * normal message and strips only the handoff for display, so a carrier stays a message here too.
 */
const COMPACTION_SUMMARY_PREFIXES = ['[CONTEXT COMPACTION', '[CONTEXT SUMMARY]:'];
const MERGED_SUMMARY_DELIMITER = '[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]';
const MERGED_CONTEXT_HEADER = '[PRIOR CONTEXT — for reference only; not a new message]';

type CompactionSummaryShape = 'standalone' | 'merged' | null;

function classifyCompactionSummary(content: string | null): CompactionSummaryShape {
  if (content === null) return null;
  const text = content.trimStart();
  if (text.startsWith(MERGED_CONTEXT_HEADER) || text.includes(MERGED_SUMMARY_DELIMITER)) {
    return 'merged';
  }
  return COMPACTION_SUMMARY_PREFIXES.some((prefix) => text.startsWith(prefix))
    ? 'standalone'
    : null;
}

function hermesParse({ openStore }: HermesParseDeps) {
  return function* parse(unit: IndexUnit, _cursor: Cursor): Generator<TranscriptRecord, Cursor> {
    const meta = unit.meta as HermesUnitMeta;
    if (meta.tombstone === true) return null;
    // The store gate unit carries no records: parse() only hands back the gate it wrote, so
    // persist() refreshes the pseudo row the next discovery skips on.
    if (meta.storeGate === true) return meta.currentCursor;
    if (openStore === undefined) throw new Error('No read-only Hermes store opener is configured');

    let db: SqliteDb | null = null;
    try {
      // The gate is sampled before the file is even opened, so the cursor can only claim a store
      // state older than the image these records come from. Sampling it after the records were
      // emitted would certify a write that landed during the emission and moved nothing the
      // watermark aggregates can see (an in-place same-length rewrite): the next scan would match
      // the fresh gate, skip the session, and the stale text would stay indexed. Sampling it after
      // the open would let a rename-over of the path in that window hand the cursor a *newer*
      // file's gate while the rows came from the old inode.
      const gate = storeGate(meta.dbPath);
      db = openStore(meta.dbPath);
      // One read transaction for every statement of this parse. Under WAL a writer could
      // otherwise commit between the session row and the message list, and the adapter
      // would emit "old session metadata + new messages" as one transcript.
      db.exec('BEGIN');
      const schemaVersion = readSchemaVersion(db);
      if (schemaVersion !== meta.schemaVersion) {
        throw new Error(`Hermes schema version changed after discovery: ${meta.rawSessionId}`);
      }
      const row = db
        .prepare(
          `SELECT ${sessionColumns(db)} FROM sessions WHERE id = ?`,
        )
        .get(meta.rawSessionId);
      if (!row) throw new Error(`Hermes session disappeared after discovery: ${meta.rawSessionId}`);
      // The parent row is read here rather than with the link below: its liveness and profile are
      // part of the fingerprint this parse has to reproduce, both before and after the row read.
      const sessionSource = stringValue(row['source']);
      const rawParentId = stringValue(row['parent_session_id']);
      const hasParent = sessionSource === 'subagent' && rawParentId !== null;
      const parentRow = hasParent ? readParentRow(db, rawParentId!) : undefined;
      const parent = parentSignature(row, parentRow, meta.profileHint);
      // Refuse to write records from a torn read: the next scan reparses the session.
      const fingerprint = sessionFingerprintOf(db, row, meta.profile, parent, schemaVersion);
      if (fingerprint !== meta.fingerprint) {
        throw new Error(`Hermes session changed after discovery: ${meta.rawSessionId}`);
      }

      // Upstream reads a session in insertion order and warns that clocks regress, so rowid
      // decides the transcript order rather than timestamp.
      const messages = db
        .prepare(
          `SELECT ${PROJECTED_MESSAGE_COLUMNS.join(', ')}
         FROM messages WHERE session_id = ? ORDER BY rowid`,
        )
        .all(meta.rawSessionId);

      const totalTokens = hasParent ? sessionTotalTokens(row) : null;

      // The transaction is the snapshot; this second fingerprint check makes a torn read
      // explicit (a rollback-journal store can still see a commit inside one transaction)
      // instead of trusting the snapshot to be repeated.
      if (sessionFingerprintOf(db, row, meta.profile, parent, schemaVersion) !== fingerprint) {
        throw new Error(`Hermes session changed while it was read: ${meta.rawSessionId}`);
      }
      const digest = digestOfMessages(messages);
      db.exec('COMMIT');

      const model = stringValue(row['model']);
      const base = {
        session_id: meta.sessionId,
        source: name,
        model,
        cwd: meta.cwd,
        skill: null,
        is_sidechain: 0 as const,
        agent_id: null,
        input_tokens: null,
        output_tokens: null,
      };
      const callOwners = new Map<string, string>();
      const emittedCalls = new Set<string>();
      let previousUuid: string | null = null;
      let visibleMessages = 0;
      let startedAt = isoFromEpochSeconds(row['started_at']);
      let endedAt = isoFromEpochSeconds(row['ended_at']);

      for (const [messageIndex, message] of messages.entries()) {
        const role = stringValue(message['role']);
        const timestamp = isoFromEpochSeconds(message['timestamp']);
        if (timestamp !== null) {
          startedAt ??= timestamp;
          endedAt = timestamp;
        }
        const visibility = messageVisibility(message);
        const isMeta = (visibility === 'hidden' ? 1 : 0) as 0 | 1;
        const rawMessageId =
          scalarValue(message['id']) ?? `${meta.rawSessionId}:row-${String(messageIndex).padStart(6, '0')}`;

        const text = stringValue(message['content']);
        const markedSummary = Number(message['_compressed_summary'] ?? 0) === 1;
        const summaryShape = classifyCompactionSummary(text);
        // Only a turn can be replaced by a summary: upstream keeps a tool row a tool result and
        // never replays a handoff as one, and a carrier's preserved text is not a handoff at all.
        const handoff = (role === 'user' || role === 'assistant')
          && summaryShape !== 'merged'
          && (markedSummary || summaryShape === 'standalone');
        if (handoff) {
          // Upstream's context compressor writes the compaction summary as its own row. It is
          // not a turn of the conversation: emitting it as a message both invents user/assistant
          // speech and inflates message_count, so it becomes a summary like kimi.ts does for
          // context.apply_compaction.
          yield {
            kind: 'summary',
            id: messageUuid(meta.sessionId, rawMessageId, 'summary'),
            session_id: meta.sessionId,
            timestamp,
            source: 'compaction',
            content: trunc(text ?? codexMessageText(message) ?? ''),
            visibility,
            // session-detail.ts materializes both keys (as null) on the persisted row path, so a
            // direct record that omits them fails the ADR-0007 round trip on any session that has
            // a handoff. copilot.ts declares them for the same reason.
            input_tokens: null,
            output_tokens: null,
          } satisfies SummaryRecord;
          continue;
        }

        if (role === 'tool') {
          // Tool rows carry the result, not a displayed message: it attaches to the
          // assistant message that owns the call, the same way copilot.ts attaches
          // Chronicle tool output.
          const rawCallId = stringValue(message['tool_call_id']);
          if (rawCallId === null) continue;
          const owner = callOwners.get(rawCallId) ?? previousUuid;
          if (owner === null) continue;
          yield {
            kind: 'tool_result',
            tool_use_id: toolCallId(meta.sessionId, rawCallId),
            message_uuid: owner,
            session_id: meta.sessionId,
            content: trunc(stringValue(message['content']) ?? ''),
            file_path: null,
            is_error: 0,
          };
          continue;
        }
        if (role !== 'user' && role !== 'assistant') continue;

        const reasoning = stringValue(message['reasoning_content']) ?? stringValue(message['reasoning']);
        if (role === 'assistant' && reasoning !== null) {
          const thinkingUuid = messageUuid(meta.sessionId, rawMessageId, 'thinking');
          yield {
            kind: 'message',
            uuid: thinkingUuid,
            type: 'assistant',
            parent_uuid: previousUuid,
            timestamp,
            role: 'assistant',
            text: trunc(reasoning),
            content_type: 'thinking',
            visibility,
            is_meta: isMeta,
            ...base,
          };
          previousUuid = thinkingUuid;
        }

        const calls = role === 'assistant' ? readToolCalls(message) : [];
        // A final Responses reply can live only in `codex_message_items`, with an empty `content`.
        const messageText = text ?? (role === 'assistant' ? codexMessageText(message) : null);
        const uuid = messageUuid(meta.sessionId, rawMessageId, 'message');
        yield {
          kind: 'message',
          uuid,
          type: role,
          parent_uuid: previousUuid,
          timestamp,
          role,
          text: messageText === null ? null : trunc(messageText),
          content_type: messageText !== null ? 'text' : calls.length > 0 ? 'tool_use' : 'unknown',
          visibility,
          is_meta: isMeta,
          ...base,
        };
        if (visibility === 'visible') visibleMessages += 1;
        previousUuid = uuid;

        for (const call of calls) {
          const canonicalId = toolCallId(meta.sessionId, call.id);
          callOwners.set(call.id, uuid);
          if (emittedCalls.has(canonicalId)) continue;
          emittedCalls.add(canonicalId);
          yield {
            kind: 'tool_call',
            id: canonicalId,
            message_uuid: uuid,
            session_id: meta.sessionId,
            name: call.name,
            presentation: 'default',
            input_json: toolInputJson(call.input),
            file_path: null,
          };
        }
      }
      yield {
        kind: 'session',
        id: meta.sessionId,
        title: stringValue(row['title']),
        project: projectSlugFromPath(meta.cwd),
        started_at: startedAt,
        ended_at: endedAt,
        git_branch: stringValue(row['git_branch']),
        version: `hermes-v${meta.schemaVersion}`,
        message_count: visibleMessages,
        countMode: 'total',
        jsonl_path: sourcePathFor(meta.dbPath, meta.rawSessionId),
        source: name,
      } satisfies SessionRecord;
      // Hermes gives a delegated session its own row (and its own transcript) with
      // parent_session_id pointing back at the parent, so unlike Claude Code's sidechain units the
      // child is a first-class session: the lineage is recorded without suppressing its messages.
      // Only upstream's `subagent` class is a subagent; the `cli` rows that also carry a parent are
      // compression-triggered splits, not delegated work. Hermes does not record the id of the
      // spawning call, so parent_tool_use_id stays null (persist merges columns with COALESCE).
      if (hasParent) {
        // The parent has to live in this store: a child's id scope encodes its own store, so a
        // parent elsewhere cannot be named exactly and a fabricated id would link to nothing.
        if (parentRow !== undefined) {
          const elapsed = startedAt !== null && endedAt !== null
            ? Date.parse(endedAt) - Date.parse(startedAt)
            : Number.NaN;
          yield {
            kind: 'subagent',
            agent_id: meta.sessionId,
            session_id: hermesSessionId(rawParentId!, profileKey(parentRow, meta.profileHint), meta.dbPath),
            parent_tool_use_id: null,
            agent_type: sessionSource,
            description: stringValue(row['title']),
            // Upstream warns that clocks regress; a backwards span is reported as unknown rather
            // than as a negative duration.
            duration_ms: Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null,
            total_tokens: totalTokens,
          } satisfies SubagentRecord;
        }
      }
      // The cursor carries the store gate this read happened at, the fingerprint it verified,
      // and the exact digest of the rows it projected, so the next discovery can tell an
      // untouched session from a rewritten one without re-reading it.
      return sessionCursor(meta.dbPath, gate, fingerprint, digest, meta.auditToken ?? null);
    } finally {
      try {
        db?.close();
      } catch {
        /* a failed close must not mask the read result */
      }
    }
  };
}

function rawHermes(input: RawLookup, openStore?: HermesStoreOpener): RawRecord | null {
  if (openStore === undefined) return null;
  try {
    const sessionPath = stringValue((input.session ?? {})['jsonl_path'] as unknown);
    if (sessionPath === null) return null;
    // A configured Hermes home may itself contain '#'. The source-path delimiter is the final
    // '#session:' (raw ids are URI-encoded), not the first hash character in the filesystem path.
    const separator = `#${SESSION_PATH_PREFIX}`;
    const separatorAt = sessionPath.lastIndexOf(separator);
    if (separatorAt < 0) return null;
    const dbPath = sessionPath.slice(0, separatorAt);
    // The row we return must belong to the session that asked for it: tool call ids are only
    // unique within a session (retries reuse them), so every lookup is session-scoped.
    const rawSessionId = decodeURIComponent(sessionPath.slice(separatorAt + separator.length));
    // `summary` resolves like a message: a compaction summary is its own row, so the exact row
    // is the evidence for it too.
    const match = /:(message|thinking|tool|summary):([^:]+)$/.exec(input.messageUuid);
    if (match === null) return null;
    const projection = match[1]!;
    const rawId = decodeURIComponent(match[2]!);

    let db: SqliteDb | null = null;
    try {
      db = openStore(dbPath);
      let row: SqliteRow | undefined;
      if (projection === 'tool') {
        row = db
          .prepare(
            // Projection ignores malformed tool_calls and non-object entries. Raw lookup must
            // use the same rule, or one bad earlier row hides a later valid tool call.
            `SELECT m.* FROM messages m,
               json_each(CASE WHEN json_valid(m.tool_calls) THEN
                 CASE WHEN json_type(m.tool_calls) = 'array' THEN m.tool_calls ELSE '[]' END
               ELSE '[]' END) AS call
           WHERE m.session_id = ?
             AND CASE WHEN call.type = 'object' THEN
               (json_extract(call.value, '$.call_id') = ? OR json_extract(call.value, '$.id') = ?)
             ELSE 0 END
           LIMIT 1`,
          )
          .get(rawSessionId, rawId, rawId);
      } else {
        row = db
          .prepare('SELECT * FROM messages WHERE session_id = ? AND id = ? LIMIT 1')
          .get(rawSessionId, numericId(rawId));
      }
      if (!row) return null;
      const text = JSON.stringify(row, null, 2);
      const messageText = projection === 'thinking'
        ? stringValue(row['reasoning_content']) ?? stringValue(row['reasoning'])
        : projection === 'message'
          ? stringValue(row['content'])
            ?? (stringValue(row['role']) === 'assistant' ? codexMessageText(row) : null)
          : null;
      return { text, totalLength: text.length, messageText };
    } finally {
      try {
        db?.close();
      } catch {
        /* a failed close must not mask the read result */
      }
    }
  } catch {
    return null;
  }
}

export function createHermesProvider({
  rootDir,
  homeDir = homedir(),
  openStore,
}: {
  rootDir?: string;
  homeDir?: string;
  openStore?: HermesStoreOpener;
} = {}): ProviderAdapter {
  const automaticRoot = defaultHermesHome(homeDir);
  const sourceRoots =
    rootDir === undefined || rootDir.trim().length === 0 ? [automaticRoot] : [expandRoot(rootDir, homeDir)];
  const descriptorRoot = sourceRoots[0]!;

  return {
    name,
    descriptor: {
      id: name,
      name: 'Hermes Agent',
      vendor: 'Nous Research',
      defaultRoot: descriptorRoot,
      color: '#FFD700',
    },
    indexVersionMarker: HERMES_CANONICAL_TRANSCRIPT_MARKER,
    sessionUnitKey: session => `hermes-unit:${session.sessionId}`,
    watchTargets(configuredRoot: string) {
      const home = configuredRoot.trim().length > 0 ? configuredRoot : descriptorRoot;
      const profilesDir = join(home, PROFILES_DIR);
      const targets: WatchTarget[] = [
        { kind: 'file', path: join(home, STORE_FILE) },
        { kind: 'file', path: join(home, WAL_FILE) },
        // The caller forwards these store files from the profiles tree and promotes active ones
        // to its bounded poller. This also covers profiles created after the watcher starts,
        // without synchronously enumerating the directory on Electron's main thread.
        { kind: 'tree', path: profilesDir, fileNames: [STORE_FILE, WAL_FILE] },
      ];
      // `state.db-shm` is deliberately absent: SQLite rewrites it on every read, so declaring it
      // would only produce events that carry no new rows.
      return targets;
    },
    discover(ctx: DiscoverContext): IndexUnit[] {
      const indexed = ctx.indexedSessions?.() ?? [];
      const units: IndexUnit[] = [];
      const liveSessionIds = new Set<string>();
      let inventoryComplete = true;
      const reportIssue = (path: string, error: unknown): void => {
        inventoryComplete = false;
        ctx.reportIncompleteInventory?.({
          path,
          error: error instanceof Error ? error.message : String(error),
        });
      };
      const indexedInside = (root: string): boolean => indexed.some(session => pathInside(root, session.jsonlPath));

      for (const home of sourceRoots) {
        if (!existsSync(home)) {
          if (indexedInside(home)) reportIssue(home, 'Previously indexed Hermes home is unavailable');
          continue;
        }

        const listing = storePaths(home);
        for (const issue of listing.errors) reportIssue(issue.path, issue.error);
        for (const { dbPath, profile } of listing.stores) {
          const dbIndexed = indexed.filter(session => session.jsonlPath.startsWith(`${dbPath}#`));
          // A missing store may have been quarantined or temporarily unmounted. Without a
          // readable inventory, no scan can prove its sessions were deleted, so keep the last
          // indexed snapshot and reconcile it when the store is available again.
          const fileState = storeFileState(dbPath);
          if (fileState !== 'present') {
            if (dbIndexed.length > 0) {
              reportIssue(dbPath, 'Previously indexed Hermes store is unavailable');
            }
            continue;
          }
          if (openStore === undefined) {
            reportIssue(dbPath, 'No read-only Hermes store opener is configured');
            continue;
          }

          // The gate is one row per store. It answers "may I skip this store entirely?" in a
          // single cursor read, which is what keeps an idle store from being opened at all.
          const gate = storeGate(dbPath);
          const gateKey = storeGateKey(dbPath);
          const stored = parseStoreCursor(ctx.lastCursor(gateKey));
          const indexedIds = new Set(dbIndexed.map(session => session.sessionId));
          const indexedSessions = sessionsDigest(indexedIds);
          const changedPaths = ctx.changedPaths ?? [];
          const storeDir = dirname(dbPath);
          // A hint naming anything under the store's directory — the database, its WAL, the
          // directory itself — only forces the store to be read; which sessions that read
          // schedules still follows the per-session cursors. The hint matters even though a write
          // normally moves the gate too: it is the daemon telling us the store is worth a look.
          const hinted = changedPaths.some(path => pathInside(storeDir, path));
          // A session source hint forces that session; sibling reconciliation still
          // follows the strict or bounded audit policy below.
          const forcedSessions = new Set<string>();
          for (const path of changedPaths) {
            const rawSessionId = rawSessionIdFromSourcePath(dbPath, path);
            if (rawSessionId !== null) forcedSessions.add(rawSessionId);
          }

          if (
            !hinted
            && forcedSessions.size === 0
            && stored !== null
            && stored.complete
            && stored.gate === gate
            && stored.sessions === indexedSessions
          ) {
            // Certified at this gate, and the index holds exactly the sessions that were
            // enumerated then: skip the store without opening it. A write of any kind moves the
            // gate, a session the index lost or gained moves the set, and a partial gate means
            // the examination scheduled work, so a pending retry cannot hide behind this branch.
            for (const session of dbIndexed) liveSessionIds.add(session.sessionId);
            continue;
          }

          // The store-level hint is what every row of this store resolves its own profile
          // against; parse() needs it to name a subagent's parent the way discovery does.
          const profileHint = profile === 'default' ? null : profile;
          const read = readStoreSessions(dbPath, profileHint, openStore);
          if ('error' in read) {
            reportIssue(dbPath, read.error);
            continue;
          }

          const storeSessions: StoreSessionEntry[] = read.sessions.map(session => {
            const rawSessionId = String(session.row['id']);
            const sessionId = hermesSessionId(rawSessionId, session.profile, session.dbPath);
            return {
              session,
              rawSessionId,
              sessionId,
              cursor: parseHermesCursor(ctx.lastCursor(`hermes-unit:${sessionId}`)),
            };
          });
          const ordered = [...storeSessions].sort((a, b) => a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0);
          const lastId = ordered.at(-1)?.sessionId ?? null;
          const now = Date.now();
          let audit: HermesAudit = stored?.audit ?? {
            token: randomUUID(), after: null, startedAt: now, startGate: gate,
          };
          const allAcknowledged = ordered.every(entry => indexedIds.has(entry.sessionId)
            && entry.cursor?.auditToken === audit.token
            && entry.cursor.fingerprint === entry.session.fingerprint);
          const coveredAtGate = stored !== null && stored.gate === gate
            && stored.sessions === sessionsDigest(ordered.map(entry => entry.sessionId))
            && audit.after === lastId && audit.startGate === gate;
          const expired = stored !== null && !stored.complete && !(coveredAtGate && allAcknowledged)
            && (now < audit.startedAt || now - audit.startedAt >= AUDIT_MAX_AGE_MS);
          const strict = ctx.readMode === 'strict' || ctx.snapshotRequired === true;
          const fullAudit = stored === null || expired || (strict && (!coveredAtGate || hinted));
          // A completed cycle starts another one only after its session commits
          // acknowledged it. New writes during a cycle never reset its position
          // or deadline, so a busy sibling cannot starve an older hidden edit.
          if (fullAudit || (audit.after === lastId && allAcknowledged && !coveredAtGate)
            || stored?.complete === true) {
            audit = { token: randomUUID(), after: null, startedAt: now, startGate: gate };
          }
          const scheduled: { entry: StoreSessionEntry; cursor: Cursor }[] = [];
          const cursorUpdates: { entry: StoreSessionEntry; digest: string }[] = [];
          const changed = new Set<string>();
          for (const entry of ordered) {
            liveSessionIds.add(entry.sessionId);
            if (!indexedIds.has(entry.sessionId) || entry.cursor === null
              || entry.cursor.fingerprint !== entry.session.fingerprint
              || forcedSessions.has(entry.rawSessionId)) {
              changed.add(entry.sessionId);
              scheduled.push({ entry, cursor: sessionCursor(dbPath, gate, entry.session.fingerprint,
                entry.cursor?.digest ?? null, audit.token) });
            }
          }
          const next = fullAudit ? ordered : ordered.filter(entry => audit.after === null || entry.sessionId > audit.after)
            .slice(0, AUDIT_BATCH_SESSIONS);
          const selected = new Set(next.map(entry => entry.sessionId));
          const candidates = ordered.filter(entry => !changed.has(entry.sessionId)
            && (selected.has(entry.sessionId)
              // A failed canonical or cursor-only commit retains its old token.
              // Retry it even after rotation has moved past its position.
              || (audit.after !== null && entry.sessionId <= audit.after && entry.cursor?.auditToken !== audit.token)));
          let digestUnavailable = false;
          if (candidates.length > 0) {
            let digestDb: SqliteDb | null = null;
            try {
              digestDb = openStore(dbPath);
              digestDb.exec('BEGIN');
              const observations = candidates.map(entry => ({ entry, digest: exactSessionDigest(digestDb!, entry.rawSessionId) }));
              digestDb.exec('COMMIT');
              if (storeGate(dbPath) !== gate) throw new Error('Hermes store changed during reconciliation');
              for (const { entry, digest } of observations) {
                if (entry.cursor?.digest === digest) cursorUpdates.push({ entry, digest });
                else scheduled.push({ entry, cursor: sessionCursor(dbPath, gate, entry.session.fingerprint, digest, audit.token) });
              }
            } catch (error) {
              reportIssue(dbPath, error);
              digestUnavailable = true;
            } finally {
              try { digestDb?.close(); } catch { /* preserve the read error */ }
            }
          }
          for (const { entry, cursor } of scheduled) {
            const { session, rawSessionId, sessionId } = entry;
            const cwdRaw = stringValue(session.row['cwd']);
            const cwd = cwdRaw === null ? null : normalizeObservedCwd(cwdRaw);
            const project = projectSlugFromPath(cwd);
            units.push({
              key: `hermes-unit:${sessionId}`, sessionId,
              ...(project === null ? {} : { project }),
              meta: {
                dbPath, profile: session.profile, profileHint, rawSessionId, sessionId, cwd,
                fingerprint: session.fingerprint, schemaVersion: read.schemaVersion,
                currentCursor: cursor, auditToken: audit.token,
              } satisfies HermesUnitMeta,
              retractSessionIds: [sessionId],
            });
          }
          const observationUnit = (key: string, cursor: Cursor): IndexUnit => ({
            key, sessionId: '',
            meta: {
              dbPath, profile: '', profileHint: null, rawSessionId: '', sessionId: '', cwd: null,
              fingerprint: '', schemaVersion: read.schemaVersion, currentCursor: cursor, storeGate: true,
            } satisfies HermesUnitMeta,
          });
          if (!digestUnavailable) {
            const prerequisites: { key: string; cursor: string }[] = [];
            for (const { entry } of cursorUpdates) {
              const key = `hermes-unit:${entry.sessionId}`;
              // Verification advances its token, not the unchanged source's
              // position, fingerprint or digest.
              const cursor = [...ctx.lastCursor(key)!.split(':').slice(0, 6), audit.token].join(':');
              units.push(observationUnit(key, cursor));
              prerequisites.push({ key, cursor });
            }
            const after = fullAudit ? lastId : next.at(-1)?.sessionId ?? audit.after;
            const observed = new Set(cursorUpdates.map(({ entry }) => entry.sessionId));
            const complete = after === lastId && audit.startGate === gate && scheduled.length === 0
              && ordered.every(entry => indexedIds.has(entry.sessionId)
                && (entry.cursor?.auditToken === audit.token || observed.has(entry.sessionId)));
            const gateUnit = observationUnit(gateKey, storeCursor(dbPath, gate,
              sessionsDigest(ordered.map(entry => entry.sessionId)), { ...audit, after }, complete));
            // Existing cursor prerequisites make the certificate conditional
            // on every staged acknowledgement actually committing.
            if (complete) gateUnit.requiresCursors = prerequisites;
            units.push(gateUnit);
          }
        }
      }

      if (inventoryComplete) {
        for (const session of indexed) {
          if (liveSessionIds.has(session.sessionId)) continue;
          units.push({
            key: `hermes-unit:${session.sessionId}`,
            sessionId: session.sessionId,
            meta: {
              dbPath: '',
              profile: '',
              profileHint: null,
              rawSessionId: '',
              sessionId: session.sessionId,
              cwd: null,
              fingerprint: '',
              schemaVersion: 0,
              currentCursor: TOMBSTONE_CURSOR,
              tombstone: true,
            } satisfies HermesUnitMeta,
            retractSessionIds: [session.sessionId],
          });
        }
      }
      return units;
    },
    parse: hermesParse({ openStore }),
    raw: (input: RawLookup): RawRecord | null => rawHermes(input, openStore),
  };
}

export const hermesProvider = createHermesProvider();
