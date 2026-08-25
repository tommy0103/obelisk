// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Query and attune sandbox helpers for the Core package.
import { statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, normalize, resolve, sep } from 'node:path';
import { constants as sqliteConstants } from 'node:sqlite';
import { storedSessionCursor } from './provider-indexing.ts';
import { createBuiltinProviderRegistry } from './providers/builtins.ts';
import type { ProviderRegistry } from './providers/registry.ts';
import type { SqliteDb, SqliteRow, SqliteStatement } from './sqlite-types.ts';

type DbRow = SqliteRow;

// SQLite extended result code for a primary-key uniqueness violation.
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;

interface QueryOptions extends Record<string, any> {
  limit?: number;
  sessionId?: string;
  sessions?: string[];
  project?: string;
  after?: string;
  before?: string;
  cwd?: string;
  branch?: string;
  source?: string;
  includeMeta?: boolean;
  includeInactive?: boolean;
  query?: string;
  projectLimit?: number;
  memoryLimit?: number;
}

interface ColumnAliases {
  sessionId: string;
  project: string;
  timestamp: string;
  /** Optional per-direction overrides for range-typed rows (activity intervals). */
  timestampAfter?: string;
  timestampBefore?: string;
  branch: string;
  source?: string;
}

interface RememberInput {
  path: string;
  session_id?: string;
  message_start?: string;
  message_end?: string;
  summary: string;
  project?: string;
  anchors?: unknown;
}

interface ForgetInput {
  id: string;
  reason: string;
}

function normalizeOpts(optsOrScalar: QueryOptions | string | number | null | undefined, scalarKey = 'sessionId'): QueryOptions {
  if (optsOrScalar == null) return {};
  if (typeof optsOrScalar === 'string') return { [scalarKey]: optsOrScalar };
  if (typeof optsOrScalar === 'number') return { limit: optsOrScalar };
  return optsOrScalar;
}

function buildWhere(opts: QueryOptions, aliases: ColumnAliases) {
  const clauses: string[] = [];
  const params: any[] = [];
  if (opts.sessionId) { clauses.push(`${aliases.sessionId} = ?`); params.push(opts.sessionId); }
  if (opts.sessions?.length) {
    clauses.push(`${aliases.sessionId} IN (${opts.sessions.map(() => '?').join(',')})`);
    params.push(...opts.sessions);
  }
  if (opts.project) { clauses.push(`${aliases.project} LIKE ?`); params.push(opts.project); }
  if (opts.after) { clauses.push(`${aliases.timestampAfter ?? aliases.timestamp} > ?`); params.push(opts.after); }
  if (opts.before) { clauses.push(`${aliases.timestampBefore ?? aliases.timestamp} < ?`); params.push(opts.before); }
  if (opts.branch) { clauses.push(`${aliases.branch} = ?`); params.push(opts.branch); }
  if (opts.source && opts.source !== 'all' && aliases.source) {
    clauses.push(`COALESCE(${aliases.source}, 'claude') = ?`);
    params.push(opts.source);
  }
  return { where: clauses.length ? clauses.join(' AND ') : '1=1', params };
}

const BASH_EXIT_PAT = 'Exit code %';

type QueryVisibility = 'visible' | 'inactive' | 'hidden';

function normalizedVisibility(value: unknown): QueryVisibility {
  if (value === null || value === undefined || value === 'visible') return 'visible';
  if (value === 'inactive') return 'inactive';
  return 'hidden';
}

function withVisibility(row: DbRow): DbRow {
  return { ...row, visibility: normalizedVisibility(row.visibility) };
}

function isQueryableMessage(
  row: DbRow | undefined,
  includeInactive = false,
): row is DbRow {
  if (row === undefined) return false;
  const visibility = normalizedVisibility(row.visibility);
  return visibility === 'visible' || (includeInactive && visibility === 'inactive');
}

function visibilitySql(alias: string, includeInactive = false): string {
  const column = `${alias}.visibility`;
  return includeInactive
    ? `COALESCE(${column},'visible') IN ('visible','inactive')`
    : `COALESCE(${column},'visible')='visible'`;
}

// #107: the read-only contract follows the statement's actual database
// effects instead of scanning the SQL text for mutation keywords (which
// false-positive on literals, comments, and quoted identifiers).
const READ_ONLY_SQL_MESSAGE = 'sql() only supports read-only SELECT/WITH queries';
const MULTI_STATEMENT_SQL_MESSAGE =
  'sql() accepts exactly one SQL statement per call; split multiple statements into separate sql() calls';

// The lexical prefix check stays: it is the cheap, stable entry contract and
// it keeps statement-level PRAGMA (allowed by the authorizer for pragma
// table-valued functions) out of the sandbox.
function assertReadOnlySqlPrefix(text: string): void {
  if (!/^\s*(SELECT|WITH)\b/i.test(text)) {
    throw new Error(READ_ONLY_SQL_MESSAGE);
  }
}

