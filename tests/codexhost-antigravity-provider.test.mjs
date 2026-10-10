// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createCodexHostAntigravityProvider } from '../packages/core/src/providers/codexhost-antigravity.ts';
import { assembleSessionDetail } from '../packages/core/src/session-detail.ts';
import { persist } from '../packages/core/src/persist.ts';
import { createProviderIndexPlan, indexProviderPlan } from '../packages/core/src/provider-indexing.ts';
import { createProviderRegistry } from '../packages/core/src/providers/registry.ts';
import { refreshSessionProjectPaths } from '../packages/core/src/index-finalize.ts';
import { makeTempDir } from './temp-dirs.mjs';

const fixtureRoot = new URL('./fixtures/codexhost-antigravity/', import.meta.url);
const historyFixture = JSON.parse(readFileSync(new URL('history-v1.json', fixtureRoot), 'utf8'));
const mappingFixture = JSON.parse(readFileSync(new URL('mapping-v1.json', fixtureRoot), 'utf8'));
const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');

function setup() {
  const root = makeTempDir('obelisk-codexhost-antigravity-');
  const historyDir = join(root, 'antigravity-history');
  const mappingDir = join(root, 'mapping-store', 'threads');
  mkdirSync(historyDir, { recursive: true });
  mkdirSync(mappingDir, { recursive: true });
  const file = `${mappingFixture.hostThreadId}.json`;
  const historyPath = join(historyDir, file);
  const mappingPath = join(mappingDir, file);
  const history = structuredClone(historyFixture);
  const mapping = structuredClone(mappingFixture);
  mapping.cwd = root;
  history.turns[0].items[0].item.cwd = root;
  const write = () => {
    writeFileSync(historyPath, JSON.stringify(history));
    writeFileSync(mappingPath, JSON.stringify(mapping));
  };
  write();
  return { root, history, mapping, historyPath, mappingPath, write,
    provider: createCodexHostAntigravityProvider({ rootDir: root }) };
}

function discover(provider, indexed = [], cursors = new Map()) {
  const issues = [];
  const units = provider.discover({
    lastCursor: (key) => cursors.get(key) ?? null,
    indexedSessions: () => indexed,
    reportIncompleteInventory: (issue) => issues.push(issue),
  });
  return { units, issues };
}

function seedIndexedSession(source) {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const unit = discover(source.provider).units[0];
  const cursor = persist(db, unit, source.provider.parse(unit, null));
  db.prepare('INSERT INTO index_state (jsonl_path, mtime, lines_processed, cursor) VALUES (?, 0, 0, NULL)')
    .run(source.provider.indexVersionMarker);
  return { db, unit, cursor };
}

function runIndexPlan(db, provider, options = {}) {
  const plan = createProviderIndexPlan(db, createProviderRegistry([provider]), options);
  const result = indexProviderPlan({
    db, plan, runTransaction: (_label, work) => work(), onError: () => 'skip',
  });
  return { plan, result };
}

test('CodexHost Antigravity history indexes user, assistant, and tool evidence without duplicating native harnesses', () => {
  const source = setup();
  writeFileSync(join(source.root, 'mapping-store', 'threads', 'native-codex.json'),
    JSON.stringify({ ...source.mapping, hostThreadId: 'native-codex', harnessId: 'codex' }));
  const { units, issues } = discover(source.provider);
  assert.deepEqual(issues, []);
  assert.equal(units.length, 1, 'discover() finds the real sidecar layout');
  const unit = units[0];
  const iterator = source.provider.parse(unit, null);
  const records = [...iterator];
  const messages = records.filter((record) => record.kind === 'message');
  assert.deepEqual(messages.map((message) => message.text), [
    'redacted user request', null, null, 'redacted assistant response',
  ]);
  assert.deepEqual(records.filter((record) => record.kind === 'tool_call').map((record) => record.name), [
    'commandExecution', 'read_file',
  ]);
  assert.deepEqual(records.filter((record) => record.kind === 'tool_result').map((record) => record.content), [
    'redacted output', 'redacted tool result',
  ]);
  assert.equal(records.find((record) => record.kind === 'session').source, 'codexhost-antigravity');
  assert.equal(records.find((record) => record.kind === 'session').message_count, 4);
  const raw = source.provider.raw({ source: 'codexhost-antigravity', messageUuid: messages[3].uuid,
    session: { id: unit.sessionId, jsonl_path: source.mappingPath }, agentId: null });
  assert.equal(raw.messageText, 'redacted assistant response');

  const direct = assembleSessionDetail(records);
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  persist(db, unit, source.provider.parse(unit, null));
  const roundTrip = assembleSessionDetail({
    session: db.prepare('SELECT * FROM sessions').get(),
    messages: db.prepare('SELECT * FROM messages ORDER BY timestamp, uuid').all(),
    toolCalls: db.prepare('SELECT * FROM tool_calls').all(),
    toolResults: db.prepare('SELECT * FROM tool_results').all(),
  });
  assert.deepEqual(roundTrip, direct, 'canonical transcript survives a SQLite round-trip');
  db.close();
});

