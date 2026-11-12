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
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createClaudeProvider,
  defaultClaudeSourceRoots,
  rootTagFor,
  canonicalSessionId,
  bareSessionId,
} from '../packages/core/src/providers/claude.ts';
import { persist } from '../packages/core/src/persist.ts';
import { healWorkflowParentLinks } from '../packages/core/src/indexer.ts';
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

test('claude multi-root: absent default root does not emit incomplete inventory when only fork has indexed sessions', () => {
  const fakeHome = makeTempDir('obelisk-claude-fork-only-');
  const absentDefault = join(fakeHome, '.claude');
  const forkRoot = join(fakeHome, '.claude-vendor');
  const forkSessionPath = join(forkRoot, 'projects', SLUG, `${FORK_ONLY_SID}.jsonl`);
  writeSession(join(forkRoot, 'projects', SLUG), FORK_ONLY_SID, [
    { uuid: 'u1', type: 'user', timestamp: '2026-08-01T10:00:00.000Z', cwd: CWD, message: { role: 'user', content: 'hi' } },
  ]);

  const { createConfiguredBuiltinProviderRuntime } = require('../packages/core/src/provider-settings.ts');
  const runtime = createConfiguredBuiltinProviderRuntime({}, { homeDir: fakeHome });
  assert.equal(runtime.roots.claude, forkRoot, 'existing fork is selected as display root when default is absent');
  const provider = runtime.registry.get('claude');

  // watchTargets called with runtime.roots.claude still watches both roots
  const watched = provider.watchTargets(runtime.roots.claude).map((t) => t.path);
  assert.equal(watched.includes(join(forkRoot, 'projects')), true);
  assert.equal(watched.includes(join(absentDefault, 'projects')), true);

  // Subsequent refresh with prior fork session must NOT report absentDefault as unavailable
  const issues = [];
  const units = provider.discover({
    lastCursor: () => null,
    indexedSessions: () => [{ sessionId: `claude-vendor:${FORK_ONLY_SID}`, jsonlPath: forkSessionPath }],
    reportIncompleteInventory: (issue) => issues.push(issue),
  });
  assert.deepEqual(issues, [], 'absent default root does not report incomplete inventory');
  assert.equal(units.length, 1);
  assert.equal(units[0].sessionId, `claude-vendor:${FORK_ONLY_SID}`);

  // When an absent root previously held an indexed session, it MUST report incomplete inventory
  const missingForkIssues = [];
  const providerWithMissingFork = createClaudeProvider({
    rootDir: absentDefault,
    sourceRoots: [absentDefault, join(fakeHome, '.claude-missing'), forkRoot],
  });
  providerWithMissingFork.discover({
    lastCursor: () => null,
    indexedSessions: () => [{ sessionId: 'claude-missing:s1', jsonlPath: join(fakeHome, '.claude-missing', 'projects', SLUG, 's1.jsonl') }],
    reportIncompleteInventory: (issue) => missingForkIssues.push(issue),
  });
  assert.equal(missingForkIssues.length, 1);
  assert.equal(missingForkIssues[0].path, join(fakeHome, '.claude-missing', 'projects'));
});

test('claude multi-root: defaultClaudeSourceRoots skips backup/archive directories', () => {
  const fakeHome = makeTempDir('obelisk-claude-backups-');
  const defaultDir = join(fakeHome, '.claude');
  const vendorDir = join(fakeHome, '.claude-vendor');
  const backupDir = join(fakeHome, '.claude-backup');
  const bakDir = join(fakeHome, '.claude-bak');
  const oldDir = join(fakeHome, '.claude-old');

  for (const dir of [defaultDir, vendorDir, backupDir, bakDir, oldDir]) {
    mkdirSync(join(dir, 'projects'), { recursive: true });
  }

  const roots = defaultClaudeSourceRoots(fakeHome);
  assert.equal(roots.includes(defaultDir), true);
  assert.equal(roots.includes(vendorDir), true);
  assert.equal(roots.includes(backupDir), false);
  assert.equal(roots.includes(bakDir), false);
  assert.equal(roots.includes(oldDir), false);
});

