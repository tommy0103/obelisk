// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import {
  codexRootScope,
  createCodexProvider,
  defaultCodexHome,
} from '../packages/core/src/providers/codex.ts';
import { createConfiguredBuiltinProviderRuntime } from '../packages/core/src/provider-settings.ts';
import { createProviderIndexPlan, indexProviderPlanStrict } from '../packages/core/src/provider-indexing.ts';
import { createProviderRegistry } from '../packages/core/src/providers/registry.ts';
import { createQueryApi } from '../packages/core/src/query.ts';
import { assembleSessionDetail } from '../packages/core/src/session-detail.ts';
import { registerSessionQueryHandlers } from '../app/src/main/session-queries.ts';
import { runCli } from './cli-test-helpers.mjs';
import { makeTempDir } from './temp-dirs.mjs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');
const REAL_FIXTURE = new URL('./fixtures/codex/real-rollout-structural-sanitized.jsonl', import.meta.url);
const REAL_PREFIX_FIXTURE = new URL('./fixtures/codex/real-rollout-structural-sanitized-prefix.jsonl', import.meta.url);

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}

function drain(gen) {
  const values = [];
  let step = gen.next();
  while (!step.done) {
    values.push(step.value);
    step = gen.next();
  }
  return { values, ret: step.value };
}

function detailRows(db, sessionId) {
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

function dumpCodexState(db) {
  const q = (sql) => db.prepare(sql).all();
  return {
    sessions: q("SELECT id, title, project, started_at, ended_at, git_branch, version, message_count, jsonl_path, source FROM sessions WHERE source='codex' ORDER BY id"),
    messages: q("SELECT uuid, session_id, type, parent_uuid, timestamp, role, text, content_type, is_meta, visibility, model, is_sidechain, agent_id, input_tokens, output_tokens, turn_duration_ms, cwd, skill, source FROM messages WHERE source='codex' ORDER BY uuid"),
    toolCalls: q("SELECT id, message_uuid, session_id, name, presentation, input_json, file_path FROM tool_calls WHERE session_id LIKE 'codex:%' ORDER BY id"),
    toolResults: q("SELECT tool_use_id, message_uuid, session_id, content, file_path, is_error FROM tool_results WHERE session_id LIKE 'codex:%' ORDER BY tool_use_id"),
    subagents: q("SELECT agent_id, session_id, parent_tool_use_id, agent_type, description, duration_ms, total_tokens FROM subagents WHERE session_id LIKE 'codex:%' ORDER BY agent_id"),
  };
}

function writeRollout(rootDir, {
  id = '019ed000-0000-7000-8000-000000000501',
  subdir = join('sessions', '2026', '06', '15'),
  filename = `rollout-2026-06-15T10-00-00-${id}.jsonl`,
  cwd = '/tmp/codex-multi-root',
  userText = 'hello from codex',
  assistantText = 'reply from codex',
  callId = 'call_shared_1',
  parentThreadId = null,
  agentRole = null,
  compressed = false,
} = {}) {
  const dir = join(rootDir, subdir);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, compressed ? `${filename}.zst` : filename);
  const metaPayload = {
    id,
    timestamp: '2026-06-15T10:00:00Z',
    cwd,
    cli_version: '1.0',
    ...(parentThreadId
      ? { source: { subagent: { thread_spawn: { parent_thread_id: parentThreadId, agent_role: agentRole || 'worker', agent_nickname: 'Helper' } } } }
      : {}),
  };
  const lines = [
    JSON.stringify({ type: 'session_meta', timestamp: '2026-06-15T10:00:00Z', payload: metaPayload }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-06-15T10:00:01Z', payload: { type: 'user_message', message: userText } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-06-15T10:00:02Z', payload: { type: 'agent_message', message: assistantText } }),
    JSON.stringify({ type: 'response_item', timestamp: '2026-06-15T10:00:03Z', payload: { type: 'function_call', call_id: callId, name: 'shell', arguments: '{"cmd":"pwd"}' } }),
    JSON.stringify({ type: 'response_item', timestamp: '2026-06-15T10:00:04Z', payload: { type: 'function_call_output', call_id: callId, output: cwd } }),
  ];
  const content = `${lines.join('\n')}\n`;
  writeFileSync(target, compressed ? zstdCompressSync(Buffer.from(content, 'utf8')) : content);
  return target;
}

function realRolloutId() {
  return JSON.parse(readFileSync(REAL_FIXTURE, 'utf8').split('\n')[0]).payload.id;
}

test('CODEX_HOME resolution supports absolute, tilde, relative, blank, and unset overrides', () => {
  const home = makeTempDir('obelisk-codex-home-');
  const cwd = join(home, 'workspace');
  mkdirSync(cwd, { recursive: true });

  assert.equal(defaultCodexHome({ env: {}, homeDir: home, cwd }), join(home, '.codex'));
  assert.equal(defaultCodexHome({ env: { CODEX_HOME: '   ' }, homeDir: home, cwd }), join(home, '.codex'));
  assert.equal(defaultCodexHome({ env: { CODEX_HOME: '~' }, homeDir: home, cwd }), home);
  assert.equal(defaultCodexHome({ env: { CODEX_HOME: '~/custom-codex' }, homeDir: home, cwd }), join(home, 'custom-codex'));
  assert.equal(defaultCodexHome({ env: { CODEX_HOME: '~\\win-codex' }, homeDir: home, cwd }), join(home, 'win-codex'));
  assert.equal(defaultCodexHome({ env: { CODEX_HOME: './rel-codex' }, homeDir: home, cwd }), resolve(cwd, './rel-codex'));
  const absoluteCodex = join(home, 'absolute-codex');
  assert.equal(defaultCodexHome({ env: { CODEX_HOME: absoluteCodex }, homeDir: home, cwd }), absoluteCodex);
  assert.equal(defaultCodexHome({ env: { CODEX_HOME: '/abs/codex' }, homeDir: home, cwd }), resolve(cwd, '/abs/codex'));
});

