// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Obelisk Core package (see docs/adr/0003-core-typescript-esm-precompiled.md).
//
// The single shared implementation behind every transport. The CLI and later
// the MCP server are thin shells over these four functions;
// none of them re-implement retrieval or own the DB lifecycle.
//
// Authored in TypeScript with erasable-only syntax so Node can run it directly
// via type stripping in development, while the CLI package ships readable,
// non-bundled tsc output. Core source lives in the @obelisk/core workspace.

import { createContext, runInNewContext } from 'node:vm';

import { DB_PATH, openAttuneDb, openReadDb, probeAttuneMemoryLayer } from './db.ts';
import { buildIndex, ensureReadableSchema } from './indexer.ts';
import { coreSchemaNeedsMigration } from './schema-migrations.ts';
import {
  createConfiguredBuiltinProviderRuntime,
  readPersistedProviderSettings,
} from './provider-settings.ts';
import type { ProviderRegistry } from './providers/registry.ts';
import { createQueryApi, createAttuneApi } from './query.ts';
import type { SqliteDb } from './sqlite-types.ts';
import { nodeSqliteTransactionAdapter } from './tx.ts';
import { runRetryableWriteTransaction } from './write-coordinator.ts';

export { buildIndex, DB_PATH };

type SandboxApi = Record<string, unknown>;

interface InvocationOptions {
  // One nonce, or candidates tried in order (first match wins). The CLI passes
  // the as-typed --query path first and the script content second: transcripts
  // record the content verbatim (Write input, heredoc command text) even when
  // the path sits behind a shell variable and never reaches the transcript.
  // A strict candidate (used for script content, which is not unique by
  // construction — boilerplate queries recur across sessions) resolves only
  // when exactly one recent session matches and that session itself holds a
  // recent CLI invocation record; anything else is honest null.
  invocationNonce?: string | readonly (string | { value: string; strict?: boolean })[];
}

interface InventoryIssue {
  provider?: unknown;
  path?: unknown;
  error?: unknown;
}

function reportIncompleteInventory(build: unknown): void {
  if (build === null || typeof build !== 'object' || !('inventoryIssues' in build)) return;
  const issues = (build as { inventoryIssues?: unknown }).inventoryIssues;
  if (!Array.isArray(issues)) return;
  for (const value of issues) {
    const issue = value as InventoryIssue | null;
    if (
      issue !== null
      && typeof issue.provider === 'string'
      && typeof issue.path === 'string'
      && typeof issue.error === 'string'
    ) {
      process.stderr.write(
        `Warning: incomplete ${issue.provider} source inventory at ${issue.path}: ${issue.error}\n`,
      );
    }
  }
}

function refreshQueryIndex(): ProviderRegistry {
  const settings = readPersistedProviderSettings();
  const providerRegistry = createConfiguredBuiltinProviderRuntime(settings.settings).registry;
  if (!settings.ok) {
    const schema = ensureReadableSchema();
    if (!schema.ready) {
      throw new Error(`Obelisk index schema upgrade is blocked by ${schema.reason ?? 'an unknown writer'}`);
    }
    process.stderr.write(`Warning: ${settings.error}; index refresh skipped\n`);
    return providerRegistry;
  }
  reportIncompleteInventory(buildIndex({ providerRegistry }));
  return providerRegistry;
}

function rethrowUnlessSchemaBlocked(error: unknown): never {
  const schema = ensureReadableSchema();
  if (!schema.ready) {
    throw new Error(`Obelisk index schema upgrade is blocked by ${schema.reason ?? 'an unknown writer'}`);
  }
  throw error;
}

// Run a user-supplied CodeAct script inside the query/attune sandbox. The script
// body runs as an async IIFE with a 30s timeout; its `return` value is resolved.
function runInSandbox(api: SandboxApi, scriptContent: string): Promise<unknown> {
  const sandbox = {
    ...api, JSON, Math, Array, Object, Set, Map, Date, RegExp,
    parseInt, parseFloat, String, Number, Boolean, Error, Promise, console, setTimeout,
  };
  const ctx = createContext(sandbox);
  return runInNewContext(`(async()=>{${scriptContent}})()`, ctx, { timeout: 30000 });
}