test('same-millisecond mapping rewrite reparses and a mismatched sidecar preserves last-good rows', () => {
  const source = setup();
  const first = discover(source.provider).units[0];
  // The cursor is the generator's return value, not a separate file mtime.
  const parsed = source.provider.parse(first, null);
  let step = parsed.next();
  while (!step.done) step = parsed.next();
  const cursors = new Map([[first.key, step.value]]);
  const indexed = [{ sessionId: first.sessionId, jsonlPath: source.mappingPath }];
  assert.equal(discover(source.provider, indexed, cursors).units.length, 0);

  const beforeMtime = statSync(source.mappingPath).mtime;
  source.mapping.title = 'changed title with same mtime';
  writeFileSync(source.mappingPath, JSON.stringify(source.mapping));
  utimesSync(source.mappingPath, beforeMtime, beforeMtime);
  const changed = discover(source.provider, indexed, cursors);
  assert.equal(changed.units.length, 1);
  assert.deepEqual(changed.units[0].retractSessionIds, [first.sessionId]);
  assert.equal([...source.provider.parse(changed.units[0], step.value)].find((row) => row.kind === 'session').title,
    'changed title with same mtime');

  source.history.nativeSessionId = 'different-native-session';
  source.write();
  const invalid = discover(source.provider, indexed, cursors);
  assert.deepEqual(invalid.units, []);
  assert.equal(invalid.issues.length, 1);
});

test('Antigravity mapping without a sidecar is metadata-only, while source loss preserves last-good content', () => {
  const source = setup();
  const first = discover(source.provider).units[0];
  const parsed = source.provider.parse(first, null);
  let step = parsed.next();
  while (!step.done) step = parsed.next();
  const indexed = [{ sessionId: first.sessionId, jsonlPath: source.mappingPath }];
  rmSync(source.historyPath);
  const fresh = discover(source.provider);
  assert.equal(fresh.units.length, 1);
  const metadata = [...source.provider.parse(fresh.units[0], null)];
  assert.equal(metadata.find((row) => row.kind === 'session').message_count, 0);
  assert.equal(metadata.find((row) => row.kind === 'message').visibility, 'hidden');
  assert.equal(metadata.find((row) => row.kind === 'message').cwd, source.root);
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  persist(db, fresh.units[0], source.provider.parse(fresh.units[0], null));
  refreshSessionProjectPaths(db, new Set([first.sessionId]));
  assert.equal(db.prepare('SELECT project_path FROM sessions').get().project_path, source.root);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE visibility = ?').get('visible').n, 0);
  db.close();

  const partial = discover(source.provider, indexed, new Map([[first.key, step.value]]));
  assert.deepEqual(partial.units, []);
  assert.equal(partial.issues.length, 1);
  rmSync(source.mappingPath);
  const deleted = discover(source.provider, indexed);
  assert.deepEqual(deleted.issues, []);
  assert.equal(deleted.units.length, 1);
  assert.deepEqual(deleted.units[0].retractSessionIds, [first.sessionId]);
});

test('unsupported Antigravity version is reported without poisoning unrelated sessions', () => {
  const source = setup();
  source.history.formatVersion = 2;
  source.write();
  const result = discover(source.provider);
  assert.deepEqual(result.units, []);
  assert.match(result.issues[0].error, /Unsupported/);
});

test('failed command retains the upstream error when no output was recorded', () => {
  const source = setup();
  delete source.history.turns[0].items[0].item.output;
  source.history.turns[0].items[0].outcome = {
    status: 'failed', error: { code: 'TOOL_ERROR', message: 'permission denied', retryable: false },
  };
  source.write();
  const unit = discover(source.provider).units[0];
  const result = [...source.provider.parse(unit, null)].find((row) => row.kind === 'tool_result');
  assert.equal(result.content, 'permission denied');
  assert.equal(result.is_error, 1);
});

