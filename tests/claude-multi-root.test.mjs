// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Explicit multi-root support for Claude Code (`providerRoots.claude`):
// - Unconfigured -> default `~/.claude` only (no directory-name sibling discovery).
// - String -> single-root override.
// - Non-empty validated array -> complete configured root set (does not implicitly append `~/.claude`).
// - Persisted identities depend solely on each root's own canonical path and the fixed defaultRoot,
//   never on the rest of the root list or array ordering.
// - Pre-v7 custom single-root bare IDs migrate atomically to deterministic v7 identities.
// - Unavailable configured roots fail closed on destructive rebuild; empty roots and deliberately
//   excluded roots follow explicit retention semantics.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createClaudeProvider,
  CLAUDE_CANONICAL_TRANSCRIPT_MARKER,
  rootTagFor,
  canonicalSessionId,
  bareSessionId,
} from '../packages/core/src/providers/claude.ts';
import { createConfiguredBuiltinProviderRuntime } from '../packages/core/src/provider-settings.ts';
import { assembleSessionDetail } from '../packages/core/src/session-detail.ts';
import { runCli } from './cli-test-helpers.mjs';
import { makeTempDir } from './temp-dirs.mjs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');

// Real Claude Code 2.1.260 output fixture (verbatim capture).
const REAL_FIXTURE_PATH = new URL('./fixtures/claude/custom-title-session.jsonl', import.meta.url);
const REAL_FIXTURE_TEXT = readFileSync(REAL_FIXTURE_PATH, 'utf8');
const REAL_FIXTURE_RECORDS = REAL_FIXTURE_TEXT.trim().split('\n').map((line) => JSON.parse(line));
const REAL_FIXTURE_USER = REAL_FIXTURE_RECORDS.find((r) => r.type === 'user');
const REAL_SID = REAL_FIXTURE_USER.sessionId;
const REAL_CWD = REAL_FIXTURE_USER.cwd;
const REAL_SLUG = '-private-tmp-obelisk-title-capture';

