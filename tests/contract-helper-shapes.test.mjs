// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Tier 2 contract golden tests (see docs/adr/0002-two-tier-runtime-contract.md).
//
// These lock the *composite return shapes* that agents parse and that
// references/api-reference.md documents explicitly, so the upcoming TypeScript /
// runtime-core refactor cannot silently reshape a helper's output. Two guards
// work together:
//
//   1. Live-shape assertions: build a representative in-memory DB, call each
//      helper, and assert the returned object's key set matches the contract.
//   2. Doc-sync guard: assert every contracted key name also appears in
//      references/api-reference.md. If an implementation shape changes, guard (1)
//      fails; if the test contract changes without updating the doc, guard (2)
//      fails. Either way, changing a helper forces a doc change.
//
// Out of scope here (covered elsewhere):
//   - Bare `Array<session_row>` helpers (sessions/recent/workflows/trace/thread)
//     return `SELECT *` rows; their columns are pinned by db-schema.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createQueryApi, createAttuneApi } from '../packages/core/src/query.ts';
import { makeTempDir } from './temp-dirs.mjs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');
const API_REFERENCE = readFileSync(new URL('../skill-doc/references/api-reference.md', import.meta.url), 'utf8');

// Every key asserted below is recorded here so the doc-sync guard can confirm
// references/api-reference.md still documents it.
const assertedKeys = new Set();

function exactKeys(obj, expected, label) {
  expected.forEach(k => assertedKeys.add(k));
  assert.deepEqual(
    Object.keys(obj).sort(),
    [...expected].sort(),
    `${label}: key set drifted from api-reference.md`,
  );
}

