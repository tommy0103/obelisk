// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Phase 5b golden test: pins the claude adapter's parse() record stream.
// This is the binding-independent contract — no database is involved. If the
// per-line parse behavior drifts, this fails before persist ever runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, utimesSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createClaudeProvider, parse } from '../packages/core/src/providers/claude.ts';
import { assembleSessionDetail } from '../packages/core/src/session-detail.ts';
import { persist } from '../packages/core/src/persist.ts';
import { makeTempDir } from './temp-dirs.mjs';

const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');

function writeFixture() {
  const dir = makeTempDir('obelisk-claude-parse-');
  const path = join(dir, 'sid-x.jsonl');
  const lines = [
    { type: 'ai-title', aiTitle: 'My Session' },
    { uuid: 'u1', type: 'user', timestamp: '2026-06-10T10:00:00Z', cwd: '/proj', gitBranch: 'main', message: { role: 'user', content: 'hi' } },
    { uuid: 'a1', type: 'assistant', timestamp: '2026-06-10T10:00:05Z', message: { role: 'assistant', model: 'claude-opus', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'tc1', name: 'Read', input: { file_path: '/f' } }], usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 } } },
    { type: 'system', subtype: 'turn_duration', parentUuid: 'a1', durationMs: 1234 },
    { uuid: 'u2', type: 'user', timestamp: '2026-06-10T10:00:10Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'file body', is_error: false }] } },
    { type: 'system', subtype: 'away_summary', uuid: 's1', timestamp: '2026-06-10T10:00:11Z', content: 'a summary' },
  ];
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

// Drain a generator, returning both the yielded values and its return value.
function drain(gen) {
  const values = [];
  let step = gen.next();
  while (!step.done) { values.push(step.value); step = gen.next(); }
  return { values, ret: step.value };
}

test('claude parse() yields the expected record stream for a main session', () => {
  const path = writeFixture();
  const { values, ret } = drain(parse({ key: path, sessionId: 'sid-x', project: 'quiet-zero' }, null));

  const byKind = k => values.filter(r => r.kind === k);

  // Three user/assistant messages, correct order and fields.
  assert.deepEqual(byKind('message').map(m => m.uuid), ['u1', 'a1', 'u2']);
  assert.equal(byKind('message').find(m => m.uuid === 'a1').model, 'claude-opus');
  assert.deepEqual(
    (({ input_tokens, output_tokens }) => ({ input_tokens, output_tokens }))(
      byKind('message').find(m => m.uuid === 'a1'),
    ),
    { input_tokens: 60, output_tokens: 5 },
  );
  assert.equal(byKind('message').every(m => m.source === 'claude'), true);

  // Tool call + tool result extracted.
  assert.deepEqual(byKind('tool_call').map(t => ({ id: t.id, name: t.name })), [{ id: 'tc1', name: 'Read' }]);
  assert.deepEqual(byKind('tool_result').map(t => ({ id: t.tool_use_id, err: t.is_error })), [{ id: 'tc1', err: 0 }]);

  // turn_duration is an update op keyed on the assistant message.
  assert.deepEqual(byKind('message-turn-duration'), [{ kind: 'message-turn-duration', uuid: 'a1', turn_duration_ms: 1234 }]);

  // Away summary.
  assert.deepEqual(byKind('summary').map(s => s.id), ['s1']);

  // Exactly one session aggregate, reflecting THIS chunk.
  const sessions = byKind('session');
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, 'My Session');
  assert.equal(sessions[0].message_count, 3);
  assert.equal(sessions[0].started_at, '2026-06-10T10:00:00Z');
  assert.equal(sessions[0].ended_at, '2026-06-10T10:00:10Z');
  assert.equal(sessions[0].git_branch, 'main');

  const detail = assembleSessionDetail(values);
  assert.deepEqual(detail.messages.map((message) => message.text), ['hi', 'ok']);
  assert.equal(detail.messages[1].tool_calls[0].result.content, 'file body');

  // Cursor encodes mtime:lines:signature (6 lines consumed).
  const stat = statSync(path);
  assert.equal(ret, `${stat.mtimeMs}:6:${stat.size}:${stat.ctimeMs}:${stat.ino}`);
});

