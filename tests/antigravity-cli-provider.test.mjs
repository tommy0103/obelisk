// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  antigravityCliSessionId,
  createAntigravityCliProvider,
} from '../packages/core/src/providers/antigravity-cli.ts';
import { createProviderRegistry } from '../packages/core/src/providers/registry.ts';
import { createProviderIndexPlan, indexProviderPlan } from '../packages/core/src/provider-indexing.ts';
import { ensureFtsReady, refreshSessionProjectPaths } from '../packages/core/src/index-finalize.ts';
import { createQueryApi } from '../packages/core/src/query.ts';
import { prepareRetainedSnapshot } from '../packages/core/src/snapshot.ts';
import { assertHarnessConformance } from './harness-conformance.mjs';
import { makeTempDir } from './temp-dirs.mjs';

const INDEX_SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');

function createSummaryDb(rootDir, rows = []) {
  const dbPath = join(rootDir, 'conversation_summaries.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      workspace_uris TEXT NOT NULL DEFAULT '[]',
      parent_conversation_id TEXT NOT NULL DEFAULT '',
      nesting_depth INTEGER NOT NULL DEFAULT 0
    );
  `);
  const insert = db.prepare(`
    INSERT INTO conversation_summaries (conversation_id, title, workspace_uris, parent_conversation_id, nesting_depth)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    insert.run(
      row.id,
      row.title ?? '',
      JSON.stringify(row.workspaceUris ?? []),
      row.parentConversationId ?? '',
      row.nestingDepth ?? 0,
    );
  }
  db.close();
  return dbPath;
}

