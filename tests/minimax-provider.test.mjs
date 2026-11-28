// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { chmodSync, closeSync, copyFileSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { test } from 'node:test';

import { installSchema } from '../packages/core/src/db.ts';
import { persist } from '../packages/core/src/persist.ts';
import { createMinimaxProvider, defaultMinimaxRoot, minimaxSessionId } from '../packages/core/src/providers/minimax.ts';
import { createQueryApi } from '../packages/core/src/query.ts';
import { assembleSessionDetail } from '../packages/core/src/session-detail.ts';
import { assembleUsf } from '../packages/core/src/usf.ts';
import { buildIndex as buildAppIndex } from '../app/src/main/indexer.ts';
import { runCli } from './cli-test-helpers.mjs';
import { assertHarnessConformance } from './harness-conformance.mjs';
import { makeTempDir } from './temp-dirs.mjs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const BetterSqlite3 = require('../app/node_modules/better-sqlite3');

const FIXTURE_DIR = new URL('./fixtures/minimax/', import.meta.url);
const FIXTURE_SCHEMA = readFileSync(new URL('schema.sql', FIXTURE_DIR), 'utf8');

function seedFixtureSession(root, relDir = '2026/11/27/20-12-46-734-session_bXZzX2FjODYyMzIwMmQxMDQ1YjZhMjkwYTI1NDhiNjg2Yzdk') {
  const sessionDir = join(root, 'v2', 'sessions', relDir);
  mkdirSync(join(sessionDir, 'snapshots'), { recursive: true });
  copyFileSync(new URL('session/manifest.json', FIXTURE_DIR), join(sessionDir, 'manifest.json'));
  copyFileSync(new URL('session/messages.jsonl', FIXTURE_DIR), join(sessionDir, 'messages.jsonl'));
  for (const name of readdirSync(new URL('session/snapshots', FIXTURE_DIR))) {
    copyFileSync(new URL(`session/snapshots/${name}`, FIXTURE_DIR), join(sessionDir, 'snapshots', name));
  }
  return sessionDir;
}

function createSqliteStore(root, rows = []) {
  const sqliteDir = join(root, 'v2', 'sqlite');
  mkdirSync(sqliteDir, { recursive: true });
  const dbPath = join(sqliteDir, 'runtime-state.sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('DROP TABLE IF EXISTS local_runtime_sessions;');
    db.exec(FIXTURE_SCHEMA);
    const stmt = db.prepare(`INSERT INTO local_runtime_sessions
      (session_id, record_json, updated_at_ms, columnar_version, session_kind, visibility, parent_session_id, workspace_dir, title, history_relative_dir, created_at_ms)
      VALUES (?, '{}', ?, 3, ?, ?, ?, ?, ?, ?, ?)`);
    for (const row of rows) {
      stmt.run(
        row.session_id,
        row.updated_at_ms ?? 1795810374323,
        row.session_kind ?? 'conversation',
        row.visibility ?? 'visible',
        row.parent_session_id ?? null,
        row.workspace_dir ?? '/workspace/demo',
        row.title ?? null,
        row.history_relative_dir ?? null,
        row.created_at_ms ?? 1795810366734,
      );
    }
  } finally {
    db.close();
  }
  return dbPath;
}

function writeSessionFiles(root, relDir, { sessionId, createdAtMs = 1795810000000, schemaVersion = 1, messages = [], snapshots = {} }) {
  const sessionDir = join(root, 'v2', 'sessions', relDir);
  mkdirSync(join(sessionDir, 'snapshots'), { recursive: true });
  writeFileSync(join(sessionDir, 'manifest.json'), JSON.stringify({
    schemaVersion,
    sessionId,
    createdAtMs,
    updatedAtMs: createdAtMs + 1000,
    source: 'local-runtime',
    layout: 'v2-final-dated-session',
  }));
  writeFileSync(
    join(sessionDir, 'messages.jsonl'),
    messages.map((m) => (typeof m === 'string' ? m : JSON.stringify(m))).join('\n') + (messages.length > 0 ? '\n' : ''),
  );
  for (const [name, lines] of Object.entries(snapshots)) {
    writeFileSync(
      join(sessionDir, 'snapshots', name),
      lines.map((m) => (typeof m === 'string' ? m : JSON.stringify(m))).join('\n') + (lines.length > 0 ? '\n' : ''),
    );
  }
  return sessionDir;
}

function collectAll(provider, opts = {}) {
  const issues = [];
  const skipped = [];
  const retained = [];
  const units = provider.discover({
    lastCursor: opts.lastCursor ?? (() => null),
    indexedSessions: opts.indexedSessions ?? (() => []),
    changedPaths: opts.changedPaths,
    reportIncompleteInventory: (issue) => issues.push(issue),
    reportSkippedArtifact: (issue) => skipped.push(issue),
    retainSession: (id) => retained.push(id),
  });
  return { units, issues, skipped, retained };
}

function snapshotTables(db) {
  return {
    sessions: db.prepare('SELECT id, title, project, started_at, ended_at, message_count, jsonl_path, source, started_by FROM sessions ORDER BY id').all().map((r) => ({ ...r })),
    messages: db.prepare('SELECT uuid, session_id, type, parent_uuid, timestamp, role, text, content_type, is_meta, visibility, model, input_tokens, output_tokens, cwd, source, harness_kind FROM messages ORDER BY uuid').all().map((r) => ({ ...r })),
    tool_calls: db.prepare('SELECT id, message_uuid, session_id, name, presentation, input_json, file_path FROM tool_calls ORDER BY id').all().map((r) => ({ ...r })),
    tool_results: db.prepare('SELECT tool_use_id, message_uuid, session_id, content, file_path, is_error FROM tool_results ORDER BY tool_use_id').all().map((r) => ({ ...r })),
    summaries: db.prepare('SELECT id, session_id, timestamp, source, content, visibility, input_tokens, output_tokens FROM summaries ORDER BY id').all().map((r) => ({ ...r })),
  };
}

function indexUnit(db, provider, unit, cursor) {
  return persist(db, unit, provider.parse(unit, cursor));
}

function indexAllWithFreshDb(root, openDatabase) {
  const provider = createMinimaxProvider({ rootDir: root, openDatabase });
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  const units = provider.discover({ lastCursor: () => null });
  for (const unit of units) {
    indexUnit(db, provider, unit, null);
  }
  const tables = snapshotTables(db);
  db.close();
  return tables;
}

test('real mcode@0.8.0 fixture passes harness conformance and ADR-0007 SQLite round-trip', () => {
  const root = makeTempDir('obelisk-minimax-fixture-');
  seedFixtureSession(root);
  createSqliteStore(root, [{
    session_id: 'mvs_ac8623202d1045b6a290a2548b686c7d',
    title: 'Hello turn 1',
    workspace_dir: '/workspace/demo',
    history_relative_dir: '2026/11/27/20-12-46-734-session_bXZzX2FjODYyMzIwMmQxMDQ1YjZhMjkwYTI1NDhiNjg2Yzdk',
  }]);

  const provider = createMinimaxProvider({ rootDir: root });
  const { units, issues } = collectAll(provider);
  assert.deepEqual(issues, []);
  assert.equal(units.length, 1);

  const records = [...provider.parse(units[0], null)];
  assertHarnessConformance(records);

  const sessionRec = records.find((r) => r.kind === 'session');
  assert.equal(sessionRec.title, 'Hello turn 1');
  assert.equal(sessionRec.project, '-workspace-demo');

  const summaries = records.filter((r) => r.kind === 'summary');
  assert.equal(summaries.length, 2, 'both g1 and g2 compaction summaries are indexed from reachable chain');

  const userMessages = records.filter((r) => r.kind === 'message' && r.role === 'user');
  assert.equal(userMessages.length, 4, 'all 4 turns across g0, g1, g2 are preserved without duplicate currentUser');
  assert.equal(userMessages[0].text, 'Hello turn 1', 'canonicalTextRange strips system-reminder wrapper');

  const hiddenCustom = records.filter((r) => r.kind === 'message' && r.role === 'custom');
  assert.ok(hiddenCustom.length > 0);
  for (const c of hiddenCustom) {
    assert.equal(c.is_meta, 1);
    assert.equal(c.harness_kind, 'reminder');
    assert.equal(c.visibility, 'hidden');
  }

  // ADR-0007 round-trip: direct assembleSessionDetail === post-SQLite assembleSessionDetail
  const directDetail = assembleSessionDetail({
    messages: records.filter((r) => r.kind === 'message'),
    toolCalls: records.filter((r) => r.kind === 'tool_call'),
    toolResults: records.filter((r) => r.kind === 'tool_result'),
    subagents: [],
    workflows: [],
    summaries,
  });

  const db = new DatabaseSync(':memory:');
  installSchema(db);
  indexUnit(db, provider, units[0], null);
  const persistedDetail = assembleSessionDetail({
    messages: db.prepare("SELECT * FROM messages WHERE session_id = ? AND COALESCE(visibility, 'visible') = 'visible' ORDER BY timestamp, uuid").all(units[0].sessionId),
    toolCalls: db.prepare('SELECT * FROM tool_calls WHERE session_id = ? ORDER BY rowid').all(units[0].sessionId),
    toolResults: db.prepare('SELECT * FROM tool_results WHERE session_id = ?').all(units[0].sessionId),
    subagents: [],
    workflows: [],
    summaries: db.prepare("SELECT * FROM summaries WHERE session_id = ? AND COALESCE(visibility, 'visible') = 'visible'").all(units[0].sessionId),
  });
  db.close();

  assert.deepEqual(directDetail, persistedDetail);
});

