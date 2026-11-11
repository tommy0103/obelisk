// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Multi-root support for Claude Code:
// When multiple Claude roots exist on disk (such as vendor/internal forks,
// different release channels, or explicit settings), Claude provider discovers
// from all configured roots under the unified `source = 'claude'`.
//
// Non-default roots namespace their session IDs and message UUIDs so that
// identical transcript UUIDs across roots never collide on `messages.uuid`
// or `sessions.id` primary keys in SQLite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createClaudeProvider,
  defaultClaudeSourceRoots,
} from '../packages/core/src/providers/claude.ts';
import { persist } from '../packages/core/src/persist.ts';
import { assembleSessionDetail } from '../packages/core/src/session-detail.ts';
import { makeTempDir } from './temp-dirs.mjs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');

const SLUG = '-tmp-demo-app';
const CWD = '/tmp/demo-app';
const SHARED_SID = '11111111-1111-4111-8111-111111111111';
const FORK_ONLY_SID = '22222222-2222-4222-8222-222222222222';

function writeSession(dir, sessionId, rows) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
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

test('defaultClaudeSourceRoots automatically detects sibling claude fork directories', () => {
  const fakeHome = makeTempDir('obelisk-claude-home-');
  const defaultDir = join(fakeHome, '.claude');
  const vendorDir = join(fakeHome, '.claude-vendor');
  const betaDir = join(fakeHome, '.claude-beta');
  const ignoredDir = join(fakeHome, '.claude-no-projects');
  const unrelatedDir = join(fakeHome, '.config');

  mkdirSync(join(defaultDir, 'projects'), { recursive: true });
  mkdirSync(join(vendorDir, 'projects'), { recursive: true });
  mkdirSync(join(betaDir, 'projects'), { recursive: true });
  mkdirSync(ignoredDir, { recursive: true });
  mkdirSync(unrelatedDir, { recursive: true });

  const roots = defaultClaudeSourceRoots(fakeHome);
  assert.equal(roots.includes(defaultDir), true);
  assert.equal(roots.includes(vendorDir), true);
  assert.equal(roots.includes(betaDir), true);
  assert.equal(roots.includes(ignoredDir), false, 'directory without projects/ is not included');
  assert.equal(roots.includes(unrelatedDir), false, 'unrelated directory is not included');
});

test('claude multi-root: discovers from multiple roots and namespaces non-default sessions', () => {
  const upstreamRoot = makeTempDir('obelisk-claude-upstream-');
  const forkRoot = makeTempDir('obelisk-claude-fork-');
  const emptyRoot = makeTempDir('obelisk-claude-empty-');
  mkdirSync(join(emptyRoot, 'projects'), { recursive: true });

  const sharedRows = [
    { type: 'ai-title', aiTitle: 'Shared session' },
    {
      uuid: 'u-1', parentUuid: null, type: 'user', timestamp: '2026-08-01T10:00:00.000Z', cwd: CWD,
      message: { role: 'user', content: 'why is the build red?' },
    },
    {
      uuid: 'a-1', parentUuid: 'u-1', type: 'assistant', timestamp: '2026-08-01T10:00:05.000Z', cwd: CWD,
      message: { role: 'assistant', model: 'demo-model', content: [{ type: 'text', text: 'Checking the log.' }] },
    },
  ];

  const forkOnlyRows = [
    { type: 'ai-title', aiTitle: 'Fork session' },
    {
      uuid: 'u-2', parentUuid: null, type: 'user', timestamp: '2026-08-02T10:00:00.000Z', cwd: CWD,
      message: { role: 'user', content: 'hello from fork' },
    },
    {
      uuid: 'a-2', parentUuid: 'u-2', type: 'assistant', timestamp: '2026-08-02T10:00:05.000Z', cwd: CWD,
      message: { role: 'assistant', model: 'demo-model', content: [{ type: 'text', text: 'Fork response.' }] },
    },
  ];

  writeSession(join(upstreamRoot, 'projects', SLUG), SHARED_SID, sharedRows);
  writeSession(join(forkRoot, 'projects', SLUG), SHARED_SID, sharedRows); // deliberate identical transcript
  writeSession(join(forkRoot, 'projects', SLUG), FORK_ONLY_SID, forkOnlyRows);

  const provider = createClaudeProvider({
    rootDir: upstreamRoot,
    sourceRoots: [upstreamRoot, forkRoot, emptyRoot],
  });

  const issues = [];
  const units = provider.discover({
    lastCursor: () => null,
    reportIncompleteInventory: (issue) => issues.push(issue),
  });

  assert.equal(issues.length, 0, 'empty root does not cause inventory issue');
  assert.equal(units.length, 3, 'upstream shared + fork shared + fork only = 3 units');

  // Verify session IDs
  const upstreamUnit = units.find((u) => u.key.startsWith(upstreamRoot));
  assert.ok(upstreamUnit);
  assert.equal(upstreamUnit.sessionId, SHARED_SID, 'default root keeps bare session id');

  const forkUnits = units.filter((u) => u.key.startsWith(forkRoot));
  assert.equal(forkUnits.length, 2);
  const forkTag = provider.rootTagFor?.(forkRoot) ?? forkUnits[0].sessionId.split(':')[0];
  assert.ok(forkTag, 'fork root has a root tag');

  for (const unit of forkUnits) {
    assert.match(unit.sessionId, new RegExp(`^${forkTag}:`));
  }
});