// Recency bound for the tool_calls leg below: `input_json LIKE '%nonce%'` is
// otherwise a full table scan, but the nonce's tool-call record is by
// definition written at invocation time — always recent. Bounding the scan by
// the joined message timestamp keeps resolution fast on large indexes. A
// nonce older than the window resolves to honest null, which only affects
// stale/replayed nonces, never the live invoking session.
const INVOCATION_RECENCY_MS = 15 * 60 * 1000;

// Epsilon for genuine concurrent collisions: concurrent same-nonce invocations
// land within seconds of each other, while sequential nonce reuses (a replayed
// command line, a reused query-file path) are typically minutes or more apart.
const INVOCATION_COLLISION_MS = 10_000;

interface InvocationResolveOptions {
  nowMs?: number;
  recencyMs?: number;
  collisionMs?: number;
}

// Resolve the session that invoked this query via a unique nonce observed in
// the transcript (the --nonce token for --search; for --query the as-typed
// file path, falling back to the script content, which heredoc/Write tool-call
// records carry verbatim even when the path hides behind a shell variable).
// Every provider writes the tool-call record before the tool
// finishes, so once the nonce reaches the index it identifies the invoking
// session. Both legs are bounded to the last INVOCATION_RECENCY_MS (see
// above), which keeps weeks-old fixed-path reuse out of the candidate set and
// makes cross-leg timestamps comparable. Candidates are tried in order and the
// first one with any match resolves.
//
// The invoking record is always written "now", so matches far apart in time
// are unrelated history, not ambiguity: each session tracks its newest
// matching record and the overall newest wins. Two newest records within
// INVOCATION_COLLISION_MS of each other are a genuine concurrent collision
// and resolve to null (honest unknown), as does zero matches or an
// unparseable timestamp. Newest-wins also fixes a false-poisoning case: a
// session merely QUOTING an obelisk command in message text (not executing
// it) is older than the real execution and loses naturally. This is a
// single-shot lookup against one snapshot; freshness retries live in
// resolveInvokingSessionIdWithWait below.
export function resolveInvokingSessionId(
  db: SqliteDb,
  nonce: string | readonly (string | { value: string; strict?: boolean })[] | null | undefined,
  opts: InvocationResolveOptions = {},
): string | null {
  const raw = Array.isArray(nonce) ? nonce : [nonce];
  for (const entry of raw) {
    const candidate = typeof entry === 'string' ? { value: entry } : entry;
    if (!candidate?.value) continue;
    const hit = resolveSingleInvocationNonce(db, candidate.value, opts, candidate.strict === true);
    if (hit) return hit;
  }
  return null;
}

