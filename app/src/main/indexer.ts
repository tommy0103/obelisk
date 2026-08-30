// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createBuiltinProviderRegistry } from '../../../packages/core/src/providers/builtins.ts';
import {
  dropMessageFtsTriggers,
  ensureFtsReady,
  refreshSessionProjectPaths,
} from '../../../packages/core/src/index-finalize.ts';
import { healWorkflowParentLinks } from '../../../packages/core/src/indexer.ts';
import type { ProviderRegistry } from '../../../packages/core/src/providers/registry.ts';
import {
  createConfiguredBuiltinProviderRuntime,
  type PersistedProviderSettings,
} from '../../../packages/core/src/provider-settings.ts';
import {
  createProviderIndexPlan,
  indexProviderPlan,
  indexProviderPlanStrict,
  ProviderIndexFailure,
  readRecentTranscriptHints,
  writeProviderIndexMarkers,
  type ProviderInventoryIssue,
  type ProviderSessionProvenance,
} from '../../../packages/core/src/provider-indexing.ts';
import { runWriteTransaction, configureConnection, betterSqliteTransactionAdapter } from '../../../packages/core/src/tx.ts';
import { migrateCoreSchemaColumns } from '../../../packages/core/src/schema-migrations.ts';
import { acquireWriterLease, writerLockPathFor } from '../../../packages/core/src/writer-lease.ts';
import { runRetryableWriteTransaction, isBeginBusyFailure, hasUnusableTransaction } from '../../../packages/core/src/write-coordinator.ts';
import { inferProjectPath } from '../../../packages/core/src/parsing.ts';

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
}

function openIndexDb({ dbPath = DEFAULT_DB_PATH, schemaPath = resolveSchemaPath(), DatabaseImpl = Database }: { dbPath?: string; schemaPath?: string; DatabaseImpl?: new (dbPath: string) => any } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseImpl(dbPath);
  configureConnection(db, { busyTimeoutMs: 250 });
  installSchema(db, schemaPath);
  return db;
}

