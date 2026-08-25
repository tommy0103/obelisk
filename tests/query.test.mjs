// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createQueryApi, createAttuneApi } from '../packages/core/src/query.ts';
import { makeTempDir } from './temp-dirs.mjs';

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
      is_meta INTEGER DEFAULT 0, visibility TEXT DEFAULT 'visible',
      source TEXT DEFAULT 'claude'
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
    INSERT INTO messages (uuid, session_id, text, role, timestamp, model, cwd, content_type, is_meta, visibility)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run('msg-meta', 'sid-search', 'needle injected caveat', 'user', '2026-06-10T10:00:30Z', null, '/tmp/quiet-zero', 'text', 1, 'visible');
  insert.run('msg-text', 'sid-search', 'needle visible reply', 'assistant', '2026-06-10T10:01:00Z', 'claude-opus', '/tmp/quiet-zero', 'text', 0, 'visible');
  insert.run('msg-meta-near', 'sid-search', '<command-name>/exit</command-name>', 'user', '2026-06-10T10:01:30Z', null, '/tmp/quiet-zero', 'text', 1, 'visible');
  insert.run('msg-thinking', 'sid-search', 'nearby reasoning trace', 'assistant', '2026-06-10T10:02:00Z', 'claude-opus', '/tmp/quiet-zero', 'thinking', 0, 'visible');
  insert.run('msg-inactive', 'sid-search', 'needle superseded experiment', 'assistant', '2026-06-10T10:02:30Z', 'claude-opus', '/tmp/quiet-zero', 'text', 0, 'inactive');
  insert.run('msg-inactive-meta', 'sid-search', 'needle superseded injected', 'user', '2026-06-10T10:02:40Z', null, '/tmp/quiet-zero', 'text', 1, 'inactive');
  insert.run('msg-hidden', 'sid-search', 'needle abandoned branch', 'assistant', '2026-06-10T10:03:00Z', 'claude-opus', '/tmp/quiet-zero', 'text', 0, 'hidden');
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
  return db;
}

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
  assert.deepEqual(api.search('abandoned', { includeMeta: true, limit: 5 }), []);

  assert.deepEqual(api.thread('sid-search').map(m => m.uuid), ['msg-text', 'msg-thinking']);
  assert.deepEqual(
    api.thread('sid-search', { includeMeta: true }).map(m => m.uuid),
    ['msg-meta', 'msg-text', 'msg-meta-near', 'msg-thinking'],
  );
  assert.deepEqual(
    api.thread('sid-search', { includeInactive: true }).map(m => [m.uuid, m.visibility]),
    [
      ['msg-text', 'visible'],
      ['msg-thinking', 'visible'],
      ['msg-inactive', 'inactive'],
    ],
  );

  db.close();
});

test('inactive search is opt-in, orthogonal to meta filtering, and always labeled', () => {
  const db = searchDb();
  const api = createQueryApi(db);

  assert.deepEqual(api.search('superseded', { limit: 5 }), []);
  const inactive = api.search('superseded', { includeInactive: true, limit: 5 });
  assert.deepEqual(inactive.map(row => [row.message.uuid, row.message.visibility]), [
    ['msg-inactive', 'inactive'],
  ]);
  assert.equal(
    inactive[0].context.every(row => row.visibility === 'visible' || row.visibility === 'inactive'),
    true,
  );

  const withMeta = api.search('superseded', {
    includeInactive: true,
    includeMeta: true,
    limit: 5,
  });
  assert.deepEqual(
    withMeta.map(row => [row.message.uuid, row.message.visibility]).sort(),
    [
      ['msg-inactive', 'inactive'],
      ['msg-inactive-meta', 'inactive'],
    ],
  );
  assert.deepEqual(api.search('abandoned', { includeInactive: true, includeMeta: true }), []);
  db.close();
});

