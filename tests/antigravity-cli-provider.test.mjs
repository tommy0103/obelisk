// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  antigravityCliSessionId,
  createAntigravityCliProvider,
} from '../packages/core/src/providers/antigravity-cli.ts';
import { RetryableSourceReadError } from '../packages/core/src/providers/source-read-error.ts';
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

function withTransaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = work();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
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
      runTransaction: (_label, work) => withTransaction(db, work),
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

  // 2. Resumed session with an incomplete trailing line is withheld until the line finishes
  const resumedLines = [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-21T09:00:00Z', content: '<USER_REQUEST>\nFind needlealpha in repo\n</USER_REQUEST>' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-21T09:00:05Z', content: 'Found needlealpha.' },
    { step_index: 2, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-21T09:05:00Z', content: '<USER_REQUEST>\nNow check needlebeta too\n</USER_REQUEST>' },
    { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-21T09:05:03Z', content: 'Checked needlebeta.' },
  ];
  writeFileSync(transcriptFile, resumedLines.map((l) => JSON.stringify(l)).join('\n') + '\n{"partial":true');
  const midWrite = runIndex(db, provider);
  assert.equal(midWrite.plan.items.length, 0);
  assert.equal(midWrite.plan.incompleteProviders.has('antigravity-cli'), true);
  assert.equal(searchCount('needlealpha'), 2);

  writeFileSync(transcriptFile, resumedLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const second = runIndex(db, provider);
  assert.equal(second.plan.items.length, 1);
  assert.equal(second.plan.incompleteProviders.size, 0);
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

test('retains full-transcript snapshot when transcript_full.jsonl disappears while transcript.jsonl remains', () => {
  const rootDir = makeTempDir('obelisk-ag-cli-full-retain-');
  const convId = '77777777-7777-4777-8777-777777777777';
  const sessionId = antigravityCliSessionId(convId);

  writeTranscript(rootDir, convId, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-24T10:00:00Z', content: '<USER_REQUEST>\nShort fallback copy\n</USER_REQUEST>' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-24T10:00:01Z', content: 'Truncated fallback reply.' },
  ], 'transcript.jsonl');

  const fullPath = writeTranscript(rootDir, convId, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-24T10:00:00Z', content: '<USER_REQUEST>\nInspect uniqueFullTokenAlpha\n</USER_REQUEST>' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-24T10:00:01Z', content: 'Detailed full answer with uniqueFullTokenBeta.' },
  ], 'transcript_full.jsonl');

  const dbDir = makeTempDir('obelisk-ag-cli-full-db-');
  const dbPath = join(dbDir, 'index.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(INDEX_SCHEMA);
  const provider = createAntigravityCliProvider({ rootDir });

  const searchHits = (q) => {
    const reader = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return createQueryApi(reader).search(q, { source: 'antigravity-cli' }).length;
    } finally {
      reader.close();
    }
  };

  assert.equal(runIndex(db, provider).plan.items.length, 1);
  assert.equal(searchHits('uniqueFullTokenBeta'), 1);

  // Remove only transcript_full.jsonl; surviving transcript.jsonl must not replace the cached snapshot
  rmSync(fullPath);
  const incRun = runIndex(db, provider);
  assert.equal(incRun.plan.items.length, 0);
  assert.equal(incRun.plan.incompleteProviders.size, 0);
  assert.equal(searchHits('uniqueFullTokenBeta'), 1);

  const forceRun = runIndex(db, provider, { force: true });
  assert.equal(forceRun.plan.items.length, 0);
  assert.equal(forceRun.plan.incompleteProviders.size, 0);
  assert.equal(searchHits('uniqueFullTokenBeta'), 1);
  assert.equal(db.prepare('SELECT jsonl_path FROM sessions WHERE id = ?').get(sessionId).jsonl_path, fullPath);

  // Restore transcript_full.jsonl with an extra turn and confirm refresh resumes
  writeTranscript(rootDir, convId, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-24T10:00:00Z', content: '<USER_REQUEST>\nInspect uniqueFullTokenAlpha\n</USER_REQUEST>' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-24T10:00:01Z', content: 'Detailed full answer with uniqueFullTokenBeta.' },
    { step_index: 2, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-24T10:02:00Z', content: '<USER_REQUEST>\nFollowup uniqueFullTokenGamma\n</USER_REQUEST>' },
  ], 'transcript_full.jsonl');
  assert.equal(runIndex(db, provider).plan.items.length, 1);
  assert.equal(searchHits('uniqueFullTokenGamma'), 1);
  db.close();
});