for (const replay of [
  { name: 'forced rebuild', options: { force: true } },
  { name: 'canonical marker replay', options: {} },
]) {
  test(`missing Antigravity history preserves last-good rows during ${replay.name}`, () => {
    const source = setup();
    const { db, unit, cursor } = seedIndexedSession(source);
    if (replay.name === 'canonical marker replay') {
      db.prepare('DELETE FROM index_state WHERE jsonl_path = ?').run(source.provider.indexVersionMarker);
    }
    rmSync(source.historyPath);

    const { plan } = runIndexPlan(db, source.provider, replay.options);

    assert.equal(plan.items.length, 0, 'unavailable content must not be replaced by metadata-only output');
    assert.equal(plan.incompleteProviders.has(source.provider.name), true);
    assert.match(plan.inventoryIssues[0].error, /history is unavailable/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(unit.sessionId).n, 4);
    assert.equal(db.prepare('SELECT cursor FROM index_state WHERE jsonl_path = ?').get(unit.key).cursor, cursor);
    db.close();
  });
}

test('known metadata-only Antigravity mappings remain replayable without false inventory gaps', () => {
  const source = setup();
  rmSync(source.historyPath);
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const unit = discover(source.provider).units[0];
  const cursor = persist(db, unit, source.provider.parse(unit, null));
  db.prepare('INSERT INTO index_state (jsonl_path, mtime, lines_processed, cursor) VALUES (?, 0, 0, NULL)')
    .run(source.provider.indexVersionMarker);

  const { plan, result } = runIndexPlan(db, source.provider, { force: true });

  assert.equal(plan.items.length, 1, JSON.stringify({ incomplete: [...plan.incompleteProviders], issues: plan.inventoryIssues }));
  assert.equal(plan.incompleteProviders.has(source.provider.name), false);
  assert.equal(result.complete, true);
  assert.equal(db.prepare('SELECT message_count FROM sessions WHERE id = ?').get(unit.sessionId).message_count, 0);
  assert.equal(db.prepare('SELECT cursor FROM index_state WHERE jsonl_path = ?').get(unit.key).cursor, cursor);
  db.close();
});

test('missing cursor provenance fails closed when an indexed Antigravity sidecar is absent', () => {
  const source = setup();
  const { db, unit } = seedIndexedSession(source);
  db.prepare('DELETE FROM index_state WHERE jsonl_path = ?').run(unit.key);
  rmSync(source.historyPath);

  const { plan } = runIndexPlan(db, source.provider, { force: true });

  assert.equal(plan.items.length, 0);
  assert.equal(plan.incompleteProviders.has(source.provider.name), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(unit.sessionId).n, 4);
  db.close();
});

test('malformed required Antigravity message text reports incomplete inventory and preserves old text', () => {
  const source = setup();
  const { db, unit, cursor } = seedIndexedSession(source);
  delete source.history.turns[0].items[2].item.text;
  source.write();

  const { plan, result } = runIndexPlan(db, source.provider);

  assert.equal(plan.items.length, 0);
  assert.equal(plan.incompleteProviders.has(source.provider.name), true);
  assert.equal(result.complete, false);
  assert.equal(db.prepare('SELECT text FROM messages WHERE uuid = ?').get(`${unit.sessionId}:t000001:item:000003`).text,
    'redacted assistant response');
  assert.equal(db.prepare('SELECT cursor FROM index_state WHERE jsonl_path = ?').get(unit.key).cursor, cursor);
  db.close();
});

for (const malformedOutcome of [
  { name: 'a missing status envelope', apply: (envelope) => { delete envelope.outcome; } },
  { name: 'success status with failure data', apply: (envelope) => {
    envelope.outcome = { status: 'succeeded', error: { code: 'TOOL_ERROR', message: 'unreported native failure', retryable: false } };
  } },
  { name: 'an unknown field in a failure payload', apply: (envelope) => {
    envelope.outcome.error.unexpected = 'not in the upstream contract';
  } },
  { name: 'an infinite failure duration from raw JSON', apply: (envelope) => {
    envelope.outcome.error.message = 'changed native failure';
  }, infiniteDuration: true },
]) {
  test(`malformed item outcome (${malformedOutcome.name}) preserves last-good tool failure and cursor`, () => {
    const source = setup();
    source.history.turns[0].items[0].outcome = {
      status: 'failed',
      error: { code: 'TOOL_ERROR', message: 'unreported native failure', retryable: false, durationMs: 1 },
    };
    source.write();
    const { db, unit, cursor } = seedIndexedSession(source);
    const callId = `${unit.sessionId}:t000001:item:000001:call`;
    const previousResult = db.prepare('SELECT content, is_error FROM tool_results WHERE tool_use_id = ?').get(callId);
    assert.equal(previousResult.content, 'redacted output\nunreported native failure');
    assert.equal(previousResult.is_error, 1);

    malformedOutcome.apply(source.history.turns[0].items[0]);
    source.write();
    if (malformedOutcome.infiniteDuration) {
      const serializedHistory = readFileSync(source.historyPath, 'utf8');
      const finiteDuration = '"retryable":false,"durationMs":1';
      assert.ok(serializedHistory.includes(finiteDuration));
      writeFileSync(source.historyPath, serializedHistory.replace(finiteDuration, '"retryable":false,"durationMs":1e400'));
    }

    const { plan, result } = runIndexPlan(db, source.provider);

    assert.equal(plan.items.length, 0);
    assert.equal(plan.incompleteProviders.has(source.provider.name), true);
    assert.equal(result.complete, false);
    const storedResult = db.prepare('SELECT content, is_error FROM tool_results WHERE tool_use_id = ?').get(callId);
    assert.equal(storedResult.content, previousResult.content);
    assert.equal(storedResult.is_error, previousResult.is_error);
    assert.equal(db.prepare('SELECT cursor FROM index_state WHERE jsonl_path = ?').get(unit.key).cursor, cursor);
    db.close();
  });
}

