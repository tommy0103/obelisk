// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import type Database from 'better-sqlite3';
import type { SessionCatalogueOptions, SessionCataloguePage, SessionMetadata } from '../shared/ipc-types.ts';

const registered = new WeakSet<object>();
const activity = "COALESCE(NULLIF(ended_at, ''), started_at, '')";
const columns = 'id, title, project, project_path, started_at, ended_at, git_branch, version, message_count, jsonl_path, source';

/**
 * Read one consistent prefix of the matching catalogue. Extending or refreshing
 * the prefix re-evaluates its order, so mutable activity timestamps cannot create
 * holes between pages. Only metadata for the expanded window crosses IPC.
 */
export function querySessionCatalogue(db: Database.Database, opts: SessionCatalogueOptions = {}): SessionCataloguePage {
  const limit = opts.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Session limit must be a positive integer');
  if (!registered.has(db)) {
    // Match the existing renderer's Unicode lowercase + literal substring
    // semantics, including %, _ and CJK, rather than SQL LIKE wildcards.
    db.function('obelisk_metadata_contains', { deterministic: true }, (value, query) => (
      String(value ?? '').toLowerCase().includes(String(query)) ? 1 : 0
    ));
    registered.add(db);
  }
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.source && opts.source !== 'all') {
    clauses.push("COALESCE(source, 'claude') = ?");
    params.push(opts.source);
  }
  if (opts.project && opts.project !== 'all') {
    clauses.push('project = ?');
    params.push(opts.project);
  }
  const query = (opts.query || '').trim().toLowerCase();
  if (query) {
    clauses.push('(obelisk_metadata_contains(title, ?) OR obelisk_metadata_contains(project, ?) OR obelisk_metadata_contains(git_branch, ?))');
    params.push(query, query, query);
  }
  const where = clauses.length ? clauses.join(' AND ') : '1';
  const direction = opts.sortDesc === false ? 'ASC' : 'DESC';
  const comparison = opts.sortDesc === false ? '<' : '>';
  db.exec('BEGIN DEFERRED');
  try {
    const total = (db.prepare(`SELECT COUNT(*) AS count FROM sessions WHERE ${where}`).get(...params) as { count: number }).count;
    let count = limit;
    if (opts.anchorId) {
      const anchor = db.prepare(`SELECT id, ${activity} AS activity FROM sessions WHERE ${where} AND id = ?`).get(...params, opts.anchorId) as { id: string; activity: string } | undefined;
      if (anchor) {
        const ahead = db.prepare(`SELECT COUNT(*) AS count FROM sessions WHERE ${where}
          AND (${activity} ${comparison} ? OR (${activity} = ? AND id ${comparison} ?))`)
          .get(...params, anchor.activity, anchor.activity, anchor.id) as { count: number };
        // Keep some content below the reader when new rows move the anchor
        // beyond the previous prefix boundary.
        count = Math.max(count, ahead.count + 50);
      }
    }
    const sessions = db.prepare(`SELECT ${columns} FROM sessions WHERE ${where}
      ORDER BY ${activity} ${direction}, id ${direction} LIMIT ?`).all(...params, count) as SessionMetadata[];
    db.exec('COMMIT');
    return { sessions, total };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
