// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { readdirSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

import { RetryableSourceReadError } from './providers/source-read-error.ts';
import { persist } from './persist.ts';
import type { ProviderRegistry } from './providers/registry.ts';
import type {
  Cursor,
  IndexedSession,
  IndexUnit,
  InventoryIssue,
  ProviderAdapter,
} from './providers/types.ts';
import type { SqliteDb } from './sqlite-types.ts';

export interface ProviderSessionProvenance extends IndexedSession {
  readonly source: string;
}

export interface StoredProviderState {
  readonly mtime: number;
  readonly linesProcessed: number;
  readonly cursor: Cursor;
  readonly replayRequired: boolean;
}

export interface RetainedSession {
  readonly source: string;
  readonly sessionId: string;
  readonly unitKey: string;
  readonly checkpoint?: StoredProviderState;
}

export interface ProviderIndexItem {
  readonly provider: ProviderAdapter;
  readonly unit: IndexUnit;
  readonly cursor: Cursor;
}

export interface ProviderInventoryIssue extends InventoryIssue {
  readonly provider: string;
}

export type ProviderReadMode = 'normal' | 'strict';

export interface ProviderIndexPlan {
  readonly items: ProviderIndexItem[];
  readonly retainedSessions: readonly RetainedSession[];
  readonly pendingMarkers: ReadonlyMap<string, string>;
  readonly replayKeys: ReadonlyMap<string, readonly string[]>;
  readonly incompleteProviders: ReadonlySet<string>;
  readonly inventoryIssues: readonly ProviderInventoryIssue[];
  /**
   * Known artifacts the adapter version cannot project. These describe content,
   * not inventory: they never withhold a provider marker or a force publish.
   */
  readonly skippedArtifacts: readonly ProviderInventoryIssue[];
}

export interface ProviderIndexResult {
  readonly committed: ProviderIndexItem[];
  readonly failedProviders: ReadonlySet<string>;
  readonly failedItems: ProviderIndexItem[];
  readonly complete: boolean;
  readonly stopped?: { item: ProviderIndexItem; error: unknown };
}

export class ProviderIndexFailure extends Error {
  readonly item: ProviderIndexItem;
  readonly sourceError: unknown;

  constructor(error: unknown, item: ProviderIndexItem) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
    this.item = item;
    this.sourceError = error;
  }
}

// Hot-file seeding for the adaptive watcher (ADR-0009): after a build, the
// most recently written transcripts are the best guess for what is still
// being appended through long-lived descriptors. index_state.mtime holds the
// source file mtime per unit; marker rows carry `__` prefixes and are not
// transcripts. Keep the limit in sync with the watcher's DEFAULT_MAX_HOT_FILES.
//
// Unit keys are not always files: Kimi's key is the session directory, whose
// mtime does not track appends to the wire files inside. Directory keys are
// expanded to the transcripts they contain (bounded, mtime-ranked); missing
// keys are dropped. Both run in the indexer worker, never on the Electron
// main thread. The authoritative wire-layout knowledge lives in the Kimi
// provider (kimi.ts sessionDirectoryFromWirePath and its discover walk) —
// this generic expansion deliberately relies on file mtime instead of
// duplicating that layout logic; if the Kimi wire layout changes, revisit
// both.
const WATCH_HINT_LIMIT = 64;
const HINT_DIRECTORY_FILE_LIMIT = 4;
// Candidates collected before ranking by mtime — a Kimi session dir holds
// several wire files (main + agents), and readdir order says nothing about
// which one is actively appended.
const HINT_DIRECTORY_CANDIDATE_LIMIT = 16;