test('defaultMinimaxRoot respects MINIMAX_DATA_DIR > MAVIS_DATA_DIR > ~/.minimax', () => {
  assert.equal(defaultMinimaxRoot({ homeDir: '/home/u', env: {} }), join('/home/u', '.minimax'));
  assert.equal(defaultMinimaxRoot({ homeDir: '/home/u', env: { MAVIS_DATA_DIR: '~/mavis-custom' } }), join('/home/u', 'mavis-custom'));
  assert.equal(
    defaultMinimaxRoot({ homeDir: '/home/u', env: { MINIMAX_DATA_DIR: '/opt/mm', MAVIS_DATA_DIR: '/opt/mavis' } }),
    '/opt/mm',
  );
});

test('discover handles deduplication, version-gate tolerance, and fail-open SQLite', () => {
  const root = makeTempDir('obelisk-minimax-discover-');
  const msg = (id, text, ts = 1795810000000) => ({
    message_id: id,
    turn_id: 't1',
    message: { role: 'user', content: [{ type: 'text', text }], timestamp: ts },
  });

  // Duplicate sessionId across two dirs; SQLite history_relative_dir picks canonical dir
  const dupRel = '2026/11/27/20-00-00-000-session_ZHVw';
  writeSessionFiles(root, '2026/11/27/12-00-00-000-session_ZHVw', {
    sessionId: 'mvs_dup',
    messages: [msg('msg-1', 'old copy')],
  });
  writeSessionFiles(root, dupRel, {
    sessionId: 'mvs_dup',
    messages: [msg('msg-1', 'canonical copy')],
  });

  // Unsupported future schemaVersion > 1: skipped & retained, does not poison siblings
  writeSessionFiles(root, '2026/11/27/21-00-00-000-session_ZnV0dXJl', {
    sessionId: 'mvs_future',
    schemaVersion: 99,
    messages: [msg('msg-f1', 'future')],
  });

  // Legacy v1-only dir without messages.jsonl: ignored cleanly
  const v1Dir = join(root, 'v2', 'sessions', '2026', '11', '27', '10-00-00-000-session_djE');
  mkdirSync(v1Dir, { recursive: true });
  writeFileSync(join(v1Dir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, sessionId: 'mvs_v1', createdAtMs: 1795810000000 }));
  writeFileSync(join(v1Dir, 'ledger.jsonl'), '{}\n');

  // Task subagent session & hidden/peek sessions
  writeSessionFiles(root, '2026/11/27/22-00-00-000-session_dGFzaw', {
    sessionId: 'mvs_task',
    messages: [
      { message_id: 'msg-t1', turn_id: 't1', message: { role: 'user', content: [{ type: 'text', text: 'do subtask' }], timestamp: 1795810001000 } },
      { message_id: 'msg-t2', turn_id: 't1', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], timestamp: 1795810002000 } },
    ],
  });
  writeSessionFiles(root, '2026/11/27/22-05-00-000-session_cGVlaw', {
    sessionId: 'mvs_peek',
    messages: [msg('msg-p1', 'peek')],
  });

  createSqliteStore(root, [
    { session_id: 'mvs_dup', title: 'Canonical Dup', history_relative_dir: dupRel },
    { session_id: 'mvs_task', session_kind: 'task', parent_session_id: 'mvs_dup', title: 'Subtask' },
    { session_id: 'mvs_peek', session_kind: 'peek', title: 'Peek' },
  ]);

  const provider = createMinimaxProvider({ rootDir: root });
  const { units, issues, skipped, retained } = collectAll(provider, {
    indexedSessions: () => [{ sessionId: minimaxSessionId('mvs_future'), jsonlPath: join(root, 'v2/sessions/2026/11/27/21-00-00-000-session_ZnV0dXJl/messages.jsonl') }],
  });

  assert.deepEqual(issues, []);
  assert.equal(skipped.length, 1);
  assert.deepEqual(retained, [minimaxSessionId('mvs_future')]);
  assert.deepEqual(units.map((u) => u.sessionId).sort(), [
    minimaxSessionId('mvs_dup'),
    minimaxSessionId('mvs_task'),
  ]);

  const dupUnit = units.find((u) => u.sessionId === minimaxSessionId('mvs_dup'));
  const dupRecords = [...provider.parse(dupUnit, null)];
  assert.equal(dupRecords.find((r) => r.kind === 'message').text, 'canonical copy');

  const taskUnit = units.find((u) => u.sessionId === minimaxSessionId('mvs_task'));
  const taskRecords = [...provider.parse(taskUnit, null)];
  assertHarnessConformance(taskRecords);
  assert.equal(taskRecords.find((r) => r.kind === 'session').started_by, 'agent');

  // Fail-closed when SQLite exists but opener throws (prevents hidden/peek leakage)
  const busyProvider = createMinimaxProvider({
    rootDir: root,
    openDatabase: () => { throw new Error('SQLITE_BUSY'); },
  });
  const busyRes = collectAll(busyProvider, {
    indexedSessions: () => [{ sessionId: minimaxSessionId('mvs_dup'), jsonlPath: join(root, 'v2/sessions/2026/11/27/12-00-00-000-session_dup_canonical/messages.jsonl') }],
  });
  assert.equal(busyRes.issues.length, 1);
  assert.equal(busyRes.units.length, 0);
  assert.deepEqual(busyRes.retained, [minimaxSessionId('mvs_dup')]);
});

test('fast === full equivalence across appends, llm_checkpoint, tool_archive, double compaction, rewind, and SQLite title updates', () => {
  const root = makeTempDir('obelisk-minimax-equiv-');
  const rel = '2026/11/27/20-00-00-000-session_ZXF1aXY';
  const sid = 'mvs_equiv';
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  const cursors = new Map();

  const runIncremental = () => {
    const provider = createMinimaxProvider({ rootDir: root });
    const units = provider.discover({
      lastCursor: (key) => cursors.get(key) ?? null,
      indexedSessions: () => db.prepare("SELECT id AS sessionId, jsonl_path AS jsonlPath FROM sessions WHERE source = 'minimax'").all(),
    });
    for (const unit of units) {
      const next = indexUnit(db, provider, unit, cursors.get(unit.key) ?? null);
      cursors.set(unit.key, next);
    }
    return units.length;
  };

  const assertEquiv = (label) => {
    const inc = snapshotTables(db);
    const full = indexAllWithFreshDb(root);
    assert.deepEqual(inc, full, `fast === full mismatch at: ${label}`);
  };

  const u1 = { message_id: 'msg-user-v1-1', turn_id: 't1', message: { role: 'user', content: [{ type: 'text', text: 'first' }], timestamp: 1795810000000 } };
  const a1 = { message_id: 'msg-a1', turn_id: 't1', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: '/workspace/demo/a.txt' } }], model: 'm1', usage: { input: 10, output: 5 }, timestamp: 1795810001000 } };
  const tr1 = { message_id: 'msg-tr1', turn_id: 't1', message: { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text: 'FULL_ORIGINAL_TOOL_OUTPUT' }], isError: false, timestamp: 1795810002000 } };
  const a2 = { message_id: 'msg-a2', turn_id: 't1', message: { role: 'assistant', content: [{ type: 'text', text: 'read done' }], model: 'm1', usage: { input: 20, output: 8 }, timestamp: 1795810003000 } };

  // Step 1: Initial turn + torn trailing line
  const sessionDir = writeSessionFiles(root, rel, { sessionId: sid, messages: [u1, a1] });
  writeFileSync(join(sessionDir, 'messages.jsonl'), `${JSON.stringify(u1)}\n${JSON.stringify(a1)}\n{"partial":true`);
  runIncremental();

  // Complete torn line + append tr1, a2 (Case A)
  writeSessionFiles(root, rel, { sessionId: sid, messages: [u1, a1, tr1, a2] });
  runIncremental();
  assertEquiv('after Case A append');

  // No-op run must discover 0 units
  assert.equal(runIncremental(), 0);

  // Step 2: Single-step tool_archive compaction (Case B) — rewrites tr1 content to receipt
  const tr1Archived = { ...tr1, message: { ...tr1.message, content: [{ type: 'text', text: '[Archived]' }] } };
  const u2 = { message_id: 'msg-user-v1-2', turn_id: 't2', message: { role: 'user', content: [{ type: 'text', text: 'second' }], timestamp: 1795810004000 } };
  const g0Snap = 'g000000000000--cmp_1.jsonl';
  writeSessionFiles(root, rel, {
    sessionId: sid,
    messages: [
      { ...u1, history_artifact: { schemaVersion: 1, generation: 1, producedBy: 'tool_archive', parentSnapshot: { generation: 0, compactionId: 'cmp_1', revision: 'sha256:' + '0'.repeat(64) } } },
      a1,
      tr1Archived,
      a2,
      u2,
    ],
    snapshots: { [g0Snap]: [u1, a1, tr1, a2] },
  });
  runIncremental();
  assertEquiv('after Case B tool_archive');
  // Original un-archived tool output is preserved in Obelisk!
  assert.equal(db.prepare("SELECT content FROM tool_results WHERE tool_use_id LIKE '%:c1'").get().content, 'FULL_ORIGINAL_TOOL_OUTPUT');

  // Step 3: Single-step llm_checkpoint compaction (Case B)
  const u3 = { message_id: 'msg-user-v1-3', turn_id: 't3', message: { role: 'user', content: [{ type: 'text', text: 'third' }], timestamp: 1795810005000 } };
  const s1 = {
    message_id: 'msg-sum-1',
    turn_id: 't3:compaction',
    message: { role: 'compactionSummary', summary: 'Summary g2', tokensBefore: 500, timestamp: 1795810005500 },
    history_artifact: { schemaVersion: 1, generation: 2, producedBy: 'llm_checkpoint', parentSnapshot: { generation: 1, compactionId: 'cmp_2', revision: 'sha256:' + '1'.repeat(64) } },
  };
  const a3 = { message_id: 'msg-a3', turn_id: 't3', message: { role: 'assistant', content: [{ type: 'text', text: 'after checkpoint' }], model: 'm1', usage: { input: 30, output: 10 }, timestamp: 1795810006000 } };
  writeSessionFiles(root, rel, {
    sessionId: sid,
    messages: [s1, u3, a3],
    snapshots: {
      [g0Snap]: [u1, a1, tr1, a2],
      'g000000000001--cmp_2.jsonl': [
        { ...u1, history_artifact: { schemaVersion: 1, generation: 1, producedBy: 'tool_archive', parentSnapshot: { generation: 0, compactionId: 'cmp_1', revision: 'sha256:' + '0'.repeat(64) } } },
        a1, tr1Archived, a2, u2, u3,
      ],
    },
  });
  runIncremental();
  assertEquiv('after Case B llm_checkpoint');

  // Step 4: SQLite metadata update (title) + Rewind (generation drops from 2 -> 1, orphan g1 ignored!)
  createSqliteStore(root, [{ session_id: sid, title: 'Rewound Session', history_relative_dir: rel }]);
  writeSessionFiles(root, rel, {
    sessionId: sid,
    messages: [
      { ...u1, history_artifact: { schemaVersion: 1, generation: 1, producedBy: 'tool_archive', parentSnapshot: { generation: 0, compactionId: 'cmp_1', revision: 'sha256:' + '0'.repeat(64) } } },
      a1, tr1Archived, a2, u2,
    ],
    snapshots: {
      [g0Snap]: [u1, a1, tr1, a2],
      // Orphan snapshot left behind after rewind — not referenced by parentSnapshot chain!
      'g000000000001--cmp_2.jsonl': [u1, a1, tr1Archived, a2, u2, u3],
      'env-g000000000000--cmp_1.json': ['{"schemaVersion":1}'],
    },
  });
  runIncremental();
  assertEquiv('after SQLite title + rewind ignoring orphan snapshot');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM summaries').get().c, 0, 'rewound llm_checkpoint summary retracted');

  db.close();
});