function resolveSingleInvocationNonce(
  db: SqliteDb,
  nonce: string,
  { nowMs = Date.now(), recencyMs = INVOCATION_RECENCY_MS, collisionMs = INVOCATION_COLLISION_MS }: InvocationResolveOptions,
  strict = false,
): string | null {
  // The query path is read-only and may face a partially built index (for
  // example only index_state exists while a writer lease is held). A missing
  // schema simply means the nonce cannot resolve: honest unknown.
  const indexedTables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE name IN ('messages_fts', 'messages', 'tool_calls')").all()
      .map(row => row.name),
  );
  const cutoff = new Date(nowMs - recencyMs).toISOString();
  // session_id → newest matching record timestamp (ISO-8601 text).
  const newestBySession = new Map<string, string>();
  const track = (sessionId: unknown, timestamp: unknown): void => {
    if (typeof sessionId !== 'string' || typeof timestamp !== 'string') return;
    const prev = newestBySession.get(sessionId);
    if (prev === undefined || timestamp > prev) newestBySession.set(sessionId, timestamp);
  };
  // FTS narrows to candidate messages; exact containment then filters out
  // tokenizer false positives (hyphenated nonces are split into tokens).
  const ftsQuery = (nonce.match(/[\p{Letter}\p{Number}]+/gu) || [])
    .slice(0, 12)
    .map(token => `"${token}"`)
    .join(' ');
  if (ftsQuery && indexedTables.has('messages_fts') && indexedTables.has('messages')) {
    const rows = db.prepare(`
      SELECT m.session_id AS session_id, m.text AS text, m.timestamp AS timestamp
      FROM messages_fts mf JOIN messages m ON m.uuid = mf.uuid
      WHERE mf.text MATCH ? AND m.timestamp >= ?
    `).all(ftsQuery, cutoff);
    for (const row of rows) {
      if (typeof row.text === 'string' && row.text.includes(nonce)) track(row.session_id, row.timestamp);
    }
  }
  // The obelisk command line lands in tool_calls.input_json for providers that
  // record tool input separately from message text. The LIKE scan is bounded
  // to recent rows via the joined message timestamp (ISO-8601 text, so a
  // lexicographic cutoff is valid). CROSS JOIN forces the planner to drive
  // from messages (idx_messages_time) and probe tool_calls by message_uuid;
  // a plain JOIN lets SQLite drive from a 150k-row tool_calls scan instead.
  if (indexedTables.has('tool_calls') && indexedTables.has('messages')) {
    // input_json is JSON-encoded, so a nonce containing JSON-escaped
    // characters (notably backslashes in Windows paths) is stored in escaped
    // form; match both the raw and the JSON-escaped spelling.
    const likePattern = (value: string): string => `%${value.replace(/[\\%_]/g, '\\$&')}%`;
    const jsonEscaped = JSON.stringify(nonce).slice(1, -1);
    const patterns = jsonEscaped === nonce ? [likePattern(nonce)] : [likePattern(nonce), likePattern(jsonEscaped)];
    const likeClause = patterns.map(() => "tc.input_json LIKE ? ESCAPE '\\'").join(' OR ');
    const toolRows = db.prepare(`
      SELECT tc.session_id AS session_id, m.timestamp AS timestamp
      FROM messages m CROSS JOIN tool_calls tc ON tc.message_uuid = m.uuid
      WHERE m.timestamp >= ? AND (${likeClause})
    `).all(cutoff, ...patterns);
    for (const row of toolRows) {
      track(row.session_id, row.timestamp);
    }
  }
  if (newestBySession.size === 0) return null;
  if (strict) {
    // Content-derived candidates are not unique by construction (boilerplate
    // queries recur across sessions), so newest-wins is not enough. Resolve
    // only when exactly one recent session matches AND that session itself
    // holds a recent CLI invocation record — the invoker's transcript always
    // contains both the file write and the `obelisk --query` call, while a
    // stranger who merely wrote or quoted the same content does not invoke.
    // Zero or multiple eligible sessions are honest null, never a guess.
    const invokers = recentCliInvokerSessions(db, cutoff, indexedTables);
    const eligible = [...newestBySession.keys()].filter(id => invokers.has(id));
    return eligible.length === 1 ? eligible[0] : null;
  }
  const ranked = [...newestBySession.entries()]
    .map(([sessionId, timestamp]) => ({ sessionId, ms: Date.parse(timestamp) }))
    .sort((a, b) => b.ms - a.ms);
  // An unparseable timestamp makes ordering unreliable: lean null.
  if (ranked.some(r => Number.isNaN(r.ms))) return null;
  if (ranked.length > 1 && ranked[0].ms - ranked[1].ms <= collisionMs) return null;
  return ranked[0].sessionId;
}