function expandHintDirectory(dir: string): string[] {
  const candidates: string[] = [];
  const walk = (current: string, depth: number) => {
    if (candidates.length >= HINT_DIRECTORY_CANDIDATE_LIMIT || depth > 4) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (candidates.length >= HINT_DIRECTORY_CANDIDATE_LIMIT) return;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.endsWith('.jsonl')) candidates.push(full);
    }
  };
  walk(dir, 0);
  // Rank by file mtime: the actively appended wire (the main one in
  // practice) is the most recently written, while a plain readdir/DFS order
  // would systematically pick stale agent wires first.
  return candidates
    .map((file) => {
      try {
        return { file, mtimeMs: statSync(file).mtimeMs };
      } catch {
        return { file, mtimeMs: 0 };
      }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, HINT_DIRECTORY_FILE_LIMIT)
    .map(({ file }) => file);
}

export function readRecentTranscriptHints(db: SqliteDb, limit = WATCH_HINT_LIMIT, registry?: ProviderRegistry): string[] {
  const statement = db.prepare(
    "SELECT jsonl_path FROM index_state WHERE jsonl_path NOT LIKE '\\_\\_%' ESCAPE '\\' ORDER BY mtime DESC",
  );
  // Many session units may expand to one store. Budget after expansion rather
  // than truncating the unit census and starving the next channel. Both runtime
  // bindings stream; all() keeps existing minimal test doubles compatible.
  const rows = statement.iterate ? statement.iterate() : statement.all();
  const hints: string[] = [];
  const seen = new Set<string>();
  const add = (file: string) => {
    if (hints.length >= limit || seen.has(file)) return;
    seen.add(file);
    hints.push(file);
  };
  const adapters = registry?.list() ?? [];
  for (const row of rows) {
    if (hints.length >= limit) break;
    const key = String(row.jsonl_path);
    const providerFiles = adapters.flatMap(provider => provider.watchHints?.(key) ?? []);
    if (providerFiles.length > 0) {
      // An adapter may include a currently absent WAL: polling must also see
      // its creation when the writer resumes without a native notification.
      for (const file of providerFiles) add(file);
      continue;
    }
    let isDirectory: boolean;
    try {
      isDirectory = statSync(key).isDirectory();
    } catch {
      continue; // deleted between build and hint collection
    }
    if (!isDirectory) {
      add(key);
      continue;
    }
    for (const file of expandHintDirectory(key)) {
      if (hints.length >= limit) break;
      add(file);
    }
  }
  return hints;
}

function storedState(row: Record<string, unknown>): StoredProviderState {
  return {
    mtime: Number(row.mtime),
    linesProcessed: Number(row.lines_processed),
    cursor: typeof row.cursor === 'string' ? row.cursor : null,
    replayRequired: row.replay_required === 1,
  };
}

export function readProviderIndexState(db: SqliteDb, schema: 'main' | 'previous_obelisk' = 'main'): ReadonlyMap<string, StoredProviderState> {
  if (!db.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type='table' AND name='index_state'`).get()) return new Map();
  return new Map(db.prepare(`SELECT * FROM ${schema}.index_state`).all()
    .map(row => [String(row.jsonl_path), storedState(row)]));
}

function checkpointCursor(state: StoredProviderState | undefined): Cursor {
  if (state === undefined) return null;
  return state.cursor ?? `${state.mtime}:${state.linesProcessed}`;
}

function storedCheckpoint(db: SqliteDb, key: string): StoredProviderState | undefined {
  const row = db.prepare('SELECT * FROM index_state WHERE jsonl_path = ?').get(key);
  return row === undefined ? undefined : storedState(row);
}

export function storedProviderCursor(db: SqliteDb, key: string): Cursor {
  const state = storedCheckpoint(db, key);
  return state?.replayRequired ? null : checkpointCursor(state);
}

export function providerSessionUnitKey(
  provider: ProviderAdapter | undefined,
  session: IndexedSession,
): string {
  return provider?.sessionUnitKey?.(session) ?? session.jsonlPath;
}

export function storedSessionCursor(
  db: SqliteDb,
  registry: ProviderRegistry,
  session: Record<string, unknown> | null,
): Cursor {
  if (typeof session?.jsonl_path !== 'string') return null;
  const source = typeof session.source === 'string' ? session.source : 'claude';
  const unitKey = providerSessionUnitKey(registry.get(source), {
    sessionId: typeof session.id === 'string' ? session.id : '',
    jsonlPath: session.jsonl_path,
  });
  return storedProviderCursor(db, unitKey);
}

export function readProviderSessionProvenance(db: SqliteDb, schema: 'main' | 'previous_obelisk' = 'main'): ProviderSessionProvenance[] {
  const members = new Map<string, string[]>();
  if (db.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type='table' AND name='subagents'`).get()) {
    for (const row of db.prepare(`SELECT session_id, agent_id FROM ${schema}.subagents`).all()) {
      if (typeof row.session_id !== 'string' || typeof row.agent_id !== 'string') continue;
      const ids = members.get(row.session_id) ?? [];
      ids.push(row.agent_id);
      members.set(row.session_id, ids);
    }
  }
  const hasSource = db.prepare(`PRAGMA ${schema}.table_info(sessions)`).all().some(column => column.name === 'source');
  return db.prepare(`
    SELECT id, jsonl_path, ${hasSource ? "COALESCE(source, 'claude')" : "'claude'"} AS source
    FROM ${schema}.sessions
    WHERE jsonl_path IS NOT NULL
      AND jsonl_path != ''
  `).all().map((row) => ({
    source: String(row.source),
    sessionId: String(row.id),
    jsonlPath: String(row.jsonl_path),
    memberSessionIds: members.get(String(row.id)) ?? [],
  }));
}