test('tombstones, root scoping, EACCES inventory protection, and raw() lookup', () => {
  const root = makeTempDir('obelisk-minimax-tombstone-');
  const otherRoot = makeTempDir('obelisk-minimax-other-');
  const rel = '2026/11/27/20-00-00-000-session_dG9tYg';
  const sessionDir = writeSessionFiles(root, rel, {
    sessionId: 'mvs_tomb',
    messages: [
      {
        message_id: 'msg-user-v1-t1',
        turn_id: 't1',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '<system-reminder>x</system-reminder>\n\nreal prompt' }],
          canonicalTextRange: { startOffset: 38, endOffset: 49 },
          timestamp: 1795810000000,
        },
      },
    ],
  });

  const provider = createMinimaxProvider({ rootDir: root });
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  const cursors = new Map();

  for (const unit of provider.discover({ lastCursor: (k) => cursors.get(k) ?? null })) {
    cursors.set(unit.key, indexUnit(db, provider, unit, null));
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE source = 'minimax'").get().c, 1);

  // raw() returns full JSONL line and canonical user text, and rejects traversal
  const sesRow = db.prepare("SELECT * FROM sessions WHERE source = 'minimax'").get();
  const msgRow = db.prepare("SELECT uuid FROM messages WHERE source = 'minimax'").get();
  const rawRes = provider.raw({ source: 'minimax', messageUuid: msgRow.uuid, session: sesRow, agentId: null });
  assert.equal(rawRes.messageText, 'real prompt');
  assert.match(rawRes.text, /"message_id":"msg-user-v1-t1"/);
  assert.equal(
    provider.raw({ source: 'minimax', messageUuid: msgRow.uuid, session: { ...sesRow, jsonl_path: join(otherRoot, 'messages.jsonl') }, agentId: null }),
    null,
  );

  // Deleting session dir retracts only sessions inside `root` (not `otherRoot`) and converges
  rmSync(sessionDir, { recursive: true, force: true });
  const otherIndexed = { sessionId: minimaxSessionId('mvs_other'), jsonlPath: join(otherRoot, 'v2/sessions/2026/11/27/x/messages.jsonl') };
  const tombUnits = provider.discover({
    lastCursor: (k) => cursors.get(k) ?? null,
    indexedSessions: () => [
      { sessionId: sesRow.id, jsonlPath: sesRow.jsonl_path },
      otherIndexed,
    ],
  });
  assert.equal(tombUnits.length, 1);
  assert.deepEqual(tombUnits[0].retractSessionIds, [sesRow.id]);
  const tombCursor = indexUnit(db, provider, tombUnits[0], cursors.get(tombUnits[0].key) ?? null);
  assert.ok(tombCursor !== null, 'tombstone leaves non-null cursor');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE source = 'minimax'").get().c, 0);

  // EACCES on sessions dir with an indexed session reports incomplete inventory and emits 0 tombstones
  if (process.platform !== 'win32') {
    const lockedRoot = makeTempDir('obelisk-minimax-eacces-');
    const lockedSessions = join(lockedRoot, 'v2', 'sessions');
    mkdirSync(lockedSessions, { recursive: true });
    chmodSync(lockedSessions, 0o000);
    try {
      const lockedProvider = createMinimaxProvider({ rootDir: lockedRoot });
      const res = collectAll(lockedProvider, {
        indexedSessions: () => [{ sessionId: 'minimax:x', jsonlPath: join(lockedSessions, '2026/11/27/x/messages.jsonl') }],
      });
      assert.ok(res.issues.length > 0);
      assert.equal(res.units.length, 0);
    } finally {
      chmodSync(lockedSessions, 0o755);
    }
  }
  db.close();
});

test('outermost entry points: built CLI and app buildIndex with live WAL SQLite store', () => {
  const home = makeTempDir('obelisk-minimax-e2e-');
  const dataRoot = join(home, 'custom-minimax');
  seedFixtureSession(dataRoot);
  const walDbPath = createSqliteStore(dataRoot, [{
    session_id: 'mvs_ac8623202d1045b6a290a2548b686c7d',
    title: 'CLI & App E2E',
    workspace_dir: '/workspace/demo',
    history_relative_dir: '2026/11/27/20-12-46-734-session_bXZzX2FjODYyMzIwMmQxMDQ1YjZhMjkwYTI1NDhiNjg2Yzdk',
  }]);

  // Keep WAL store open concurrently while built CLI and app buildIndex read it
  const liveWriter = new BetterSqlite3(walDbPath);
  try {
    const queryFile = join(home, 'q.mjs');
    writeFileSync(queryFile, "return { sessions: sessions({ source: 'minimax' }), hits: search('OK_RESPONSE_19', { source: 'minimax' }) };");
    const env = { MINIMAX_DATA_DIR: dataRoot };

    const buildRes = runCli(['--build'], { home, env });
    assert.equal(buildRes.status, 0, buildRes.stderr + buildRes.stdout);

    const queryRes = runCli(['--query', queryFile], { home, env });
    assert.equal(queryRes.status, 0, queryRes.stderr + queryRes.stdout);
    const parsed = JSON.parse(queryRes.stdout);
    assert.equal(parsed.sessions.length, 1);
    assert.equal(parsed.sessions[0].title, 'CLI & App E2E');
    assert.equal(parsed.hits.length, 1);

    // App buildIndex using better-sqlite3
    const appDbPath = join(home, 'app-index.sqlite');
    const appRes = buildAppIndex({
      force: true,
      claudeDir: join(home, '.missing-claude'),
      codexDir: join(home, '.missing-codex'),
      projectsDir: join(home, '.missing-claude', 'projects'),
      providerRoots: { minimax: dataRoot },
      dbPath: appDbPath,
      DatabaseImpl: BetterSqlite3,
    });
    assert.equal(appRes.complete, true);
    const appDb = new BetterSqlite3(appDbPath, { readonly: true });
    try {
      const appSessions = appDb.prepare("SELECT title FROM sessions WHERE source = 'minimax'").all();
      assert.deepEqual(appSessions.map((s) => s.title), ['CLI & App E2E']);
    } finally {
      appDb.close();
    }
  } finally {
    liveWriter.close();
  }
});

