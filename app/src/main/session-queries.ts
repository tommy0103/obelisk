// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Read-side IPC over the index: sessions, transcripts, memories and usage.
// Holds no state and imports neither electron nor better-sqlite3 values: tests
// re-import index.ts with fresh mocks, and a cached dependency would keep the
// first test's. index.ts injects ipcMain and the live handle.

import fs from 'node:fs';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type Database from 'better-sqlite3';
import { storedSessionCursor } from '../../../packages/core/src/provider-indexing.ts';
import type { ProviderRegistry } from '../../../packages/core/src/providers/registry.ts';
import type { SqliteRow } from '../../../packages/core/src/sqlite-types.ts';
import type { createWorkerBuildIndex } from './indexer-worker-client.ts';
import type {
  SessionPatchCursor,
  SessionPatchSnapshot,
  SessionMetadata,
  SessionCatalogueOptions,
  ActivitySessionsOptions,
  SessionsQueryOptions,
  SourceQueryOptions,
} from '../shared/ipc-types.ts';
import type {
  SessionDetailAssemblyInput,
  SessionMessageRow,
  SessionSubagentRow,
  SessionSummaryRow,
  SessionToolCallRow,
  SessionToolResultRow,
  SessionWorkflowRow,
} from '../shared/session-detail-types.ts';
import { createSessionPatch } from '../shared/session-patch.mjs';
import { assembleSessionDetail } from '../shared/session-detail-assembly.mjs';

type AppDb = Database.Database;

interface SessionQueryDeps {
  ipcMain: Pick<IpcMain, 'handle'>;
  getDb: () => AppDb | null;
  getRuntimePaths: () => { providerRegistry: ProviderRegistry; providerRoots: Record<string, string> };
  getIndexerWorker: () => ReturnType<typeof createWorkerBuildIndex> | null;
  runAppDbWrite: (work: (db: AppDb) => void) => boolean;
}

type CountRow = { c: number };
type FullTextMessageRow = SqliteRow & {
  session_id: string;
  agent_id: string | null;
  source: string | null;
  visibility: string | null;
  text: string | null;
};

function sourceWhereClause(opts: SourceQueryOptions = {}, column = "source"): { sql: string; params: unknown[] } {
  if (opts.source === 'all') return { sql: '', params: [] };
  if (opts.source) return { sql: `COALESCE(${column}, 'claude') = ?`, params: [opts.source] };
  return { sql: `COALESCE(${column}, 'claude') = 'claude'`, params: [] };
}

function appendWhere(sql: string, clause: string) {
  if (!clause) return sql;
  return `${sql}${sql.includes(' WHERE ') ? ' AND ' : ' WHERE '}${clause}`;
}

function querySessionMessages(db: AppDb | null, sessionId: string): SessionMessageRow[] {
  if (!db) return [];
  return db.prepare(`
    SELECT m.uuid, m.session_id, m.type, m.parent_uuid, m.timestamp, m.role, m.text, m.model,
           m.is_sidechain, m.agent_id, m.input_tokens, m.output_tokens, m.cwd, m.skill, m.turn_duration_ms,
           m.content_type, m.is_meta, m.visibility, m.source
    FROM messages m
    WHERE m.session_id = ? AND (m.agent_id IS NULL OR m.agent_id = m.session_id)
      AND COALESCE(m.visibility, 'visible') = 'visible'
    ORDER BY m.timestamp, m.uuid
  `).all(sessionId) as SessionMessageRow[];
}

function querySessionToolCalls(db: AppDb | null, sessionId: string): SessionToolCallRow[] {
  if (!db) return [];
  // Insertion order is the provider's source order, and the assembled session detail keeps a
  // message's calls the way they arrive here: `tool_calls` carries a `(session_id, name)` index, so
  // an explicit order is what stops the planner from returning them sorted by tool name (ADR-0007).
  return db.prepare(`
    SELECT tc.* FROM messages m
    CROSS JOIN tool_calls tc ON tc.message_uuid = m.uuid
    WHERE m.session_id = ? AND (m.agent_id IS NULL OR m.agent_id = m.session_id)
      AND COALESCE(m.visibility, 'visible') = 'visible'
      AND tc.session_id = ?
    ORDER BY tc.rowid
  `).all(sessionId, sessionId) as SessionToolCallRow[];
}

