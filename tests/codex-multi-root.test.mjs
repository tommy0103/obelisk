// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import {
  codexRootScope,
  createCodexProvider,
  defaultCodexHome,
} from '../packages/core/src/providers/codex.ts';
import { createConfiguredBuiltinProviderRuntime } from '../packages/core/src/provider-settings.ts';
import { createProviderIndexPlan, indexProviderPlanStrict } from '../packages/core/src/provider-indexing.ts';
import { createProviderRegistry } from '../packages/core/src/providers/registry.ts';
import { assembleSessionDetail } from '../packages/core/src/session-detail.ts';
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
  assert.equal(defaultCodexHome({ env: { CODEX_HOME: '/abs/codex' }, homeDir: home, cwd }), resolve('/abs/codex'));
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