test('started_by and session filtering: no-SQLite human sessions, archived conversation roots, task-hidden vs peek/cron', () => {
  // 1. No SQLite at all -> human session must have started_by: null and USF human turns
  const noSqlRoot = makeTempDir('obelisk-minimax-nosql-');
  writeSessionFiles(noSqlRoot, '2026/11/27/10-00-00-000-session_nosql', {
    sessionId: 'mvs_nosql',
    messages: [
      { message_id: 'u1', turn_id: 't1', message: { role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: 1795810000000 } },
      { message_id: 'a1', turn_id: 't1', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: 1795810001000 } },
      { message_id: 'u2', turn_id: 't2', message: { role: 'user', content: [{ type: 'text', text: 'turn 2' }], timestamp: 1795810002000 } },
    ],
  });
  const noSqlProvider = createMinimaxProvider({ rootDir: noSqlRoot });
  const noSqlUnits = noSqlProvider.discover({ lastCursor: () => null });
  assert.equal(noSqlUnits.length, 1);
  const noSqlRecs = [...noSqlProvider.parse(noSqlUnits[0], null)];
  assertHarnessConformance(noSqlRecs);
  const noSqlSession = noSqlRecs.find((r) => r.kind === 'session');
  assert.equal(noSqlSession.started_by, null);
  const usf = assembleUsf(noSqlRecs);
  assert.equal(usf.sessions[0].session.turns.length, 2);
  assert.equal(usf.sessions[0].session.turns[0].steps[0].by, 'human');

  // 2. With SQLite: archived conversation with parent_session_id -> null; task with visibility=hidden -> agent; peek/cron/non-task hidden -> excluded
  const sqlRoot = makeTempDir('obelisk-minimax-filter-');
  const sessions = [
    { id: 'mvs_conv_branch', kind: 'conversation', vis: 'visible', parent: 'mvs_next_root' },
    { id: 'mvs_task_hidden', kind: 'task', vis: 'hidden', parent: 'mvs_conv_branch' },
    { id: 'mvs_peek', kind: 'peek', vis: 'hidden', parent: null },
    { id: 'mvs_cron', kind: 'cron', vis: 'visible', parent: null },
    { id: 'mvs_other_hidden', kind: 'conversation', vis: 'hidden', parent: null },
  ];
  for (const s of sessions) {
    writeSessionFiles(sqlRoot, `2026/11/27/10-00-00-000-session_${s.id}`, {
      sessionId: s.id,
      messages: [
        { message_id: `u_${s.id}`, turn_id: 't1', message: { role: 'user', content: [{ type: 'text', text: `prompt ${s.id}` }], timestamp: 1795810000000 } },
      ],
    });
  }
  createSqliteStore(sqlRoot, sessions.map((s) => ({
    session_id: s.id,
    session_kind: s.kind,
    visibility: s.vis,
    parent_session_id: s.parent,
    history_relative_dir: `2026/11/27/10-00-00-000-session_${s.id}`,
  })));
  const sqlProvider = createMinimaxProvider({ rootDir: sqlRoot });
  const sqlUnits = sqlProvider.discover({ lastCursor: () => null });
  const byId = new Map(sqlUnits.map((u) => [u.sessionId, u]));
  assert.deepEqual([...byId.keys()].sort(), [
    minimaxSessionId('mvs_conv_branch'),
    minimaxSessionId('mvs_task_hidden'),
  ]);
  assert.equal(byId.get(minimaxSessionId('mvs_conv_branch')).meta.startedBy, null);
  assert.equal(byId.get(minimaxSessionId('mvs_task_hidden')).meta.startedBy, 'agent');
});

test('SQLite fail-closed when present but unreadable: corrupt, WAL-without-SHM on readonly dir, and EACCES', () => {
  const root = makeTempDir('obelisk-minimax-sqlite-fail-');
  writeSessionFiles(root, '2026/11/27/10-00-00-000-session_vis', {
    sessionId: 'mvs_vis',
    messages: [{ message_id: 'u1', turn_id: 't1', message: { role: 'user', content: [{ type: 'text', text: 'visible prompt' }], timestamp: 1795810000000 } }],
  });
  writeSessionFiles(root, '2026/11/27/10-00-00-000-session_hid', {
    sessionId: 'mvs_hid',
    messages: [{ message_id: 'u2', turn_id: 't1', message: { role: 'user', content: [{ type: 'text', text: 'SECRET_PEEK' }], timestamp: 1795810000000 } }],
  });
  const sqPath = createSqliteStore(root, [
    { session_id: 'mvs_vis', session_kind: 'conversation', visibility: 'visible', title: 'Stored Title', history_relative_dir: '2026/11/27/10-00-00-000-session_vis' },
    { session_id: 'mvs_hid', session_kind: 'peek', visibility: 'hidden', title: 'Peek', history_relative_dir: '2026/11/27/10-00-00-000-session_hid' },
  ]);

  const provider = createMinimaxProvider({ rootDir: root });
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  for (const u of provider.discover({ lastCursor: () => null })) {
    indexUnit(db, provider, u, null);
  }
  const indexed = () => db.prepare("SELECT id AS sessionId, jsonl_path AS jsonlPath FROM sessions WHERE source = 'minimax'").all();
  assert.equal(indexed().length, 1);

  // 1. WAL-without-SHM on 0o555 dir (skip on root uid)
  if (process.getuid?.() !== 0) {
    const sqDir = join(root, 'v2', 'sqlite');
    writeFileSync(`${sqPath}-wal`, Buffer.from('non-empty-wal'));
    rmSync(`${sqPath}-shm`, { force: true });
    chmodSync(sqDir, 0o555);
    try {
      const res = collectAll(provider, { indexedSessions: indexed });
      assert.equal(res.units.length, 0);
      assert.equal(res.issues.length, 1);
      assert.deepEqual(res.retained, [minimaxSessionId('mvs_vis')]);
    } finally {
      chmodSync(sqDir, 0o755);
      rmSync(`${sqPath}-wal`, { force: true });
    }
  }

  // 2. Corrupt SQLite file
  writeFileSync(sqPath, 'not a sqlite file');
  const corruptRes = collectAll(provider, { indexedSessions: indexed });
  assert.equal(corruptRes.units.length, 0);
  assert.equal(corruptRes.issues.length, 1);
  assert.deepEqual(corruptRes.retained, [minimaxSessionId('mvs_vis')]);
});

test('3-tier equivalence: metadata-only patch, strict mid-file rewrite, historical dup id, multi-kept llm_checkpoint, tool_archive marker-before-watermark, and cross-dir switch', () => {
  const root = makeTempDir('obelisk-minimax-3tier-');
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  const cursors = new Map();

  const runIncremental = (opts = {}) => {
    const provider = createMinimaxProvider({ rootDir: root });
    const units = provider.discover({
      lastCursor: (k) => cursors.get(k) ?? null,
      indexedSessions: () => db.prepare("SELECT id AS sessionId, jsonl_path AS jsonlPath FROM sessions WHERE source = 'minimax'").all(),
      readMode: opts.readMode,
    });
    const emittedKinds = [];
    for (const unit of units) {
      const gen = provider.parse(unit, cursors.get(unit.key) ?? null);
      const collected = [];
      let step = gen.next();
      while (!step.done) {
        collected.push(step.value);
        emittedKinds.push(step.value.kind);
        step = gen.next();
      }
      function* replay() {
        for (const r of collected) yield r;
        return step.value;
      }
      const next = persist(db, unit, replay());
      cursors.set(unit.key, next);
    }
    return { count: units.length, emittedKinds };
  };

  const assertEquiv = (label) => {
    const inc = snapshotTables(db);
    const full = indexAllWithFreshDb(root);
    assert.deepEqual(inc, full, `fast === full mismatch at: ${label}`);
  };

  const sid = 'mvs_3tier';
  const rel1 = '2026/11/27/10-00-00-000-session_dir1';
  const u1 = { message_id: 'u1', turn_id: 't1', message: { role: 'user', content: [{ type: 'text', text: 'ORIGINAL_PROMPT' }], timestamp: 1795810000000 } };
  const a1 = { message_id: 'a1', turn_id: 't1', message: { role: 'assistant', content: [{ type: 'text', text: 'ans1' }], model: 'm1', usage: { input: 10, output: 5 }, timestamp: 1795810001000 } };
  const u2 = { message_id: 'u2', turn_id: 't2', message: { role: 'user', content: [{ type: 'text', text: 'second' }], timestamp: 1795810002000 } };
  const a2 = { message_id: 'a2', turn_id: 't2', message: { role: 'assistant', content: [{ type: 'text', text: 'ans2' }], model: 'm1', usage: { input: 10, output: 5 }, timestamp: 1795810003000 } };

  // Step 1: initial index with SQLite row
  const dir1 = writeSessionFiles(root, rel1, { sessionId: sid, messages: [u1, a1, u2, a2] });
  createSqliteStore(root, [{ session_id: sid, session_kind: 'conversation', visibility: 'visible', title: null, updated_at_ms: 1795810003000, history_relative_dir: rel1 }]);
  runIncremental();
  assertEquiv('initial');

  // Step 2: metadata-only SQLite title + updated_at_ms update -> zero delete-session!
  createSqliteStore(root, [{ session_id: sid, session_kind: 'conversation', visibility: 'visible', title: 'Async Title', updated_at_ms: 1795810099000, history_relative_dir: rel1 }]);
  const metaPatch = runIncremental();
  assert.deepEqual(metaPatch.emittedKinds, ['session']);
  assertEquiv('metadata-only patch');

  // Step 3: Case A append with historical duplicate message_id (u1) -> skipped cleanly
  const u3 = { message_id: 'u3', turn_id: 't3', message: { role: 'user', content: [{ type: 'text', text: 'third' }], timestamp: 1795810100000 } };
  writeSessionFiles(root, rel1, { sessionId: sid, messages: [u1, a1, u2, a2, u1, u3] });
  const dupAppend = runIncremental();
  assert.equal(dupAppend.emittedKinds.includes('delete-session'), false);
  assertEquiv('Case A duplicate message_id');

  // Step 4: readMode: 'strict' catches mid-file same-length rewrite well before the last 512 bytes
  const pad = 'x'.repeat(700);
  const longA2 = { message_id: 'a2', turn_id: 't2', message: { role: 'assistant', content: [{ type: 'text', text: pad }], model: 'm1', usage: { input: 10, output: 5 }, timestamp: 1795810003000 } };
  writeSessionFiles(root, rel1, { sessionId: sid, messages: [u1, a1, u2, longA2, u3] });
  runIncremental();
  assertEquiv('before strict rewrite');
  const mutatedU1 = { message_id: 'u1', turn_id: 't1', message: { role: 'user', content: [{ type: 'text', text: 'MUTATED__PROMPT' }], timestamp: 1795810000000 } };
  writeSessionFiles(root, rel1, { sessionId: sid, messages: [mutatedU1, a1, u2, longA2, u3] });
  runIncremental({ readMode: 'strict' });
  assertEquiv('after strict mid-file rewrite');

  // Step 5: llm_checkpoint keeping >1 historical message (u2, longA2) + u3
  const s1 = {
    message_id: 's1',
    turn_id: 't3:compaction',
    message: { role: 'compactionSummary', summary: 'Compacted', tokensBefore: 100, timestamp: 1795810101000 },
    history_artifact: { schemaVersion: 1, generation: 1, producedBy: 'llm_checkpoint', parentSnapshot: { generation: 0, compactionId: 'cmp_1', revision: 'sha256:0' } },
  };
  writeSessionFiles(root, rel1, {
    sessionId: sid,
    messages: [s1, u2, longA2, u3],
    snapshots: { 'g000000000000--cmp_1.jsonl': [mutatedU1, a1, u2, longA2, u3] },
  });
  runIncremental();
  assertEquiv('llm_checkpoint >1 kept msg');

  // Step 6: tool_archive inserting placedMarker before watermarkId (u3)
  const placedMarker = { message_id: 'm_placed', turn_id: 't4', message: { role: 'custom', customType: 'session_identity_reminder', display: false, content: [{ type: 'text', text: 'rem' }], timestamp: 1795810102000 } };
  const s2Head = { ...s1, history_artifact: { schemaVersion: 1, generation: 2, producedBy: 'tool_archive', parentSnapshot: { generation: 1, compactionId: 'cmp_2', revision: 'sha256:1' } } };
  writeSessionFiles(root, rel1, {
    sessionId: sid,
    messages: [s2Head, u2, longA2, placedMarker, u3],
    snapshots: {
      'g000000000000--cmp_1.jsonl': [mutatedU1, a1, u2, longA2, u3],
      'g000000000001--cmp_2.jsonl': [s1, u2, longA2, u3],
    },
  });
  runIncremental();
  assertEquiv('tool_archive placedMarker before watermarkId');

  // Step 7: cross-directory winner switch dir1 -> dir2, then delete dir2 so dir1 wins again
  const rel2 = '2026/11/28/10-00-00-000-session_dir2';
  const uNew = { message_id: 'u_dir2', turn_id: 't1', message: { role: 'user', content: [{ type: 'text', text: 'from dir2' }], timestamp: 1795810200000 } };
  const dir2 = writeSessionFiles(root, rel2, { sessionId: sid, messages: [uNew] });
  createSqliteStore(root, [{ session_id: sid, session_kind: 'conversation', visibility: 'visible', title: 'Async Title', updated_at_ms: 1795810200000, history_relative_dir: rel2 }]);
  runIncremental();
  assertEquiv('winner switched dir1 -> dir2');

  rmSync(dir2, { recursive: true, force: true });
  createSqliteStore(root, [{ session_id: sid, session_kind: 'conversation', visibility: 'visible', title: 'Async Title', updated_at_ms: 1795810200000, history_relative_dir: rel1 }]);
  runIncremental();
  assertEquiv('dir2 deleted, dir1 wins again');
  assert.ok(dir1);
});

