// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Shared database-finalize policies for the passive CLI indexer and the app
// daemon. Callers keep ownership of discovery, retries, watcher state, and
// transactions; this module owns the invariants that must not diverge between
// the two indexing modes.

import { existsSync } from 'node:fs';
import { inferProjectPath } from './parsing.ts';
import type { SqliteDb, SqliteRow } from './sqlite-types.ts';

const FTS_TRIGGERS_READY_MARKER = '__fts_triggers_ready__';
const PROJECT_PATH_BACKFILL_MARKER = '__project_path_backfill_v1__';
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
 * complete repair. Trigger-only maintenance is safe because persist writes
 * messages with INSERT ... ON CONFLICT DO UPDATE (fires messages_fts_au) and
 * removes them with plain DELETE (fires messages_fts_ad); it never uses
 * INSERT OR REPLACE for messages. The marker is written by the caller's
 * transaction after both rebuilds succeed.
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
 * Derive stable project roots for sessions that need a path.
 *
 * Scoped refreshes are used by ordinary incremental indexing and only select
 * unresolved sessions. A non-empty path is intentionally stable: nested cwd
 * values in later messages must not turn a project root into a subdirectory,
 * and an affected long session must not be rescanned on every delta. A null
 * session set is reserved for complete force/repair passes and recomputes all
 * sessions.
 */
export function refreshSessionProjectPaths(
  db: SqliteDb,
  sessionIds: ReadonlySet<string> | null = null,
  { recompute = false }: { recompute?: boolean } = {},
): void {
  let sessions: SqliteRow[];
  if (sessionIds === null) {
    sessions = db.prepare('SELECT id, project FROM sessions').all();
  } else {
    const sessionById = db.prepare(
      recompute
        ? 'SELECT id, project FROM sessions WHERE id = ?'
        : `SELECT id, project FROM sessions
           WHERE id = ? AND (project_path IS NULL OR project_path = '')`,
    );
    sessions = [...sessionIds]
      .map(sessionId => sessionById.get(sessionId))
      .filter((session): session is SqliteRow => session !== undefined);
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

const SESSION_TITLE_MAX_CHARS = 80;
// How many opening user messages to inspect before giving up on a title: the
// first few records of a transcript are frequently runtime wrappers rather
// than anything the person typed.
const SESSION_TITLE_CANDIDATES = 5;

// Blocks that describe the harness, not the session. `<command-name>/clear</command-name>`
// is a slash command, `<user_info>` is the runtime's environment preamble, and
// the rest are local-command plumbing.
const WRAPPER_BLOCKS = [
  'system-reminder', 'user_info', 'command-name', 'command-message', 'command-args',
  'local-command-stdout', 'local-command-stderr',
] as const;
const AGENT_TYPE_PREFIX = /^\[[^\]]{1,40}\]\s*/;
const WARMUP_PROMPT = /^warm ?up$/i;
const HAS_WORD = /[\p{L}\p{N}]/u;

/** A catalogue-sized title taken from a message body, or null when it is all plumbing. */
function titleFromMessageText(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  let cleaned = text.trim().replace(AGENT_TYPE_PREFIX, '');
  for (const tag of WRAPPER_BLOCKS) {
    cleaned = cleaned.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'gi'), ' ');
  }
  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('<') || WARMUP_PROMPT.test(line)) continue;
    if (line.length < 3 || !HAS_WORD.test(line)) continue;
    // Slice by code point: a UTF-16 cut can split an emoji or a rare CJK
    // character and leave a lone surrogate in the catalogue.
    const chars = [...line];
    return chars.length > SESSION_TITLE_MAX_CHARS
      ? `${chars.slice(0, SESSION_TITLE_MAX_CHARS - 1).join('').trimEnd()}…`
      : line;
  }
  return null;
}

/**
 * Fill a missing catalogue title from the session's own first usable user message.
 *
 * Two kinds of session reach the index without a title: older Claude
 * transcripts that never wrote a custom/ai title, and sessions reconstructed
 * from orphaned subagent logs, which have no title source at all (see the
 * claude adapter). They are browsable by id but indistinguishable in a list.
 *
 * Wrapper records are skipped rather than titled (`<command-name>/clear</command-name>`,
 * `<user_info>` preambles, `Warmup` probes), and a session whose opening records
 * are all plumbing stays untitled — a made-up title is worse than none. Only
 * NULL/blank titles are filled, so a real title learned later still wins:
 * persist writes provider titles with `r.title ?? prev?.title`.
 */
