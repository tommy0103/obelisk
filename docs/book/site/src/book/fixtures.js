// A miniature index for the in-page query sandbox.
//
// The helpers below are real implementations over these arrays — the same
// shapes `query.ts` returns, the same default limits, the same `.map()` you
// would write for real. What is NOT here: `sql()`, because there is no SQLite
// in the browser. Everything else behaves.
//
// The data is fictional but shaped like a real index: three sources, prefixed
// ids, ISO-8601 text timestamps, an is_meta flag, a couple of archived memories.

const S = (id, title, project, source, started, msgs) => ({
  id, title, project, project_path: '/Users/tomiya/Code/quiet-zero',
  source, started_at: started, ended_at: started, message_count: msgs,
  git_branch: 'main',
});

export const SESSIONS = [
  S('5c396090-fbcc-417a-808e-92da269a2ef5', '修复 auth token 刷新的竞态', '-Users-tomiya-Code-quiet-zero', 'claude', '2026-07-14T09:12:03.000Z', 84),
  S('codex:019f8000-2bee-7ee1-9a9f-fe013f23124b', '修复 session detail 的 computer use 显示', '-Users-tomiya-Code-quiet-zero', 'codex', '2026-07-20T14:03:41.000Z', 152),
  S('codex:019f4b11-1aa2-7c30-9d21-0b7712aa9911', '评估 rollback 修复', '-Users-tomiya-Code-quiet-zero', 'codex', '2026-07-10T21:44:10.000Z', 96),
  S('kimi:sess-7712aa99', '给 memories 加 anchors 字段', '-Users-tomiya-Code-quiet-zero', 'kimi', '2026-07-25T11:20:00.000Z', 41),
  S('a1b2c3d4-0000-4444-8888-ffee00112233', '重写 auth 中间件的错误处理', '-Users-tomiya-Code-quiet-zero', 'claude', '2026-06-22T16:31:55.000Z', 63),
  S('codex:019f7c21-9911-7fa0-8123-77aa00bb1122', '分析 kimi-code session 接入方案', '-Users-tomiya-Code-quiet-zero', 'codex', '2026-07-19T08:05:12.000Z', 208),
];

const M = (uuid, sessionId, role, timestamp, text, extra = {}) => ({
  uuid, session_id: sessionId, role, timestamp, text,
  type: role === 'user' ? 'user' : 'assistant',
  content_type: 'text', is_meta: 0, model: role === 'user' ? null : 'claude-opus-5',
  parent_uuid: null, ...extra,
});