// Write and schema-mutation action codes from SQLite's authorizer API
// (sqlite3_set_authorizer). Everything not listed — SELECT, READ, FUNCTION,
// TRANSACTION, PRAGMA, RECURSIVE, and any future read action — is allowed by
// default: a denylist cannot false-positive on read syntax the way the old
// keyword scan did, and the read-only connection opened by openReadDb()
// remains the final mutation boundary for anything missed here. DENY is the
// only correct rejection code: SQLITE_IGNORE on SQLITE_READ would silently
// null out columns instead of failing.
const DENIED_SQLITE_ACTIONS: ReadonlySet<number> = new Set([
  sqliteConstants.SQLITE_INSERT,
  sqliteConstants.SQLITE_UPDATE,
  sqliteConstants.SQLITE_DELETE,
  sqliteConstants.SQLITE_CREATE_INDEX,
  sqliteConstants.SQLITE_CREATE_TABLE,
  sqliteConstants.SQLITE_CREATE_TEMP_INDEX,
  sqliteConstants.SQLITE_CREATE_TEMP_TABLE,
  sqliteConstants.SQLITE_CREATE_TEMP_TRIGGER,
  sqliteConstants.SQLITE_CREATE_TEMP_VIEW,
  sqliteConstants.SQLITE_CREATE_TRIGGER,
  sqliteConstants.SQLITE_CREATE_VIEW,
  sqliteConstants.SQLITE_CREATE_VTABLE,
  sqliteConstants.SQLITE_DROP_INDEX,
  sqliteConstants.SQLITE_DROP_TABLE,
  sqliteConstants.SQLITE_DROP_TEMP_INDEX,
  sqliteConstants.SQLITE_DROP_TEMP_TABLE,
  sqliteConstants.SQLITE_DROP_TEMP_TRIGGER,
  sqliteConstants.SQLITE_DROP_TEMP_VIEW,
  sqliteConstants.SQLITE_DROP_TRIGGER,
  sqliteConstants.SQLITE_DROP_VIEW,
  sqliteConstants.SQLITE_DROP_VTABLE,
  sqliteConstants.SQLITE_ALTER_TABLE,
  sqliteConstants.SQLITE_REINDEX,
  sqliteConstants.SQLITE_ANALYZE,
  sqliteConstants.SQLITE_ATTACH,
  sqliteConstants.SQLITE_DETACH,
  sqliteConstants.SQLITE_SAVEPOINT,
]);

// Prepare-time semantic classification. node:sqlite exposes the authorizer;
// better-sqlite3 does not, and there statement classification happens through
// the statement's readonly flag in assertReadOnlyStatement below.
function installWriteDenylist(db: SqliteDb): void {
  if (typeof db.setAuthorizer !== 'function') return;
  db.setAuthorizer((action) =>
    DENIED_SQLITE_ACTIONS.has(action) ? sqliteConstants.SQLITE_DENY : sqliteConstants.SQLITE_OK);
}

// better-sqlite3 path: no authorizer, but prepare() already rejected
// multi-statement input and the readonly flag classifies write effects.
function assertReadOnlyStatement(stmt: SqliteStatement): void {
  if (stmt.readonly === false) throw new Error(READ_ONLY_SQL_MESSAGE);
}

// A tail is inert only when it is whitespace and comments — no quotes to
// track, because anything else is a second statement SQLite never compiled
// (node:sqlite prepare compiles the first statement and silently ignores the
// rest, so this check is what makes multi-statement input fail clearly).
function isBlankOrCommentTail(text: string): boolean {
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') { i += 1; continue; }
    if (ch === '-' && text[i + 1] === '-') {
      const end = text.indexOf('\n', i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) return false;
      i = end + 2;
      continue;
    }
    return false;
  }
  return true;
}

function assertSingleStatement(sqlText: string, stmt: SqliteStatement): void {
  if (typeof stmt.sourceSQL !== 'string') return;
  if (!isBlankOrCommentTail(sqlText.slice(stmt.sourceSQL.length))) {
    throw new Error(MULTI_STATEMENT_SQL_MESSAGE);
  }
}

function prepareReadOnlyStatement(db: SqliteDb, sqlText: string): SqliteStatement {
  let stmt: SqliteStatement;
  try {
    stmt = db.prepare(sqlText);
  } catch (error) {
    // node:sqlite reports an authorizer denial as SQLITE_AUTH ("not
    // authorized"); surface the sandbox contract instead of the raw code.
    if (error instanceof Error && /not authorized/i.test(error.message)) {
      throw new Error(READ_ONLY_SQL_MESSAGE, { cause: error });
    }
    throw error;
  }
  assertReadOnlyStatement(stmt);
  assertSingleStatement(sqlText, stmt);
  return stmt;
}