export function backfillSessionTitles(db: SqliteDb): number {
  const untitled = db.prepare(
    "SELECT id FROM sessions WHERE title IS NULL OR trim(title) = ''",
  ).all();
  if (untitled.length === 0) return 0;
  // One index seek per untitled session. A single windowed join over `messages`
  // is shaped the other way round — it scans every message (2M rows on a real
  // corpus) and holds the caller's write transaction for 14-17 s. Staying on
  // idx_messages_session keeps this in the millisecond range and lets the pass
  // run on every incremental build.
  const opening = db.prepare(`
    SELECT text FROM messages
    WHERE session_id = ?
      AND role = 'user'
      AND text IS NOT NULL AND trim(text) <> ''
      AND COALESCE(is_meta, 0) = 0
      AND agent_id IS NULL
      AND COALESCE(visibility, 'visible') = 'visible'
    ORDER BY timestamp IS NULL, timestamp, uuid
    LIMIT ${SESSION_TITLE_CANDIDATES}
  `);
  // A session rebuilt from an orphaned subagent log has nothing but subagent
  // turns, so the main-agent filter would leave it untitled forever. Fall back
  // to any user record — `titleFromMessageText` still rejects plumbing.
  const openingFallback = db.prepare(`
    SELECT text FROM messages
    WHERE session_id = ?
      AND role = 'user'
      AND text IS NOT NULL AND trim(text) <> ''
      AND COALESCE(visibility, 'visible') = 'visible'
    ORDER BY timestamp IS NULL, timestamp, uuid
    LIMIT ${SESSION_TITLE_CANDIDATES}
  `);
  // Re-check the precondition in the UPDATE: a provider that learned a real
  // title between the SELECT and this write must keep it.
  const update = db.prepare(
    "UPDATE sessions SET title = ? WHERE id = ? AND (title IS NULL OR trim(title) = '')",
  );
  const firstTitle = (rows: readonly { text?: unknown }[]): string | null => {
    for (const row of rows) {
      const title = titleFromMessageText(row.text);
      if (title !== null) return title;
    }
    return null;
  };
  let filled = 0;
  for (const session of untitled) {
    const id = String(session.id);
    const title = firstTitle(opening.all(id)) ?? firstTitle(openingFallback.all(id));
    if (title === null) continue;
    update.run(title, id);
    filled++;
  }
  return filled;
}

/**
 * Recompute `message_count` for sessions whose transcript no longer exists.
 *
 * Sessions rebuilt from the last surviving subagent log (see the claude
 * adapter) are counted with `countMode: 'delta'`, because several subagent
 * files share one session id. A replay — marker bump, lost cursor row, failed
 * unit retried — re-adds that unit's messages instead of replacing them, so the
 * count drifts above the rows actually stored. Nothing can correct it from the
 * provider side, because the main transcript that used to own the total is
 * exactly what is missing.
 *
 * Rows are the authority here: their transcript is gone, so the count is
 * derived from them. Idempotent by construction — after the first pass the
 * stored count equals `COUNT(*)` and the statement is a no-op.
 */
export function repairOrphanedSessionCounts(db: SqliteDb): number {
  const sessions = db.prepare(`
    SELECT id, jsonl_path, message_count FROM sessions
    WHERE jsonl_path IS NOT NULL AND jsonl_path <> ''
  `).all();
  if (sessions.length === 0) return 0;
  const count = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?');
  const update = db.prepare('UPDATE sessions SET message_count = ? WHERE id = ?');
  let repaired = 0;
  for (const session of sessions) {
    // A readable transcript stays authoritative: it can be re-parsed, and
    // `message_count` may legitimately cover rows the adapter chose to fold.
    if (existsSync(String(session.jsonl_path))) continue;
    const actual = Number(count.get(String(session.id))?.n ?? 0);
    if (actual === Number(session.message_count ?? 0)) continue;
    update.run(actual, String(session.id));
    repaired++;
  }
  return repaired;
}

/** Repair legacy unresolved project paths once; new/changed sessions use their unit transaction. */
export function backfillUnresolvedSessionProjectPathsOnce(db: SqliteDb): boolean {
  const done = db.prepare('SELECT jsonl_path FROM index_state WHERE jsonl_path = ?')
    .get(PROJECT_PATH_BACKFILL_MARKER);
  if (done) return false;
  const unresolved = new Set(db.prepare(
    "SELECT id FROM sessions WHERE project_path IS NULL OR project_path = ''",
  ).all().map((session: SqliteRow) => String(session.id)));
  refreshSessionProjectPaths(db, unresolved);
  db.prepare(
    'INSERT OR REPLACE INTO index_state (jsonl_path, mtime, lines_processed) VALUES (?, ?, 0)',
  ).run(PROJECT_PATH_BACKFILL_MARKER, Date.now());
  return true;
}

export { FTS_TRIGGERS_READY_MARKER, PROJECT_PATH_BACKFILL_MARKER };
