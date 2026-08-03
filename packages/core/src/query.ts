// Query and attune sandbox helpers for the Core package.
import { fs, path } from './db.ts';
import { createBuiltinProviderRegistry } from './providers/builtins.ts';
import type { ProviderRegistry } from './providers/registry.ts';
import type { SqliteDb, SqliteRow } from './sqlite-types.ts';

type DbRow = SqliteRow;

interface QueryOptions extends Record<string, any> {
  limit?: number;
  sessionId?: string;
  sessions?: string[];
  excludeSession?: string | string[];
  project?: string;
  after?: string;
  before?: string;
  cwd?: string;
  branch?: string;
  source?: string;
  includeMeta?: boolean;
  query?: string;
  projectLimit?: number;
  memoryLimit?: number;
}

interface ColumnAliases {
  sessionId: string;
  project: string;
  timestamp: string;
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
  if (opts.after) { clauses.push(`${aliases.timestamp} > ?`); params.push(opts.after); }
  if (opts.before) { clauses.push(`${aliases.timestamp} < ?`); params.push(opts.before); }
  if (opts.branch) { clauses.push(`${aliases.branch} = ?`); params.push(opts.branch); }
  if (opts.source && opts.source !== 'all' && aliases.source) {
    clauses.push(`COALESCE(${aliases.source}, 'claude') = ?`);
    params.push(opts.source);
  }
  return { where: clauses.length ? clauses.join(' AND ') : '1=1', params };
}

// Most sessions carry no title: current Claude Code versions stopped writing
// `ai-title` transcript rows and dropped `title` from history.jsonl, so the two
// upstream title sources are usually absent (96% null on a real index). Derive a
// navigable label from the opening user message instead of returning null.
// Command envelopes (`<command-message>…`) are skipped: they name the slash
// command, not the task.
function titleExpr(alias: string): string {
  return `COALESCE(NULLIF(${alias}.title, ''), (
    SELECT substr(replace(replace(m_t.text, char(10), ' '), char(13), ' '), 1, 80)
    FROM messages m_t
    WHERE m_t.session_id = ${alias}.id AND m_t.role = 'user' AND m_t.content_type = 'text'
      AND COALESCE(m_t.is_meta, 0) = 0 AND m_t.text IS NOT NULL AND m_t.text <> ''
      AND m_t.text NOT LIKE '<command-%'
    ORDER BY m_t.timestamp LIMIT 1))`;
}

const BASH_EXIT_PAT = 'Exit code %';