test('claude parse() emits no session record for a subagent transcript', () => {
  const path = writeFixture();
  const { values } = drain(parse({ key: path, sessionId: 'sid-x', isSubagent: true, agentId: 'agent-7' }, null));

  assert.equal(values.filter(r => r.kind === 'session').length, 0);
  // Subagent messages carry the unit's agent id.
  assert.equal(values.filter(r => r.kind === 'message').every(m => m.agent_id === 'agent-7'), true);
});

test('claude parse() resumes from a cursor, skipping already-indexed lines', () => {
  const path = writeFixture();
  // Cursor with 6 lines already processed → nothing new to parse.
  const { values } = drain(parse({ key: path, sessionId: 'sid-x', project: 'quiet-zero' }, '0:6'));
  // Only the (empty-chunk) session record, with message_count 0.
  assert.deepEqual(values.filter(r => r.kind !== 'session'), []);
  assert.equal(values.find(r => r.kind === 'session').message_count, 0);
});

test('claude provider emits workflow artifacts with an explicit canonical tool edge', () => {
  const root = makeTempDir('obelisk-claude-workflow-');
  const projectDir = join(root, 'projects', '-proj');
  const workflowDir = join(projectDir, 'sid-workflow', 'workflows');
  const workflowAgentDir = join(projectDir, 'sid-workflow', 'subagents', 'workflows', 'run-workflow');
  mkdirSync(workflowDir, { recursive: true });
  mkdirSync(workflowAgentDir, { recursive: true });
  writeFileSync(join(projectDir, 'sid-workflow.jsonl'), [
    {
      uuid: 'assistant-workflow', type: 'assistant', timestamp: '2026-06-10T10:00:00Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'workflow-tool', name: 'Workflow', input: {} }] },
    },
    {
      uuid: 'workflow-result', type: 'user', timestamp: '2026-06-10T10:00:01Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'workflow-tool', content: 'run-workflow complete' }] },
    },
  ].map(line => JSON.stringify(line)).join('\n') + '\n');
  writeFileSync(join(workflowDir, 'run-workflow.json'), JSON.stringify({
    runId: 'run-workflow',
    workflowName: 'Review',
    status: 'complete',
    workflowProgress: [{ type: 'workflow_agent', agentId: '7', phaseTitle: 'review', label: 'Reviewer' }],
  }));
  writeFileSync(join(workflowAgentDir, 'agent-7.jsonl'), `${JSON.stringify({
    uuid: 'workflow-agent-message', type: 'user', timestamp: '2026-06-10T10:00:00Z',
    message: { role: 'user', content: 'review it' },
  })}\n`);
  writeFileSync(join(workflowAgentDir, 'agent-7.meta.json'), JSON.stringify({
    agentType: 'reviewer', description: 'Review the implementation',
  }));
  writeFileSync(join(root, 'history.jsonl'), `${JSON.stringify({
    sessionId: 'sid-workflow', title: 'History-owned title',
  })}\n`);
  const provider = createClaudeProvider({ rootDir: root });
  const units = provider.discover({ lastCursor: () => null });
  const records = units.flatMap(unit => drain(provider.parse(unit, null)).values);

  const workflow = records.find(record => record.kind === 'workflow');
  assert.equal(workflow.parent_tool_use_id, 'workflow-tool');
  const detail = assembleSessionDetail(records);
  assert.equal(detail.session.title, 'History-owned title');
  assert.equal(detail.messages[0].tool_calls[0].workflow.run_id, 'run-workflow');
  assert.equal(detail.workflows[0].agents[0].label, 'Reviewer');
  assert.equal(detail.workflows[0].agents.length, 1);

  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  for (const unit of units) persist(db, unit, provider.parse(unit, null));
  const workflows = db.prepare('SELECT * FROM workflows').all();
  for (const row of workflows) row.agents = db.prepare('SELECT * FROM workflow_agents WHERE run_id=?').all(row.run_id);
  const persistedDetail = assembleSessionDetail({
    session: db.prepare('SELECT * FROM sessions').get(),
    messages: db.prepare('SELECT * FROM messages ORDER BY timestamp, uuid').all(),
    toolCalls: db.prepare('SELECT * FROM tool_calls').all(),
    toolResults: db.prepare('SELECT * FROM tool_results').all(),
    subagents: db.prepare('SELECT * FROM subagents').all(),
    workflows,
    summaries: db.prepare('SELECT * FROM summaries').all(),
  });
  assert.deepEqual(persistedDetail, detail);
  db.close();
});