export const MESSAGES = [
  M('m-0001', SESSIONS[0].id, 'user', '2026-07-14T09:12:03.000Z',
    'auth token 在并发刷新时会拿到过期的那一份，两个请求同时命中 refresh 端点就复现了'),
  M('m-0002', SESSIONS[0].id, 'assistant', '2026-07-14T09:12:40.000Z',
    '看了 refreshToken()，它在读取和写入之间没有任何互斥。两个调用各自读到同一个旧 token，各自去刷新，后写的那个把先写的覆盖掉了。', { parent_uuid: 'm-0001' }),
  M('m-0003', SESSIONS[0].id, 'assistant', '2026-07-14T09:18:22.000Z',
    '改成把整个 refresh 收敛到一个 in-flight promise 上：第二个调用直接 await 第一个的结果，而不是自己再发一次请求。src/auth/token.ts 里加了 pendingRefresh 这个字段。', { parent_uuid: 'm-0002' }),
  M('m-0004', SESSIONS[0].id, 'user', '2026-07-14T09:31:07.000Z',
    '那如果第一个请求失败了呢，第二个会不会一直等？'),
  M('m-0005', SESSIONS[0].id, 'assistant', '2026-07-14T09:32:15.000Z',
    'pendingRefresh 在 finally 里被清空，所以失败之后下一个调用会重新发起。这一版放弃了退避重试——它属于调用方的策略，不该埋在 token 层里。', { parent_uuid: 'm-0004' }),

  M('m-0101', SESSIONS[4].id, 'user', '2026-06-22T16:31:55.000Z',
    'auth 中间件现在把所有错误都吞成 401，日志里看不出到底是 token 过期还是签名不对'),
  M('m-0102', SESSIONS[4].id, 'assistant', '2026-06-22T16:33:02.000Z',
    '拆成三种：TokenExpired、SignatureInvalid、SubjectUnknown。对外仍然统一回 401（不给攻击者信息），但日志里记具体类型。src/auth/middleware.ts', { parent_uuid: 'm-0101' }),

  M('m-0201', SESSIONS[1].id, 'user', '2026-07-20T14:03:41.000Z',
    'Codex 的 session 打开之后，computer use 那几条消息渲染错了，thinking 块跑到了工具调用后面'),
  M('m-0202', SESSIONS[1].id, 'assistant', '2026-07-20T14:09:18.000Z',
    '这次 Codex 问题应该在 Codex parser 中产出正确的 canonical event；不应在 session-detail assembly 里增加 if source === "codex"。', { parent_uuid: 'm-0201' }),
  M('m-0203', SESSIONS[1].id, 'assistant', '2026-07-20T14:22:50.000Z',
    '最好逐步拆成类似 visibility: visible | hidden 和明确的 message kind，避免把「隐藏注入」和「需要展示的 Skill/system metadata」混为一类。', { parent_uuid: 'm-0202' }),

  M('m-0301', SESSIONS[2].id, 'user', '2026-07-10T21:44:10.000Z',
    'cannot rollback - no transaction is active，这个报错到底是什么引起的'),
  M('m-0302', SESSIONS[2].id, 'assistant', '2026-07-10T21:51:33.000Z',
    '它是二级清理失败：真正的异常在 catch 块里被无条件 ROLLBACK 盖掉了。主异常丢了，所以 SQLITE_BUSY 只是最可能的解释，不是已证实的事实。', { parent_uuid: 'm-0301' }),
  M('m-0303', SESSIONS[2].id, 'assistant', '2026-07-10T22:14:02.000Z',
    '1. skill 用只读连接检查 heartbeat。2. heartbeat 新鲜：直接查询现有 DB。3. heartbeat 过期：尝试获取 writer lease。4. 获取 lease 后再次检查 heartbeat，消除 TOCTOU 竞态。5. 仍无活跃 daemon，才打开写连接。6. lease 获取失败：放弃索引，退回只读查询。', { parent_uuid: 'm-0302' }),

  M('m-0401', SESSIONS[5].id, 'user', '2026-07-19T08:05:12.000Z',
    'kimi-code 的 session 怎么接进来，它的 wire.jsonl 看着和前两个完全不是一回事'),
  M('m-0402', SESSIONS[5].id, 'assistant', '2026-07-19T08:22:41.000Z',
    '核心难点是 wire.jsonl 不是消息列表，而是操作日志。把 Kimi Code 作为「目录型 provider」接入：一个 IndexUnit 对应整个 session 目录，采用全量 replay + 事务内替换。', { parent_uuid: 'm-0401' }),
  M('m-0403', SESSIONS[5].id, 'assistant', '2026-07-21T10:02:19.000Z',
    '硬约束：保持数据库 schema 和 IndexRecord 不变，把 Kimi 的复杂语义全部封装在 adapter 内。本次不修改 schema.sql，也不新增 IndexRecord 类型。', { parent_uuid: 'm-0402' }),

  M('m-0501', SESSIONS[3].id, 'user', '2026-07-25T11:20:00.000Z',
    'memories 表加一个 anchors 列，存相关文件路径'),
  M('m-0502', SESSIONS[3].id, 'assistant', '2026-07-25T11:26:44.000Z',
    '加列走 schema-migrations.ts 的 ADD COLUMN，只加不改。校验只到「是对象数组」为止，不检查对象里有什么字段——在结构上收紧、在内容上留白。', { parent_uuid: 'm-0501' }),
  M('m-0503', SESSIONS[3].id, 'assistant', '2026-07-25T11:40:02.000Z',
    '注意 memories 从不参与任何重建，所以这一列的迁移必须对老库幂等。', { parent_uuid: 'm-0502' }),
];

