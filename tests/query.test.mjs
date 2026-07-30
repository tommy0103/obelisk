import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createQueryApi, createAttuneApi } from '../packages/core/src/query.ts';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');

function memoryDb({ projectPath = '/tmp/quiet-zero-test' } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const insertSession = db.prepare(`
    INSERT INTO sessions (id, title, project, project_path, started_at, ended_at, git_branch, message_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertSession.run('sid-1', 'Older quiet-zero session', 'quiet-zero', projectPath, '2026-06-09T10:00:00Z', '2026-06-09T11:00:00Z', 'main', 12);
  insertSession.run('sid-2', 'Memory layer session', 'quiet-zero', projectPath, '2026-06-10T10:00:00Z', '2026-06-10T11:00:00Z', 'codex/memory-layer', 23);
  insertSession.run('sid-3', 'Other project session', 'other-project', '/tmp/other-project', '2026-06-11T10:00:00Z', '2026-06-11T11:00:00Z', 'main', 5);
  const insert = db.prepare(`
    INSERT INTO memories (id, session_id, project, path, summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insert.run('mem-1', 'sid-1', 'quiet-zero', '.obelisk/memories/parallel-agents.md', 'Decision: use parallel agents for independent review facets.', '2026-06-09T12:00:00Z');
  insert.run('mem-2', 'sid-2', 'quiet-zero', '.obelisk/memories/sqlite-memory.md', 'Decision: store markdown memory records in SQLite.', '2026-06-10T12:00:00Z');
  insert.run('mem-3', 'sid-3', 'other-project', '.obelisk/memories/parallel-agents.md', 'Other project note about parallel agents.', '2026-06-11T12:00:00Z');
  db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
  return db;
}

function searchDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, title TEXT, project TEXT, started_at TEXT,
      source TEXT DEFAULT 'claude'
    );
    CREATE TABLE messages (
      uuid TEXT PRIMARY KEY, session_id TEXT, text TEXT, role TEXT,
      timestamp TEXT, model TEXT, cwd TEXT, content_type TEXT,
      is_meta INTEGER DEFAULT 0, source TEXT DEFAULT 'claude'
    );
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      uuid UNINDEXED, session_id UNINDEXED, text,
      content=messages, content_rowid=rowid
    );
  `);
  db.prepare(`
    INSERT INTO sessions (id, title, project, started_at)
    VALUES (?, ?, ?, ?)
  `).run('sid-search', 'Search session', 'quiet-zero', '2026-06-10T10:00:00Z');
  const insert = db.prepare(`
    INSERT INTO messages (uuid, session_id, text, role, timestamp, model, cwd, content_type, is_meta)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run('msg-meta', 'sid-search', 'needle injected caveat', 'user', '2026-06-10T10:00:30Z', null, '/tmp/quiet-zero', 'text', 1);
  insert.run('msg-text', 'sid-search', 'needle visible reply', 'assistant', '2026-06-10T10:01:00Z', 'claude-opus', '/tmp/quiet-zero', 'text', 0);
  insert.run('msg-meta-near', 'sid-search', '<command-name>/exit</command-name>', 'user', '2026-06-10T10:01:30Z', null, '/tmp/quiet-zero', 'text', 1);
  insert.run('msg-thinking', 'sid-search', 'nearby reasoning trace', 'assistant', '2026-06-10T10:02:00Z', 'claude-opus', '/tmp/quiet-zero', 'thinking', 0);
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
  return db;
}

// Two untitled sessions, as produced by current Claude Code versions: the
// current one whose own prompt repeats the search terms, and an older one
// holding the actual evidence.
function untitledDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const insertSession = db.prepare(`
    INSERT INTO sessions (id, title, project, project_path, started_at, ended_at, message_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertSession.run('sid-current', null, 'quiet-zero', '/tmp/quiet-zero-test', '2026-06-12T10:00:00Z', '2026-06-12T11:00:00Z', 3);
  insertSession.run('sid-past', null, 'quiet-zero', '/tmp/quiet-zero-test', '2026-06-11T10:00:00Z', '2026-06-11T11:00:00Z', 2);
  const insert = db.prepare(`
    INSERT INTO messages (uuid, session_id, text, role, timestamp, content_type, is_meta)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run('cur-cmd', 'sid-current', '<command-message>obelisk</command-message>', 'user', '2026-06-12T10:00:00Z', 'text', 0);
  insert.run('cur-prompt', 'sid-current', 'find the retry needle discussion', 'user', '2026-06-12T10:00:10Z', 'text', 0);
  insert.run('past-prompt', 'sid-past', 'why does the retry path drop it', 'user', '2026-06-11T10:00:10Z', 'text', 0);
  insert.run('past-answer', 'sid-past', 'the needle fix landed in the retry path', 'assistant', '2026-06-11T10:05:00Z', 'text', 0);
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
  return db;
}

