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