test('upstream message shapes: backgroundTaskOrigin, multimodal canonicalTextRange + surrogate pair ADR-0007, worktree fork ts=0, archonCompaction v2, empty thinking, raw() toolCall', () => {
  const root = makeTempDir('obelisk-minimax-shapes-');
  const sid = 'mvs_shapes';
  const rel = '2026/11/27/10-00-00-000-session_shapes';
  const surrogateStr = '<rem>\ud83d\udc4b hi'; // 👋 at index 5..6; startOffset 6 cuts surrogate pair
  const sessionDir = writeSessionFiles(root, rel, {
    sessionId: sid,
    messages: [
      // Worktree fork control message with timestamp: 0
      {
        message_id: 'm_fork',
        turn_id: 't0',
        message: { role: 'user', content: '<system-reminder>\nForked into worktree.\n</system-reminder>', timestamp: 0 },
      },
      // Background task notification with hostMetadata.backgroundTaskOrigin & zero-length canonicalTextRange
      {
        message_id: 'm_bg',
        turn_id: 't0b',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '<background-task-finished>build done</background-task-finished>' }],
          canonicalTextRange: { startOffset: 59, endOffset: 59 },
          hostMetadata: { backgroundTaskOrigin: { taskId: 'bg1' } },
          timestamp: 1795810000000,
        },
      },
      // Multimodal user message with canonicalTextRange + image + video
      {
        message_id: 'm_multi',
        turn_id: 't1',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '<system-reminder>x</system-reminder>\n\nDescribe media' },
            { type: 'image', mimeType: 'image/png', data: 'AAAA' },
            { type: 'video', mimeType: 'video/mp4', data: 'BBBB' },
          ],
          canonicalTextRange: { startOffset: 38, endOffset: 52 },
          timestamp: 1795810001000,
        },
      },
      // Assistant with empty thinking + toolCall + text
      {
        message_id: 'm_asst',
        turn_id: 't1',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '' },
            { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: '/tmp/a' } },
            { type: 'text', text: 'FINAL_ANSWER' },
          ],
          model: 'm1',
          timestamp: 1795810002000,
        },
      },
      // archonCompaction v2 marker on real user message (no summary string)
      {
        message_id: 'm_archon_u',
        turn_id: 't2',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'after archon marker' }],
          archonCompaction: { schemaVersion: 2, generation: 0 },
          timestamp: 1795810003000,
        },
      },
      // Mid-surrogate canonicalTextRange ADR-0007 round-trip
      {
        message_id: 'm_surr',
        turn_id: 't3',
        message: {
          role: 'user',
          content: [{ type: 'text', text: surrogateStr }],
          canonicalTextRange: { startOffset: 6, endOffset: surrogateStr.length },
          timestamp: 1795810004000,
        },
      },
    ],
  });

  const provider = createMinimaxProvider({ rootDir: root });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const directRecords = [...provider.parse(unit, null)];
  assertHarnessConformance(directRecords);

  const db = new DatabaseSync(':memory:');
  installSchema(db);
  indexUnit(db, provider, unit, null);

  const ses = db.prepare("SELECT * FROM sessions WHERE source = 'minimax'").get();
  // timestamp: 0 must NOT pull started_at to 1970; title must NOT be bg notification or fork reminder
  assert.equal(ses.started_at, new Date(1795810000000).toISOString());
  assert.equal(ses.title, 'Describe media');

  const msgs = db.prepare("SELECT uuid, role, text, content_type, is_meta, harness_kind, visibility FROM messages WHERE source = 'minimax' ORDER BY uuid").all();
  const byUuid = new Map(msgs.map((m) => [m.uuid, m]));
  assert.equal(byUuid.get(minimaxSessionId(sid) + ':m_fork:b0000').visibility, 'hidden');
  assert.equal(byUuid.get(minimaxSessionId(sid) + ':m_fork:b0000').harness_kind, 'reminder');

  const bgRow = byUuid.get(minimaxSessionId(sid) + ':m_bg:b0000');
  assert.equal(bgRow.harness_kind, 'notification');
  assert.equal(bgRow.is_meta, 1);
  assert.equal(bgRow.text, '<background-task-finished>build done</background-task-finished>');

  assert.equal(byUuid.get(minimaxSessionId(sid) + ':m_multi:b0000').text, 'Describe media');
  assert.equal(byUuid.get(minimaxSessionId(sid) + ':m_multi:b0001').content_type, 'image');
  assert.equal(byUuid.get(minimaxSessionId(sid) + ':m_multi:b0002').content_type, 'video');

  // Empty thinking must be skipped (no b0000 unknown/is_meta row on m_asst)
  assert.equal(byUuid.get(minimaxSessionId(sid) + ':m_asst:b0000'), undefined);
  assert.equal(byUuid.get(minimaxSessionId(sid) + ':m_asst:b0001').content_type, 'tool_use');

  // archonCompaction v2 without summary must project real user message
  assert.equal(byUuid.get(minimaxSessionId(sid) + ':m_archon_u:b0000').text, 'after archon marker');

  // ADR-0007: direct in-memory surrogate replacement === SQLite persisted text
  const directSurr = directRecords.find((r) => r.kind === 'message' && r.uuid.endsWith(':m_surr:b0000'));
  const dbSurr = byUuid.get(minimaxSessionId(sid) + ':m_surr:b0000');
  assert.equal(directSurr.text, dbSurr.text);

  // raw() on assistant toolCall block must return messageText: null (never sibling FINAL_ANSWER)
  const rawToolCall = provider.raw({
    source: 'minimax',
    messageUuid: minimaxSessionId(sid) + ':m_asst:b0001',
    session: ses,
    agentId: null,
  });
  assert.equal(rawToolCall.messageText, null);
  assert.ok(sessionDir);
});

