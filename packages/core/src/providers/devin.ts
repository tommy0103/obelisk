// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Devin CLI provider (Devin Desktop shares the store).
//
// Source: `<data>/devin/cli/sessions.db`, SQLite in WAL mode, where <data> is
// `$XDG_DATA_HOME` or `~/.local/share` on macOS and Linux and `%APPDATA%` on
// Windows (docs.devin.ai: credentials.toml and cli/logs live under the same
// data directory). Opened read-only, one read transaction per operation.
//
// A session is a `sessions` row plus a forest of `message_nodes`. The live
// conversation is the chain walked from `sessions.main_chain_id` through
// `parent_node_id`; `subagent_heads` names each subagent's chain head in the
// same forest. Devin rebuilds chains when the system prefix changes, so the
// forest repeats messages under one `message_id`: each message is emitted once,
// claimed first by the main chain, then by subagent chains. Messages no live
// chain reaches (rewound turns, pre-compaction history) stay as `inactive`
// evidence. A subagent's spawning call is linked only when the run_subagent
// result names the agent (`subagent/agent_id`). `hidden = 1` sessions were removed from view by the user and are
// not indexed.
//
// Each unit replaces one whole session. The cursor fingerprints the session
// row, its subagent heads and per-session node aggregates (count, max row id,
// byte sizes, max created_at), plus a digest of the session's node bytes.
// octet_length reads record headers, not payloads, so an unhinted census
// compares aggregates only and stays cheap on a large store. When a watcher
// hint names the store and no aggregate moved, the write is unexplained: every
// session's node bytes are digested and only a mismatch is replayed. A rewrite
// that keeps every aggregate and lands in the same scan as an aggregate-visible
// change waits for the next unexplained hint or a rebuild.

import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, sep, win32 } from 'node:path';

import { normalizeObservedCwd, normalizeTranscriptTimestamp, projectSlugFromPath, trunc, truncJson } from '../parsing.ts';
import type { SqliteDb, SqliteRow } from '../sqlite-types.ts';
import type {
  Cursor, DiscoverContext, IndexUnit, MessageRecord, MessageVisibility, ProviderAdapter,
  RawLookup, RawRecord, TranscriptRecord, WatchTarget,
} from './types.ts';

const name = 'devin';
const DEVIN_CANONICAL_TRANSCRIPT_MARKER = '__devin_canonical_transcript_v1__';
const CURSOR_TAG = 'devin-v1';
const TOMBSTONE_CURSOR = `0:0:${CURSOR_TAG}:tombstone`;
const STORE_FILE = 'sessions.db';
const UNIT_SEPARATOR = '#devin:';
const BUSY_TIMEOUT_MS = 500;
const SUMMARY_EXTENSION = 'devin-rs/summary';
// run_subagent's result names the agent it started; that is the only explicit spawn link.
const SPAWN_TOOL = 'run_subagent';
const SPAWN_AGENT_EXTENSION = 'subagent/agent_id';
const SPAWN_PROFILE_EXTENSION = 'subagent/profile_name';
const RESULT_META_EXTENSION = 'chisel/tool_result_meta';
const FILE_TOOLS = new Set(['read', 'edit', 'write']);

// Columns the projection reads. A store without them cannot be projected, at
// any schema version; newer versions that keep them are read as usual.
const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  sessions: ['id', 'working_directory', 'model', 'created_at', 'last_activity_at', 'title', 'main_chain_id', 'hidden'],
  message_nodes: ['row_id', 'session_id', 'node_id', 'parent_node_id', 'chat_message', 'created_at', 'metadata'],
};

export type DevinDatabaseOpener = (path: string) => SqliteDb;
type Json = Record<string, any>;

const require = createRequire(import.meta.url);

