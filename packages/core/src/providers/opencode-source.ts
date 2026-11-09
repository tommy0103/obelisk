// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { digest } from './opencode-manifest.ts';
import type { SqliteDb } from '../sqlite-types.ts';

export interface SessionRow {
  id: string;
  project_id: string | null;
  parent_id: string | null;
  directory: string | null;
  title: string | null;
  version: string | null;
  revert: string | null;
  cost: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_reasoning: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  time_created: number | null;
  time_updated: number | null;
  time_archived: number | null;
  agent: string | null;
  model: string | null;
}

export interface SessionMessageRow {
  id: string;
  session_id: string;
  type: string;
  seq: number;
  time_created: number;
  time_updated: number;
  data: string;
}

export interface MessageRow {
  id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
}

export interface PartRow {
  id: string;
  message_id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
}

export function checkIsSubagent(db: SqliteDb, parentId: string | null, tables: ReadonlySet<string>): boolean {
  if (parentId === null || parentId.length === 0) return false;
  return (['session_v2', 'session'] as const).some(table => tables.has(table)
    && db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(parentId) !== undefined);
}

export function sourceTables(db: SqliteDb): Set<string> {
  try {
    return new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: unknown }>)
        .map(r => String(r.name)),
    );
  } catch (cause) {
    throw new Error(`opencode: unable to read transcript tables: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

export interface DiscoveredSessionEntry {
  format: 'v1' | 'v2';
  row: SessionRow;
}

type SessionTable = 'session_v2' | 'session';

export function sessionSelect(table: SessionTable): string {
  // Metadata tables and wire formats have separate lifecycles: before the V2
  // split (v1.19.3), modern session_message rows also belonged to `session`.
  return `SELECT id, project_id, parent_id, directory, title, version, revert, cost,
    tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
    time_created, time_updated, time_archived, agent, model FROM ${table}`;
}

export function sessionFormat(
  db: SqliteDb,
  tables: ReadonlySet<string>,
  table: SessionTable,
  id: string,
): 'v1' | 'v2' {
  const modern = tables.has('session_message');
  const legacy = tables.has('message') && tables.has('part');
  if (modern && (table === 'session_v2' || !legacy || db.prepare('SELECT 1 FROM session_message WHERE session_id = ? LIMIT 1').get(id) !== undefined)) {
    return 'v2';
  }
  if (table === 'session' && legacy) return 'v1';
  throw new Error(`opencode: no recognized message tables for ${table} session ${id}`);
}

export function readSessionEntry(db: SqliteDb, tables: ReadonlySet<string>, id: string): DiscoveredSessionEntry | undefined {
  for (const table of ['session_v2', 'session'] as const) {
    if (!tables.has(table)) continue;
    const row = db.prepare(`${sessionSelect(table)} WHERE id = ?`).get(id) as unknown as SessionRow | undefined;
    if (row !== undefined) return { row, format: sessionFormat(db, tables, table, id) };
  }
  return undefined;
}


export interface ObservedSession extends DiscoveredSessionEntry {
  isSubagent: boolean;
  manifest: string;
}

/** Relevant schema only: account/auth changes are not transcript migrations. */
export function transcriptSchema(db: SqliteDb): string {
  return digest(db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE tbl_name IN ('session', 'session_v2', 'session_message', 'message', 'part', 'event_sequence')
    ORDER BY type, name`).all());
}

interface AggregateHead { aggregate_id: string; seq: number; owner_id: string | null }

function observeEntry(
  db: SqliteDb,
  tables: ReadonlySet<string>,
  entry: DiscoveredSessionEntry,
  isSubagent: boolean,
  head: AggregateHead | undefined,
): ObservedSession {
  // Only these pinned writers have a checked atomic head/projector contract.
  // Other versions still work through metadata + unexplained-write reconciliation.
  const eventOwned = entry.format === 'v2' && head !== undefined
    && (entry.row.version === '1.19.3' || entry.row.version === '2.0.32');
  let members: unknown = null;
  if (entry.format === 'v1') {
    members = [
      db.prepare('SELECT id, session_id, time_created, time_updated FROM message WHERE session_id = ? ORDER BY id').all(entry.row.id),
      db.prepare('SELECT id, session_id, message_id, time_created, time_updated FROM part WHERE session_id = ? ORDER BY id').all(entry.row.id),
    ];
  } else if (!eventOwned) {
    members = db.prepare('SELECT id, session_id, type, seq, time_created, time_updated FROM session_message WHERE session_id = ? ORDER BY id').all(entry.row.id);
  }
  return { ...entry, isSubagent, manifest: digest([entry.format, entry.row, isSubagent, head ?? null, members]) };
}

export function observeSessions(db: SqliteDb, tables: ReadonlySet<string>): Map<string, ObservedSession> {
  if ((!tables.has('session_v2') && !tables.has('session'))
    || (!tables.has('session_message') && !(tables.has('message') && tables.has('part')))) {
    throw new Error('Session database has no recognized transcript tables');
  }
  const entries = new Map<string, DiscoveredSessionEntry>();
  for (const table of ['session_v2', 'session'] as const) {
    if (!tables.has(table)) continue;
    for (const row of db.prepare(sessionSelect(table)).all() as unknown as SessionRow[]) {
      if (!entries.has(row.id)) entries.set(row.id, { row, format: sessionFormat(db, tables, table, row.id) });
    }
  }
  const heads = new Map<string, AggregateHead>();
  if (tables.has('event_sequence')) {
    for (const head of db.prepare('SELECT aggregate_id, seq, owner_id FROM event_sequence').all() as unknown as AggregateHead[]) {
      heads.set(head.aggregate_id, head);
    }
  }
  return new Map([...entries].map(([id, entry]) => [id, observeEntry(db, tables, entry,
    entry.row.parent_id !== null && entries.has(entry.row.parent_id), heads.get(id))]));
}

/** Parse validates only this session, using indexed probes in its fresh snapshot. */
export function observeSession(db: SqliteDb, tables: ReadonlySet<string>, id: string): ObservedSession | undefined {
  const entry = readSessionEntry(db, tables, id);
  if (entry === undefined) return undefined;
  const head = tables.has('event_sequence')
    ? db.prepare('SELECT aggregate_id, seq, owner_id FROM event_sequence WHERE aggregate_id = ?').get(id) as unknown as AggregateHead | undefined
    : undefined;
  return observeEntry(db, tables, entry, checkIsSubagent(db, entry.row.parent_id, tables), head);
}
