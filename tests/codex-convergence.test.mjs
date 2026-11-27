// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Canonical hard gate: a full Codex snapshot must assemble identically before
// and after persistence, and prefix + normal append must converge to the
// same SQLite projection as parsing the final source from scratch.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { persist } from '../packages/core/src/persist.ts';
import { createProviderIndexPlan, indexProviderPlanStrict } from '../packages/core/src/provider-indexing.ts';
import { createProviderRegistry } from '../packages/core/src/providers/registry.ts';
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

function assertNormalAppendReads(metrics, sourceStat, suffixBytes, expectedPlan) {
  const usableIdentity = Number.isSafeInteger(sourceStat.dev) && sourceStat.dev > 0
    && Number.isSafeInteger(sourceStat.ino) && sourceStat.ino > 0;
  const plan = expectedPlan ?? (usableIdentity ? 'cooperative-append' : 'verified-append');
  const cooperative = plan === 'cooperative-append';
  assert.equal(metrics.plan, plan, `normal append read plan (dev=${sourceStat.dev}, ino=${sourceStat.ino})`);
  assert.equal(metrics.suffixBytesRead, suffixBytes * 2, 'pre-scan and emit each read the suffix once');
  assert.equal(metrics.sourceBytesRead, suffixBytes * 2 + (cooperative ? 0 : sourceStat.size),
    'verified append adds exactly one complete fingerprint pass to the two suffix reads');
}

const REAL_FIXTURE = new URL('./fixtures/codex/real-rollout-structural-sanitized.jsonl', import.meta.url);
const REAL_PREFIX_FIXTURE = new URL('./fixtures/codex/real-rollout-structural-sanitized-prefix.jsonl', import.meta.url);

for (const refresh of ['first prompt', 'legacy checkpoint', 'multipart prompt']) {
  test(`Codex prompt-label refresh preserves unchanged child contributions (${refresh})`, t => {
    const legacyCheckpoint = refresh === 'legacy checkpoint';
    const multipartPrompt = refresh === 'multipart prompt';
    const root = makeTempDir('obelisk-codex-label-refresh-');
    const sessions = join(root, 'sessions');
    mkdirSync(sessions);
    const parent = join(sessions, 'parent.jsonl');
    const child = join(sessions, 'child.jsonl');
    const childId = `${ID}-child`;
    // Synthetic rollout records using Codex's thread_spawn source shape.
    writeJsonl(parent, [
      { type: 'session_meta', timestamp: META.timestamp, payload: META },
      { type: 'response_item', timestamp: META.timestamp, payload: {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: 'workspace preamble' }],
      } },
      ...(legacyCheckpoint || multipartPrompt ? [prefixLines()[1]] : []),
      ...(multipartPrompt ? [{ type: 'response_item', timestamp: META.timestamp, payload: {
        type: 'message', role: 'user', content: ['follow', ' up'].map(text => ({ type: 'input_text', text })),
      } }] : []),
    ]);
    writeJsonl(child, [
      { type: 'session_meta', timestamp: META.timestamp, payload: {
        ...META, id: childId, source: { subagent: { thread_spawn: { parent_thread_id: ID } } },
      } },
      ...prefixLines().slice(1),
      ...suffixLines().slice(0, 3),
    ]);
    const db = freshDb();
    t.after(() => db.close());
    const provider = createCodexProvider({ rootDir: root });
    const cursors = new Map();
    for (const key of [parent, child]) cursors.set(key, persist(db, { key, sessionId: SESSION_ID }, parse({ key, sessionId: SESSION_ID }, null)));
    if (legacyCheckpoint) {
      // Pre-label v4 cursors carry no userMessageEvents, even when prompts exist.
      const parts = cursors.get(parent).split(':');
      const state = JSON.parse(Buffer.from(parts[5], 'base64url').toString('utf8'));
      delete state.userMessageEvents;
      parts[5] = Buffer.from(JSON.stringify(state)).toString('base64url');
      cursors.set(parent, parts.join(':'));
      db.prepare('UPDATE messages SET is_meta=0, harness_kind=NULL WHERE agent_id IS NULL').run();
    }
    const childRows = () => ({
      messages: db.prepare('SELECT * FROM messages WHERE agent_id=? ORDER BY uuid').all(`codex:${childId}`),
      tools: db.prepare('SELECT * FROM tool_calls WHERE id LIKE ? ORDER BY id').all(`codex:${childId}:%`),
      results: db.prepare('SELECT * FROM tool_results WHERE tool_use_id LIKE ? ORDER BY tool_use_id').all(`codex:${childId}:%`),
      agents: db.prepare('SELECT * FROM subagents ORDER BY agent_id').all(),
    });
    const before = childRows();
    assert.ok(before.messages.length >= 2 && before.tools.length > 0 && before.results.length > 0);
    appendFileSync(parent, JSON.stringify(suffixLines().at(-1)) + '\n');
    const context = {
      lastCursor: key => cursors.get(key) ?? null,
      indexedSessions: () => [{ sessionId: SESSION_ID, jsonlPath: parent }],
      changedPaths: [parent],
    };
    const units = provider.discover(context);
    assert.deepEqual(units.map(unit => unit.key), [parent], 'unchanged children need no replay for a label refresh');
    for (const next of units) cursors.set(next.key, persist(db, next, provider.parse(next, cursors.get(next.key))));
    assert.deepEqual(childRows(), before, 'child messages, tool evidence and subagent links survive the parent refresh');
    assert.deepEqual({ ...db.prepare("SELECT is_meta, harness_kind FROM messages WHERE text='workspace preamble'").get() },
      { is_meta: 1, harness_kind: 'other' });
    if (multipartPrompt) {
      assert.deepEqual({ ...db.prepare('SELECT is_meta, harness_kind FROM messages WHERE text=?').get('follow\n up') },
        { is_meta: 0, harness_kind: null }, 'a later event repairs an earlier multipart prompt label');
    }
    assert.equal(provider.discover({ ...context, changedPaths: undefined }).length, 0, 'the checkpoint converges');
    const fresh = freshDb();
    t.after(() => fresh.close());
    for (const key of [parent, child]) persist(fresh, { key, sessionId: SESSION_ID }, parse({ key, sessionId: SESSION_ID }, null));
    assert.deepEqual(dumpDb(db), dumpDb(fresh), 'incremental label refresh equals a fresh family parse');
  });
}