function defaultOpenDatabase(path: string): SqliteDb {
  // Keep the Node-only binding out of the Electron bundle (see zcode.ts).
  const specifier = ['node', 'sqlite'].join(':');
  const { DatabaseSync } = require(specifier) as {
    DatabaseSync: new (path: string, options: { readOnly: boolean; timeout: number }) => SqliteDb;
  };
  return new DatabaseSync(path, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
}

export function defaultDevinRoot({
  homeDir = homedir(), platform = process.platform, env = process.env,
}: { homeDir?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}): string {
  if (platform === 'win32') return win32.join(env.APPDATA || win32.join(homeDir, 'AppData', 'Roaming'), 'devin', 'cli');
  const xdg = env.XDG_DATA_HOME?.trim();
  return join(xdg ? xdg : join(homeDir, '.local', 'share'), 'devin', 'cli');
}

export function devinSessionId(dbPath: string, rawSessionId: string): string {
  const dbi = createHash('sha256').update(dbPath).digest('hex').slice(0, 12);
  return `devin:${dbi}:${rawSessionId}`;
}

function unitKey(dbPath: string, rawSessionId: string): string {
  return `${dbPath}${UNIT_SEPARATOR}${rawSessionId}`;
}

function splitUnitKey(key: string): { dbPath: string; rawSessionId: string } | null {
  const at = key.lastIndexOf(UNIT_SEPARATOR);
  if (at <= 0) return null;
  return { dbPath: key.slice(0, at), rawSessionId: key.slice(at + UNIT_SEPARATOR.length) };
}

function parseJson(text: unknown): Json | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
  } catch {
    return null;
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function isoFromSeconds(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? new Date(value * 1000).toISOString() : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---- store reads ----------------------------------------------------------

interface SessionRow {
  id: string;
  working_directory: string | null;
  model: string | null;
  created_at: number | null;
  last_activity_at: number | null;
  title: string | null;
  main_chain_id: number | null;
  hidden: number | null;
}

interface NodeAggregate {
  n: number;
  max_row: number | null;
  bytes: number | null;
  meta_bytes: number | null;
  last: number | null;
}

interface HeadRow {
  agent_id: string;
  chain_node_id: number;
  updated_at: number | null;
}

interface NodeRow {
  node_id: number;
  parent_node_id: number | null;
  chat_message: string;
  created_at: number | null;
  metadata: string | null;
}

const SESSION_COLUMNS = 'id, working_directory, model, created_at, last_activity_at, title, main_chain_id, hidden';
const AGGREGATE_COLUMNS = 'COUNT(*) AS n, MAX(row_id) AS max_row, SUM(octet_length(chat_message)) AS bytes, '
  + 'SUM(octet_length(metadata)) AS meta_bytes, MAX(created_at) AS last';

function shapeError(db: SqliteDb): string | null {
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const present = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name)));
    if (present.size === 0) return `Devin store has no ${table} table`;
    const missing = columns.filter(column => !present.has(column));
    if (missing.length > 0) return `Devin store ${table} lacks ${missing.join(', ')}`;
  }
  return null;
}

function hasSubagentHeads(db: SqliteDb): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'subagent_heads'").get() !== undefined;
}

function readHeads(db: SqliteDb, rawSessionId: string | null): Map<string, HeadRow[]> {
  const bySession = new Map<string, HeadRow[]>();
  if (!hasSubagentHeads(db)) return bySession;
  const rows = rawSessionId === null
    ? db.prepare('SELECT session_id, agent_id, chain_node_id, updated_at FROM subagent_heads ORDER BY session_id, agent_id').all()
    : db.prepare('SELECT session_id, agent_id, chain_node_id, updated_at FROM subagent_heads WHERE session_id = ? ORDER BY agent_id').all(rawSessionId);
  for (const row of rows) {
    const list = bySession.get(String(row.session_id)) ?? [];
    list.push({ agent_id: String(row.agent_id), chain_node_id: Number(row.chain_node_id), updated_at: row.updated_at ?? null });
    bySession.set(String(row.session_id), list);
  }
  return bySession;
}

// Discovery and parse must hash byte-identical inputs, or every census
// would schedule a replay.
function fingerprint(session: SessionRow, aggregate: NodeAggregate | undefined, heads: readonly HeadRow[]): string {
  return createHash('sha256').update(JSON.stringify([
    session.id, session.working_directory, session.model, session.created_at, session.last_activity_at,
    session.title, session.main_chain_id,
    aggregate === undefined ? null : [aggregate.n, aggregate.max_row, aggregate.bytes, aggregate.meta_bytes, aggregate.last],
    heads.map(head => [head.agent_id, head.chain_node_id, head.updated_at]),
  ])).digest('hex').slice(0, 24);
}