function copyRealFixture(rootDir, { project = REAL_SLUG, sessionId = REAL_SID } = {}) {
  const dir = join(rootDir, 'projects', project);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${sessionId}.jsonl`);
  writeFileSync(filePath, REAL_FIXTURE_TEXT);
  return filePath;
}

function appendUserTurn(filePath, { uuid, parentUuid, text, timestamp = '2026-09-14T18:05:00.000Z' }) {
  appendFileSync(filePath, JSON.stringify({
    ...REAL_FIXTURE_USER,
    uuid,
    parentUuid,
    timestamp,
    message: { role: 'user', content: text },
  }) + '\n');
}

function writeSettings(homeDir, settings) {
  const obeliskDir = join(homeDir, '.obelisk');
  mkdirSync(obeliskDir, { recursive: true });
  writeFileSync(join(obeliskDir, 'settings.json'), JSON.stringify(settings, null, 2));
}

test('claude explicit roots: unconfigured ignores sibling directories and array replaces default root', () => {
  const fakeHome = makeTempDir('obelisk-claude-explicit-');
  const defaultDir = join(fakeHome, '.claude');
  const siblingDir = join(fakeHome, '.claude-vendor');
  const customA = join(fakeHome, 'profiles', 'work');
  const customB = join(fakeHome, 'profiles', 'personal');
  for (const dir of [defaultDir, siblingDir, customA, customB]) {
    mkdirSync(join(dir, 'projects'), { recursive: true });
  }

  // Unconfigured: only default `~/.claude` is active (no automatic `.claude-*` sibling discovery).
  const unconfigured = createConfiguredBuiltinProviderRuntime({}, { homeDir: fakeHome });
  const unconfiguredTargets = unconfigured.registry.watchTargets(unconfigured.roots).map((t) => t.path);
  assert.equal(unconfiguredTargets.includes(join(defaultDir, 'projects')), true);
  assert.equal(unconfiguredTargets.includes(join(siblingDir, 'projects')), false);

  // String override: replaces default root.
  const single = createConfiguredBuiltinProviderRuntime({
    providerRoots: { claude: '~/profiles/work' },
  }, { homeDir: fakeHome });
  const singleTargets = single.registry.watchTargets(single.roots).map((t) => t.path);
  assert.equal(singleTargets.includes(join(customA, 'projects')), true);
  assert.equal(singleTargets.includes(join(defaultDir, 'projects')), false);

  // Explicit array: complete set of roots (does not implicitly append `~/.claude`).
  const multi = createConfiguredBuiltinProviderRuntime({
    providerRoots: { claude: ['~/profiles/work', '~/profiles/personal'] },
  }, { homeDir: fakeHome });
  const multiTargets = multi.registry.watchTargets(multi.roots).map((t) => t.path);
  assert.equal(multiTargets.includes(join(customA, 'projects')), true);
  assert.equal(multiTargets.includes(join(customA, 'history.jsonl')), true);
  assert.equal(multiTargets.includes(join(customB, 'projects')), true);
  assert.equal(multiTargets.includes(join(customB, 'history.jsonl')), true);
  assert.equal(multiTargets.includes(join(defaultDir, 'projects')), false);
});

test('claude explicit roots: invalid providerRoots.claude disables provider instead of falling back', () => {
  const fakeHome = makeTempDir('obelisk-claude-invalid-');
  const validDir = join(fakeHome, 'profiles', 'work');
  mkdirSync(join(validDir, 'projects'), { recursive: true });

  const mixed = createConfiguredBuiltinProviderRuntime({
    providerRoots: { claude: [validDir, './relative-invalid'] },
  }, { homeDir: fakeHome });
  assert.equal(mixed.roots.claude, undefined);
  assert.equal(mixed.registry.get('claude').descriptor.requiresExplicitRoot, true);
  assert.deepEqual(mixed.registry.get('claude').watchTargets(validDir), []);

  const empty = createConfiguredBuiltinProviderRuntime({
    providerRoots: { claude: [] },
  }, { homeDir: fakeHome });
  assert.equal(empty.roots.claude, undefined);
  assert.equal(empty.registry.get('claude').descriptor.requiresExplicitRoot, true);
  assert.match(empty.registry.get('claude').descriptor.rootResolutionReason, /must not be empty/);
});

test('claude explicit roots: persisted identities stay unchanged when adding, removing, or reordering roots (even with identical basenames)', () => {
  const home = makeTempDir('obelisk-claude-id-stable-');
  const rootA = join(home, 'a', 'store');
  const rootB = join(home, 'b', 'store'); // identical basename `store`
  const fileA = copyRealFixture(rootA);

  // 1. Index `[rootA]` alone via CLI build
  writeSettings(home, { providerRoots: { claude: [rootA] } });
  const first = runCli(['--build'], { home });
  assert.equal(first.status, 0, first.stderr + first.stdout);

  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
  let db = new DatabaseSync(dbPath, { readOnly: true });
  const initialSessions = db.prepare("SELECT id, message_count FROM sessions WHERE source = 'claude'").all();
  const initialMsgs = db.prepare("SELECT uuid, session_id FROM messages WHERE source = 'claude'").all();
  assert.equal(initialSessions.length, 1);
  assert.equal(initialMsgs.length, 1);
  const originalSessionId = initialSessions[0].id;
  const originalMsgUuid = initialMsgs[0].uuid;
  assert.match(originalSessionId, new RegExp(`^store-[0-9a-f]{6}:${REAL_SID}$`));
  db.close();

  // 2. Add `rootB` (same basename `store`) AND reorder to `[rootB, rootA]`, then append to `fileA`
  copyRealFixture(rootB);
  appendUserTurn(fileA, {
    uuid: 'follow-up-u2',
    parentUuid: REAL_FIXTURE_USER.uuid,
    text: 'appended after adding same-basename root',
  });
  writeSettings(home, { providerRoots: { claude: [rootB, rootA] } });

  const queryScript = join(home, 'q.mjs');
  writeFileSync(queryScript, 'return sessions();');
  const incremental = runCli(['--query', queryScript], { home });
  assert.equal(incremental.status, 0, incremental.stderr + incremental.stdout);

  db = new DatabaseSync(dbPath, { readOnly: true });
  const afterAddSessions = db.prepare("SELECT id, message_count, jsonl_path FROM sessions WHERE source = 'claude' ORDER BY jsonl_path").all();
  assert.equal(afterAddSessions.length, 2, 'exactly one session per root — no split history');
  const sessionA = afterAddSessions.find((s) => s.jsonl_path === fileA);
  assert.equal(sessionA.id, originalSessionId, 'session ID for rootA stayed identical after adding rootB and reordering');
  assert.equal(sessionA.message_count, 2, 'appended message landed in the same session');

  const msgsA = db.prepare('SELECT uuid FROM messages WHERE session_id = ? ORDER BY timestamp').all(originalSessionId);
  assert.equal(msgsA.length, 2);
  assert.equal(msgsA[0].uuid, originalMsgUuid);

  const sessionB = afterAddSessions.find((s) => s.jsonl_path !== fileA);
  assert.notEqual(sessionB.id, sessionA.id);
  assert.equal(sessionB.message_count, 1);
  db.close();

  // 3. Trailing slash in config yields identical tag
  assert.equal(rootTagFor(`${rootA}/`, join(home, '.claude')), rootTagFor(rootA, join(home, '.claude')));
});

test('claude explicit roots: copied real fixture across roots isolates messages, tools, subagents, workflows, summaries, raw lookup, and ADR-0007', () => {
  const home = makeTempDir('obelisk-claude-isolation-');
  const defaultRoot = join(home, '.claude');
  const workRoot = join(home, 'profiles', 'work');

  const populateWithCopy = (rootDir, label) => {
    const mainPath = copyRealFixture(rootDir);
    const projectDir = join(rootDir, 'projects', REAL_SLUG);
    const sessionDir = join(projectDir, REAL_SID);
    const subDir = join(sessionDir, 'subagents');
    const wfDir = join(sessionDir, 'workflows');
    mkdirSync(subDir, { recursive: true });
    mkdirSync(wfDir, { recursive: true });

    appendFileSync(mainPath, [
      {
        uuid: 'a-wf-1', parentUuid: REAL_FIXTURE_USER.uuid, type: 'assistant', timestamp: '2026-09-14T18:01:00.000Z', cwd: REAL_CWD,
        message: { role: 'assistant', model: 'claude-opus', content: [{ type: 'tool_use', id: 'wf-call-1', name: 'Workflow', input: {} }] },
      },
      { type: 'system', subtype: 'away_summary', uuid: 'sum-1', timestamp: '2026-09-14T18:01:02.000Z', content: `summary ${label}` },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');

    writeFileSync(join(wfDir, 'run-shared.json'), JSON.stringify({
      runId: 'run-shared',
      workflowName: `wf-${label}`,
      status: 'completed',
      timestamp: '2026-09-14T18:01:03.000Z',
      workflowProgress: [{ type: 'workflow_agent', agentId: 'wa1', label: `worker-${label}` }],
    }));

    writeFileSync(join(subDir, 'agent-sub1.jsonl'), JSON.stringify({
      ...REAL_FIXTURE_USER,
      uuid: 'su-1',
      isSidechain: true,
      agentId: 'agent-sub1',
      message: { role: 'user', content: `sub ${label}` },
    }) + '\n');
    writeFileSync(join(subDir, 'agent-sub1.meta.json'), JSON.stringify({
      toolUseId: 'wf-call-1',
      agentType: 'Explore',
      description: `desc ${label}`,
    }));
    return mainPath;
  };

  const defaultMain = populateWithCopy(defaultRoot, 'default');
  const workMain = populateWithCopy(workRoot, 'work');

  writeSettings(home, { providerRoots: { claude: [defaultRoot, workRoot] } });
  const first = runCli(['--build'], { home });
  assert.equal(first.status, 0, first.stderr + first.stdout);

  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
  let db = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM sessions WHERE source='claude'").get().c, 2);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM messages').get().c, 6);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM tool_calls').get().c, 2);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM subagents').get().c, 2);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM workflows').get().c, 2);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM workflow_agents').get().c, 2);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM summaries').get().c, 2);
  db.close();

  // Now append tool_result containing bare `run-shared` to BOTH main transcripts; CLI passive refresh heals both without rawRunIdExpr in shared SQL.
  for (const mainPath of [defaultMain, workMain]) {
    appendFileSync(mainPath, JSON.stringify({
      ...REAL_FIXTURE_USER,
      uuid: 'u-wf-result',
      parentUuid: 'a-wf-1',
      timestamp: '2026-09-14T18:02:00.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'wf-call-1', content: 'Run ID: run-shared done' }] },
    }) + '\n');
  }
  const qPath = join(home, 'q.mjs');
  writeFileSync(qPath, 'return sessions();');
  const second = runCli(['--query', qPath], { home });
  assert.equal(second.status, 0, second.stderr + second.stdout);

  db = new DatabaseSync(dbPath, { readOnly: true });
  const workflows = db.prepare('SELECT run_id, session_id, parent_tool_use_id FROM workflows ORDER BY session_id').all();
  assert.equal(workflows.length, 2);
  for (const wf of workflows) {
    assert.ok(wf.parent_tool_use_id, `workflow ${wf.run_id} healed parent_tool_use_id on CLI refresh`);
    const call = db.prepare('SELECT id, session_id FROM tool_calls WHERE id = ?').get(wf.parent_tool_use_id);
    assert.equal(call.session_id, wf.session_id);
  }

  // Raw lookup and ADR-0007 canonical round-trip invariant hold for both default and non-default roots.
  const provider = createClaudeProvider({ rootDir: defaultRoot, sourceRoots: [defaultRoot, workRoot] });
  const units = provider.discover({ lastCursor: () => null });
  for (const unit of units.filter((u) => !u.isSubagent && u.meta?.kind !== 'workflow')) {
    const sessionRecords = units
      .filter((u) => u.sessionId === unit.sessionId)
      .flatMap((u) => [...provider.parse(u, null)]);
    const directDetail = assembleSessionDetail(sessionRecords);
    const sessionRow = db.prepare('SELECT * FROM sessions WHERE id = ?').get(unit.sessionId);
    const wfRows = db.prepare('SELECT * FROM workflows WHERE session_id = ?').all(unit.sessionId);
    for (const row of wfRows) row.agents = db.prepare('SELECT * FROM workflow_agents WHERE run_id = ?').all(row.run_id);
    const persistedDetail = assembleSessionDetail({
      session: sessionRow,
      messages: db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp, uuid').all(unit.sessionId),
      toolCalls: db.prepare('SELECT * FROM tool_calls WHERE session_id = ?').all(unit.sessionId),
      toolResults: db.prepare('SELECT * FROM tool_results WHERE session_id = ?').all(unit.sessionId),
      subagents: db.prepare('SELECT * FROM subagents WHERE session_id = ?').all(unit.sessionId),
      workflows: wfRows,
      summaries: db.prepare('SELECT * FROM summaries WHERE session_id = ?').all(unit.sessionId),
    });
    assert.deepEqual(persistedDetail, directDetail, `ADR-0007 invariant holds for ${unit.sessionId}`);

    const firstMsg = persistedDetail.messages[0];
    const raw = provider.raw({
      source: 'claude',
      messageUuid: firstMsg.uuid,
      session: { id: sessionRow.id, jsonl_path: sessionRow.jsonl_path },
      agentId: null,
      cursor: null,
      subagent: null,
      workflowAgent: null,
    });
    assert.ok(raw);
    assert.equal(raw.messageText, REAL_FIXTURE_USER.message.content);
  }
  db.close();
});

test('claude migration: custom single-root pre-v7 bare IDs migrate atomically (including memories and orphan history) when upgrading to explicit array', async () => {
  for (const mode of ['incremental-refresh', 'force-build']) {
    const home = makeTempDir(`obelisk-claude-migrate-${mode}-`);
    const customA = join(home, 'profiles', 'work');
    const customB = join(home, 'profiles', 'second');
    const mainA = copyRealFixture(customA);

    // Seed an orphan session in customA as well (main deleted, subagent survives).
    const orphanSid = '99999999-9999-4999-8999-999999999999';
    const orphanMainPath = join(customA, 'projects', REAL_SLUG, `${orphanSid}.jsonl`);
    const orphanSubDir = join(customA, 'projects', REAL_SLUG, orphanSid, 'subagents');
    mkdirSync(orphanSubDir, { recursive: true });
    writeFileSync(join(orphanSubDir, 'agent-o1.jsonl'), JSON.stringify({
      ...REAL_FIXTURE_USER,
      uuid: 'orphan-child-u1',
      sessionId: orphanSid,
      isSidechain: true,
      agentId: 'agent-o1',
      message: { role: 'user', content: 'surviving orphan child' },
    }) + '\n');

    // Construct a realistic pre-v7 SQLite DB where custom single-root used bare IDs.
    const obeliskDir = join(home, '.obelisk');
    mkdirSync(obeliskDir, { recursive: true });
    const dbPath = join(obeliskDir, 'obelisk.sqlite');
    const seedDb = new DatabaseSync(dbPath);
    seedDb.exec(SCHEMA);
    seedDb.prepare(`
      INSERT INTO sessions (id, title, project, started_at, ended_at, message_count, jsonl_path, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'claude')
    `).run(REAL_SID, 'obelisk fixture capture', REAL_SLUG, REAL_FIXTURE_USER.timestamp, REAL_FIXTURE_USER.timestamp, 1, mainA);
    seedDb.prepare(`
      INSERT INTO messages (uuid, session_id, type, timestamp, role, text, content_type, is_meta, visibility, is_sidechain, source)
      VALUES (?, ?, 'user', ?, 'user', ?, 'text', 0, 'visible', 0, 'claude')
    `).run(REAL_FIXTURE_USER.uuid, REAL_SID, REAL_FIXTURE_USER.timestamp, REAL_FIXTURE_USER.message.content);
    seedDb.prepare(`
      INSERT INTO memories (id, session_id, project, path, summary, created_at)
      VALUES ('mem-1', ?, ?, 'notes/work.md', 'remember custom root work', '2026-09-14T18:10:00.000Z')
    `).run(REAL_SID, REAL_SLUG);
    seedDb.prepare(`
      INSERT INTO sessions (id, title, project, started_at, ended_at, message_count, jsonl_path, source)
      VALUES (?, 'Orphan cached title', ?, '2026-09-14T17:00:00.000Z', '2026-09-14T17:05:00.000Z', 2, ?, 'claude')
    `).run(orphanSid, REAL_SLUG, orphanMainPath);
    seedDb.prepare(`
      INSERT INTO messages (uuid, session_id, type, timestamp, role, text, content_type, is_meta, visibility, is_sidechain, source)
      VALUES ('orphan-cached-main', ?, 'user', '2026-09-14T17:00:00.000Z', 'user', 'cachedmainhistoryneedle', 'text', 0, 'visible', 0, 'claude')
    `).run(orphanSid);
    seedDb.prepare("INSERT INTO index_state (jsonl_path, mtime, lines_processed) VALUES ('__claude_canonical_transcript_v6__', 1, 0)").run();
    seedDb.prepare('INSERT INTO index_state (jsonl_path, mtime, lines_processed, cursor) VALUES (?, 1, 4, ?)')
      .run(mainA, '1:4:1:1:1');
    seedDb.close();

    // Add second root containing a verbatim copy of the same real fixture.
    copyRealFixture(customB);
    writeSettings(home, { providerRoots: { claude: [customA, customB] } });

    if (mode === 'force-build') {
      const res = runCli(['--build'], { home });
      assert.equal(res.status, 0, res.stderr + res.stdout);
    } else {
      const qPath = join(home, 'q.mjs');
      writeFileSync(qPath, 'return sessions();');
      const res = runCli(['--query', qPath], { home });
      assert.equal(res.status, 0, res.stderr + res.stdout);
    }

    const expectedTagA = rootTagFor(customA, join(home, '.claude'));
    const expectedTagB = rootTagFor(customB, join(home, '.claude'));
    const expectedSidA = canonicalSessionId(REAL_SID, expectedTagA);
    const expectedSidB = canonicalSessionId(REAL_SID, expectedTagB);
    const expectedOrphanSid = canonicalSessionId(orphanSid, expectedTagA);

    const db = new DatabaseSync(dbPath);
    const sessionIds = db.prepare("SELECT id FROM sessions WHERE source='claude' ORDER BY id").all().map((r) => r.id);
    assert.deepEqual(sessionIds, [expectedOrphanSid, expectedSidA, expectedSidB].sort(), `${mode}: zero legacy bare sessions remain`);
    assert.equal(db.prepare('SELECT session_id FROM memories WHERE id = ?').get('mem-1').session_id, expectedSidA, `${mode}: memories reconciled`);

    // Orphan cached main message survived migration and child was merged onto the migrated session.
    const orphanMsgs = db.prepare('SELECT uuid, text FROM messages WHERE session_id = ? ORDER BY uuid').all(expectedOrphanSid);
    assert.equal(orphanMsgs.length, 2, `${mode}: cached main + surviving child preserved`);
    assert.ok(orphanMsgs.some((m) => m.text === 'cachedmainhistoryneedle'));
    assert.ok(orphanMsgs.some((m) => m.text === 'surviving orphan child'));
    assert.equal(db.prepare('SELECT message_count FROM sessions WHERE id = ?').get(expectedOrphanSid).message_count, 2);

    // FTS integrity check passes after migration.
    db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1)");
    assert.ok(db.prepare("SELECT uuid FROM messages_fts WHERE messages_fts MATCH 'cachedmainhistoryneedle'").get());
    assert.ok(db.prepare('SELECT 1 FROM index_state WHERE jsonl_path = ?').get(CLAUDE_CANONICAL_TRANSCRIPT_MARKER));
    db.close();
  }
});

test('claude migration: default root upgrading to explicit array keeps bare IDs intact', () => {
  const home = makeTempDir('obelisk-claude-default-upgrade-');
  const defaultRoot = join(home, '.claude');
  const extraRoot = join(home, 'extra');
  copyRealFixture(defaultRoot);

  // Initial default-only build
  let res = runCli(['--build'], { home });
  assert.equal(res.status, 0, res.stderr + res.stdout);

  // Add second root in explicit array `[defaultRoot, extraRoot]`
  copyRealFixture(extraRoot);
  writeSettings(home, { providerRoots: { claude: [defaultRoot, extraRoot] } });
  const qPath = join(home, 'q.mjs');
  writeFileSync(qPath, 'return sessions();');
  res = runCli(['--query', qPath], { home });
  assert.equal(res.status, 0, res.stderr + res.stdout);

  const db = new DatabaseSync(join(home, '.obelisk', 'obelisk.sqlite'), { readOnly: true });
  const ids = db.prepare("SELECT id FROM sessions WHERE source='claude' ORDER BY id").all().map((r) => r.id);
  assert.deepEqual(ids, [canonicalSessionId(REAL_SID, rootTagFor(extraRoot, defaultRoot)), REAL_SID].sort());
  db.close();
});

test('claude explicit roots: separates unavailable configured roots from empty roots and deliberately excluded roots', () => {
  const home = makeTempDir('obelisk-claude-root-states-');
  const rootA = join(home, 'roots', 'alpha');
  const rootB = join(home, 'roots', 'beta');
  const emptyRoot = join(home, 'roots', 'empty-existing');
  mkdirSync(emptyRoot, { recursive: true }); // exists on disk without `projects/` yet
  copyRealFixture(rootA);
  copyRealFixture(rootB);

  // 1. Index `[rootA, rootB]`
  writeSettings(home, { providerRoots: { claude: [rootA, rootB] } });
  let res = runCli(['--build'], { home });
  assert.equal(res.status, 0, res.stderr + res.stdout);

  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
  const countClaude = () => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { return db.prepare("SELECT COUNT(*) c FROM sessions WHERE source='claude'").get().c; }
    finally { db.close(); }
  };
  assert.equal(countClaude(), 2);

  // 2. Deliberately exclude `rootB` -> ordinary refresh retains `rootB` cached history.
  writeSettings(home, { providerRoots: { claude: [rootA] } });
  const qPath = join(home, 'q.mjs');
  writeFileSync(qPath, 'return sessions();');
  res = runCli(['--query', qPath], { home });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.equal(countClaude(), 2, 'ordinary refresh retains cached history for deliberately removed root');

  // 3. Deliberate full rebuild publishes only `[rootA]` (drops `rootB`).
  res = runCli(['--build'], { home });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.equal(countClaude(), 1, 'force rebuild publishes only explicitly selected roots');

  // 4. Switching from `[rootA]` (has prior indexed session) to `[emptyRoot]` (existing empty root, no prior sessions)
  //    must NOT confuse `emptyRoot` with a failed scan.
  writeSettings(home, { providerRoots: { claude: [emptyRoot] } });
  res = runCli(['--build'], { home });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.equal(countClaude(), 0, 'empty configured root completes full rebuild without incomplete-inventory error');

  // 5. Unavailable configured root that WAS previously indexed aborts destructive rebuild.
  writeSettings(home, { providerRoots: { claude: [rootA] } });
  res = runCli(['--build'], { home });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.equal(countClaude(), 1);

  // Temporarily rename rootA so configured root with prior sessions is unavailable.
  const movedRootA = join(home, 'roots', 'alpha-moved');
  const { renameSync } = require('node:fs');
  renameSync(rootA, movedRootA);
  res = runCli(['--build'], { home });
  assert.notEqual(res.status, 0, 'force rebuild fails closed when configured previously-indexed root is missing');
  assert.equal(countClaude(), 1, 'cached session retained when force rebuild aborts');

  // Restore and check unreadable `projects/` (POSIX only).
  renameSync(movedRootA, rootA);
  if (process.platform !== 'win32') {
    chmodSync(join(rootA, 'projects'), 0o000);
    try {
      res = runCli(['--build'], { home });
      assert.notEqual(res.status, 0, 'force rebuild fails closed when configured root projects/ is unreadable');
      assert.equal(countClaude(), 1);
    } finally {
      chmodSync(join(rootA, 'projects'), 0o755);
    }
  }
});

test('claude explicit roots: incremental indexing matches a clean full rebuild', async () => {
  const incHome = makeTempDir('obelisk-claude-parity-inc-');
  const cleanHome = makeTempDir('obelisk-claude-parity-clean-');

  const setupRoots = (home) => {
    const r1 = join(home, 'r1');
    const r2 = join(home, 'r2');
    const f1 = copyRealFixture(r1);
    const f2 = copyRealFixture(r2);
    return { r1, r2, f1, f2 };
  };

  const inc = setupRoots(incHome);
  writeSettings(incHome, { providerRoots: { claude: [inc.r1] } });
  assert.equal(runCli(['--build'], { home: incHome }).status, 0);

  // Incrementally add r2 and append to r1.
  appendUserTurn(inc.f1, { uuid: 'u-inc-2', parentUuid: REAL_FIXTURE_USER.uuid, text: 'incremental turn' });
  writeSettings(incHome, { providerRoots: { claude: [inc.r1, inc.r2] } });
  const qPath = join(incHome, 'q.mjs');
  writeFileSync(qPath, 'return sessions();');
  assert.equal(runCli(['--query', qPath], { home: incHome }).status, 0);

  // Mirror exact same final files into cleanHome and run a single clean `--build`.
  const clean = setupRoots(cleanHome);
  appendUserTurn(clean.f1, { uuid: 'u-inc-2', parentUuid: REAL_FIXTURE_USER.uuid, text: 'incremental turn' });
  writeSettings(cleanHome, { providerRoots: { claude: [clean.r1, clean.r2] } });
  assert.equal(runCli(['--build'], { home: cleanHome }).status, 0);

  const normalizeRows = (home, roots) => {
    const db = new DatabaseSync(join(home, '.obelisk', 'obelisk.sqlite'), { readOnly: true });
    try {
      const stripHome = (s) => s.replace(roots.r1, '<R1>').replace(roots.r2, '<R2>');
      const sessions = db.prepare("SELECT project, message_count, title, started_at, ended_at, jsonl_path FROM sessions WHERE source='claude' ORDER BY jsonl_path")
        .all().map((r) => ({ ...r, jsonl_path: stripHome(r.jsonl_path) }));
      const messages = db.prepare("SELECT role, text, timestamp, cwd FROM messages WHERE source='claude' ORDER BY timestamp, text")
        .all();
      return { sessions, messages };
    } finally {
      db.close();
    }
  };
  assert.deepEqual(normalizeRows(incHome, inc), normalizeRows(cleanHome, clean));
});

test('claude explicit roots: rawClaude blocks traversal and symlinks while supporting non-default roots', () => {
  const root = makeTempDir('obelisk-claude-raw-security-');
  const mainPath = copyRealFixture(root);
  const subagentsDir = join(root, 'projects', REAL_SLUG, REAL_SID, 'subagents');
  const wfDir = join(subagentsDir, 'workflows', 'run-ok');
  mkdirSync(wfDir, { recursive: true });

  const secretPath = join(root, 'secret.jsonl');
  writeFileSync(secretPath, JSON.stringify({ uuid: 'sec-1', type: 'user', message: { role: 'user', content: 'TOP_SECRET' } }) + '\n');
  writeFileSync(join(wfDir, 'agent-ok.jsonl'), JSON.stringify({
    ...REAL_FIXTURE_USER,
    uuid: 'wf-u1',
    message: { role: 'user', content: 'wf hello' },
  }) + '\n');

  const escapedLink = join(subagentsDir, 'escaped-link.jsonl');
  try { symlinkSync(secretPath, escapedLink); } catch { /* symlink unsupported */ }

  const provider = createClaudeProvider({
    rootDir: '/placeholder/default',
    sourceRoots: ['/placeholder/default', root],
  });
  const tag = provider.rootTagFor(root);
  const scopedSid = canonicalSessionId(REAL_SID, tag);

  assert.equal(provider.raw({
    source: 'claude', messageUuid: 'sec-1', session: { id: REAL_SID, jsonl_path: mainPath },
    agentId: '../../../secret', cursor: null, subagent: null, workflowAgent: null,
  }), null);
  assert.equal(provider.raw({
    source: 'claude', messageUuid: 'sec-1', session: { id: REAL_SID, jsonl_path: mainPath },
    agentId: 'agent-ok', cursor: null, subagent: null, workflowAgent: { run_id: '../../../../secret' },
  }), null);
  assert.equal(provider.raw({
    source: 'claude', messageUuid: 'sec-1', session: { id: REAL_SID, jsonl_path: mainPath },
    agentId: 'escaped-link', cursor: null, subagent: null, workflowAgent: null,
  }), null);

  const wfRaw = provider.raw({
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

  // Root-tag colon sanitization keeps bareSessionId accurate.
  const colonTag = rootTagFor('/tmp/.claude:work', '/tmp/.claude');
  assert.equal(colonTag.includes(':'), false);
  assert.equal(bareSessionId(canonicalSessionId('abc-123', colonTag)), 'abc-123');
});

test('claude explicit roots: symlinked root does not emit false missing-inventory reports', () => {
  const fakeHome = makeTempDir('obelisk-claude-symlink-');
  const realRoot = join(fakeHome, 'real-profile');
  const linkRoot = join(fakeHome, 'link-profile');
  copyRealFixture(realRoot);
  symlinkSync(realRoot, linkRoot);

  const provider = createClaudeProvider({
    rootDir: join(fakeHome, '.claude'),
    sourceRoots: [join(fakeHome, '.claude'), linkRoot],
  });

  const issues = [];
  provider.discover({
    lastCursor: () => null,
    indexedSessions: () => [{
      sessionId: canonicalSessionId(REAL_SID, rootTagFor(linkRoot, join(fakeHome, '.claude'))),
      jsonlPath: join(realRoot, 'projects', REAL_SLUG, `${REAL_SID}.jsonl`),
    }],
    reportIncompleteInventory: (issue) => issues.push(issue),
  });
  assert.deepEqual(issues, []);
});

test('claude explicit roots: Windows-style drive paths match case-insensitively during missing-root detection', () => {
  const existingRoot = makeTempDir('obelisk-claude-win-other-');
  mkdirSync(join(existingRoot, 'projects'), { recursive: true });
  const winDefault = 'C:\\Users\\Demo\\.claude';
  const winFork = 'C:\\Users\\Demo\\claude-work';
  const provider = createClaudeProvider({
    rootDir: existingRoot,
    sourceRoots: [existingRoot, winDefault, winFork],
  });

  const issues = [];
  provider.discover({
    lastCursor: () => null,
    indexedSessions: () => [{
      sessionId: canonicalSessionId(REAL_SID, rootTagFor(winFork, existingRoot)),
      jsonlPath: `c:/users/demo/claude-work/projects/${REAL_SLUG}/${REAL_SID}.jsonl`,
    }],
    reportIncompleteInventory: (issue) => issues.push(issue),
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].path, join(winFork, 'projects'));
});