function hasKeys(obj, expected, label) {
  const keys = new Set(Object.keys(obj));
  for (const k of expected) {
    assertedKeys.add(k);
    assert.ok(keys.has(k), `${label}: missing documented key "${k}"`);
  }
}

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);

  db.prepare(`INSERT INTO sessions (id, title, project, project_path, started_at, ended_at, git_branch, message_count, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'sid-1', 'Contract session', 'quiet-zero', process.cwd(),
    '2026-06-10T10:00:00Z', '2026-06-10T11:00:00Z', 'main', 5, 'claude',
  );

  const insertMsg = db.prepare(`INSERT INTO messages
    (uuid, session_id, type, parent_uuid, timestamp, role, text, content_type, is_meta, model, agent_id, cwd, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insertMsg.run('m-root', 'sid-1', 'user', null, '2026-06-10T10:00:00Z', 'user', 'contract needle root', 'text', 0, null, null, process.cwd(), 'claude');
  insertMsg.run('m-child', 'sid-1', 'assistant', 'm-root', '2026-06-10T10:00:10Z', 'assistant', 'contract needle child', 'text', 0, 'claude-opus', 'sub-A', process.cwd(), 'claude');
  insertMsg.run('m-fail', 'sid-1', 'assistant', 'm-child', '2026-06-10T10:00:20Z', 'assistant', 'ran a command', 'tool_use', 0, 'claude-opus', null, process.cwd(), 'claude');
  insertMsg.run('m-after', 'sid-1', 'assistant', 'm-fail', '2026-06-10T10:00:30Z', 'assistant', 'recovered after failure', 'text', 0, 'claude-opus', null, process.cwd(), 'claude');

  db.prepare(`INSERT INTO tool_calls (id, message_uuid, session_id, name, input_json, file_path)
    VALUES (?, ?, ?, ?, ?, ?)`).run('tc-read', 'm-child', 'sid-1', 'Read', '{"file_path":"/x/file.ts"}', '/x/file.ts');
  db.prepare(`INSERT INTO tool_calls (id, message_uuid, session_id, name, input_json, file_path)
    VALUES (?, ?, ?, ?, ?, ?)`).run('tc-bash', 'm-fail', 'sid-1', 'Bash', '{"command":"boom"}', null);

  db.prepare(`INSERT INTO tool_results (tool_use_id, message_uuid, session_id, content, file_path, is_error)
    VALUES (?, ?, ?, ?, ?, ?)`).run('tc-bash', 'm-fail', 'sid-1', 'command failed', null, 1);

  db.prepare(`INSERT INTO subagents (agent_id, session_id, parent_tool_use_id, agent_type, description, duration_ms, total_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run('sub-A', 'sid-1', 'tc-read', 'general-purpose', 'a subagent', 100, 200);

  db.prepare(`INSERT INTO workflows (run_id, session_id, task_id, script, result_json, timestamp, agent_count, status, workflow_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('wf-1', 'sid-1', 'task-1', 'export const meta={}', '{"ok":true}', '2026-06-10T10:05:00Z', 1, 'done', 'demo');
  db.prepare(`INSERT INTO workflow_agents (agent_id, run_id, session_id, agent_type, description, phase, label, model, state, duration_ms, tokens, tool_calls)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('wa-1', 'wf-1', 'sid-1', 'worker', 'agent', 'Find', 'find:x', 'claude-opus', 'done', 50, 10, 2);

  db.prepare(`INSERT INTO summaries (id, session_id, timestamp, source, content)
    VALUES (?, ?, ?, ?, ?)`).run('su-1', 'sid-1', '2026-06-10T10:06:00Z', 'away_summary', 'a summary');

  db.prepare(`INSERT INTO memories (id, session_id, project, path, summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run('mem-1', 'sid-1', 'quiet-zero', '.obelisk/memories/x.md', 'Decision: contract fixture memory.', '2026-06-10T10:07:00Z');

  return db;
}

test('search() hit shape matches api-reference.md', () => {
  const db = fixture();
  const hit = createQueryApi(db).search('needle', { limit: 1 })[0];

  // snippet is present whenever a query term appears literally in the text,
  // which a plain-token query like this one guarantees (api-reference.md).
  exactKeys(hit, ['message', 'session', 'rank', 'context', 'snippet'], 'search() hit');
  exactKeys(hit.message, ['uuid', 'text', 'content_type', 'is_meta', 'role', 'timestamp', 'model', 'cwd', 'visibility', 'source'], 'search() hit.message');
  exactKeys(hit.session, ['id', 'title', 'project', 'started_at', 'source'], 'search() hit.session');
  assert.ok(Array.isArray(hit.context), 'search() hit.context is an array');
  db.close();
});

test('context() shape matches api-reference.md', () => {
  const db = fixture();
  const ctx = createQueryApi(db).context('m-child');

  exactKeys(ctx, ['message', 'parentChain', 'session', 'subagent', 'workflow'], 'context()');
  assert.ok(Array.isArray(ctx.parentChain), 'context() parentChain is an array');
  assert.equal(ctx.parentChain[0].uuid, 'm-root');
  db.close();
});

test('fileHistory() row shape matches api-reference.md', () => {
  const db = fixture();
  const row = createQueryApi(db).fileHistory('/x/file.ts')[0];

  exactKeys(row, ['toolCall', 'session', 'timestamp', 'visibility'], 'fileHistory() row');
  exactKeys(row.toolCall, ['id', 'message_uuid', 'name', 'input_json'], 'fileHistory() row.toolCall');
  exactKeys(row.session, ['id', 'title', 'project'], 'fileHistory() row.session');
  db.close();
});

test('failures() row shape matches api-reference.md', () => {
  const db = fixture();
  const row = createQueryApi(db).failures()[0];

  exactKeys(row, ['toolCall', 'result', 'session', 'nextMessages', 'visibility'], 'failures() row');
  assert.ok(Array.isArray(row.nextMessages), 'failures() row.nextMessages is an array');
  assert.equal(row.nextMessages[0].uuid, 'm-after');
  db.close();
});

test('subagents() row carries messageCount', () => {
  const db = fixture();
  const row = createQueryApi(db).subagents()[0];

  hasKeys(row, ['messageCount'], 'subagents() row');
  assert.equal(row.messageCount, 1);
  db.close();
});

test('workflowTree() shape carries result and agents with messageCount', () => {
  const db = fixture();
  const tree = createQueryApi(db).workflowTree('wf-1');

  hasKeys(tree, ['result', 'agents'], 'workflowTree()');
  assert.deepEqual(tree.result, { ok: true });
  assert.ok(Array.isArray(tree.agents));
  hasKeys(tree.agents[0], ['messageCount'], 'workflowTree() agent');
  db.close();
});

test('summaries() row carries session_title and project', () => {
  const db = fixture();
  const row = createQueryApi(db).summaries()[0];

  hasKeys(row, ['session_title', 'project'], 'summaries() row');
  db.close();
});

test('overview() shape matches api-reference.md', () => {
  const db = fixture();
  const view = createQueryApi(db).overview({ limit: 5 });

  exactKeys(view, ['current', 'current_project', 'projects', 'totals'], 'overview()');
  exactKeys(view.current, ['cwd', 'project', 'session_id'], 'overview() current');
  assert.equal(view.current.session_id, null, 'no invocation nonce: session_id is null');
  exactKeys(view.totals, ['projects', 'sessions', 'memories', 'sources'], 'overview() totals');
  db.close();
});

test('forget() result shape matches api-reference.md', () => {
  const db = fixture();
  const api = createAttuneApi(db);

  const forgotten = api.forget({ id: 'mem-1', reason: 'contract test' });
  exactKeys(forgotten, ['id', 'deleted_at', 'deleted_reason'], 'forget()');
  db.close();
});

test('raw() shape matches api-reference.md', () => {
  const dir = makeTempDir('obelisk-raw-');
  const jsonlPath = join(dir, 'session.jsonl');
  const line = JSON.stringify({ uuid: 'm-raw', type: 'user', message: { role: 'user', content: 'raw line body' } });
  writeFileSync(jsonlPath, line + '\n');

  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sessions (id, title, project, project_path, jsonl_path, source)
    VALUES (?, ?, ?, ?, ?, ?)`).run('sid-raw', 'Raw session', 'quiet-zero', dir, jsonlPath, 'claude');
  db.prepare(`INSERT INTO messages (uuid, session_id, type, role, text, content_type, source)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run('m-raw', 'sid-raw', 'user', 'user', 'raw line body', 'text', 'claude');

  const result = createQueryApi(db).raw('m-raw');
  exactKeys(result, ['text', 'totalLength', 'offset', 'limit', 'hasMore', 'visibility'], 'raw()');
  assert.equal(result.text, line);
  assert.equal(result.totalLength, line.length);
  db.close();
});

test('doc-sync guard: every asserted contract key appears in api-reference.md', () => {
  // Runs after the shape tests have populated assertedKeys. Guarantees the test
  // contract and the authoritative doc cannot drift apart silently.
  assert.ok(assertedKeys.size > 0, 'expected contract keys to have been asserted');
  const missing = [...assertedKeys].filter(k => !API_REFERENCE.includes(k));
  assert.deepEqual(missing, [], `keys asserted in tests but absent from api-reference.md: ${missing.join(', ')}`);
});