test('claude multi-root: the same transcript in two roots does not collide on messages.uuid in SQLite', () => {
  const upstreamRoot = makeTempDir('obelisk-claude-up-');
  const forkRoot = makeTempDir('obelisk-claude-fk-');

  const sharedRows = [
    { type: 'ai-title', aiTitle: 'Shared transcript' },
    {
      uuid: 'u-shared', parentUuid: null, type: 'user', timestamp: '2026-08-01T10:00:00.000Z', cwd: CWD,
      message: { role: 'user', content: 'question in shared transcript' },
    },
    {
      uuid: 'a-shared', parentUuid: 'u-shared', type: 'assistant', timestamp: '2026-08-01T10:00:05.000Z', cwd: CWD,
      message: { role: 'assistant', model: 'demo-model', content: [{ type: 'text', text: 'answer in shared transcript' }] },
    },
  ];

  writeSession(join(upstreamRoot, 'projects', SLUG), SHARED_SID, sharedRows);
  writeSession(join(forkRoot, 'projects', SLUG), SHARED_SID, sharedRows);

  const provider = createClaudeProvider({
    rootDir: upstreamRoot,
    sourceRoots: [upstreamRoot, forkRoot],
  });

  const units = provider.discover({ lastCursor: () => null });
  assert.equal(units.length, 2);

  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);

  for (const unit of units) {
    persist(db, unit, provider.parse(unit, null));
  }

  const sessions = db.prepare('SELECT id, message_count, source FROM sessions ORDER BY id').all();
  assert.equal(sessions.length, 2, 'both sessions exist in SQLite');
  assert.equal(sessions.every((s) => s.source === 'claude'), true, 'both sessions have source = claude');
  assert.equal(sessions[0].message_count, 2);
  assert.equal(sessions[1].message_count, 2);

  // CRITICAL ASSERTION:
  // Before the fix, the second session stole the messages from the first session via
  // ON CONFLICT(uuid) DO UPDATE SET session_id=excluded.session_id, leaving the first
  // session with 0 message rows.
  const messagesForUpstream = db.prepare('SELECT uuid, session_id FROM messages WHERE session_id = ?').all(sessions[0].id);
  const messagesForFork = db.prepare('SELECT uuid, session_id FROM messages WHERE session_id = ?').all(sessions[1].id);

  assert.equal(messagesForUpstream.length, 2, 'upstream session keeps its message rows');
  assert.equal(messagesForFork.length, 2, 'fork session keeps its message rows');

  const allUuids = db.prepare('SELECT uuid FROM messages').all().map((r) => r.uuid);
  assert.equal(new Set(allUuids).size, 4, 'all 4 message rows have distinct global primary keys');
});

