// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Canonical hard gate: a full Codex snapshot must assemble identically before
// and after persistence, and prefix + cooperative append must converge to the
// same SQLite projection as parsing the final source from scratch.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { persist } from '../packages/core/src/persist.ts';
import { assembleSessionDetail } from '../packages/core/src/session-detail.ts';
import { createCodexParseMetrics, createCodexProvider, parse } from '../packages/core/src/providers/codex.ts';
import { makeTempDir } from './temp-dirs.mjs';

const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');
const ID = '019ed000-0000-7000-8000-000000000201';
const SESSION_ID = `codex:${ID}`;
const META = { id: ID, cwd: '/tmp/codex-convergence', timestamp: '2026-06-15T10:00:00Z', cli_version: '1.0', git: { branch: 'main' } };

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}

function drain(gen) {
  const values = [];
  let step = gen.next();
  while (!step.done) { values.push(step.value); step = gen.next(); }
  return { values, ret: step.value };
}

function detailRows(db, sessionId = SESSION_ID) {
  return {
    session: db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId),
    messages: db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY timestamp, uuid').all(sessionId),
    toolCalls: db.prepare('SELECT * FROM tool_calls WHERE session_id=? ORDER BY id').all(sessionId),
    toolResults: db.prepare('SELECT * FROM tool_results WHERE session_id=? ORDER BY tool_use_id').all(sessionId),
    subagents: db.prepare('SELECT * FROM subagents WHERE session_id=? ORDER BY agent_id').all(sessionId),
    workflows: [],
    summaries: db.prepare('SELECT * FROM summaries WHERE session_id=? ORDER BY id').all(sessionId),
  };
}

function dumpDb(db) {
  const q = (sql) => db.prepare(sql).all();
  return {
    sessions: q('SELECT id, title, project, started_at, ended_at, git_branch, version, message_count, source FROM sessions ORDER BY id'),
    messages: q('SELECT uuid, session_id, type, parent_uuid, timestamp, role, text, content_type, is_meta, visibility, model, is_sidechain, agent_id, input_tokens, output_tokens, turn_duration_ms, cwd, skill, source FROM messages ORDER BY uuid'),
    toolCalls: q('SELECT id, message_uuid, session_id, name, presentation, input_json, file_path FROM tool_calls ORDER BY id'),
    toolResults: q('SELECT tool_use_id, message_uuid, session_id, content, file_path, is_error FROM tool_results ORDER BY tool_use_id'),
    subagents: q('SELECT agent_id, session_id, parent_tool_use_id, agent_type, description, duration_ms, total_tokens FROM subagents ORDER BY agent_id'),
    summaries: q('SELECT id, session_id, timestamp, source, content, visibility, input_tokens, output_tokens FROM summaries ORDER BY id'),
  };
}

function unit(path, indexedTitle = 'Indexed title') {
  return {
    key: path,
    sessionId: SESSION_ID,
    meta: { source: 'codex', guardian: false, indexedTitle, indexedUpdatedAt: '2026-06-15T11:00:00Z' },
  };
}

