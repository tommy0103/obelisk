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

import { DB_PATH, openDb, openReadDb, openWriterLeaseDb } from './db.ts';
import { buildIndex, ensureReadableSchema, shouldSkipBuild } from './indexer.ts';
import { coreSchemaNeedsMigration } from './schema-migrations.ts';
import {
  createConfiguredBuiltinProviderRuntime,
  readPersistedProviderSettings,
} from './provider-settings.ts';
import type { ProviderRegistry } from './providers/registry.ts';
import { createQueryApi, createAttuneApi } from './query.ts';
import type { SqliteDb } from './sqlite-types.ts';
import { acquireWriterLease, writerLockPathFor } from './writer-lease.ts';

export { buildIndex, DB_PATH };

type SandboxApi = Record<string, unknown>;

interface InvocationOptions {
  invocationNonce?: string;
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

// Resolve the session that invoked this query via a unique nonce embedded in
// the CLI's argv (a uuidgen token for --search, the as-typed query file path
// for --query). Every provider writes the tool-call record before the tool
// finishes, so once the nonce reaches the index it identifies the invoking
// session. Both legs are bounded to the last INVOCATION_RECENCY_MS (see
// above), which keeps weeks-old fixed-path reuse out of the candidate set and
// makes cross-leg timestamps comparable.
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
  nonce: string | null | undefined,
  { nowMs = Date.now(), recencyMs = INVOCATION_RECENCY_MS, collisionMs = INVOCATION_COLLISION_MS }: InvocationResolveOptions = {},
): string | null {
  if (!nonce) return null;
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
    const like = `%${nonce.replace(/[\\%_]/g, '\\$&')}%`;
    const toolRows = db.prepare(`
      SELECT tc.session_id AS session_id, m.timestamp AS timestamp
      FROM messages m CROSS JOIN tool_calls tc ON tc.message_uuid = m.uuid
      WHERE m.timestamp >= ? AND tc.input_json LIKE ? ESCAPE '\\'
    `).all(cutoff, like);
    for (const row of toolRows) {
      track(row.session_id, row.timestamp);
    }
  }
  if (newestBySession.size === 0) return null;
  const ranked = [...newestBySession.entries()]
    .map(([sessionId, timestamp]) => ({ sessionId, ms: Date.parse(timestamp) }))
    .sort((a, b) => b.ms - a.ms);
  // An unparseable timestamp makes ordering unreliable: lean null.
  if (ranked.some(r => Number.isNaN(r.ms))) return null;
  if (ranked.length > 1 && ranked[0].ms - ranked[1].ms <= collisionMs) return null;
  return ranked[0].sessionId;
}

// Poll bounds for the nonce freshness fallback. The poll runs only when the
// incremental recovery build loses the writer lease (writer_busy); the cap
// gives a concurrent build — the daemon's watcher-driven build is chokidar
// debounced ~2s plus 0.5s write stability — time to publish the nonce.
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
  nonce: string | null | undefined,
  providerRegistry: ProviderRegistry,
  {
    openRead = openReadDb,
    build = () => buildIndex({ ignoreRecentBuild: true, ignoreDaemonOwnership: true, providerRegistry }),
    pollIntervalMs = INVOCATION_POLL_INTERVAL_MS,
    pollCapMs = INVOCATION_POLL_CAP_MS,
    resolveOpts,
  }: InvocationWaitOptions = {},
): string | null {
  if (!nonce) return null;
  // Open a fresh read snapshot per attempt: another writer (the daemon or a
  // concurrent agent's build) may publish a newer index between ticks.
  const tryResolve = (): string | null => {
    const db = openRead();
    try {
      return resolveInvokingSessionId(db, nonce, resolveOpts);
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
export async function executeAttune(scriptContent: string): Promise<unknown> {
  const settings = readPersistedProviderSettings();
  if (!settings.ok) throw new Error(`${settings.error}; attune was not applied`);
  const providerRegistry = createConfiguredBuiltinProviderRuntime(settings.settings).registry;
  const build = buildIndex({ providerRegistry }) as { reason?: string } | undefined;
  reportIncompleteInventory(build);
  if (build?.reason === 'daemon_active') {
    throw new Error('Obelisk daemon owns index writes; attune is read-only until the daemon stops');
  }
  if (build?.reason === 'writer_busy' || build?.reason === 'database_busy') {
    throw new Error('Obelisk index writer is busy; attune was not applied');
  }
  const lease = acquireWriterLease({
    lockPath: writerLockPathFor(DB_PATH),
    openDb: openWriterLeaseDb,
    waitMs: 1000,
  });
  if (!lease) throw new Error('Obelisk index writer is busy; attune was not applied');
  try {
    // Close the heartbeat TOCTOU window after acquiring the hard lease.
    const ownershipDb = openReadDb();
    try {
      const ownership = shouldSkipBuild(ownershipDb, { ignoreRecentBuild: true });
      if (ownership.reason === 'daemon_active') {
        throw new Error('Obelisk daemon owns index writes; attune is read-only until the daemon stops');
      }
    } finally {
      ownershipDb.close();
    }
    const db = openDb();
    try {
      return await runInSandbox(createAttuneApi(db), scriptContent);
    } finally {
      db.close();
    }
  } finally {
    lease.release();
  }
}
