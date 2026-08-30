// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Shared database-finalize policies for the passive CLI indexer and the app
// daemon. Callers keep ownership of discovery, retries, watcher state, and
// transactions; this module owns the invariants that must not diverge between
// the two indexing modes.

import { inferProjectPath } from './parsing.ts';
import type { SqliteDb, SqliteRow } from './sqlite-types.ts';

const FTS_TRIGGERS_READY_MARKER = '__fts_triggers_ready__';
const MESSAGE_FTS_TRIGGERS = [
  'messages_fts_ai',
  'messages_fts_ad',
  'messages_fts_au',
] as const;

/** Remove message FTS triggers before a caller-owned bulk replacement. */
export function dropMessageFtsTriggers(db: SqliteDb): void {
  for (const trigger of MESSAGE_FTS_TRIGGERS) {
    db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  }
}

/**
 * Rebuild both external-content FTS indexes only when the index has not yet
 * recorded trigger readiness, or when a force snapshot explicitly requests a
 * complete repair. The marker is written by the caller's transaction after
 * both rebuilds succeed.
 */
export function ensureFtsReady(db: SqliteDb, { force = false }: { force?: boolean } = {}): boolean {
  const ready = db.prepare('SELECT jsonl_path FROM index_state WHERE jsonl_path = ?')
    .get(FTS_TRIGGERS_READY_MARKER);
  if (ready && !force) return false;
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
  db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
  db.prepare(
    'INSERT OR REPLACE INTO index_state (jsonl_path, mtime, lines_processed) VALUES (?, ?, 0)',
  ).run(FTS_TRIGGERS_READY_MARKER, Date.now());
  return true;
}

/**
 * Refresh project paths for every session (`null`) or for one affected set.
 * Scoped refreshes also repair unresolved rows, so legacy/null paths converge
 * without turning every ordinary incremental build into a corpus-wide scan.
 */
export function refreshSessionProjectPaths(
  db: SqliteDb,
  sessionIds: ReadonlySet<string> | null = null,
): void {
  let sessions: SqliteRow[];
  if (sessionIds === null) {
    sessions = db.prepare('SELECT id, project FROM sessions').all();
  } else {
    const byId = new Map<string, SqliteRow>();
    const sessionById = db.prepare('SELECT id, project FROM sessions WHERE id = ?');
    for (const sessionId of sessionIds) {
      const session = sessionById.get(sessionId);
      if (session) byId.set(String(session.id), session);
    }
    for (const session of db.prepare(
      "SELECT id, project FROM sessions WHERE project_path IS NULL OR project_path = ''",
    ).all()) {
      byId.set(String(session.id), session);
    }
    sessions = [...byId.values()];
  }

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

export { FTS_TRIGGERS_READY_MARKER };