export function createProviderIndexPlan(
  db: SqliteDb,
  registry: ProviderRegistry,
  {
    force = false,
    changedPaths,
    priorSessions,
    priorIndexState,
    readMode = 'normal',
  }: {
    force?: boolean;
    changedPaths?: string[];
    priorSessions?: readonly ProviderSessionProvenance[];
    priorIndexState?: ReadonlyMap<string, StoredProviderState>;
    readMode?: ProviderReadMode;
  } = {},
): ProviderIndexPlan {
  const items: ProviderIndexItem[] = [];
  const retainedSessions: RetainedSession[] = [];
  const pendingMarkers = new Map<string, string>();
  const replayKeys = new Map<string, readonly string[]>();
  const incompleteProviders = new Set<string>();
  const inventoryIssues: ProviderInventoryIssue[] = [];
  const skippedArtifacts: ProviderInventoryIssue[] = [];
  const provenance = priorSessions ?? readProviderSessionProvenance(db);
  for (const provider of registry.list()) {
    const indexedSessions = provenance
      .filter((session) => session.source === provider.name)
      .map(({ sessionId, jsonlPath, memberSessionIds }) => ({ sessionId, jsonlPath, memberSessionIds }));
    const marker = provider.indexVersionMarker;
    const markerMissing = marker !== undefined && !db.prepare(
      'SELECT jsonl_path FROM index_state WHERE jsonl_path = ?',
    ).get(marker);
    const fullReindex = force || (markerMissing && indexedSessions.length > 0);
    if (markerMissing && indexedSessions.length > 0) {
      replayKeys.set(provider.name, [
        ...new Set(indexedSessions.map((session) => providerSessionUnitKey(provider, session))),
      ]);
    }
    let inventoryComplete = true;
    let reportedIssue: InventoryIssue | undefined;
    const retainedIds = new Set<string>();
    const previousState = (key: string) => priorIndexState?.get(key) ?? storedCheckpoint(db, key);
    const units = provider.discover({
      snapshotRequired: fullReindex,
      previousCursor: key => checkpointCursor(previousState(key)),
      retainSession: id => retainedIds.add(id),
      lastCursor: fullReindex ? () => null : (key) => storedProviderCursor(db, key),
      changedPaths: fullReindex ? undefined : changedPaths,
      indexedSessions: () => indexedSessions,
      reportIncompleteInventory: (issue) => {
        inventoryComplete = false;
        reportedIssue ??= issue;
      },
      reportSkippedArtifact: (issue) => {
        if (issue === undefined) return;
        skippedArtifacts.push({ ...issue, provider: provider.name });
      },
    });
    const retainedGroups = new Set(units.filter(unit => unit.atomicGroup !== undefined
      && (retainedIds.has(unit.sessionId) || unit.retractSessionIds?.some(id => retainedIds.has(id))))
      .map(unit => unit.atomicGroup!));
    for (const unit of units) {
      if (unit.atomicGroup === undefined || !retainedGroups.has(unit.atomicGroup)) continue;
      retainedIds.add(unit.sessionId);
      for (const id of unit.retractSessionIds ?? []) retainedIds.add(id);
    }
    for (const session of indexedSessions) {
      if (!retainedIds.has(session.sessionId)) continue;
      const unitKey = providerSessionUnitKey(provider, session);
      retainedSessions.push({ source: provider.name, sessionId: session.sessionId, unitKey, checkpoint: previousState(unitKey) });
    }
    if (!inventoryComplete) {
      incompleteProviders.add(provider.name);
      inventoryIssues.push({
        provider: provider.name,
        ...(reportedIssue ?? {
          path: provider.descriptor.defaultRoot,
          error: 'Source inventory is incomplete',
        }),
      });
    }
    if (
      marker !== undefined
      && (force || markerMissing)
      && (inventoryComplete || indexedSessions.length > 0)
    ) {
      pendingMarkers.set(provider.name, marker);
    }
    for (const unit of units) {
      // A retain decision protects the complete canonical session, including
      // against a provider accidentally emitting a replacement or tombstone.
      if (retainedIds.has(unit.sessionId) || unit.retractSessionIds?.some(id => retainedIds.has(id))) continue;
      items.push({
        provider,
        unit: readMode === 'normal'
          ? unit
          : {
            ...unit,
            meta: {
              ...(unit.meta && typeof unit.meta === 'object' ? unit.meta : {}),
              readMode,
            },
          },
        cursor: fullReindex ? null : storedProviderCursor(db, unit.key),
      });
    }
  }
  return { items, retainedSessions, pendingMarkers, replayKeys, incompleteProviders, inventoryIssues, skippedArtifacts };
}

