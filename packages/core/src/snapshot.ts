// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import type { RetainedSession } from './provider-indexing.ts';
import type { SqliteDb } from './sqlite-types.ts';

// Memories have their own lifecycle and are never part of transcript cleanup.
const TABLES = ['messages', 'tool_calls', 'tool_results', 'sessions', 'summaries', 'subagents', 'workflows', 'workflow_agents'] as const;
const COPY_BATCH = 200;
const ROW_BATCH = 256;

/**
 * Stage last-good sessions while the caller holds the writer lease. A desktop
 * replacement supplies a separate read-only source connection. reset() runs in
 * the caller's retryable publication transaction; staged rows survive rollback.
 * Both bindings use the same bounded reads/inserts, without URI/ATTACH options.
 */
export function prepareRetainedSnapshot(db: SqliteDb, retained: readonly RetainedSession[], source: SqliteDb = db) {
  const staged: string[] = [];
  const clean = () => {
    for (const table of staged) db.exec(`DROP TABLE IF EXISTS temp.obelisk_retained_${table}`);
  };
  try {
    const ids = [...new Set(retained.map(session => session.sessionId))];
    for (const table of TABLES) {
      // Identifiers/defaults come from the installed target schema, never from
      // transcripts. Additive fields missing in an old source use that default.
      const columns = db.prepare(`PRAGMA main.table_info(${table})`).all();
      const names = columns.map(column => column.name);
      const sourceColumns = new Set(source.prepare(`PRAGMA main.table_info(${table})`).all().map(column => column.name));
      const selection = columns.map(column => sourceColumns.has(column.name)
        ? column.name : `${column.dflt_value ?? 'NULL'} AS ${column.name}`).join(',');
      db.exec(`CREATE TEMP TABLE obelisk_retained_${table} AS SELECT rowid AS obelisk_rowid, * FROM main.${table} WHERE 0`);
      staged.push(table);
      db.exec(`CREATE UNIQUE INDEX temp.obelisk_retained_${table}_rowid ON obelisk_retained_${table}(obelisk_rowid)`);
      const insert = db.prepare(`INSERT OR IGNORE INTO temp.obelisk_retained_${table} VALUES (${Array(names.length + 1).fill('?').join(',')})`);
      for (let offset = 0; offset < ids.length; offset += COPY_BATCH) {
        const batch = ids.slice(offset, offset + COPY_BATCH);
        const placeholders = batch.map(() => '?').join(',');
        const memberMessages = `session_id IN (${placeholders}) OR agent_id IN (${placeholders})`;
        const predicates: Record<(typeof TABLES)[number], [string, number]> = {
          sessions: [`id IN (${placeholders})`, 1],
          messages: [memberMessages, 2],
          tool_calls: [`session_id IN (${placeholders}) OR message_uuid IN (SELECT uuid FROM main.messages WHERE ${memberMessages})`, 3],
          tool_results: [`session_id IN (${placeholders}) OR message_uuid IN (SELECT uuid FROM main.messages WHERE ${memberMessages})`, 3],
          summaries: [`session_id IN (${placeholders})`, 1],
          subagents: [`session_id IN (${placeholders}) OR agent_id IN (${placeholders})`, 2],
          workflows: [`session_id IN (${placeholders})`, 1],
          workflow_agents: [`session_id IN (${placeholders})`, 1],
        };
        const [predicate, copies] = predicates[table];
        const bindings = Array.from({ length: copies }, () => batch).flat();
        let lastRowid: number | undefined;
        for (;;) {
          const rows = source.prepare(`SELECT rowid AS obelisk_rowid, ${selection} FROM main.${table} WHERE (${predicate})${lastRowid === undefined ? '' : ' AND rowid > ?'} ORDER BY rowid LIMIT ${ROW_BATCH}`)
            .all(...bindings, ...(lastRowid === undefined ? [] : [lastRowid]));
          for (const row of rows) insert.run(row.obelisk_rowid, ...names.map(name => row[name]));
          if (rows.length < ROW_BATCH) break;
          lastRowid = Number(rows[rows.length - 1]!.obelisk_rowid);
        }
      }
    }
  } catch (error) {
    clean();
    throw error;
  }
  return {
    reset() {
      db.prepare('DELETE FROM index_state').run();
      for (const table of TABLES) db.prepare(`DELETE FROM ${table}`).run();
      for (const table of TABLES) {
        const columns = db.prepare(`PRAGMA main.table_info(${table})`).all().map(column => column.name).join(',');
        db.exec(`INSERT INTO main.${table} (rowid,${columns}) SELECT obelisk_rowid,${columns} FROM temp.obelisk_retained_${table}`);
      }
      const restore = db.prepare('INSERT OR REPLACE INTO index_state (jsonl_path,mtime,lines_processed,cursor,replay_required) VALUES (?,?,?,?,1)');
      for (const session of retained) {
        const state = session.checkpoint;
        if (state !== undefined) restore.run(session.unitKey, state.mtime, state.linesProcessed, state.cursor);
      }
    },
    close: clean,
  };
}
