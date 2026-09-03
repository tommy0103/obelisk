// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { healWorkflowParentLinks } from '../packages/core/src/indexer.ts';
import { persist } from '../packages/core/src/persist.ts';
import {
  bindings,
  messageRecord,
  openNodeSqlite,
  SCHEMA,
  toolCallRecord,
  toolResultRecord,
} from './persist-test-fixtures.mjs';

const BASE_MESSAGE = messageRecord(1, {
  timestamp: '2026-09-01T10:00:00.000Z',
  text: 'stable searchable text',
});
const BASE_TOOL_CALL = toolCallRecord(1);
const BASE_TOOL_RESULT = toolResultRecord(1);

function installWriteAudit(db) {
  db.exec(`
    CREATE TABLE write_audit (table_name TEXT NOT NULL, operation TEXT NOT NULL);
    CREATE TRIGGER audit_messages_insert AFTER INSERT ON messages BEGIN
      INSERT INTO write_audit VALUES ('messages', 'insert');
    END;
    CREATE TRIGGER audit_messages_update AFTER UPDATE ON messages BEGIN
      INSERT INTO write_audit VALUES ('messages', 'update');
    END;
    CREATE TRIGGER audit_messages_delete AFTER DELETE ON messages BEGIN
      INSERT INTO write_audit VALUES ('messages', 'delete');
    END;
    CREATE TRIGGER audit_tool_calls_insert AFTER INSERT ON tool_calls BEGIN
      INSERT INTO write_audit VALUES ('tool_calls', 'insert');
    END;
    CREATE TRIGGER audit_tool_calls_update AFTER UPDATE ON tool_calls BEGIN
      INSERT INTO write_audit VALUES ('tool_calls', 'update');
    END;
    CREATE TRIGGER audit_tool_calls_delete AFTER DELETE ON tool_calls BEGIN
      INSERT INTO write_audit VALUES ('tool_calls', 'delete');
    END;
    CREATE TRIGGER audit_tool_results_insert AFTER INSERT ON tool_results BEGIN
      INSERT INTO write_audit VALUES ('tool_results', 'insert');
    END;
    CREATE TRIGGER audit_tool_results_update AFTER UPDATE ON tool_results BEGIN
      INSERT INTO write_audit VALUES ('tool_results', 'update');
    END;
    CREATE TRIGGER audit_tool_results_delete AFTER DELETE ON tool_results BEGIN
      INSERT INTO write_audit VALUES ('tool_results', 'delete');
    END;
  `);
}

function* canonicalRecords({ message = {}, toolCall = {}, toolResult = {}, duration = 42 } = {}) {
  yield { ...BASE_MESSAGE, ...message };
  yield { ...BASE_TOOL_CALL, ...toolCall };
  yield { ...BASE_TOOL_RESULT, ...toolResult };
  yield { kind: 'message-turn-duration', uuid: 'message-1', turn_duration_ms: duration };
  return null;
}

function* replaySizedRecord(record) {
  yield record;
  for (let index = 0; index < 249; index += 1) {
    yield { kind: 'message-turn-duration', uuid: `missing-${index}`, turn_duration_ms: null };
  }
  return null;
}

function* oneRecord(record) {
  yield record;
  return null;
}

for (const [binding, openDb] of bindings) {
  test(`${binding}: identical replay performs no canonical writes`, () => {
    const db = openDb();
    db.exec(SCHEMA);
    installWriteAudit(db);
    const unit = { key: 'unit-1', sessionId: 'session-1' };

    persist(db, unit, canonicalRecords());
    const rowids = {
      message: db.prepare('SELECT rowid FROM messages WHERE uuid=?').get('message-1').rowid,
      toolCall: db.prepare('SELECT rowid FROM tool_calls WHERE id=?').get('call-1').rowid,
      toolResult: db.prepare('SELECT rowid FROM tool_results WHERE tool_use_id=?').get('call-1').rowid,
    };
    db.prepare('DELETE FROM write_audit').run();

    persist(db, unit, canonicalRecords());

    assert.deepEqual(db.prepare('SELECT * FROM write_audit').all(), []);
    assert.deepEqual(
      {
        message: db.prepare('SELECT rowid FROM messages WHERE uuid=?').get('message-1').rowid,
        toolCall: db.prepare('SELECT rowid FROM tool_calls WHERE id=?').get('call-1').rowid,
        toolResult: db.prepare('SELECT rowid FROM tool_results WHERE tool_use_id=?').get('call-1').rowid,
      },
      rowids,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM messages_fts WHERE messages_fts MATCH 'searchable'").get().count,
      1,
    );
    db.close();
  });

  test(`${binding}: changed and NULL-transitioned values update in place`, () => {
    const db = openDb();
    db.exec(SCHEMA);
    installWriteAudit(db);
    const unit = { key: 'unit-1', sessionId: 'session-1' };
    const changed = {
      message: {
        text: 'changed searchable text',
        agent_id: 'agent-1',
        input_tokens: null,
        skill: 'review',
      },
      toolCall: {
        presentation: 'skill',
        input_json: '{"cmd":"false"}',
        file_path: '/tmp/input',
      },
      toolResult: {
        content: 'changed output',
        file_path: '/tmp/output',
        is_error: 1,
      },
      duration: null,
    };

    persist(db, unit, canonicalRecords());
    const rowids = {
      message: db.prepare('SELECT rowid FROM messages WHERE uuid=?').get('message-1').rowid,
      toolCall: db.prepare('SELECT rowid FROM tool_calls WHERE id=?').get('call-1').rowid,
      toolResult: db.prepare('SELECT rowid FROM tool_results WHERE tool_use_id=?').get('call-1').rowid,
    };
    db.prepare('DELETE FROM write_audit').run();

    persist(db, unit, canonicalRecords(changed));

    assert.deepEqual(
      { ...db.prepare('SELECT text,agent_id,input_tokens,skill,turn_duration_ms FROM messages WHERE uuid=?').get('message-1') },
      {
        text: 'changed searchable text',
        agent_id: 'agent-1',
        input_tokens: null,
        skill: 'review',
        turn_duration_ms: null,
      },
    );
    assert.deepEqual(
      { ...db.prepare('SELECT presentation,input_json,file_path FROM tool_calls WHERE id=?').get('call-1') },
      { presentation: 'skill', input_json: '{"cmd":"false"}', file_path: '/tmp/input' },
    );
    assert.deepEqual(
      { ...db.prepare('SELECT content,file_path,is_error FROM tool_results WHERE tool_use_id=?').get('call-1') },
      { content: 'changed output', file_path: '/tmp/output', is_error: 1 },
    );
    assert.deepEqual(
      {
        message: db.prepare('SELECT rowid FROM messages WHERE uuid=?').get('message-1').rowid,
        toolCall: db.prepare('SELECT rowid FROM tool_calls WHERE id=?').get('call-1').rowid,
        toolResult: db.prepare('SELECT rowid FROM tool_results WHERE tool_use_id=?').get('call-1').rowid,
      },
      rowids,
    );
    assert.deepEqual(
      db.prepare(`
        SELECT table_name, operation, COUNT(*) AS count
        FROM write_audit
        GROUP BY table_name, operation
        ORDER BY table_name
      `).all().map(row => ({ ...row })),
      [
        { table_name: 'messages', operation: 'update', count: 2 },
        { table_name: 'tool_calls', operation: 'update', count: 1 },
        { table_name: 'tool_results', operation: 'update', count: 1 },
      ],
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM messages_fts WHERE messages_fts MATCH 'stable'").get().count,
      0,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM messages_fts WHERE messages_fts MATCH 'changed'").get().count,
      1,
    );
    db.prepare("INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1)").run();
    db.close();
  });
}