test('search excludes the caller session in SQL so limit is spent on other sessions', () => {
  const db = untitledDb();
  const api = createQueryApi(db);

  const all = api.search('needle', { limit: 5 }).map(r => r.message.uuid);
  assert.deepEqual(all.sort(), ['cur-prompt', 'past-answer']);

  // limit 1 would otherwise be consumed by the caller's own prompt.
  const others = api.search('needle', { excludeSession: 'sid-current', limit: 1 });
  assert.deepEqual(others.map(r => r.message.uuid), ['past-answer']);

  assert.deepEqual(
    api.search('needle', { excludeSession: ['sid-current', 'sid-past'], limit: 5 }),
    [],
  );
  db.close();
});

test('untitled sessions fall back to the opening user message as a title', () => {
  const db = untitledDb();
  const api = createQueryApi(db);

  // The command envelope is skipped; the first real prompt becomes the label.
  assert.equal(api.search('needle', { excludeSession: 'sid-current' })[0].session.title, 'why does the retry path drop it');
  assert.equal(api.sessions({ sessionId: 'sid-current' })[0].title, 'find the retry needle discussion');

  // A session with no user text at all keeps a null title rather than inventing one.
  db.prepare(`INSERT INTO sessions (id, title, project, started_at) VALUES (?, ?, ?, ?)`)
    .run('sid-empty', null, 'quiet-zero', '2026-06-13T10:00:00Z');
  assert.equal(api.sessions({ sessionId: 'sid-empty' })[0].title, null);
  db.close();
});

test('search falls back to safe tokenization for FTS-special input instead of throwing', () => {
  const db = searchDb();
  const api = createQueryApi(db);

  // 'needle-reply' is FTS5 operator syntax (a hyphen). Raw MATCH would throw;
  // search() must fall back to safe per-token quoting ("needle" "reply") and
  // still find the message that contains both tokens.
  const rows = api.search('needle-reply', { limit: 5 });

  assert.deepEqual(rows.map(r => r.message.uuid), ['msg-text']);
  db.close();
});

test('search exposes content_type on hits and temporal context', () => {
  const db = searchDb();
  const api = createQueryApi(db);

  const rows = api.search('needle', { limit: 1 });

  assert.equal(rows[0].message.uuid, 'msg-text');
  assert.equal(rows[0].message.content_type, 'text');
  assert.equal(rows[0].message.is_meta, 0);
  assert.equal(rows[0].context[0].uuid, 'msg-thinking');
  assert.equal(rows[0].context[0].content_type, 'thinking');
  assert.equal(rows[0].context[0].is_meta, 0);
  db.close();
});

test('search and thread omit meta messages by default and expose them on request', () => {
  const db = searchDb();
  const api = createQueryApi(db);

  assert.deepEqual(api.search('injected', { limit: 5 }), []);

  const withMeta = api.search('injected', { includeMeta: true, limit: 5 });
  assert.equal(withMeta[0].message.uuid, 'msg-meta');
  assert.equal(withMeta[0].message.is_meta, 1);

  assert.deepEqual(api.thread('sid-search').map(m => m.uuid), ['msg-text', 'msg-thinking']);
  assert.deepEqual(
    api.thread('sid-search', { includeMeta: true }).map(m => m.uuid),
    ['msg-meta', 'msg-text', 'msg-meta-near', 'msg-thinking'],
  );

  db.close();
});

test('memories follows list-helper scalar opts and filters by query within scope', () => {
  const db = memoryDb();
  const api = createQueryApi(db);

  assert.deepEqual(api.memories('sid-1').map(m => m.id), ['mem-1']);
  assert.deepEqual(api.memories(1).map(m => m.id), ['mem-3']);
  assert.deepEqual(
    api.memories({ project: '%quiet-zero%', query: 'parallel agents', limit: 5 }).map(m => m.id),
    ['mem-1'],
  );

  db.close();
});

test('memories requires English query terms', () => {
  const db = memoryDb();
  const api = createQueryApi(db);

  assert.throws(
    () => api.memories({ query: '记忆层', limit: 5 }),
    /memories\(\) query must use English terms/,
  );

  db.close();
});

test('memories uses FTS recall with safe English tokenization and rank', () => {
  const db = memoryDb();
  const api = createQueryApi(db);

  const rows = api.memories({ project: '%quiet-zero%', query: 'sqlite-memory', limit: 5 });

  assert.deepEqual(rows.map(m => m.id), ['mem-2']);
  assert.equal(typeof rows[0].rank, 'number');
  db.close();
});

test('memories does not broaden punctuation-only FTS queries into full recall', () => {
  const db = memoryDb();
  const api = createQueryApi(db);

  assert.deepEqual(api.memories({ project: '%quiet-zero%', query: '---', limit: 5 }), []);
  db.close();
});

test('overview returns a compact current-project map with bounded sessions', () => {
  const db = memoryDb({ projectPath: process.cwd() });
  const api = createQueryApi(db);

  const view = api.overview({ limit: 1, projectLimit: 5 });

  assert.equal(view.current.cwd, process.cwd());
  assert.equal(view.current.project.project, 'quiet-zero');
  assert.equal(view.current.project.source, 'cwd_project_path');
  assert.equal(view.current.project.confidence, 'exact');
  assert.equal('session' in view.current, false);
  assert.equal(view.current_project.session_total, 2);
  assert.deepEqual(view.current_project.sessions.map(s => s.id), ['sid-2']);
  assert.equal(view.current_project.memory_total, 2);
  assert.deepEqual(view.current_project.memories.map(m => m.id), ['mem-2', 'mem-1']);
  assert.equal(view.totals.projects, 2);
  assert.equal(view.totals.sessions, 3);
  assert.equal(view.totals.memories, 3);
  assert.ok(view.projects.some(p => p.project === 'quiet-zero' && p.session_count === 2 && p.memory_count === 2));

  db.close();
});