const CJK_TEXT_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function assertEnglishMemoryText(value: unknown, label: string): void {
  const text = String(value || '');
  if (!text.trim()) return;
  if (CJK_TEXT_RE.test(text)) {
    const requirement = label.includes('query') ? 'must use English terms' : 'must be written in English';
    throw new Error(`${label} ${requirement}; translate user-language terms before using the memory layer`);
  }
}

function buildSafeFtsQuery(text: unknown): string {
  const tokens = String(text || '').match(/[\p{Letter}\p{Number}]+/gu) || [];
  return tokens
    .slice(0, 12)
    .map(token => `"${token}"`)
    .join(' ');
}

function createQueryApi(
  db: SqliteDb,
  {
    providerRegistry = createBuiltinProviderRegistry(),
    invokingSessionId = null,
  }: { providerRegistry?: ProviderRegistry; invokingSessionId?: string | null } = {},
) {
  installWriteDenylist(db);
  const q = (sql: string, ...p: any[]) => {
    const text = String(sql || '');
    assertReadOnlySqlPrefix(text);
    return prepareReadOnlyStatement(db, text).all(...p);
  };

  const normalizeOverviewOpts = (optsOrScalar: QueryOptions | string | number | null | undefined): QueryOptions => {
    if (optsOrScalar == null) return {};
    if (typeof optsOrScalar === 'string') return { project: optsOrScalar };
    if (typeof optsOrScalar === 'number') return { limit: optsOrScalar };
    return optsOrScalar;
  };

  const search = (text: string, opts: QueryOptions = {}) => {
    const {
      limit = 20,
      sessionId,
      project,
      after,
      before,
      cwd,
      source,
      includeMeta = false,
      includeInactive = false,
    } = opts;
    let where = 'WHERE mf.text MATCH ?';
    const filterParams: any[] = [];
    if (sessionId) { where += ' AND mf.session_id=?'; filterParams.push(sessionId); }
    if (project)   { where += ' AND s.project LIKE ?'; filterParams.push(project); }
    if (after)     { where += ' AND m.timestamp>?';    filterParams.push(after); }
    if (before)    { where += ' AND m.timestamp<?';    filterParams.push(before); }
    if (cwd)       { where += ' AND m.cwd LIKE ?';     filterParams.push(cwd); }
    if (source && source !== 'all') { where += " AND COALESCE(m.source, s.source, 'claude')=?"; filterParams.push(source); }
    if (!includeMeta) where += ' AND COALESCE(m.is_meta,0)=0';
    where += ` AND ${visibilitySql('m', includeInactive)}`;
    const stmt = db.prepare(`
      SELECT m.uuid,m.session_id,m.text,m.content_type,m.is_meta,m.role,m.timestamp,m.model,m.cwd,
             COALESCE(m.visibility,'visible') AS visibility,m.source as m_source,
             s.id as s_id,s.title as s_title,s.project as s_project,s.started_at as s_started,
             s.source as s_source,
             rank
      FROM messages_fts mf JOIN messages m ON m.uuid=mf.uuid LEFT JOIN sessions s ON s.id=m.session_id
      ${where} ORDER BY rank LIMIT ?`);
    const runMatch = (matchText: string): DbRow[] => stmt.all(matchText, ...filterParams, limit);
    // Honor raw FTS5 syntax when the query is valid, but never crash on ordinary
    // input (hyphens, punctuation) that FTS5 would parse as operators: fall back
    // to safe per-token quoting, the same tokenization memories() uses.
    let rows;
    try {
      rows = runMatch(text);
    } catch {
      const safe = buildSafeFtsQuery(text);
      rows = safe ? runMatch(safe) : [];
    }
    return rows.map((r: DbRow) => {
      const metaClause = includeMeta ? '' : 'AND COALESCE(is_meta,0)=0';
      const ctx = db.prepare(
        `SELECT uuid,text,content_type,is_meta,role,timestamp,model,
                COALESCE(visibility,'visible') AS visibility,
                COALESCE(source, 'claude') as source
         FROM messages
         WHERE session_id=? AND uuid!=? ${metaClause}
           AND ${visibilitySql('messages', includeInactive)}
         ORDER BY ABS(JULIANDAY(timestamp)-JULIANDAY(?))
         LIMIT 6`
      ).all(r.session_id, r.uuid, r.timestamp)
        .map(withVisibility)
        .sort((a: DbRow, b: DbRow) => a.timestamp < b.timestamp ? -1 : 1);
      const sourceValue = r.m_source || r.s_source || 'claude';
      const session: DbRow = { id: r.s_id, title: r.s_title, project: r.s_project, started_at: r.s_started, source: r.s_source || sourceValue };
      // is_invoking marks the session that ran this query; it is the agent's
      // own live context, not independent historical evidence.
      if (invokingSessionId && r.s_id === invokingSessionId) session.is_invoking = true;
      return {
        message: {
          uuid: r.uuid,
          text: r.text,
          content_type: r.content_type,
          is_meta: r.is_meta || 0,
          role: r.role,
          timestamp: r.timestamp,
          model: r.model,
          cwd: r.cwd,
          visibility: normalizedVisibility(r.visibility),
          source: sourceValue,
        },
        session,
        rank: r.rank,
        context: ctx,
      };
    });
  };

  const context = (uuid: string, opts: QueryOptions = {}) => {
    const includeInactive = opts.includeInactive === true;
    const msg = db.prepare('SELECT * FROM messages WHERE uuid=?').get(uuid);
    if (!isQueryableMessage(msg, includeInactive)) return null;
    const message = withVisibility(msg);
    const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(msg.session_id);
    const chain: DbRow[] = [];
    let cur: DbRow | undefined = msg;
    while (cur?.parent_uuid) {
      cur = db.prepare('SELECT * FROM messages WHERE uuid=?').get(cur.parent_uuid);
      if (isQueryableMessage(cur, includeInactive)) chain.unshift(withVisibility(cur));
    }
    const subagent = msg.agent_id ? db.prepare('SELECT * FROM subagents WHERE agent_id=?').get(msg.agent_id) : null;
    let workflow = null;
    if (msg.agent_id) {
      const wa = db.prepare('SELECT * FROM workflow_agents WHERE agent_id=?').get(msg.agent_id);
      if (wa) workflow = db.prepare('SELECT * FROM workflows WHERE run_id=?').get(wa.run_id);
    }
    return { message, parentChain: chain, session, subagent, workflow };
  };

  const trace = (uuid: string, opts: QueryOptions = {}) => {
    const includeInactive = opts.includeInactive === true;
    const chain: DbRow[] = [];
    let cur = db.prepare('SELECT * FROM messages WHERE uuid=?').get(uuid);
    if (!isQueryableMessage(cur, includeInactive)) return chain;
    while (cur) {
      if (isQueryableMessage(cur, includeInactive)) chain.unshift(withVisibility(cur));
      cur = cur.parent_uuid ? db.prepare('SELECT * FROM messages WHERE uuid=?').get(cur.parent_uuid) : undefined;
    }
    return chain;
  };

  const thread = (sid: string, opts: QueryOptions = {}) => {
    const includeMeta = opts?.includeMeta === true;
    const includeInactive = opts?.includeInactive === true;
    const metaClause = includeMeta ? '' : 'AND COALESCE(is_meta,0)=0';
    return db.prepare(`
      SELECT * FROM messages
      WHERE session_id=? ${metaClause}
        AND ${visibilitySql('messages', includeInactive)}
      ORDER BY timestamp
    `).all(sid).map(withVisibility);
  };

  const subagents = (optsOrSid?: QueryOptions | string) => {
    const opts = normalizeOpts(optsOrSid);
    const { limit = 100 } = opts;
    const needsJoin = opts.project || opts.branch || opts.source;
    // The subagents table has no timestamp column; scope time filters by the
    // subagent's activity interval instead of comparing session IDs. `after`
    // matches agents still active past the bound (latest message), `before`
    // matches agents already started by the bound (earliest message), so
    // combined bounds select every agent active during the window.
    const firstMessageAt = '(SELECT MIN(m.timestamp) FROM messages m WHERE m.agent_id = sa.agent_id)';
    const lastMessageAt = '(SELECT MAX(m.timestamp) FROM messages m WHERE m.agent_id = sa.agent_id)';
    const { where, params } = buildWhere(opts, { sessionId: 'sa.session_id', project: 's.project', timestamp: firstMessageAt, timestampAfter: lastMessageAt, timestampBefore: firstMessageAt, branch: 's.git_branch', source: 's.source' });
    params.push(limit);
    const join = needsJoin ? 'LEFT JOIN sessions s ON s.id=sa.session_id' : '';
    return db.prepare(`SELECT sa.* FROM subagents sa ${join} WHERE ${where} LIMIT ?`).all(...params).map((r: DbRow) => {
      const c = db.prepare('SELECT COUNT(*) as c FROM messages WHERE agent_id=?').get(r.agent_id);
      return { ...r, messageCount: c?.c || 0 };
    });
  };

  const workflows = (optsOrSid?: QueryOptions | string) => {
    const opts = normalizeOpts(optsOrSid);
    const { limit = 100 } = opts;
    const needsJoin = opts.project || opts.branch || opts.source;
    const { where, params } = buildWhere(opts, { sessionId: 'w.session_id', project: 's.project', timestamp: 'w.timestamp', branch: 's.git_branch', source: 's.source' });
    params.push(limit);
    const join = needsJoin ? 'LEFT JOIN sessions s ON s.id=w.session_id' : '';
    return db.prepare(`SELECT w.* FROM workflows w ${join} WHERE ${where} ORDER BY w.timestamp DESC LIMIT ?`).all(...params);
  };

  const workflowTree = (runId: string) => {
    const wf = db.prepare('SELECT * FROM workflows WHERE run_id=?').get(runId);
    if (!wf) return null;
    let result = null;
    try { result = JSON.parse(wf.result_json); } catch { /* keep the raw result nullable */ }
    const agents = db.prepare('SELECT * FROM workflow_agents WHERE run_id=?').all(runId).map((a: DbRow) => {
      const mc = db.prepare('SELECT COUNT(*) as c FROM messages WHERE agent_id=?').get(a.agent_id);
      return { ...a, messageCount: mc?.c || 0 };
    });
    return { ...wf, result, agents };
  };

  const fileHistory = (fp: string, opts: QueryOptions = {}) => {
    const { limit = 200, after, before, source, includeInactive = false } = opts;
    let where = `tc.file_path=? AND ${visibilitySql('m', includeInactive)}`;
    const params: any[] = [fp];
    if (after)  { where += ' AND m.timestamp > ?'; params.push(after); }
    if (before) { where += ' AND m.timestamp < ?'; params.push(before); }
    if (source && source !== 'all') { where += " AND COALESCE(s.source, 'claude') = ?"; params.push(source); }
    params.push(limit);
    return db.prepare(
      `SELECT tc.*,s.title as s_title,s.project as s_project,m.timestamp as ts,
              COALESCE(m.visibility,'visible') AS visibility
       FROM tool_calls tc
       LEFT JOIN sessions s ON s.id=tc.session_id
       LEFT JOIN messages m ON m.uuid=tc.message_uuid
       WHERE ${where}
       ORDER BY m.timestamp
       LIMIT ?`
    ).all(...params).map((r: DbRow) => ({
      toolCall: { id: r.id, message_uuid: r.message_uuid, name: r.name, input_json: r.input_json },
      session: { id: r.session_id, title: r.s_title, project: r.s_project },
      timestamp: r.ts,
      visibility: normalizedVisibility(r.visibility),
    }));
  };

  const failures = (optsOrSid?: QueryOptions | string) => {
    const opts = normalizeOpts(optsOrSid);
    const { limit = 50 } = opts;
    const includeInactive = opts.includeInactive === true;
    const needsJoin = opts.project || opts.branch || opts.source;
    const { where, params: filterParams } = buildWhere(opts, { sessionId: 'tr.session_id', project: 's.project', timestamp: 'rm.timestamp', branch: 's.git_branch', source: 's.source' });
    const join = needsJoin ? 'LEFT JOIN sessions s ON s.id=tr.session_id' : '';
    const errorCond = [
      `(tr.is_error = 1 OR tr.content LIKE '${BASH_EXIT_PAT}')`,
      visibilitySql('rm', includeInactive),
      visibilitySql('cm', includeInactive),
    ].join(' AND ');
    const allParams = [...filterParams, limit];
    const rows = db.prepare(`
      SELECT tr.*,
        CASE
          WHEN COALESCE(rm.visibility,'visible') = 'inactive'
            OR COALESCE(cm.visibility,'visible') = 'inactive'
          THEN 'inactive'
          ELSE 'visible'
        END AS visibility
      FROM tool_results tr
      LEFT JOIN messages rm ON rm.uuid=tr.message_uuid
      LEFT JOIN tool_calls tc ON tc.id=tr.tool_use_id
      LEFT JOIN messages cm ON cm.uuid=tc.message_uuid
      ${join}
      WHERE ${errorCond} AND ${where}
      ORDER BY rm.timestamp DESC
      LIMIT ?
    `).all(...allParams);
    return rows.map((r: DbRow) => {
      const tc = db.prepare('SELECT * FROM tool_calls WHERE id=?').get(r.tool_use_id);
      const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(r.session_id);
      const rmRow = db.prepare('SELECT * FROM messages WHERE uuid=?').get(r.message_uuid);
      const rm = rmRow === undefined ? undefined : withVisibility(rmRow);
      const next = rm?.timestamp ? db.prepare(`
        SELECT * FROM messages
        WHERE session_id=? AND timestamp>?
          AND ${visibilitySql('messages', includeInactive)}
        ORDER BY timestamp
        LIMIT 3
      `).all(r.session_id, rm.timestamp).map(withVisibility) : [];
      return {
        toolCall: tc,
        result: withVisibility(r),
        session,
        nextMessages: next,
        visibility: normalizedVisibility(r.visibility),
      };
    });
  };

  const sessions = (optsOrN?: QueryOptions | number | string) => {
    const opts = normalizeOpts(optsOrN, 'sessionId');
    const { limit = 50 } = opts;
    const { where, params } = buildWhere(opts, { sessionId: 's.id', project: 's.project', timestamp: 's.started_at', branch: 's.git_branch', source: 's.source' });
    params.push(limit);
    return db.prepare(`SELECT * FROM sessions s WHERE ${where} ORDER BY ended_at DESC LIMIT ?`).all(...params)
      .map((row: DbRow) => invokingSessionId && row.id === invokingSessionId ? { ...row, is_invoking: true } : row);
  };

  const recent = (n = 10) => sessions({ limit: n });

  const summaries = (optsOrSid?: QueryOptions | string) => {
    const opts = normalizeOpts(optsOrSid);
    const { limit = 100 } = opts;
    const includeInactive = opts.includeInactive === true;
    const { where, params } = buildWhere(opts, { sessionId: 'su.session_id', project: 's.project', timestamp: 'su.timestamp', branch: 's.git_branch', source: 's.source' });
    params.push(limit);
    return db.prepare(`
      SELECT su.*, s.title as session_title, s.project
      FROM summaries su
      LEFT JOIN sessions s ON s.id=su.session_id
      WHERE ${where} AND ${visibilitySql('su', includeInactive)}
      ORDER BY su.timestamp DESC
      LIMIT ?
    `).all(...params).map(withVisibility);
  };

  const overview = (optsOrScalar?: QueryOptions | string | number) => {
    const opts = normalizeOverviewOpts(optsOrScalar);
    const cwd = process.cwd();
    const sessionLimit = opts.limit ?? 8;
    const projectLimit = opts.projectLimit ?? 20;
    const memoryLimit = opts.memoryLimit ?? 100;

    const projectDescriptor = (row: DbRow | null, source: string, confidence: string) => row ? ({
      project: row.project,
      project_path: row.project_path || null,
      source,
      confidence,
    }) : null;

    const latestProjectByPattern = (pattern: string): DbRow | undefined => {
      const fromSessions = db.prepare(`
        SELECT project, project_path
        FROM sessions
        WHERE project LIKE ?
        ORDER BY COALESCE(ended_at, started_at) DESC
        LIMIT 1
      `).get(pattern);
      if (fromSessions) return fromSessions;
      return db.prepare(`
        SELECT project, NULL AS project_path
        FROM memories
        WHERE project LIKE ?
        ORDER BY created_at DESC
        LIMIT 1
      `).get(pattern);
    };

    const resolveCurrentProject = () => {
      if (opts.project) {
        const row = latestProjectByPattern(opts.project);
        const confidence = row ? (/[%_]/.test(opts.project) ? 'inferred' : 'exact') : 'unknown';
        return projectDescriptor(row || { project: opts.project, project_path: null }, 'opts', confidence);
      }

      const paths = db.prepare(`
        SELECT project, project_path, MAX(COALESCE(ended_at, started_at)) AS last_seen
        FROM sessions
        WHERE project IS NOT NULL AND project_path IS NOT NULL AND project_path != ''
        GROUP BY project, project_path
      `).all();
      const byProjectPath = paths
        .filter((r: DbRow) => cwd === r.project_path || cwd.startsWith(r.project_path + sep))
        .sort((a: DbRow, b: DbRow) => b.project_path.length - a.project_path.length || String(b.last_seen || '').localeCompare(String(a.last_seen || '')))[0];
      if (byProjectPath) return projectDescriptor(byProjectPath, 'cwd_project_path', 'exact');

      const byMessageCwd = db.prepare(`
        SELECT s.project, s.project_path, MAX(m.timestamp) AS last_seen
        FROM messages m
        LEFT JOIN sessions s ON s.id=m.session_id
        WHERE m.cwd = ? AND s.project IS NOT NULL
        GROUP BY s.project, s.project_path
        ORDER BY last_seen DESC
        LIMIT 1
      `).get(cwd);
      if (byMessageCwd) return projectDescriptor(byMessageCwd, 'cwd_messages', 'inferred');

      return null;
    };

    const projects = db.prepare(`
      WITH names AS (
        SELECT project FROM sessions WHERE project IS NOT NULL GROUP BY project
        UNION
        SELECT project FROM memories WHERE project IS NOT NULL AND deleted_at IS NULL GROUP BY project
      ),
      session_stats AS (
        SELECT project, COUNT(*) AS session_count, MAX(COALESCE(ended_at, started_at)) AS last_session_at
        FROM sessions
        WHERE project IS NOT NULL
        GROUP BY project
      ),
      memory_stats AS (
        SELECT project, COUNT(*) AS memory_count, MAX(created_at) AS last_memory_at
        FROM memories
        WHERE project IS NOT NULL AND deleted_at IS NULL
        GROUP BY project
      )
      SELECT
        n.project,
        (
          SELECT s2.project_path
          FROM sessions s2
          WHERE s2.project = n.project AND s2.project_path IS NOT NULL
          ORDER BY COALESCE(s2.ended_at, s2.started_at) DESC
          LIMIT 1
        ) AS project_path,
        COALESCE(ss.session_count, 0) AS session_count,
        COALESCE(ms.memory_count, 0) AS memory_count,
        ss.last_session_at,
        ms.last_memory_at
      FROM names n
      LEFT JOIN session_stats ss ON ss.project = n.project
      LEFT JOIN memory_stats ms ON ms.project = n.project
      ORDER BY COALESCE(ss.last_session_at, ms.last_memory_at) DESC
      LIMIT ?
    `).all(projectLimit).map((row: DbRow) => {
      const branches = db.prepare(`
        SELECT git_branch
        FROM sessions
        WHERE project = ? AND git_branch IS NOT NULL AND git_branch != ''
        GROUP BY git_branch
        ORDER BY MAX(COALESCE(ended_at, started_at)) DESC
        LIMIT 5
      `).all(row.project).map((r: DbRow) => r.git_branch);
      return { ...row, recent_branches: branches };
    });

    const currentProject = resolveCurrentProject();
    let current_project = null;
    if (currentProject?.project) {
      const sessionTotal = db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE project = ?').get(currentProject.project)?.c || 0;
      const sessionsForProject = db.prepare(`
        SELECT id, title, project, project_path, started_at, ended_at, git_branch, message_count, COALESCE(source, 'claude') AS source
        FROM sessions
        WHERE project = ?
        ORDER BY COALESCE(ended_at, started_at) DESC
        LIMIT ?
      `).all(currentProject.project, sessionLimit);
      const memoryTotal = db.prepare('SELECT COUNT(*) AS c FROM memories WHERE project = ? AND deleted_at IS NULL').get(currentProject.project)?.c || 0;
      const memoriesForProject = db.prepare(`
        SELECT id, path, anchors, summary, session_id, project, created_at
        FROM memories
        WHERE project = ? AND deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT ?
      `).all(currentProject.project, memoryLimit);
      current_project = {
        project: currentProject.project,
        project_path: currentProject.project_path,
        session_total: sessionTotal,
        sessions: sessionsForProject,
        memory_total: memoryTotal,
        memories: memoriesForProject,
      };
    }

    const totalProjects = db.prepare(`
      SELECT COUNT(*) AS c
      FROM (
        SELECT project FROM sessions WHERE project IS NOT NULL GROUP BY project
        UNION
        SELECT project FROM memories WHERE project IS NOT NULL AND deleted_at IS NULL GROUP BY project
      )
    `).get()?.c || 0;
    const totalSessions = db.prepare('SELECT COUNT(*) AS c FROM sessions').get()?.c || 0;
    const totalMemories = db.prepare('SELECT COUNT(*) AS c FROM memories WHERE deleted_at IS NULL').get()?.c || 0;
    const sources = db.prepare(`
      SELECT COALESCE(source, 'claude') AS source,
             COUNT(*) AS session_count,
             MAX(COALESCE(ended_at, started_at)) AS last_session_at
      FROM sessions
      GROUP BY COALESCE(source, 'claude')
      ORDER BY last_session_at DESC
    `).all();

    return {
      current: {
        cwd,
        project: currentProject,
        // The session that invoked this query, when the invocation nonce
        // resolved to exactly one indexed session; null when unknown.
        session_id: invokingSessionId || null,
      },
      current_project,
      projects,
      totals: {
        projects: totalProjects,
        sessions: totalSessions,
        memories: totalMemories,
        sources,
      },
    };
  };

  const raw = (
    messageUuid: string,
    opts: { offset?: number; limit?: number; includeInactive?: boolean } = {},
  ) => {
    const { offset = 0, limit = 10000, includeInactive = false } = opts;
    const message = db.prepare('SELECT * FROM messages WHERE uuid=?').get(messageUuid);
    if (!isQueryableMessage(message, includeInactive)) return null;
    const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(message.session_id) ?? null;
    const subagent = message.agent_id
      ? db.prepare('SELECT * FROM subagents WHERE agent_id=?').get(message.agent_id) ?? null
      : null;
    const workflowAgent = message.agent_id
      ? db.prepare('SELECT * FROM workflow_agents WHERE agent_id=?').get(message.agent_id) ?? null
      : null;
    const source = message.source || session?.source || 'claude';
    const record = providerRegistry.raw({
      source,
      messageUuid,
      session,
      agentId: message.agent_id || null,
      cursor: storedSessionCursor(db, providerRegistry, session),
      subagent,
      workflowAgent,
    });
    if (record === null) return null;
    const totalLength = record.totalLength ?? record.text.length;
    return {
      text: record.text.slice(offset, offset + limit),
      totalLength,
      offset,
      limit,
      hasMore: offset + limit < totalLength,
      visibility: normalizedVisibility(message.visibility),
    };
  };

  const memories = (optsOrSid?: QueryOptions | string) => {
    const opts = normalizeOpts(optsOrSid);
    const { limit = 50, query } = opts;
    assertEnglishMemoryText(query, 'memories() query');
    const needsJoin = opts.branch || opts.source;
    const { where: baseWhere, params } = buildWhere(opts, {
      sessionId: 'mem.session_id',
      project: 'mem.project',
      timestamp: 'mem.created_at',
      branch: 's.git_branch',
      source: 's.source',
    });
    const where = baseWhere + ' AND mem.deleted_at IS NULL';
    const join = needsJoin ? 'LEFT JOIN sessions s ON s.id=mem.session_id' : '';
    const hasQuery = String(query || '').trim().length > 0;
    const ftsQuery = buildSafeFtsQuery(query);
    if (!hasQuery) {
      params.push(limit);
      return db.prepare(`SELECT mem.* FROM memories mem ${join} WHERE ${where} ORDER BY mem.created_at DESC LIMIT ?`).all(...params);
    }
    if (!ftsQuery) return [];
    params.unshift(ftsQuery);
    params.push(limit);
    return db.prepare(`
      SELECT mem.*, mf.rank AS rank
      FROM memories_fts mf
      JOIN memories mem ON mem.rowid = mf.rowid
      ${join}
      WHERE memories_fts MATCH ? AND ${where}
      ORDER BY mf.rank, mem.created_at DESC
      LIMIT ?
    `).all(...params);
  };

  return { sql: q, search, context, trace, thread, subagents, workflows, workflowTree, fileHistory, failures, sessions, recent, summaries, raw, memories, overview };
}