// The exact bytes of every node row parse reads, framed so no two row sets
// hash alike. Blobs skip text decoding, which is most of the cost.
function contentDigest(db: SqliteDb, rawSessionId: string): string {
  const statement = db.prepare('SELECT node_id, parent_node_id, created_at, CAST(chat_message AS BLOB) AS chat, '
    + 'CAST(metadata AS BLOB) AS meta FROM message_nodes WHERE session_id = ? ORDER BY node_id');
  const hash = createHash('sha256');
  for (const row of statement.iterate?.(rawSessionId) ?? statement.all(rawSessionId)) {
    const chat = row.chat as Uint8Array;
    const meta = row.meta as Uint8Array | null;
    hash.update(JSON.stringify([row.node_id, row.parent_node_id, row.created_at, chat.length, meta?.length ?? null]));
    hash.update(chat);
    if (meta !== null) hash.update(meta);
  }
  return hash.digest('hex').slice(0, 24);
}

function encodeCursor(session: SessionRow, aggregate: NodeAggregate | undefined, print: string, digest: string): string {
  // Leading numeric fields follow persist's index_state mtime/lines_processed convention.
  return `${(session.last_activity_at ?? 0) * 1000}:${aggregate?.n ?? 0}:${CURSOR_TAG}:${print}:${digest}`;
}

function decodeCursor(cursor: Cursor): { print: string; digest: string } | null {
  const parts = cursor?.split(':');
  return parts?.length === 5 && parts[2] === CURSOR_TAG ? { print: parts[3]!, digest: parts[4]! } : null;
}

function openStore(dbPath: string, opener: DevinDatabaseOpener): SqliteDb | null {
  try {
    return opener(dbPath);
  } catch {
    return null;
  }
}

// ---- discovery ------------------------------------------------------------

interface DevinUnitMeta {
  dbPath: string;
  rawSessionId: string;
  tombstone?: boolean;
}

function storeState(dbPath: string): 'present' | 'missing' | 'inaccessible' {
  try {
    statSync(dbPath);
    return 'present';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'inaccessible';
  }
}