export function indexProviderPlan({
  db,
  plan,
  runTransaction,
  onPersisted = () => {},
  onCommitted = () => {},
  onError,
}: {
  db: SqliteDb;
  plan: ProviderIndexPlan;
  runTransaction: <T>(label: string, work: () => T) => T;
  /** Runs after persist but inside the same transaction, before its commit. */
  onPersisted?: (item: ProviderIndexItem, cursor: Cursor) => void;
  onCommitted?: (item: ProviderIndexItem, cursor: Cursor) => void;
  onError: (error: unknown, item: ProviderIndexItem) => 'skip' | 'stop';
}): ProviderIndexResult {
  const committed: ProviderIndexItem[] = [];
  const failedProviders = new Set<string>();
  const failedItems: ProviderIndexItem[] = [];
  let replayScheduleCommitted = plan.pendingMarkers.size === 0 && plan.replayKeys.size === 0;
  const batches: ProviderIndexItem[][] = [];
  const grouped = new Map<string, ProviderIndexItem[]>();
  for (const item of plan.items) {
    if (item.unit.atomicGroup === undefined) { batches.push([item]); continue; }
    const key = `${item.provider.name}\0${item.unit.atomicGroup}`;
    let batch = grouped.get(key);
    if (batch === undefined) { batch = []; grouped.set(key, batch); batches.push(batch); }
    batch.push(item);
  }
  for (const batch of batches) {
    const hasTranscript = batch.some(item => item.unit.sessionId !== '');
    let active = batch[0]!;
    let cursors: Cursor[];
    try {
      cursors = runTransaction(`provider:${active.provider.name}:${active.unit.atomicGroup ?? active.unit.key}`, () => {
        // Replay scheduling and every unit in this publication set roll back
        // together. A BUSY retry runs the entire set again.
        if (!replayScheduleCommitted && hasTranscript) {
          const scheduleReplay = db.prepare('UPDATE index_state SET replay_required = 1 WHERE jsonl_path = ?');
          const keysToReplay = new Set(
            plan.items
              .filter(({ provider, unit }) => unit.sessionId !== '' && plan.pendingMarkers.has(provider.name))
              .map(({ unit }) => unit.key),
          );
          for (const keys of plan.replayKeys.values()) {
            for (const key of keys) keysToReplay.add(key);
          }
          for (const key of keysToReplay) scheduleReplay.run(key);
          writePendingMarkers(db, plan);
        }
        return batch.map(item => {
          active = item;
          for (const required of item.unit.requiresCursors ?? []) {
            if (storedProviderCursor(db, required.key) !== required.cursor) {
              throw new RetryableSourceReadError(item.unit.key, `Source observation prerequisite was not committed: ${required.key}`);
            }
          }
          const nextCursor = persist(db, item.unit, item.provider.parse(item.unit, item.cursor));
          onPersisted(item, nextCursor);
          return nextCursor;
        });
      });
    } catch (error) {
      for (const item of batch) {
        failedProviders.add(item.provider.name);
        failedItems.push(item);
      }
      if (onError(error, active) === 'stop') {
        return { committed, failedProviders, failedItems, complete: false, stopped: { item: active, error } };
      }
      continue;
    }
    if (hasTranscript) replayScheduleCommitted = true;
    for (const [index, item] of batch.entries()) {
      committed.push(item);
      onCommitted(item, cursors[index]!);
    }
  }
  return {
    committed,
    failedProviders,
    failedItems,
    complete: failedItems.length === 0 && plan.incompleteProviders.size === 0,
  };
}