function querySessionToolResults(db: AppDb | null, sessionId: string): SessionToolResultRow[] {
  if (!db) return [];
  return db.prepare(`
    SELECT tr.* FROM messages m
    CROSS JOIN tool_results tr ON tr.message_uuid = m.uuid
    WHERE m.session_id = ? AND (m.agent_id IS NULL OR m.agent_id = m.session_id)
      AND COALESCE(m.visibility, 'visible') = 'visible'
      AND tr.session_id = ?
  `).all(sessionId, sessionId) as SessionToolResultRow[];
}

function querySessionSubagents(db: AppDb | null, sessionId: string): SessionSubagentRow[] {
  if (!db) return [];
  return db.prepare(`SELECT * FROM subagents WHERE session_id = ?`).all(sessionId) as SessionSubagentRow[];
}

function querySessionWorkflows(db: AppDb | null, sessionId: string): SessionWorkflowRow[] {
  if (!db) return [];
  const workflows = db.prepare(`SELECT * FROM workflows WHERE session_id = ?`).all(sessionId) as SessionWorkflowRow[];
  for (const workflow of workflows) {
    workflow.agents = db.prepare(`SELECT * FROM workflow_agents WHERE run_id = ?`).all(workflow.run_id) as SessionWorkflowRow['agents'];
  }
  return workflows;
}

function querySessionSummaries(db: AppDb | null, sessionId: string): SessionSummaryRow[] {
  if (!db) return [];
  return db.prepare(`
    SELECT * FROM summaries
    WHERE session_id = ? AND COALESCE(visibility, 'visible') = 'visible'
  `).all(sessionId) as SessionSummaryRow[];
}

function querySessionSnapshot(db: AppDb | null, sessionId: string): SessionDetailAssemblyInput {
  return {
    messages: querySessionMessages(db, sessionId),
    toolCalls: querySessionToolCalls(db, sessionId),
    toolResults: querySessionToolResults(db, sessionId),
    subagents: querySessionSubagents(db, sessionId),
    workflows: querySessionWorkflows(db, sessionId),
    summaries: querySessionSummaries(db, sessionId),
  };
}

function querySessionDisplaySnapshot(db: AppDb | null, sessionId: string): SessionPatchSnapshot {
  const snapshot = querySessionSnapshot(db, sessionId);
  const detail = assembleSessionDetail(snapshot);
  return {
    messages: detail.messages,
    workflows: detail.workflows,
    summaries: detail.summaries,
  };
}

const SESSION_METADATA_COLUMNS = [
  'id',
  'title',
  'project',
  'project_path',
  'started_at',
  'ended_at',
  'git_branch',
  'version',
  'message_count',
  'jsonl_path',
  'source',
].join(', ');

function querySessionMetadata(db: AppDb | null, sessionId: string): SessionMetadata | null {
  if (!db) return null;
  return (
    db.prepare(`SELECT ${SESSION_METADATA_COLUMNS} FROM sessions WHERE id = ?`).get(sessionId) as SessionMetadata | undefined
  ) || null;
}

// Every root this session actually worked in. A reference is only opened if it lands inside
// one of them, so untrusted transcript text cannot reach a file outside the session's own
// projects. Scoping is deliberately per session, not corpus-wide.
function querySessionFileRoots(db: AppDb | null, sessionId: unknown): string[] {
  if (!db || typeof sessionId !== 'string' || !sessionId) return [];
  const roots: string[] = [];
  const rows = db.prepare<[string], { cwd: string }>(
    `SELECT DISTINCT cwd FROM messages
     WHERE session_id = ? AND cwd IS NOT NULL AND cwd != ''
       AND COALESCE(visibility, 'visible') = 'visible'`
  ).all(sessionId);
  for (const row of rows) roots.push(row.cwd);
  const session = db.prepare<[string], { project_path: string | null }>(`SELECT project_path FROM sessions WHERE id = ?`).get(sessionId);
  if (session?.project_path) roots.push(session.project_path);
  return roots;
}