function copyPreservedDataFromDb(db, sourceDbPath): ProviderSessionProvenance[] {
  if (!sourceDbPath || !fs.existsSync(sourceDbPath)) {
    throw new Error(`Preserved Obelisk database is unavailable: ${sourceDbPath}`);
  }
  db.prepare('ATTACH DATABASE ? AS previous_obelisk').run(sourceDbPath);
  try {
    const hasMemories = db.prepare(`
      SELECT name FROM previous_obelisk.sqlite_master
      WHERE type='table' AND name='memories'
    `).get();
    if (hasMemories) {
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
    }

    const hasSessions = db.prepare(`
      SELECT name FROM previous_obelisk.sqlite_master
      WHERE type='table' AND name='sessions'
    `).get();
    if (!hasSessions) {
      throw new Error(`Preserved Obelisk database has no sessions table: ${sourceDbPath}`);
    }
    const sessionColumns = new Set(
      db.prepare('PRAGMA previous_obelisk.table_info(sessions)').all().map(column => column.name),
    );
    if (!sessionColumns.has('id') || !sessionColumns.has('jsonl_path')) {
      throw new Error(`Preserved Obelisk sessions schema is incomplete: ${sourceDbPath}`);
    }
    const sourceExpression = sessionColumns.has('source')
      ? "COALESCE(source, 'claude')"
      : "'claude'";
    return db.prepare(`
      SELECT id, jsonl_path, ${sourceExpression} AS source
      FROM previous_obelisk.sessions
      WHERE jsonl_path IS NOT NULL
        AND jsonl_path != ''
    `).all().map(row => ({
      source: String(row.source),
      sessionId: String(row.id),
      jsonlPath: String(row.jsonl_path),
    }));
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

// PASSIVE by default: it checkpoints what it can without blocking concurrent
// readers/writers, so it is safe to run after every build. A blocking TRUNCATE
// (which reclaims the -wal file but needs exclusive access and can contend with
// the daemon + queries) is reserved for maintenance/exit — pass mode explicitly.
function checkpointDb(db, mode = 'PASSIVE') {
  try {
    db.pragma(`wal_checkpoint(${mode})`);
  } catch {}
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
  providerSettings?: PersistedProviderSettings;
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
  retrySessionIds?: string[];
  preserveDbPath?: string | null;
  writerLeasePath?: string;
  writerLeaseWaitMs?: number;
  writerLeaseMode?: 'acquire' | 'caller-held';
}

interface SkippedFile {
  provider: string;
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
  complete: boolean;
  incompleteProviders: string[];
  inventoryIssues: ProviderInventoryIssue[];
  /** Most recently written transcripts (ADR-0009 hot-set seeding). */
  watchHints?: string[];
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
    complete: false,
    incompleteProviders: [],
    inventoryIssues: [],
    ...overrides,
    deferred: true,
    reason,
  };
}

function buildIndex({
  providerRoots = {},
  providerSettings,
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
  retrySessionIds = [],
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
      let priorSessions: ProviderSessionProvenance[] | undefined;
      if (preserveDbPath && path.resolve(preserveDbPath) !== path.resolve(dbPath)) {
        priorSessions = copyPreservedDataFromDb(db, preserveDbPath);
      }
      const defaultHome = os.homedir();
      const compatibilityHome = path.dirname(claudeDir);
      const relocatedDefaults = Object.fromEntries(
        createBuiltinProviderRegistry().catalog().flatMap((descriptor) => {
          if (descriptor.requiresExplicitRoot) return [];
          const relativeDefault = path.relative(defaultHome, descriptor.defaultRoot);
          const root = compatibilityHome !== defaultHome
            && relativeDefault
            && !relativeDefault.startsWith('..')
            && !path.isAbsolute(relativeDefault)
            ? path.join(compatibilityHome, relativeDefault)
            : descriptor.defaultRoot;
          return [[descriptor.id, root]];
        }),
      );
      const roots = {
        ...relocatedDefaults,
        claude: claudeDir,
        codex: codexDir,
        ...providerRoots,
      };
      const registry = providerRegistry
        ?? (providerSettings === undefined
          ? createBuiltinProviderRegistry(roots)
          : createConfiguredBuiltinProviderRuntime(providerSettings, { baseRoots: roots }).registry);
      const providerPlan = createProviderIndexPlan(db, registry, {
        force,
        changedPaths,
        priorSessions,
      });
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
      const discoveredSourceMtime = latestSourceMtime;
      const incompleteProviders = [...providerPlan.incompleteProviders].sort();
      const inventoryIssues = [...providerPlan.inventoryIssues];
      if (force && incompleteProviders.length > 0) {
        return {
          files: providerPlan.items.length,
          latestSourceMtime,
          affectedSessionIds: [],
          ftsRebuilt: false,
          skipped: 0,
          skippedFiles: [],
          deferred: false,
          complete: false,
          incompleteProviders,
          inventoryIssues,
          reason: 'incomplete_snapshot',
        };
      }

      const affectedSessionIds = new Set<string>();
      const finalizeAffectedSessionIds = new Set<string>();
      if (Array.isArray(changedPaths)) {
        for (const changedPath of changedPaths) {
          const sessionId = sessionIdFromChangedPath(projectsDir, changedPath);
          const normalizedChangedPath = normalizeChangedPath(projectsDir, changedPath);
          const isMetaChange = normalizedChangedPath?.toLowerCase().endsWith('.meta.json');
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
      let ftsRebuilt = false;
      const noteCommitted = ({ unit }, nextCursor) => {
        if (nextCursor) {
          latestSourceMtime = Math.max(
            latestSourceMtime,
            Number(nextCursor.split(':')[0]) || 0,
          );
        }
        if (unit.sessionId) affectedSessionIds.add(unit.sessionId);
        for (const sessionId of unit.retractSessionIds ?? []) affectedSessionIds.add(sessionId);
      };
      const finalize = (providerResult) => {
        const projectPathSessionIds = !force && Array.isArray(changedPaths)
          ? new Set([...retrySessionIds, ...affectedSessionIds, ...finalizeAffectedSessionIds])
          : null;
        refreshSessionProjectPaths(db, projectPathSessionIds);
        healWorkflowParentLinks(db);
        if (messageFtsTriggersDropped) installSchema(db, schemaPath);
        ftsRebuilt = ensureFtsReady(db, { force });
        writeIndexMarker(db, '__last_build__');
        if (providerResult.complete) writeIndexMarker(db, '__app_last_successful_build__');
        writeIndexMarker(db, '__indexer_owner_app__');
        writeProviderIndexMarkers(db, providerPlan, providerResult);
        if (latestSourceMtime) writeIndexMarker(db, '__last_source_mtime__', latestSourceMtime);
      };

      if (force) {
        try {
          runRetryableWriteTransaction(txDb, () => {
            latestSourceMtime = discoveredSourceMtime;
            affectedSessionIds.clear();
            skipped.splice(0);
            ftsRebuilt = false;
            dropMessageFtsTriggers(db);
            messageFtsTriggersDropped = true;
            // The provider contract reserves no key prefix. A force snapshot
            // recreates every unit cursor, provider marker, and system marker.
            db.prepare('DELETE FROM index_state').run();
            for (const table of ['messages', 'tool_calls', 'tool_results', 'sessions', 'summaries', 'subagents', 'workflows', 'workflow_agents']) {
              db.prepare(`DELETE FROM ${table}`).run();
            }
            const providerResult = indexProviderPlanStrict({
              db,
              plan: providerPlan,
              onCommitted: noteCommitted,
            });
            finalize(providerResult);
          }, { label: 'force-rebuild' });
        } catch (error) {
          if (isBeginBusyFailure(error)) {
            return deferredBuildResult('database_busy', {
              files: providerPlan.items.length,
              latestSourceMtime: discoveredSourceMtime,
              incompleteProviders,
              inventoryIssues,
            });
          }
          if (error instanceof ProviderIndexFailure) {
            skipped.push({
              provider: error.item.provider.name,
              path: error.item.unit.key,
              error: error.sourceError instanceof Error
                ? error.sourceError.message
                : String(error.sourceError),
              diagnostics: (error as { obelisk?: unknown }).obelisk,
            });
            console.warn(
              `Warning: failed to index ${error.item.provider.name} unit ${error.item.unit.key}: ${error.message}`,
            );
            return {
              files: providerPlan.items.length,
              latestSourceMtime: discoveredSourceMtime,
              affectedSessionIds: [],
              ftsRebuilt: false,
              skipped: skipped.length,
              skippedFiles: skipped,
              deferred: false,
              complete: false,
              incompleteProviders,
              inventoryIssues,
              reason: 'provider_failure',
            };
          }
          throw error;
        }
        for (const sessionId of finalizeAffectedSessionIds) affectedSessionIds.add(sessionId);
        return {
          files: providerPlan.items.length,
          latestSourceMtime,
          affectedSessionIds: [...affectedSessionIds],
          ftsRebuilt,
          skipped: 0,
          skippedFiles: [],
          deferred: false,
          complete: true,
          incompleteProviders,
          inventoryIssues,
          watchHints: readRecentTranscriptHints(db),
        };
      }

      const providerResult = indexProviderPlan({
        db,
        plan: providerPlan,
        runTransaction: (label, work) => runRetryableWriteTransaction(txDb, work, { label }),
        onCommitted: noteCommitted,
        onError: (error, { provider, unit }) => {
          if (isBeginBusyFailure(error)) return 'stop';
          if (hasUnusableTransaction(error)) throw error;
          skipped.push({
            provider: provider.name,
            path: unit.key,
            error: error instanceof Error ? error.message : String(error),
            diagnostics: (error as { obelisk?: unknown })?.obelisk,
          });
          console.warn(`Warning: failed to index ${provider.name} unit ${unit.key}: ${error instanceof Error ? error.message : String(error)}`);
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
          incompleteProviders,
          inventoryIssues,
        });
      }
      // Finalize is one transaction; a failure here fails the whole build.
      try {
        runRetryableWriteTransaction(txDb, () => finalize(providerResult), { label: 'finalize' });
      } catch (error) {
        if (isBeginBusyFailure(error)) {
          return deferredBuildResult('database_busy', {
            files: providerPlan.items.length,
            latestSourceMtime,
            affectedSessionIds: [...affectedSessionIds],
            skipped: skipped.length,
            skippedFiles: skipped,
            incompleteProviders,
            inventoryIssues,
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
        complete: providerResult.complete,
        incompleteProviders,
        inventoryIssues,
        watchHints: readRecentTranscriptHints(db),
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