test('context and trace reject hidden targets and omit hidden ancestors', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.prepare('INSERT INTO sessions (id,title,source) VALUES (?,?,?)')
    .run('sid-chain', 'Visibility chain', 'pi');
  const insert = db.prepare(`
    INSERT INTO messages (
      uuid,session_id,type,parent_uuid,role,text,timestamp,visibility,source
    ) VALUES (?,?,?,?,?,?,?,?,?)
  `);
  insert.run('visible-root', 'sid-chain', 'user', null, 'user', 'root', '2026-08-02T10:00:00Z', 'visible', 'pi');
  insert.run('hidden-parent', 'sid-chain', 'assistant', 'visible-root', 'assistant', 'secret', '2026-08-02T10:00:01Z', 'hidden', 'pi');
  insert.run('visible-child', 'sid-chain', 'user', 'hidden-parent', 'user', 'continue', '2026-08-02T10:00:02Z', 'visible', 'pi');
  insert.run('inactive-child', 'sid-chain', 'assistant', 'visible-root', 'assistant', 'superseded', '2026-08-02T10:00:03Z', 'inactive', 'pi');

  const api = createQueryApi(db);
  assert.equal(api.context('hidden-parent'), null);
  assert.equal(api.context('hidden-parent', { includeInactive: true }), null);
  assert.deepEqual(api.trace('hidden-parent'), []);
  assert.deepEqual(api.trace('hidden-parent', { includeInactive: true }), []);
  assert.equal(api.context('inactive-child'), null);
  assert.deepEqual(api.trace('inactive-child'), []);
  assert.deepEqual(
    api.context('inactive-child', { includeInactive: true }).parentChain
      .map(message => [message.uuid, message.visibility]),
    [['visible-root', 'visible']],
  );
  assert.deepEqual(
    api.trace('inactive-child', { includeInactive: true })
      .map(message => [message.uuid, message.visibility]),
    [
      ['visible-root', 'visible'],
      ['inactive-child', 'inactive'],
    ],
  );
  assert.deepEqual(
    api.context('visible-child').parentChain.map(message => message.uuid),
    ['visible-root'],
  );
  assert.deepEqual(
    api.trace('visible-child').map(message => message.uuid),
    ['visible-root', 'visible-child'],
  );
  db.close();
});

test('raw rejects hidden targets and labels explicitly included inactive evidence', () => {
  const db = searchDb();
  const providerRegistry = {
    raw: ({ messageUuid }) => ({
      text: `raw:${messageUuid}`,
      totalLength: `raw:${messageUuid}`.length,
    }),
  };
  const api = createQueryApi(db, { providerRegistry });

  assert.equal(api.raw('msg-hidden'), null);
  assert.equal(api.raw('msg-hidden', { includeInactive: true }), null);
  assert.equal(api.raw('msg-inactive'), null);
  assert.deepEqual(
    api.raw('msg-inactive', { includeInactive: true }),
    {
      text: 'raw:msg-inactive',
      totalLength: 16,
      offset: 0,
      limit: 10000,
      hasMore: false,
      visibility: 'inactive',
    },
  );
  assert.equal(api.raw('msg-text').text, 'raw:msg-text');
  assert.equal(api.raw('msg-text').visibility, 'visible');
  db.close();
});

test('raw looks up cursors by provider unit identity instead of source path', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.prepare('INSERT INTO sessions (id,title,jsonl_path,source) VALUES (?,?,?,?)')
    .run('sid-raw-key', 'Raw key', '/alpha/agents/main/wire.jsonl', 'alpha');
  db.prepare(`
    INSERT INTO messages (uuid,session_id,type,role,text,content_type,visibility,source)
    VALUES (?,?,?,?,?,?,?,?)
  `).run('msg-raw-key', 'sid-raw-key', 'user', 'user', 'raw key', 'text', 'visible', 'alpha');
  db.prepare(`
    INSERT INTO index_state (jsonl_path,mtime,lines_processed,cursor)
    VALUES (?,?,?,?)
  `).run('alpha:unit', 10, 1, '10:1');
  let cursor;
  const provider = {
    sessionUnitKey: () => 'alpha:unit',
  };
  const providerRegistry = {
    get: () => provider,
    raw(input) {
      cursor = input.cursor;
      return { text: 'raw', totalLength: 3 };
    },
  };

  assert.equal(createQueryApi(db, { providerRegistry }).raw('msg-raw-key').text, 'raw');
  assert.equal(cursor, '10:1');
  db.close();
});