function discoverAt(dbPath: string, ctx: DiscoverContext, opener: DevinDatabaseOpener): IndexUnit[] {
  const hinted = ctx.changedPaths !== undefined;
  if (hinted) {
    const store = normalize(dbPath);
    const touched = ctx.changedPaths!.some((changed) => {
      const path = isAbsolute(changed) ? normalize(changed) : store;
      return path === store || path === `${store}-wal` || store.startsWith(path + sep);
    });
    if (!touched) return [];
  }
  const indexed = (ctx.indexedSessions?.() ?? []).filter(session => session.jsonlPath.startsWith(`${dbPath}${UNIT_SEPARATOR}`));
  const state = storeState(dbPath);
  if (state !== 'present') {
    // Absence or denied access is not proof of deletion: never tombstone from it.
    if (state === 'inaccessible' || indexed.length > 0) {
      ctx.reportIncompleteInventory?.({ path: dbPath, error: state === 'missing' ? 'Devin store is unavailable' : 'Devin store is not accessible' });
    }
    return [];
  }
  const db = openStore(dbPath, opener);
  if (db === null) {
    ctx.reportIncompleteInventory?.({ path: dbPath, error: 'Devin store is busy or unreadable' });
    return [];
  }
  try {
    const shape = shapeError(db);
    if (shape !== null) {
      ctx.reportIncompleteInventory?.({ path: dbPath, error: shape });
      return [];
    }
    db.exec('BEGIN');
    let sessions: SessionRow[];
    let aggregates: Map<string, NodeAggregate>;
    let heads: Map<string, HeadRow[]>;
    try {
      sessions = db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE hidden = 0 ORDER BY id`).all() as SessionRow[];
      aggregates = new Map(db.prepare(`SELECT session_id, ${AGGREGATE_COLUMNS} FROM message_nodes GROUP BY session_id`).all()
        .map(row => [String(row.session_id), row as NodeAggregate]));
      heads = readHeads(db, null);
    } finally {
      db.exec('COMMIT');
    }

    const units: IndexUnit[] = [];
    const unit = (session: SessionRow, sessionId: string, key: string): IndexUnit => ({
      key,
      sessionId,
      project: projectSlugFromPath(normalizeObservedCwd(session.working_directory)) ?? undefined,
      retractSessionIds: [sessionId],
      meta: { dbPath, rawSessionId: session.id } satisfies DevinUnitMeta,
    });
    const live = new Set<string>();
    const unchanged: { session: SessionRow; sessionId: string; key: string; digest: string }[] = [];
    for (const session of sessions) {
      const sessionId = devinSessionId(dbPath, session.id);
      const key = unitKey(dbPath, session.id);
      live.add(sessionId);
      const prior = decodeCursor(ctx.lastCursor(key));
      if (prior?.print === fingerprint(session, aggregates.get(session.id), heads.get(session.id) ?? [])) {
        unchanged.push({ session, sessionId, key, digest: prior.digest });
      } else {
        units.push(unit(session, sessionId, key));
      }
    }
    for (const session of indexed) {
      if (live.has(session.sessionId)) continue;
      units.push({
        key: session.jsonlPath,
        sessionId: session.sessionId,
        retractSessionIds: [session.sessionId],
        meta: { dbPath, rawSessionId: '', tombstone: true } satisfies DevinUnitMeta,
      });
    }
    if (hinted && units.length === 0) {
      // The watcher saw a write no aggregate explains: compare exact bytes.
      db.exec('BEGIN');
      try {
        for (const { session, sessionId, key, digest } of unchanged) {
          if (contentDigest(db, session.id) !== digest) units.push(unit(session, sessionId, key));
        }
      } finally {
        db.exec('COMMIT');
      }
    }
    return units;
  } catch (error) {
    ctx.reportIncompleteInventory?.({ path: dbPath, error: errorText(error) });
    return [];
  } finally {
    db.close();
  }
}

// ---- projection -----------------------------------------------------------

interface SessionSnapshot {
  session: SessionRow;
  nodes: NodeRow[];
  heads: HeadRow[];
  cursor: string;
}

function readSession(db: SqliteDb, rawSessionId: string): SessionSnapshot | null {
  db.exec('BEGIN');
  try {
    const session = db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`).get(rawSessionId) as SessionRow | undefined;
    if (session === undefined || session.hidden !== 0) return null;
    const aggregate = db.prepare(`SELECT ${AGGREGATE_COLUMNS} FROM message_nodes WHERE session_id = ?`).get(rawSessionId) as NodeAggregate;
    const nodes = db.prepare(
      'SELECT node_id, parent_node_id, chat_message, created_at, metadata FROM message_nodes WHERE session_id = ? ORDER BY node_id',
    ).all(rawSessionId) as NodeRow[];
    const heads = readHeads(db, rawSessionId).get(rawSessionId) ?? [];
    const present = aggregate.n > 0 ? aggregate : undefined;
    const cursor = encodeCursor(session, present, fingerprint(session, present, heads), contentDigest(db, rawSessionId));
    return { session, nodes, heads, cursor };
  } finally {
    db.exec('COMMIT');
  }
}

interface ProjectedNode {
  node: NodeRow;
  message: Json;
  uuid: string;
  visibility: MessageVisibility;
  agentId: string | null;
}

/** Walk a chain from its head to its root, root first. Cycles and dangling parents end the walk. */
function chain(nodes: ReadonlyMap<number, NodeRow>, head: number | null): NodeRow[] {
  const out: NodeRow[] = [];
  const seen = new Set<number>();
  for (let id = head; id !== null && !seen.has(id);) {
    const node = nodes.get(id);
    if (node === undefined) break;
    seen.add(id);
    out.push(node);
    id = node.parent_node_id;
  }
  return out.reverse();
}

export function devinAgentId(sessionId: string, rawAgentId: string): string {
  return `${sessionId}:agent:${rawAgentId}`;
}

/**
 * Assign every distinct message_id to one node: the main chain first, then each
 * subagent chain, then nodes no live chain reaches (inactive evidence).
 */
