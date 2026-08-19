// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Passive-pull indexing orchestration for the Core package.
import { existsSync } from 'node:fs';
import { DB_PATH, openDb, openReadDb, openWriterLeaseDb, rebuildMemoryFts } from './db.ts';
import { inferProjectPath } from './parsing.ts';
import {
  createProviderIndexPlan,
  indexProviderPlan,
  indexProviderPlanStrict,
  ProviderIndexFailure,
  writeProviderIndexMarkers,
} from './provider-indexing.ts';
import { nodeSqliteTransactionAdapter } from './tx.ts';
import { acquireWriterLease, writerLockPathFor } from './writer-lease.ts';
import { runRetryableWriteTransaction, isBeginBusyFailure, hasUnusableTransaction } from './write-coordinator.ts';
import {
  createConfiguredBuiltinProviderRuntime,
  readPersistedProviderSettings,
} from './provider-settings.ts';
import { coreSchemaNeedsMigration } from './schema-migrations.ts';
import type { ProviderRegistry } from './providers/registry.ts';
import type { NodeSqliteDb, SqliteDb, SqliteRow } from './sqlite-types.ts';

interface SkippedFile {
  provider: string;
  path: string;
  error: string;
  diagnostics?: unknown;
}

interface BuildCheckOptions {
  now?: number;
  ignoreRecentBuild?: boolean;
  ignoreDaemonOwnership?: boolean;
}

interface BuildIndexOptions {
  force?: boolean;
  // Bypass the recent-build debounce without selecting the force full-republish
  // path: the build stays incremental. Used by the invocation-nonce freshness
  // recovery, which needs the just-written transcript indexed cheaply.
  ignoreRecentBuild?: boolean;
  // Bypass the daemon-ownership policy check (fresh __app_heartbeat__). Narrow
  // carve-out for the invocation-nonce freshness build: the writer lease
  // remains the sole write arbitrator, and the build stays incremental so
  // daemon and CLI cursors in index_state stay consistent. force does NOT
  // imply this; the carve-out is always explicit (ADR 0006 amendment).
  ignoreDaemonOwnership?: boolean;
  providerRegistry?: ProviderRegistry;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


function refreshSessionProjectPaths(db: NodeSqliteDb): void {
  const sessions = db.prepare('SELECT id, project FROM sessions').all();
  const cwdStmt = db.prepare(`
    SELECT cwd
    FROM messages
    WHERE session_id = ? AND cwd IS NOT NULL AND cwd != ''
    ORDER BY timestamp IS NULL, timestamp
  `);
  const update = db.prepare('UPDATE sessions SET project_path = ? WHERE id = ?');
  for (const session of sessions) {
    const cwds = cwdStmt.all(session.id).map((row: SqliteRow) => row.cwd);
    const projectPath = inferProjectPath(session.project, cwds);
    if (projectPath) update.run(projectPath, session.id);
  }
}

// A workflow unit links to its parent Workflow tool call by matching the unique
// run id in the tool_result text — but the run json can reach the index before
// that tool_result lands in the main transcript, leaving parent_tool_use_id
// null with no later re-parse to fix it (the run json's mtime no longer moves).
// Once every unit is persisted the tool_results table holds the result text, so
// the match can be completed in SQL. Runs at every finalize: missed links heal
// on the next refresh instead of waiting for a force rebuild. instr() is exact
// substring matching (no LIKE wildcards); unresolvable rows stay null.
function healWorkflowParentLinks(db: SqliteDb): void {
  db.prepare(`
    UPDATE workflows
    SET parent_tool_use_id = (
      SELECT tr.tool_use_id
      FROM tool_results tr
      JOIN tool_calls tc ON tc.id = tr.tool_use_id AND tc.session_id = tr.session_id
      WHERE tr.session_id = workflows.session_id
        AND tc.name = 'Workflow'
        AND instr(tr.content, workflows.run_id) > 0
      ORDER BY tr.rowid
      LIMIT 1
    )
    WHERE parent_tool_use_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM tool_results tr
        JOIN tool_calls tc ON tc.id = tr.tool_use_id AND tc.session_id = tr.session_id
        WHERE tr.session_id = workflows.session_id
          AND tc.name = 'Workflow'
          AND instr(tr.content, workflows.run_id) > 0
      )
  `).run();
}

const BUILD_DEBOUNCE_MS = 30000;
const APP_HEARTBEAT_FRESH_MS = 60000;

// messages_fts is maintained row-by-row by its schema triggers: persist writes
// messages with INSERT ... ON CONFLICT DO UPDATE (fires messages_fts_au) and
// deletes them with plain DELETE (fires messages_fts_ad), so an incremental
// build never leaves the index stale. The wholesale rebuild that used to run in
// every finalize predates that guarantee, and its cost is independent of how
// much changed — on a 1.8 GB index it is ~30 s of a ~50 s incremental build
// (3× that under a trigram tokenizer). It is still needed exactly once, to heal
// an index whose rows were written before trigger-only maintenance could be
// trusted (e.g. by a version that wrote messages with INSERT OR REPLACE, whose
// implicit deletes fire no DELETE trigger). This marker records that the heal
// has happened; it is written in the same transaction as the rebuild, so an
// interrupted build simply redoes it — the marker never runs ahead of the work.
const MESSAGES_FTS_SYNC_MARKER = '__messages_fts_synced__';

function markMessagesFtsSynced(db: SqliteDb): void {
  db.prepare(
    "INSERT OR REPLACE INTO index_state (jsonl_path, mtime, lines_processed) VALUES (?, ?, 0)",
  ).run(MESSAGES_FTS_SYNC_MARKER, Date.now());
}

function syncMessagesFtsOnce(db: SqliteDb): void {
  const done = db.prepare('SELECT jsonl_path FROM index_state WHERE jsonl_path = ?').get(MESSAGES_FTS_SYNC_MARKER);
  if (done) return;
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
  markMessagesFtsSynced(db);
}

function shouldSkipBuild(db: NodeSqliteDb, { now = Date.now(), ignoreRecentBuild = false, ignoreDaemonOwnership = false }: BuildCheckOptions = {}) {
  if (!ignoreDaemonOwnership) {
    const appHeartbeat = db.prepare("SELECT mtime FROM index_state WHERE jsonl_path='__app_heartbeat__'").get();
    if (appHeartbeat && now - appHeartbeat.mtime < APP_HEARTBEAT_FRESH_MS) {
      return { skip: true, reason: 'daemon_active' };
    }
  }
  if (!ignoreRecentBuild) {
    const last = db.prepare("SELECT mtime FROM index_state WHERE jsonl_path='__last_build__'").get();
    if (last && now - last.mtime < BUILD_DEBOUNCE_MS) {
      return { skip: true, reason: 'recent_build' };
    }
  }
  return { skip: false };
}

function isMissingIndexStateTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table:\s*(?:main\.)?index_state\b/i.test(message);
}

