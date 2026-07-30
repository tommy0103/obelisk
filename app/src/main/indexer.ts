import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createBuiltinProviderRegistry } from '../../../packages/core/src/providers/builtins.ts';
import type { ProviderRegistry } from '../../../packages/core/src/providers/registry.ts';
import {
  createProviderIndexPlan,
  indexProviderPlan,
  writeProviderIndexMarkers,
} from '../../../packages/core/src/provider-indexing.ts';
import { runWriteTransaction, configureConnection, betterSqliteTransactionAdapter } from '../../../packages/core/src/tx.ts';
import { migrateCoreSchemaColumns, migrateFtsTokenizer, resolveFtsTokenizer } from '../../../packages/core/src/schema-migrations.ts';
import { acquireWriterLease, writerLockPathFor } from '../../../packages/core/src/writer-lease.ts';
import { runRetryableWriteTransaction, isBeginBusyFailure, hasUnusableTransaction } from '../../../packages/core/src/write-coordinator.ts';
import {
  inferProjectPath,
} from '../../../packages/core/src/parsing.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_CLAUDE_DIR = path.join(os.homedir(), '.claude');
const DEFAULT_OBELISK_DIR = path.join(os.homedir(), '.obelisk');
const DEFAULT_DB_PATH = path.join(DEFAULT_OBELISK_DIR, 'obelisk.sqlite');

function resolveSchemaPath() {
  const candidates = [
    path.join(__dirname, 'schema.sql'),
    path.join(__dirname, '..', '..', '..', 'packages', 'core', 'src', 'schema.sql'),
    process.resourcesPath ? path.join(process.resourcesPath, 'scripts', 'schema.sql') : null,
  ].filter((c): c is string => Boolean(c));
  const found = candidates.find(p => fs.existsSync(p));
  if (!found) throw new Error('Obelisk schema.sql not found');
  return found;
}

function installSchema(db, schemaPath = resolveSchemaPath()) {
  db.exec(fs.readFileSync(schemaPath, 'utf8'));
  migrateCoreSchemaColumns(db);
  migrateFtsTokenizer(db, resolveFtsTokenizer());
}

function openIndexDb({ dbPath = DEFAULT_DB_PATH, schemaPath = resolveSchemaPath(), DatabaseImpl = Database }: { dbPath?: string; schemaPath?: string; DatabaseImpl?: new (dbPath: string) => any } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseImpl(dbPath);
  configureConnection(db, { busyTimeoutMs: 250 });
  installSchema(db, schemaPath);
  return db;
}

function copyMemoriesFromDb(db, sourceDbPath) {
  if (!sourceDbPath || !fs.existsSync(sourceDbPath)) return false;
  db.prepare('ATTACH DATABASE ? AS previous_obelisk').run(sourceDbPath);
  try {
    const hasMemories = db.prepare(`
      SELECT name FROM previous_obelisk.sqlite_master
      WHERE type='table' AND name='memories'
    `).get();
    if (!hasMemories) return false;

    const sourceColumns = new Set(
      db.prepare('PRAGMA previous_obelisk.table_info(memories)').all().map(column => column.name),
    );
    const targetColumns = [
      'id',
      'session_id',
      'project',
      'message_start',
      'message_end',
      'path',
      'anchors',
      'summary',
      'created_at',
      'deleted_at',
      'deleted_reason',
    ];
    const selectList = targetColumns
      .map(column => sourceColumns.has(column) ? column : `NULL AS ${column}`)
      .join(',');
    db.exec(`
      INSERT OR REPLACE INTO memories (${targetColumns.join(',')})
      SELECT ${selectList} FROM previous_obelisk.memories
    `);
    return true;
  } finally {
    db.exec('DETACH DATABASE previous_obelisk');
  }
}

function normalizeChangedPath(projectsDir, changedPath) {
  if (!changedPath) return null;
  const raw = String(changedPath);
  return path.isAbsolute(raw) ? path.normalize(raw) : path.normalize(path.join(projectsDir, raw));
}

function sessionIdFromChangedPath(projectsDir, changedPath) {
  const fp = normalizeChangedPath(projectsDir, changedPath);
  if (!fp) return null;
  const rel = path.relative(projectsDir, fp);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  if (parts.length === 2 && parts[1].endsWith('.jsonl')) {
    return fs.existsSync(fp) ? parts[1].slice(0, -6) : null;
  }
  if (parts.length >= 3) return fs.existsSync(fp) ? parts[1] || null : null;
  return null;
}