test('manifest/history_artifact gating, corrupt manifest resilience, symlinks, large/blank first line, and relative env root', () => {
  // 1. Relative MINIMAX_DATA_DIR resolves to absolute path
  const abs = defaultMinimaxRoot({ homeDir: '/tmp/h', env: { MINIMAX_DATA_DIR: './rel-minimax' } });
  assert.equal(isAbsolute(abs), true);

  // 2. Manifest schemaVersion ("99", -1, 2), corrupt {}, SyntaxError, history_artifact.schemaVersion=2, symlink rejection
  const root = makeTempDir('obelisk-minimax-gate-');
  const outsideDir = makeTempDir('obelisk-minimax-outside-');
  writeFileSync(join(outsideDir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, sessionId: 'mvs_outside' }));
  writeFileSync(join(outsideDir, 'messages.jsonl'), JSON.stringify({ message_id: 'u0', turn_id: 't0', message: { role: 'user', content: 'SECRET', timestamp: 1795810000000 } }) + '\n');

  // Valid live session
  writeSessionFiles(root, '2026/11/27/10-00-00-000-session_ok', {
    sessionId: 'mvs_ok',
    messages: [{ message_id: 'u_ok', turn_id: 't1', message: { role: 'user', content: 'ok', timestamp: 1795810000000 } }],
  });

  // Indexed session whose manifest later turns into `{}` (corrupt)
  const corruptDir = writeSessionFiles(root, '2026/11/27/10-00-00-000-session_corrupt', {
    sessionId: 'mvs_corrupt',
    messages: [{ message_id: 'u_c', turn_id: 't1', message: { role: 'user', content: 'kept', timestamp: 1795810000000 } }],
  });

  const provider = createMinimaxProvider({ rootDir: root });
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  for (const u of provider.discover({ lastCursor: () => null })) indexUnit(db, provider, u, null);
  const indexed = () => db.prepare("SELECT id AS sessionId, jsonl_path AS jsonlPath FROM sessions WHERE source = 'minimax'").all();
  assert.equal(indexed().length, 2);

  // Break corruptDir manifest to {} and add bad-version/syntax/symlink siblings
  writeFileSync(join(corruptDir, 'manifest.json'), '{}');

  const badStrDir = join(root, 'v2/sessions/2026/11/27/10-00-00-000-session_str99');
  mkdirSync(badStrDir, { recursive: true });
  writeFileSync(join(badStrDir, 'manifest.json'), JSON.stringify({ schemaVersion: '99', sessionId: 'mvs_str99' }));
  writeFileSync(join(badStrDir, 'messages.jsonl'), JSON.stringify({ message_id: 'u', turn_id: 't', message: { role: 'user', content: 'x' } }) + '\n');

  const negDir = join(root, 'v2/sessions/2026/11/27/10-00-00-000-session_neg');
  mkdirSync(negDir, { recursive: true });
  writeFileSync(join(negDir, 'manifest.json'), JSON.stringify({ schemaVersion: -1, sessionId: 'mvs_neg' }));
  writeFileSync(join(negDir, 'messages.jsonl'), JSON.stringify({ message_id: 'u', turn_id: 't', message: { role: 'user', content: 'x' } }) + '\n');

  const syntaxDir = join(root, 'v2/sessions/2026/11/27/10-00-00-000-session_syntax');
  mkdirSync(syntaxDir, { recursive: true });
  writeFileSync(join(syntaxDir, 'manifest.json'), '{bad json');

  const symDir = join(root, 'v2/sessions/2026/11/27/10-00-00-000-session_sym');
  mkdirSync(symDir, { recursive: true });
  symlinkSync(join(outsideDir, 'manifest.json'), join(symDir, 'manifest.json'));
  symlinkSync(join(outsideDir, 'messages.jsonl'), join(symDir, 'messages.jsonl'));

  const artV2Dir = writeSessionFiles(root, '2026/11/27/10-00-00-000-session_artv2', {
    sessionId: 'mvs_artv2',
    messages: [{
      message_id: 'u_v2',
      turn_id: 't1',
      message: { role: 'user', content: 'v2' },
      history_artifact: { schemaVersion: 2, generation: 1 },
    }],
  });
  assert.ok(artV2Dir);

  const res = collectAll(provider, { indexedSessions: indexed });
  // SyntaxError and corrupt {} must NOT mark inventory incomplete (issues === 0), and mvs_corrupt must be retained!
  assert.equal(res.issues.length, 0);
  assert.ok(res.skipped.length >= 5);
  assert.ok(res.retained.includes(minimaxSessionId('mvs_corrupt')));
  assert.deepEqual(res.units.map((u) => u.sessionId), [minimaxSessionId('mvs_ok')]);

  // 3. Large (>5 MiB) first line & blank leading line in readFirstEnvelope still resolve g0 snapshot
  const bigRoot = makeTempDir('obelisk-minimax-bighead-');
  const bigStr = 'B'.repeat(5 * 1024 * 1024);
  const bigDir = writeSessionFiles(bigRoot, '2026/11/27/10-00-00-000-session_big', {
    sessionId: 'mvs_big',
    messages: [
      '',
      {
        message_id: 'u_big',
        turn_id: 't2',
        message: { role: 'user', content: [{ type: 'text', text: bigStr }], timestamp: 1795810002000 },
        history_artifact: { schemaVersion: 1, generation: 1, producedBy: 'llm_checkpoint', parentSnapshot: { generation: 0, compactionId: 'cmp_big' } },
      },
    ],
    snapshots: {
      'g000000000000--cmp_big.jsonl': [
        { message_id: 'u_g0', turn_id: 't1', message: { role: 'user', content: [{ type: 'text', text: 'from g0' }], timestamp: 1795810001000 } },
      ],
    },
  });
  assert.ok(bigDir);
  const bigProv = createMinimaxProvider({ rootDir: bigRoot });
  const bigUnit = bigProv.discover({ lastCursor: () => null })[0];
  const bigRecs = [...bigProv.parse(bigUnit, null)];
  assert.ok(bigRecs.some((r) => r.kind === 'message' && r.uuid.endsWith(':u_g0:b0000')));

  // 4. Symlinked rootDir matches physical changedPaths
  const realRoot = makeTempDir('obelisk-minimax-realroot-');
  const linkHolder = makeTempDir('obelisk-minimax-linkholder-');
  const linkRoot = join(linkHolder, 'mm-link');
  symlinkSync(realRoot, linkRoot);
  const symSessDir = writeSessionFiles(realRoot, '2026/11/27/10-00-00-000-session_link', {
    sessionId: 'mvs_link',
    messages: [{ message_id: 'u1', turn_id: 't1', message: { role: 'user', content: 'hi', timestamp: 1795810000000 } }],
  });
  const linkProv = createMinimaxProvider({ rootDir: linkRoot });
  const changedUnits = linkProv.discover({
    lastCursor: () => null,
    changedPaths: [join(symSessDir, 'messages.jsonl')],
  });
  assert.equal(changedUnits.length, 1);
});