function assertReadOnlySql(sql: unknown): void {
  const text = String(sql || '').trim();
  if (!/^(SELECT|WITH)\b/i.test(text)) {
    throw new Error('sql() only supports read-only SELECT/WITH queries');
  }
  if (/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|VACUUM|ATTACH|DETACH)\b/i.test(text)) {
    throw new Error('sql() only supports read-only SELECT/WITH queries');
  }
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
  { providerRegistry = createBuiltinProviderRegistry() }: { providerRegistry?: ProviderRegistry } = {},
) {
  const q = (sql: string, ...p: any[]) => {
    assertReadOnlySql(sql);
    return db.prepare(sql).all(...p);
  };

  const normalizeOverviewOpts = (optsOrScalar: QueryOptions | string | number | null | undefined): QueryOptions => {
    if (optsOrScalar == null) return {};
    if (typeof optsOrScalar === 'string') return { project: optsOrScalar };
    if (typeof optsOrScalar === 'number') return { limit: optsOrScalar };
    return optsOrScalar;
  };

  const search = (text: string, opts: QueryOptions = {}) => {
    const { limit = 20, sessionId, excludeSession, project, after, before, cwd, source, includeMeta = false } = opts;
    let where = 'WHERE mf.text MATCH ?';
    const filterParams: any[] = [];
    if (sessionId) { where += ' AND mf.session_id=?'; filterParams.push(sessionId); }
    // Searching history from inside a session almost always hits that session's
    // own prompt, because the query terms came from it. Excluding in SQL keeps
    // `limit` spent on other sessions; a post-filter in the script would not.
    const excluded = typeof excludeSession === 'string' ? [excludeSession] : (excludeSession ?? []);
    if (excluded.length) {
      where += ` AND mf.session_id NOT IN (${excluded.map(() => '?').join(',')})`;
      filterParams.push(...excluded);
    }
    if (project)   { where += ' AND s.project LIKE ?'; filterParams.push(project); }
    if (after)     { where += ' AND m.timestamp>?';    filterParams.push(after); }
    if (before)    { where += ' AND m.timestamp<?';    filterParams.push(before); }
    if (cwd)       { where += ' AND m.cwd LIKE ?';     filterParams.push(cwd); }
    if (source && source !== 'all') { where += " AND COALESCE(m.source, s.source, 'claude')=?"; filterParams.push(source); }
    if (!includeMeta) where += ' AND COALESCE(m.is_meta,0)=0';
    const stmt = db.prepare(`
      SELECT m.uuid,m.session_id,m.text,m.content_type,m.is_meta,m.role,m.timestamp,m.model,m.cwd,m.source as m_source,
             s.id as s_id,${titleExpr('s')} as s_title,s.project as s_project,s.started_at as s_started,
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
        `SELECT uuid,text,content_type,is_meta,role,timestamp,model,COALESCE(source, 'claude') as source FROM messages WHERE session_id=? AND uuid!=? ${metaClause} ORDER BY ABS(JULIANDAY(timestamp)-JULIANDAY(?)) LIMIT 6`
      ).all(r.session_id, r.uuid, r.timestamp).sort((a: DbRow, b: DbRow) => a.timestamp < b.timestamp ? -1 : 1);
      const sourceValue = r.m_source || r.s_source || 'claude';
      return {
        message: { uuid: r.uuid, text: r.text, content_type: r.content_type, is_meta: r.is_meta || 0, role: r.role, timestamp: r.timestamp, model: r.model, cwd: r.cwd, source: sourceValue },
        session: { id: r.s_id, title: r.s_title, project: r.s_project, started_at: r.s_started, source: r.s_source || sourceValue },
        rank: r.rank,
        context: ctx,
      };
    });
  };

  const context = (uuid: string) => {
    const msg = db.prepare('SELECT * FROM messages WHERE uuid=?').get(uuid);
    if (!msg) return null;
    const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(msg.session_id);
    const chain: DbRow[] = [];
    let cur: DbRow | undefined = msg;
    while (cur?.parent_uuid) { cur = db.prepare('SELECT * FROM messages WHERE uuid=?').get(cur.parent_uuid); if (cur) chain.unshift(cur); }
    const subagent = msg.agent_id ? db.prepare('SELECT * FROM subagents WHERE agent_id=?').get(msg.agent_id) : null;
    let workflow = null;
    if (msg.agent_id) {
      const wa = db.prepare('SELECT * FROM workflow_agents WHERE agent_id=?').get(msg.agent_id);
      if (wa) workflow = db.prepare('SELECT * FROM workflows WHERE run_id=?').get(wa.run_id);
    }
    return { message: msg, parentChain: chain, session, subagent, workflow };
  };

  const trace = (uuid: string) => {
    const chain: DbRow[] = [];
    let cur = db.prepare('SELECT * FROM messages WHERE uuid=?').get(uuid);
    while (cur) { chain.unshift(cur); cur = cur.parent_uuid ? db.prepare('SELECT * FROM messages WHERE uuid=?').get(cur.parent_uuid) : undefined; }
    return chain;
  };

  const thread = (sid: string, opts: QueryOptions = {}) => {
    const includeMeta = opts?.includeMeta === true;
    const metaClause = includeMeta ? '' : 'AND COALESCE(is_meta,0)=0';
    return db.prepare(`SELECT * FROM messages WHERE session_id=? ${metaClause} ORDER BY timestamp`).all(sid);
  };

  const subagents = (optsOrSid?: QueryOptions | string) => {
    const opts = normalizeOpts(optsOrSid);
    const { limit = 100 } = opts;
    const needsJoin = opts.project || opts.branch || opts.source;
    const { where, params } = buildWhere(opts, { sessionId: 'sa.session_id', project: 's.project', timestamp: 'sa.session_id', branch: 's.git_branch', source: 's.source' });
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
    const { limit = 200, after, before, source } = opts;
    let where = 'tc.file_path=?';
    const params: any[] = [fp];
    if (after)  { where += ' AND m.timestamp > ?'; params.push(after); }
    if (before) { where += ' AND m.timestamp < ?'; params.push(before); }
    if (source && source !== 'all') { where += " AND COALESCE(s.source, 'claude') = ?"; params.push(source); }
    params.push(limit);
    return db.prepare(
      `SELECT tc.*,s.title as s_title,s.project as s_project,m.timestamp as ts FROM tool_calls tc LEFT JOIN sessions s ON s.id=tc.session_id LEFT JOIN messages m ON m.uuid=tc.message_uuid WHERE ${where} ORDER BY m.timestamp LIMIT ?`
    ).all(...params).map((r: DbRow) => ({
      toolCall: { id: r.id, message_uuid: r.message_uuid, name: r.name, input_json: r.input_json },
      session: { id: r.session_id, title: r.s_title, project: r.s_project },
      timestamp: r.ts,
    }));
  };

  const failures = (optsOrSid?: QueryOptions | string) => {
    const opts = normalizeOpts(optsOrSid);
    const { limit = 50 } = opts;
    const needsJoin = opts.project || opts.branch || opts.source;
    const { where, params: filterParams } = buildWhere(opts, { sessionId: 'tr.session_id', project: 's.project', timestamp: 'rm.timestamp', branch: 's.git_branch', source: 's.source' });
    const join = needsJoin ? 'LEFT JOIN sessions s ON s.id=tr.session_id' : '';
    const errorCond = `(tr.is_error = 1 OR tr.content LIKE '${BASH_EXIT_PAT}')`;
    const allParams = [...filterParams, limit];
    const rows = db.prepare(`SELECT tr.* FROM tool_results tr ${join} LEFT JOIN messages rm ON rm.uuid=tr.message_uuid WHERE ${errorCond} AND ${where} ORDER BY rm.timestamp DESC LIMIT ?`).all(...allParams);
    return rows.map((r: DbRow) => {
      const tc = db.prepare('SELECT * FROM tool_calls WHERE id=?').get(r.tool_use_id);
      const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(r.session_id);
      const rm = db.prepare('SELECT * FROM messages WHERE uuid=?').get(r.message_uuid);
      const next = rm?.timestamp ? db.prepare('SELECT * FROM messages WHERE session_id=? AND timestamp>? ORDER BY timestamp LIMIT 3').all(r.session_id, rm.timestamp) : [];
      return { toolCall: tc, result: r, session, nextMessages: next };
    });
  };

  const sessions = (optsOrN?: QueryOptions | number | string) => {
    const opts = normalizeOpts(optsOrN, 'sessionId');
    const { limit = 50 } = opts;
    const { where, params } = buildWhere(opts, { sessionId: 's.id', project: 's.project', timestamp: 's.started_at', branch: 's.git_branch', source: 's.source' });
    params.push(limit);
    return db.prepare(`SELECT s.*, ${titleExpr('s')} AS title FROM sessions s WHERE ${where} ORDER BY ended_at DESC LIMIT ?`).all(...params);
  };

  const recent = (n = 10) => sessions({ limit: n });

  const summaries = (optsOrSid?: QueryOptions | string) => {
    const opts = normalizeOpts(optsOrSid);
    const { limit = 100 } = opts;
    const { where, params } = buildWhere(opts, { sessionId: 'su.session_id', project: 's.project', timestamp: 'su.timestamp', branch: 's.git_branch', source: 's.source' });
    params.push(limit);
    return db.prepare(`SELECT su.*, s.title as session_title, s.project FROM summaries su LEFT JOIN sessions s ON s.id=su.session_id WHERE ${where} ORDER BY su.timestamp DESC LIMIT ?`).all(...params);
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
        .filter((r: DbRow) => cwd === r.project_path || cwd.startsWith(r.project_path + path.sep))
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
        SELECT id, ${titleExpr('sessions')} AS title, project, project_path, started_at, ended_at, git_branch, message_count, COALESCE(source, 'claude') AS source
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

  const raw = (messageUuid: string, opts: { offset?: number; limit?: number } = {}) => {
    const { offset = 0, limit = 10000 } = opts;
    const message = db.prepare('SELECT * FROM messages WHERE uuid=?').get(messageUuid);
    if (!message) return null;
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

function createAttuneApi(db: SqliteDb) {
  const resolveMemoryPath = (memoryPath: string, sessionId?: string): string => {
    let base = null;
    if (sessionId) {
      base = db.prepare('SELECT project_path FROM sessions WHERE id=?').get(sessionId)?.project_path || null;
    }
    const resolved = path.isAbsolute(memoryPath)
      ? path.normalize(memoryPath)
      : path.resolve(base || process.cwd(), memoryPath);
    let stat;
    try {
      stat = fs.statSync(resolved);
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
    const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const proj = project || db.prepare('SELECT project FROM sessions WHERE id=?').get(session_id)?.project || null;
    const created_at = new Date().toISOString();
    db.prepare('INSERT OR REPLACE INTO memories (id, session_id, project, message_start, message_end, path, anchors, summary, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(
      id, session_id || null, proj, message_start || null, message_end || null, normalizedPath, normalizedAnchors, summary, created_at);
    return { id, path: normalizedPath, project: proj, anchors: normalizedAnchors, created_at };
  };

  const forget = ({ id, reason }: ForgetInput) => {
    const deletionReason = String(reason || '').trim();
    if (!id || !deletionReason) throw new Error('forget() requires id and reason');
    const row = db.prepare('SELECT id, deleted_at, deleted_reason FROM memories WHERE id=?').get(id);
    if (!row) throw new Error(`forget() memory not found: ${id}`);
    if (row.deleted_at) {
      return { id, deleted_at: row.deleted_at, deleted_reason: row.deleted_reason, already_deleted: true };
    }
    const deleted_at = new Date().toISOString();
    db.prepare('UPDATE memories SET deleted_at=?, deleted_reason=? WHERE id=?').run(deleted_at, deletionReason, id);
    return { id, deleted_at, deleted_reason: deletionReason };
  };

  return { remember, forget };
}

export { createQueryApi, createAttuneApi };
