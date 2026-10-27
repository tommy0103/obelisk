// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// OpenCode provider adapter in Core (see docs/adr/0001, ADR-0006, ADR-0007).
//
// Pure: discovers OpenCode SQLite stores (V1 session/message/part and V2
// session[_v2]/session_message) and parses sessions into canonical records. It never
// writes source databases. SQLite opening is injected because Core runs under both
// node:sqlite (CLI) and better-sqlite3 (Electron).
//
// Source layout ($root = XDG_DATA_HOME || ~/.local/share/opencode by default, all platforms):
//   opencode.db          — standard authoritative store (WAL mode)
//   opencode-<channel>.db — channel-specific stores (e.g. opencode-next.db)
//
// Every mutation is handled by complete session snapshot replacement: when a
// unit's content fingerprint changed, retractSessionIds clears the old records and
// parse re-emits everything with countMode 'total'.
//
// Canonical tokens:
//   V2: input_tokens = input + cache.read + cache.write, output_tokens = output + reasoning
//   V1: step-finish per-step priority; assistant.tokens only when no step-finish occurred.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';

import { encodeCursor, decodeCursor, encodeStoreCursor, decodeStoreCursor, storePhysicalState, digest } from './opencode-manifest.ts';
import type { StoreObservation, StoreCursorState, PendingSession } from './opencode-manifest.ts';
import { RetryableSourceReadError } from './source-read-error.ts';
import { parseV1, parseV2, fingerprintSession } from './opencode-project.ts';
import { checkIsSubagent, sourceTables, readSessionEntry, observeSessions, observeSession, transcriptSchema } from './opencode-source.ts';
import type { SessionMessageRow, MessageRow, PartRow } from './opencode-source.ts';
import { isRecord, modernMessageData, legacyMessageData, legacyPartData, str, parseModelRef, completedCompaction } from './opencode-decode.ts';
export { parseModelRef } from './opencode-decode.ts';

import { decodeOpencodeUnitKey, opencodeSessionId, opencodeUnitKey, opencodeObservationKey, opencodeObservationProofKey } from './opencode-identity.ts';
export { opencodeStoreHash, opencodeSessionId, opencodeUnitKey } from './opencode-identity.ts';

import { normalizeObservedCwd, projectSlugFromPath } from '../parsing.ts';
import type { SqliteDb } from '../sqlite-types.ts';
import type {
  Cursor,
  DiscoverContext,
  IndexUnit,
  ProviderAdapter,
  RawLookup,
  RawRecord,
  TranscriptRecord,
  WatchTarget,
} from './types.ts';

export const name = 'opencode';
export const OPENCODE_CANONICAL_TRANSCRIPT_MARKER = '__opencode_canonical_transcript_v3__';

const TOMBSTONE_CURSOR = '0:0:v1:tombstone';

export type OpencodeDatabaseOpener = (dbPath: string) => SqliteDb;

export function defaultOpencodeDataRoot(homeDir = homedir()): string {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg !== undefined && xdg.trim().length > 0) {
    return join(xdg.trim(), 'opencode');
  }
  return join(homeDir, '.local', 'share', 'opencode');
}

export function resolveOpencodeRoot(
  rootDir: string | undefined,
  homeDir: string = homedir(),
): { rootDir: string; singleDbFile?: string } {
  if (rootDir !== undefined && rootDir.trim().length > 0) {
    const expanded = rootDir.startsWith('~/') || rootDir.startsWith('~\\')
      ? join(homeDir, rootDir.slice(2))
      : normalize(rootDir);
    return { rootDir: expanded };
  }
  const envDb = process.env.OPENCODE_DB;
  if (envDb !== undefined && envDb.trim().length > 0 && envDb.trim() !== ':memory:') {
    const trimmed = envDb.trim();
    const storePath = isAbsolute(trimmed)
      ? normalize(trimmed)
      : normalize(join(defaultOpencodeDataRoot(homeDir), trimmed));
    return { rootDir: dirname(storePath), singleDbFile: storePath };
  }
  return { rootDir: defaultOpencodeDataRoot(homeDir) };
}

function openSource(dbPath: string, opener: OpencodeDatabaseOpener): SqliteDb | null {
  try {
    return opener(dbPath);
  } catch {
    return null;
  }
}

export function isValidChannelDbName(filename: string): boolean {
  return /^opencode-[a-zA-Z0-9._-]+\.db$/.test(filename);
}

export function isValidChannelWalName(filename: string): boolean {
  return /^opencode-[a-zA-Z0-9._-]+\.db-wal$/.test(filename);
}

export function isOpencodeStoreOrWalFile(filename: string): boolean {
  return (
    filename === 'opencode.db'
    || filename === 'opencode.db-wal'
    || isValidChannelDbName(filename)
    || isValidChannelWalName(filename)
  );
}