const AUTHORITATIVE_FIELD_CASES = [
  ['messages', 'uuid', BASE_MESSAGE, {
    session_id: 'session-2', type: 'user', parent_uuid: 'parent-1', timestamp: null,
    role: null, text: null, content_type: null, is_meta: 1, visibility: 'hidden',
    model: null, is_sidechain: 1, agent_id: 'agent-1', input_tokens: null,
    output_tokens: null, cwd: null, skill: 'review', source: 'claude',
  }],
  ['tool_calls', 'id', BASE_TOOL_CALL, {
    message_uuid: 'message-2', session_id: 'session-2', name: 'read_file',
    presentation: 'skill', input_json: '{}', file_path: '/tmp/input',
  }],
  ['tool_results', 'tool_use_id', BASE_TOOL_RESULT, {
    message_uuid: 'message-2', session_id: 'session-2', content: 'changed',
    file_path: '/tmp/output', is_error: 1,
  }],
];

function assertEveryAuthoritativeField(recordStream) {
  const db = openNodeSqlite();
  db.exec(SCHEMA);
  const unit = { key: 'unit-1', sessionId: 'session-1' };
  persist(db, unit, canonicalRecords());

  for (const [table, key, base, changes] of AUTHORITATIVE_FIELD_CASES) {
    for (const [column, value] of Object.entries(changes)) {
      persist(db, unit, recordStream({ ...base, [column]: value }));
      assert.equal(
        db.prepare(`SELECT ${column} AS value FROM ${table} WHERE ${key}=?`).get(base[key]).value,
        value,
        `${table}.${column} did not update`,
      );
      persist(db, unit, recordStream(base));
    }
  }

  db.close();
}

test('direct path lets every authoritative field independently trigger an in-place update', () => {
  assertEveryAuthoritativeField(oneRecord);
});

test('replay filtering lets every authoritative field independently trigger an in-place update', () => {
  assertEveryAuthoritativeField(replaySizedRecord);
});

test('changed tool-result replay preserves workflow healer candidate order', () => {
  const db = openNodeSqlite();
  db.exec(SCHEMA);
  const unit = { key: 'unit-1', sessionId: 'session-1' };
  const toolResult = (id, content) => ({
    kind: 'tool_result',
    tool_use_id: id,
    message_uuid: 'message-1',
    session_id: 'session-1',
    content,
    file_path: null,
    is_error: 0,
  });
  function* initialRecords() {
    for (const id of ['call-1', 'call-2']) {
      yield {
        kind: 'tool_call',
        id,
        message_uuid: 'message-1',
        session_id: 'session-1',
        name: 'Workflow',
        presentation: 'default',
        input_json: '{}',
        file_path: null,
      };
      yield toolResult(id, `Run ID: run-1; result from ${id}`);
    }
    return null;
  }
  function* changedFirstResult() {
    yield toolResult('call-1', 'Run ID: run-1; updated result from call-1');
    return null;
  }

  persist(db, unit, initialRecords());
  const firstRowid = db.prepare('SELECT rowid FROM tool_results WHERE tool_use_id=?').get('call-1').rowid;
  persist(db, unit, changedFirstResult());
  db.prepare(`
    INSERT INTO workflows (run_id, session_id, parent_tool_use_id)
    VALUES ('run-1', 'session-1', NULL)
  `).run();

  healWorkflowParentLinks(db);

  assert.equal(db.prepare('SELECT rowid FROM tool_results WHERE tool_use_id=?').get('call-1').rowid, firstRowid);
  assert.equal(db.prepare('SELECT parent_tool_use_id FROM workflows WHERE run_id=?').get('run-1').parent_tool_use_id, 'call-1');
  db.close();
});