test('Codex marker upgrade backfills stale session-index metadata from an unchanged real rollout once', t => {
  const root = makeTempDir('obelisk-codex-metadata-backfill-');
  const sessionsDir = join(root, 'sessions');
  mkdirSync(sessionsDir);
  const path = join(sessionsDir, 'rollout.jsonl');
  copyFileSync(REAL_FIXTURE, path);
  const rawId = JSON.parse(readFileSync(path, 'utf8').split('\n')[0]).payload.id;
  const sessionId = `codex:${rawId}`;
  const provider = createCodexProvider({ rootDir: root });
  const registry = createProviderRegistry([provider]);
  const db = freshDb();
  t.after(() => db.close());
  // The captured fixture sanitizes timestamps to p-NNNN. These later index
  // timestamps preserve that ordering without changing any rollout records.
  const beforeMeta = { indexedTitle: 'Before', indexedUpdatedAt: 'p-9991' };
  const afterMeta = { indexedTitle: 'After', indexedUpdatedAt: 'p-9992' };
  const beforeUnit = { key: path, sessionId, meta: beforeMeta };
  const cursor = persist(db, beforeUnit, parse(beforeUnit, null));
  // Literal old marker: referring to the current marker would make this test
  // pass even if an upgrade never scheduled a backfill.
  db.prepare('INSERT INTO index_state (jsonl_path,mtime,lines_processed) VALUES (?,0,0)')
    .run('__codex_canonical_transcript_v3__');
  const sourceStat = statSync(path);
  writeFileSync(join(root, 'session_index.jsonl'), `${JSON.stringify({
    id: rawId, thread_name: afterMeta.indexedTitle, updated_at: afterMeta.indexedUpdatedAt,
  })}\n`);
  assert.deepEqual(provider.discover({ lastCursor: () => cursor }), [], 'the unchanged source alone cannot repair stale metadata');

  const plan = createProviderIndexPlan(db, registry, { readMode: 'strict' });
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].cursor, null, 'an old-format index forces a snapshot backfill');
  db.exec('BEGIN');
  const result = indexProviderPlanStrict({ db, plan });
  db.exec('COMMIT');
  assert.equal(result.complete, true);
  assert.equal(db.prepare('SELECT title,ended_at FROM sessions WHERE id=?').get(sessionId).title, 'After');
  assert.equal(db.prepare('SELECT ended_at FROM sessions WHERE id=?').get(sessionId).ended_at, 'p-9992');
  assert.ok(db.prepare('SELECT 1 FROM index_state WHERE jsonl_path=?').get(provider.indexVersionMarker));
  const repairedStat = statSync(path);
  assert.deepEqual(
    [repairedStat.size, repairedStat.mtimeMs, repairedStat.ctimeMs],
    [sourceStat.size, sourceStat.mtimeMs, sourceStat.ctimeMs],
    'the repair does not modify the transcript',
  );

  const finalUnit = { key: path, sessionId, meta: afterMeta };
  const expectedDb = freshDb();
  t.after(() => expectedDb.close());
  persist(expectedDb, finalUnit, parse(finalUnit, null));
  assert.deepEqual(dumpDb(db), dumpDb(expectedDb), 'backfill equals a fresh canonical snapshot, including all message/tool rows');
  assert.deepEqual(assembleSessionDetail(detailRows(db, sessionId)), assembleSessionDetail(drain(parse(finalUnit, null)).values));
  const nextPlan = createProviderIndexPlan(db, registry, { readMode: 'strict' });
  assert.equal(nextPlan.items.length, 0, 'an already-migrated index does not replay again');
  assert.equal(nextPlan.pendingMarkers.size, 0);
});

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