function collectPriorStoresInDir(dir: string, ctx: DiscoverContext): string[] {
  const normDir = normalize(dir);
  const prefix = `${normDir}${sep}`;
  const indexedSessions = ctx.indexedSessions?.() ?? [];
  const stores = new Set<string>();
  for (const s of indexedSessions) {
    const identity = decodeOpencodeUnitKey(s.jsonlPath);
    if (identity !== null) {
      const store = identity.dbPath;
      if (store.startsWith(prefix) || store === join(normDir, 'opencode.db')) {
        stores.add(store);
      }
    }
  }
  return Array.from(stores);
}

function discoverDatabaseFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const paths: string[] = [];
    for (const entry of entries) {
      if (entry.isFile()) {
        if (entry.name === 'opencode.db' || isValidChannelDbName(entry.name)) {
          paths.push(join(dir, entry.name));
        }
      }
    }
    return paths.sort();
  } catch {
    return [];
  }
}

interface OpencodeSessionMeta {
  kind: 'opencode-session';
  format: 'v1' | 'v2';
  dbPath: string;
  rawSessionId: string;
  manifest: string;
  revision: number;
  store: StoreObservation;
  reason: 'changed-session' | 'source-replaced' | 'unexplained-write' | 'cursor-upgrade';
  reconcileFingerprint?: string;
}

interface OpencodeTombstoneMeta {
  kind: 'opencode-tombstone';
  store: StoreObservation;
  dbPath: string;
  rawSessionId: string;
}
interface OpencodeObservationMeta {
  kind: 'opencode-observation';
  dbPath: string;
  observation: StoreCursorState;
}
interface OpencodeObservationProofMeta {
  kind: 'opencode-observation-proof';
  dbPath: string;
  cursor: string;
}
type OpencodeUnitMeta = OpencodeSessionMeta | OpencodeTombstoneMeta | OpencodeObservationMeta | OpencodeObservationProofMeta;