test('claude links repeated workflow names by unique run id', () => {
  const root = makeTempDir('obelisk-claude-workflow-link-');
  const projectDir = join(root, 'projects', '-proj');
  const workflowDir = join(projectDir, 'sid-workflow', 'workflows');
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(join(projectDir, 'sid-workflow.jsonl'), [
    {
      uuid: 'assistant-old', type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'old-call', name: 'Workflow', input: {} }] },
    },
    {
      uuid: 'old-result', type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old-call', content: 'Run ID: old-run\nSummary: same-name' }] },
    },
    {
      uuid: 'assistant-new', type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'new-call', name: 'Workflow', input: {} }] },
    },
    {
      uuid: 'new-result', type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'new-call', content: 'Run ID: new-run\nSummary: same-name' }] },
    },
  ].map(line => JSON.stringify(line)).join('\n') + '\n');
  for (const runId of ['old-run', 'new-run']) {
    writeFileSync(join(workflowDir, `${runId}.json`), JSON.stringify({
      runId, workflowName: 'same-name', status: 'completed', workflowProgress: [],
    }));
  }

  const provider = createClaudeProvider({ rootDir: root });
  const workflowUnits = provider.discover({ lastCursor: () => null })
    .filter(unit => unit.meta?.kind === 'workflow');
  assert.equal(workflowUnits.length, 2);

  // Both runs share the workflow name, so name-based matching would attach the
  // newer run to the older call; each run must link by its unique run id.
  const parentByRun = new Map();
  for (const unit of workflowUnits) {
    const records = drain(provider.parse(unit, null)).values;
    const workflow = records.find(record => record.kind === 'workflow');
    parentByRun.set(workflow.run_id, workflow.parent_tool_use_id);
  }
  assert.equal(parentByRun.get('old-run'), 'old-call');
  assert.equal(parentByRun.get('new-run'), 'new-call');
});


// ---- torn-tail cursor safety (#102) ----
// A build can land while the writer is mid-line. readLines reports the
// unterminated EOF tail with terminated=false; the Claude cursor must not
// count a tail that failed to parse, or the completed line is never re-read.