function projectNodes(snapshot: SessionSnapshot, sessionId: string): ProjectedNode[] {
  const byId = new Map(snapshot.nodes.map(node => [node.node_id, node]));
  const claimed = new Set<string>();
  const out: ProjectedNode[] = [];
  const claim = (node: NodeRow, visibility: MessageVisibility, agentId: string | null) => {
    const message = parseJson(node.chat_message);
    const messageId = str(message?.message_id);
    if (message === null || messageId === null || claimed.has(messageId)) return;
    claimed.add(messageId);
    out.push({ node, message, uuid: `${sessionId}:${messageId}`, visibility, agentId });
  };
  for (const node of chain(byId, snapshot.session.main_chain_id)) claim(node, 'visible', null);
  for (const head of snapshot.heads) {
    const agentId = devinAgentId(sessionId, head.agent_id);
    for (const node of chain(byId, head.chain_node_id)) claim(node, 'visible', agentId);
  }
  for (const node of snapshot.nodes) claim(node, 'inactive', null);
  return out;
}

function totalInputTokens(metrics: Json): number | null {
  // Devin reports cache reads and writes beside input_tokens, not inside it.
  const parts = [metrics.input_tokens, metrics.cache_read_tokens, metrics.cache_creation_tokens].map(count);
  return parts.every(part => part === null) ? null : parts.reduce<number>((sum, part) => sum + (part ?? 0), 0);
}

function toolFilePath(toolName: string, input: unknown): string | null {
  return FILE_TOOLS.has(toolName) && input !== null && typeof input === 'object' ? str((input as Json).file_path) : null;
}