function writeTranscript(rootDir, conversationId, lines, fileName = 'transcript_full.jsonl') {
  const logsDir = join(rootDir, 'brain', conversationId, '.system_generated', 'logs');
  mkdirSync(logsDir, { recursive: true });
  const filePath = join(logsDir, fileName);
  writeFileSync(filePath, lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n');
  return filePath;
}

function runIndex(db, provider, { force = false } = {}) {
  const registry = createProviderRegistry([provider]);
  const plan = createProviderIndexPlan(db, registry, { force });
  let retained = null;
  if (force) {
    retained = prepareRetainedSnapshot(db, plan.retainedSessions);
    retained.reset();
  }
  try {
    const result = indexProviderPlan({
      db,
      plan,
      runTransaction: (_label, work) => work(),
      onError: (error) => { throw error; },
    });
    refreshSessionProjectPaths(db, null);
    ensureFtsReady(db, { force });
    return { plan, result };
  } finally {
    retained?.close();
  }
}

test('parses native CLI transcripts, pairs CLI tool outputs, conforms to USF, and serves raw lines', () => {
  const rootDir = makeTempDir('obelisk-ag-cli-parse-');
  const convId = '11111111-1111-4111-8111-111111111111';
  const childId = '22222222-2222-4222-8222-222222222222';
  const fallbackId = '33333333-3333-4333-8333-333333333333';
  const workspaceDir = join(rootDir, 'workspace-repo');
  mkdirSync(workspaceDir, { recursive: true });

  createSummaryDb(rootDir, [
    {
      id: convId,
      title: 'Inspect build script',
      workspaceUris: [pathToFileURL(workspaceDir).href],
    },
    {
      id: childId,
      title: 'Subagent task',
      workspaceUris: [pathToFileURL(workspaceDir).href],
      parentConversationId: convId,
      nestingDepth: 1,
    },
  ]);

  // Include both transcript.jsonl (should be ignored when transcript_full.jsonl exists) and transcript_full.jsonl
  writeTranscript(rootDir, convId, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-20T10:00:00Z', content: '<USER_REQUEST>\nIgnored short transcript\n</USER_REQUEST>' },
  ], 'transcript.jsonl');

  writeTranscript(rootDir, convId, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-20T10:00:00Z', content: '<USER_REQUEST>\nCheck package.json and run tests\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nlocal time\n</ADDITIONAL_METADATA>' },
    // Resent identical step_index must be deduplicated
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-20T10:00:01Z', content: '<USER_REQUEST>\nCheck package.json and run tests\n</USER_REQUEST>' },
    { step_index: 1, source: 'SYSTEM', type: 'CONVERSATION_HISTORY', status: 'DONE', created_at: '2026-11-20T10:00:01Z' },
    // Out-of-order output logged before PLANNER_RESPONSE
    { step_index: 4, source: 'MODEL', type: 'RUN_COMMAND', status: 'ERROR', error: 'exit 1', created_at: '2026-11-20T10:00:04Z' },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-20T10:00:02Z',
      thinking: 'Need to inspect package.json and run tests.',
      content: 'Checking now.',
      input_tokens: 100,
      cache_read_tokens: 900,
      output_tokens: 42,
      tool_calls: [
        { name: 'view_file', args: { AbsolutePath: JSON.stringify('/repo/package.json') } },
        { name: 'run_command', args: { CommandLine: 'npm test' } },
      ],
    },
    { step_index: 3, source: 'MODEL', type: 'VIEW_FILE', status: 'DONE', created_at: '2026-11-20T10:00:03Z', content: '{"name":"demo"}' },
    { step_index: 5, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: '2026-11-20T10:00:05Z', content: 'System reminder' },
    { step_index: 6, source: 'SYSTEM', type: 'CHECKPOINT', status: 'DONE', created_at: '2026-11-20T10:00:06Z', content: 'Compacted summary', input_tokens: 50, output_tokens: 10 },
    { step_index: 7, source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', created_at: '2026-11-20T10:00:07Z', error: 'Rate limit', error_code: 429 },
    { step_index: 8, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-20T10:00:08Z', content: 'Unclaimed generic result' },
  ], 'transcript_full.jsonl');

  writeTranscript(rootDir, childId, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-20T10:01:00Z', content: '<USER_REQUEST>\nVerify subagent check\n</USER_REQUEST>' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-20T10:01:01Z', content: 'Subagent done.' },
  ]);

  writeTranscript(rootDir, fallbackId, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-20T10:02:00Z', content: '<USER_REQUEST>\nFallback transcript file\n</USER_REQUEST>' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-20T10:02:01Z', content: 'Fallback ok.' },
  ], 'transcript.jsonl');

  const provider = createAntigravityCliProvider({ rootDir });
  const units = provider.discover({ lastCursor: () => null });
  assert.equal(units.length, 3);

  const byId = new Map(units.map((u) => [u.sessionId, u]));
  const mainUnit = byId.get(antigravityCliSessionId(convId));
  const childUnit = byId.get(antigravityCliSessionId(childId));
  const fallbackUnit = byId.get(antigravityCliSessionId(fallbackId));
  assert.ok(mainUnit && childUnit && fallbackUnit);

  const mainRecords = [...provider.parse(mainUnit, null)];
  const childRecords = [...provider.parse(childUnit, null)];
  const fallbackRecords = [...provider.parse(fallbackUnit, null)];

  assertHarnessConformance(mainRecords);
  assertHarnessConformance(childRecords);
  assertHarnessConformance(fallbackRecords);

  const mainSession = mainRecords.find((r) => r.kind === 'session');
  assert.equal(mainSession.title, 'Inspect build script');
  assert.equal(mainSession.source, 'antigravity-cli');
  assert.equal(mainSession.started_by, null);

  const childSession = childRecords.find((r) => r.kind === 'session');
  assert.equal(childSession.started_by, 'agent');

  const userMsgs = mainRecords.filter((r) => r.kind === 'message' && r.role === 'user');
  assert.equal(userMsgs.length, 1);
  assert.equal(userMsgs[0].text, 'Check package.json and run tests');

  const thinkingMsg = mainRecords.find((r) => r.kind === 'message' && r.content_type === 'thinking');
  assert.equal(thinkingMsg.input_tokens, 1000);
  assert.equal(thinkingMsg.output_tokens, 42);

  const toolCalls = mainRecords.filter((r) => r.kind === 'tool_call');
  const toolResults = mainRecords.filter((r) => r.kind === 'tool_result');
  assert.equal(toolCalls.length, 2);
  assert.equal(toolCalls[0].file_path, '/repo/package.json');
  assert.equal(toolResults.length, 2);
  assert.deepEqual(
    toolResults.map((r) => [r.tool_use_id, r.content, r.is_error]),
    [
      [toolCalls[0].id, '{"name":"demo"}', 0],
      [toolCalls[1].id, 'exit 1', 1],
    ],
  );

  const harnessKinds = mainRecords
    .filter((r) => r.kind === 'message' && r.harness_kind !== null)
    .map((r) => r.harness_kind);
  assert.deepEqual(harnessKinds, ['other', 'reminder', 'compaction', 'error', 'result']);

  const raw = provider.raw({
    source: 'antigravity-cli',
    messageUuid: userMsgs[0].uuid,
    session: { id: mainSession.id, jsonl_path: mainSession.jsonl_path },
    agentId: null,
  });
  assert.equal(raw?.messageText, 'Check package.json and run tests');

  const fallbackSession = fallbackRecords.find((r) => r.kind === 'session');
  assert.equal(fallbackSession.title, 'Fallback transcript file');
});

