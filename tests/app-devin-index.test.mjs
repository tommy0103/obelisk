// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Devin stores are built from the real migration-20 schema
// (fixtures/devin/schema.sql) with synthetic rows whose JSON mirrors the
// shapes a real store holds. No real session content is checked in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { buildIndex } from '../app/src/main/indexer.ts';
import { persist } from '../packages/core/src/persist.ts';
import { readRecentTranscriptHints } from '../packages/core/src/provider-indexing.ts';
import { createBuiltinProviderRegistry } from '../packages/core/src/providers/builtins.ts';
import { createDevinProvider, defaultDevinRoot, devinAgentId, devinSessionId } from '../packages/core/src/providers/devin.ts';
import { assembleSessionDetail } from '../packages/core/src/session-detail.ts';
import { runCli } from './cli-test-helpers.mjs';
import { makeTempDir } from './temp-dirs.mjs';

const DEVIN_SCHEMA = readFileSync(new URL('./fixtures/devin/schema.sql', import.meta.url), 'utf8');
const INDEX_SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');
const T0 = 1794000000;

const iso = seconds => new Date(seconds * 1000).toISOString().replace('Z', '123Z');

function message(role, id, at, content, extra = {}, metadata = {}) {
  return {
    message_id: id,
    role,
    content,
    metadata: {
      num_tokens: null, is_user_input: null, request_id: null, metrics: null, finish_reason: null,
      created_at: iso(at), telemetry: { source: role, operation: 'unknown' }, ...metadata,
    },
    ...extra,
  };
}

const user = (id, at, content) => message('user', id, at, content, {}, {
  is_user_input: true, extensions: { 'chisel/client-message-id': `client-${id}` },
});
const injectedUser = (id, at, content) => message('user', id, at, content, {}, { extensions: { 'barista/prompt_cache_footer': true } });
const system = (id, at, content, extensions = {}) => message('system', id, at, content, {}, { extensions });
const assistant = (id, at, content, { calls = [], thinking = null, model = 'synthetic-model-a' } = {}) => message('assistant', id, at, content, {
  tool_calls: calls.map((call, index) => ({ index, kind: 'function', ...call })),
  ...(thinking === null ? {} : { thinking: { thinking, signature: 'sig', signature_type: 'anthropic' } }),
}, {
  request_id: `req-${id}`, num_tokens: 40, finish_reason: calls.length > 0 ? 'tool_calls' : 'stop',
  generation_model: model, started_generation_at: iso(at - 1),
  metrics: { input_tokens: 3, cache_read_tokens: 1000, cache_creation_tokens: 20, context_input_tokens: null, output_tokens: 40, tokens_per_sec: 50, total_time_ms: 800, tpot_ms: 10, ttft_ms: 300 },
});
const tool = (id, at, callId, content, success = true, extra = {}) => message('tool', id, at, content, { tool_call_id: callId }, {
  extensions: {
    ...extra,
    'chisel/tool_result_meta': { kind: 'execute', success, ...(success ? {} : { failure_reason: 'exit 1' }) },
    'chisel/tool_call_timing': { duration_ms: 12, started_at: iso(at), finished_at: iso(at) },
  },
});

const PREFIX = { is_system_prefix: true, summarized_from: null, num_tokens_preceding: null };