test('rejects an unstable transcript replaced between discover() and parse() without wiping cached messages', () => {
  const rootDir = makeTempDir('obelisk-ag-cli-unstable-');
  const convId = '88888888-8888-4888-8888-888888888888';
  const sessionId = antigravityCliSessionId(convId);
  const transcriptPath = writeTranscript(rootDir, convId, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-24T11:00:00Z', content: '<USER_REQUEST>\nKeep this good turn\n</USER_REQUEST>' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-24T11:00:02Z', content: 'Preserved reply.' },
  ]);

  const db = new DatabaseSync(':memory:');
  db.exec(INDEX_SCHEMA);
  const provider = createAntigravityCliProvider({ rootDir });
  assert.equal(runIndex(db, provider).plan.items.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages WHERE session_id = ?').get(sessionId).c, 2);

  // Append a valid line so discover() schedules an update
  writeTranscript(rootDir, convId, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-24T11:00:00Z', content: '<USER_REQUEST>\nKeep this good turn\n</USER_REQUEST>' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-24T11:00:02Z', content: 'Preserved reply.' },
    { step_index: 2, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-24T11:01:00Z', content: '<USER_REQUEST>\nSecond turn\n</USER_REQUEST>' },
  ]);

  const registry = createProviderRegistry([provider]);
  const plan = createProviderIndexPlan(db, registry);
  assert.equal(plan.items.length, 1);

  // Atomically replace transcript between discover() and parse() with a single incomplete line
  const stagingPath = `${transcriptPath}.tmp`;
  writeFileSync(stagingPath, '{"step_index":0,"type":"USER_INPUT"');
  renameSync(stagingPath, transcriptPath);

  assert.throws(
    () => [...provider.parse(plan.items[0].unit, null)],
    (error) => error instanceof RetryableSourceReadError,
  );

  const errors = [];
  const res = indexProviderPlan({
    db,
    plan,
    runTransaction: (_label, work) => withTransaction(db, work),
    onError: (error) => {
      errors.push(error);
      return 'skip';
    },
  });
  assert.equal(res.complete, false);
  assert.equal(errors.length, 1);
  assert.equal(errors[0] instanceof RetryableSourceReadError, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages WHERE session_id = ?').get(sessionId).c, 2);

  // Recover on next refresh once the complete file is written
  writeTranscript(rootDir, convId, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-24T11:00:00Z', content: '<USER_REQUEST>\nKeep this good turn\n</USER_REQUEST>' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-24T11:00:02Z', content: 'Preserved reply.' },
    { step_index: 2, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-24T11:01:00Z', content: '<USER_REQUEST>\nSecond turn\n</USER_REQUEST>' },
  ]);
  const recovered = runIndex(db, provider);
  assert.equal(recovered.plan.items.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages WHERE session_id = ?').get(sessionId).c, 3);
  db.close();
});

test('escapes embedded NUL bytes in canonical message text and tool results across SQLite persistence', () => {
  const rootDir = makeTempDir('obelisk-ag-cli-nul-');
  const convId = '99999999-9999-4999-8999-999999999999';
  const sessionId = antigravityCliSessionId(convId);
  writeTranscript(rootDir, convId, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-24T12:00:00Z', content: '<USER_REQUEST>\nCheck binary output\n</USER_REQUEST>' },
    { step_index: 1, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: '2026-11-24T12:00:01Z', content: 'sys-prefix\0sys-suffix' },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-24T12:00:02Z',
      content: 'Running command.',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'printf "a\\0b"' } }],
    },
    { step_index: 3, source: 'MODEL', type: 'RUN_COMMAND', status: 'DONE', created_at: '2026-11-24T12:00:03Z', content: 'out-prefix\0out-suffix' },
  ]);

  const provider = createAntigravityCliProvider({ rootDir });
  const units = provider.discover({ lastCursor: () => null });
  assert.equal(units.length, 1);

  const records = [...provider.parse(units[0], null)];
  assertHarnessConformance(records);

  const directSys = records.find((r) => r.kind === 'message' && r.harness_kind === 'reminder');
  const directToolResult = records.find((r) => r.kind === 'tool_result');
  assert.equal(directSys.text, 'sys-prefix\\^@sys-suffix');
  assert.equal(directToolResult.content, 'out-prefix\\^@out-suffix');

  const db = new DatabaseSync(':memory:');
  db.exec(INDEX_SCHEMA);
  runIndex(db, provider);

  const persistedSys = db.prepare('SELECT text FROM messages WHERE uuid = ?').get(directSys.uuid);
  const persistedTool = db.prepare('SELECT content FROM tool_results WHERE tool_use_id = ?').get(directToolResult.tool_use_id);
  assert.equal(persistedSys.text, directSys.text);
  assert.equal(persistedTool.content, directToolResult.content);

  const session = records.find((r) => r.kind === 'session');
  const rawSys = provider.raw({
    source: 'antigravity-cli',
    messageUuid: directSys.uuid,
    session: { id: sessionId, jsonl_path: session.jsonl_path },
    agentId: null,
  });
  assert.equal(rawSys?.messageText, 'sys-prefix\0sys-suffix');
  assert.ok(rawSys?.text.includes('sys-prefix\\u0000sys-suffix'));
  db.close();
});