// Sessions holding a recent record of an actual CLI invocation (`obelisk
// --query ...` / `obelisk --search ...` in a tool-call command line or message
// text). Bounded to the same recency window as the nonce legs.
function recentCliInvokerSessions(
  db: SqliteDb,
  cutoff: string,
  indexedTables: Set<string>,
): Set<string> {
  const invokers = new Set<string>();
  const patterns = ['%obelisk --%', '%obelisk.js --%'];
  if (indexedTables.has('tool_calls') && indexedTables.has('messages')) {
    const rows = db.prepare(`
      SELECT DISTINCT tc.session_id AS session_id
      FROM messages m CROSS JOIN tool_calls tc ON tc.message_uuid = m.uuid
      WHERE m.timestamp >= ? AND (tc.input_json LIKE ? OR tc.input_json LIKE ?)
    `).all(cutoff, ...patterns);
    for (const row of rows) {
      if (typeof row.session_id === 'string') invokers.add(row.session_id);
    }
  }
  if (indexedTables.has('messages')) {
    const rows = db.prepare(`
      SELECT DISTINCT session_id FROM messages
      WHERE timestamp >= ? AND (text LIKE ? OR text LIKE ?)
    `).all(cutoff, ...patterns);
    for (const row of rows) {
      if (typeof row.session_id === 'string') invokers.add(row.session_id);
    }
  }
  return invokers;
}

// Poll bounds for the nonce freshness fallback. The poll runs only when the
// incremental recovery build loses the writer lease (writer_busy); the cap
// gives a concurrent build — the daemon's watcher-driven build (bounded
// batching: ~250 ms trailing debounce, 0.5 s stability, 1.5 s max wait) —
// time to publish the nonce. Cold-build cost on large corpora is a separate
// concern tracked in #105.
const INVOCATION_POLL_INTERVAL_MS = 300;
const INVOCATION_POLL_CAP_MS = 4000;

interface InvocationWaitOptions {
  openRead?: () => SqliteDb;
  build?: () => unknown;
  pollIntervalMs?: number;
  pollCapMs?: number;
  resolveOpts?: InvocationResolveOptions;
}

// Block the current thread; the sync searchText path cannot await.
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // If synchronous sleeping is unavailable, the deadline below still bounds
    // the poll loop.
  }
}

// Resolve the invoking session, closing the index-freshness gap first: the
// pre-query refresh skips when a recent build or the app daemon owns writes,
// so the current invocation's tool-call record may not be indexed yet. On a
// first miss, run one incremental recovery build that bypasses both the
// recent-build debounce and — as a narrow carve-out (ADR 0006 amendment) —
// daemon policy ownership. The carve-out is incremental-only: it runs against
// an already-initialized index and never performs schema setup, which stays
// read-only under a fresh daemon heartbeat. The writer lease remains the sole
// arbitrator: if another writer holds it, the build skips with writer_busy and
// the poll loop below waits for that writer (the daemon or a concurrent
// agent's build) to publish the nonce. Still unresolved after the cap is
// honest null. Queries without a nonce or with an immediate hit pay zero
// added latency.
export function resolveInvokingSessionIdWithWait(
  nonce: string | readonly (string | { value: string; strict?: boolean })[] | null | undefined,
  providerRegistry: ProviderRegistry,
  {
    openRead = openReadDb,
    build = () => buildIndex({ ignoreRecentBuild: true, ignoreDaemonOwnership: true, providerRegistry }),
    pollIntervalMs = INVOCATION_POLL_INTERVAL_MS,
    pollCapMs = INVOCATION_POLL_CAP_MS,
    resolveOpts,
  }: InvocationWaitOptions = {},
): string | null {
  const candidates = (Array.isArray(nonce) ? nonce : [nonce])
    .filter(c => Boolean(typeof c === 'string' ? c : c?.value));
  if (candidates.length === 0) return null;
  // Open a fresh read snapshot per attempt: another writer (the daemon or a
  // concurrent agent's build) may publish a newer index between ticks.
  const tryResolve = (): string | null => {
    const db = openRead();
    try {
      return resolveInvokingSessionId(db, candidates, resolveOpts);
    } finally {
      db.close();
    }
  };
  const schemaReady = (): boolean => {
    const db = openRead();
    try {
      const tablesReady = db.prepare(
        "SELECT COUNT(*) AS c FROM sqlite_master WHERE name IN ('messages_fts', 'messages', 'tool_calls')",
      ).get()?.c === 3;
      if (!tablesReady) return false;
      // The carve-out build must not perform a schema upgrade: migrating a
      // legacy schema under a fresh daemon heartbeat remains daemon-owned
      // (ADR 0006). Unreadable migration state also fails closed.
      try {
        return !coreSchemaNeedsMigration(db);
      } catch {
        return false;
      }
    } finally {
      db.close();
    }
  };
  const immediate = tryResolve();
  if (immediate) return immediate;
  if (schemaReady()) {
    reportIncompleteInventory(build());
    const afterBuild = tryResolve();
    if (afterBuild) return afterBuild;
  }
  const deadline = Date.now() + pollCapMs;
  while (Date.now() < deadline) {
    sleepSync(pollIntervalMs);
    const hit = tryResolve();
    if (hit) return hit;
  }
  return null;
}