test('indexes new and resumed sessions and retains cached sessions after transcript deletion', () => {
  const rootDir = makeTempDir('obelisk-ag-cli-retain-');
  const convId = '44444444-4444-4444-8444-444444444444';
  const transcriptFile = writeTranscript(rootDir, convId, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-21T09:00:00Z', content: '<USER_REQUEST>\nFind needlealpha in repo\n</USER_REQUEST>' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-21T09:00:05Z', content: 'Found needlealpha.' },
  ]);

  const dbDir = makeTempDir('obelisk-ag-cli-db-');
  const dbPath = join(dbDir, 'index.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(INDEX_SCHEMA);
  const provider = createAntigravityCliProvider({ rootDir });
  const searchCount = (query) => {
    const reader = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return createQueryApi(reader).search(query, { source: 'antigravity-cli' }).length;
    } finally {
      reader.close();
    }
  };

  // 1. Initial index
  const first = runIndex(db, provider);
  assert.equal(first.plan.items.length, 1);
  assert.equal(searchCount('needlealpha'), 2);

  // 2. Resumed session appends lines (and ignores an incomplete trailing line)
  const resumedLines = [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-21T09:00:00Z', content: '<USER_REQUEST>\nFind needlealpha in repo\n</USER_REQUEST>' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-21T09:00:05Z', content: 'Found needlealpha.' },
    { step_index: 2, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-21T09:05:00Z', content: '<USER_REQUEST>\nNow check needlebeta too\n</USER_REQUEST>' },
    { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-21T09:05:03Z', content: 'Checked needlebeta.' },
  ];
  writeFileSync(transcriptFile, resumedLines.map((l) => JSON.stringify(l)).join('\n') + '\n{"partial":true');

  const second = runIndex(db, provider);
  assert.equal(second.plan.items.length, 1);
  assert.equal(searchCount('needlebeta'), 2);

  // 3. Transcript deleted -> cached session stays searchable on incremental and force rebuilds
  rmSync(transcriptFile);
  const afterDelete = runIndex(db, provider);
  assert.equal(afterDelete.plan.items.length, 0);
  assert.equal(afterDelete.plan.incompleteProviders.size, 0);
  assert.equal(searchCount('needlebeta'), 2);

  // 4. Entire brain/ directory deleted -> still retained even on force rebuild
  rmSync(join(rootDir, 'brain'), { recursive: true, force: true });
  const afterBrainRemoved = runIndex(db, provider, { force: true });
  assert.equal(afterBrainRemoved.plan.items.length, 0);
  assert.equal(afterBrainRemoved.plan.incompleteProviders.size, 0);
  assert.equal(searchCount('needlebeta'), 2);
  db.close();
});

test('preserves previously indexed title and project when conversation_summaries.db is exclusively locked', () => {
  const rootDir = makeTempDir('obelisk-ag-cli-lock-');
  const convId = '55555555-5555-4555-8555-555555555555';
  const workspaceDir = join(rootDir, 'alpha-project');
  mkdirSync(workspaceDir, { recursive: true });
  const summaryDbPath = createSummaryDb(rootDir, [
    {
      id: convId,
      title: 'Original CLI Title',
      workspaceUris: [pathToFileURL(workspaceDir).href],
    },
  ]);
  writeTranscript(rootDir, convId, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-22T10:00:00Z', content: '<USER_REQUEST>\nFirst request text\n</USER_REQUEST>' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-22T10:00:02Z', content: 'Done.' },
  ]);

  const db = new DatabaseSync(':memory:');
  db.exec(INDEX_SCHEMA);
  const provider = createAntigravityCliProvider({
    rootDir,
    openDatabase: (path) => new DatabaseSync(path, { readOnly: true, timeout: 0 }),
  });

  const initial = runIndex(db, provider);
  assert.equal(initial.plan.items.length, 1);
  assert.equal(initial.plan.incompleteProviders.size, 0);
  const readSession = () => db.prepare('SELECT title, project, project_path FROM sessions WHERE id = ?').get(antigravityCliSessionId(convId));
  assert.equal(readSession().title, 'Original CLI Title');
  assert.ok(readSession().project);
  const expectedProject = readSession().project;

  // Acquire a real SQLite exclusive write lock on conversation_summaries.db
  const locker = new DatabaseSync(summaryDbPath);
  locker.exec('BEGIN EXCLUSIVE');
  try {
    const lockedRun = runIndex(db, provider);
    assert.equal(lockedRun.plan.items.length, 0);
    assert.equal(lockedRun.plan.incompleteProviders.has('antigravity-cli'), true);
    assert.equal(readSession().title, 'Original CLI Title');
    assert.equal(readSession().project, expectedProject);

    locker.prepare('UPDATE conversation_summaries SET title = ? WHERE conversation_id = ?').run('Updated CLI Title', convId);
    locker.exec('COMMIT');
  } finally {
    locker.close();
  }

  // After lock release, the next refresh picks up the updated title cleanly
  const unlockedRun = runIndex(db, provider);
  assert.equal(unlockedRun.plan.items.length, 1);
  assert.equal(unlockedRun.plan.incompleteProviders.size, 0);
  assert.equal(readSession().title, 'Updated CLI Title');
  assert.equal(readSession().project, expectedProject);
  db.close();
});