function inspectBuildOwnership({ force = false, ignoreRecentBuild = false, ignoreDaemonOwnership = false }: { force?: boolean; ignoreRecentBuild?: boolean; ignoreDaemonOwnership?: boolean } = {}) {
  if (!existsSync(DB_PATH)) return { skip: false };
  const db = openReadDb();
  try {
    const ownership = shouldSkipBuild(db, { ignoreRecentBuild: force || ignoreRecentBuild, ignoreDaemonOwnership });
    if (!ownership.skip || ownership.reason === 'daemon_active') return ownership;
    return coreSchemaNeedsMigration(db) ? { skip: false } : ownership;
  } catch (error) {
    // A missing table means the write path must initialize a new/legacy index.
    // Any other read failure leaves daemon ownership unknown, so fail closed.
    if (isMissingIndexStateTable(error)) return { skip: false };
    throw error;
  } finally {
    db.close();
  }
}

function ensureReadableSchema(): { ready: boolean; reason?: string } {
  const inspect = () => {
    if (!existsSync(DB_PATH)) return { ready: false };
    const db = openReadDb();
    try {
      if (!coreSchemaNeedsMigration(db)) return { ready: true };
      try {
        if (shouldSkipBuild(db, { ignoreRecentBuild: true }).reason === 'daemon_active') {
          return { ready: false, reason: 'daemon_active' };
        }
      } catch (error) {
        if (!isMissingIndexStateTable(error)) throw error;
      }
      return { ready: false };
    } finally {
      db.close();
    }
  };

  let state = inspect();
  if (state.ready || state.reason) return state;
  const lease = acquireWriterLease({
    lockPath: writerLockPathFor(DB_PATH),
    openDb: openWriterLeaseDb,
    waitMs: 1000,
  });
  if (!lease) return { ready: false, reason: 'writer_busy' };
  try {
    state = inspect();
    if (state.ready || state.reason) return state;
    const db = openDb();
    db.close();
    return { ready: true };
  } finally {
    lease.release();
  }
}