test('failures nextMessages does not leak hidden branch messages', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.prepare('INSERT INTO sessions (id,title,source) VALUES (?,?,?)')
    .run('sid-failure', 'Failure branch', 'pi');
  const insertMessage = db.prepare(`
    INSERT INTO messages (uuid,session_id,type,role,text,timestamp,visibility,source)
    VALUES (?,?,?,?,?,?,?,?)
  `);
  insertMessage.run('failure-result', 'sid-failure', 'user', 'toolResult', 'failed', '2026-08-02T10:00:00Z', 'visible', 'pi');
  insertMessage.run('hidden-next', 'sid-failure', 'assistant', 'assistant', 'abandoned', '2026-08-02T10:00:01Z', 'hidden', 'pi');
  insertMessage.run('inactive-next', 'sid-failure', 'assistant', 'assistant', 'superseded', '2026-08-02T10:00:02Z', 'inactive', 'pi');
  insertMessage.run('visible-next', 'sid-failure', 'assistant', 'assistant', 'recovered', '2026-08-02T10:00:03Z', 'visible', 'pi');
  db.prepare(`
    INSERT INTO tool_calls (id,message_uuid,session_id,name,input_json)
    VALUES (?,?,?,?,?)
  `).run('call-failure', 'failure-result', 'sid-failure', 'read', '{}');
  db.prepare(`
    INSERT INTO tool_results (tool_use_id,message_uuid,session_id,content,is_error)
    VALUES (?,?,?,?,?)
  `).run('call-failure', 'failure-result', 'sid-failure', 'failed', 1);

  const row = createQueryApi(db).failures('sid-failure')[0];
  assert.deepEqual(row.nextMessages.map(message => message.uuid), ['visible-next']);
  assert.equal(row.visibility, 'visible');
  assert.deepEqual(
    createQueryApi(db).failures({ sessionId: 'sid-failure', includeInactive: true })[0]
      .nextMessages.map(message => [message.uuid, message.visibility]),
    [
      ['inactive-next', 'inactive'],
      ['visible-next', 'visible'],
    ],
  );
  db.close();
});

test('failures gates both result and linked call message visibility', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.prepare('INSERT INTO sessions (id,title,source) VALUES (?,?,?)')
    .run('sid-edge-visibility', 'Tool edge visibility', 'pi');
  const insertMessage = db.prepare(`
    INSERT INTO messages (uuid,session_id,type,role,text,timestamp,visibility,source)
    VALUES (?,?,?,?,?,?,?,?)
  `);
  const insertCall = db.prepare(`
    INSERT INTO tool_calls (id,message_uuid,session_id,name,input_json,file_path)
    VALUES (?,?,?,?,?,?)
  `);
  const insertResult = db.prepare(`
    INSERT INTO tool_results (tool_use_id,message_uuid,session_id,content,is_error)
    VALUES (?,?,?,?,?)
  `);
  for (const [index, callVisibility] of ['visible', 'inactive', 'hidden'].entries()) {
    const callId = `call-${callVisibility}`;
    insertMessage.run(
      `message-${callVisibility}`,
      'sid-edge-visibility',
      'assistant',
      'assistant',
      null,
      `2026-08-02T10:00:0${index * 2}Z`,
      callVisibility,
      'pi',
    );
    insertMessage.run(
      `result-${callVisibility}`,
      'sid-edge-visibility',
      'user',
      'toolResult',
      `failed-${callVisibility}`,
      `2026-08-02T10:00:0${index * 2 + 1}Z`,
      'visible',
      'pi',
    );
    insertCall.run(
      callId,
      `message-${callVisibility}`,
      'sid-edge-visibility',
      'read',
      JSON.stringify({ path: `/${callVisibility}` }),
      `/${callVisibility}`,
    );
    insertResult.run(
      callId,
      `result-${callVisibility}`,
      'sid-edge-visibility',
      `failed-${callVisibility}`,
      1,
    );
  }
  const api = createQueryApi(db);

  assert.deepEqual(
    api.failures('sid-edge-visibility').map(record => record.toolCall.id),
    ['call-visible'],
  );
  assert.deepEqual(
    api.failures({ sessionId: 'sid-edge-visibility', includeInactive: true })
      .map(record => [record.toolCall.id, record.visibility])
      .sort(),
    [
      ['call-inactive', 'inactive'],
      ['call-visible', 'visible'],
    ],
  );
  db.close();
});