class Store {
  constructor(path) {
    this.path = path;
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(DEVIN_SCHEMA);
  }
  session(id, { cwd = '/work/app', head = null, hidden = 0, title = `Title ${id}`, at = T0 } = {}) {
    this.db.prepare(`INSERT INTO sessions (id, working_directory, backend_type, model, agent_mode, created_at, last_activity_at, title, main_chain_id, hidden)
      VALUES (?, ?, 'windsurf', 'synthetic-model-a', 'bypass', ?, ?, ?, ?, ?)`).run(id, cwd, at, at, title, head, hidden);
  }
  node(sessionId, nodeId, parent, chat, { at = T0, metadata = null } = {}) {
    this.db.prepare('INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sessionId, nodeId, parent, JSON.stringify(chat), at, metadata === null ? null : JSON.stringify(metadata));
  }
  head(sessionId, nodeId, at) {
    this.db.prepare('UPDATE sessions SET main_chain_id = ?, last_activity_at = ? WHERE id = ?').run(nodeId, at, sessionId);
  }
  subagent(sessionId, agentId, nodeId, at) {
    this.db.prepare('INSERT OR REPLACE INTO subagent_heads (session_id, agent_id, chain_node_id, updated_at) VALUES (?, ?, ?, ?)')
      .run(sessionId, agentId, nodeId, at);
  }
  close() { this.db.close(); }
}

/**
 * One session exercising every chain shape the real store holds: a system
 * prefix rebuild that copies earlier messages under the same message_id, a
 * subagent chain, a rewound user turn left off every live chain, and a
 * compaction summary. Only a run_subagent result that names its agent links a
 * subagent to the spawning call; a read_subagent result naming one does not.
 */
function seedRichSession(store, id = 'brave-otter') {
  store.session(id);
  const n = (node, parent, chat, metadata = null) => store.node(id, node, parent, chat, { at: T0 + node, metadata });
  const s1 = system('s1', T0 + 1, 'system prompt v1');
  const u1 = user('u1', T0 + 2, 'please fix the flaky upload test');
  const a1 = assistant('a1', T0 + 3, '', { calls: [{ id: 'call-1', name: 'exec', arguments: { command: 'npm test' } }], thinking: 'run the tests first' });
  const t1 = tool('t1', T0 + 4, 'call-1', 'upload.test.mjs failed', false);
  const a2 = assistant('a2', T0 + 5, 'The upload test races the server start.');
  n(1, null, s1, PREFIX); n(2, 1, u1); n(3, 2, a1); n(4, 3, t1); n(5, 4, a2);
  n(6, 5, user('u-rewound', T0 + 6, 'actually ignore that, rewrite everything'));
  // The system prefix changed: Devin rebuilds the chain and copies messages.
  n(7, null, system('s2', T0 + 7, 'system prompt v2'), PREFIX);
  n(8, 7, u1, { extensions: { 'compact/prior_node_ids': [2] } });
  n(9, 8, a1, { extensions: { 'compact/prior_node_ids': [3] } });
  n(10, 9, t1, { extensions: { 'compact/prior_node_ids': [4] } });
  n(11, 10, a2, { extensions: { 'compact/prior_node_ids': [5] } });
  n(12, 11, system('summary-1', T0 + 12, 'Summary: the upload test races the server.', { 'devin-rs/summary': { source: 'compaction' } }));
  n(13, 12, user('u2', T0 + 13, 'delegate the server audit'));
  n(14, 13, injectedUser('footer-1', T0 + 14, 'prompt cache footer'));
  n(15, 14, assistant('a3', T0 + 15, 'Starting a subagent.', { calls: [
    { id: 'call-2', name: 'run_subagent', arguments: { title: 'Audit server start', profile: 'subagent_explore', task: 'audit the server start' } },
    { id: 'call-4', name: 'read_subagent', arguments: { agent_id: 'e5f6a7b8' } },
  ] }));
  n(16, null, system('sub-s', T0 + 16, 'subagent system prompt'), PREFIX);
  n(17, 16, injectedUser('sub-task', T0 + 17, 'audit the server start'));
  n(18, 17, assistant('sub-a1', T0 + 18, '', { calls: [{ id: 'call-3', name: 'read', arguments: { file_path: '/work/app/server.mjs' } }] }));
  n(19, 18, tool('sub-t1', T0 + 19, 'call-3', 'export function start() {}'));
  n(20, 19, assistant('sub-a2', T0 + 20, 'The server start is not awaited.'));
  store.subagent(id, 'a1b2c3d4', 20, T0 + 20);
  n(21, 15, tool('t2', T0 + 21, 'call-2', 'The server start is not awaited.', true,
    { 'subagent/agent_id': 'a1b2c3d4', 'subagent/chain_node_id': 20, 'subagent/profile_name': 'Explore', 'subagent/model': 'synthetic-model-c' }));
  n(22, 21, tool('t4', T0 + 21, 'call-4', 'still running', true, { 'subagent/agent_id': 'e5f6a7b8' }));
  n(23, 22, assistant('a4', T0 + 22, 'Fixed: the test now awaits the server.', { model: 'synthetic-model-b' }));
  n(24, null, assistant('sub-b1', T0 + 21, 'Background check finished.'));
  // A background agent's profile arrives on its completion notice, not its spawn result.
  n(25, 23, system('bg-done', T0 + 23, 'Background agent finished.', { 'subagent/agent_id': 'e5f6a7b8', 'subagent/profile_name': 'General' }));
  store.subagent(id, 'e5f6a7b8', 24, T0 + 21);
  store.head(id, 25, T0 + 23);
}

// The platform's default store under `home`, with no XDG_DATA_HOME or APPDATA override.
function seedRoot(home) {
  const root = defaultDevinRoot({ homeDir: home, env: {} });
  mkdirSync(root, { recursive: true });
  return { root, dbPath: join(root, 'sessions.db') };
}

function collect(provider, ctx = {}) {
  const issues = [];
  const units = provider.discover({
    lastCursor: () => null,
    reportIncompleteInventory: issue => issues.push(issue),
    ...ctx,
  });
  return { units, issues };
}

function parseAll(provider, unit) {
  const records = [];
  const iterator = provider.parse(unit, null);
  let step = iterator.next();
  while (!step.done) {
    records.push(step.value);
    step = iterator.next();
  }
  return { records, cursor: step.value };
}

class TestDatabase {
  constructor(path) { this.db = new DatabaseSync(path); }
  pragma(statement) { this.db.exec(`PRAGMA ${statement}`); }
  exec(sql) { return this.db.exec(sql); }
  prepare(sql) { return this.db.prepare(sql); }
  close() { return this.db.close(); }
}

function build(home, root, options = {}) {
  return buildIndex({
    claudeDir: join(home, '.claude'),
    providerRoots: { devin: root },
    dbPath: join(home, '.obelisk', 'obelisk.sqlite'),
    DatabaseImpl: TestDatabase,
    ...options,
  });
}

function clearDebounce(home) {
  const db = new DatabaseSync(join(home, '.obelisk', 'obelisk.sqlite'));
  db.prepare("DELETE FROM index_state WHERE jsonl_path='__last_build__'").run();
  db.close();
}

function indexRows(home, sql, ...args) {
  const db = new DatabaseSync(join(home, '.obelisk', 'obelisk.sqlite'), { readOnly: true });
  try { return db.prepare(sql).all(...args).map(row => ({ ...row })); } finally { db.close(); }
}

test('the default store follows Devin\'s data directory on every platform', () => {
  assert.equal(defaultDevinRoot({ homeDir: '/home/me', platform: 'linux', env: {} }), join('/home/me', '.local', 'share', 'devin', 'cli'));
  assert.equal(defaultDevinRoot({ homeDir: '/Users/me', platform: 'darwin', env: {} }), join('/Users/me', '.local', 'share', 'devin', 'cli'));
  assert.equal(defaultDevinRoot({ homeDir: '/home/me', platform: 'linux', env: { XDG_DATA_HOME: '/data' } }), join('/data', 'devin', 'cli'));
  assert.equal(defaultDevinRoot({ homeDir: 'C:\\Users\\me', platform: 'win32', env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } }),
    'C:\\Users\\me\\AppData\\Roaming\\devin\\cli');
});

