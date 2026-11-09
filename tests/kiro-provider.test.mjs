// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createKiroProvider, defaultKiroDatabasePath, kiroSessionId } from '../packages/core/src/providers/kiro.ts';
import { createConfiguredBuiltinProviderRuntime } from '../packages/core/src/provider-settings.ts';
import { persist } from '../packages/core/src/persist.ts';
import { runWriteTransaction } from '../packages/core/src/tx.ts';
import { assembleSessionDetail } from '../packages/core/src/session-detail.ts';
import { createQueryApi } from '../packages/core/src/query.ts';
import { createProviderRegistry } from '../packages/core/src/providers/registry.ts';
import { createProviderIndexPlan, indexProviderPlan } from '../packages/core/src/provider-indexing.ts';
import { makeTempDir } from './temp-dirs.mjs';

const fixture = name => new URL(`./fixtures/kiro/${name}`, import.meta.url);
const json = name => JSON.parse(readFileSync(fixture(name), 'utf8'));
const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');
const openDatabase = path => new DatabaseSync(path, { readOnly: true });

function drain(generator) {
  const records = [];
  let step = generator.next();
  while (!step.done) { records.push(step.value); step = generator.next(); }
  return { records, cursor: step.value };
}

function discover(provider, { cursors = new Map(), indexed = [], issues = [], changedPaths } = {}) {
  return provider.discover({ lastCursor: key => cursors.get(key) ?? null,
    indexedSessions: () => indexed, reportIncompleteInventory: issue => issues.push(issue),
    ...(changedPaths === undefined ? {} : { changedPaths }) });
}

function seedCli(root, header = json('cli.json'), contents = readFileSync(fixture('cli.jsonl'), 'utf8'), filename = 'sample') {
  const dir = join(root, 'sessions', 'cli');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${filename}.json`), JSON.stringify(header));
  writeFileSync(join(dir, `${filename}.jsonl`), contents);
  return { metadata: join(dir, `${filename}.json`), path: join(dir, `${filename}.jsonl`) };
}

function seedWorkspace(root, header = json('session.json'), filename = 'sample') {
  const dir = join(root, 'sessions', 'workspace-hash', `sess_${filename}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.json'), JSON.stringify(header));
  copyFileSync(fixture('messages.jsonl'), join(dir, 'messages.jsonl'));
  return dir;
}