test('claude multi-root: raw lookup works for both default and non-default root messages', () => {
  const upstreamRoot = makeTempDir('obelisk-claude-up-raw-');
  const forkRoot = makeTempDir('obelisk-claude-fk-raw-');

  const rows = [
    { type: 'ai-title', aiTitle: 'Lookup test' },
    {
      uuid: 'u-msg-1', parentUuid: null, type: 'user', timestamp: '2026-08-01T10:00:00.000Z', cwd: CWD,
      message: { role: 'user', content: 'lookup this user question' },
    },
    {
      uuid: 'a-msg-1', parentUuid: 'u-msg-1', type: 'assistant', timestamp: '2026-08-01T10:00:05.000Z', cwd: CWD,
      message: { role: 'assistant', model: 'demo-model', content: [{ type: 'text', text: 'lookup this assistant answer' }] },
    },
  ];

  writeSession(join(upstreamRoot, 'projects', SLUG), SHARED_SID, rows);
  writeSession(join(forkRoot, 'projects', SLUG), SHARED_SID, rows);

  const provider = createClaudeProvider({
    rootDir: upstreamRoot,
    sourceRoots: [upstreamRoot, forkRoot],
  });

  const units = provider.discover({ lastCursor: () => null });
  const upUnit = units.find((u) => u.key.startsWith(upstreamRoot));
  const fkUnit = units.find((u) => u.key.startsWith(forkRoot));

  const upRecords = drain(provider.parse(upUnit, null)).values;
  const fkRecords = drain(provider.parse(fkUnit, null)).values;

  const upMsg = upRecords.find((r) => r.kind === 'message');
  const fkMsg = fkRecords.find((r) => r.kind === 'message');

  const upRaw = provider.raw({
    source: 'claude',
    messageUuid: upMsg.uuid,
    session: { id: upUnit.sessionId, jsonl_path: upUnit.key },
    agentId: null,
    cursor: null,
    subagent: null,
    workflowAgent: null,
  });
  assert.ok(upRaw);
  assert.equal(upRaw.messageText, 'lookup this user question');

  const fkRaw = provider.raw({
    source: 'claude',
    messageUuid: fkMsg.uuid,
    session: { id: fkUnit.sessionId, jsonl_path: fkUnit.key },
    agentId: null,
    cursor: null,
    subagent: null,
    workflowAgent: null,
  });
  assert.ok(fkRaw);
  assert.equal(fkRaw.messageText, 'lookup this user question');
});