for (const [label, brokenBody] of [
  ['empty file', ''],
  ['invalid JSON only', '{not valid json\n'],
  ['valid step plus unfinished trailing line', `${JSON.stringify({
    step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-25T08:00:00Z', content: '<USER_REQUEST>\nPartial\n</USER_REQUEST>',
  })}\n{"step_index":1,"type":"PLANNER_`],
]) {
  test(`retains cached hits across incremental and force rebuilds when pre-discovery transcript is ${label}`, () => {
    const rootDir = makeTempDir('obelisk-ag-cli-broken-');
    const convId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const transcriptFile = writeTranscript(rootDir, convId, [
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-25T08:00:00Z', content: '<USER_REQUEST>\nFind uniqueBrokenRetainToken\n</USER_REQUEST>' },
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-25T08:00:02Z', content: 'Found uniqueBrokenRetainToken.' },
    ]);

    const dbDir = makeTempDir('obelisk-ag-cli-broken-db-');
    const dbPath = join(dbDir, 'index.sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec(INDEX_SCHEMA);
    const provider = createAntigravityCliProvider({ rootDir });

    const hits = (q) => {
      const reader = new DatabaseSync(dbPath, { readOnly: true });
      try {
        return createQueryApi(reader).search(q, { source: 'antigravity-cli' }).length;
      } finally {
        reader.close();
      }
    };

    assert.equal(runIndex(db, provider).plan.items.length, 1);
    assert.equal(hits('uniqueBrokenRetainToken'), 2);

    // Replace with broken content before discover()
    writeFileSync(transcriptFile, brokenBody);

    const inc = runIndex(db, provider);
    assert.equal(inc.plan.items.length, 0);
    assert.equal(inc.plan.incompleteProviders.has('antigravity-cli'), true);
    assert.equal(hits('uniqueBrokenRetainToken'), 2);

    const forced = runIndex(db, provider, { force: true });
    assert.equal(forced.plan.items.length, 0);
    assert.equal(forced.plan.incompleteProviders.has('antigravity-cli'), true);
    assert.equal(hits('uniqueBrokenRetainToken'), 2);

    // Deleting the broken file and rebuilding still keeps the cached hits
    rmSync(transcriptFile);
    const afterDelete = runIndex(db, provider, { force: true });
    assert.equal(afterDelete.plan.items.length, 0);
    assert.equal(afterDelete.plan.incompleteProviders.size, 0);
    assert.equal(hits('uniqueBrokenRetainToken'), 2);

    // Restoring a valid transcript resumes indexing cleanly
    writeTranscript(rootDir, convId, [
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-25T08:00:00Z', content: '<USER_REQUEST>\nFind uniqueBrokenRetainToken\n</USER_REQUEST>' },
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-25T08:00:02Z', content: 'Found uniqueBrokenRetainToken.' },
      { step_index: 2, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-25T08:05:00Z', content: '<USER_REQUEST>\nRecovered uniqueBrokenRecoveredToken\n</USER_REQUEST>' },
    ]);
    const recovered = runIndex(db, provider);
    assert.equal(recovered.plan.items.length, 1);
    assert.equal(recovered.plan.incompleteProviders.size, 0);
    assert.equal(hits('uniqueBrokenRecoveredToken'), 1);
    db.close();
  });
}

test('preserves title, project, and started_by when switching from transcript.jsonl to transcript_full.jsonl under DB lock', () => {
  const rootDir = makeTempDir('obelisk-ag-cli-switch-lock-');
  const convId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const sessionId = antigravityCliSessionId(convId);
  const workspaceDir = join(rootDir, 'switch-repo');
  mkdirSync(workspaceDir, { recursive: true });
  const summaryDbPath = createSummaryDb(rootDir, [
    {
      id: convId,
      title: 'Initial Summary Title',
      workspaceUris: [pathToFileURL(workspaceDir).href],
      parentConversationId: '00000000-0000-4000-8000-000000000000',
      nestingDepth: 1,
    },
  ]);

  writeTranscript(rootDir, convId, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-25T09:00:00Z', content: '<USER_REQUEST>\nFirst fallback request\n</USER_REQUEST>' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-25T09:00:01Z', content: 'Fallback answer.' },
  ], 'transcript.jsonl');

  const db = new DatabaseSync(':memory:');
  db.exec(INDEX_SCHEMA);
  const provider = createAntigravityCliProvider({
    rootDir,
    openDatabase: (path) => new DatabaseSync(path, { readOnly: true, timeout: 0 }),
  });

  assert.equal(runIndex(db, provider).plan.items.length, 1);
  const readRow = () => {
    const row = db.prepare('SELECT title, project, started_by FROM sessions WHERE id = ?').get(sessionId);
    return row ? { ...row } : null;
  };
  const expectedProject = readRow().project;
  assert.equal(readRow().title, 'Initial Summary Title');
  assert.ok(expectedProject);
  assert.equal(readRow().started_by, 'agent');

  // Lock summary DB, then introduce transcript_full.jsonl so the unit path switches
  const locker = new DatabaseSync(summaryDbPath);
  locker.exec('BEGIN EXCLUSIVE');
  try {
    writeTranscript(rootDir, convId, [
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-25T09:00:00Z', content: '<USER_REQUEST>\nFull request\n</USER_REQUEST>' },
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-25T09:00:01Z', content: 'Full answer.' },
    ], 'transcript_full.jsonl');

    const switchedLocked = runIndex(db, provider);
    assert.equal(switchedLocked.plan.items.length, 1);
    assert.equal(switchedLocked.plan.incompleteProviders.has('antigravity-cli'), true);
    assert.deepEqual(readRow(), {
      title: 'Initial Summary Title',
      project: expectedProject,
      started_by: 'agent',
    });

    locker.prepare('UPDATE conversation_summaries SET title = ?, nesting_depth = 0, parent_conversation_id = \'\' WHERE conversation_id = ?')
      .run('Updated After Unlock', convId);
    locker.exec('COMMIT');
  } finally {
    locker.close();
  }

  const unlocked = runIndex(db, provider);
  assert.equal(unlocked.plan.items.length, 1);
  assert.equal(unlocked.plan.incompleteProviders.size, 0);
  assert.deepEqual(readRow(), {
    title: 'Updated After Unlock',
    project: expectedProject,
    started_by: null,
  });
  db.close();
});