// The sanitized real fixture uses differentiated placeholders (the same
// original string always maps to the same placeholder, a different string to
// a different one), so the duplicate-pair structure survives sanitization.
// Regenerate with scripts/sanitize-codex-fixture.mjs. Line 60 splits no
// duplicate pair, so a usable file identity must engage cooperative append.
// Unsupported identities must verify the prefix instead of selecting snapshot.
test('real sanitized Codex prefix plus append selects the identity-gated read plan and converges', () => {
  const fullPath = join(makeTempDir('obelisk-codex-real-full-'), 'rollout.jsonl');
  copyFileSync(REAL_FIXTURE, fullPath);
  const dbFull = freshDb();
  persist(dbFull, { key: fullPath, sessionId: '', meta: { source: 'codex', guardian: false } }, parse({ key: fullPath, sessionId: '', meta: { source: 'codex', guardian: false } }, null));

  const path = join(makeTempDir('obelisk-codex-real-split-'), 'rollout.jsonl');
  copyFileSync(REAL_PREFIX_FIXTURE, path);
  const dbSplit = freshDb();
  const prefixUnit = { key: path, sessionId: '', meta: { source: 'codex', guardian: false } };
  const cursor = persist(dbSplit, prefixUnit, parse(prefixUnit, null));
  const suffixLines = readFileSync(REAL_FIXTURE, 'utf8').split('\n').slice(60).filter(Boolean);
  const suffixBytes = Buffer.byteLength(`${suffixLines.join('\n')}\n`);
  appendFileSync(path, `${suffixLines.join('\n')}\n`);
  const metrics = createCodexParseMetrics();
  persist(dbSplit, { key: path, sessionId: '', meta: { source: 'codex', guardian: false } }, parse({ key: path, sessionId: '', meta: { source: 'codex', guardian: false } }, cursor, metrics));

  assertNormalAppendReads(metrics, statSync(path), suffixBytes);
  assert.equal(metrics.jsonLinesParsed, suffixLines.length * 2, 'only suffix records are parsed in pre-scan and emit');
  assert.deepEqual(dumpDb(dbSplit), dumpDb(dbFull));
  dbFull.close();
  dbSplit.close();
});