test('discover() finds every visible session in the default store and skips hidden ones', () => {
  const home = makeTempDir('obelisk-devin-discover-');
  const { dbPath } = seedRoot(home);
  const store = new Store(dbPath);
  seedRichSession(store);
  store.session('quiet-fox', { hidden: 1 });
  store.node('quiet-fox', 1, null, user('q1', T0, 'hidden turn'));
  store.head('quiet-fox', 1, T0);
  store.close();

  const previous = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, APPDATA: process.env.APPDATA };
  delete process.env.XDG_DATA_HOME;
  delete process.env.APPDATA;
  try {
    const { units, issues } = collect(createDevinProvider({ homeDir: home }));
    assert.deepEqual(issues, []);
    assert.deepEqual(units.map(unit => unit.sessionId), [devinSessionId(dbPath, 'brave-otter')]);
    assert.equal(units[0].key, `${dbPath}#devin:brave-otter`);
    assert.equal(units[0].project, '-work-app');
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value !== undefined) process.env[key] = value;
  }
});

test('parse() projects the main chain once, attributes the subagent chain, and keeps rewound turns inactive', () => {
  const home = makeTempDir('obelisk-devin-parse-');
  const { root, dbPath } = seedRoot(home);
  const store = new Store(dbPath);
  seedRichSession(store);
  store.close();
  const provider = createDevinProvider({ rootDir: root });
  const [unit] = collect(provider).units;
  const { records } = parseAll(provider, unit);
  const sid = devinSessionId(dbPath, 'brave-otter');
  const agentId = devinAgentId(sid, 'a1b2c3d4');
  const messages = records.filter(record => record.kind === 'message');
  const byUuid = new Map(messages.map(record => [record.uuid.slice(sid.length + 1), record]));

  assert.equal(messages.length, new Set(messages.map(record => record.uuid)).size, 'every message is emitted once');
  const visibleMain = messages.filter(record => record.visibility === 'visible' && record.agent_id === null).map(record => record.uuid.slice(sid.length + 1));
  assert.deepEqual(visibleMain, ['u1', 'a1:thinking', 'a1', 'a2', 'u2', 'a3', 'a4']);
  assert.deepEqual(messages.filter(record => record.agent_id === agentId && record.visibility === 'visible').map(record => record.uuid.slice(sid.length + 1)),
    ['sub-a1', 'sub-a2']);
  assert.ok(messages.filter(record => record.agent_id === agentId).every(record => record.is_sidechain === 1));
  assert.equal(byUuid.get('u-rewound').visibility, 'inactive', 'a turn no live chain reaches is superseded evidence');
  for (const hidden of ['s1', 's2', 'footer-1', 'sub-s', 'sub-task', 'bg-done']) assert.equal(byUuid.get(hidden).visibility, 'hidden', hidden);

  assert.equal(byUuid.get('a1').parent_uuid, `${sid}:u1`);
  assert.equal(byUuid.get('a1').content_type, 'tool_use');
  assert.equal(byUuid.get('a1').input_tokens, 1023, 'cache reads and writes count as input');
  assert.equal(byUuid.get('a1').output_tokens, 40);
  assert.equal(byUuid.get('a1:thinking').content_type, 'thinking');
  assert.equal(byUuid.get('a4').model, 'synthetic-model-b');
  assert.equal(byUuid.get('u1').cwd, normalize('/work/app'));

  const calls = records.filter(record => record.kind === 'tool_call');
  assert.deepEqual(calls.map(call => [call.id, call.message_uuid, call.name, call.file_path]), [
    [`${sid}:call-1`, `${sid}:a1`, 'exec', null],
    [`${sid}:call-2`, `${sid}:a3`, 'run_subagent', null],
    [`${sid}:call-4`, `${sid}:a3`, 'read_subagent', null],
    [`${sid}:call-3`, `${sid}:sub-a1`, 'read', '/work/app/server.mjs'],
  ]);
  const results = records.filter(record => record.kind === 'tool_result');
  assert.deepEqual(results.map(result => [result.tool_use_id, result.message_uuid, result.is_error]), [
    [`${sid}:call-1`, `${sid}:a1`, 1],
    [`${sid}:call-2`, `${sid}:a3`, 0],
    [`${sid}:call-4`, `${sid}:a3`, 0],
    [`${sid}:call-3`, `${sid}:sub-a1`, 0],
  ]);
  assert.deepEqual(records.filter(record => record.kind === 'summary').map(summary => [summary.id, summary.visibility]),
    [[`${sid}:summary-1`, 'visible']]);
  assert.deepEqual(records.filter(record => record.kind === 'subagent')
    .map(sub => [sub.agent_id, sub.session_id, sub.parent_tool_use_id, sub.agent_type, sub.description]), [
    [agentId, sid, `${sid}:call-2`, 'Explore', 'Audit server start'],
    [devinAgentId(sid, 'e5f6a7b8'), sid, null, 'General', null],
  ]);
  const session = records.find(record => record.kind === 'session');
  assert.equal(session.message_count, 10);
  assert.equal(session.title, 'Title brave-otter');
  assert.equal(session.started_at, new Date(T0 * 1000).toISOString());
  assert.equal(session.ended_at, new Date((T0 + 23) * 1000).toISOString(), 'microsecond source times normalize to milliseconds');
});