test('claude multi-root: ADR-0007 canonical transcript roundtrip holds for fork sessions', () => {
  const forkRoot = makeTempDir('obelisk-claude-fk-adr-');
  const rows = [
    { type: 'ai-title', aiTitle: 'Canonical test' },
    {
      uuid: 'u-c1', parentUuid: null, type: 'user', timestamp: '2026-08-01T10:00:00.000Z', cwd: CWD,
      message: { role: 'user', content: 'test canonical contract' },
    },
    {
      uuid: 'a-c1', parentUuid: 'u-c1', type: 'assistant', timestamp: '2026-08-01T10:00:05.000Z', cwd: CWD,
      message: {
        role: 'assistant', model: 'demo-model',
        content: [{ type: 'text', text: 'tool call' }, { type: 'tool_use', id: 'tc-c1', name: 'Bash', input: { command: 'ls' } }],
      },
    },
    {
      uuid: 'u-c2', parentUuid: 'a-c1', type: 'user', timestamp: '2026-08-01T10:00:10.000Z', cwd: CWD,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tc-c1', content: 'output' }] },
    },
  ];
  writeSession(join(forkRoot, 'projects', SLUG), SHARED_SID, rows);

  const provider = createClaudeProvider({
    rootDir: '/placeholder/upstream',
    sourceRoots: ['/placeholder/upstream', forkRoot],
  });

  const unit = provider.discover({ lastCursor: () => null })[0];
  const directDetail = assembleSessionDetail(provider.parse(unit, null));

  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  persist(db, unit, provider.parse(unit, null));

  const sessionRow = db.prepare('SELECT * FROM sessions WHERE id = ?').get(unit.sessionId);
  const messageRows = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp').all(unit.sessionId);
  const toolCallRows = db.prepare('SELECT * FROM tool_calls WHERE session_id = ?').all(unit.sessionId);
  const toolResultRows = db.prepare('SELECT * FROM tool_results WHERE session_id = ?').all(unit.sessionId);

  const persistedDetail = assembleSessionDetail({
    session: sessionRow,
    messages: messageRows,
    toolCalls: toolCallRows,
    toolResults: toolResultRows,
    subagents: [],
    workflows: [],
    summaries: [],
  });

  assert.deepEqual(persistedDetail, directDetail, 'ADR-0007 invariant holds');
});

test('claude multi-root: runtime settings integration auto-discovers or honors explicit root array', () => {
  const fakeHome = makeTempDir('obelisk-claude-runtime-home-');
  const defaultDir = join(fakeHome, '.claude');
  const vendorDir = join(fakeHome, '.claude-vendor');
  mkdirSync(join(defaultDir, 'projects'), { recursive: true });
  mkdirSync(join(vendorDir, 'projects'), { recursive: true });

  const { createConfiguredBuiltinProviderRuntime } = require('../packages/core/src/provider-settings.ts');

  // Case 1: unconfigured -> auto-discovers default + vendor
  const runtimeAuto = createConfiguredBuiltinProviderRuntime({}, { homeDir: fakeHome });
  const claudeAuto = runtimeAuto.registry.get('claude');
  const targetsAuto = claudeAuto.watchTargets(defaultDir).map((t) => t.path);
  assert.equal(targetsAuto.includes(join(defaultDir, 'projects')), true);
  assert.equal(targetsAuto.includes(join(vendorDir, 'projects')), true);

  // Case 2: explicit root array in providerRoots.claude
  const explicitA = makeTempDir('obelisk-claude-exp-a-');
  const explicitB = makeTempDir('obelisk-claude-exp-b-');
  mkdirSync(join(explicitA, 'projects'), { recursive: true });
  mkdirSync(join(explicitB, 'projects'), { recursive: true });

  const runtimeExplicit = createConfiguredBuiltinProviderRuntime({
    providerRoots: { claude: [explicitA, explicitB] },
  }, { homeDir: fakeHome });
  const claudeExplicit = runtimeExplicit.registry.get('claude');
  const targetsExplicit = claudeExplicit.watchTargets(explicitA).map((t) => t.path);
  assert.equal(targetsExplicit.includes(join(explicitA, 'projects')), true);
  assert.equal(targetsExplicit.includes(join(explicitB, 'projects')), true);
  assert.equal(targetsExplicit.includes(join(defaultDir, 'projects')), false);
});

test('claude multi-root: watchTargets covers all configured roots', () => {
  const root1 = '/home/user/.claude';
  const root2 = '/home/user/.claude-vendor';
  const provider = createClaudeProvider({
    rootDir: root1,
    sourceRoots: [root1, root2],
  });

  const targets = provider.watchTargets(root1);
  const paths = targets.map((t) => t.path);
  assert.equal(paths.includes(join(root1, 'projects')), true);
  assert.equal(paths.includes(join(root1, 'history.jsonl')), true);
  assert.equal(paths.includes(join(root2, 'projects')), true);
  assert.equal(paths.includes(join(root2, 'history.jsonl')), true);
});