function* projectSession(snapshot: SessionSnapshot, sessionId: string, unitKeyValue: string): Generator<TranscriptRecord> {
  const { session } = snapshot;
  const cwd = normalizeObservedCwd(session.working_directory);
  const projected = projectNodes(snapshot, sessionId);
  const uuidByNode = new Map<number, string>();
  const parseCache = new Map<number, string | null>();
  for (const entry of projected) uuidByNode.set(entry.node.node_id, entry.uuid);
  const byId = new Map(snapshot.nodes.map(node => [node.node_id, node]));
  // A duplicate copy's id resolves to the copy that was emitted for its message.
  const uuidOf = (nodeId: number | null): string | null => {
    if (nodeId === null) return null;
    if (uuidByNode.has(nodeId)) return uuidByNode.get(nodeId)!;
    if (!parseCache.has(nodeId)) {
      const messageId = str(parseJson(byId.get(nodeId)?.chat_message)?.message_id);
      parseCache.set(nodeId, messageId === null ? null : `${sessionId}:${messageId}`);
    }
    return parseCache.get(nodeId)!;
  };
  const callMessage = new Map<string, string>();
  const callInputs = new Map<string, { name: string; input: unknown }>();
  const spawns = new Map<string, { toolUseId: string; description: string | null }>();
  // Spawn results and background-completion notices both tag the agent id and profile.
  const profiles = new Map<string, string>();
  const results = new Set<string>();
  let visibleCount = 0;
  let endedAt = isoFromSeconds(session.last_activity_at);

  for (const { node, message, uuid, visibility, agentId } of projected) {
    const metadata = message.metadata !== null && typeof message.metadata === 'object' ? message.metadata as Json : {};
    const extensions = metadata.extensions !== null && typeof metadata.extensions === 'object' ? metadata.extensions as Json : {};
    const timestamp = normalizeTranscriptTimestamp(metadata.created_at) ?? isoFromSeconds(node.created_at);
    if (visibility === 'visible' && timestamp !== null && (endedAt === null || timestamp > endedAt)) endedAt = timestamp;
    const role = str(message.role);
    const text = str(message.content);
    const taggedAgent = str(extensions[SPAWN_AGENT_EXTENSION]);
    const taggedProfile = str(extensions[SPAWN_PROFILE_EXTENSION]);
    if (taggedAgent !== null && taggedProfile !== null && !profiles.has(taggedAgent)) profiles.set(taggedAgent, taggedProfile);

    if (role === 'tool') {
      const callId = str(message.tool_call_id);
      if (callId === null) continue;
      const toolUseId = `${sessionId}:${callId}`;
      if (results.has(toolUseId)) continue;
      results.add(toolUseId);
      const resultMeta = extensions[RESULT_META_EXTENSION];
      const call = callInputs.get(toolUseId);
      if (taggedAgent !== null && call?.name === SPAWN_TOOL && !spawns.has(taggedAgent)) {
        spawns.set(taggedAgent, {
          toolUseId,
          description: call.input !== null && typeof call.input === 'object' ? str((call.input as Json).title) : null,
        });
      }
      yield {
        kind: 'tool_result',
        tool_use_id: toolUseId,
        // An unmatched result keeps an empty anchor rather than vanishing (as codex does).
        message_uuid: callMessage.get(toolUseId) ?? '',
        session_id: sessionId,
        content: trunc(text ?? ''),
        file_path: null,
        is_error: resultMeta !== null && typeof resultMeta === 'object' && resultMeta.success === false ? 1 : 0,
      };
      continue;
    }

    if (role === 'system' && extensions[SUMMARY_EXTENSION] !== undefined) {
      yield {
        kind: 'summary', id: uuid, session_id: sessionId, timestamp, source: name,
        content: trunc(text ?? ''), visibility,
      };
      continue;
    }

    // Devin's own search indexes assistant text and real user input only; system
    // context and injected user turns are transport, not conversation.
    const userInput = role === 'user' && metadata.is_user_input === true;
    const effective: MessageVisibility = role === 'assistant' || userInput ? visibility : 'hidden';
    const calls = role === 'assistant' && Array.isArray(message.tool_calls) ? message.tool_calls as unknown[] : [];
    const metrics = role === 'assistant' && metadata.metrics !== null && typeof metadata.metrics === 'object' ? metadata.metrics as Json : null;
    const model = role === 'assistant' ? str(metadata.generation_model) ?? session.model : null;
    const base = {
      kind: 'message' as const,
      session_id: sessionId,
      timestamp,
      is_meta: 0 as const,
      model,
      is_sidechain: agentId === null ? 0 as const : 1 as const,
      agent_id: agentId,
      cwd,
      skill: null,
      source: name,
    };
    const thinking = role === 'assistant' && message.thinking !== null && typeof message.thinking === 'object'
      ? str((message.thinking as Json).thinking) : null;
    if (thinking !== null) {
      if (effective === 'visible') visibleCount++;
      yield {
        ...base, uuid: `${uuid}:thinking`, type: 'assistant', parent_uuid: uuid, role: 'assistant',
        text: trunc(thinking), content_type: 'thinking', visibility: effective, input_tokens: null, output_tokens: null,
      } satisfies MessageRecord;
    }
    if (effective === 'visible') visibleCount++;
    yield {
      ...base,
      uuid,
      type: role === 'user' || role === 'assistant' ? role : 'system',
      parent_uuid: uuidOf(node.parent_node_id),
      role: role ?? 'system',
      text: text === null ? null : trunc(text),
      content_type: text !== null ? 'text' : calls.length > 0 ? 'tool_use' : 'unknown',
      visibility: effective,
      input_tokens: metrics === null ? null : totalInputTokens(metrics),
      output_tokens: metrics === null ? null : count(metrics.output_tokens),
    } satisfies MessageRecord;
    for (const call of calls) {
      if (call === null || typeof call !== 'object') continue;
      const callId = str((call as Json).id);
      const toolName = str((call as Json).name);
      if (callId === null || toolName === null) continue;
      const id = `${sessionId}:${callId}`;
      if (callMessage.has(id)) continue;
      callMessage.set(id, uuid);
      const input = (call as Json).arguments ?? {};
      callInputs.set(id, { name: toolName, input });
      yield {
        kind: 'tool_call', id, message_uuid: uuid, session_id: sessionId, name: toolName, presentation: 'default',
        input_json: truncJson(input) ?? '{}', file_path: toolFilePath(toolName, input),
      };
    }
  }

  for (const head of snapshot.heads) {
    const spawn = spawns.get(head.agent_id);
    yield {
      kind: 'subagent',
      agent_id: devinAgentId(sessionId, head.agent_id),
      session_id: sessionId,
      parent_tool_use_id: spawn?.toolUseId ?? null,
      agent_type: profiles.get(head.agent_id) ?? null,
      description: spawn?.description ?? null,
    };
  }
  yield {
    kind: 'session',
    id: sessionId,
    title: str(session.title),
    project: projectSlugFromPath(cwd),
    started_at: isoFromSeconds(session.created_at),
    ended_at: endedAt,
    git_branch: null,
    version: null,
    message_count: visibleCount,
    countMode: 'total',
    jsonl_path: unitKeyValue,
    source: name,
  };
}