test('claude multi-root: invalid entry in providerRoots.claude array disables provider instead of silently dropping it', () => {
  const fakeHome = makeTempDir('obelisk-claude-invalid-arr-');
  const validDir = join(fakeHome, '.claude-vendor');
  mkdirSync(join(validDir, 'projects'), { recursive: true });

  const { createConfiguredBuiltinProviderRuntime } = require('../packages/core/src/provider-settings.ts');
  const runtimeMixed = createConfiguredBuiltinProviderRuntime({
    providerRoots: { claude: [validDir, './relative-invalid'] },
  }, { homeDir: fakeHome });
  assert.equal(runtimeMixed.roots.claude, undefined);
  assert.equal(runtimeMixed.registry.get('claude').descriptor.requiresExplicitRoot, true);
  assert.deepEqual(runtimeMixed.registry.get('claude').discover({ lastCursor: () => null }), []);

  const runtimeEmpty = createConfiguredBuiltinProviderRuntime({
    providerRoots: { claude: [] },
  }, { homeDir: fakeHome });
  assert.equal(runtimeEmpty.roots.claude, undefined);
  assert.equal(runtimeEmpty.registry.get('claude').descriptor.requiresExplicitRoot, true);
});

test('claude multi-root: rootTagFor sanitizes colons so bareSessionId never mis-splits', () => {
  const tag = rootTagFor('/tmp/.claude:work', '/tmp/.claude');
  assert.equal(tag.includes(':'), false);
  const sid = canonicalSessionId('abc-123', tag);
  assert.equal(bareSessionId(sid), 'abc-123');
});

test('claude multi-root: rawClaude blocks path traversal via agentId, run_id, and symlinks', () => {
  const root = makeTempDir('obelisk-claude-raw-security-');
  const projectDir = join(root, 'projects', SLUG);
  const subagentsDir = join(projectDir, SHARED_SID, 'subagents');
  const wfDir = join(subagentsDir, 'workflows', 'run-ok');
  mkdirSync(wfDir, { recursive: true });

  const mainPath = join(projectDir, `${SHARED_SID}.jsonl`);
  writeFileSync(mainPath, JSON.stringify({ uuid: 'u1', type: 'user', message: { role: 'user', content: 'hi' } }) + '\n');
  const secretPath = join(root, 'secret.jsonl');
  writeFileSync(secretPath, JSON.stringify({ uuid: 'sec-1', type: 'user', message: { role: 'user', content: 'TOP_SECRET' } }) + '\n');

  const validWfAgent = join(wfDir, 'agent-ok.jsonl');
  writeFileSync(validWfAgent, JSON.stringify({ uuid: 'wf-u1', type: 'user', message: { role: 'user', content: 'wf hello' } }) + '\n');

  const escapedLink = join(subagentsDir, 'escaped-link.jsonl');
  try {
    symlinkSync(secretPath, escapedLink);
  } catch { /* symlink unsupported on platform */ }

  const provider = createClaudeProvider({ rootDir: root });
  const baseLookup = {
    source: 'claude',
    messageUuid: 'sec-1',
    session: { id: SHARED_SID, jsonl_path: mainPath },
    cursor: null,
    subagent: null,
    workflowAgent: null,
  };

  assert.equal(provider.raw({ ...baseLookup, agentId: '../../../secret' }), null, 'agentId traversal blocked');
  assert.equal(provider.raw({ ...baseLookup, agentId: 'sub/../../../secret' }), null, 'slash in agentId blocked');
  assert.equal(provider.raw({
    ...baseLookup,
    agentId: 'agent-ok',
    workflowAgent: { run_id: '../../../../secret' },
  }), null, 'run_id traversal blocked');
  assert.equal(provider.raw({
    ...baseLookup,
    agentId: 'escaped-link',
  }), null, 'symlink outside subagents directory blocked');

  // Legitimate workflow agent with scoped run_id and agent_id works
  const forkProvider = createClaudeProvider({
    rootDir: '/placeholder/default',
    sourceRoots: ['/placeholder/default', root],
  });
  const tag = forkProvider.rootTagFor(root);
  const scopedSid = canonicalSessionId(SHARED_SID, tag);
  const wfRaw = forkProvider.raw({
    source: 'claude',
    messageUuid: `${scopedSid}:wf-u1`,
    session: { id: scopedSid, jsonl_path: mainPath },
    agentId: `${scopedSid}:agent-ok`,
    cursor: null,
    subagent: null,
    workflowAgent: { run_id: `${scopedSid}:run-ok` },
  });
  assert.ok(wfRaw);
  assert.equal(wfRaw.messageText, 'wf hello');
});