function refreshSessionProjectPaths(db) {
  const sessions = db.prepare('SELECT id, project FROM sessions').all();
  const cwdStmt = db.prepare(`
    SELECT cwd FROM messages
    WHERE session_id = ? AND cwd IS NOT NULL AND cwd != ''
    ORDER BY timestamp IS NULL, timestamp
  `);
  const update = db.prepare('UPDATE sessions SET project_path = ? WHERE id = ?');
  for (const session of sessions) {
    const cwds = cwdStmt.all(session.id).map(row => row.cwd);
    const projectPath = inferProjectPath(session.project, cwds);
    if (projectPath) update.run(projectPath, session.id);
  }
}

function rebuildFts(db) {
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
  db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
}

// PASSIVE by default: it checkpoints what it can without blocking concurrent
// readers/writers, so it is safe to run after every build. A blocking TRUNCATE
// (which reclaims the -wal file but needs exclusive access and can contend with
// the daemon + queries) is reserved for maintenance/exit — pass mode explicitly.
function checkpointDb(db, mode = 'PASSIVE') {
  try {
    db.pragma(`wal_checkpoint(${mode})`);
  } catch {}
}

const MESSAGE_FTS_TRIGGERS = [
  'messages_fts_ai',
  'messages_fts_ad',
  'messages_fts_au',
];

function dropMessageFtsTriggers(db) {
  for (const trigger of MESSAGE_FTS_TRIGGERS) {
    db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  }
}

function ensureFtsReady(db, { force = false } = {}) {
  const marker = '__fts_triggers_ready__';
  const ready = db.prepare('SELECT jsonl_path FROM index_state WHERE jsonl_path = ?').get(marker);
  if (ready && !force) return false;
  rebuildFts(db);
  writeIndexMarker(db, marker);
  return true;
}

function writeIndexMarker(db, key, value = Date.now()) {
  db.prepare('INSERT OR REPLACE INTO index_state (jsonl_path, mtime, lines_processed) VALUES (?, ?, 0)').run(key, value);
}

function writeHeartbeat({
  dbPath = DEFAULT_DB_PATH,
  writerLeasePath = writerLockPathFor(dbPath),
  DatabaseImpl = Database,
  LockDatabaseImpl = DatabaseImpl,
} = {}) {
  if (!fs.existsSync(dbPath)) return;
  const lease = acquireWriterLease({
    lockPath: writerLeasePath,
    openDb: lockPath => new LockDatabaseImpl(lockPath),
  });
  if (!lease) return false;
  try {
    const db = new DatabaseImpl(dbPath);
    configureConnection(db, { busyTimeoutMs: 0 });
    const txDb = betterSqliteTransactionAdapter(db);
    try {
      runWriteTransaction(txDb, () => writeIndexMarker(db, '__app_heartbeat__'), { label: 'heartbeat' });
      return true;
    } finally {
      db.close();
    }
  } finally {
    lease.release();
  }
}

interface BuildIndexOptions {
  providerRoots?: Record<string, string>;
  providerRegistry?: ProviderRegistry;
  claudeDir?: string;
  codexDir?: string;
  projectsDir?: string;
  dbPath?: string;
  schemaPath?: string;
  DatabaseImpl?: new (dbPath: string) => any;
  LockDatabaseImpl?: new (dbPath: string) => any;
  force?: boolean;
  changedPaths?: string[];
  preserveDbPath?: string | null;
  writerLeasePath?: string;
  writerLeaseWaitMs?: number;
  writerLeaseMode?: 'acquire' | 'caller-held';
}

interface SkippedFile {
  path: string;
  error: string;
  diagnostics?: unknown;
}

interface BuildIndexResult {
  files: number;
  latestSourceMtime: number;
  affectedSessionIds: string[];
  ftsRebuilt: boolean;
  skipped: number;
  skippedFiles: SkippedFile[];
  deferred: boolean;
  reason?: string;
}