function seedStore(root, row = json('conversation.json')) {
  const path = join(root, 'data.sqlite3');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE conversations_v2 (
    key TEXT NOT NULL, conversation_id TEXT NOT NULL, value TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (key, conversation_id))`);
  db.prepare('INSERT INTO conversations_v2 VALUES (?, ?, ?, ?, ?)').run(
    row.key, row.conversation_id, JSON.stringify(row.value), row.created_at, row.updated_at,
  );
  db.close();
  return path;
}

function indexDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}

function storedDetail(db, sessionId) {
  const rows = (table, order = 'rowid') => db.prepare(`SELECT * FROM ${table} WHERE session_id = ? ORDER BY ${order}`).all(sessionId);
  return assembleSessionDetail({
    session: db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId),
    messages: rows('messages', 'timestamp, uuid'), toolCalls: rows('tool_calls'),
    toolResults: rows('tool_results'), subagents: rows('subagents'), summaries: rows('summaries'),
  });
}

function setup() {
  const root = makeTempDir('obelisk-kiro-');
  return { root, provider: createKiroProvider({ rootDir: root, openDatabase }) };
}

function seedV3(root) {
  const directory = join(root, 'sessions', 'workspace-hash', 'sess_v3');
  cpSync(new URL('./fixtures/kiro/v3/', import.meta.url), directory, { recursive: true });
  return directory;
}

test('Kiro V3 child file changes and deletion refresh the parent snapshot without a parent-file change', () => {
  const { root, provider } = setup();
  const directory = seedV3(root);
  const [unit] = discover(provider);
  const first = drain(provider.parse(unit, null));
  const child = join(directory, 'sub-executions', readdirSync(join(directory, 'sub-executions'))[0]);
  const indexed = [{ sessionId: unit.sessionId, jsonlPath: join(directory, 'messages.jsonl') }];
  const context = { indexed, cursors: new Map([[unit.key, first.cursor]]) };
  writeFileSync(child, readFileSync(child, 'utf8').replace('Example child response', 'Updated child response'));
  const [changed] = discover(provider, context);
  assert.ok([...provider.parse(changed, first.cursor)].some(row => row.kind === 'message' && row.text === 'Updated child response'));
  assert.throws(() => [...provider.parse(unit, first.cursor)], /changed after discovery/);
  rmSync(child);
  const [removed] = discover(provider, context);
  const remaining = [...provider.parse(removed, first.cursor)];
  assert.equal(remaining.filter(row => row.kind === 'message' && row.agent_id !== null).length, 1,
    'the final response saved in the parent survives removal of the child file');
  assert.ok(!remaining.some(row => row.kind === 'message' && row.text === 'Updated child response'));
});

test('Kiro V3 compaction summaries and tangent sessions preserve native evidence without losing parent history', () => {
  const { root, provider } = setup();
  const directory = seedV3(root);
  const transcript = join(directory, 'messages.jsonl');
  writeFileSync(transcript, readFileSync(transcript, 'utf8') + readFileSync(fixture('v3/compaction.jsonl'), 'utf8'));
  cpSync(fixture('v3/tangent'), join(root, 'sessions', 'workspace-hash', 'sess_tangent'), { recursive: true });
  const units = discover(provider);
  assert.equal(units.length, 2);
  const records = units.flatMap(unit => [...provider.parse(unit, null)]);
  const summary = records.find(row => row.kind === 'summary');
  assert.equal(summary.content, 'Example compaction summary');
  assert.equal(summary.source, 'kiro:compaction');
  assert.ok(records.some(row => row.kind === 'message' && row.text === 'Example prompt'));
  assert.ok(records.some(row => row.kind === 'message' && row.text === 'Example tangent response'));
  assert.ok(records.some(row => row.kind === 'message' && row.is_meta && row.text?.startsWith('Forked from Kiro session')));
  const db = indexDb();
  for (const unit of units) persist(db, unit, provider.parse(unit, null));
  const main = records.find(row => row.kind === 'session' && row.title === 'Example session');
  assert.deepEqual(storedDetail(db, main.id), assembleSessionDetail(records.filter(row => row.session_id === main.id || row.id === main.id)));
  db.close();
});

test('Kiro indexes reported usage and V3 events when upgrading an unchanged index from the old canonical marker', () => {
  const { root, provider } = setup(); seedV3(root);
  const [unit] = discover(provider);
  const first = drain(provider.parse(unit, null));
  const db = indexDb();
  // Recreate the original provider's cursor and text-only persisted projection.
  persist(db, unit, (function* () {
    yield* first.records.filter(row => row.kind === 'session' || (row.kind === 'message' && row.agent_id === null && row.content_type === 'text' && !row.text?.startsWith('Kiro ')));
    return first.cursor;
  })());
  db.prepare('INSERT INTO index_state (jsonl_path, mtime, lines_processed, cursor) VALUES (?, 0, 0, ?)')
    .run('__kiro_canonical_transcript_v2__', '0:0:previous-format');
  const registry = createProviderRegistry([provider]);
  const plan = createProviderIndexPlan(db, registry);
  assert.equal(plan.pendingMarkers.get('kiro'), '__kiro_canonical_transcript_v3__');
  assert.ok(plan.items.some(item => item.unit.key === unit.key && item.cursor === null));
  indexProviderPlan({ db, plan, runTransaction: (_label, work) => runWriteTransaction(db, work), onError: error => { throw error; } });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tool_calls').get().n, 5);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM subagents').get().n, 1);
  assert.ok(db.prepare("SELECT text FROM messages WHERE text LIKE 'Kiro reported usage:%'").all().some(row => row.text.includes('0.4241799948590381')));
  assert.equal(createProviderIndexPlan(db, registry).items.length, 0);
  db.close();
});

for (const format of ['cli', 'workspace', 'sqlite', 'v3']) {
  test(`Kiro discovers ${format} sessions and preserves canonical detail through SQLite`, () => {
    const { root, provider } = setup();
    if (format === 'cli') seedCli(root);
    if (format === 'workspace') seedWorkspace(root);
    if (format === 'sqlite') seedStore(root);
    if (format === 'v3') seedV3(root);
    const issues = [];
    const units = discover(provider, { issues });
    assert.deepEqual(issues, []);
    assert.equal(units.length, 1);
    const unit = units[0];
    const { records, cursor } = drain(provider.parse(unit, null));
    const messages = records.filter(row => row.kind === 'message');
    if (format === 'v3') {
      const calls = records.filter(row => row.kind === 'tool_call');
      const results = records.filter(row => row.kind === 'tool_result');
      assert.equal(calls.length, 5);
      assert.equal(results.length, 5);
      assert.ok(results.every(result => calls.some(call => call.id === result.tool_use_id)));
      assert.ok(messages.some(row => row.content_type === 'thinking'));
      const child = records.find(row => row.kind === 'subagent');
      assert.equal(child.agent_type, 'general-task-execution');
      assert.ok(child.duration_ms > 0);
      assert.equal(calls.find(call => call.id === child.parent_tool_use_id).name, 'orchestrate_subagent');
      assert.equal(messages.filter(row => row.agent_id === child.agent_id).length, 8);
      assert.ok(messages.some(row => row.is_meta === 1 && row.text?.startsWith('Kiro reported usage:') && row.text.includes('0.4241799948590381') && row.text.includes('credit')));
      assert.ok(messages.some(row => row.is_meta === 1 && row.text?.startsWith('Kiro reported usage percentage:') && row.text.includes('2.9042000770568848')));
      assert.ok(messages.every(row => row.input_tokens === null && row.output_tokens === null), 'credit usage must not become tokens');
    }
    assert.ok(messages.some(row => row.role === 'user' && row.text === (format === 'v3' ? 'Example prompt' : 'Example content')));
    assert.ok(messages.some(row => row.role === 'assistant' && row.text === (format === 'v3' ? 'Example response' : 'Example content')));
    if (format !== 'workspace') {
      const calls = records.filter(row => row.kind === 'tool_call');
      const results = records.filter(row => row.kind === 'tool_result');
      assert.ok(calls.length > 0 && results.length > 0);
      assert.ok(results.some(result => calls.some(call => call.id === result.tool_use_id)));
    }
    if (format === 'cli') {
      assert.ok(messages.some(row => row.content_type === 'thinking'));
      assert.ok(messages.some(row => row.is_meta === 1 && row.text.includes('subagent')));
    }
    const db = indexDb();
    persist(db, unit, provider.parse(unit, null));
    const persisted = storedDetail(db, unit.sessionId);
    assert.deepEqual(persisted, assembleSessionDetail(records));
    const api = createQueryApi(db, { providerRegistry: createProviderRegistry([provider]) });
    assert.equal(api.sessions({ source: 'kiro' }).length, 1);
    assert.ok(api.search('Example', { source: 'kiro' }).length > 0);
    if (format === 'v3') assert.ok(api.search('credit', { source: 'kiro', includeMeta: true }).some(hit => hit.message.text.includes('0.4241799948590381')));
    const sourceSession = records.find(row => row.kind === 'session');
    const target = messages.find(row => row.text === (format === 'v3' ? 'Example child response' : 'Example content'));
    if (format === 'v3') assert.ok(api.search('Example child response', { source: 'kiro' }).some(row => row.message.uuid === target.uuid));
    assert.equal(provider.raw({ source: 'kiro', messageUuid: target.uuid,
      session: sourceSession, agentId: target.agent_id, cursor }).messageText, target.text);
    assert.deepEqual(discover(provider, { cursors: new Map([[unit.key, cursor]]), indexed: [{ sessionId: unit.sessionId, jsonlPath: sourceSession.jsonl_path }] }), []);
    db.close();
  });
}

test('Kiro deduplicates the same identity across all three stores, using the newest snapshot', () => {
  const { root, provider } = setup();
  const id = 'shared-id';
  seedCli(root, { ...json('cli.json'), session_id: id, updated_at: '2026-01-01T12:00:00Z' });
  seedWorkspace(root, { ...json('session.json'), id, lastModifiedAt: '2026-01-01T12:02:00Z' });
  const row = json('conversation.json');
  row.conversation_id = row.value.conversation_id = id;
  row.updated_at = Date.parse('2026-01-01T12:01:00Z');
  seedStore(root, row);
  const [unit] = discover(provider);
  assert.equal(discover(provider).length, 1);
  const session = [...provider.parse(unit, null)].find(row => row.kind === 'session');
  assert.match(session.jsonl_path, /messages\.jsonl$/);
  assert.equal(session.id, kiroSessionId(id, '/workspace/demo'));
});

test('Kiro project-local native ids never overwrite another project', () => {
  const { root, provider } = setup();
  seedCli(root, { ...json('cli.json'), session_id: 'same', cwd: '/workspace/one' }, undefined, 'one');
  seedCli(root, { ...json('cli.json'), session_id: 'same', cwd: '/workspace/two' }, undefined, 'two');
  const units = discover(provider);
  assert.equal(units.length, 2);
  assert.notEqual(units[0].sessionId, units[1].sessionId);
  assert.equal(kiroSessionId('same', 'C:\\Work\\Demo'), kiroSessionId('same', 'c:/work/demo'));
});

test('Kiro ignores line-editor history and keeps metadata-only sessions', () => {
  const { root, provider } = setup();
  const { path } = seedCli(root);
  rmSync(path);
  writeFileSync(path.replace('.jsonl', '.history'), '#V2\n+History-only text\n');
  const dir = seedWorkspace(root);
  rmSync(join(dir, 'messages.jsonl'));
  const units = discover(provider);
  assert.equal(units.length, 2);
  const records = units.flatMap(unit => [...provider.parse(unit, null)]);
  assert.equal(records.filter(row => row.kind === 'session').length, 2);
  assert.ok(!records.some(row => row.kind === 'message' && row.text?.includes('History-only')));
});

test('Kiro same-millisecond rewrites and metadata changes invalidate the cursor', () => {
  const { root, provider } = setup();
  const { path, metadata } = seedCli(root);
  const [unit] = discover(provider);
  const first = drain(provider.parse(unit, null));
  const cursors = new Map([[unit.key, first.cursor]]);
  const indexed = [{ sessionId: unit.sessionId, jsonlPath: path }];
  const before = statSync(path);
  writeFileSync(path, readFileSync(path, 'utf8').replaceAll('Example content', 'Changed content'));
  utimesSync(path, before.atime, before.mtime);
  assert.equal(discover(provider, { cursors, indexed }).length, 1);
  const header = JSON.parse(readFileSync(metadata, 'utf8'));
  header.title = 'New title';
  writeFileSync(metadata, JSON.stringify(header));
  const next = discover(provider, { cursors, indexed })[0];
  assert.equal([...provider.parse(next, first.cursor)].find(row => row.kind === 'session').title, 'New title');
  assert.equal(provider.raw({ source: 'kiro', messageUuid: first.records.find(row => row.kind === 'message').uuid,
    session: first.records.find(row => row.kind === 'session'), agentId: null, cursor: first.cursor }), null);
});

test('Kiro snapshot replacement removes truncated messages and retries reused native tool ids', () => {
  const { root, provider } = setup();
  const header = json('cli.json');
  const event = (kind, content) => ({ version: 'v1', kind, data: { message_id: 'repeated', content } });
  const call = event('AssistantMessage', [{ kind: 'toolUse', data: { toolUseId: 'retry', name: 'example_tool', input: {} } }]);
  const result = event('ToolResults', [{ kind: 'toolResult', data: { toolUseId: 'retry', status: 'error', content: [{ kind: 'text', data: 'failed' }] } }]);
  const rows = [call, result, call, result];
  const { path } = seedCli(root, header, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const [unit] = discover(provider);
  const db = indexDb();
  const initial = drain(provider.parse(unit, null));
  assert.equal(new Set(initial.records.filter(row => row.kind === 'tool_call').map(row => row.id)).size, 2);
  assert.equal(initial.records.filter(row => row.kind === 'tool_result' && row.is_error === 1).length, 2);
  persist(db, unit, provider.parse(unit, null));
  writeFileSync(path, JSON.stringify(call) + '\n');
  const next = discover(provider, { indexed: [{ sessionId: unit.sessionId, jsonlPath: path }], cursors: new Map([[unit.key, initial.cursor]]) })[0];
  persist(db, next, provider.parse(next, initial.cursor));
  assert.equal(db.prepare('SELECT count(*) n FROM tool_calls').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM tool_results').get().n, 0);
  db.close();
});

test('Kiro preserves image-only and aborted rows and assigns turn usage only once', () => {
  const { root, provider } = setup();
  const header = json('cli.json');
  header.session_state.conversation_metadata.user_turn_metadatas = [{
    message_ids: ['assistant'], input_token_count: 10, cache_read_input_token_count: 20,
    cache_write_input_token_count: 30, output_token_count: 4, model: 'example-model',
  }];
  seedCli(root, header, [
    { version: 'v1', kind: 'Prompt', data: { content: [{ kind: 'image', data: {} }] } },
    { version: 'v1', kind: 'AssistantMessage', data: { message_id: 'assistant', content: [] } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const messages = [...provider.parse(discover(provider)[0], null)].filter(row => row.kind === 'message' && row.is_meta === 0);
  assert.deepEqual(messages.map(row => row.text), [null, null]);
  assert.deepEqual(messages.map(row => row.content_type), ['unknown', 'unknown']);
  assert.equal(messages.reduce((sum, row) => sum + (row.input_tokens ?? 0), 0), 60);
  assert.equal(messages.reduce((sum, row) => sum + (row.output_tokens ?? 0), 0), 4);
});

test('Kiro classic usage includes cache once and pending/cancelled input remains searchable', () => {
  const { root, provider } = setup();
  const row = json('conversation.json');
  row.value.history[0].request_metadata = { uncached_input_tokens: 10, cache_read_input_tokens: 20, cache_write_input_tokens: 30, output_tokens: 4 };
  row.value.next_message = { content: { CancelledToolUses: { prompt: 'Pending prompt', tool_use_results: [{ tool_use_id: 'cancelled', content: [{ Text: 'Cancelled output' }], status: 'Error' }] } } };
  seedStore(root, row);
  const records = [...provider.parse(discover(provider)[0], null)];
  const messages = records.filter(row => row.kind === 'message');
  assert.equal(messages.reduce((sum, row) => sum + (row.input_tokens ?? 0), 0), 60);
  assert.ok(messages.some(row => row.text === 'Pending prompt'));
  assert.ok(records.some(row => row.kind === 'tool_result' && row.content === 'Cancelled output' && row.is_error === 1));
});

test('Kiro retains turn accounting when an aborted turn has no assistant message', () => {
  const { root, provider } = setup();
  const header = json('cli.json');
  header.session_state.conversation_metadata.user_turn_metadatas = [{
    message_ids: ['missing'], input_token_count: 12, output_token_count: 0,
    end_timestamp: '2026-01-01T12:00:00Z', model: 'example-model',
  }];
  seedCli(root, header, '');
  const messages = [...provider.parse(discover(provider)[0], null)].filter(row => row.kind === 'message' && row.is_meta === 0);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, null);
  assert.equal(messages[0].input_tokens, 12);
  assert.equal(messages[0].output_tokens, 0);
});

test('Kiro reports unknown CLI event and workspace versions during discovery', () => {
  const { root, provider } = setup();
  seedCli(root, json('cli.json'), '{"version":"v99","kind":"Prompt","data":{}}\n');
  const header = json('session.json'); header.schemaVersion = '99.0.0';
  seedWorkspace(root, header);
  const issues = [];
  assert.deepEqual(discover(provider, { issues }), []);
  assert.equal(issues.length, 2);
  assert.ok(issues.some(issue => /Unsupported Kiro CLI event version/.test(issue.error)));
  assert.ok(issues.some(issue => /Unsupported Kiro workspace schema/.test(issue.error)));
});

test('Kiro preserves the last snapshot when inventory is unavailable or a version is unknown', () => {
  const { root, provider } = setup();
  const { path, metadata } = seedCli(root);
  const [unit] = discover(provider);
  const indexed = [{ sessionId: unit.sessionId, jsonlPath: path }];
  const issues = [];
  const header = json('cli.json'); header.session_state.version = 'v99';
  writeFileSync(metadata, JSON.stringify(header));
  assert.deepEqual(discover(provider, { indexed, issues }), []);
  assert.match(issues[0].error, /Unsupported Kiro CLI schema/);
  rmSync(join(root, 'sessions'), { recursive: true });
  assert.deepEqual(discover(provider, { indexed, issues }), []);
  assert.ok(issues.length > 1);
});

test('Kiro unreadable stores and completed corrupt JSONL never publish an empty replacement', () => {
  const { root, provider } = setup();
  writeFileSync(join(root, 'data.sqlite3'), 'not SQLite');
  const issues = [];
  assert.deepEqual(discover(provider, { issues }), []);
  assert.equal(issues.length, 1);
  rmSync(join(root, 'data.sqlite3'));
  const { path } = seedCli(root);
  const [unit] = discover(provider);
  writeFileSync(path, '{broken}\n');
  assert.throws(() => [...provider.parse(unit, null)], /changed after discovery/);
  const [broken] = discover(provider);
  assert.throws(() => [...provider.parse(broken, null)], /Invalid Kiro JSONL/);
});

test('Kiro torn final lines retry when completed without dropping committed content', () => {
  const { root, provider } = setup();
  const { path } = seedCli(root);
  const prefix = readFileSync(path, 'utf8');
  writeFileSync(path, prefix + '{"version":');
  const first = drain(provider.parse(discover(provider)[0], null));
  writeFileSync(path, prefix + '{"version":"v1","kind":"Prompt","data":{"content":[{"kind":"text","data":"Completed prompt"}]}}\n');
  const [unit] = discover(provider, { cursors: new Map([[discover(provider)[0].key, first.cursor]]) });
  const next = [...provider.parse(unit, first.cursor)];
  assert.ok(next.some(row => row.kind === 'message' && row.text === 'Completed prompt'));
});

test('Kiro moves preserve identity and confirmed deletion retracts once, with restoration discoverable', () => {
  const { root, provider } = setup();
  const dir = seedWorkspace(root);
  const [unit] = discover(provider);
  const first = drain(provider.parse(unit, null));
  const indexed = [{ sessionId: unit.sessionId, jsonlPath: join(dir, 'messages.jsonl') }];
  const moved = join(root, 'sessions', 'workspace-hash', 'sess_moved');
  renameSync(dir, moved);
  const units = discover(provider, { indexed, cursors: new Map([[unit.key, first.cursor]]) });
  assert.equal(units.length, 1); assert.equal(units[0].sessionId, unit.sessionId);
  rmSync(moved, { recursive: true });
  const [tombstone] = discover(provider, { indexed });
  const removed = drain(provider.parse(tombstone, first.cursor));
  assert.deepEqual(removed.records, []);
  assert.equal(removed.cursor, '0:0:kiro-tombstone');
  assert.deepEqual(discover(provider, { cursors: new Map([[unit.key, removed.cursor]]) }), []);
  seedWorkspace(root);
  assert.equal(discover(provider, { cursors: new Map([[unit.key, removed.cursor]]) }).length, 1);
});

for (const unavailable of ['sessions', 'database']) {
  test(`Kiro tombstones retain both sources when ${unavailable} becomes unavailable before persistence`, () => {
    const { root, provider } = setup();
    seedCli(root);
    const store = seedStore(root);
    const db = indexDb();
    const units = discover(provider);
    for (const unit of units) persist(db, unit, provider.parse(unit, null));
    const indexed = db.prepare('SELECT id AS sessionId, jsonl_path AS jsonlPath FROM sessions').all();
    // Confirm an empty inventory while both source containers still exist.
    rmSync(join(root, 'sessions', 'cli'), { recursive: true });
    const sourceDb = new DatabaseSync(store);
    sourceDb.exec('DELETE FROM conversations_v2'); sourceDb.close();
    const tombstones = discover(provider, { indexed });
    assert.equal(tombstones.length, 2);
    rmSync(unavailable === 'sessions' ? join(root, 'sessions') : store, { recursive: true });
    for (const unit of tombstones) {
      assert.throws(() => runWriteTransaction(db, () => persist(db, unit, provider.parse(unit, null))), /inventory changed before deletion/);
    }
    assert.equal(db.prepare('SELECT count(*) n FROM sessions').get().n, 2);
    db.close();
  });
}

test('Kiro root settings drive real discovery and custom roots exclude the platform database', () => {
  const root = makeTempDir('obelisk-kiro-settings-'); seedCli(root);
  const runtime = createConfiguredBuiltinProviderRuntime({ providerRoots: { kiro: root } });
  const provider = runtime.registry.get('kiro');
  assert.equal(runtime.roots.kiro, root);
  assert.equal(discover(provider).length, 1);
  assert.deepEqual(provider.watchTargets(root).map(target => target.path), [join(root, 'sessions'), join(root, 'data.sqlite3'), join(root, 'data.sqlite3-wal')]);
  assert.equal(defaultKiroDatabasePath({ homeDir: '/home/example', platform: 'linux', env: {} }), '/home/example/.local/share/kiro-cli/data.sqlite3');
  assert.equal(defaultKiroDatabasePath({ homeDir: '/home/example', platform: 'linux', env: { XDG_DATA_HOME: '/data' } }), '/data/kiro-cli/data.sqlite3');
  assert.equal(defaultKiroDatabasePath({ homeDir: '/home/example', platform: 'darwin', env: {} }), '/home/example/Library/Application Support/kiro-cli/data.sqlite3');
  assert.equal(defaultKiroDatabasePath({ homeDir: 'C:\\Users\\example', platform: 'win32', env: { LOCALAPPDATA: 'D:\\Local' } }), 'D:\\Local\\kiro-cli\\data.sqlite3');
});

test('Kiro opens its real SQLite source read-only and leaves every source byte unchanged', () => {
  const { root } = setup();
  const path = seedStore(root);
  const before = readFileSync(path);
  const provider = createKiroProvider({ rootDir: root });
  const [unit] = discover(provider);
  assert.ok([...provider.parse(unit, null)].length > 0);
  assert.deepEqual(readFileSync(path), before);
  const db = openDatabase(path);
  assert.throws(() => db.exec('DELETE FROM conversations_v2'), /readonly/);
  db.close();
});