test('parse output assembles and survives a SQLite round-trip (ADR-0007)', () => {
  const home = makeTempDir('obelisk-devin-adr7-');
  const { root, dbPath } = seedRoot(home);
  const store = new Store(dbPath);
  seedRichSession(store);
  store.close();
  const provider = createDevinProvider({ rootDir: root });
  const [unit] = collect(provider).units;
  const direct = assembleSessionDetail(parseAll(provider, unit).records);
  assert.ok(direct.messages.some(entry => entry.text === 'Fixed: the test now awaits the server.'));

  const db = new DatabaseSync(':memory:');
  db.exec(INDEX_SCHEMA);
  persist(db, unit, provider.parse(unit, null));
  const sessionId = devinSessionId(dbPath, 'brave-otter');
  const persisted = assembleSessionDetail({
    session: db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId),
    messages: db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp, uuid').all(sessionId),
    toolCalls: db.prepare('SELECT * FROM tool_calls WHERE session_id = ? ORDER BY rowid').all(sessionId),
    toolResults: db.prepare('SELECT * FROM tool_results WHERE session_id = ?').all(sessionId),
    subagents: db.prepare('SELECT * FROM subagents WHERE session_id = ?').all(sessionId),
    summaries: db.prepare('SELECT * FROM summaries WHERE session_id = ?').all(sessionId),
  });
  assert.deepEqual(persisted, direct);
  db.close();
});