test('failures preserves orphaned error results without linked messages or calls', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.prepare('INSERT INTO sessions (id,title,source) VALUES (?,?,?)')
    .run('sid-orphan-failure', 'Orphan failure', 'codex');
  db.prepare(`
    INSERT INTO tool_results (tool_use_id,message_uuid,session_id,content,is_error)
    VALUES (?,?,?,?,?)
  `).run('missing-call', '', 'sid-orphan-failure', 'orphaned failure', 1);

  const rows = createQueryApi(db).failures('sid-orphan-failure');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].toolCall, undefined);
  assert.equal(rows[0].result.content, 'orphaned failure');
  assert.equal(rows[0].visibility, 'visible');
  assert.deepEqual(rows[0].nextMessages, []);
  db.close();
});

test('summaries, file history, and failures expose inactive rows only on request', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.prepare('INSERT INTO sessions (id,title,source) VALUES (?,?,?)')
    .run('sid-structured', 'Structured visibility', 'pi');
  const insertMessage = db.prepare(`
    INSERT INTO messages (uuid,session_id,type,role,text,timestamp,visibility,source)
    VALUES (?,?,?,?,?,?,?,?)
  `);
  const insertCall = db.prepare(`
    INSERT INTO tool_calls (id,message_uuid,session_id,name,input_json,file_path)
    VALUES (?,?,?,?,?,?)
  `);
  const insertResult = db.prepare(`
    INSERT INTO tool_results (tool_use_id,message_uuid,session_id,content,is_error)
    VALUES (?,?,?,?,?)
  `);
  const insertSummary = db.prepare(`
    INSERT INTO summaries (id,session_id,timestamp,source,content,visibility)
    VALUES (?,?,?,?,?,?)
  `);
  for (const [index, visibility] of ['visible', 'inactive', 'hidden'].entries()) {
    const suffix = visibility;
    const uuid = `message-${suffix}`;
    const callId = `call-${suffix}`;
    const timestamp = `2026-08-02T10:00:0${index}Z`;
    insertMessage.run(uuid, 'sid-structured', 'user', 'toolResult', suffix, timestamp, visibility, 'pi');
    insertCall.run(callId, uuid, 'sid-structured', 'read', '{}', '/tmp/visibility.ts');
    insertResult.run(callId, uuid, 'sid-structured', `failed-${suffix}`, 1);
    insertSummary.run(`summary-${suffix}`, 'sid-structured', timestamp, 'pi:branch_summary', suffix, visibility);
  }
  const api = createQueryApi(db);

  assert.deepEqual(api.fileHistory('/tmp/visibility.ts').map(row => row.visibility), ['visible']);
  assert.deepEqual(
    api.fileHistory('/tmp/visibility.ts', { includeInactive: true }).map(row => row.visibility),
    ['visible', 'inactive'],
  );
  assert.deepEqual(api.failures('sid-structured').map(row => row.visibility), ['visible']);
  assert.deepEqual(
    api.failures({ sessionId: 'sid-structured', includeInactive: true })
      .map(row => [row.visibility, row.result.visibility]),
    [
      ['inactive', 'inactive'],
      ['visible', 'visible'],
    ],
  );
  assert.deepEqual(api.summaries('sid-structured').map(row => row.visibility), ['visible']);
  assert.deepEqual(
    api.summaries({ sessionId: 'sid-structured', includeInactive: true })
      .map(row => row.visibility),
    ['inactive', 'visible'],
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

test('sql() accepts blocked keywords in literals, comments, and quoted identifiers', () => {
  const db = memoryDb();
  const api = createQueryApi(db);

  // The issue #107 repro: all of these are read-only and must not be
  // rejected for merely containing a blocked word.
  assert.equal(api.sql("SELECT 'live update' AS text")[0].text, 'live update');
  assert.equal(api.sql('SELECT 1 AS "delete"')[0].delete, 1);
  assert.equal(api.sql('SELECT 1 AS x -- INSERT INTO t')[0].x, 1);
  assert.equal(api.sql('SELECT 1 AS x /* DROP TABLE memories */')[0].x, 1);
  // A blocked word inside a LIKE literal: no rows match, and that is the
  // point — the query executes instead of being rejected.
  assert.deepEqual(
    api.sql("SELECT id FROM memories WHERE summary LIKE '%update%' ORDER BY id"),
    [],
  );
  // Recursive CTEs and pragma table-valued functions are read-only too.
  assert.equal(
    api.sql('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<3) SELECT x FROM c').length,
    3,
  );
  assert.ok(api.sql("SELECT name FROM pragma_table_info('memories')").length > 0);

  db.close();
});

test('sql() rejects writes with a SELECT/WITH prefix without mutating the database', () => {
  const db = memoryDb();
  const api = createQueryApi(db);
  const countMemories = () => db.prepare('SELECT COUNT(*) AS c FROM memories').get().c;

  assert.throws(
    () => api.sql("SELECT 1; DROP TABLE memories"),
    /exactly one SQL statement/,
  );

  // The write denylist runs through node:sqlite's setAuthorizer, added in
  // Node 24.10. On older supported Nodes (>=22.13) there is no prepare-time
  // classifier; the read-only connection is the boundary there (covered by
  // the next test), so these prepare-time assertions are capability-gated.
  if (typeof db.setAuthorizer === 'function') {
    assert.throws(
      () => api.sql("WITH c AS (SELECT 1) INSERT INTO memories (id, path, summary) SELECT 'mem-x', '/tmp/x.md', 'x' FROM c"),
      /sql\(\) only supports read-only SELECT\/WITH queries/,
    );
    assert.throws(
      () => api.sql('WITH c AS (SELECT 1) DELETE FROM memories'),
      /sql\(\) only supports read-only SELECT\/WITH queries/,
    );
    // The fixture database is writable, so these rows surviving proves the
    // semantic checks — not the read-only connection — blocked the writes.
  }
  assert.equal(countMemories(), 3);

  db.close();
});

test('a read-only connection fails writes closed on any supported Node version', () => {
  // The final mutation boundary must hold even where the prepare-time
  // authorizer does not exist (Node <24.10): the write fails at execute time
  // and the index does not change.
  const dir = makeTempDir('obelisk-readonly-boundary-');
  const dbPath = join(dir, 'index.sqlite');
  const seed = new DatabaseSync(dbPath);
  seed.exec(SCHEMA);
  seed.prepare('INSERT INTO memories (id, path, summary, created_at) VALUES (?, ?, ?, ?)')
    .run('mem-1', '/m.md', 'seed memory', '2026-08-01T00:00:00Z');
  seed.close();

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const api = createQueryApi(db);
  assert.throws(
    () => api.sql("WITH c AS (SELECT 1) INSERT INTO memories (id, path, summary) SELECT 'mem-x', '/tmp/x.md', 'x' FROM c"),
    // With the authorizer: the contract error at prepare time. Without it
    // (Node <24.10): SQLite's own read-only error at execute time.
    /read-only SELECT\/WITH|readonly database/i,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM memories').get().c, 1);
  db.close();
});

test('sql() enforces one statement per call with clear failures', () => {
  const db = memoryDb();
  const api = createQueryApi(db);

  assert.throws(() => api.sql('SELECT 1; SELECT 2'), /exactly one SQL statement/);
  assert.throws(() => api.sql('SELECT 1;; SELECT 2'), /exactly one SQL statement/);
  assert.throws(() => api.sql('SELECT 1; /* unterminated'), /exactly one SQL statement/);

  // A trailing semicolon and trailing comments are still a single statement.
  assert.equal(api.sql('SELECT 1;')[0]['1'], 1);
  assert.equal(api.sql('SELECT 1; -- trailing comment')[0]['1'], 1);
  assert.equal(api.sql('SELECT 1; /* trailing comment */')[0]['1'], 1);

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

test('remember regenerates the id on a primary-key collision instead of overwriting', () => {
  const memoryDir = makeTempDir('obelisk-remember-collision-');
  const memoryPath = join(memoryDir, 'memory.md');
  writeFileSync(memoryPath, '# Memory\n');

  const inserted = [];
  const attempted = [];
  let failFirstInsert = true;
  const fakeDb = {
    prepare(sql) {
      if (sql.startsWith('INSERT INTO memories')) {
        return {
          run: (...args) => {
            attempted.push(args[0]);
            if (failFirstInsert) {
              failFirstInsert = false;
              const error = new Error('UNIQUE constraint failed: memories.id');
              error.errcode = 1555; // SQLITE_CONSTRAINT_PRIMARYKEY
              throw error;
            }
            inserted.push(args);
          },
        };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
    exec() {},
    close() {},
  };

  const result = createAttuneApi(fakeDb).remember({
    path: memoryPath,
    project: 'collision-test',
    summary: 'Decision: memory ids regenerate on collision instead of overwriting.',
  });

  // The first attempt collided; the persisted row must carry a REGENERATED
  // id (a retry of the same id would satisfy inserted[0][0] === result.id),
  // and the existing row was never replaced (plain INSERT, not OR REPLACE).
  assert.equal(attempted.length, 2);
  assert.notEqual(attempted[0], attempted[1]);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0][0], result.id);
  assert.equal(attempted[1], result.id);
  assert.match(result.id, /^mem-[0-9a-f-]{36}$/);
});

test('remember stores absolute project-relative memory path', () => {
  const projectDir = makeTempDir('obelisk-memory-project-');
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
  const projectDir = makeTempDir('obelisk-memory-project-');
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
  const projectDir = makeTempDir('obelisk-memory-project-');
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
  const projectDir = makeTempDir('obelisk-memory-project-');
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

test('subagents after/before narrow by the subagent activity interval, not session IDs', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.prepare('INSERT INTO sessions (id,title,started_at) VALUES (?,?,?)')
    .run('sid-agents', 'Subagent session', '2026-06-01T09:00:00Z');
  const insertAgent = db.prepare(`
    INSERT INTO subagents (agent_id,session_id,agent_type,description)
    VALUES (?,?,?,?)
  `);
  insertAgent.run('agent-early', 'sid-agents', 'explore', 'Early agent');
  insertAgent.run('agent-late', 'sid-agents', 'coder', 'Late agent');
  insertAgent.run('agent-spanning', 'sid-agents', 'coder', 'Agent active across the bound');
  const insertMessage = db.prepare(`
    INSERT INTO messages (uuid,session_id,type,role,text,timestamp,agent_id)
    VALUES (?,?,?,?,?,?,?)
  `);
  insertMessage.run('m-early-1', 'sid-agents', 'assistant', 'assistant', 'early start', '2026-06-01T10:00:00Z', 'agent-early');
  insertMessage.run('m-early-2', 'sid-agents', 'assistant', 'assistant', 'early end', '2026-06-01T10:05:00Z', 'agent-early');
  insertMessage.run('m-late-1', 'sid-agents', 'assistant', 'assistant', 'late start', '2026-06-03T10:00:00Z', 'agent-late');
  insertMessage.run('m-span-1', 'sid-agents', 'assistant', 'assistant', 'spanning start', '2026-06-01T12:00:00Z', 'agent-spanning');
  insertMessage.run('m-span-2', 'sid-agents', 'assistant', 'assistant', 'spanning end', '2026-06-03T12:00:00Z', 'agent-spanning');
  const api = createQueryApi(db);

  // `after` keeps agents still active past the bound: the spanning agent's
  // interval crosses 06-02 even though it started before it.
  assert.deepEqual(
    api.subagents({ after: '2026-06-02T00:00:00Z' }).map((row) => row.agent_id).sort(),
    ['agent-late', 'agent-spanning'],
  );
  // `before` keeps agents already started by the bound.
  assert.deepEqual(
    api.subagents({ before: '2026-06-02T00:00:00Z' }).map((row) => row.agent_id).sort(),
    ['agent-early', 'agent-spanning'],
  );
  // Combined bounds select every agent active during the window.
  assert.deepEqual(
    api.subagents({ after: '2026-06-01T09:00:00Z', before: '2026-06-04T00:00:00Z' }).map((row) => row.agent_id).sort(),
    ['agent-early', 'agent-late', 'agent-spanning'],
  );
  // A window inside the spanning agent's interval matches it alone.
  assert.deepEqual(
    api.subagents({ after: '2026-06-02T00:00:00Z', before: '2026-06-03T00:00:00Z' }).map((row) => row.agent_id),
    ['agent-spanning'],
  );

  db.close();
});

test('subagents() derives total_tokens from sidechain message usage', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.prepare("INSERT INTO sessions (id, title, source) VALUES ('sid-sub', 'sub parent', 'deepseek')").run();
  // The stored row carries no total_tokens: the value is derived at query time.
  db.prepare("INSERT INTO subagents (agent_id, session_id, agent_type, description) VALUES ('deepseek:agent-1', 'sid-sub', 'deepseek-official', 'helper')").run();
  const insertMsg = db.prepare("INSERT INTO messages (uuid, session_id, type, role, text, timestamp, agent_id, input_tokens, output_tokens, source) VALUES (?,?,?,?,?,?,?,?,?,?)");
  insertMsg.run('sub-m1', 'sid-sub', 'assistant', 'assistant', 'a', '2026-06-01T00:00:00Z', 'deepseek:agent-1', 10, 5, 'deepseek');
  insertMsg.run('sub-m2', 'sid-sub', 'assistant', 'assistant', 'b', '2026-06-01T00:01:00Z', 'deepseek:agent-1', 3, 2, 'deepseek');

  const api = createQueryApi(db);
  const row = api.subagents()[0];
  assert.equal(row.agent_id, 'deepseek:agent-1');
  assert.equal(row.total_tokens, 20); // (10+5) + (3+2)
  assert.equal(row.messageCount, 2);

  db.close();
});

test('subagents() never overrides a provider-stored total_tokens (codex regression)', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.prepare("INSERT INTO sessions (id, title, source) VALUES ('sid-codex', 'codex parent', 'codex')").run();
  // Codex stores total_tokens authoritatively at persist time; the derived
  // message sum (30) must not replace the stored value (20).
  db.prepare("INSERT INTO subagents (agent_id, session_id, agent_type, total_tokens) VALUES ('codex:agent-1', 'sid-codex', 'worker', 20)").run();
  const insertMsg = db.prepare("INSERT INTO messages (uuid, session_id, type, role, text, timestamp, agent_id, input_tokens, output_tokens, source) VALUES (?,?,?,?,?,?,?,?,?,?)");
  insertMsg.run('cx-m1', 'sid-codex', 'assistant', 'assistant', 'a', '2026-06-01T00:00:00Z', 'codex:agent-1', 10, 5, 'codex');
  insertMsg.run('cx-m2', 'sid-codex', 'assistant', 'assistant', 'b', '2026-06-01T00:01:00Z', 'codex:agent-1', 10, 5, 'codex');

  const api = createQueryApi(db);
  const row = api.subagents()[0];
  assert.equal(row.total_tokens, 20);

  const ctx = api.context('cx-m1');
  assert.equal(ctx.subagent.total_tokens, 20);

  db.close();
});