export function registerSessionQueryHandlers({ ipcMain, getDb, getRuntimePaths, getIndexerWorker, runAppDbWrite }: SessionQueryDeps): void {
  ipcMain.handle('db:getSessions', (_, opts: SessionsQueryOptions = {}) => {
    const db = getDb();
    if (!db) return [];
    const { project, sessionId, limit = 200 } = opts;
    let sql = `SELECT ${SESSION_METADATA_COLUMNS} FROM sessions`;
    const params: unknown[] = [];
    const sourceFilter = sourceWhereClause(opts);
    if (sourceFilter.sql) {
      sql = appendWhere(sql, sourceFilter.sql);
      params.push(...sourceFilter.params);
    }
    if (project) { sql = appendWhere(sql, `project LIKE ?`); params.push(project); }
    if (sessionId !== undefined) { sql = appendWhere(sql, `id = ?`); params.push(sessionId); }
    sql += ` ORDER BY COALESCE(ended_at, started_at) DESC`;
    if (limit !== null) {
      sql += ' LIMIT ?';
      params.push(limit);
    }
    return db.prepare(sql).all(...params);
  });

  ipcMain.handle('db:getSessionCatalogue', (_, opts: SessionCatalogueOptions = {}) => {
    const db = getDb();
    if (!db) return { rows: [], total: 0 };
    const limit = Number.isSafeInteger(opts.limit) ? Math.max(1, Math.min(opts.limit!, 100)) : 100;
    const offset = Number.isSafeInteger(opts.offset) ? Math.max(0, opts.offset!) : 0;
    const clauses: string[] = [];
    const params: unknown[] = [];
    const sourceFilter = sourceWhereClause(opts);
    if (sourceFilter.sql) { clauses.push(sourceFilter.sql); params.push(...sourceFilter.params); }
    if (opts.project && opts.project !== 'all') { clauses.push('project = ?'); params.push(opts.project); }
    if (opts.quiet) clauses.push("(title IS NULL OR title = '')");
    else clauses.push("title IS NOT NULL AND title != ''");
    const query = opts.query?.trim().toLowerCase();
    if (query) {
      clauses.push('catalogue_contains(title, project, git_branch, ?)');
      params.push(query);
    }
    const where = `WHERE ${clauses.join(' AND ')}`;
    const total = (db.prepare(`SELECT COUNT(*) AS count FROM sessions ${where}`).get(...params) as { count: number }).count;
    const direction = opts.descending === false ? 'ASC' : 'DESC';
    const rows = db.prepare(`SELECT ${SESSION_METADATA_COLUMNS} FROM sessions ${where}
      ORDER BY COALESCE(ended_at, started_at) ${direction}, id ${direction} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);
    return { rows, total };
  });

  ipcMain.handle('db:getActivitySessions', (_, opts: ActivitySessionsOptions) => {
    const db = getDb();
    if (!db) return { rows: [], total: 0 };
    if (!/^\d{4}-\d\d-\d\d/.test(opts?.from) || !/^\d{4}-\d\d-\d\d/.test(opts?.to)) {
      throw new Error('Activity date range must use ISO dates');
    }
    const offset = Number.isSafeInteger(opts.offset) ? Math.max(0, opts.offset!) : 0;
    const where = 's.started_at < ? AND COALESCE(s.ended_at, s.started_at) >= ?';
    const params = [opts.to, opts.from];
    const total = (db.prepare(`SELECT COUNT(*) AS count FROM sessions s WHERE ${where}`).get(...params) as { count: number }).count;
    const rows = db.prepare(`SELECT ${SESSION_METADATA_COLUMNS.split(', ').map(column => `s.${column}`).join(', ')},
      EXISTS (SELECT 1 FROM sessions earlier WHERE earlier.project = s.project
        AND earlier.id != s.id AND earlier.started_at < s.started_at) AS has_earlier
      FROM sessions s WHERE ${where}
      ORDER BY COALESCE(s.ended_at, s.started_at) DESC, s.id DESC LIMIT 200 OFFSET ?`)
      .all(...params, offset);
    return { rows, total };
  });

  ipcMain.handle('db:getSessionMessages', (_, sessionId) => {
    const db = getDb();
    return querySessionMessages(db, sessionId);
  });

  ipcMain.handle('db:getSessionToolCalls', (_, sessionId) => {
    const db = getDb();
    return querySessionToolCalls(db, sessionId);
  });

  ipcMain.handle('db:getSessionToolResults', (_, sessionId) => {
    const db = getDb();
    return querySessionToolResults(db, sessionId);
  });

  ipcMain.handle('db:getSessionSubagents', (_, sessionId) => {
    const db = getDb();
    return querySessionSubagents(db, sessionId);
  });

  ipcMain.handle('db:getSessionWorkflows', (_, sessionId) => {
    const db = getDb();
    return querySessionWorkflows(db, sessionId);
  });

  ipcMain.handle('db:getSessionPatch', (
    _event: IpcMainInvokeEvent,
    sessionId: string,
    cursor: SessionPatchCursor,
  ) => {
    const db = getDb();
    if (!db) return null;
    return {
      ...createSessionPatch(querySessionDisplaySnapshot(db, sessionId), cursor),
      session: querySessionMetadata(db, sessionId),
    };
  });

  ipcMain.handle('db:getSubagentMessages', (_, agentId) => {
    const db = getDb();
    if (!db) return [];
    return db.prepare(`
      SELECT m.uuid, m.session_id, m.type, m.parent_uuid, m.timestamp, m.role, m.text, m.model,
             m.is_sidechain, m.agent_id, m.input_tokens, m.output_tokens, m.cwd, m.skill, m.turn_duration_ms,
             m.content_type, m.is_meta, m.visibility, m.source
      FROM messages m
      WHERE m.agent_id = ? AND COALESCE(m.visibility, 'visible') = 'visible'
      ORDER BY m.timestamp, m.uuid
    `).all(agentId);
  });

  ipcMain.handle('db:getSubagentToolCalls', (_, agentId) => {
    const db = getDb();
    if (!db) return [];
    // Same as querySessionToolCalls: insertion order, not the `(session_id, name)` index order.
    return db.prepare(`
      SELECT tc.* FROM tool_calls tc
      JOIN messages m ON m.uuid = tc.message_uuid
      WHERE m.agent_id = ? AND COALESCE(m.visibility, 'visible') = 'visible'
      ORDER BY tc.rowid
    `).all(agentId);
  });

  ipcMain.handle('db:getSubagentToolResults', (_, agentId) => {
    const db = getDb();
    if (!db) return [];
    return db.prepare(`
      SELECT tr.* FROM tool_results tr
      JOIN messages m ON m.uuid = tr.message_uuid
      WHERE m.agent_id = ? AND COALESCE(m.visibility, 'visible') = 'visible'
    `).all(agentId);
  });

  ipcMain.handle('db:getSessionSummaries', (_, sessionId) => {
    const db = getDb();
    return querySessionSummaries(db, sessionId);
  });

  ipcMain.handle('db:getMemories', () => {
    const db = getDb();
    if (!db) return [];
    return db.prepare(`
      SELECT m.id, m.session_id, m.project, m.message_start, m.message_end, m.path, m.anchors,
             m.summary, m.created_at, m.deleted_at, m.deleted_reason, s.title AS session_title
      FROM memories m LEFT JOIN sessions s ON s.id = m.session_id ORDER BY m.created_at DESC
    `).all();
  });

  ipcMain.handle('db:getMessageFullText', async (_, uuid) => {
    const db = getDb();
    if (!db) return null;
    const msg = db.prepare<[unknown], FullTextMessageRow>('SELECT * FROM messages WHERE uuid=?').get(uuid);
    if (!msg || (msg.visibility ?? 'visible') !== 'visible') return null;
    const session = db.prepare<[string], SqliteRow>('SELECT * FROM sessions WHERE id=?').get(msg.session_id) ?? null;
    const subagent = msg.agent_id
      ? db.prepare<[string], SqliteRow>('SELECT * FROM subagents WHERE agent_id=?').get(msg.agent_id) ?? null
      : null;
    const workflowAgent = msg.agent_id
      ? db.prepare<[string], SqliteRow>('SELECT * FROM workflow_agents WHERE agent_id=?').get(msg.agent_id) ?? null
      : null;
    const paths = getRuntimePaths();
    const lookup = {
      source: msg.source || session?.source || 'claude',
      messageUuid: String(uuid),
      session,
      agentId: msg.agent_id || null,
      cursor: storedSessionCursor(db, paths.providerRegistry, session),
      subagent,
      workflowAgent,
    };
    // Store-backed source reads belong in the worker: a custom root can live on a slow mount.
    if (lookup.source === 'zcode' || lookup.source === 'hermes' || lookup.source === 'kiro' || lookup.source === 'opencode' || lookup.source === 'devin') {
      try {
        const messageText = lookup.source === 'zcode'
          ? await getIndexerWorker()?.readZcodeMessageText(lookup)
          : lookup.source === 'kiro'
            ? await getIndexerWorker()?.readKiroMessageText({ ...lookup, rootDir: paths.providerRoots.kiro })
            : lookup.source === 'devin'
              ? await getIndexerWorker()?.readDevinMessageText({ ...lookup, rootDir: paths.providerRoots.devin })
              : lookup.source === 'opencode'
                ? await getIndexerWorker()?.readOpencodeMessageText(lookup)
                : await getIndexerWorker()?.readHermesMessageText(lookup);
        return messageText ?? msg.text ?? null;
      } catch {
        return msg.text ?? null;
      }
    }
    const raw = paths.providerRegistry.raw(lookup);
    return raw?.messageText ?? msg.text ?? null;
  });

  ipcMain.handle('db:readMemoryFile', async (_, filePath) => {
    try {
      return await fs.promises.readFile(filePath, 'utf-8');
    } catch { return null; }
  });

  ipcMain.handle('db:archiveMemory', (_, id, reason) => {
    return runAppDbWrite((db) => {
      db.prepare(`UPDATE memories SET deleted_at = ?, deleted_reason = ? WHERE id = ?`)
        .run(new Date().toISOString(), reason || 'Archived via panel', id);
    });
  });

  ipcMain.handle('db:restoreMemory', (_, id) => {
    return runAppDbWrite((db) => {
      db.prepare(`UPDATE memories SET deleted_at = NULL, deleted_reason = NULL WHERE id = ?`).run(id);
    });
  });

  ipcMain.handle('db:getProjects', (_, opts = {}) => {
    const db = getDb();
    if (!db) return [];
    const sourceFilter = sourceWhereClause(opts);
    const where = sourceFilter.sql ? `WHERE ${sourceFilter.sql}` : '';
    return db.prepare(`
      SELECT project, project_path, COUNT(*) as session_count,
             MAX(COALESCE(ended_at, started_at)) as last_active
      FROM sessions ${where ? `${where} AND` : 'WHERE'} project IS NOT NULL
      GROUP BY project ORDER BY last_active DESC
    `).all(...sourceFilter.params);
  });

  ipcMain.handle('db:getStats', (_, opts = {}) => {
    const db = getDb();
    if (!db) return { sessions: 0, memories: 0, memoriesArchived: 0 };
    const sourceFilter = sourceWhereClause(opts);
    const where = sourceFilter.sql ? `WHERE ${sourceFilter.sql}` : '';
    const sessions = db.prepare<unknown[], CountRow>(`SELECT COUNT(*) as c FROM sessions ${where}`).get(...sourceFilter.params)?.c || 0;
    const memories = db.prepare<[], CountRow>('SELECT COUNT(*) as c FROM memories WHERE deleted_at IS NULL').get()?.c || 0;
    const memoriesArchived = db.prepare<[], CountRow>('SELECT COUNT(*) as c FROM memories WHERE deleted_at IS NOT NULL').get()?.c || 0;
    return { sessions, memories, memoriesArchived };
  });

  ipcMain.handle('db:getUsageStats', (_, opts = {}) => {
    const db = getDb();
    if (!db) return { daily: [], totalTokens: 0, peakDay: null, longestTurn: null };
    // Visibility controls evidence display, not accounting. Abandoned model calls
    // still consumed tokens, so aggregate usage intentionally includes them.
    const messageSourceFilter = sourceWhereClause(opts, 'source');
    const summarySourceFilter = sourceWhereClause(opts, 's.source');
    const usageDays = db.prepare<unknown[], { day: string | null; tokens: number | null }>(`
      WITH usage_events AS (
        SELECT timestamp, input_tokens, output_tokens
        FROM messages
        WHERE (input_tokens IS NOT NULL OR output_tokens IS NOT NULL)
          ${messageSourceFilter.sql ? `AND ${messageSourceFilter.sql}` : ''}
        UNION ALL
        SELECT su.timestamp, su.input_tokens, su.output_tokens
        FROM summaries su
        LEFT JOIN sessions s ON s.id = su.session_id
        WHERE (su.input_tokens IS NOT NULL OR su.output_tokens IS NOT NULL)
          ${summarySourceFilter.sql ? `AND ${summarySourceFilter.sql}` : ''}
      )
      SELECT DATE(timestamp) as day,
             SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)) as tokens
      FROM usage_events
      GROUP BY DATE(timestamp)
      ORDER BY day
    `).all(...messageSourceFilter.params, ...summarySourceFilter.params);

    const totalTokens = usageDays.reduce((total, row) => total + (row.tokens || 0), 0);
    const daily: Array<{ day: string; tokens: number }> = [];
    for (const row of usageDays) {
      if (row.day !== null) daily.push({ day: row.day, tokens: row.tokens || 0 });
    }

    let peakDay: { day: string; tokens: number } | null = null;
    for (const day of daily) {
      if (!peakDay || day.tokens > peakDay.tokens) peakDay = day;
    }

    const longestTurn = db.prepare(`
      SELECT turn_duration_ms, uuid, session_id, timestamp
      FROM messages
      WHERE turn_duration_ms IS NOT NULL
        ${messageSourceFilter.sql ? `AND ${messageSourceFilter.sql}` : ''}
      ORDER BY turn_duration_ms DESC
      LIMIT 1
    `).get(...messageSourceFilter.params) || null;

    return { daily, totalTokens, peakDay, longestTurn };
  });
}

export { querySessionFileRoots };