/** Index every planned unit inside a caller-owned transaction, failing as one snapshot. */
export function indexProviderPlanStrict({
  db,
  plan,
  onPersisted = () => {},
  onCommitted = () => {},
}: {
  db: SqliteDb;
  plan: ProviderIndexPlan;
  onPersisted?: (item: ProviderIndexItem, cursor: Cursor) => void;
  onCommitted?: (item: ProviderIndexItem, cursor: Cursor) => void;
}): ProviderIndexResult {
  return indexProviderPlan({
    db,
    plan,
    runTransaction: (_label, work) => work(),
    onPersisted,
    onCommitted,
    onError: (error, item) => {
      throw new ProviderIndexFailure(error, item);
    },
  });
}

/** Write every pending version marker, so the first-unit transaction and finalize share one marker row shape. */
function writePendingMarkers(db: SqliteDb, plan: ProviderIndexPlan): void {
  const write = db.prepare(
    'INSERT OR REPLACE INTO index_state (jsonl_path, mtime, lines_processed) VALUES (?, ?, 0)',
  );
  const now = Date.now();
  for (const marker of plan.pendingMarkers.values()) write.run(marker, now);
}

export function writeProviderIndexMarkers(
  db: SqliteDb,
  plan: ProviderIndexPlan,
  result: ProviderIndexResult,
): void {
  if (result.stopped !== undefined) return;
  const retry = db.prepare('UPDATE index_state SET replay_required = 1 WHERE jsonl_path = ?');
  for (const session of plan.retainedSessions) retry.run(session.unitKey);
  const committed = new Set(result.committed.map(
    (item) => `${item.provider.name}\0${item.unit.key}`,
  ));
  // A marker records that replay was scheduled. Per-unit cursors record which
  // known sources completed it, so an incomplete inventory retries only the
  // missing or failed sources instead of every readable sibling.
  for (const [provider, keys] of plan.replayKeys) {
    for (const key of keys) {
      if (!committed.has(`${provider}\0${key}`)) retry.run(key);
    }
  }
  for (const item of result.failedItems) {
    if (plan.pendingMarkers.has(item.provider.name) || item.unit.atomicGroup !== undefined) retry.run(item.unit.key);
  }
  writePendingMarkers(db, plan);
}