function prefixLines() {
  return [
    { type: 'session_meta', timestamp: '2026-06-15T10:00:00Z', payload: META },
    { type: 'event_msg', timestamp: '2026-06-15T10:00:01Z', payload: { type: 'user_message', message: 'inspect this' } },
    { type: 'event_msg', timestamp: '2026-06-15T10:00:02Z', payload: { type: 'agent_message', message: 'working' } },
    { type: 'response_item', timestamp: '2026-06-15T10:00:02Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'working' }] } },
    { type: 'response_item', timestamp: '2026-06-15T10:00:03Z', payload: { type: 'function_call', call_id: 'call_boundary', name: 'shell', arguments: '{"cmd":"pwd"}' } },
  ];
}

function suffixLines() {
  return [
    { type: 'response_item', timestamp: '2026-06-15T10:00:04Z', payload: { type: 'function_call_output', call_id: 'call_boundary', output: '/tmp/codex-convergence' } },
    { type: 'event_msg', timestamp: '2026-06-15T10:00:05Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, output_tokens: 50 } } } },
    { type: 'event_msg', timestamp: '2026-06-15T10:00:06Z', payload: { type: 'task_complete', duration_ms: 1500 } },
    { type: 'event_msg', timestamp: '2026-06-15T10:00:07Z', payload: { type: 'user_message', message: '<environment_context>hidden</environment_context>' } },
    { type: 'event_msg', timestamp: '2026-06-15T10:00:08Z', payload: { type: 'user_message', message: 'follow up' } },
  ];
}

function writeJsonl(path, lines) {
  writeFileSync(path, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`);
}

const REAL_FIXTURE = new URL('./fixtures/codex/real-rollout-structural-sanitized.jsonl', import.meta.url);
const REAL_PREFIX_FIXTURE = new URL('./fixtures/codex/real-rollout-structural-sanitized-prefix.jsonl', import.meta.url);

test('Codex direct canonical assembly equals SQLite round-trip', () => {
  const path = join(makeTempDir('obelisk-codex-roundtrip-'), 'rollout.jsonl');
  writeJsonl(path, [...prefixLines(), ...suffixLines()]);
  const sourceUnit = unit(path);
  const direct = assembleSessionDetail(drain(parse(sourceUnit, null)).values);
  const db = freshDb();
  persist(db, sourceUnit, parse(sourceUnit, null));

  assert.deepEqual(assembleSessionDetail(detailRows(db)), direct);
  const assistant = db.prepare('SELECT input_tokens, output_tokens, turn_duration_ms FROM messages WHERE uuid=?').get(`codex:${ID}:000003`);
  assert.deepEqual({ ...assistant }, { input_tokens: 100, output_tokens: 50, turn_duration_ms: 1500 });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE visibility='hidden'").get().count, 1, 'hidden rows persist even though assembly omits them');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tool_results WHERE message_uuid=?').get(`codex:${ID}:000005`).count, 1);
  db.close();
});

test('real sanitized Codex output round-trips through SQLite', () => {
  const path = join(makeTempDir('obelisk-codex-real-roundtrip-'), 'rollout.jsonl');
  copyFileSync(REAL_FIXTURE, path);
  const sourceUnit = { key: path, sessionId: '', meta: { source: 'codex', guardian: false } };
  const direct = assembleSessionDetail(drain(parse(sourceUnit, null)).values);
  const db = freshDb();
  persist(db, sourceUnit, parse(sourceUnit, null));
  assert.deepEqual(assembleSessionDetail(detailRows(db, direct.session.id)), direct);
  assert.ok(db.prepare('SELECT COUNT(*) AS count FROM tool_calls').get().count > 0, 'fixture retains real tool-call shapes');
  assert.ok(db.prepare('SELECT COUNT(*) AS count FROM tool_results').get().count > 0, 'fixture retains real tool-result shapes');
  db.close();
});

test('real sanitized Codex prefix plus append converges SQLite projection', () => {
  const fullPath = join(makeTempDir('obelisk-codex-real-full-'), 'rollout.jsonl');
  copyFileSync(REAL_FIXTURE, fullPath);
  const dbFull = freshDb();
  persist(dbFull, { key: fullPath, sessionId: '', meta: { source: 'codex', guardian: false } }, parse({ key: fullPath, sessionId: '', meta: { source: 'codex', guardian: false } }, null));

  const path = join(makeTempDir('obelisk-codex-real-split-'), 'rollout.jsonl');
  copyFileSync(REAL_PREFIX_FIXTURE, path);
  const dbSplit = freshDb();
  const prefixUnit = { key: path, sessionId: '', meta: { source: 'codex', guardian: false } };
  const cursor = persist(dbSplit, prefixUnit, parse(prefixUnit, null));
  const complete = readFileSync(REAL_FIXTURE, 'utf8').split('\n');
  appendFileSync(path, `${complete.slice(60).filter(Boolean).join('\n')}\n`);
  const metrics = createCodexParseMetrics();
  persist(dbSplit, { key: path, sessionId: '', meta: { source: 'codex', guardian: false } }, parse({ key: path, sessionId: '', meta: { source: 'codex', guardian: false } }, cursor, metrics));

  assert.notEqual(metrics.plan, null);
  assert.deepEqual(dumpDb(dbSplit), dumpDb(dbFull));
  dbFull.close();
  dbSplit.close();
});

test('Codex child rewritten as guardian retracts only its persisted contribution', () => {
  const root = makeTempDir('obelisk-codex-guardian-retract-');
  const path = join(root, 'sessions', '2026', '06', '15', 'child.jsonl');
  mkdirSync(join(root, 'sessions', '2026', '06', '15'), { recursive: true });
  const parentId = '019ed000-0000-7000-8000-000000000202';
  const childId = '019ed000-0000-7000-8000-000000000203';
  const parentSessionId = `codex:${parentId}`;
  const childMeta = {
    id: childId, cwd: '/tmp/codex-guardian-retract', timestamp: '2026-06-15T10:00:00Z',
    source: { subagent: { thread_spawn: { parent_thread_id: parentId, agent_role: 'worker' } } },
  };
  writeJsonl(path, [
    { type: 'session_meta', timestamp: '2026-06-15T10:00:00Z', payload: childMeta },
    { type: 'event_msg', timestamp: '2026-06-15T10:00:01Z', payload: { type: 'user_message', message: 'child contribution' } },
    { type: 'response_item', timestamp: '2026-06-15T10:00:02Z', payload: { type: 'function_call', call_id: 'child-call', name: 'shell', arguments: '{}' } },
    { type: 'response_item', timestamp: '2026-06-15T10:00:03Z', payload: { type: 'function_call_output', call_id: 'child-call', output: 'child output' } },
  ]);
  const provider = createCodexProvider({ rootDir: root });
  const cursorByPath = new Map();
  const discover = () => provider.discover({ lastCursor: (key) => cursorByPath.get(key) ?? null });
  const db = freshDb();
  const parentUnit = { key: 'parent.jsonl', sessionId: parentSessionId, meta: { source: 'codex', guardian: false } };
  persist(db, parentUnit, (function* () {
    yield { kind: 'session', id: parentSessionId, title: 'parent', project: 'codex-guardian-retract', started_at: '2026-06-15T09:00:00Z', ended_at: '2026-06-15T09:00:00Z', git_branch: null, version: null, message_count: 1, countMode: 'total', jsonl_path: 'parent.jsonl', source: 'codex' };
    yield { kind: 'message', uuid: `codex:${parentId}:000001`, session_id: parentSessionId, type: 'user', parent_uuid: null, timestamp: '2026-06-15T09:00:00Z', role: 'user', text: 'parent contribution', content_type: 'text', is_meta: 0, visibility: 'visible', model: null, is_sidechain: 0, agent_id: null, input_tokens: null, output_tokens: null, cwd: '/tmp/codex-guardian-retract', skill: null, source: 'codex' };
    yield { kind: 'message', uuid: `codex:${parentId}:000002`, session_id: parentSessionId, type: 'assistant', parent_uuid: `codex:${parentId}:000001`, timestamp: '2026-06-15T09:00:01Z', role: 'assistant', text: null, content_type: 'tool_use', is_meta: 0, visibility: 'visible', model: null, is_sidechain: 0, agent_id: null, input_tokens: null, output_tokens: null, cwd: '/tmp/codex-guardian-retract', skill: null, source: 'codex' };
    yield { kind: 'tool_call', id: `codex:${parentId}:parent-call`, message_uuid: `codex:${parentId}:000002`, session_id: parentSessionId, name: 'shell', presentation: 'default', input_json: '{}', file_path: null };
    yield { kind: 'tool_result', tool_use_id: `codex:${parentId}:parent-call`, message_uuid: `codex:${parentId}:000002`, session_id: parentSessionId, content: 'parent output', file_path: null, is_error: 0 };
  })());

  const [childUnit] = discover();
  assert.equal(childUnit.meta.guardian, false);
  cursorByPath.set(path, persist(db, childUnit, provider.parse(childUnit, null)));
  const childStat = statSync(path);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE agent_id=?').get(`codex:${childId}`).count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM subagents WHERE agent_id=?').get(`codex:${childId}`).count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tool_calls WHERE id=?').get(`codex:${childId}:child-call`).count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tool_results WHERE tool_use_id=?').get(`codex:${childId}:child-call`).count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tool_calls WHERE id=?').get(`codex:${parentId}:parent-call`).count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tool_results WHERE tool_use_id=?').get(`codex:${parentId}:parent-call`).count, 1);

  writeJsonl(path, [
    { type: 'session_meta', timestamp: '2026-06-15T10:00:00Z', payload: { ...childMeta, source: { subagent: { other: 'guardian' } }, padding: 'x'.repeat(10_000) } },
    { type: 'event_msg', timestamp: '2026-06-15T10:00:01Z', payload: { type: 'user_message', message: 'must retract' } },
  ]);
  const guardianStat = statSync(path);
  assert.equal(guardianStat.ino, childStat.ino, 'rewrite retains source identity and would have qualified for the offset path');
  assert.ok(guardianStat.size > childStat.size, 'rewrite grows the source and would have looked like an append');
  const [guardianUnit] = discover();
  assert.equal(guardianUnit.meta.guardian, true);
  const metrics = createCodexParseMetrics();
  cursorByPath.set(path, persist(db, guardianUnit, provider.parse(guardianUnit, cursorByPath.get(path), metrics)));
  assert.equal(metrics.plan, 'snapshot', 'guardian invalidation must bypass cooperative and verified append');

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE agent_id=?').get(`codex:${childId}`).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM subagents WHERE agent_id=?').get(`codex:${childId}`).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tool_calls WHERE id=?').get(`codex:${childId}:child-call`).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tool_results WHERE tool_use_id=?').get(`codex:${childId}:child-call`).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tool_calls WHERE id=?').get(`codex:${parentId}:parent-call`).count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tool_results WHERE tool_use_id=?').get(`codex:${parentId}:parent-call`).count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id=? AND agent_id IS NULL').get(parentSessionId).count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE id=?').get(parentSessionId).count, 1);
  db.close();
});

test('Codex prefix snapshot plus cooperative append converges SQLite projection', () => {
  const finalPath = join(makeTempDir('obelisk-codex-final-'), 'rollout.jsonl');
  writeJsonl(finalPath, [...prefixLines(), ...suffixLines()]);
  const dbFinal = freshDb();
  persist(dbFinal, unit(finalPath), parse(unit(finalPath), null));

  const path = join(makeTempDir('obelisk-codex-split-'), 'rollout.jsonl');
  writeJsonl(path, prefixLines());
  const dbSplit = freshDb();
  const firstUnit = unit(path);
  const cursor = persist(dbSplit, firstUnit, parse(firstUnit, null));
  const suffixBytes = Buffer.byteLength(`${suffixLines().map(line => JSON.stringify(line)).join('\n')}\n`);
  appendFileSync(path, `${suffixLines().map(line => JSON.stringify(line)).join('\n')}\n`);

  const metrics = createCodexParseMetrics();
  persist(dbSplit, unit(path), parse(unit(path), cursor, metrics));
  assert.equal(metrics.plan, 'cooperative-append');
  assert.equal(metrics.suffixBytesRead, suffixBytes * 2, 'pre-scan and emit each read the suffix once');
  assert.ok(metrics.sourceBytesRead <= suffixBytes * 2, 'cooperative source reads only the two suffix passes');
  assert.equal(metrics.jsonLinesParsed, suffixLines().length * 2, 'only suffix records are parsed in pre-scan and emit');
  assert.deepEqual(dumpDb(dbSplit), dumpDb(dbFinal));

  dbFinal.close();
  dbSplit.close();
});