function deferredBuildResult(
  reason: string,
  overrides: Partial<Omit<BuildIndexResult, 'deferred' | 'reason'>> = {},
): BuildIndexResult {
  return {
    files: 0,
    latestSourceMtime: 0,
    affectedSessionIds: [],
    ftsRebuilt: false,
    skipped: 0,
    skippedFiles: [],
    ...overrides,
    deferred: true,
    reason,
  };
}

function buildIndex({
  providerRoots = {},
  providerRegistry,
  claudeDir = DEFAULT_CLAUDE_DIR,
  codexDir = path.join(path.dirname(claudeDir), '.codex'),
  projectsDir = path.join(claudeDir, 'projects'),
  dbPath = DEFAULT_DB_PATH,
  schemaPath = resolveSchemaPath(),
  DatabaseImpl = Database,
  LockDatabaseImpl = DatabaseImpl,
  force = false,
  changedPaths = undefined,
  preserveDbPath = null,
  writerLeasePath = writerLockPathFor(dbPath),
  writerLeaseWaitMs = 2000,
  writerLeaseMode = 'acquire',
}: BuildIndexOptions = {}): BuildIndexResult {
  if (writerLeaseMode !== 'acquire' && writerLeaseMode !== 'caller-held') {
    throw new Error(`Unknown writer lease mode: ${writerLeaseMode}`);
  }
  let lease: ReturnType<typeof acquireWriterLease> = null;
  if (writerLeaseMode === 'acquire') {
    lease = acquireWriterLease({
      lockPath: writerLeasePath,
      openDb: lockPath => new LockDatabaseImpl(lockPath),
      waitMs: writerLeaseWaitMs,
    });
    if (!lease) {
      return deferredBuildResult('writer_busy');
    }
  }
  try {
    const db = openIndexDb({ dbPath, schemaPath, DatabaseImpl });
    const txDb = betterSqliteTransactionAdapter(db);
    let messageFtsTriggersDropped = false;
    try {
      if (preserveDbPath && path.resolve(preserveDbPath) !== path.resolve(dbPath)) {
        copyMemoriesFromDb(db, preserveDbPath);
      }
      const defaultHome = os.homedir();
      const compatibilityHome = path.dirname(claudeDir);
      const relocatedDefaults = Object.fromEntries(
        createBuiltinProviderRegistry().catalog().map((descriptor) => {
          const relativeDefault = path.relative(defaultHome, descriptor.defaultRoot);
          const root = compatibilityHome !== defaultHome
            && relativeDefault
            && !relativeDefault.startsWith('..')
            && !path.isAbsolute(relativeDefault)
            ? path.join(compatibilityHome, relativeDefault)
            : descriptor.defaultRoot;
          return [descriptor.id, root];
        }),
      );
      const roots = {
        ...relocatedDefaults,
        claude: claudeDir,
        codex: codexDir,
        ...providerRoots,
      };
      const registry = providerRegistry ?? createBuiltinProviderRegistry(roots);
      const providerPlan = createProviderIndexPlan(db, registry, { force, changedPaths });
      let latestSourceMtime = providerPlan.items.reduce((latest, { unit }) => {
        const providerCursor = (unit.meta as { currentCursor?: unknown } | undefined)?.currentCursor;
        if (typeof providerCursor === 'string') {
          return Math.max(latest, Number(providerCursor.split(':')[0]) || 0);
        }
        try {
          return Math.max(latest, fs.statSync(unit.key).mtimeMs);
        } catch {
          return latest;
        }
      }, 0);

      try {
        if (force) {
          runRetryableWriteTransaction(txDb, () => {
            dropMessageFtsTriggers(db);
            db.prepare("DELETE FROM index_state WHERE substr(jsonl_path, 1, 2) != '__'").run();
            db.prepare("DELETE FROM messages").run();
            db.prepare("DELETE FROM tool_calls").run();
            db.prepare("DELETE FROM tool_results").run();
            db.prepare("DELETE FROM sessions").run();
            db.prepare("DELETE FROM summaries").run();
            db.prepare("DELETE FROM subagents").run();
            db.prepare("DELETE FROM workflows").run();
            db.prepare("DELETE FROM workflow_agents").run();
          }, { label: 'force-cleanup' });
          messageFtsTriggersDropped = true;
        }
      } catch (error) {
        if (isBeginBusyFailure(error)) {
          return deferredBuildResult('database_busy', {
            files: providerPlan.items.length,
            latestSourceMtime,
          });
        }
        throw error;
      }
      const affectedSessionIds = new Set<string>();
      const finalizeAffectedSessionIds = new Set<string>();
      const changedMetaJsonlPaths = new Set<string>();
      if (Array.isArray(changedPaths)) {
        for (const changedPath of changedPaths) {
          const sessionId = sessionIdFromChangedPath(projectsDir, changedPath);
          const normalizedChangedPath = normalizeChangedPath(projectsDir, changedPath);
          const isMetaChange = normalizedChangedPath?.toLowerCase().endsWith('.meta.json');
          if (isMetaChange && normalizedChangedPath) {
            changedMetaJsonlPaths.add(
              normalizedChangedPath.slice(0, -'.meta.json'.length) + '.jsonl',
            );
          }
          // Transcript files report their session only after their own transaction
          // commits. Workflow changes are applied during finalize, so stage those
          // IDs until the finalize transaction commits. Meta files map back to their
          // transcript transaction and are reported only after that commit.
          if (sessionId && !changedPath.toLowerCase().endsWith('.jsonl') && !isMetaChange) {
            finalizeAffectedSessionIds.add(sessionId);
          }
        }
      }
      const skipped: SkippedFile[] = [];
      const providerResult = indexProviderPlan({
        db,
        plan: providerPlan,
        runTransaction: (label, work) => runRetryableWriteTransaction(txDb, work, { label }),
        onCommitted: ({ unit }, nextCursor) => {
          if (nextCursor) latestSourceMtime = Math.max(latestSourceMtime, Number(nextCursor.split(':')[0]) || 0);
          if (unit.sessionId) affectedSessionIds.add(unit.sessionId);
        },
        onError: (error, { provider, unit }) => {
          if (isBeginBusyFailure(error)) return 'stop';
          if (hasUnusableTransaction(error)) throw error;
          skipped.push({
            path: unit.key,
            error: (error as Error).message,
            diagnostics: (error as { obelisk?: unknown }).obelisk,
          });
          console.warn(`Warning: failed to index ${provider.name} unit ${unit.key}: ${(error as Error).message}`);
          return 'skip';
        },
      });
      if (providerResult.stopped) {
        return deferredBuildResult('database_busy', {
          files: providerPlan.items.length,
          latestSourceMtime,
          affectedSessionIds: [...affectedSessionIds],
          skipped: skipped.length,
          skippedFiles: skipped,
        });
      }
      let ftsRebuilt = false;
      // Finalize is one transaction; a failure here fails the whole build (the
      // index would otherwise be left inconsistent).
      try {
        runRetryableWriteTransaction(txDb, () => {
          refreshSessionProjectPaths(db);
          if (messageFtsTriggersDropped) installSchema(db, schemaPath);
          ftsRebuilt = ensureFtsReady(db, { force });
          writeIndexMarker(db, '__last_build__');
          writeIndexMarker(db, '__app_last_successful_build__');
          writeIndexMarker(db, '__indexer_owner_app__');
          writeProviderIndexMarkers(db, providerPlan, providerResult);
          if (latestSourceMtime) writeIndexMarker(db, '__last_source_mtime__', latestSourceMtime);
        }, { label: 'finalize' });
      } catch (error) {
        if (isBeginBusyFailure(error)) {
          return deferredBuildResult('database_busy', {
            files: providerPlan.items.length,
            latestSourceMtime,
            affectedSessionIds: [...affectedSessionIds],
            skipped: skipped.length,
            skippedFiles: skipped,
          });
        }
        throw error;
      }
      for (const sessionId of finalizeAffectedSessionIds) affectedSessionIds.add(sessionId);
      return {
        files: providerPlan.items.length,
        latestSourceMtime,
        affectedSessionIds: [...affectedSessionIds],
        ftsRebuilt,
        skipped: skipped.length,
        skippedFiles: skipped,
        deferred: false,
      };
    } finally {
      if (messageFtsTriggersDropped) {
        try {
          installSchema(db, schemaPath);
        } catch (error) {
          console.warn(`Warning: failed to restore message FTS triggers: ${(error as Error).message}`);
        }
      }
      checkpointDb(db);
      db.close();
    }
  } finally {
    lease?.release();
  }
}

export {
  buildIndex,
  writeHeartbeat,
  openIndexDb,
  inferProjectPath,
};
