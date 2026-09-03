// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { persist } from '../packages/core/src/persist.ts';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const appDir = fileURLToPath(new URL('../app/', import.meta.url));
const BetterSqlite3 = require(require.resolve('better-sqlite3', { paths: [appDir] }));
const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');

const bindings = [
  ['node:sqlite', () => new DatabaseSync(':memory:')],
  ['better-sqlite3', () => new BetterSqlite3(':memory:')],
];

function canonicalKind(sql) {
  const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
  if (/\b(?:from|join) messages\b/.test(normalized) || normalized.startsWith('insert into messages ') || normalized.startsWith('update messages ')) return 'messages';
  if (/\b(?:from|join) tool_calls\b/.test(normalized) || normalized.startsWith('insert into tool_calls ')) return 'tool_calls';
  if (/\b(?:from|join) tool_results\b/.test(normalized) || normalized.startsWith('insert into tool_results ')) return 'tool_results';
  return null;
}

function instrument(db) {
  const metrics = { reads: 0, writes: 0, byTable: {} };
  const record = (sql, method) => {
    const table = canonicalKind(sql);
    if (table == null) return;
    const operation = method === 'all' || method === 'get' ? 'reads' : 'writes';
    metrics[operation] += 1;
    metrics.byTable[table] ??= { reads: 0, writes: 0 };
    metrics.byTable[table][operation] += 1;
  };
  return {
    metrics,
    reset() {
      metrics.reads = 0;
      metrics.writes = 0;
      metrics.byTable = {};
    },
    handle: {
      exec(sql) { return db.exec(sql); },
      prepare(sql) {
        const statement = db.prepare(sql);
        return {
          all(...bindings) { record(sql, 'all'); return statement.all(...bindings); },
          get(...bindings) { record(sql, 'get'); return statement.get(...bindings); },
          run(...bindings) { record(sql, 'run'); return statement.run(...bindings); },
          get readonly() { return statement.readonly; },
          get sourceSQL() { return statement.sourceSQL; },
        };
      },
      close() { return db.close(); },
    },
  };
}

function message(id, changes = {}) {
  return {
    kind: 'message',
    uuid: `message-${id}`,
    session_id: 'session-1',
    type: 'assistant',
    parent_uuid: null,
    timestamp: `2026-09-01T10:${String(id % 60).padStart(2, '0')}:00.000Z`,
    role: 'assistant',
    text: `stable searchable text ${id}`,
    content_type: 'text',
    is_meta: 0,
    visibility: 'visible',
    model: 'model-1',
    is_sidechain: 0,
    agent_id: null,
    input_tokens: 10,
    output_tokens: 20,
    cwd: '/workspace',
    skill: null,
    source: 'codex',
    ...changes,
  };
}

function toolCall(id, changes = {}) {
  return {
    kind: 'tool_call',
    id: `call-${id}`,
    message_uuid: `message-${id}`,
    session_id: 'session-1',
    name: 'exec_command',
    presentation: 'default',
    input_json: '{"cmd":"true"}',
    file_path: null,
    ...changes,
  };
}

function toolResult(id, changes = {}) {
  return {
    kind: 'tool_result',
    tool_use_id: `call-${id}`,
    message_uuid: `message-${id}`,
    session_id: 'session-1',
    content: 'done',
    file_path: null,
    is_error: 0,
    ...changes,
  };
}

function* snapshot(count, changedId = null) {
  for (let id = 0; id < count; id += 1) {
    const changed = id === changedId;
    yield message(id, changed ? { text: `changed searchable text ${id}`, input_tokens: null, skill: 'review' } : {});
    yield toolCall(id, changed ? { presentation: 'skill', file_path: '/tmp/input' } : {});
    yield toolResult(id, changed ? { content: 'changed output', file_path: '/tmp/output', is_error: 1 } : {});
    yield { kind: 'message-turn-duration', uuid: `message-${id}`, turn_duration_ms: changed ? null : 42 };
  }
  return null;
}

function* records(items) {
  yield* items;
  return null;
}