// Line 64 splits a real duplicate pair (an assistant message whose two
// representations land on opposite sides of the boundary), so the
// cross-boundary Bloom check must conservatively select the snapshot path —
// and still converge to the same projection.
test('real sanitized Codex split straddling a duplicate pair falls back to snapshot and converges', () => {
  const lines = readFileSync(REAL_FIXTURE, 'utf8').split('\n').filter(Boolean);
  const fullPath = join(makeTempDir('obelisk-codex-real-straddle-full-'), 'rollout.jsonl');
  writeFileSync(fullPath, `${lines.join('\n')}\n`);
  const dbFull = freshDb();
  persist(dbFull, { key: fullPath, sessionId: '', meta: { source: 'codex', guardian: false } }, parse({ key: fullPath, sessionId: '', meta: { source: 'codex', guardian: false } }, null));

  const path = join(makeTempDir('obelisk-codex-real-straddle-split-'), 'rollout.jsonl');
  writeFileSync(path, `${lines.slice(0, 64).join('\n')}\n`);
  const dbSplit = freshDb();
  const prefixUnit = { key: path, sessionId: '', meta: { source: 'codex', guardian: false } };
  const cursor = persist(dbSplit, prefixUnit, parse(prefixUnit, null));
  appendFileSync(path, `${lines.slice(64).join('\n')}\n`);
  const metrics = createCodexParseMetrics();
  persist(dbSplit, { key: path, sessionId: '', meta: { source: 'codex', guardian: false } }, parse({ key: path, sessionId: '', meta: { source: 'codex', guardian: false } }, cursor, metrics));

  assert.equal(metrics.plan, 'snapshot', 'a straddled duplicate pair must fall back to the exact full replay');
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

test('Codex prefix snapshot plus identity-gated append converges SQLite projection', () => {
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
  assertNormalAppendReads(metrics, statSync(path), suffixBytes);
  assert.equal(metrics.jsonLinesParsed, suffixLines().length * 2, 'only suffix records are parsed in pre-scan and emit');
  assert.deepEqual(dumpDb(dbSplit), dumpDb(dbFinal));

  dbFinal.close();
  dbSplit.close();
});

// A zero identity still verifies the prefix. Exact identities above Number's
// precision, including the uint64 high bit, can use cooperative append.
for (const [identityName, inode, expectedPlan] of [
  ['zero', 0n, 'verified-append'],
  ['large inode', 9_007_199_254_740_993n, 'cooperative-append'],
  ['high-bit inode', 0x8000_0000_0000_0001n, 'cooperative-append'],
]) {
  test(`Codex append with ${identityName} identity converges`, async t => {
    const exactStat = (...args) => {
      const result = statSync(...args);
      return Object.assign(result, {
        dev: args[1]?.bigint ? 1n : 1,
        ino: args[1]?.bigint ? inode : Number(inode),
      });
    };
    const fsMock = t.mock.module('node:fs', {
      namedExports: { closeSync, existsSync, lstatSync, openSync, readdirSync, readSync, statSync: exactStat },
    });
    t.after(() => fsMock.restore());
    const { parse: parseWithoutIdentity } = await import(`../packages/core/src/providers/codex.ts?${identityName}-identity`);
    const finalPath = join(makeTempDir('obelisk-codex-identity-final-'), 'rollout.jsonl');
    copyFileSync(REAL_FIXTURE, finalPath);
    const dbFinal = freshDb();
    t.after(() => dbFinal.close());
    const finalUnit = { key: finalPath, sessionId: '', meta: { source: 'codex', guardian: false } };
    persist(dbFinal, finalUnit, parse(finalUnit, null));

    const path = join(makeTempDir('obelisk-codex-identity-split-'), 'rollout.jsonl');
    copyFileSync(REAL_PREFIX_FIXTURE, path);
    const dbSplit = freshDb();
    t.after(() => dbSplit.close());
    const sourceUnit = { key: path, sessionId: '', meta: { source: 'codex', guardian: false } };
    const cursor = persist(dbSplit, sourceUnit, parseWithoutIdentity(sourceUnit, null));
    const cursorState = JSON.parse(Buffer.from(cursor.split(':', 6)[5], 'base64url').toString('utf8'));
    assert.equal(cursorState.sourceInode, String(inode), 'checkpoint retains the exact BigInt inode');
    const lines = readFileSync(REAL_FIXTURE, 'utf8').split('\n').slice(60).filter(Boolean);
    const suffix = `${lines.join('\n')}\n`;
    appendFileSync(path, suffix);
    const metrics = createCodexParseMetrics();
    persist(dbSplit, sourceUnit, parseWithoutIdentity(sourceUnit, cursor, metrics));
    assertNormalAppendReads(metrics, statSync(path), Buffer.byteLength(suffix), expectedPlan);
    assert.equal(metrics.jsonLinesParsed, lines.length * 2, 'append parses only the suffix records');
    assert.deepEqual(dumpDb(dbSplit), dumpDb(dbFinal));
  });
}

test('Codex copied rollout with Windows CopyFileExW birthtime newer than preserved ctime backfills, appends, and rejects inode reuse', async t => {
  const birthByPath = new Map();
  const fsMock = t.mock.module('node:fs', {
    namedExports: {
      closeSync,
      existsSync,
      lstatSync,
      openSync,
      readdirSync,
      readSync,
      copyFileSync: (src, dst, ...rest) => {
        copyFileSync(src, dst, ...rest);
        const exact = statSync(dst, { bigint: true });
        birthByPath.set(dst, exact.ctimeNs + 60_000_000_000n);
      },
      statSync: (target, options) => {
        const result = statSync(target, options);
        const customBirthNs = birthByPath.get(target);
        if (customBirthNs === undefined) return result;
        if (options?.bigint) {
          return Object.assign(result, {
            birthtimeNs: customBirthNs,
            birthtimeMs: Number(customBirthNs / 1_000_000_000n) * 1000 + Number(customBirthNs % 1_000_000_000n) / 1_000_000,
          });
        }
        const birthMs = Number(customBirthNs / 1_000_000_000n) * 1000 + Number(customBirthNs % 1_000_000_000n) / 1_000_000;
        return Object.assign(result, { birthtimeMs: birthMs, birthtime: new Date(birthMs) });
      },
    },
  });
  t.after(() => fsMock.restore());
  const {
    createCodexParseMetrics: createMockMetrics,
    createCodexProvider: createMockProvider,
    parse: parseMock,
  } = await import('../packages/core/src/providers/codex.ts?win32-copyfile-birthtime');

  const root = makeTempDir('obelisk-codex-win32-copyfile-');
  const sessionsDir = join(root, 'sessions');
  mkdirSync(sessionsDir);
  const path = join(sessionsDir, 'rollout.jsonl');
  copyFileSync(REAL_PREFIX_FIXTURE, path);
  const copiedBirthNs = statSync(path, { bigint: true }).ctimeNs + 60_000_000_000n;
  birthByPath.set(path, copiedBirthNs);

  const rawId = JSON.parse(readFileSync(path, 'utf8').split('\n')[0]).payload.id;
  const sessionId = `codex:${rawId}`;
  const provider = createMockProvider({ rootDir: root });
  const registry = createProviderRegistry([provider]);
  const db = freshDb();
  t.after(() => db.close());

  const initialUnit = { key: path, sessionId, meta: { indexedTitle: 'Before', indexedUpdatedAt: 'p-9991' } };
  const initialCursor = persist(db, initialUnit, parseMock(initialUnit, null));
  const decodedState = JSON.parse(Buffer.from(initialCursor.split(':', 6)[5], 'base64url').toString('utf8'));
  assert.equal(decodedState.sourceBirthtimeNs, String(copiedBirthNs));

  db.prepare('INSERT INTO index_state (jsonl_path,mtime,lines_processed) VALUES (?,0,0)')
    .run('__codex_canonical_transcript_v3__');
  writeFileSync(join(root, 'session_index.jsonl'), `${JSON.stringify({
    id: rawId, thread_name: 'After', updated_at: 'p-9992',
  })}\n`);

  const plan = createProviderIndexPlan(db, registry, { readMode: 'strict' });
  assert.equal(plan.items.length, 1, 'unchanged copied rollout with birthtime > ctime is recognized during marker backfill');

  // Legacy cursor without sourceBirthtimeNs also recognizes an unchanged copied rollout.
  delete decodedState.sourceBirthtimeNs;
  const legacyParts = initialCursor.split(':', 6);
  const legacyCursor = `${legacyParts.slice(0, 5).join(':')}:${Buffer.from(JSON.stringify(decodedState)).toString('base64url')}`;
  db.prepare('UPDATE index_state SET cursor=? WHERE jsonl_path=?').run(legacyCursor, path);
  const legacyPlan = createProviderIndexPlan(db, registry, { readMode: 'strict' });
  assert.equal(legacyPlan.items.length, 1, 'legacy cursor without sourceBirthtimeNs still matches unchanged copied rollout');

  // Restore full cursor, finish migration, then append lines (ctime advances while birthtime stays > initial ctime).
  db.prepare('UPDATE index_state SET cursor=? WHERE jsonl_path=?').run(initialCursor, path);
  db.exec('BEGIN');
  assert.equal(indexProviderPlanStrict({ db, plan: createProviderIndexPlan(db, registry, { readMode: 'strict' }) }).complete, true);
  db.exec('COMMIT');

  const migratedCursor = db.prepare('SELECT cursor FROM index_state WHERE jsonl_path=?').get(path).cursor;
  const restLines = readFileSync(REAL_FIXTURE, 'utf8').split('\n').slice(60).filter(Boolean);
  appendFileSync(path, `${restLines.join('\n')}\n`);
  const appendMetrics = createMockMetrics();
  const afterAppendCursor = persist(db, { key: path, sessionId, meta: { indexedTitle: 'After', indexedUpdatedAt: 'p-9992' } }, parseMock({ key: path, sessionId, meta: { indexedTitle: 'After', indexedUpdatedAt: 'p-9992' } }, migratedCursor, appendMetrics));
  assert.equal(appendMetrics.plan, 'cooperative-append');

  // Reused inode with a newer creation time must not take noop or cooperative-append.
  birthByPath.set(path, copiedBirthNs + 5_000_000_000n);
  const reusedMetrics = createMockMetrics();
  persist(db, { key: path, sessionId, meta: { indexedTitle: 'After', indexedUpdatedAt: 'p-9992' } }, parseMock({ key: path, sessionId, meta: { indexedTitle: 'After', indexedUpdatedAt: 'p-9992' } }, afterAppendCursor, reusedMetrics));
  assert.equal(reusedMetrics.plan, 'snapshot', 'inode reuse with different birthtime forces a full snapshot');
});

test('legacy cursor without sourceBirthtimeNs or store tag converges after append on CopyFileExW rollout', async t => {
  const birthByPath = new Map();
  const fsMock = t.mock.module('node:fs', {
    namedExports: {
      closeSync,
      existsSync,
      lstatSync,
      openSync,
      readdirSync,
      readSync,
      statSync: (target, options) => {
        const result = statSync(target, options);
        const customBirthNs = birthByPath.get(target);
        if (customBirthNs === undefined) return result;
        const birthMs = Number(customBirthNs / 1_000_000_000n) * 1000 + Number(customBirthNs % 1_000_000_000n) / 1_000_000;
        if (options?.bigint) {
          return Object.assign(result, { birthtimeNs: customBirthNs, birthtimeMs: birthMs });
        }
        return Object.assign(result, { birthtimeMs: birthMs, birthtime: new Date(birthMs) });
      },
    },
  });
  t.after(() => fsMock.restore());
  const { createCodexProvider: createMockProvider, parse: parseMock } = await import('../packages/core/src/providers/codex.ts?win32-legacy-append-converge');

  const home = makeTempDir('obelisk-codex-win32-legacy-append-');
  const root = join(home, '.codex');
  const sessionsDir = join(root, 'sessions', '2026', '06', '15');
  mkdirSync(sessionsDir, { recursive: true });
  const path = join(sessionsDir, 'rollout.jsonl');
  copyFileSync(REAL_PREFIX_FIXTURE, path);
  birthByPath.set(path, statSync(path, { bigint: true }).ctimeNs + 60_000_000_000n);

  const rawId = JSON.parse(readFileSync(path, 'utf8').split('\n')[0]).payload.id;
  const sessionId = `codex:${rawId}`;
  const db = freshDb();
  t.after(() => db.close());

  const initialCursor = persist(db, { key: path, sessionId }, parseMock({ key: path, sessionId }, null));
  const parts = initialCursor.split(':', 6);
  const state = JSON.parse(Buffer.from(parts[5], 'base64url').toString('utf8'));
  delete state.sourceBirthtimeNs;
  const legacyNoStoreCursor = `${parts.slice(0, 5).join(':')}:${Buffer.from(JSON.stringify(state)).toString('base64url')}`;
  db.prepare('UPDATE index_state SET cursor=? WHERE jsonl_path=?').run(legacyNoStoreCursor, path);

  const restLines = readFileSync(REAL_FIXTURE, 'utf8').split('\n').slice(60).filter(Boolean);
  appendFileSync(path, `${restLines.join('\n')}\n`);

  const provider = createMockProvider({ roots: [root], homeDir: home });
  const plan = createProviderIndexPlan(db, createProviderRegistry([provider]));
  assert.equal(plan.incompleteProviders.has('codex'), false);
  assert.equal(indexProviderPlanStrict({ db, plan }).complete, true);
  assert.deepEqual(db.prepare('SELECT id FROM sessions').all().map(row => row.id), [`codex:${rawId}`]);
});