test('incremental updates re-index only the changed session and equal a fresh build', () => {
  const home = makeTempDir('obelisk-devin-incremental-');
  const { root, dbPath } = seedRoot(home);
  const store = new Store(dbPath);
  seedRichSession(store);
  store.session('calm-heron', { at: T0 + 100 });
  store.node('calm-heron', 1, null, user('c1', T0 + 101, 'hello heron'));
  store.head('calm-heron', 1, T0 + 101);

  const first = build(home, root);
  assert.ok(first.complete, JSON.stringify(first.inventoryIssues));
  assert.equal(first.affectedSessionIds.length, 2);
  clearDebounce(home);
  assert.deepEqual(build(home, root).affectedSessionIds, [], 'an unchanged store schedules nothing');

  store.node('calm-heron', 2, 1, assistant('c2', T0 + 102, 'hello back'));
  store.head('calm-heron', 2, T0 + 102);
  clearDebounce(home);
  const heron = devinSessionId(dbPath, 'calm-heron');
  assert.deepEqual(build(home, root, { changedPaths: [`${dbPath}-wal`] }).affectedSessionIds, [heron]);

  // A same-row rewrite that leaves last_activity_at alone is still caught, and
  // the message it replaced does not linger.
  store.db.prepare('UPDATE message_nodes SET chat_message = ? WHERE session_id = ? AND node_id = 2')
    .run(JSON.stringify(assistant('c2-regenerated', T0 + 102, 'hello back, edited')), 'calm-heron');
  clearDebounce(home);
  assert.deepEqual(build(home, root).affectedSessionIds, [heron]);
  store.close();

  const incremental = indexRows(home, 'SELECT uuid, visibility, text FROM messages ORDER BY uuid');
  const freshHome = makeTempDir('obelisk-devin-fresh-');
  build(freshHome, root);
  assert.deepEqual(indexRows(freshHome, 'SELECT uuid, visibility, text FROM messages ORDER BY uuid'), incremental);
  assert.deepEqual(indexRows(home, 'SELECT uuid, text FROM messages WHERE uuid LIKE ? ORDER BY uuid', `${heron}:c2%`),
    [{ uuid: `${heron}:c2-regenerated`, text: 'hello back, edited' }]);
});