test('claude multi-root: workflows, workflow_agents, subagents, tools, and summaries do not collide across roots and heal parent links', () => {
  const upstreamRoot = makeTempDir('obelisk-claude-wf-up-');
  const forkRoot = makeTempDir('obelisk-claude-wf-fk-');

  const populateRoot = (rootDir, label) => {
    const projectDir = join(rootDir, 'projects', SLUG);
    const sessionDir = join(projectDir, SHARED_SID);
    const subDir = join(sessionDir, 'subagents');
    const wfDir = join(sessionDir, 'workflows');
    mkdirSync(subDir, { recursive: true });
    mkdirSync(wfDir, { recursive: true });

    // Main transcript initially omits tool_result so healWorkflowParentLinks runs later
    const mainPath = join(projectDir, `${SHARED_SID}.jsonl`);
    writeFileSync(mainPath, [
      { uuid: 'u1', type: 'user', timestamp: '2026-08-01T10:00:00Z', cwd: CWD, message: { role: 'user', content: `start ${label}` } },
      {
        uuid: 'a1', type: 'assistant', timestamp: '2026-08-01T10:00:05Z', cwd: CWD,
        message: {
          role: 'assistant', model: 'demo',
          content: [{ type: 'tool_use', id: 'wf-call-1', name: 'Workflow', input: {} }],
        },
      },
      { type: 'system', subtype: 'away_summary', uuid: 'sum-1', timestamp: '2026-08-01T10:00:06Z', content: `summary ${label}` },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');

    writeFileSync(join(wfDir, 'run-shared.json'), JSON.stringify({
      runId: 'run-shared',
      workflowName: `wf-${label}`,
      status: 'completed',
      timestamp: '2026-08-01T10:00:07Z',
      workflowProgress: [{ type: 'workflow_agent', agentId: 'wa1', label: `worker-${label}` }],
    }));

    writeFileSync(join(subDir, 'agent-sub1.jsonl'), [
      { uuid: 'su1', type: 'user', timestamp: '2026-08-01T10:00:08Z', cwd: CWD, isSidechain: true, agentId: 'agent-sub1', message: { role: 'user', content: `sub ${label}` } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    writeFileSync(join(subDir, 'agent-sub1.meta.json'), JSON.stringify({
      toolUseId: 'wf-call-1',
      agentType: 'Explore',
      description: `desc ${label}`,
    }));

    return mainPath;
  };

  const upMain = populateRoot(upstreamRoot, 'upstream');
  const fkMain = populateRoot(forkRoot, 'fork');

  const provider = createClaudeProvider({
    rootDir: upstreamRoot,
    sourceRoots: [upstreamRoot, forkRoot],
  });

  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  for (const unit of provider.discover({ lastCursor: () => null })) {
    persist(db, unit, provider.parse(unit, null));
  }

  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM workflows').get().c, 2, 'both workflows kept without collision');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM workflow_agents').get().c, 2, 'both workflow_agents kept');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM subagents').get().c, 2, 'both subagents kept');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM summaries').get().c, 2, 'both summaries kept');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM tool_calls').get().c, 2, 'both tool_calls kept');

  // Now append tool_result containing bare run-shared to BOTH main transcripts and verify healWorkflowParentLinks heals BOTH
  for (const mainPath of [upMain, fkMain]) {
    const existing = readFileSync(mainPath, 'utf8');
    writeFileSync(mainPath, existing + JSON.stringify({
      uuid: 'u2', type: 'user', timestamp: '2026-08-01T10:00:10Z', cwd: CWD,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'wf-call-1', content: 'Run ID: run-shared done' }] },
    }) + '\n');
  }

  const cursors = new Map();
  // Incremental update: parse only the modified main transcripts
  for (const unit of provider.discover({ lastCursor: (k) => cursors.get(k) ?? null })) {
    if (unit.key === upMain || unit.key === fkMain) {
      persist(db, unit, provider.parse(unit, null));
    }
  }
  healWorkflowParentLinks(db);

  const workflows = db.prepare('SELECT run_id, session_id, parent_tool_use_id FROM workflows ORDER BY session_id').all();
  assert.equal(workflows.length, 2);
  for (const wf of workflows) {
    assert.ok(wf.parent_tool_use_id, `workflow ${wf.run_id} parent_tool_use_id healed`);
    const call = db.prepare('SELECT id, session_id FROM tool_calls WHERE id = ?').get(wf.parent_tool_use_id);
    assert.equal(call.session_id, wf.session_id, 'healed parent_tool_use_id belongs to the same session');
  }
});