function createAttuneApi(db: SqliteDb, runMutation: <T>(work: () => T) => T = (work) => work()) {
  const resolveMemoryPath = (memoryPath: string, sessionId?: string): string => {
    let base = null;
    if (sessionId) {
      base = db.prepare('SELECT project_path FROM sessions WHERE id=?').get(sessionId)?.project_path || null;
    }
    const resolved = isAbsolute(memoryPath)
      ? normalize(memoryPath)
      : resolve(base || process.cwd(), memoryPath);
    let stat;
    try {
      stat = statSync(resolved);
    } catch {
      throw new Error(`remember() memory file does not exist: ${resolved}`);
    }
    if (!stat.isFile()) throw new Error(`remember() memory path is not a file: ${resolved}`);
    return resolved;
  };

  const normalizeAnchors = (anchors: unknown): string | null => {
    if (anchors == null) return null;
    let parsed = anchors;
    if (typeof anchors === 'string') {
      const trimmed = anchors.trim();
      if (!trimmed) return null;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw new Error('remember() anchors must be a JSON array');
      }
    }
    if (!Array.isArray(parsed)) throw new Error('remember() anchors must be an array');
    for (const anchor of parsed) {
      if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) {
        throw new Error('remember() anchors entries must be objects');
      }
    }
    return parsed.length ? JSON.stringify(parsed) : null;
  };

  const remember = ({ path: memoryPath, session_id, message_start, message_end, summary, project, anchors }: RememberInput) => {
    if (!memoryPath || !summary) throw new Error('remember() requires path and summary');
    assertEnglishMemoryText(summary, 'remember() summary');
    const normalizedPath = resolveMemoryPath(memoryPath, session_id);
    const normalizedAnchors = normalizeAnchors(anchors);
    const proj = project || db.prepare('SELECT project FROM sessions WHERE id=?').get(session_id)?.project || null;
    const created_at = new Date().toISOString();
    // Plain INSERT, never OR REPLACE: a memory id must not silently overwrite
    // an existing memory. Collisions regenerate instead of losing data.
    let id = `mem-${randomUUID()}`;
    runMutation(() => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          db.prepare('INSERT INTO memories (id, session_id, project, message_start, message_end, path, anchors, summary, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(
            id, session_id || null, proj, message_start || null, message_end || null, normalizedPath, normalizedAnchors, summary, created_at);
          return;
        } catch (error) {
          // Primary-key collision: regenerate the id and retry. Any other
          // constraint or error propagates unchanged.
          const errcode = (error as { errcode?: unknown })?.errcode;
          if (attempt < 2 && errcode === SQLITE_CONSTRAINT_PRIMARYKEY) {
            id = `mem-${randomUUID()}`;
            continue;
          }
          throw error;
        }
      }
    });
    return { id, path: normalizedPath, project: proj, anchors: normalizedAnchors, created_at };
  };

  const forget = ({ id, reason }: ForgetInput) => {
    const deletionReason = String(reason || '').trim();
    if (!id || !deletionReason) throw new Error('forget() requires id and reason');
    // Read, decide, and update in one write transaction: a concurrent forget
    // must observe the deleted state, not overwrite another forget's reason.
    return runMutation(() => {
      const row = db.prepare('SELECT id, deleted_at, deleted_reason FROM memories WHERE id=?').get(id);
      if (!row) throw new Error(`forget() memory not found: ${id}`);
      if (row.deleted_at) {
        return { id, deleted_at: row.deleted_at, deleted_reason: row.deleted_reason, already_deleted: true };
      }
      const deleted_at = new Date().toISOString();
      db.prepare('UPDATE memories SET deleted_at=?, deleted_reason=? WHERE id=?').run(deleted_at, deletionReason, id);
      return { id, deleted_at, deleted_reason: deletionReason };
    });
  };

  return { remember, forget };
}

export { createQueryApi, createAttuneApi };