function* parse(unit: IndexUnit, opener: DevinDatabaseOpener): Generator<TranscriptRecord, Cursor> {
  const meta = unit.meta as DevinUnitMeta;
  if (meta.tombstone === true) return TOMBSTONE_CURSOR;
  const db = openStore(meta.dbPath, opener);
  // This unit retracts the session first: a silent empty parse would erase it.
  if (db === null) throw new Error(`devin: store is busy or unreadable: ${meta.dbPath}`);
  try {
    const snapshot = readSession(db, meta.rawSessionId);
    if (snapshot === null) throw new Error(`devin: session vanished before parse: ${meta.rawSessionId}`);
    yield* projectSession(snapshot, unit.sessionId, unit.key);
    return snapshot.cursor;
  } finally {
    db.close();
  }
}

function raw(input: RawLookup, dbPath: string, opener: DevinDatabaseOpener): RawRecord | null {
  if (input.source !== name || typeof input.session?.jsonl_path !== 'string') return null;
  const identity = splitUnitKey(input.session.jsonl_path);
  if (identity === null || identity.dbPath !== dbPath) return null;
  const sessionId = devinSessionId(dbPath, identity.rawSessionId);
  const thinking = input.messageUuid.endsWith(':thinking');
  const uuid = thinking ? input.messageUuid.slice(0, -':thinking'.length) : input.messageUuid;
  if (!uuid.startsWith(`${sessionId}:`)) return null;
  const messageId = uuid.slice(sessionId.length + 1);
  const db = openStore(dbPath, opener);
  if (db === null) return null;
  try {
    const row = db.prepare(
      "SELECT chat_message FROM message_nodes WHERE session_id = ? AND json_extract(chat_message, '$.message_id') = ? ORDER BY node_id LIMIT 1",
    ).get(identity.rawSessionId, messageId) as SqliteRow | undefined;
    const message = parseJson(row?.chat_message);
    if (message === null) return null;
    const text = JSON.stringify(message, null, 1);
    const messageText = thinking
      ? str(message.thinking !== null && typeof message.thinking === 'object' ? (message.thinking as Json).thinking : null)
      : str(message.content);
    return { text, totalLength: text.length, hasMore: false, messageText };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export function createDevinProvider({
  rootDir,
  homeDir = homedir(),
  openDatabase = defaultOpenDatabase,
}: {
  rootDir?: string;
  homeDir?: string;
  openDatabase?: DevinDatabaseOpener;
} = {}): ProviderAdapter {
  const trimmed = rootDir?.trim() ?? '';
  const root = trimmed === ''
    ? defaultDevinRoot({ homeDir })
    : trimmed.startsWith('~/') || trimmed.startsWith('~\\') ? join(homeDir, trimmed.slice(2)) : normalize(trimmed);
  const dbPath = join(root, STORE_FILE);
  return {
    name,
    descriptor: { id: name, name: 'Devin', vendor: 'Cognition', defaultRoot: root, color: '#14b8a6' },
    indexVersionMarker: DEVIN_CANONICAL_TRANSCRIPT_MARKER,
    discover: ctx => discoverAt(dbPath, ctx, openDatabase),
    parse: unit => parse(unit, openDatabase),
    // Unit keys name a session inside the store; the files to poll are the store and its WAL.
    watchHints: key => splitUnitKey(key)?.dbPath === dbPath ? [dbPath, `${dbPath}-wal`] : [],
    watchTargets: (configuredRoot: string): WatchTarget[] => {
      const store = join(configuredRoot.trim() === '' ? root : configuredRoot, STORE_FILE);
      return [{ kind: 'file', path: store }, { kind: 'file', path: `${store}-wal` }];
    },
    raw: input => raw(input, dbPath, openDatabase),
  };
}