for (const malformedTurnOutcome of [
  { name: 'success status with failure data', apply: (turn) => {
    turn.outcome = { status: 'succeeded', error: { code: 'TURN_ERROR', message: 'changed turn failure', retryable: false } };
  } },
  { name: 'a failed outcome missing retryability', apply: (turn) => { delete turn.outcome.error.retryable; } },
  { name: 'unknown status without a reason', apply: (turn) => { turn.outcome = { status: 'unknown' }; } },
]) {
  test(`malformed turn outcome (${malformedTurnOutcome.name}) preserves last-good failure and cursor`, () => {
    const source = setup();
    source.history.turns[0].outcome = {
      status: 'failed',
      error: { code: 'TURN_ERROR', message: 'previous native turn failure', retryable: false },
    };
    source.write();
    const { db, unit, cursor } = seedIndexedSession(source);
    const failureUuid = `${unit.sessionId}:t000001:outcome`;
    const previousFailure = db.prepare('SELECT role, text, visibility FROM messages WHERE uuid = ?').get(failureUuid);
    assert.equal(previousFailure.text, 'previous native turn failure');
    assert.equal(previousFailure.visibility, 'visible');

    malformedTurnOutcome.apply(source.history.turns[0]);
    source.write();

    const { plan, result } = runIndexPlan(db, source.provider);

    assert.equal(plan.items.length, 0);
    assert.equal(plan.incompleteProviders.has(source.provider.name), true);
    assert.equal(result.complete, false);
    const storedFailure = db.prepare('SELECT role, text, visibility FROM messages WHERE uuid = ?').get(failureUuid);
    assert.equal(storedFailure.role, previousFailure.role);
    assert.equal(storedFailure.text, previousFailure.text);
    assert.equal(storedFailure.visibility, previousFailure.visibility);
    assert.equal(db.prepare('SELECT cursor FROM index_state WHERE jsonl_path = ?').get(unit.key).cursor, cursor);
    db.close();
  });
}

test('failed Antigravity turn without item results emits a visible, expandable failure message', () => {
  const source = setup();
  source.history.turns[0].items = [];
  source.history.turns[0].outcome = {
    status: 'failed', error: { code: 'QUOTA_EXCEEDED', message: 'Antigravity Turn ended with status ERROR: quota exhausted', retryable: false },
  };
  source.write();
  const unit = discover(source.provider).units[0];
  const records = [...source.provider.parse(unit, null)];
  const failureUuid = `${unit.sessionId}:t000001:outcome`;
  const failure = records.find((record) => record.kind === 'message' && record.uuid === failureUuid);

  assert.ok(failure, 'the turn-level failure is part of the canonical transcript');
  assert.equal(failure.role, 'system');
  assert.equal(failure.visibility, 'visible');
  assert.match(failure.text, /quota exhausted/);
  assert.equal(records.find((record) => record.kind === 'session').message_count, 2);
  assert.equal(source.provider.indexVersionMarker.endsWith('v2__'), true, 'new canonical records require a replay marker bump');
  const raw = source.provider.raw({ source: source.provider.name, messageUuid: failureUuid,
    session: { id: unit.sessionId, jsonl_path: source.mappingPath }, agentId: null });
  assert.match(raw.messageText, /quota exhausted/);

  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  persist(db, unit, source.provider.parse(unit, null));
  const storedFailure = db.prepare('SELECT role, text, visibility FROM messages WHERE uuid = ?').get(failureUuid);
  assert.equal(storedFailure.role, 'system');
  assert.equal(storedFailure.text, failure.text);
  assert.equal(storedFailure.visibility, 'visible');
  assert.equal(db.prepare('SELECT message_count FROM sessions WHERE id = ?').get(unit.sessionId).message_count, 2);
  db.close();
});