for (const [binding, openDb] of bindings) {
  test(`${binding}: short delta keeps the direct write path`, () => {
    const rawDb = openDb();
    rawDb.exec(SCHEMA);
    const observed = instrument(rawDb);

    persist(
      observed.handle,
      { key: 'delta-unit', sessionId: 'session-1' },
      records([message('delta')]),
    );

    assert.equal(observed.metrics.reads, 0);
    assert.equal(observed.metrics.writes, 1);
    rawDb.close();
  });

  test(`${binding}: unchanged snapshot rows do not execute one SQLite statement each`, (t) => {
    const rawDb = openDb();
    rawDb.exec(SCHEMA);
    const observed = instrument(rawDb);
    const unit = { key: 'unit-1', sessionId: 'session-1' };

    persist(observed.handle, unit, snapshot(1_000));
    const rowids = {
      message: rawDb.prepare('SELECT rowid FROM messages WHERE uuid=?').get('message-500').rowid,
      toolCall: rawDb.prepare('SELECT rowid FROM tool_calls WHERE id=?').get('call-500').rowid,
      toolResult: rawDb.prepare('SELECT rowid FROM tool_results WHERE tool_use_id=?').get('call-500').rowid,
    };
    observed.reset();

    persist(observed.handle, unit, snapshot(1_001, 500));

    const classification = {
      emitted: 4_004,
      existing: 4_000,
      new: 4,
      modified: 4,
      unchanged: 3_996,
    };
    t.diagnostic(JSON.stringify({ classification, sqlite: observed.metrics }));
    assert.equal(observed.metrics.writes, classification.new + classification.modified);
    assert.ok(
      observed.metrics.reads + observed.metrics.writes < 80,
      `${observed.metrics.reads + observed.metrics.writes} canonical SQLite executions remain for ${classification.emitted} emitted records`,
    );
    assert.deepEqual(
      {
        message: rawDb.prepare('SELECT rowid FROM messages WHERE uuid=?').get('message-500').rowid,
        toolCall: rawDb.prepare('SELECT rowid FROM tool_calls WHERE id=?').get('call-500').rowid,
        toolResult: rawDb.prepare('SELECT rowid FROM tool_results WHERE tool_use_id=?').get('call-500').rowid,
      },
      rowids,
    );
    assert.deepEqual(
      { ...rawDb.prepare('SELECT text,input_tokens,skill,turn_duration_ms FROM messages WHERE uuid=?').get('message-500') },
      { text: 'changed searchable text 500', input_tokens: null, skill: 'review', turn_duration_ms: null },
    );
    assert.equal(rawDb.prepare("SELECT COUNT(*) AS count FROM messages_fts WHERE messages_fts MATCH 'changed'").get().count, 1);
    assert.equal(rawDb.prepare("SELECT COUNT(*) AS count FROM messages_fts WHERE messages_fts MATCH 'stable AND 500'").get().count, 0);
    rawDb.prepare("INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1)").run();
    rawDb.close();
  });

  test(`${binding}: replay filtering preserves repeated-key order and delete/reinsert order`, () => {
    const db = openDb();
    db.exec(SCHEMA);
    const unit = { key: 'unit-1', sessionId: 'session-1' };
    persist(db, unit, records([message(1)]));
    const originalRowid = db.prepare('SELECT rowid FROM messages WHERE uuid=?').get('message-1').rowid;

    persist(db, unit, records([
      message(1, { text: 'temporary value' }),
      message(1),
    ]));
    assert.equal(db.prepare('SELECT text FROM messages WHERE uuid=?').get('message-1').text, 'stable searchable text 1');
    assert.equal(db.prepare('SELECT rowid FROM messages WHERE uuid=?').get('message-1').rowid, originalRowid);

    persist(db, unit, records([
      { kind: 'delete-session', sessionId: 'session-1' },
      message(1),
    ]));
    assert.equal(db.prepare('SELECT text FROM messages WHERE uuid=?').get('message-1').text, 'stable searchable text 1');
    db.close();
  });
}
