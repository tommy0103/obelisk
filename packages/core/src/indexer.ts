// Passive-pull indexing orchestration for the Core package.
import { DB_PATH, openDb, openReadDb, openWriterLeaseDb, rebuildMemoryFts, rebuildToolErrorsFts } from './db.ts';
import { fs, inferProjectPath } from './parsing.ts';
import {
  createProviderIndexPlan,
  indexProviderPlan,
  writeProviderIndexMarkers,
} from './provider-indexing.ts';
import { nodeSqliteTransactionAdapter } from './tx.ts';
import { acquireWriterLease, writerLockPathFor } from './writer-lease.ts';
import { runRetryableWriteTransaction, isBeginBusyFailure, hasUnusableTransaction } from './write-coordinator.ts';
import { createBuiltinProviderRegistry } from './providers/builtins.ts';
import type { NodeSqliteDb, SqliteRow } from './sqlite-types.ts';

interface SkippedFile {
  path: string;
  error: string;
  diagnostics?: unknown;
}

interface BuildCheckOptions {
  now?: number;
  ignoreRecentBuild?: boolean;
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

const BUILD_DEBOUNCE_MS = 30000;
const APP_HEARTBEAT_FRESH_MS = 60000;

function shouldSkipBuild(db: NodeSqliteDb, { now = Date.now(), ignoreRecentBuild = false }: BuildCheckOptions = {}) {
  const appHeartbeat = db.prepare("SELECT mtime FROM index_state WHERE jsonl_path='__app_heartbeat__'").get();
  if (appHeartbeat && now - appHeartbeat.mtime < APP_HEARTBEAT_FRESH_MS) {
    return { skip: true, reason: 'daemon_active' };
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

function inspectBuildOwnership({ force = false }: { force?: boolean } = {}) {
  if (!fs.existsSync(DB_PATH)) return { skip: false };
  const db = openReadDb();
  try {
    return shouldSkipBuild(db, { ignoreRecentBuild: force });
  } catch (error) {
    // A missing table means the write path must initialize a new/legacy index.
    // Any other read failure leaves daemon ownership unknown, so fail closed.
    if (isMissingIndexStateTable(error)) return { skip: false };
    throw error;
  } finally {
    db.close();
  }
}

function buildIndex({ force = false }: { force?: boolean } = {}) {
  const ownership = inspectBuildOwnership({ force });
  if (ownership.skip) return ownership;
  const lease = acquireWriterLease({
    lockPath: writerLockPathFor(DB_PATH),
    openDb: openWriterLeaseDb,
  });
  if (!lease) return { skip: true, reason: 'writer_busy' };
  try {
    // Ownership may change between the first read and lease acquisition.
    const ownershipAfterLease = inspectBuildOwnership({ force });
    if (ownershipAfterLease.skip) return ownershipAfterLease;

    const db = openDb();
    const txDb = nodeSqliteTransactionAdapter(db);
    const skippedFiles: SkippedFile[] = [];
    try {
      try {
        if (force) {
          runRetryableWriteTransaction(txDb, () => {
            db.prepare("DELETE FROM index_state WHERE jsonl_path != '__last_build__'").run();
            // Clearing index_state alone re-indexes existing files but leaves rows for
            // files that no longer exist on disk (stale sessions accumulate). A force
            // build is a clean rebuild: drop every derived table, then re-index from the
            // current files. `memories` is the durable, human-approved layer and is never
            // cleared; messages_fts is repopulated by the 'rebuild' command in finalize.
            for (const table of ['messages', 'tool_calls', 'tool_results', 'sessions', 'summaries', 'subagents', 'workflows', 'workflow_agents']) {
              db.prepare(`DELETE FROM ${table}`).run();
            }
          }, { label: 'force-cleanup' });
        }
      } catch (error) {
        if (isBeginBusyFailure(error)) {
          return { skip: true, reason: 'database_busy', skipped: skippedFiles.length, skippedFiles };
        }
        throw error;
      }

      const registry = createBuiltinProviderRegistry();
      const providerPlan = createProviderIndexPlan(db, registry, { force });
      const providerResult = indexProviderPlan({
        db,
        plan: providerPlan,
        runTransaction: (label, work) => runRetryableWriteTransaction(txDb, work, { label }),
        onError: (error, { provider, unit }) => {
          if (isBeginBusyFailure(error)) return 'stop';
          if (hasUnusableTransaction(error)) throw error;
          const detail = error as { message?: unknown; obelisk?: unknown } | null;
          const message = errorMessage(error);
          skippedFiles.push({ path: unit.key, error: message, diagnostics: detail?.obelisk });
          process.stderr.write(`Warning: failed to index ${provider.name} unit ${unit.key}: ${message}\n`);
          return 'skip';
        },
      });
      if (providerResult.stopped) {
        return { skip: true, reason: 'database_busy', skipped: skippedFiles.length, skippedFiles };
      }
      // Finalize is one transaction and is NOT swallowed: a finalize failure fails
      // the build (a half-finalized index would be inconsistent).
      try {
        runRetryableWriteTransaction(txDb, () => {
          refreshSessionProjectPaths(db);
          db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
          rebuildMemoryFts(db);
          rebuildToolErrorsFts(db);
          db.prepare("INSERT OR REPLACE INTO index_state (jsonl_path, mtime, lines_processed) VALUES ('__last_build__', ?, 0)").run(Date.now());
          writeProviderIndexMarkers(db, providerPlan, providerResult);
        }, { label: 'finalize' });
      } catch (error) {
        if (isBeginBusyFailure(error)) {
          return { skip: true, reason: 'database_busy', skipped: skippedFiles.length, skippedFiles };
        }
        throw error;
      }
      return { skip: false, skipped: skippedFiles.length, skippedFiles };
    } finally {
      db.close();
    }
  } finally {
    lease.release();
  }
}

export { buildIndex, inferProjectPath, refreshSessionProjectPaths, shouldSkipBuild };