test('claude multi-root: Windows-style drive paths match case-insensitively during missing-root detection', () => {
  const existingRoot = makeTempDir('obelisk-claude-win-other-');
  mkdirSync(join(existingRoot, 'projects'), { recursive: true });
  const winDefault = 'C:\\Users\\Demo\\.claude';
  const winFork = 'C:\\Users\\Demo\\.claude-vendor';
  const provider = createClaudeProvider({
    rootDir: existingRoot,
    sourceRoots: [existingRoot, winDefault, winFork],
  });

  const issues = [];
  provider.discover({
    lastCursor: () => null,
    indexedSessions: () => [{
      sessionId: `claude-vendor:${FORK_ONLY_SID}`,
      jsonlPath: 'c:/users/demo/.claude-vendor/projects/slug/session.jsonl',
    }],
    reportIncompleteInventory: (issue) => issues.push(issue),
  });
  assert.equal(issues.length, 1, 'only the Windows fork root that had prior sessions is reported');
  assert.equal(issues[0].path, join(winFork, 'projects'));
});

test('claude multi-root: symlinked roots do not emit false missing-inventory reports', () => {
  const fakeHome = makeTempDir('obelisk-claude-symlink-');
  const realVendor = join(fakeHome, 'real-vendor');
  const linkVendor = join(fakeHome, '.claude-vendor');
  writeSession(join(realVendor, 'projects', SLUG), FORK_ONLY_SID, [
    { uuid: 'u-sym', type: 'user', timestamp: '2026-08-01T10:00:00.000Z', cwd: CWD, message: { role: 'user', content: 'via symlink' } },
  ]);
  symlinkSync(realVendor, linkVendor);

  const provider = createClaudeProvider({
    rootDir: join(fakeHome, '.claude'),
    sourceRoots: [join(fakeHome, '.claude'), linkVendor],
  });

  const issues = [];
  // Even if indexed session stored the realpath instead of symlink path, pathInside recognizes containment
  provider.discover({
    lastCursor: () => null,
    indexedSessions: () => [{ sessionId: `claude-vendor:${FORK_ONLY_SID}`, jsonlPath: join(realVendor, 'projects', SLUG, `${FORK_ONLY_SID}.jsonl`) }],
    reportIncompleteInventory: (issue) => issues.push(issue),
  });
  assert.deepEqual(issues, []);
});