function discoverAtStore(
  dbPath: string,
  ctx: DiscoverContext,
  opener: OpencodeDatabaseOpener,
): IndexUnit[] {
  const walPath = `${dbPath}-wal`;
  if (ctx.changedPaths !== undefined) {
    const normalized = normalize(dbPath);
    const touched = ctx.changedPaths.some((changed) => {
      const absolute = isAbsolute(changed) ? normalize(changed) : normalized;
      return absolute === normalized || absolute === normalize(walPath) || normalized.startsWith(absolute + sep);
    });
    if (!touched) return [];
  }

  let present: 'yes' | 'missing' | 'inaccessible';
  try {
    statSync(dbPath);
    present = 'yes';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    present = code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'inaccessible';
  }

  if (present === 'inaccessible') {
    ctx.reportIncompleteInventory?.({ path: dbPath, error: 'Source database is not accessible' });
    return [];
  }
  if (present === 'missing') {
    const prior = (ctx.indexedSessions?.() ?? []).some(s => s.jsonlPath.startsWith(`${normalize(dbPath)}#ses:`));
    if (prior) {
      ctx.reportIncompleteInventory?.({ path: dbPath, error: 'Source database is unavailable' });
    }
    return [];
  }

  const db = openSource(dbPath, opener);
  if (db === null) {
    ctx.reportIncompleteInventory?.({ path: dbPath, error: 'Session database is busy or unreadable' });
    return [];
  }

  try {
    sourceTables(db); // Initialize SQLite's read-only WAL coordination before sampling files.
    const physical = storePhysicalState(dbPath);
    db.exec('BEGIN');
    try {
      const tables = sourceTables(db);
      const schema = transcriptSchema(db);
      const store: StoreObservation = { ...physical, schema };
      const sessionsMap = observeSessions(db, tables);
      if (storePhysicalState(dbPath).stamp !== store.stamp) {
        throw new RetryableSourceReadError(dbPath, 'opencode: source changed during inventory');
      }

      const units: IndexUnit[] = [];
      const liveSessionIds = new Set<string>();
      const liveUnitKeys = new Set<string>();
      const indexedSessions = ctx.indexedSessions?.() ?? [];
      const indexedByKey = new Map<string, string[]>();
      for (const indexed of indexedSessions) {
        const ids = indexedByKey.get(indexed.jsonlPath) ?? [];
        ids.push(indexed.sessionId);
        indexedByKey.set(indexed.jsonlPath, ids);
      }

      // Depth-based sorting so parents process before children
      const depths = new Map<string, number>();
      const depth = (id: string, seen = new Set<string>()): number => {
        if (depths.has(id)) return depths.get(id)!;
        const parentId = sessionsMap.get(id)?.row.parent_id;
        if (!parentId || !sessionsMap.has(parentId) || seen.has(parentId)) return 0;
        seen.add(id);
        const value = depth(parentId, seen) + 1;
        depths.set(id, value);
        return value;
      };

      const sortedSessions = Array.from(sessionsMap.values()).sort(
        (a, b) => depth(a.row.id) - depth(b.row.id) || a.row.id.localeCompare(b.row.id),
      );

      const changedRawIds = new Set<string>();
      const states = new Map(sortedSessions.map(({ row }) => [row.id, decodeCursor(ctx.lastCursor(opencodeUnitKey(dbPath, row.id)))]));
      const observationKey = opencodeObservationKey(dbPath);
      const priorObservation = decodeStoreCursor(ctx.lastCursor(observationKey));
      const inventory = digest([...sessionsMap].map(([id, e]) => [id, e.manifest]).sort((a, b) => a[0]!.localeCompare(b[0]!)));
      const observationChanged = priorObservation === null || priorObservation.inventory !== inventory
        || JSON.stringify(priorObservation.store) !== JSON.stringify(store);
      // Missing/unknown observations cannot reset the ordering below successful
      // session cursors, or failed dependency work would look acknowledged.
      const revisionFloor = [...states.values()].reduce((max, state) => Math.max(max, state?.revision ?? 0), priorObservation?.revision ?? 0);
      const revision = revisionFloor + (observationChanged ? 1 : 0);
      if (!Number.isSafeInteger(revision)) throw new Error('opencode: observation revision exceeds safe cursor range');
      const unexplainedWrite = priorObservation !== null && priorObservation.inventory === inventory
        && priorObservation.store.identity === store.identity && priorObservation.store.schema === store.schema
        && priorObservation.store.stamp !== store.stamp;
      const pending = new Map<string, PendingSession>();
      for (const work of priorObservation?.pending ?? []) {
        if (sessionsMap.has(work.id) && (states.get(work.id)?.revision ?? 0) < work.revision) pending.set(work.id, work);
      }

      for (const entry of sortedSessions) {
        const session = entry.row;
        const sessionId = opencodeSessionId(session.id, dbPath);
        liveSessionIds.add(sessionId);
        const key = opencodeUnitKey(dbPath, session.id);
        liveUnitKeys.add(key);

        const replacedSessionIds = (indexedByKey.get(key) ?? []).filter(id => id !== sessionId);
        const isSubagent = entry.isSubagent;
        const state = states.get(session.id) ?? null;
        const replaced = state !== null && (state.store.identity !== store.identity || state.store.schema !== store.schema);
        const outstanding = pending.get(session.id);
        let changed = state === null || replacedSessionIds.length > 0 || replaced
          || state.manifest !== entry.manifest || outstanding?.mode === 'replay';
        let reconcile = !changed && (unexplainedWrite || outstanding?.mode === 'reconcile' || priorObservation === null);

        if (isSubagent && session.parent_id !== null && changedRawIds.has(session.parent_id)) {
          changed = true;
          reconcile = false;
        }
        if (!changed && !reconcile) continue;
        changedRawIds.add(session.id);
        pending.set(session.id, { id: session.id, revision, mode: reconcile ? 'reconcile' : 'replay' });
        units.push({
          key,
          sessionId,
          project: projectSlugFromPath(normalizeObservedCwd(session.directory)) ?? undefined,
          isSubagent,
          agentId: isSubagent ? sessionId : undefined,
          ...(reconcile ? {} : { retractSessionIds: [sessionId, ...replacedSessionIds] }),
          meta: {
            kind: 'opencode-session',
            format: entry.format,
            dbPath,
            rawSessionId: session.id,
            manifest: entry.manifest,
            revision,
            store,
            reason: state === null ? 'cursor-upgrade' : replaced ? 'source-replaced' : reconcile ? 'unexplained-write' : 'changed-session',
            ...(reconcile ? { reconcileFingerprint: state!.fingerprint } : {}),
          } satisfies OpencodeUnitMeta,
        });
      }

      // Tombstones for deleted sessions in this store
      for (const indexed of indexedSessions) {
        const identity = decodeOpencodeUnitKey(indexed.jsonlPath);
        if (identity === null || identity.dbPath !== normalize(dbPath)
          || opencodeSessionId(identity.nativeId, dbPath) !== indexed.sessionId) continue;
        if (liveSessionIds.has(indexed.sessionId)) continue;
        if (liveUnitKeys.has(indexed.jsonlPath)) continue;
        units.push({
          key: indexed.jsonlPath,
          sessionId: indexed.sessionId,
          retractSessionIds: [indexed.sessionId],
          meta: {
            kind: 'opencode-tombstone',
            store,
            dbPath,
            rawSessionId: identity.nativeId,
          } satisfies OpencodeUnitMeta,
        });
      }

      const observation: StoreCursorState = { store, inventory, revision, pending: [...pending.values()] };
      const observationCursor = encodeStoreCursor(observation);
      const needsObservation = observationChanged || units.length > 0;
      if (needsObservation) {
        // Compare the potentially large pending schedule exactly once. Every
        // session then checks a bounded proof, avoiding quadratic cursor bytes
        // on first import, rebuild and large reconciliation batches.
        const proofKey = opencodeObservationProofKey(dbPath);
        const proofCursor = `0:0:opencode-observation-proof-v1:${digest(observationCursor)}`;
        for (const unit of units) unit.requiresCursors = [{ key: proofKey, cursor: proofCursor }];
        units.unshift({ key: proofKey, sessionId: '',
          requiresCursors: [{ key: observationKey, cursor: observationCursor }],
          meta: { kind: 'opencode-observation-proof', dbPath, cursor: proofCursor } satisfies OpencodeObservationProofMeta,
        });
        units.unshift({ key: observationKey, sessionId: '', meta: {
          kind: 'opencode-observation', dbPath, observation,
        } satisfies OpencodeObservationMeta });
      }
      return units;
    } finally {
      db.exec('COMMIT');
    }
  } catch (error) {
    ctx.reportIncompleteInventory?.({
      path: dbPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  } finally {
    db.close();
  }
}

function discoverAll(
  resolvedRootDir: string | undefined,
  homeDir: string,
  ctx: DiscoverContext,
  opener: OpencodeDatabaseOpener,
): IndexUnit[] {
  // If explicit rootDir was configured, it takes priority over OPENCODE_DB
  if (resolvedRootDir !== undefined) {
    const dir = resolvedRootDir;
    let present: 'yes' | 'missing' | 'inaccessible';
    try {
      const st = statSync(dir);
      present = st.isDirectory() ? 'yes' : 'inaccessible';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      present = code === 'ENOENT' ? 'missing' : 'inaccessible';
    }

    if (present === 'inaccessible') {
      ctx.reportIncompleteInventory?.({ path: dir, error: 'Configured OpenCode directory is not accessible' });
      return [];
    }
    if (present === 'missing') {
      const prior = (ctx.indexedSessions?.() ?? []).some(s => s.jsonlPath.startsWith(`${normalize(dir)}${sep}`) || s.jsonlPath.startsWith(`${normalize(dir)}#ses:`));
      if (prior) {
        ctx.reportIncompleteInventory?.({ path: dir, error: 'Configured OpenCode directory is unavailable' });
      }
      return [];
    }

    const dbFiles = discoverDatabaseFiles(dir);
    const priorStores = collectPriorStoresInDir(dir, ctx);
    const allStores = Array.from(new Set([...dbFiles, ...priorStores])).sort();

    if (allStores.length === 0) {
      const prior = (ctx.indexedSessions?.() ?? []).some(s => s.jsonlPath.startsWith(`${normalize(dir)}${sep}`) || s.jsonlPath.startsWith(`${normalize(dir)}#ses:`));
      if (prior) {
        ctx.reportIncompleteInventory?.({ path: dir, error: 'Configured OpenCode directory contains no session databases' });
      }
      return [];
    }

    const units: IndexUnit[] = [];
    for (const dbPath of allStores) {
      units.push(...discoverAtStore(dbPath, ctx, opener));
    }
    return units;
  }

  // Automatic mode: check process.env.OPENCODE_DB
  const envDb = process.env.OPENCODE_DB;
  if (envDb !== undefined && envDb.trim().length > 0) {
    const trimmed = envDb.trim();
    if (trimmed === ':memory:') {
      ctx.reportIncompleteInventory?.({
        path: ':memory:',
        error: 'OpenCode in-memory database (:memory:) cannot be independently indexed',
      });
      return [];
    }
    const storePath = isAbsolute(trimmed)
      ? normalize(trimmed)
      : normalize(join(defaultOpencodeDataRoot(homeDir), trimmed));
    return discoverAtStore(storePath, ctx, opener);
  }

  // Default directory discovery
  const defaultDir = defaultOpencodeDataRoot(homeDir);
  if (!existsSync(defaultDir)) {
    const prior = (ctx.indexedSessions?.() ?? []).some(s => s.jsonlPath.startsWith(`${normalize(defaultDir)}${sep}`) || s.jsonlPath.startsWith(`${normalize(defaultDir)}#ses:`));
    if (prior) {
      ctx.reportIncompleteInventory?.({ path: defaultDir, error: 'OpenCode data directory is unavailable' });
    }
    return [];
  }

  const dbFiles = discoverDatabaseFiles(defaultDir);
  const priorStores = collectPriorStoresInDir(defaultDir, ctx);
  const allStores = Array.from(new Set([...dbFiles, ...priorStores])).sort();

  if (allStores.length === 0) {
    const prior = (ctx.indexedSessions?.() ?? []).some(s => s.jsonlPath.startsWith(`${normalize(defaultDir)}${sep}`) || s.jsonlPath.startsWith(`${normalize(defaultDir)}#ses:`));
    if (prior) {
      ctx.reportIncompleteInventory?.({ path: defaultDir, error: 'OpenCode data directory contains no session databases' });
    }
    return [];
  }

  const units: IndexUnit[] = [];
  for (const dbPath of allStores) {
    units.push(...discoverAtStore(dbPath, ctx, opener));
  }
  return units;
}

function* parse(
  unit: IndexUnit,
  _cursor: Cursor,
  opener: OpencodeDatabaseOpener,
): Generator<TranscriptRecord, Cursor> {
  const meta = unit.meta as OpencodeUnitMeta;
  if (!meta || (meta.kind !== 'opencode-session' && meta.kind !== 'opencode-tombstone' && meta.kind !== 'opencode-observation' && meta.kind !== 'opencode-observation-proof')) {
    throw new Error('opencode: invalid unit metadata');
  }

  if (meta.kind === 'opencode-observation-proof') {
    if (unit.sessionId !== '' || unit.key !== opencodeObservationProofKey(meta.dbPath)
      || !/^0:0:opencode-observation-proof-v1:[a-f0-9]{64}$/.test(meta.cursor)) {
      throw new Error('opencode: invalid observation proof');
    }
    return meta.cursor;
  }

  if (meta.kind === 'opencode-observation') {
    if (unit.key !== opencodeObservationKey(meta.dbPath) || unit.sessionId !== '') {
      throw new Error('opencode: invalid observation identity');
    }
    const db = openSource(meta.dbPath, opener);
    if (db === null) throw new RetryableSourceReadError(meta.dbPath, 'opencode: source database is busy or unreadable before observation commit');
    try {
      sourceTables(db);
      const physical = storePhysicalState(meta.dbPath);
      db.exec('BEGIN');
      try {
        const tables = sourceTables(db);
        const current = observeSessions(db, tables);
        const inventory = digest([...current].map(([id, e]) => [id, e.manifest]).sort((a, b) => a[0]!.localeCompare(b[0]!)));
        if (inventory !== meta.observation.inventory || transcriptSchema(db) !== meta.observation.store.schema
          || physical.identity !== meta.observation.store.identity || physical.stamp !== meta.observation.store.stamp
          || storePhysicalState(meta.dbPath).stamp !== physical.stamp) {
          throw new RetryableSourceReadError(meta.dbPath, 'opencode: source changed before observation commit');
        }
        return encodeStoreCursor(meta.observation);
      } finally { db.exec('COMMIT'); }
    } finally { db.close(); }
  }

  const identity = decodeOpencodeUnitKey(unit.key);
  if (identity === null || identity.dbPath !== normalize(meta.dbPath)
    || identity.nativeId !== meta.rawSessionId
    || opencodeSessionId(identity.nativeId, identity.dbPath) !== unit.sessionId) {
    throw new Error('opencode: unit identity does not match metadata');
  }

  if (meta.kind === 'opencode-tombstone') {
    // Tombstone verification
    const db = openSource(meta.dbPath, opener);
    if (db === null) {
      throw new RetryableSourceReadError(meta.dbPath, `opencode: session database is busy or unreadable during tombstone verification: ${meta.dbPath}`);
    }
    try {
      sourceTables(db);
      const tombstonePhysical = storePhysicalState(meta.dbPath);
      db.exec('BEGIN');
      const tables = sourceTables(db);
      if (tombstonePhysical.identity !== meta.store.identity
        || transcriptSchema(db) !== meta.store.schema) {
        throw new RetryableSourceReadError(meta.dbPath, 'opencode: source changed before tombstone verification');
      }
      if (!tables.has('session_v2') && !tables.has('session')) {
        throw new Error(`opencode: session database has no recognized transcript tables during tombstone verification: ${meta.dbPath}`);
      }
      const nativeId = meta.rawSessionId;
      let exists = false;
      if (tables.has('session_v2')) {
        exists = db.prepare('SELECT 1 FROM session_v2 WHERE id = ?').get(nativeId) !== undefined;
      }
      if (!exists && tables.has('session')) {
        exists = db.prepare('SELECT 1 FROM session WHERE id = ?').get(nativeId) !== undefined;
      }
      if (exists) {
        throw new RetryableSourceReadError(meta.dbPath, `opencode: session still present during tombstone parse: ${unit.sessionId}`);
      }
      if (storePhysicalState(meta.dbPath).stamp !== tombstonePhysical.stamp) {
        throw new RetryableSourceReadError(meta.dbPath, 'opencode: source changed during tombstone verification');
      }
      db.exec('COMMIT');
      return TOMBSTONE_CURSOR;
    } finally {
      db.close();
    }
  }

  const db = openSource(meta.dbPath, opener);
  if (db === null) {
    throw new RetryableSourceReadError(meta.dbPath, `opencode: session database is busy or unreadable: ${meta.dbPath}`);
  }

  try {
    sourceTables(db);
    const physical = storePhysicalState(meta.dbPath);
    db.exec('BEGIN');
    try {
      const tables = sourceTables(db);
      const entry = observeSession(db, tables, meta.rawSessionId);
      if (entry === undefined || entry.manifest !== meta.manifest
        || transcriptSchema(db) !== meta.store.schema || physical.identity !== meta.store.identity
        || physical.stamp !== meta.store.stamp) {
        throw new RetryableSourceReadError(meta.dbPath, `opencode: source changed before parse: ${meta.rawSessionId}`);
      }
      const generator = entry.format === 'v2'
        ? parseV2(unit, meta, db, entry.row) : parseV1(unit, meta, db, entry.row);
      const records: TranscriptRecord[] = [];
      let step = generator.next();
      while (!step.done) { records.push(step.value); step = generator.next(); }
      if (storePhysicalState(meta.dbPath).stamp !== meta.store.stamp) {
        throw new RetryableSourceReadError(meta.dbPath, `opencode: source changed during parse: ${meta.rawSessionId}`);
      }
      if (meta.reconcileFingerprint === undefined || meta.reconcileFingerprint !== step.value) {
        if (meta.reconcileFingerprint !== undefined) yield { kind: 'delete-session', sessionId: unit.sessionId };
        yield* records;
      }
      return encodeCursor(entry.row.time_updated ?? 0, {
        manifest: entry.manifest, revision: meta.revision, store: meta.store, fingerprint: step.value,
      });
    } finally {
      db.exec('COMMIT');
    }
  } finally {
    db.close();
  }
}

function raw(input: RawLookup, opener: OpencodeDatabaseOpener): RawRecord | null {
  if (input.source !== name || !input.messageUuid) return null;
  const jsonlPath = typeof input.session?.jsonl_path === 'string'
    ? input.session.jsonl_path
    : null;
  if (jsonlPath === null) return null;

  const identity = decodeOpencodeUnitKey(jsonlPath);
  if (identity === null) return null;
  const { dbPath, nativeId: rawSessionId } = identity;

  // Store & Session identity strict authentication
  const expectedSessionId = opencodeSessionId(rawSessionId, dbPath);
  const sessionId = typeof input.session?.id === 'string' ? input.session.id : '';
  if (sessionId !== expectedSessionId) {
    return null;
  }
  if (!input.messageUuid.startsWith(`${expectedSessionId}:`)) {
    return null;
  }

  const suffix = input.messageUuid.slice(expectedSessionId.length + 1);

  const db = openSource(dbPath, opener);
  if (db === null) return null;

  try {
    db.exec('BEGIN');
    try {
      const tables = sourceTables(db);
      const entry = readSessionEntry(db, tables, rawSessionId);
      if (entry === undefined) return null;
      const { row: sessionRow, format: sessionFormat } = entry;
      const isSubagent = checkIsSubagent(db, sessionRow.parent_id, tables);

      // Verify cursor if supplied
      if (input.cursor !== undefined && input.cursor !== null) {
        const state = decodeCursor(input.cursor);
        if (state === null) return null;
        let fingerprint: string;
        if (sessionFormat === 'v2') {
          const msgs = db.prepare(
            'SELECT id, session_id, type, seq, time_created, time_updated, data FROM session_message WHERE session_id = ? ORDER BY seq, time_created, id',
          ).all(rawSessionId) as unknown as SessionMessageRow[];
          fingerprint = fingerprintSession('v2', sessionRow, isSubagent, msgs);
        } else {
          const msgs = db.prepare(
            'SELECT id, session_id, time_created, time_updated, data FROM message WHERE session_id = ? ORDER BY time_created, id',
          ).all(rawSessionId) as unknown as MessageRow[];
          const parts = db.prepare(
            'SELECT id, message_id, session_id, time_created, time_updated, data FROM part WHERE session_id = ? ORDER BY id',
          ).all(rawSessionId) as unknown as PartRow[];
          fingerprint = fingerprintSession('v1', sessionRow, isSubagent, undefined, msgs, parts);
        }
        if (fingerprint !== state.fingerprint) return null;
      }

      let projection: Record<string, unknown> | null = null;
      let messageText: string | null = null;

      if (sessionFormat === 'v2' && tables.has('session_message')) {
        if (suffix.startsWith('summary:')) {
          const rawMsgId = decodeURIComponent(suffix.slice(8));
          const row = db.prepare(
            'SELECT id, session_id, type, seq, time_created, time_updated, data FROM session_message WHERE session_id = ? AND id = ?',
          ).get(rawSessionId, rawMsgId) as unknown as SessionMessageRow | undefined;
          if (!row || row.type !== 'compaction') return null;
          const parsedData = modernMessageData(row);
          if (completedCompaction(parsedData) === null) return null;
          projection = {
            format: 'v2',
            message: {
              id: row.id,
              session_id: row.session_id,
              type: row.type,
              seq: row.seq,
              time_created: row.time_created,
              time_updated: row.time_updated,
              data: parsedData,
            },
          };
          messageText = completedCompaction(parsedData);
        } else {
          // Format: m:(\d{6}):([^:]+)(:msg|:c:(\d{4}):(text|think|tool))
          const match = /^m:(\d{6}):([^:]+)(.*)$/.exec(suffix);
          if (!match) return null;
          const seq = Number(match[1]);
          const rawMsgId = decodeURIComponent(match[2]!);
          const rest = match[3]!;

          const row = db.prepare(
            'SELECT id, session_id, type, seq, time_created, time_updated, data FROM session_message WHERE session_id = ? AND id = ?',
          ).get(rawSessionId, rawMsgId) as unknown as SessionMessageRow | undefined;
          if (!row || row.seq !== seq) return null;

          const parsedData = modernMessageData(row);
          projection = {
            format: 'v2',
            message: {
              id: row.id,
              session_id: row.session_id,
              type: row.type,
              seq: row.seq,
              time_created: row.time_created,
              time_updated: row.time_updated,
              data: parsedData,
            },
          };

          if (rest === ':msg') {
            if (row.type === 'user') {
              messageText = str(parsedData.text);
            } else if (row.type === 'system' || row.type === 'synthetic') {
              messageText = str(parsedData.text);
            } else if (row.type === 'model-switched') {
              const toModel = parseModelRef(parsedData.model);
              const fromModel = parseModelRef(parsedData.previous);
              messageText = fromModel !== null && toModel !== null
                ? `model ${fromModel} → ${toModel}`
                : `model → ${toModel ?? fromModel ?? 'default'}`;
            } else if (row.type === 'agent-switched') {
              const toAgent = str(parsedData.agent);
              const fromAgent = str(parsedData.previous);
              messageText = fromAgent !== null && toAgent !== null
                ? `agent ${fromAgent} → ${toAgent}`
                : `agent → ${toAgent ?? fromAgent ?? 'default'}`;
            } else if (row.type === 'location-switched') {
              messageText = 'location switched';
            } else if (row.type === 'idle') {
              messageText = null;
            } else if (row.type === 'skill') {
              messageText = str(parsedData.instructions) ?? str(parsedData.text);
            } else if (row.type === 'assistant') {
              messageText = null;
            } else {
              messageText = str(parsedData.text) ?? null;
            }
          } else {
            const blockMatch = /^:c:(\d{4}):(text|think|tool)$/.exec(rest);
            if (!blockMatch) return null;
            if (row.type !== 'assistant') return null;
            const blockIdx = Number(blockMatch[1]);
            const blockKind = blockMatch[2]!;
            const content = Array.isArray(parsedData.content) ? parsedData.content : [];
            if (blockIdx < 0 || blockIdx >= content.length) return null;
            const block = content[blockIdx];
            if (!isRecord(block)) return null;

            if (blockKind === 'text') {
              if (block.type !== 'text') return null;
              messageText = str(block.text);
              if (messageText === null) return null;
            } else if (blockKind === 'think') {
              if (block.type !== 'reasoning') return null;
              messageText = str(block.text);
              if (messageText === null) return null;
            } else if (blockKind === 'tool') {
              if (block.type !== 'tool') return null;
              messageText = null;
            } else {
              return null;
            }
          }
        }
      } else if (sessionFormat === 'v1' && tables.has('message')) {
        // V1 suffix: m:(\d{6}):([^:]+)(:msg|:p:([^:]+):(text|think|tool|step))
        const match = /^m:(\d{6}):([^:]+)(.*)$/.exec(suffix);
        if (!match) return null;
        const ordinal = Number(match[1]);
        const rawMsgId = decodeURIComponent(match[2]!);
        const rest = match[3]!;

        const allV1Msgs = db.prepare(
          'SELECT id, session_id, time_created, time_updated, data FROM message WHERE session_id = ? ORDER BY time_created, id',
        ).all(rawSessionId) as unknown as MessageRow[];
        if (ordinal < 0 || ordinal >= allV1Msgs.length) return null;
        const mRow = allV1Msgs[ordinal]!;
        if (mRow.id !== rawMsgId) return null;

        const parts = db.prepare(
          'SELECT id, message_id, session_id, time_created, time_updated, data FROM part WHERE session_id = ? AND message_id = ? ORDER BY id',
        ).all(rawSessionId, rawMsgId) as unknown as PartRow[];

        const parsedMData = legacyMessageData(mRow);
        const parsedParts = parts.map(p => ({
          id: p.id,
          time_created: p.time_created,
          data: legacyPartData(p),
        }));

        projection = {
          format: 'v1',
          message: {
            id: mRow.id,
            session_id: mRow.session_id,
            time_created: mRow.time_created,
            time_updated: mRow.time_updated,
            data: parsedMData,
          },
          parts: parsedParts,
        };

        if (rest === ':msg') {
          if (parsedMData.role === 'user') {
            const textParts = parsedParts
              .filter(p => p.data.type === 'text' && typeof p.data.text === 'string')
              .map(p => p.data.text as string);
            messageText = textParts.length > 0 ? textParts.join('\n') : str(parsedMData.text);
          } else {
            messageText = null;
          }
        } else {
          const partMatch = /^:p:([^:]+):(text|think|tool|step)$/.exec(rest);
          if (!partMatch) return null;
          const targetPartId = decodeURIComponent(partMatch[1]!);
          const partKind = partMatch[2]!;
          const targetPart = parsedParts.find(p => p.id === targetPartId);
          if (!targetPart) return null;

          if (partKind === 'text') {
            if (targetPart.data.type !== 'text') return null;
            messageText = str(targetPart.data.text);
            if (messageText === null) return null;
          } else if (partKind === 'think') {
            if (targetPart.data.type !== 'reasoning') return null;
            messageText = str(targetPart.data.text);
            if (messageText === null) return null;
          } else if (partKind === 'tool') {
            if (targetPart.data.type !== 'tool') return null;
            messageText = null;
          } else if (partKind === 'step') {
            if (targetPart.data.type !== 'step-finish') return null;
            messageText = null;
          } else {
            return null;
          }
        }
      }

      if (projection === null) return null;

      const text = JSON.stringify(projection, null, 1);
      return {
        text,
        totalLength: text.length,
        hasMore: false,
        messageText: messageText || null,
      };
    } finally {
      db.exec('COMMIT');
    }
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export function createOpencodeProvider({
  rootDir,
  homeDir = homedir(),
  openDatabase,
}: {
  rootDir?: string;
  homeDir?: string;
  openDatabase?: OpencodeDatabaseOpener;
} = {}): ProviderAdapter {
  const fallbackOpener: OpencodeDatabaseOpener = () => {
    throw new Error('No OpencodeDatabaseOpener injected');
  };
  const opener = openDatabase ?? fallbackOpener;

  const defaultDir = defaultOpencodeDataRoot(homeDir);
  const resolvedRoot = rootDir !== undefined && rootDir.trim().length > 0
    ? (rootDir.startsWith('~/') || rootDir.startsWith('~\\')
      ? join(homeDir, rootDir.slice(2))
      : normalize(rootDir))
    : undefined;

  return {
    name,
    descriptor: {
      id: name,
      name: 'OpenCode',
      vendor: 'Anomaly',
      defaultRoot: resolvedRoot ?? defaultDir,
      color: '#0ea5e9',
    },
    indexVersionMarker: OPENCODE_CANONICAL_TRANSCRIPT_MARKER,
    sessionUnitKey: (session) => session.jsonlPath,
    watchHints: (unitKey) => {
      const identity = decodeOpencodeUnitKey(unitKey);
      if (identity === null) return [];
      const store = identity.dbPath;
      if (resolvedRoot === undefined && process.env.OPENCODE_DB?.trim() === ':memory:') return [];
      const scope = resolveOpencodeRoot(resolvedRoot, homeDir);
      if (scope.singleDbFile !== undefined
        ? normalize(store) !== normalize(scope.singleDbFile)
        : normalize(dirname(store)) !== normalize(scope.rootDir)) return [];
      return [store, `${store}-wal`];
    },
    discover: (ctx: DiscoverContext) => discoverAll(resolvedRoot, homeDir, ctx, opener),
    parse: (unit, cursor) => parse(unit, cursor, opener),
    watchTargets: (configuredRoot: string): WatchTarget[] => {
      const isDefault = resolvedRoot === undefined && (!configuredRoot || configuredRoot.trim().length === 0 || normalize(configuredRoot) === normalize(defaultDir));
      if (isDefault) {
        const envDb = process.env.OPENCODE_DB;
        if (envDb !== undefined && envDb.trim().length > 0 && envDb.trim() !== ':memory:') {
          const trimmed = envDb.trim();
          const storePath = isAbsolute(trimmed)
            ? normalize(trimmed)
            : normalize(join(defaultDir, trimmed));
          return [
            { kind: 'file', path: storePath },
            { kind: 'file', path: `${storePath}-wal` },
          ];
        }
      }
      const root = !isDefault ? normalize(configuredRoot) : defaultDir;
      const treeTarget: WatchTarget = {
        kind: 'tree',
        path: root,
        fileNames: ['opencode-next.db', 'opencode-next.db-wal', 'opencode.db', 'opencode.db-wal'],
      };
      Object.defineProperty(treeTarget, 'matches', {
        value: isOpencodeStoreOrWalFile,
        enumerable: false,
        writable: true,
        configurable: true,
      });
      return [
        { kind: 'file', path: join(root, 'opencode.db') },
        { kind: 'file', path: join(root, 'opencode.db-wal') },
        treeTarget,
      ];
    },
    raw: (input) => raw(input, opener),
  };
}