function buildIndex({ force = false, ignoreRecentBuild = false, ignoreDaemonOwnership = false, providerRegistry }: BuildIndexOptions = {}) {
  const ownership = inspectBuildOwnership({ force, ignoreRecentBuild, ignoreDaemonOwnership });
  if (ownership.skip) return ownership;
  const lease = acquireWriterLease({
    lockPath: writerLockPathFor(DB_PATH),
    openDb: openWriterLeaseDb,
  });
  if (!lease) return { skip: true, reason: 'writer_busy' };
  try {
    // Ownership may change between the first read and lease acquisition.
    const ownershipAfterLease = inspectBuildOwnership({ force, ignoreRecentBuild, ignoreDaemonOwnership });
    if (ownershipAfterLease.skip) return ownershipAfterLease;
    let registry = providerRegistry;
    if (registry === undefined) {
      const settings = readPersistedProviderSettings();
      if (!settings.ok) {
        return { skip: true, reason: 'settings_unavailable', error: settings.error };
      }
      registry = createConfiguredBuiltinProviderRuntime(settings.settings).registry;
    }

    const db = openDb();
    const txDb = nodeSqliteTransactionAdapter(db);
    const skippedFiles: SkippedFile[] = [];
    try {
      const providerPlan = createProviderIndexPlan(db, registry, { force });
      const incompleteProviders = [...providerPlan.incompleteProviders].sort();
      const inventoryIssues = [...providerPlan.inventoryIssues];
      if (force && incompleteProviders.length > 0) {
        return {
          skip: false,
          complete: false,
          reason: 'incomplete_snapshot',
          incompleteProviders,
          inventoryIssues,
          skipped: 0,
          skippedFiles,
        };
      }

      if (force) {
        try {
          runRetryableWriteTransaction(txDb, () => {
            // A force build publishes one complete source snapshot or nothing.
            // The provider contract reserves no key prefix. A force snapshot
            // recreates every unit cursor, provider marker, and system marker.
            db.prepare('DELETE FROM index_state').run();
            for (const table of ['messages', 'tool_calls', 'tool_results', 'sessions', 'summaries', 'subagents', 'workflows', 'workflow_agents']) {
              db.prepare(`DELETE FROM ${table}`).run();
            }
            const providerResult = indexProviderPlanStrict({
              db,
              plan: providerPlan,
            });
            refreshSessionProjectPaths(db);
            healWorkflowParentLinks(db);
            // A force snapshot keeps the wholesale rebuild as its last line of
            // defence, and re-records the sync marker it just wiped with
            // index_state so the next incremental build trusts the triggers.
            db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
            markMessagesFtsSynced(db);
            rebuildMemoryFts(db);
            db.prepare("INSERT OR REPLACE INTO index_state (jsonl_path, mtime, lines_processed) VALUES ('__last_build__', ?, 0)").run(Date.now());
            writeProviderIndexMarkers(db, providerPlan, providerResult);
          }, { label: 'force-rebuild' });
        } catch (error) {
          if (isBeginBusyFailure(error)) {
            return {
              skip: true,
              complete: false,
              reason: 'database_busy',
              incompleteProviders,
              inventoryIssues,
              skipped: 0,
              skippedFiles,
            };
          }
          if (error instanceof ProviderIndexFailure) {
            const skippedFile = {
              provider: error.item.provider.name,
              path: error.item.unit.key,
              error: errorMessage(error.sourceError),
              diagnostics: (error as { obelisk?: unknown }).obelisk,
            };
            skippedFiles.push(skippedFile);
            process.stderr.write(
              `Warning: failed to index ${error.item.provider.name} unit ${skippedFile.path}: ${skippedFile.error}\n`,
            );
            return {
              skip: false,
              complete: false,
              reason: 'provider_failure',
              incompleteProviders,
              inventoryIssues,
              skipped: skippedFiles.length,
              skippedFiles,
            };
          }
          throw error;
        }
        return {
          skip: false,
          complete: true,
          incompleteProviders,
          inventoryIssues,
          skipped: 0,
          skippedFiles,
        };
      }

      const providerResult = indexProviderPlan({
        db,
        plan: providerPlan,
        runTransaction: (label, work) => runRetryableWriteTransaction(txDb, work, { label }),
        onError: (error, { provider, unit }) => {
          if (isBeginBusyFailure(error)) return 'stop';
          if (hasUnusableTransaction(error)) throw error;
          const detail = error as { message?: unknown; obelisk?: unknown } | null;
          const message = errorMessage(error);
          skippedFiles.push({
            provider: provider.name,
            path: unit.key,
            error: message,
            diagnostics: detail?.obelisk,
          });
          process.stderr.write(`Warning: failed to index ${provider.name} unit ${unit.key}: ${message}\n`);
          return 'skip';
        },
      });
      if (providerResult.stopped) {
        return {
          skip: true,
          complete: false,
          reason: 'database_busy',
          incompleteProviders,
          inventoryIssues,
          skipped: skippedFiles.length,
          skippedFiles,
        };
      }
      // Finalize is one transaction and is NOT swallowed: a finalize failure fails
      // the build (a half-finalized index would be inconsistent).
      try {
        runRetryableWriteTransaction(txDb, () => {
          refreshSessionProjectPaths(db);
          healWorkflowParentLinks(db);
          syncMessagesFtsOnce(db);
          rebuildMemoryFts(db);
          db.prepare("INSERT OR REPLACE INTO index_state (jsonl_path, mtime, lines_processed) VALUES ('__last_build__', ?, 0)").run(Date.now());
          writeProviderIndexMarkers(db, providerPlan, providerResult);
        }, { label: 'finalize' });
      } catch (error) {
        if (isBeginBusyFailure(error)) {
          return {
            skip: true,
            complete: false,
            reason: 'database_busy',
            incompleteProviders,
            inventoryIssues,
            skipped: skippedFiles.length,
            skippedFiles,
          };
        }
        throw error;
      }
      return {
        skip: false,
        complete: providerResult.complete,
        incompleteProviders,
        inventoryIssues,
        skipped: skippedFiles.length,
        skippedFiles,
      };
    } finally {
      db.close();
    }
  } finally {
    lease.release();
  }
}

export { buildIndex, ensureReadableSchema, healWorkflowParentLinks, inferProjectPath, refreshSessionProjectPaths, shouldSkipBuild };