test('query api is read-only and does not expose attune helpers', () => {
  const db = memoryDb();
  const api = createQueryApi(db);

  assert.equal(api.remember, undefined);
  assert.equal(api.forget, undefined);
  assert.equal(typeof api.overview, 'function');
  assert.deepEqual(api.sql('SELECT id FROM memories ORDER BY id').map(r => r.id), ['mem-1', 'mem-2', 'mem-3']);
  assert.throws(
    () => api.sql("INSERT INTO memories (id, path, summary) VALUES ('mem-x', '/tmp/x.md', 'x')"),
    /sql\(\) only supports read-only SELECT\/WITH queries/,
  );

  db.close();
});

test('attune api exposes only memory mutation helpers', () => {
  const db = memoryDb();
  const api = createAttuneApi(db);

  assert.deepEqual(Object.keys(api).sort(), ['forget', 'remember']);
  assert.equal(api.search, undefined);
  assert.equal(api.sql, undefined);
  assert.equal(typeof api.remember, 'function');
  assert.equal(typeof api.forget, 'function');

  db.close();
});

test('remember stores absolute project-relative memory path', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'obelisk-memory-project-'));
  const memoryDir = join(projectDir, '.obelisk', 'memories');
  mkdirSync(memoryDir, { recursive: true });
  const memoryPath = join(memoryDir, 'decision.md');
  writeFileSync(memoryPath, '# Decision\n');
  const db = memoryDb({ projectPath: projectDir });
  const api = createAttuneApi(db);

  const result = api.remember({
    path: '.obelisk/memories/decision.md',
    session_id: 'sid-1',
    summary: 'Decision: store normalized memory paths.',
  });

  assert.equal(result.path, memoryPath);
  assert.equal(db.prepare('SELECT path FROM memories WHERE id=?').get(result.id).path, memoryPath);
  db.close();
});

test('remember updates FTS recall for the registered memory immediately', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'obelisk-memory-project-'));
  const memoryDir = join(projectDir, '.obelisk', 'memories');
  mkdirSync(memoryDir, { recursive: true });
  const memoryPath = join(memoryDir, 'query-plan.md');
  writeFileSync(memoryPath, '# Query Plan\n');
  const db = memoryDb({ projectPath: projectDir });
  const api = createAttuneApi(db);

  const registered = api.remember({
    path: '.obelisk/memories/query-plan.md',
    session_id: 'sid-2',
    summary: 'Decision: use faceted query plans for synthesis recall.',
  });
  const rows = createQueryApi(db).memories({
    project: '%quiet-zero%',
    query: 'faceted query plans',
    limit: 5,
  });

  assert.deepEqual(rows.map(m => m.id), [registered.id]);
  assert.equal(typeof rows[0].rank, 'number');
  db.close();
});

test('forget soft-deletes memory records from active recall', () => {
  const db = memoryDb();
  const api = createAttuneApi(db);

  const result = api.forget({ id: 'mem-1', reason: 'Outdated project guidance.' });

  assert.equal(result.id, 'mem-1');
  assert.equal(result.deleted_reason, 'Outdated project guidance.');
  assert.match(result.deleted_at, /^\d{4}-\d{2}-\d{2}T/);
  const row = db.prepare('SELECT deleted_at, deleted_reason FROM memories WHERE id=?').get('mem-1');
  assert.equal(row.deleted_at, result.deleted_at);
  assert.equal(row.deleted_reason, 'Outdated project guidance.');
  assert.deepEqual(createQueryApi(db).memories({ project: '%quiet-zero%', limit: 10 }).map(m => m.id), ['mem-2']);

  db.close();
});

test('remember requires English summaries', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'obelisk-memory-project-'));
  const memoryDir = join(projectDir, '.obelisk', 'memories');
  mkdirSync(memoryDir, { recursive: true });
  const memoryPath = join(memoryDir, 'decision.md');
  writeFileSync(memoryPath, '# Decision\n');
  const db = memoryDb({ projectPath: projectDir });
  const api = createAttuneApi(db);

  assert.throws(
    () => api.remember({
      path: '.obelisk/memories/decision.md',
      session_id: 'sid-1',
      summary: '决策：记忆摘要必须使用英文。',
    }),
    /remember\(\) summary must be written in English/,
  );

  db.close();
});

test('remember rejects missing memory files', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'obelisk-memory-project-'));
  const db = memoryDb({ projectPath: projectDir });
  const api = createAttuneApi(db);

  assert.throws(
    () => api.remember({
      path: '.obelisk/memories/missing.md',
      session_id: 'sid-1',
      summary: 'Decision: this should not be registered.',
    }),
    /remember\(\) memory file does not exist/,
  );

  db.close();
});