export const TOOL_CALLS = [
  { id: 'tc-1', message_uuid: 'm-0003', session_id: SESSIONS[0].id, name: 'Edit', file_path: 'src/auth/token.ts', presentation: 'default' },
  { id: 'tc-2', message_uuid: 'm-0003', session_id: SESSIONS[0].id, name: 'Bash', file_path: null, presentation: 'default' },
  { id: 'tc-3', message_uuid: 'm-0102', session_id: SESSIONS[4].id, name: 'Edit', file_path: 'src/auth/middleware.ts', presentation: 'default' },
  { id: 'tc-4', message_uuid: 'm-0203', session_id: SESSIONS[1].id, name: 'Edit', file_path: 'packages/core/src/providers/codex.ts', presentation: 'default' },
  { id: 'tc-5', message_uuid: 'm-0502', session_id: SESSIONS[3].id, name: 'Edit', file_path: 'packages/core/src/schema.sql', presentation: 'default' },
];

export const TOOL_RESULTS = [
  { tool_use_id: 'tc-2', session_id: SESSIONS[0].id, message_uuid: 'm-0003', is_error: 1, content: 'FAIL tests/auth-refresh.test.mjs — expected 1 refresh call, got 2' },
  { tool_use_id: 'tc-1', session_id: SESSIONS[0].id, message_uuid: 'm-0003', is_error: 0, content: 'applied' },
];

export const MEMORIES = [
  {
    id: 'mem-1752480000-a1b2c3',
    session_id: SESSIONS[0].id,
    project: '-Users-tomiya-Code-quiet-zero',
    path: '/Users/tomiya/Code/quiet-zero/.obelisk/memories/auth-refresh-single-flight.md',
    summary:
      'Token refresh is collapsed onto a single in-flight promise in src/auth/token.ts. Concurrent callers await the first refresh instead of issuing their own; the pending promise is cleared in finally so a failed refresh does not wedge later callers. Backoff was deliberately left to the caller rather than buried in the token layer.',
    anchors: [{ kind: 'file', path: 'src/auth/token.ts' }],
    created_at: '2026-07-14T09:44:00.000Z',
    deleted_at: null,
  },
  {
    id: 'mem-1753440000-9f8e7d',
    session_id: SESSIONS[1].id,
    project: '-Users-tomiya-Code-quiet-zero',
    path: '/Users/tomiya/Code/quiet-zero/.obelisk/memories/provider-semantics-belong-to-adapters.md',
    summary:
      'Source-specific semantics are resolved in the provider adapter, never in session-detail assembly. A Codex rendering bug was fixed by emitting a correct canonical event rather than adding an if (source === "codex") branch downstream. This is why MessageRecord carries an explicit visibility field alongside is_meta.',
    anchors: [{ kind: 'file', path: 'packages/core/src/providers/codex.ts' }],
    created_at: '2026-07-20T15:02:00.000Z',
    deleted_at: null,
  },
  {
    id: 'mem-1752130000-44aa11',
    session_id: SESSIONS[2].id,
    project: '-Users-tomiya-Code-quiet-zero',
    path: '/Users/tomiya/Code/quiet-zero/.obelisk/memories/heartbeat-vs-lease.md',
    summary:
      'Heartbeat and writer lease have different jobs: the heartbeat decides who should write, the lease guarantees writers cannot overlap when policy is stale. The TOCTOU window is closed by re-checking the heartbeat after acquiring the lease, implemented separately in buildIndex and executeAttune.',
    anchors: [{ kind: 'file', path: 'packages/core/src/writer-lease.ts' }],
    created_at: '2026-07-10T22:31:00.000Z',
    deleted_at: null,
  },
  {
    id: 'mem-1750000000-deadbe',
    session_id: SESSIONS[4].id,
    project: '-Users-tomiya-Code-quiet-zero',
    path: '/Users/tomiya/Code/quiet-zero/.obelisk/memories/auth-errors-collapse-to-401.md',
    summary:
      'Auth middleware collapsed every failure into a bare 401 with no logging detail. Superseded by the three-way split (TokenExpired / SignatureInvalid / SubjectUnknown).',
    anchors: [],
    created_at: '2026-06-22T17:00:00.000Z',
    // Archived, not deleted — the row stays, and so does the markdown file.
    deleted_at: '2026-07-14T09:50:00.000Z',
    deleted_reason: 'superseded by the three-way error split in the same file',
  },
];