test('hiding or deleting a session retracts it; an unreadable store retracts nothing', () => {
  const home = makeTempDir('obelisk-devin-retract-');
  const { root, dbPath } = seedRoot(home);
  const store = new Store(dbPath);
  seedRichSession(store);
  store.session('calm-heron');
  store.node('calm-heron', 1, null, user('c1', T0, 'hello heron'));
  store.head('calm-heron', 1, T0);
  build(home, root);
  const otter = devinSessionId(dbPath, 'brave-otter');
  const heron = devinSessionId(dbPath, 'calm-heron');
  const sessions = () => indexRows(home, "SELECT id FROM sessions WHERE source = 'devin' ORDER BY id").map(row => row.id);
  assert.deepEqual(sessions(), [otter, heron].sort());

  store.db.prepare('UPDATE sessions SET hidden = 1 WHERE id = ?').run('calm-heron');
  clearDebounce(home);
  build(home, root);
  assert.deepEqual(sessions(), [otter]);
  assert.deepEqual(indexRows(home, 'SELECT COUNT(*) AS n FROM messages WHERE session_id = ?', heron), [{ n: 0 }]);
  store.close();

  writeFileSync(dbPath, 'not a sqlite database');
  clearDebounce(home);
  const broken = build(home, root);
  assert.equal(broken.complete, false);
  assert.deepEqual(sessions(), [otter], 'an unreadable store is not evidence of deletion');
});

test('a newer schema that keeps the projected columns still indexes; one that drops them is reported, not tombstoned', () => {
  const home = makeTempDir('obelisk-devin-version-');
  const { root, dbPath } = seedRoot(home);
  const store = new Store(dbPath);
  seedRichSession(store);
  store.db.exec("INSERT INTO refinery_schema_history (version, name) VALUES (21, 'future_migration')");
  store.db.exec('ALTER TABLE message_nodes ADD COLUMN future_column TEXT');
  store.db.exec('CREATE TABLE future_table (id INTEGER PRIMARY KEY)');
  const first = build(home, root);
  assert.ok(first.complete, JSON.stringify(first.inventoryIssues));
  const otter = devinSessionId(dbPath, 'brave-otter');
  assert.equal(indexRows(home, 'SELECT COUNT(*) AS n FROM messages WHERE session_id = ?', otter)[0].n > 0, true);

  store.db.exec('ALTER TABLE sessions DROP COLUMN title');
  store.close();
  const provider = createDevinProvider({ rootDir: root });
  const { units, issues } = collect(provider, { indexedSessions: () => [{ sessionId: otter, jsonlPath: `${dbPath}#devin:brave-otter` }] });
  assert.deepEqual(units, []);
  assert.match(issues[0].error, /sessions lacks title/);
});

test('a missing store is quiet without prior sessions and incomplete with them', () => {
  const home = makeTempDir('obelisk-devin-missing-');
  const { root, dbPath } = seedRoot(home);
  const provider = createDevinProvider({ rootDir: root });
  assert.deepEqual(collect(provider), { units: [], issues: [] });
  const prior = [{ sessionId: devinSessionId(dbPath, 'gone'), jsonlPath: `${dbPath}#devin:gone` }];
  const { units, issues } = collect(provider, { indexedSessions: () => prior });
  assert.deepEqual(units, []);
  assert.equal(issues.length, 1);
});