test('Round 2 fixes: edit file_path, skill presentation, snapshots symlink/EACCES, 0-byte/legacy SQLite, >10k dedup, >64MiB head, strict prefixVerified, surrogates, and rawBlockText', () => {
  // 1. edit({ file_path }) & skill presentation
  const editRoot = makeTempDir('obelisk-minimax-edit-');
  writeSessionFiles(editRoot, '2026/11/27/10-00-00-000-session_edit', {
    sessionId: 'mvs_edit',
    messages: [
      { message_id: 'u1', turn_id: 't1', message: { role: 'user', content: 'edit main.ts', timestamp: 1795810000000 } },
      {
        message_id: 'a1',
        turn_id: 't1',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'tc_edit', name: 'edit', arguments: { file_path: '/workspace/demo/main.ts', old_string: 'a', new_string: 'b' } },
            { type: 'toolCall', id: 'tc_skill', name: 'skill', arguments: { name: 'tdd' } },
          ],
          model: 'm1',
          timestamp: 1795810001000,
        },
      },
      { message_id: 'tr1', turn_id: 't1', message: { role: 'toolResult', toolCallId: 'tc_edit', content: [{ type: 'text', text: 'edited' }], isError: false, timestamp: 1795810002000 } },
    ],
  });
  const editProv = createMinimaxProvider({ rootDir: editRoot });
  const editDb = new DatabaseSync(':memory:');
  installSchema(editDb);
  for (const u of editProv.discover({ lastCursor: () => null })) indexUnit(editDb, editProv, u, null);
  const editTc = editDb.prepare("SELECT file_path, presentation FROM tool_calls WHERE id LIKE '%:tc_edit'").get();
  const skillTc = editDb.prepare("SELECT presentation FROM tool_calls WHERE id LIKE '%:tc_skill'").get();
  assert.equal(editTc.file_path, '/workspace/demo/main.ts');
  assert.equal(skillTc.presentation, 'skill');
  const editApi = createQueryApi(editDb);
  assert.equal(editApi.fileHistory('/workspace/demo/main.ts', { source: 'minimax' }).length, 1);

  // 2. snapshots/ directory symlink escape blocked in parse() & raw(), and EACCES fails closed without advancing cursor
  const snapRoot = makeTempDir('obelisk-minimax-snapsec-');
  const outsideSnap = makeTempDir('obelisk-minimax-outsidesnap-');
  writeFileSync(join(outsideSnap, 'g000000000000--sec1.jsonl'), JSON.stringify({ message_id: 'exfil', turn_id: 't0', message: { role: 'user', content: 'EXFIL', timestamp: 1795810000000 } }) + '\n');
  const symSnapDir = join(snapRoot, 'v2/sessions/2026/11/27/10-00-00-000-session_symsnap');
  mkdirSync(symSnapDir, { recursive: true });
  symlinkSync(outsideSnap, join(symSnapDir, 'snapshots'));
  writeFileSync(join(symSnapDir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, sessionId: 'mvs_symsnap', createdAtMs: 1795810000000 }));
  const symMsgPath = join(symSnapDir, 'messages.jsonl');
  writeFileSync(symMsgPath, JSON.stringify({
    message_id: 'm1',
    turn_id: 't1',
    history_artifact: { schemaVersion: 1, generation: 1, producedBy: 'tool_trim', parentSnapshot: { generation: 0, compactionId: 'sec1' } },
    message: { role: 'user', content: 'active', timestamp: 1795810001000 },
  }) + '\n');
  const snapProv = createMinimaxProvider({ rootDir: snapRoot });
  const symDisc = collectAll(snapProv);
  assert.equal(symDisc.units.length, 0);
  assert.equal(symDisc.skipped.length, 1);
  assert.equal(snapProv.raw({ source: 'minimax', messageUuid: `${minimaxSessionId('mvs_symsnap')}:exfil:b0000`, session: { id: minimaxSessionId('mvs_symsnap'), jsonl_path: symMsgPath }, agentId: null }), null);

  if (process.getuid?.() !== 0) {
    const eaccesRoot = makeTempDir('obelisk-minimax-snapeacces-');
    const eDir = writeSessionFiles(eaccesRoot, '2026/11/27/10-00-00-000-session_eacces', {
      sessionId: 'mvs_snapeacces',
      messages: [{
        message_id: 'm2',
        turn_id: 't2',
        history_artifact: { schemaVersion: 1, generation: 1, producedBy: 'llm_checkpoint', parentSnapshot: { generation: 0, compactionId: 'c1' } },
        message: { role: 'user', content: 'after', timestamp: 1795810002000 },
      }],
      snapshots: {
        'g000000000000--c1.jsonl': [{ message_id: 'm1', turn_id: 't1', message: { role: 'user', content: 'BEFORE', timestamp: 1795810001000 } }],
      },
    });
    const eProv = createMinimaxProvider({ rootDir: eaccesRoot });
    chmodSync(join(eDir, 'snapshots'), 0o000);
    try {
      const eRes = collectAll(eProv);
      assert.equal(eRes.units.length, 0);
      assert.equal(eRes.issues.length, 1);
    } finally {
      chmodSync(join(eDir, 'snapshots'), 0o755);
    }
    const recovered = collectAll(eProv);
    assert.equal(recovered.units.length, 1);
    const recs = [...eProv.parse(recovered.units[0], null)];
    assert.ok(recs.some((r) => r.kind === 'message' && r.text === 'BEFORE'));
  }

  // 3. 0-byte & missing-table SQLite fail closed; legacy 3-column record_json SQLite parsed cleanly
  const zeroSqlRoot = makeTempDir('obelisk-minimax-0sql-');
  writeSessionFiles(zeroSqlRoot, '2026/11/27/10-00-00-000-session_v', {
    sessionId: 'mvs_v',
    messages: [{ message_id: 'u1', turn_id: 't1', message: { role: 'user', content: 'vis', timestamp: 1795810000000 } }],
  });
  mkdirSync(join(zeroSqlRoot, 'v2/sqlite'), { recursive: true });
  const zeroDbPath = join(zeroSqlRoot, 'v2/sqlite/runtime-state.sqlite');
  writeFileSync(zeroDbPath, '');
  const zeroProv = createMinimaxProvider({ rootDir: zeroSqlRoot });
  const zeroRes = collectAll(zeroProv, {
    indexedSessions: () => [{ sessionId: minimaxSessionId('mvs_v'), jsonlPath: join(zeroSqlRoot, 'v2/sessions/2026/11/27/10-00-00-000-session_v/messages.jsonl') }],
  });
  assert.equal(zeroRes.units.length, 0);
  assert.equal(zeroRes.issues.length, 1);
  assert.deepEqual(zeroRes.retained, [minimaxSessionId('mvs_v')]);

  const legacySqlRoot = makeTempDir('obelisk-minimax-legacysql-');
  writeSessionFiles(legacySqlRoot, '2026/11/27/10-00-00-000-session_legv', {
    sessionId: 'mvs_legv',
    messages: [{ message_id: 'u1', turn_id: 't1', message: { role: 'user', content: 'hello', timestamp: 1795810000000 } }],
  });
  writeSessionFiles(legacySqlRoot, '2026/11/27/10-00-00-000-session_legp', {
    sessionId: 'mvs_legp',
    messages: [{ message_id: 'u2', turn_id: 't1', message: { role: 'user', content: 'peek', timestamp: 1795810000000 } }],
  });
  mkdirSync(join(legacySqlRoot, 'v2/sqlite'), { recursive: true });
  const legDb = new DatabaseSync(join(legacySqlRoot, 'v2/sqlite/runtime-state.sqlite'));
  legDb.exec('CREATE TABLE local_runtime_sessions (session_id TEXT PRIMARY KEY, record_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL)');
  legDb.prepare('INSERT INTO local_runtime_sessions VALUES (?, ?, ?)').run(
    'mvs_legv',
    JSON.stringify({ title: 'Legacy Title', workspaceDir: '/work/leg', sessionKind: 'conversation', visibility: 'visible' }),
    1795810001000,
  );
  legDb.prepare('INSERT INTO local_runtime_sessions VALUES (?, ?, ?)').run(
    'mvs_legp',
    JSON.stringify({ title: 'Legacy Peek', sessionKind: 'peek', visibility: 'hidden' }),
    1795810001000,
  );
  legDb.close();
  const legProv = createMinimaxProvider({ rootDir: legacySqlRoot });
  const legUnits = legProv.discover({ lastCursor: () => null });
  assert.deepEqual(legUnits.map((u) => u.sessionId), [minimaxSessionId('mvs_legv')]);
  assert.equal(legUnits[0].meta.title, 'Legacy Title');
  assert.equal(legUnits[0].meta.cwd, '/work/leg');

  // 4. >10,000 messages in Case C preserves g0 tool output, exact message_count === COUNT(*), and acyclic parents
  const big10kRoot = makeTempDir('obelisk-minimax-10k-');
  const g0Lines = [];
  for (let i = 1; i <= 10005; i++) {
    g0Lines.push(JSON.stringify({ message_id: `m-${i}`, turn_id: `t-${i}`, message: { role: 'user', content: `q${i}`, timestamp: 1795810000000 + i } }));
  }
  g0Lines.push(JSON.stringify({ message_id: 'tail-call', turn_id: 'tx', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tc99', name: 'read', arguments: { path: '/a.ts' } }], timestamp: 1795820000000 } }));
  g0Lines.push(JSON.stringify({ message_id: 'tail-res', turn_id: 'tx', message: { role: 'toolResult', toolCallId: 'tc99', content: [{ type: 'text', text: 'FULL_10K_ORIG' }], isError: false, timestamp: 1795820000001 } }));
  writeSessionFiles(big10kRoot, '2026/11/27/10-00-00-000-session_10k', {
    sessionId: 'mvs_10k',
    messages: [
      { message_id: 'tail-call', turn_id: 'tx', history_artifact: { schemaVersion: 1, generation: 1, producedBy: 'tool_archive', parentSnapshot: { generation: 0, compactionId: 'c1' } }, message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tc99', name: 'read', arguments: { path: '/a.ts' } }], timestamp: 1795820000000 } },
      { message_id: 'tail-res', turn_id: 'tx', message: { role: 'toolResult', toolCallId: 'tc99', content: [{ type: 'text', text: '[Archived]' }], isError: false, timestamp: 1795820000001 } },
      { message_id: 'after', turn_id: 'ty', message: { role: 'user', content: 'after', timestamp: 1795820000002 } },
    ],
    snapshots: { 'g000000000000--c1.jsonl': g0Lines },
  });
  const prov10k = createMinimaxProvider({ rootDir: big10kRoot });
  const db10k = new DatabaseSync(':memory:');
  installSchema(db10k);
  for (const u of prov10k.discover({ lastCursor: () => null })) indexUnit(db10k, prov10k, u, null);
  const cid10k = minimaxSessionId('mvs_10k');
  assert.equal(db10k.prepare('SELECT message_count FROM sessions WHERE id = ?').get(cid10k).message_count, 10008);
  assert.equal(db10k.prepare('SELECT COUNT(*) AS c FROM messages WHERE session_id = ?').get(cid10k).c, 10008);
  assert.equal(db10k.prepare('SELECT content FROM tool_results WHERE session_id = ?').get(cid10k).content, 'FULL_10K_ORIG');
  const api10k = createQueryApi(db10k);
  assert.ok(api10k.messages({ around: `${cid10k}:after:b0000`, relation: 'parents', beforeCount: 5 }).messages.length >= 1);

  // 5. >64 MiB first line fails closed (skipped, does not bypass schemaVersion 99)
  const giantRoot = makeTempDir('obelisk-minimax-64m-');
  const giantDir = join(giantRoot, 'v2/sessions/2026/11/27/10-00-00-000-session_giant');
  mkdirSync(giantDir, { recursive: true });
  writeFileSync(join(giantDir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, sessionId: 'mvs_giant', createdAtMs: 1795810000000 }));
  const fd = openSync(join(giantDir, 'messages.jsonl'), 'w');
  try {
    writeSync(fd, '{"message_id":"m1","turn_id":"t1","history_artifact":{"schemaVersion":99,"generation":1},"message":{"role":"user","content":"');
    const chunk = Buffer.alloc(1024 * 1024, 65);
    for (let i = 0; i < 65; i++) writeSync(fd, chunk);
    writeSync(fd, '","timestamp":1795810000000}}\n{"message_id":"m2","turn_id":"t2","message":{"role":"user","content":"line2","timestamp":1795810001000}}\n');
  } finally {
    closeSync(fd);
  }
  const giantRes = collectAll(createMinimaxProvider({ rootDir: giantRoot }));
  assert.equal(giantRes.units.length, 0);
  assert.equal(giantRes.skipped.length, 1);

  // 6. normal Case A mid-file rewrite + append followed by strict reconcile repairs DB
  const strictRoot = makeTempDir('obelisk-minimax-strictpoison-');
  const pad600 = 'X'.repeat(600);
  writeSessionFiles(strictRoot, '2026/11/27/10-00-00-000-session_sp', {
    sessionId: 'mvs_sp',
    messages: [{ message_id: 'm1', turn_id: 't1', message: { role: 'user', content: `ORIG_${pad600}`, timestamp: 1795810000000 } }],
  });
  const strictProv = createMinimaxProvider({ rootDir: strictRoot });
  const strictDb = new DatabaseSync(':memory:');
  installSchema(strictDb);
  const strictCursors = new Map();
  const runMode = (readMode) => {
    for (const u of strictProv.discover({ lastCursor: (k) => strictCursors.get(k) ?? null, readMode })) {
      strictCursors.set(u.key, indexUnit(strictDb, strictProv, u, strictCursors.get(u.key) ?? null));
    }
  };
  runMode('normal');
  writeSessionFiles(strictRoot, '2026/11/27/10-00-00-000-session_sp', {
    sessionId: 'mvs_sp',
    messages: [
      { message_id: 'm1', turn_id: 't1', message: { role: 'user', content: `HACK_${pad600}`, timestamp: 1795810000000 } },
      { message_id: 'm2', turn_id: 't2', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], timestamp: 1795810001000 } },
    ],
  });
  runMode('normal');
  assert.ok(strictDb.prepare("SELECT text FROM messages WHERE uuid LIKE '%:m1:b0000'").get().text.startsWith('ORIG_'));
  runMode('strict');
  assert.ok(strictDb.prepare("SELECT text FROM messages WHERE uuid LIKE '%:m1:b0000'").get().text.startsWith('HACK_'));

  // 7. Lone UTF-16 surrogates across non-canonical fields pass ADR-0007 & assertHarnessConformance
  const surrRoot = makeTempDir('obelisk-minimax-surrall-');
  writeSessionFiles(surrRoot, '2026/11/27/10-00-00-000-session_surrall', {
    sessionId: 'mvs_surrall',
    messages: [
      { message_id: 'u1', turn_id: 't1', message: { role: 'user', content: 'usr \ud83d x', timestamp: 1795810000000 } },
      { message_id: 'a1', turn_id: 't1', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'thk \ud83d' }, { type: 'text', text: 'txt \ud83d' }], errorMessage: 'err \ud83d', timestamp: 1795810001000 } },
      { message_id: 'b1', turn_id: 't2', message: { role: 'bashExecution', command: 'cmd \ud83d', output: 'bo \ud83d', timestamp: 1795810002000 } },
    ],
  });
  const surrProv = createMinimaxProvider({ rootDir: surrRoot });
  const surrRecs = [...surrProv.parse(surrProv.discover({ lastCursor: () => null })[0], null)];
  assertHarnessConformance(surrRecs);

  // 8. Symlink root alias for raw() + tombstone, corrupt move allowTombstones=false, unhealthy dup not poisoning healthy, same-dir tombstone ordering
  const symReal = makeTempDir('obelisk-minimax-symreal-');
  const symHolder = makeTempDir('obelisk-minimax-symholder-');
  const symLink = join(symHolder, 'link');
  symlinkSync(symReal, symLink);
  const symSess = writeSessionFiles(symLink, '2026/11/27/10-00-00-000-session_s', {
    sessionId: 'mvs_symalias',
    messages: [{ message_id: 'msg-3', turn_id: 't1', message: { role: 'user', content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }], genuineUserQueryText: 'canonical1', timestamp: 1795810000000 } }],
  });
  const realProv = createMinimaxProvider({ rootDir: symReal });
  const realUnit = realProv.discover({ lastCursor: () => null })[0];
  const symSesRow = { id: realUnit.sessionId, jsonl_path: join(symSess, 'messages.jsonl') };
  assert.equal(realProv.raw({ source: 'minimax', messageUuid: `${realUnit.sessionId}:msg-3:b0001`, session: symSesRow, agentId: null }).messageText, 'second');
  rmSync(symSess, { recursive: true, force: true });
  const symTomb = realProv.discover({
    lastCursor: () => null,
    indexedSessions: () => [{ sessionId: realUnit.sessionId, jsonlPath: symSesRow.jsonl_path }],
    changedPaths: [join(symReal, 'v2/sessions/2026/11/27/10-00-00-000-session_s/messages.jsonl')],
  });
  assert.equal(symTomb.length, 1);
  assert.equal(symTomb[0].meta.kind, 'tombstone');

  // 9. raw() JSON-escaped message_id, empty-array canonicalText, >10k unknown block, ENOTDIR, static trailing line, wrapper-tag title
  const miscRoot = makeTempDir('obelisk-minimax-misc-');
  const bigUnknown = { type: 'customBlock', payload: 'Z'.repeat(10050) };
  const miscDir = writeSessionFiles(miscRoot, '2026/11/27/10-00-00-000-session_misc', {
    sessionId: 'mvs_misc',
    messages: [
      { message_id: 'u_cmd', turn_id: 't0', message: { role: 'user', content: '<command-name>/clear</command-name>', timestamp: 1795810000000 } },
      '{"message_id":"msg\\u002d3","turn_id":"t1","message":{"role":"user","content":[],"genuineUserQueryText":"empty array text","timestamp":1795810001000}}',
      { message_id: 'a_unk', turn_id: 't1', message: { role: 'assistant', content: [bigUnknown], timestamp: 1795810002000 } },
    ],
  });
  // Append valid trailing JSON line WITHOUT trailing newline
  writeFileSync(
    join(miscDir, 'messages.jsonl'),
    readFileSync(join(miscDir, 'messages.jsonl'), 'utf8') +
      JSON.stringify({ message_id: 'u_no_nl', turn_id: 't2', message: { role: 'user', content: 'last line no nl', timestamp: 1795810003000 } }),
  );
  const miscProv = createMinimaxProvider({ rootDir: miscRoot });
  const miscUnit = miscProv.discover({ lastCursor: () => null })[0];
  const miscRecs = [...miscProv.parse(miscUnit, null)];
  assert.equal(miscRecs.find((r) => r.kind === 'session').title, 'last line no nl');
  const miscSesRow = { id: miscUnit.sessionId, jsonl_path: join(miscDir, 'messages.jsonl') };
  assert.equal(miscProv.raw({ source: 'minimax', messageUuid: `${miscUnit.sessionId}:msg-3:b0000`, session: miscSesRow, agentId: null }).messageText, 'empty array text');
  assert.ok(miscProv.raw({ source: 'minimax', messageUuid: `${miscUnit.sessionId}:a_unk:b0000`, session: miscSesRow, agentId: null }).messageText.length > 10050);

  // 10. Moved + corrupt manifest suppresses tombstones; unhealthy dup does not freeze healthy sibling; same-dir tombstone sorts first
  const edgeRoot = makeTempDir('obelisk-minimax-discedge-');
  const healthyDir = writeSessionFiles(edgeRoot, '2026/11/27/10-00-00-000-session_healthy', {
    sessionId: 'mvs_dup_ok',
    messages: [{ message_id: 'u1', turn_id: 't1', message: { role: 'user', content: 'ok', timestamp: 1795810000000 } }],
  });
  const badDupDir = writeSessionFiles(edgeRoot, '2026/11/27/10-00-00-000-session_baddup', {
    sessionId: 'mvs_dup_ok',
    messages: [{ message_id: 'u2', turn_id: 't1', history_artifact: { schemaVersion: 99, generation: 1 }, message: { role: 'user', content: 'v99', timestamp: 1795810000000 } }],
  });
  assert.ok(healthyDir && badDupDir);
  const corruptMoveDir = join(edgeRoot, 'v2/sessions/2026/11/27/10-00-00-000-session_corruptmove');
  mkdirSync(corruptMoveDir, { recursive: true });
  writeFileSync(join(corruptMoveDir, 'manifest.json'), '{broken');
  const edgeProv = createMinimaxProvider({ rootDir: edgeRoot });
  const edgeRes = collectAll(edgeProv, {
    indexedSessions: () => [
      { sessionId: minimaxSessionId('mvs_missing_moved'), jsonlPath: join(edgeRoot, 'v2/sessions/2026/11/27/09-00-00-000-session_old/messages.jsonl') },
    ],
  });
  assert.ok(edgeRes.units.some((u) => u.sessionId === minimaxSessionId('mvs_dup_ok') && u.meta.kind === 'session'));
  assert.equal(edgeRes.units.some((u) => u.sessionId === minimaxSessionId('mvs_missing_moved')), false);

  const sameDirRoot = makeTempDir('obelisk-minimax-samedir-');
  const sameDir = writeSessionFiles(sameDirRoot, '2026/11/27/10-00-00-000-session_shared', {
    sessionId: 'sess-a',
    messages: [{ message_id: 'ua', turn_id: 't1', message: { role: 'user', content: 'new a', timestamp: 1795810000000 } }],
  });
  const sameDirProv = createMinimaxProvider({ rootDir: sameDirRoot });
  const sharedUnits = sameDirProv.discover({
    lastCursor: () => null,
    indexedSessions: () => [{ sessionId: minimaxSessionId('sess-z'), jsonlPath: join(sameDir, 'messages.jsonl') }],
  });
  assert.equal(sharedUnits.length, 2);
  assert.equal(sharedUnits[0].meta.kind, 'tombstone');
  assert.equal(sharedUnits[1].meta.kind, 'session');

  // ENOTDIR on v2/sessions reports inventory issue
  const enotdirRoot = makeTempDir('obelisk-minimax-enotdir-');
  mkdirSync(join(enotdirRoot, 'v2'), { recursive: true });
  writeFileSync(join(enotdirRoot, 'v2/sessions'), 'not a directory');
  const enotdirRes = collectAll(createMinimaxProvider({ rootDir: enotdirRoot }));
  assert.equal(enotdirRes.issues.length, 1);
});