// ---------------------------------------------------------------- helpers

const sessionById = (id) => SESSIONS.find((s) => s.id === id) || null;

const applyFilters = (rows, opts, keys) =>
  rows.filter((row) => {
    if (opts.source && (keys.source ? keys.source(row) : row.source) !== opts.source) return false;
    if (opts.project) {
      const p = keys.project ? keys.project(row) : row.project;
      if (!p || !p.includes(opts.project.replace(/%/g, ''))) return false;
    }
    if (opts.sessionId && (keys.sessionId ? keys.sessionId(row) : row.session_id) !== opts.sessionId) return false;
    if (opts.after && (keys.timestamp ? keys.timestamp(row) : row.timestamp) <= opts.after) return false;
    if (opts.before && (keys.timestamp ? keys.timestamp(row) : row.timestamp) >= opts.before) return false;
    return true;
  });

// Same scalar shorthand as query.ts: a string is the id, a number is the limit.
const norm = (optsOrScalar, scalarKey = 'sessionId') => {
  if (optsOrScalar == null) return {};
  if (typeof optsOrScalar === 'string') return { [scalarKey]: optsOrScalar };
  if (typeof optsOrScalar === 'number') return { limit: optsOrScalar };
  return optsOrScalar;
};

const tokenize = (text) => String(text || '').toLowerCase().match(/[\p{Letter}\p{Number}]+/gu) || [];