test('watch hints map session units to the store and its WAL; foreign changes never wake the provider', () => {
  const home = makeTempDir('obelisk-devin-hints-');
  const { root, dbPath } = seedRoot(home);
  const store = new Store(dbPath);
  seedRichSession(store);
  store.close();
  const registry = createBuiltinProviderRegistry({ devin: root });
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE index_state (jsonl_path TEXT, mtime INTEGER, lines_processed INTEGER, cursor TEXT)');
  db.prepare('INSERT INTO index_state (jsonl_path, mtime, lines_processed) VALUES (?, 1, 0)').run(`${dbPath}#devin:brave-otter`);
  db.prepare('INSERT INTO index_state (jsonl_path, mtime, lines_processed) VALUES (?, 2, 0)').run(join(home, 'elsewhere', 'other.db#devin:x'));
  assert.deepEqual(readRecentTranscriptHints(db, undefined, registry), [dbPath, `${dbPath}-wal`]);
  db.close();

  const provider = createDevinProvider({ rootDir: root });
  assert.deepEqual(collect(provider, { changedPaths: [join(home, 'unrelated.jsonl')] }).units, []);
  assert.equal(collect(provider, { changedPaths: [`${dbPath}-wal`] }).units.length, 1);
  assert.equal(collect(provider, { changedPaths: [root] }).units.length, 1);
});

test('raw() returns the full message text from the configured store only', () => {
  const home = makeTempDir('obelisk-devin-raw-');
  const { root, dbPath } = seedRoot(home);
  const store = new Store(dbPath);
  seedRichSession(store);
  store.close();
  const provider = createDevinProvider({ rootDir: root });
  const sid = devinSessionId(dbPath, 'brave-otter');
  const session = { id: sid, jsonl_path: `${dbPath}#devin:brave-otter` };
  assert.equal(provider.raw({ source: 'devin', messageUuid: `${sid}:a2`, session, agentId: null }).messageText,
    'The upload test races the server start.');
  assert.equal(provider.raw({ source: 'devin', messageUuid: `${sid}:a1:thinking`, session, agentId: null }).messageText,
    'run the tests first');
  const elsewhere = join(home, 'elsewhere.db');
  assert.equal(provider.raw({ source: 'devin', messageUuid: `${devinSessionId(elsewhere, 'brave-otter')}:a2`,
    session: { id: devinSessionId(elsewhere, 'brave-otter'), jsonl_path: `${elsewhere}#devin:brave-otter` }, agentId: null }), null);
});

test('the CLI indexes the default Devin store and finds a message through search()', () => {
  const home = makeTempDir('obelisk-devin-cli-');
  const { dbPath } = seedRoot(home);
  const store = new Store(dbPath);
  seedRichSession(store);
  store.close();
  writeFileSync(join(home, 'q.mjs'), `return {
    hits: search('awaits the server', { source: 'devin', limit: 5 }).map(hit => hit.session.id),
    agents: sql("SELECT agent_id, parent_tool_use_id FROM subagents WHERE agent_id LIKE 'devin:%' ORDER BY agent_id")
      .map(row => [row.agent_id, row.parent_tool_use_id]),
  };`);
  const result = runCli(['--query', join(home, 'q.mjs')], { home, env: { APPDATA: join(home, 'AppData', 'Roaming') } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const out = JSON.parse(result.stdout);
  const sid = devinSessionId(dbPath, 'brave-otter');
  assert.ok(out.hits.includes(sid), JSON.stringify(out));
  assert.deepEqual(out.agents, [[devinAgentId(sid, 'a1b2c3d4'), `${sid}:call-2`], [devinAgentId(sid, 'e5f6a7b8'), null]]);
});

test('a store behind a denied directory is incomplete inventory, not absence', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const home = makeTempDir('obelisk-devin-denied-');
  const { root, dbPath } = seedRoot(home);
  new Store(dbPath).close();
  chmodSync(root, 0o000);
  try {
    const { units, issues } = collect(createDevinProvider({ rootDir: root }));
    assert.deepEqual(units, []);
    assert.equal(issues.length, 1);
  } finally {
    chmodSync(root, 0o755);
  }
});