function writeTornFixture() {
  const dir = makeTempDir('obelisk-claude-torn-');
  const path = join(dir, 'sid-torn.jsonl');
  const head = [
    JSON.stringify({ uuid: 'u1', type: 'user', timestamp: '2026-06-10T10:00:00Z', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ uuid: 'a1', type: 'assistant', timestamp: '2026-06-10T10:00:05Z', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
  ];
  return { path, head };
}

const COMPLETED_TAIL = JSON.stringify({
  uuid: 'u2', type: 'user', timestamp: '2026-06-10T10:00:10Z', message: { role: 'user', content: 'done' },
});

test('a torn unterminated tail line does not advance the Claude cursor', () => {
  const { path, head } = writeTornFixture();
  writeFileSync(path, `${head.join('\n')}\n{"uuid":"u2","type":"user","mes`);
  const { ret } = drain(parse({ key: path, sessionId: 'sid-torn' }, null));
  assert.equal(ret.split(':')[1], '2', 'the unparseable unterminated tail is not counted');
});

test('a completed tail line is indexed exactly once after a torn parse', () => {
  const { path, head } = writeTornFixture();
  writeFileSync(path, `${head.join('\n')}\n{"uuid":"u2","type":"user","mes`);
  const torn = drain(parse({ key: path, sessionId: 'sid-torn' }, null));

  // The writer finishes the line (a later build sees it complete).
  writeFileSync(path, `${head.join('\n')}\n${COMPLETED_TAIL}\n`);
  const healed = drain(parse({ key: path, sessionId: 'sid-torn' }, torn.ret));

  const u2 = healed.values.filter((r) => r.kind === 'message' && r.uuid === 'u2');
  assert.equal(u2.length, 1, 'the completed line is indexed exactly once');
  assert.equal(healed.ret.split(':')[1], '3', 'the cursor now covers the completed line');
});

test('a newline-terminated malformed line advances the Claude cursor', () => {
  const { path, head } = writeTornFixture();
  writeFileSync(path, `${head.join('\n')}\nnot-json-at-all\n`);
  const { ret } = drain(parse({ key: path, sessionId: 'sid-torn' }, null));
  assert.equal(ret.split(':')[1], '3', 'terminated garbage keeps the legacy count');
});

test('a legal unterminated final JSON line advances the Claude cursor', () => {
  const { path, head } = writeTornFixture();
  writeFileSync(path, `${head.join('\n')}\n${COMPLETED_TAIL}`);
  const { ret } = drain(parse({ key: path, sessionId: 'sid-torn' }, null));
  assert.equal(ret.split(':')[1], '3', 'a parseable unterminated final line is counted');
});


// ---- cursor signature: same-millisecond recovery through discover ----
// The production self-heal path is discover → parse, not parse alone: after a
// torn parse, the completed tail must be reselected even when the file's
// mtime did not move (same-millisecond append, coarse or network filesystems).

test('a same-mtime tail completion is rediscovered through the cursor signature', () => {
  const root = makeTempDir('obelisk-claude-signature-');
  const projectDir = join(root, 'projects', '-proj');
  mkdirSync(projectDir, { recursive: true });
  const path = join(projectDir, 'sid-torn.jsonl');
  const head = [
    JSON.stringify({ uuid: 'u1', type: 'user', timestamp: '2026-06-10T10:00:00Z', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ uuid: 'a1', type: 'assistant', timestamp: '2026-06-10T10:00:05Z', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
  ];
  writeFileSync(path, `${head.join('\n')}\n{"uuid":"u2","type":"user","mes`);
  const provider = createClaudeProvider({ rootDir: root });

  // First production cycle: discover → parse the torn file.
  let units = provider.discover({ lastCursor: () => null });
  assert.equal(units.length, 1);
  const tornCursor = drain(provider.parse(units[0], null)).ret;
  assert.equal(tornCursor.split(':')[1], '2', 'the torn tail is not counted');

  // The writer completes the line with the mtime pinned to the parse-time
  // value — an mtime-only gate would never reselect this file.
  writeFileSync(path, `${head.join('\n')}\n${COMPLETED_TAIL}\n`);
  const pinnedMtime = new Date(Number(tornCursor.split(':')[0]));
  utimesSync(path, pinnedMtime, pinnedMtime);

  // The signature (size/ctime moved) reselects it anyway, and the completed
  // line is indexed exactly once through the full discover → parse cycle.
  units = provider.discover({ lastCursor: () => tornCursor });
  assert.equal(units.length, 1, 'a same-mtime completion is rediscovered');
  const healed = drain(provider.parse(units[0], tornCursor));
  assert.equal(
    healed.values.filter((r) => r.kind === 'message' && r.uuid === 'u2').length,
    1,
    'the completed line is indexed exactly once',
  );
});

test('a legacy two-part cursor keeps the mtime-only gate until it upgrades', () => {
  const root = makeTempDir('obelisk-claude-legacy-cursor-');
  const projectDir = join(root, 'projects', '-proj');
  mkdirSync(projectDir, { recursive: true });
  const path = join(projectDir, 'sid-legacy.jsonl');
  writeFileSync(path, [
    JSON.stringify({ uuid: 'u1', type: 'user', timestamp: '2026-06-10T10:00:00Z', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ uuid: 'a1', type: 'assistant', timestamp: '2026-06-10T10:00:05Z', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
  ].join('\n') + '\n');
  const provider = createClaudeProvider({ rootDir: root });
  const mtime = statSync(path).mtimeMs;

  assert.equal(
    provider.discover({ lastCursor: () => `${mtime}:2` }).length,
    0,
    'a legacy cursor at the current mtime is not reselected',
  );
  assert.equal(
    provider.discover({ lastCursor: () => `${mtime - 1000}:2` }).length,
    1,
    'a legacy cursor behind the current mtime is reselected',
  );
});