export function createSandboxApi() {
  const search = (text, optsOrScalar) => {
    const opts = norm(optsOrScalar, 'project');
    const limit = opts.limit ?? 20;
    const terms = tokenize(text);
    if (!terms.length) return [];

    const scored = MESSAGES
      .filter((m) => !m.is_meta)
      .map((m) => {
        const hay = m.text.toLowerCase();
        const hits = terms.filter((t) => hay.includes(t)).length;
        return { m, hits };
      })
      .filter((r) => r.hits > 0)
      .sort((a, b) => b.hits - a.hits || (a.m.timestamp < b.m.timestamp ? 1 : -1));

    const filtered = applyFilters(scored.map((r) => r.m), opts, {
      project: (m) => sessionById(m.session_id)?.project,
      source: (m) => sessionById(m.session_id)?.source,
    });

    return filtered.slice(0, limit).map((m) => {
      const session = sessionById(m.session_id);
      // `context` here is the *time neighbourhood*, not the parent chain —
      // the same overloaded word the chapter warns about.
      const neighbours = MESSAGES
        .filter((o) => o.session_id === m.session_id && o.uuid !== m.uuid && !o.is_meta)
        .slice(0, 6)
        .map((o) => ({ uuid: o.uuid, role: o.role, text: o.text, timestamp: o.timestamp }));
      return {
        session: { id: session.id, title: session.title, project: session.project, source: session.source },
        message: { uuid: m.uuid, role: m.role, text: m.text, timestamp: m.timestamp, model: m.model },
        context: neighbours,
      };
    });
  };

  const memories = (optsOrScalar) => {
    const opts = norm(optsOrScalar, 'project');
    const limit = opts.limit ?? 20;
    if (opts.query && /[㐀-鿿぀-ヿ가-힯]/.test(String(opts.query))) {
      throw new Error(
        'memories() query must be written in English; translate user-language terms before using the memory layer',
      );
    }
    const terms = tokenize(opts.query);
    return MEMORIES
      .filter((mem) => mem.deleted_at === null)
      .filter((mem) => !opts.project || mem.project.includes(opts.project))
      .filter((mem) => !terms.length || terms.some((t) => mem.summary.toLowerCase().includes(t)))
      .slice(0, limit)
      .map((mem) => ({
        id: mem.id, path: mem.path, project: mem.project,
        summary: mem.summary, anchors: mem.anchors, created_at: mem.created_at,
        session_id: mem.session_id,
      }));
  };

  const sessions = (optsOrScalar) => {
    const opts = norm(optsOrScalar, 'project');
    const limit = opts.limit ?? 50;
    return applyFilters(SESSIONS, opts, { timestamp: (s) => s.started_at, sessionId: (s) => s.id })
      .slice()
      .sort((a, b) => (a.started_at < b.started_at ? 1 : -1))
      .slice(0, limit);
  };

  const context = (uuid) => {
    const message = MESSAGES.find((m) => m.uuid === uuid);
    if (!message) return null;
    const parents = [];
    let cur = message;
    while (cur?.parent_uuid) {
      cur = MESSAGES.find((m) => m.uuid === cur.parent_uuid);
      if (!cur) break;
      parents.unshift({ uuid: cur.uuid, role: cur.role, text: cur.text, timestamp: cur.timestamp });
    }
    return { message, parents, session: sessionById(message.session_id), subagent: null, workflow: null };
  };

  const trace = (uuid) => context(uuid)?.parents ?? [];

  const failures = (optsOrScalar) => {
    const opts = norm(optsOrScalar);
    const limit = opts.limit ?? 50;
    return TOOL_RESULTS.filter((r) => r.is_error)
      .slice(0, limit)
      .map((r) => {
        const call = TOOL_CALLS.find((c) => c.id === r.tool_use_id);
        const session = sessionById(r.session_id);
        return {
          tool_use_id: r.tool_use_id, tool: call?.name ?? null, content: r.content,
          session: { id: session.id, title: session.title, source: session.source },
          message_uuid: r.message_uuid,
        };
      });
  };

  const fileHistory = (pathOrOpts, maybeOpts) => {
    const path = typeof pathOrOpts === 'string' ? pathOrOpts : pathOrOpts?.path;
    const opts = norm(maybeOpts);
    const limit = opts.limit ?? 200;
    return TOOL_CALLS
      .filter((c) => c.file_path && c.file_path.includes(path || ''))
      .slice(0, limit)
      .map((c) => {
        const session = sessionById(c.session_id);
        return {
          tool: c.name, file_path: c.file_path, message_uuid: c.message_uuid,
          session: { id: session.id, title: session.title, source: session.source },
        };
      });
  };

  const overview = (optsOrScalar) => {
    const opts = norm(optsOrScalar, 'project');
    const limit = opts.limit ?? 10;
    const cwd = '/Users/tomiya/Code/quiet-zero';
    const project = '-Users-tomiya-Code-quiet-zero';
    const bySource = {};
    for (const s of SESSIONS) bySource[s.source] = (bySource[s.source] || 0) + 1;
    return {
      current: {
        cwd,
        // Three-level fallback, each level recording its own confidence.
        project: { project, project_path: cwd, source: 'cwd_project_path', confidence: 'exact' },
      },
      totals: {
        sessions: SESSIONS.length,
        messages: MESSAGES.length,
        memories: MEMORIES.filter((m) => !m.deleted_at).length,
        by_source: bySource,
      },
      current_project: {
        project,
        sessions: sessions({ project, limit }),
      },
    };
  };

  const sql = () => {
    throw new Error(
      'sql() is not available in this in-page sandbox — there is no SQLite in the browser. '
      + 'Everything else (overview / search / memories / sessions / context / trace / failures / fileHistory) is real.',
    );
  };

  return { overview, search, memories, sessions, context, trace, failures, fileHistory, sql };
}

export const HELPER_NAMES = [
  'overview', 'search', 'memories', 'sessions', 'context', 'trace', 'failures', 'fileHistory', 'sql',
];