// FTS search over indexed message text. Refreshes the index, then queries.
export function searchText(text: string, opts?: Record<string, unknown>, invocation?: InvocationOptions): unknown {
  const providerRegistry = refreshQueryIndex();
  const invokingSessionId = resolveInvokingSessionIdWithWait(invocation?.invocationNonce, providerRegistry);
  // Query against a freshly opened snapshot so results reflect the latest
  // published index.
  const db = openReadDb();
  try {
    try {
      return createQueryApi(db, { providerRegistry, invokingSessionId }).search(text, opts);
    } catch (error) {
      return rethrowUnlessSchemaBlocked(error);
    }
  } finally {
    db.close();
  }
}

// Execute a read-only CodeAct query script and resolve its returned value.
export async function executeQuery(scriptContent: string, invocation?: InvocationOptions): Promise<unknown> {
  const providerRegistry = refreshQueryIndex();
  const invokingSessionId = resolveInvokingSessionIdWithWait(invocation?.invocationNonce, providerRegistry);
  const db = openReadDb();
  try {
    try {
      return await runInSandbox(createQueryApi(db, { providerRegistry, invokingSessionId }), scriptContent);
    } catch (error) {
      return rethrowUnlessSchemaBlocked(error);
    }
  } finally {
    db.close();
  }
}

// Execute a memory-mutation CodeAct script (remember/forget only).
// Memory writes are independent of index writes by design: no settings read,
// no pre-write index build, no daemon-ownership check, no writer lease. The
// memories table is untouched by index builds (force rebuilds included), each
// mutation is a single short retryable write transaction, and concurrent
// attunes cannot collide logically — remember() generates unique ids and
// forget() is idempotent (ADR 0006 amendment).
export async function executeAttune(scriptContent: string): Promise<unknown> {
  const db = openAttuneDb();
  try {
    const txDb = nodeSqliteTransactionAdapter(db);
    const runMutation = <T>(work: () => T): T => runRetryableWriteTransaction(
      txDb,
      work,
      { label: 'attune' },
      // The connection's busy_timeout is short (250 ms, per ADR 0006), so a
      // contended BEGIN fails fast and this layer owns the waiting. The 5 s
      // budget is the real bound; maxAttempts just has to be large enough not
      // to cap it first (each cycle costs ~250 ms timeout + growing backoff).
      { retryOnBeginBusy: true, budgetMs: 5000, retryDelayMs: 100, maxAttempts: 10 },
    );
    // Verify the recall half of the memory layer (FTS + triggers) actually
    // works before accepting mutations. The probe runs inside the same
    // retryable transaction wrapper, so lock contention is waited out by the
    // same budget instead of failing the open with a misleading error.
    runMutation(() => probeAttuneMemoryLayer(db));
    return await runInSandbox(createAttuneApi(db, runMutation), scriptContent);
  } finally {
    db.close();
  }
}