test('explicit real and symlink roots discover one physical Codex store with a stable scope', () => {
  const home = makeTempDir('obelisk-codex-alias-');
  const realRoot = join(home, 'real-codex');
  const aliasRoot = join(home, 'alias-codex');
  const file = writeRollout(realRoot, { id: '019ed000-0000-7000-8000-000000000111' });
  symlinkSync(realRoot, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const provider = createCodexProvider({ roots: [aliasRoot, realRoot], homeDir: home });
  const units = provider.discover({ lastCursor: () => null });
  assert.deepEqual(units.map(unit => unit.key), [file]);
  assert.equal(units[0].sessionId, `codex:${codexRootScope(realRoot, home)}:019ed000-0000-7000-8000-000000000111`);
  assert.deepEqual(provider.discover({ lastCursor: () => null, changedPaths: [join(aliasRoot, 'sessions', '2026', '06', '15', basename(file))] }).map(unit => unit.key), [file]);
});

// Project the pre-deduplication adapter's lexical identities and cursor keys.
function legacyAliasProvider(aliasRoot) {
  const provider = createCodexProvider({ rootDir: aliasRoot });
  const scope = `${basename(aliasRoot)}-${createHash('sha256').update(`codex-root-v1\0${resolve(aliasRoot)}`).digest('hex').slice(0, 8)}`;
  return {
    scope,
    provider: {
      ...provider,
      discover: ctx => provider.discover(ctx).map(unit => ({
        ...unit,
        sessionId: `codex:${scope}:${unit.sessionId.slice('codex:'.length)}`,
        meta: { ...unit.meta, rootScope: scope, storeSuffix: undefined },
      })),
    },
  };
}

function planCodex(db, provider, options) {
  return createProviderIndexPlan(db, createProviderRegistry([provider]), options);
}

function beforeStoreCheckpoints(provider) {
  return {
    ...provider,
    discover: ctx => provider.discover(ctx).map(unit => ({ ...unit, meta: { ...unit.meta, storeSuffix: undefined } })),
  };
}

test('legacy root allows a rollout rewrite when the original source remains in its directory', () => {
  const home = makeTempDir('obelisk-codex-legacy-rewrite-');
  const root = join(home, '.codex');
  const id = '019ed000-0000-7000-8000-000000000133';
  const source = writeRollout(root, { id, userText: 'old default rollout' });
  const db = freshDb();
  const previous = beforeStoreCheckpoints(createCodexProvider({ rootDir: root, homeDir: home }));
  assert.equal(indexProviderPlanStrict({ db, plan: planCodex(db, previous) }).complete, true);
  renameSync(source, `${source}.old`);
  writeRollout(root, { id, userText: 'rewritten default rollout' });
  const next = createCodexProvider({ roots: [root], homeDir: home });
  const plan = planCodex(db, next);
  assert.equal(indexProviderPlanStrict({ db, plan }).complete, true);
  const query = createQueryApi(db, { providerRegistry: createProviderRegistry([next]) });
  assert.match(query.raw(`codex:${id}:000002`)?.text ?? '', /rewritten default rollout/);
  db.close();
});

test('verifying an unchanged legacy rollout permits a later replacement without a backup', () => {
  const home = makeTempDir('obelisk-codex-store-backfill-');
  const root = join(home, '.codex');
  const id = '019ed000-0000-7000-8000-000000000138';
  const source = writeRollout(root, { id, userText: 'old verified rollout' });
  const db = freshDb();
  const previous = beforeStoreCheckpoints(createCodexProvider({ rootDir: root, homeDir: home }));
  assert.equal(indexProviderPlanStrict({ db, plan: planCodex(db, previous) }).complete, true);
  const next = createCodexProvider({ roots: [root], homeDir: home });
  assert.equal(indexProviderPlanStrict({ db, plan: planCodex(db, next) }).complete, true);
  renameSync(source, `${source}.old`);
  writeRollout(root, { id, userText: 'new verified rollout' });
  unlinkSync(`${source}.old`);
  assert.equal(indexProviderPlanStrict({ db, plan: planCodex(db, next) }).complete, true);
  const query = createQueryApi(db, { providerRegistry: createProviderRegistry([next]) });
  assert.match(query.raw(`codex:${id}:000002`)?.text ?? '', /new verified rollout/);
  db.close();
});

test('legacy physical custom root migrates atomically when adding the physical default', () => {
  const home = makeTempDir('obelisk-codex-legacy-physical-custom-');
  const custom = join(home, 'custom');
  const defaultRoot = join(home, '.codex');
  const id = '019ed000-0000-7000-8000-000000000134';
  writeRollout(custom, { id, userText: 'old custom rollout' });
  writeRollout(defaultRoot, { id, userText: 'new default rollout' });
  const db = freshDb();
  const previous = beforeStoreCheckpoints(createCodexProvider({ rootDir: custom, homeDir: home }));
  assert.equal(indexProviderPlanStrict({ db, plan: planCodex(db, previous) }).complete, true);
  const next = createCodexProvider({ roots: [defaultRoot, custom], homeDir: home });
  const plan = planCodex(db, next);
  assert.equal(new Set(plan.items.map(({ unit }) => unit.atomicGroup)).size, 1);
  assert.ok(plan.items.every(({ unit }) => unit.atomicGroup !== undefined));
  assert.equal(indexProviderPlanStrict({ db, plan }).complete, true);
  const messages = db.prepare('SELECT session_id FROM messages WHERE text=?');
  assert.equal(messages.get('old custom rollout').session_id, `codex:${codexRootScope(custom, home)}:${id}`);
  assert.equal(messages.get('new default rollout').session_id, `codex:${id}`);
  db.close();
});

test('a stale custom-root guardian is retracted before the default publishes the same bare ID', () => {
  const home = makeTempDir('obelisk-codex-guardian-ownership-');
  const custom = join(home, 'custom');
  const defaultRoot = join(home, '.codex');
  const id = '019ed000-0000-7000-8000-000000000139';
  const path = writeRollout(custom, { id, userText: 'stale guardian' });
  const lines = readFileSync(path, 'utf8').split('\n');
  const meta = JSON.parse(lines[0]);
  meta.payload.source = { subagent: { other: 'guardian' } };
  lines[0] = JSON.stringify(meta);
  writeFileSync(path, lines.join('\n'));
  writeRollout(defaultRoot, { id, userText: 'real default rollout' });
  const db = freshDb();
  const bareId = `codex:${id}`;
  db.prepare("INSERT INTO sessions (id, jsonl_path, source) VALUES (?, ?, 'codex')").run(bareId, path);
  db.prepare('INSERT INTO subagents (agent_id, session_id) VALUES (?, ?)').run(bareId, bareId);
  db.prepare('INSERT INTO index_state (jsonl_path, mtime, lines_processed) VALUES (?, ?, 2)').run(path, statSync(path).mtimeMs);
  const next = createCodexProvider({ roots: [defaultRoot, custom], homeDir: home });
  assert.equal(indexProviderPlanStrict({ db, plan: planCodex(db, next) }).complete, true);
  assert.equal(db.prepare('SELECT session_id FROM messages WHERE text=?').get('real default rollout').session_id, bareId);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM subagents').get().count, 0);
  const fresh = freshDb();
  assert.equal(indexProviderPlanStrict({ db: fresh, plan: planCodex(fresh, next) }).complete, true);
  assert.deepEqual(dumpCodexState(db), dumpCodexState(fresh));
  assert.equal(indexProviderPlanStrict({ db, plan: planCodex(db, next) }).complete, true);
  assert.deepEqual(dumpCodexState(db), dumpCodexState(fresh));
  fresh.close();
  db.close();
});

test('retargeting the same single-root spelling preserves legacy bare history', () => {
  const home = makeTempDir('obelisk-codex-single-root-retarget-');
  const root = join(home, '.codex');
  const first = join(home, 'first');
  const second = join(home, 'second');
  const id = '019ed000-0000-7000-8000-000000000137';
  writeRollout(first, { id, userText: 'first single store' });
  writeRollout(second, { id, userText: 'second single store' });
  const aliasType = process.platform === 'win32' ? 'junction' : 'dir';
  symlinkSync(first, root, aliasType);
  const db = freshDb();
  const provider = createCodexProvider({ rootDir: root, homeDir: home });
  const previous = beforeStoreCheckpoints(provider);
  assert.equal(indexProviderPlanStrict({ db, plan: planCodex(db, previous) }).complete, true);
  unlinkSync(root);
  symlinkSync(second, root, aliasType);
  const plan = planCodex(db, provider, { force: true });
  assert.equal(plan.incompleteProviders.has('codex'), true);
  assert.equal(plan.items.length, 0);
  const uuid = `codex:${id}:000002`;
  assert.equal(db.prepare('SELECT text FROM messages WHERE uuid=?').get(uuid).text, 'first single store');
  assert.equal(createQueryApi(db, { providerRegistry: createProviderRegistry([provider]) }).raw(uuid), null);
  unlinkSync(root);
  symlinkSync(first, root, aliasType);
  assert.equal(indexProviderPlanStrict({ db, plan: planCodex(db, provider) }).complete, true);
  db.close();
});

test('raw follows an indexed transcript directory alias and rejects a redirected rollout file', () => {
  const home = makeTempDir('obelisk-codex-sessions-alias-');
  const root = join(home, '.codex');
  const external = join(home, 'external');
  const parentId = '019ed000-0000-7000-8000-000000000135';
  const childId = '019ed000-0000-7000-8000-000000000136';
  const parent = writeRollout(external, { id: parentId, userText: 'linked parent' });
  writeRollout(external, { id: childId, parentThreadId: parentId, userText: 'linked child' });
  mkdirSync(root);
  symlinkSync(join(external, 'sessions'), join(root, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir');
  const db = freshDb();
  const provider = createCodexProvider({ roots: [root], homeDir: home });
  assert.equal(indexProviderPlanStrict({ db, plan: planCodex(db, provider) }).complete, true);
  const query = createQueryApi(db, { providerRegistry: createProviderRegistry([provider]) });
  const parentUuid = `codex:${parentId}:000002`;
  const childUuid = `codex:${childId}:000002`;
  assert.match(query.raw(parentUuid)?.text ?? '', /linked parent/);
  assert.match(query.raw(childUuid)?.text ?? '', /linked child/);
  if (process.platform !== 'win32') {
    const moved = join(home, basename(parent));
    renameSync(parent, moved);
    symlinkSync(moved, parent);
    assert.equal(query.raw(parentUuid), null);
  }
  db.close();
});

test('legacy standalone alias child retraction commits with the migrated parent and all contributors', () => {
  const home = makeTempDir('obelisk-codex-alias-rekey-');
  const realRoot = join(home, 'real-codex');
  const aliasRoot = join(home, 'alias-codex');
  const parentId = '019ed000-0000-7000-8000-000000000121';
  const childId = '019ed000-0000-7000-8000-000000000122';
  const parentPath = writeRollout(realRoot, { id: parentId, userText: 'parent' });
  const childPath = writeRollout(realRoot, { id: childId, userText: 'standalone child' });
  symlinkSync(realRoot, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const legacy = legacyAliasProvider(aliasRoot);
  const oldParent = `codex:${legacy.scope}:${parentId}`;
  const oldChild = `codex:${legacy.scope}:${childId}`;
  const db = freshDb();
  assert.equal(indexProviderPlanStrict({ db, plan: planCodex(db, legacy.provider) }).complete, true);
  writeRollout(realRoot, { id: childId, parentThreadId: parentId, userText: 'merged child' });

  const provider = createCodexProvider({ roots: [aliasRoot, realRoot], homeDir: home });
  const plan = planCodex(db, provider, { changedPaths: [parentPath] });
  const parent = plan.items.find(({ unit }) => unit.key === parentPath).unit;
  const child = plan.items.find(({ unit }) => unit.key === childPath).unit;
  assert.equal(parent.atomicGroup, child.atomicGroup);
  assert.deepEqual(new Set(parent.retractSessionIds), new Set([oldParent, oldChild]));
  assert.equal(indexProviderPlanStrict({ db, plan }).complete, true);
  assert.deepEqual(db.prepare('SELECT id FROM sessions ORDER BY id').all().map(row => row.id), [parent.sessionId]);
  assert.ok(db.prepare('SELECT 1 FROM messages WHERE session_id=? AND text=?').get(parent.sessionId, 'merged child'));
  assert.equal(db.prepare('SELECT 1 FROM messages WHERE text=?').get('standalone child'), undefined);
  db.close();
});

test('legacy child raw lookup and first refresh work after dropping a live alias from settings', () => {
  const home = makeTempDir('obelisk-codex-unconfigured-alias-');
  const realRoot = join(home, 'real-codex');
  const aliasRoot = join(home, 'alias-codex');
  const parentId = realRolloutId();
  const childId = '019ed000-0000-7000-8000-000000000124';
  const parentDir = join(realRoot, 'sessions', '2026', '06', '15');
  mkdirSync(parentDir, { recursive: true });
  const parentPath = join(parentDir, `rollout-${parentId}.jsonl`);
  copyFileSync(REAL_FIXTURE, parentPath);
  writeRollout(realRoot, { id: childId, parentThreadId: parentId, userText: 'legacy child message' });
  symlinkSync(realRoot, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const legacy = legacyAliasProvider(aliasRoot);
  const db = freshDb();
  assert.equal(indexProviderPlanStrict({ db, plan: planCodex(db, legacy.provider) }).complete, true);
  const oldParent = `codex:${legacy.scope}:${parentId}`;
  const oldChild = `codex:${legacy.scope}:${childId}`;
  const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(oldParent);
  const { cursor } = db.prepare('SELECT cursor FROM index_state WHERE jsonl_path=?').get(session.jsonl_path);

  const provider = createCodexProvider({ roots: [realRoot], homeDir: home });
  assert.match(provider.raw({
    source: 'codex', messageUuid: `${oldChild}:000002`, agentId: oldChild, session, cursor,
    cursorForPath: path => db.prepare('SELECT cursor FROM index_state WHERE jsonl_path=?').get(path)?.cursor ?? null,
  })?.text ?? '', /legacy child message/);
  const plan = planCodex(db, provider, { changedPaths: [parentPath] });
  assert.equal(indexProviderPlanStrict({ db, plan }).complete, true);
  const newParent = `codex:${codexRootScope(realRoot, home)}:${parentId}`;
  assert.deepEqual(db.prepare('SELECT id FROM sessions').all().map(row => row.id), [newParent]);
  assert.ok(db.prepare('SELECT 1 FROM messages WHERE session_id=? AND text=?').get(newParent, 'legacy child message'));
  assert.equal(planCodex(db, provider).items.length, 0);
  db.close();
});

test('legacy child raw evidence and family migration require the indexed child source', async () => {
  const home = makeTempDir('obelisk-codex-alias-child-source-');
  const firstRoot = join(home, 'first-codex');
  const secondRoot = join(home, 'second-codex');
  const aliasRoot = join(home, 'alias-codex');
  const parentId = realRolloutId();
  const childId = '019ed000-0000-7000-8000-000000000124';
  const originalChild = `original child ${'x'.repeat(10_010)} end`;
  const childPath = writeRollout(firstRoot, { id: childId, parentThreadId: parentId, userText: originalChild });
  const parentPath = join(firstRoot, 'sessions', '2026', '06', '15', `rollout-${parentId}.jsonl`);
  copyFileSync(REAL_FIXTURE, parentPath);
  const aliasType = process.platform === 'win32' ? 'junction' : 'dir';
  symlinkSync(firstRoot, aliasRoot, aliasType);
  const legacy = legacyAliasProvider(aliasRoot);
  const db = freshDb();
  assert.equal(indexProviderPlanStrict({ db, plan: planCodex(db, legacy.provider) }).complete, true);
  const childUuid = `codex:${legacy.scope}:${childId}:000002`;
  const next = createCodexProvider({ roots: [firstRoot], homeDir: home });
  const raw = provider => createQueryApi(db, { providerRegistry: createProviderRegistry([provider]) }).raw(childUuid);
  const handlers = new Map();
  registerSessionQueryHandlers({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    getDb: () => db,
    getRuntimePaths: () => ({ providerRegistry: createProviderRegistry([next]), providerRoots: {} }),
    getIndexerWorker: () => null,
    runAppDbWrite: () => false,
  });
  const fullText = () => handlers.get('db:getMessageFullText')(null, childUuid);
  const cachedText = db.prepare('SELECT text FROM messages WHERE uuid=?').get(childUuid).text;
  assert.notEqual(cachedText, originalChild);
  assert.match(raw(next)?.text ?? '', /original child/);
  db.prepare('UPDATE index_state SET replay_required = 1 WHERE jsonl_path LIKE ?').run(`%${basename(childPath)}`);
  assert.match(raw(next)?.text ?? '', /original child/);
  assert.equal(await fullText(), originalChild);
  appendFileSync(childPath, '\n');
  assert.match(raw(next)?.text ?? '', /original child/);
  renameSync(childPath, `${childPath}.old`);
  writeRollout(firstRoot, { id: childId, parentThreadId: parentId, userText: 'replacement child' });
  assert.equal(raw(next), null);
  assert.equal(await fullText(), cachedText);

  const otherChild = writeRollout(secondRoot, { id: childId, parentThreadId: parentId, userText: 'other store child' });
  linkSync(parentPath, join(otherChild, '..', basename(parentPath)));
  unlinkSync(aliasRoot);
  symlinkSync(secondRoot, aliasRoot, aliasType);
  const retargeted = createCodexProvider({ roots: [aliasRoot], homeDir: home });
  assert.equal(raw(retargeted), null);
  assert.equal(indexProviderPlanStrict({ db, plan: planCodex(db, retargeted) }).complete, false);
  assert.ok(db.prepare('SELECT 1 FROM messages WHERE uuid=? AND text=?').get(childUuid, cachedText));
  db.close();
});

test('retargeting a legacy alias cannot reassign its cached history or expose another store via raw lookup', () => {
  const home = makeTempDir('obelisk-codex-retargeted-alias-');
  const firstRoot = join(home, 'first-codex');
  const secondRoot = join(home, 'second-codex');
  const aliasRoot = join(home, 'alias-codex');
  const parentId = '019ed000-0000-7000-8000-000000000125';
  const childId = '019ed000-0000-7000-8000-000000000126';
  for (const [root, text] of [[firstRoot, 'first store'], [secondRoot, 'second store']]) {
    writeRollout(root, { id: parentId, userText: text });
    writeRollout(root, { id: childId, parentThreadId: parentId, userText: `${text} child` });
  }
  const aliasType = process.platform === 'win32' ? 'junction' : 'dir';
  symlinkSync(firstRoot, aliasRoot, aliasType);
  const legacy = legacyAliasProvider(aliasRoot);
  const db = freshDb();
  assert.equal(indexProviderPlanStrict({ db, plan: planCodex(db, legacy.provider) }).complete, true);

  unlinkSync(aliasRoot);
  symlinkSync(secondRoot, aliasRoot, aliasType);
  const provider = createCodexProvider({ roots: [aliasRoot, secondRoot], homeDir: home });
  const oldParent = `codex:${legacy.scope}:${parentId}`;
  const oldChild = `codex:${legacy.scope}:${childId}`;
  const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(oldParent);
  const { cursor } = db.prepare('SELECT cursor FROM index_state WHERE jsonl_path=?').get(session.jsonl_path);
  assert.equal(provider.raw({
    source: 'codex', messageUuid: `${oldChild}:000002`, agentId: oldChild, session, cursor,
  }), null);

  const forcePlan = planCodex(db, provider, { force: true });
  assert.deepEqual(forcePlan.retainedSessions.map(row => row.sessionId), [oldParent]);
  const plan = planCodex(db, provider);
  assert.equal(indexProviderPlanStrict({ db, plan }).complete, true);
  const newParent = `codex:${codexRootScope(secondRoot, home)}:${parentId}`;
  const hasMessage = db.prepare('SELECT 1 FROM messages WHERE session_id=? AND text=?');
  assert.ok(hasMessage.get(oldParent, 'first store child'));
  assert.ok(hasMessage.get(newParent, 'second store child'));
  assert.equal(hasMessage.get(oldParent, 'second store child'), undefined);
  db.close();
});

for (const [replacement, legacy] of [['alias', false], ['directory', false], ['alias', true], ['directory', true]]) {
test(`replacing the ${legacy ? 'legacy' : 'canonical'} default Codex alias with a different ${replacement} preserves bare ID ownership`, () => {
  const home = makeTempDir('obelisk-codex-retargeted-default-');
  const firstRoot = join(home, 'first-codex');
  const secondRoot = join(home, 'second-codex');
  const aliasRoot = join(home, '.codex');
  const parentId = '019ed000-0000-7000-8000-000000000127';
  const childId = '019ed000-0000-7000-8000-000000000128';
  for (const [root, text] of [[firstRoot, 'first default'], [secondRoot, 'second default']]) {
    writeRollout(root, { id: parentId, userText: text });
    writeRollout(root, { id: childId, parentThreadId: parentId, userText: `${text} child` });
  }
  const aliasType = process.platform === 'win32' ? 'junction' : 'dir';
  symlinkSync(firstRoot, aliasRoot, aliasType);
  const db = freshDb();
  const initial = legacy ? beforeStoreCheckpoints(createCodexProvider({ rootDir: aliasRoot, homeDir: home }))
    : createCodexProvider({ roots: [aliasRoot], homeDir: home });
  assert.equal(indexProviderPlanStrict({ db, plan: planCodex(db, initial) }).complete, true);
  const bareParent = `codex:${parentId}`;
  const bareChild = `codex:${childId}`;
  const rawChild = provider => createQueryApi(db, { providerRegistry: createProviderRegistry([provider]) }).raw(`${bareChild}:000002`);

  unlinkSync(aliasRoot);
  if (replacement === 'alias') symlinkSync(secondRoot, aliasRoot, aliasType);
  else renameSync(secondRoot, aliasRoot);
  const next = createCodexProvider({ roots: [aliasRoot], homeDir: home });
  if (legacy) assert.equal(rawChild(next), null);
  else assert.match(rawChild(next)?.text ?? '', /first default child/);
  const blocked = planCodex(db, next);
  assert.equal(blocked.incompleteProviders.has('codex'), true);
  assert.ok(blocked.items.every(({ unit }) => unit.sessionId !== bareParent));
  assert.equal(indexProviderPlanStrict({ db, plan: blocked }).complete, false);
  const recover = createCodexProvider({ roots: [aliasRoot, firstRoot], homeDir: home });
  assert.equal(indexProviderPlanStrict({ db, plan: planCodex(db, recover) }).complete, true);
  const hasMessage = db.prepare('SELECT 1 FROM messages WHERE session_id=? AND text=?');
  assert.ok(hasMessage.get(bareParent, 'first default child'));
  assert.equal(hasMessage.get(bareParent, 'second default child'), undefined);
  assert.match(rawChild(recover)?.text ?? '', /first default child/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE text='second default child'").get().count, 1);
  assert.equal(planCodex(db, recover).items.length, 0);
  db.close();
});
}

for (const unavailableAlias of ['dangling', 'deleted', 'deleted and reselected']) {
test(`built CLI leaves its cache intact when a configured alias is ${unavailableAlias}`, () => {
  const home = makeTempDir('obelisk-codex-dangling-alias-');
  const realRoot = join(home, 'real-codex');
  const aliasRoot = join(home, 'alias-codex');
  const rolloutDir = join(realRoot, 'sessions', '2026', '06', '15');
  mkdirSync(rolloutDir, { recursive: true });
  copyFileSync(REAL_FIXTURE, join(rolloutDir, `rollout-${realRolloutId()}.jsonl`));
  symlinkSync(realRoot, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const obeliskDir = join(home, '.obelisk');
  mkdirSync(obeliskDir);
  const select = root => writeFileSync(join(obeliskDir, 'settings.json'), JSON.stringify({ providerRoots: { codex: [root] } }));
  select(aliasRoot);
  assert.equal(runCli(['--build'], { home }).status, 0);
  const read = () => {
    const db = new DatabaseSync(join(obeliskDir, 'obelisk.sqlite'), { readOnly: true });
    try { return dumpCodexState(db); } finally { db.close(); }
  };
  const before = read();
  assert.equal(before.sessions.length, 1);
  if (unavailableAlias === 'deleted and reselected') {
    select(realRoot);
    assert.equal(runCli(['--build'], { home }).status, 0);
    select(aliasRoot);
  }
  if (unavailableAlias === 'dangling') renameSync(realRoot, join(home, 'offline-codex'));
  else unlinkSync(aliasRoot);
  const unavailable = runCli(['--build'], { home });
  assert.notEqual(unavailable.status, 0);
  assert.match(unavailable.stderr + unavailable.stdout, /Source folder is unavailable/);
  assert.deepEqual(read(), before);
});
}

test('built CLI keeps real-fixture identity stable across alias lifecycle and isolates an independent copy', () => {
  const home = makeTempDir('obelisk-codex-real-alias-cli-');
  const realRoot = join(home, 'real-codex');
  const aliasRoot = join(home, 'alias-codex');
  const independentRoot = join(home, 'independent-codex');
  const rawId = realRolloutId();
  const realFile = join(realRoot, 'sessions', '2026', '06', '15', `rollout-${rawId}.jsonl`);
  mkdirSync(join(realRoot, 'sessions', '2026', '06', '15'), { recursive: true });
  copyFileSync(REAL_PREFIX_FIXTURE, realFile);
  mkdirSync(join(independentRoot, 'sessions', '2026', '06', '15'), { recursive: true });
  copyFileSync(REAL_FIXTURE, join(independentRoot, 'sessions', '2026', '06', '15', `rollout-${rawId}.jsonl`));
  symlinkSync(realRoot, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const settingsPath = join(home, '.obelisk', 'settings.json');
  mkdirSync(join(home, '.obelisk'), { recursive: true });
  const save = roots => writeFileSync(settingsPath, JSON.stringify({ providerRoots: { codex: roots } }));
  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
  const ids = () => {
    const db = new DatabaseSync(dbPath);
    const rows = db.prepare("SELECT id, jsonl_path FROM sessions WHERE source='codex' ORDER BY id").all();
    db.close();
    return rows;
  };

  save([aliasRoot, realRoot, independentRoot]);
  assert.equal(runCli(['--build'], { home }).status, 0);
  const initial = ids();
  assert.equal(initial.length, 2);
  assert.equal(new Set(initial.map(row => row.id)).size, 2);
  assert.equal(initial.filter(row => row.jsonl_path === realFile).length, 1);

  save([independentRoot, realRoot, aliasRoot]);
  assert.equal(runCli(['--build'], { home }).status, 0);
  assert.deepEqual(ids(), initial);

  save([aliasRoot]);
  assert.equal(runCli(['--build'], { home }).status, 0);
  assert.deepEqual(ids().map(row => row.id), [initial.find(row => row.jsonl_path === realFile).id]);

  save([realRoot]);
  assert.equal(runCli(['--build'], { home }).status, 0);
  assert.deepEqual(ids().map(row => row.id), [initial.find(row => row.jsonl_path === realFile).id]);

  const restLines = readFileSync(REAL_FIXTURE, 'utf8').split('\n').slice(60).filter(Boolean);
  appendFileSync(join(aliasRoot, 'sessions', '2026', '06', '15', basename(realFile)), `${restLines.join('\n')}\n`);
  assert.equal(runCli(['--build'], { home }).status, 0);
  const afterAppend = ids();
  assert.deepEqual(afterAppend.map(row => row.id), [initial.find(row => row.jsonl_path === realFile).id]);
});

test('CLI honors CODEX_HOME (including symlinked paths) and explicit providerRoots.codex takes precedence', () => {
  const home = makeTempDir('obelisk-codex-env-cli-');
  const defaultCodex = join(home, '.codex');
  const envCodex = join(home, 'env-codex');
  const envCodexAlias = join(home, 'env-codex-alias');
  const explicitCodex = join(home, 'explicit-codex');

  writeRollout(defaultCodex, { id: '019ed000-0000-7000-8000-000000000101', userText: 'default root sentinel' });

  const realSessDir = join(envCodex, 'sessions', '2026', '06', '15');
  mkdirSync(realSessDir, { recursive: true });
  const envRollout = join(realSessDir, `rollout-${realRolloutId()}.jsonl`);
  copyFileSync(REAL_FIXTURE, envRollout);
  symlinkSync(envCodex, envCodexAlias, process.platform === 'win32' ? 'junction' : 'dir');

  const cliBuild = runCli(['--build'], { home, env: { CODEX_HOME: '~/env-codex-alias' } });
  assert.equal(cliBuild.status, 0, cliBuild.stderr || cliBuild.stdout);

  const queryPath = join(home, 'query-env.mjs');
  const rawId = realRolloutId();
  writeFileSync(queryPath, `return {
    sessions: sessions({ source: 'codex' }).map(s => ({ id: s.id, path: s.jsonl_path })),
    hits: search('default root sentinel', { source: 'codex' }).length,
    rawText: raw(${JSON.stringify(`codex:${rawId}:000007`)}, { limit: 500 })?.text || null,
  };`);
  const cliQuery = runCli(['--query', queryPath], { home, env: { CODEX_HOME: '~/env-codex-alias' } });
  assert.equal(cliQuery.status, 0, cliQuery.stderr || cliQuery.stdout);
  const payload = JSON.parse(cliQuery.stdout);
  assert.equal(payload.sessions.length, 1);
  assert.equal(payload.sessions[0].id, `codex:${rawId}`);
  assert.equal(payload.hits, 0, 'CODEX_HOME replaces default ~/.codex instead of merging both');
  assert.ok(payload.rawText && payload.rawText.includes('user_message'));

  // Explicit providerRoots.codex overrides CODEX_HOME.
  writeRollout(explicitCodex, { id: '019ed000-0000-7000-8000-000000000102', userText: 'explicit override sentinel' });
  mkdirSync(join(home, '.obelisk'), { recursive: true });
  writeFileSync(join(home, '.obelisk', 'settings.json'), JSON.stringify({
    providerRoots: { codex: explicitCodex },
  }));
  const cliExplicit = runCli(['--build'], { home, env: { CODEX_HOME: envCodex } });
  assert.equal(cliExplicit.status, 0, cliExplicit.stderr || cliExplicit.stdout);
  const cliDb = new DatabaseSync(join(home, '.obelisk', 'obelisk.sqlite'));
  const cliSessions = cliDb.prepare("SELECT id FROM sessions WHERE source='codex'").all();
  cliDb.close();
  assert.deepEqual(cliSessions.map((s) => s.id), ['codex:019ed000-0000-7000-8000-000000000102']);
});

test('cross-root copies stay isolated across messages, tools, subagents, session_index, raw lookup, and ADR-0007 round-trip', () => {
  const home = makeTempDir('obelisk-codex-cross-root-');
  const rootDefault = join(home, '.codex');
  const rootWork = join(home, 'codex-work');

  const sharedParentId = realRolloutId();
  const sharedChildId = '019ed000-0000-7000-8000-000000000399';

  for (const [root, title, childText] of [
    [rootDefault, 'Default copy title', 'child in default'],
    [rootWork, 'Work copy title', 'child in work'],
  ]) {
    const dir = join(root, 'sessions', '2026', '06', '15');
    mkdirSync(dir, { recursive: true });
    copyFileSync(REAL_FIXTURE, join(dir, `rollout-${sharedParentId}.jsonl`));
    writeRollout(root, {
      id: sharedChildId,
      filename: `rollout-${sharedChildId}.jsonl`,
      parentThreadId: sharedParentId,
      agentRole: 'explorer',
      userText: childText,
      assistantText: `reply ${childText}`,
      callId: 'call_child_shared',
      compressed: root === rootWork,
    });
    writeFileSync(join(root, 'session_index.jsonl'), `${JSON.stringify({
      id: sharedParentId,
      thread_name: title,
      updated_at: '2026-10-01T00:00:00Z',
    })}\n`);
  }

  const provider = createCodexProvider({ roots: [rootDefault, rootWork], homeDir: home });
  const registry = createProviderRegistry([provider]);
  const db = freshDb();
  const plan = createProviderIndexPlan(db, registry);
  assert.equal(plan.items.length, 4);
  const res = indexProviderPlanStrict({ db, plan });
  assert.equal(res.complete, true);

  const scopeWork = codexRootScope(rootWork, home);
  const defaultSessionId = `codex:${sharedParentId}`;
  const workSessionId = `codex:${scopeWork}:${sharedParentId}`;

  const defaultRow = db.prepare('SELECT * FROM sessions WHERE id=?').get(defaultSessionId);
  const workRow = db.prepare('SELECT * FROM sessions WHERE id=?').get(workSessionId);
  assert.equal(defaultRow.title, 'Default copy title');
  assert.equal(workRow.title, 'Work copy title');

  const defaultMsgs = db.prepare('SELECT uuid, agent_id, text FROM messages WHERE session_id=?').all(defaultSessionId);
  const workMsgs = db.prepare('SELECT uuid, agent_id, text FROM messages WHERE session_id=?').all(workSessionId);
  assert.equal(defaultMsgs.length, workMsgs.length);
  assert.deepEqual(
    defaultMsgs.filter((m) => workMsgs.some((w) => w.uuid === m.uuid)),
    [],
    'no message uuid collision across roots',
  );
  assert.ok(defaultMsgs.some((m) => m.text === 'child in default'));
  assert.ok(!defaultMsgs.some((m) => m.text === 'child in work'));
  assert.ok(workMsgs.some((m) => m.text === 'child in work'));
  assert.ok(!workMsgs.some((m) => m.text === 'child in default'));

  assert.equal(
    db.prepare('SELECT COUNT(*) c FROM tool_calls WHERE session_id=?').get(defaultSessionId).c,
    db.prepare('SELECT COUNT(*) c FROM tool_calls WHERE session_id=?').get(workSessionId).c,
  );
  assert.equal(
    db.prepare('SELECT agent_id FROM subagents WHERE session_id=?').get(defaultSessionId).agent_id,
    `codex:${sharedChildId}`,
  );
  assert.equal(
    db.prepare('SELECT agent_id FROM subagents WHERE session_id=?').get(workSessionId).agent_id,
    `codex:${scopeWork}:${sharedChildId}`,
  );

  const defaultChildMsg = defaultMsgs.find((m) => m.text === 'child in default');
  const workChildMsg = workMsgs.find((m) => m.text === 'child in work');
  const rawDefault = provider.raw({
    source: 'codex',
    messageUuid: defaultChildMsg.uuid,
    agentId: defaultChildMsg.agent_id,
    session: defaultRow,
  });
  const rawWork = provider.raw({
    source: 'codex',
    messageUuid: workChildMsg.uuid,
    agentId: workChildMsg.agent_id,
    session: workRow,
  });
  assert.match(rawDefault.text, /child in default/);
  assert.match(rawWork.text, /child in work/);

  const workUnits = plan.items.filter((item) => item.unit.sessionId === workSessionId).map((item) => item.unit);
  const directRecords = workUnits.flatMap((unit) => drain(provider.parse(unit, null)).values);
  assert.deepEqual(
    assembleSessionDetail(detailRows(db, workSessionId)),
    assembleSessionDetail(directRecords),
    'ADR-0007: direct canonical assembly == SQLite round-trip for scoped multi-root session',
  );
  db.close();
});

test('multi-root CLI build and query work end-to-end with incremental prefix-append convergence', () => {
  const home = makeTempDir('obelisk-codex-cli-multi-');
  const rootA = join(home, 'codex-one');
  const rootB = join(home, 'codex-two');
  const prefixId = JSON.parse(readFileSync(REAL_PREFIX_FIXTURE, 'utf8').split('\n')[0]).payload.id;

  const dirA = join(rootA, 'sessions', '2026', '06', '15');
  mkdirSync(dirA, { recursive: true });
  const fileA = join(dirA, `rollout-${prefixId}.jsonl`);
  copyFileSync(REAL_PREFIX_FIXTURE, fileA);

  writeRollout(rootB, {
    subdir: 'archived_sessions',
    id: '019ed000-0000-7000-8000-000000000601',
    userText: 'archived root two sentinel',
    compressed: true,
  });

  mkdirSync(join(home, '.obelisk'), { recursive: true });
  writeFileSync(join(home, '.obelisk', 'settings.json'), JSON.stringify({
    providerRoots: { codex: [rootA, rootB] },
  }));

  assert.equal(runCli(['--build'], { home }).status, 0);

  const restLines = readFileSync(REAL_FIXTURE, 'utf8').split('\n').slice(60).filter(Boolean);
  appendFileSync(fileA, `${restLines.join('\n')}\n`);
  const nextMtime = statSync(fileA).mtimeMs / 1000 + 5;
  utimesSync(fileA, nextMtime, nextMtime);
  const dbHandle = new DatabaseSync(join(home, '.obelisk', 'obelisk.sqlite'));
  dbHandle.prepare("DELETE FROM index_state WHERE jsonl_path='__last_build__'").run();
  dbHandle.close();

  const queryScript = join(home, 'check-multi.mjs');
  writeFileSync(queryScript, `return {
    sessions: sessions({ source: 'codex' }).map(s => s.id).sort(),
    archivedHits: search('archived root two sentinel', { source: 'codex' }).length,
  };`);
  const queryRes = runCli(['--query', queryScript], { home });
  assert.equal(queryRes.status, 0, queryRes.stderr || queryRes.stdout);
  const result = JSON.parse(queryRes.stdout);
  assert.equal(result.sessions.length, 2);
  assert.equal(result.archivedHits, 1);

  const dbInc = new DatabaseSync(join(home, '.obelisk', 'obelisk.sqlite'));
  const incState = dumpCodexState(dbInc);
  dbInc.close();

  assert.equal(runCli(['--build'], { home }).status, 0);
  const dbClean = new DatabaseSync(join(home, '.obelisk', 'obelisk.sqlite'));
  const cleanState = dumpCodexState(dbClean);
  dbClean.close();
  assert.deepEqual(incState, cleanState);
});

test('multi-root changedPaths only re-plans the affected root and unreadable roots fail inventory', () => {
  const home = makeTempDir('obelisk-codex-changed-paths-');
  const rootA = join(home, 'codex-a');
  const rootB = join(home, 'codex-b');
  const fileA = writeRollout(rootA, { id: '019ed000-0000-7000-8000-000000000701', userText: 'root A' });
  const fileB = writeRollout(rootB, { id: '019ed000-0000-7000-8000-000000000702', userText: 'root B' });

  const provider = createCodexProvider({ roots: [rootA, rootB], homeDir: home });
  const cursors = new Map();
  for (const unit of provider.discover({ lastCursor: () => null })) {
    const { ret } = drain(provider.parse(unit, null));
    cursors.set(unit.key, ret);
  }

  appendFileSync(fileB, `${JSON.stringify({ type: 'event_msg', timestamp: '2026-06-15T10:05:00Z', payload: { type: 'user_message', message: 'appended B' } })}\n`);
  const units = provider.discover({
    lastCursor: (k) => cursors.get(k) ?? null,
    changedPaths: [fileB],
  });
  assert.deepEqual(units.map((u) => u.key), [fileB]);
  assert.ok(!units.some((u) => u.key === fileA));

  // Also test session_index.jsonl changedPaths targeting one root in multi-root mode,
  // and raw() lookup for a retained subagent session from single-root custom mode.
  const indexB = join(rootB, 'session_index.jsonl');
  writeFileSync(indexB, `${JSON.stringify({
    id: '019ed000-0000-7000-8000-000000000702',
    thread_name: 'Root B Updated Title',
    updated_at: '2026-10-02T00:00:00Z',
  })}\n`);
  const indexUnits = provider.discover({
    lastCursor: (k) => cursors.get(k) ?? null,
    changedPaths: [indexB],
  });
  assert.deepEqual(indexUnits.map((u) => u.key), [fileB]);
  const { values: metaValues } = drain(provider.parse(indexUnits[0], cursors.get(fileB)));
  assert.equal(metaValues.find((v) => v.kind === 'session')?.title, 'Root B Updated Title');

  const retainedCustomRoot = join(home, 'retained-custom-codex');
  const retainedChildId = '019ed000-0000-7000-8000-000000000799';
  writeRollout(retainedCustomRoot, {
    id: retainedChildId,
    filename: `rollout-${retainedChildId}.jsonl`,
    parentThreadId: '019ed000-0000-7000-8000-000000000798',
    userText: 'retained custom child sentinel',
  });
  const retainedParentPath = writeRollout(retainedCustomRoot, {
    id: '019ed000-0000-7000-8000-000000000798',
    userText: 'retained custom parent',
  });
  const rawRetainedChild = provider.raw({
    source: 'codex',
    messageUuid: `codex:${retainedChildId}:000002`,
    agentId: `codex:${retainedChildId}`,
    session: { id: 'codex:019ed000-0000-7000-8000-000000000798', jsonl_path: retainedParentPath },
  });
  assert.match(rawRetainedChild?.text ?? '', /retained custom child sentinel/);

  // Missing empty root with no prior sessions does not fail inventory; existing empty root does not fail either.
  const missingRoot = join(home, 'never-existed');
  const emptyRoot = join(home, 'empty-root');
  mkdirSync(emptyRoot, { recursive: true });
  const issues = [];
  const runtime = createConfiguredBuiltinProviderRuntime({
    providerRoots: { codex: [rootA, emptyRoot, missingRoot] },
  }, { homeDir: home });
  runtime.registry.get('codex').discover({
    lastCursor: (k) => cursors.get(k) ?? null,
    indexedSessions: () => [{ sessionId: `codex:${codexRootScope(rootA, home)}:019ed000-0000-7000-8000-000000000701`, jsonlPath: fileA }],
    reportIncompleteInventory: (issue) => issues.push(issue),
  });
  assert.deepEqual(issues, []);

  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const lockedRoot = join(home, 'locked');
    mkdirSync(join(lockedRoot, 'sessions'), { recursive: true });
    chmodSync(join(lockedRoot, 'sessions'), 0o000);
    try {
      const lockedIssues = [];
      createCodexProvider({ roots: [rootA, lockedRoot], homeDir: home }).discover({
        lastCursor: () => null,
        reportIncompleteInventory: (issue) => lockedIssues.push(issue),
      });
      assert.equal(lockedIssues.length, 1);
      assert.equal(lockedIssues[0].path, join(lockedRoot, 'sessions'));
    } finally {
      chmodSync(join(lockedRoot, 'sessions'), 0o755);
    }
  }
});