test('fallback title truncation does not split surrogate pairs across SQLite persistence', () => {
  const rootDir = makeTempDir('obelisk-ag-cli-emoji-');
  const convId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const sessionId = antigravityCliSessionId(convId);
  const boundaryTitle = `${'a'.repeat(79)}🚀`;
  writeTranscript(rootDir, convId, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-25T10:00:00Z', content: `<USER_REQUEST>\n${boundaryTitle}\n</USER_REQUEST>` },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-25T10:00:01Z', content: 'Ok.' },
  ]);

  const provider = createAntigravityCliProvider({ rootDir });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const directSession = [...provider.parse(unit, null)].find((r) => r.kind === 'session');
  assert.equal(directSession.title, 'a'.repeat(79));

  const db = new DatabaseSync(':memory:');
  db.exec(INDEX_SCHEMA);
  runIndex(db, provider);
  const persisted = db.prepare('SELECT title FROM sessions WHERE id = ?').get(sessionId);
  assert.equal(persisted.title, directSession.title);
  db.close();
});

test('raw() returns thinking text for :1-thinking UUIDs and response content for :2-text UUIDs', () => {
  const rootDir = makeTempDir('obelisk-ag-cli-raw-parts-');
  const convId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  writeTranscript(rootDir, convId, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-25T11:00:00Z', content: '<USER_REQUEST>\nExplain why\n</USER_REQUEST>' },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-25T11:00:02Z',
      thinking: 'Private chain of thought.',
      content: 'Public final answer.',
    },
  ]);

  const provider = createAntigravityCliProvider({ rootDir });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const records = [...provider.parse(unit, null)];
  const session = records.find((r) => r.kind === 'session');
  const thinkingMsg = records.find((r) => r.kind === 'message' && r.content_type === 'thinking');
  const answerMsg = records.find((r) => r.kind === 'message' && r.role === 'assistant' && r.content_type === 'text');
  assert.ok(thinkingMsg && answerMsg);

  const rawThinking = provider.raw({
    source: 'antigravity-cli',
    messageUuid: thinkingMsg.uuid,
    session: { id: session.id, jsonl_path: session.jsonl_path },
    agentId: null,
  });
  const rawAnswer = provider.raw({
    source: 'antigravity-cli',
    messageUuid: answerMsg.uuid,
    session: { id: session.id, jsonl_path: session.jsonl_path },
    agentId: null,
  });
  assert.equal(rawThinking?.messageText, 'Private chain of thought.');
  assert.equal(rawAnswer?.messageText, 'Public final answer.');
});
