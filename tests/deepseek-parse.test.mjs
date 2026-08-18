// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Golden test: pins the deepseek adapter's parse() record stream against the
// DeepSeek Harness JSONL format (header line + typed events + packed chunk
// rows, plaintext or zstd-framed). Binding-independent (no database). Covers
// the line-incremental delta resume, the truncation fallback to a full
// reparse, tool call/result correlation, meta classification, thinking
// messages, subagent projection, discover, and raw().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, mkdirSync, openSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import { createDeepseekProvider, parse } from '../packages/core/src/providers/deepseek.ts';
import { makeTempDir } from './temp-dirs.mjs';

const SID = 'session-019e8951-3e7d-7343-a3e3-05bff48a317d';
const HEADER = {
  type: 'session', version: 0, id: SID, createdAt: 1787054668467,
  cwd: '/proj', delegationDepth: 0, agentPreset: 'standard',
};

function writeFixture(lines, { suffix = '.jsonl', framed = false } = {}) {
  const dir = makeTempDir('obelisk-deepseek-parse-');
  const path = join(dir, `session${suffix}`);
  const text = lines.map(line => JSON.stringify(line)).join('\n') + '\n';
  if (framed) {
    // The header line is its own frame; the rest of the batch is a second frame.
    const headerFrame = zstdCompressSync(Buffer.from(JSON.stringify(lines[0]) + '\n'));
    const bodyFrame = zstdCompressSync(Buffer.from(lines.slice(1).map(l => JSON.stringify(l)).join('\n') + '\n'));
    writeFileSync(path, Buffer.concat([headerFrame, bodyFrame]));
  } else {
    writeFileSync(path, text);
  }
  return path;
}

function drain(gen) {
  const values = [];
  let step = gen.next();
  while (!step.done) { values.push(step.value); step = gen.next(); }
  return { values, cursor: step.value };
}

const BASE_EVENTS = [
  HEADER,
  { type: 'user/message', seq: 0, time: 1787054669201, data: {
    content: [{ type: 'text', text: 'hello deepseek' }],
    source: { kind: 'user', rpcId: 'rpc-1' }, role: 'user', id: 'm-1' } },
  { type: 'user/message', seq: 1, time: 1787054669300, data: {
    content: [{ type: 'text', text: 'Current runtime context.' }],
    source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }, role: 'user', id: 'm-2' } },
  { type: 'assistant/message', seq: 2, time: 1787054669400, data: {
    turn: 1, step: 1, message: { role: 'assistant', content: [
      { type: 'reasoning', text: 'I should inspect.' },
      { type: 'text', text: 'I will inspect.' },
    ], id: 'a-1' }, usage: { inputTokens: 100, outputTokens: 50, reasoningTokens: 30 } } },
  { type: 'tool/call', seq: 3, time: 1787054669500, data: {
    turn: 1, step: 1, callId: 'call_1', name: 'bash', arguments: '{"command":"ls"}' } },
  { type: 'tool/result', seq: 4, time: 1787054669600, data: {
    turn: 1, step: 1, message: { role: 'user', content: [
      { type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'file listing' }], isError: false },
    ], source: { kind: 'tool', tool: 'bash' }, id: 'tr-1' } } },
  { type: 'session/title', seq: 5, time: 1787054669700, data: {
    title: 'hello deepseek', messageSeqs: [0], source: { kind: 'fallback' } } },
  { type: 'request/header', seq: 6, time: 1787054669800, data: {
    header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, reason: 'initial' },
    reason: 'initial' } },
  // Log-only / control-plane events that must be skipped.
  { type: 'turn/start', seq: 7, time: 1787054669900, data: { turn: 1 } },
  { type: 'step/start', seq: 8, time: 1787054670000, data: { turn: 1, step: 1 } },
  { type: 'assistant/chunk', seq: 9, time: 1787054670100, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'he' } } },
  { type: 'text-chunks', seq0: 10, time0: 1787054670200, data: { turn: 1, step: 1, index: 0, dt: [1], texts: ['l', 'lo'] } },
  { type: 'approval/policy', seq: 11, time: 1787054670300, data: { policy: 'ask' } },
  { type: 'agent/inbox/spliced', seq: 12, time: 1787054670400, data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
];

test('deepseek parse() yields a delta-capable, tool-aware record stream', () => {
  const path = writeFixture(BASE_EVENTS);
  const { values, cursor } = drain(parse({ key: path, sessionId: SID }, null));
  const byKind = k => values.filter(r => r.kind === k);

  const [session] = byKind('session');
  assert.equal(session.id, SID);
  assert.equal(session.title, 'hello deepseek');
  assert.equal(session.project, '-proj');
  assert.equal(session.version, '0');
  assert.equal(session.countMode, 'total');
  assert.equal(session.source, 'deepseek');
  assert.equal(session.started_at, '2026-08-18T12:04:28.467Z');
  assert.equal(session.ended_at, '2026-08-18T12:04:30.400Z');
  assert.match(session.jsonl_path, /session\.jsonl$/);

  const msgs = byKind('message');
  // user, injected user (meta), assistant thinking, assistant text, tool_use.
  assert.equal(msgs.length, 5);
  const user = msgs.find(m => m.type === 'user' && m.text === 'hello deepseek');
  assert.equal(user.role, 'user');
  assert.equal(user.content_type, 'text');
  assert.equal(user.is_meta, 0);
  assert.equal(user.source, 'deepseek');
  assert.equal(user.model, null); // request/header comes after in the log
  const injected = msgs.find(m => m.text === 'Current runtime context.');
  assert.equal(injected.is_meta, 1);
  const thinking = msgs.find(m => m.content_type === 'thinking');
  assert.equal(thinking.text, 'I should inspect.');
  assert.equal(thinking.input_tokens, 100);
  assert.equal(thinking.output_tokens, 50);
  const text = msgs.find(m => m.content_type === 'text' && m.type === 'assistant');
  assert.equal(text.text, 'I will inspect.');
  const toolUse = msgs.find(m => m.content_type === 'tool_use');
  assert.equal(toolUse.text, null);
  assert.equal(toolUse.model, null); // request/header appears later in the log

  const calls = byKind('tool_call');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'call_1');
  assert.equal(calls[0].message_uuid, toolUse.uuid);
  assert.equal(calls[0].name, 'bash');
  assert.equal(calls[0].presentation, 'default');
  assert.deepEqual(JSON.parse(calls[0].input_json), { command: 'ls' });

  const results = byKind('tool_result');
  assert.equal(results.length, 1);
  assert.equal(results[0].tool_use_id, 'call_1');
  assert.equal(results[0].message_uuid, toolUse.uuid);
  assert.equal(results[0].content, 'file listing');
  assert.equal(results[0].is_error, 0);

  assert.equal(byKind('summary').length, 0);
  assert.equal(byKind('subagent').length, 0);
  assert.ok(cursor.includes(`:${BASE_EVENTS.length}`), `cursor advances past all lines: ${cursor}`);
});

test('deepseek parse() resumes incrementally with a delta session record', () => {
  const path = writeFixture(BASE_EVENTS);
  const first = drain(parse({ key: path, sessionId: SID }, null));
  assert.equal(first.values.filter(r => r.kind === 'session')[0].countMode, 'total');

  // Append new events, then resume from the first cursor.
  const appended = [
    { type: 'user/message', seq: 13, time: 1787054670500, data: {
      content: [{ type: 'text', text: 'continue please' }],
      source: { kind: 'user' }, role: 'user', id: 'm-3' } },
    { type: 'assistant/message', seq: 14, time: 1787054670600, data: {
      turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], id: 'a-2' } } },
  ];
  const fd = openSync(path, 'a');
  writeSync(fd, appended.map(l => JSON.stringify(l)).join('\n') + '\n');
  closeSync(fd);

  const second = drain(parse({ key: path, sessionId: SID }, first.cursor));
  const byKind = k => second.values.filter(r => r.kind === k);
  const [session] = byKind('session');
  assert.equal(session.countMode, 'delta');
  assert.equal(session.message_count, 2, 'delta message_count counts only new events');
  const msgs = byKind('message');
  assert.equal(msgs.length, 2, 'delta parse re-emits only the new messages');
  assert.equal(msgs.find(m => m.text === 'continue please').role, 'user');
  assert.equal(msgs.find(m => m.text === 'done').model, null);
  assert.equal(byKind('tool_call').length, 0);
});

test('deepseek parse() falls back to a full reparse after a truncation', () => {
  const path = writeFixture(BASE_EVENTS);
  const first = drain(parse({ key: path, sessionId: SID }, null));
  // Simulate a DSH crash repair: truncate below the indexed line count.
  writeFileSync(path, JSON.stringify(HEADER) + '\n');
  const second = drain(parse({ key: path, sessionId: SID }, first.cursor));
  const [session] = second.values.filter(r => r.kind === 'session');
  assert.equal(session.countMode, 'total', 'truncation below the cursor forces a total reparse');
  assert.equal(second.values.filter(r => r.kind === 'message').length, 0, 'no messages left after truncation');
});

test('deepseek parse() reads zstd-framed artifacts and skips a torn tail', () => {
  const dir = makeTempDir('obelisk-deepseek-zstd-');
  const path = join(dir, 'session.jsonl.zstd');
  const headerFrame = zstdCompressSync(Buffer.from(JSON.stringify(HEADER) + '\n'));
  const bodyFrame = zstdCompressSync(Buffer.from(BASE_EVENTS.slice(1).map(l => JSON.stringify(l)).join('\n') + '\n'));
  const torn = zstdCompressSync(Buffer.from(JSON.stringify({ type: 'assistant/message', seq: 99 }) + '\n')).subarray(0, 7);
  writeFileSync(path, Buffer.concat([headerFrame, bodyFrame, torn]));

  const { values, cursor } = drain(parse({ key: path, sessionId: SID }, null));
  assert.equal(values.filter(r => r.kind === 'message').length, 5, 'torn frame lines are not indexed');
  assert.ok(cursor.includes(`:${BASE_EVENTS.length}`), `cursor covers only complete frames: ${cursor}`);
});

test('deepseek parse() projects a subagent child into the parent session', () => {
  const CHILD = 'session-child-0001-0000-4000-8000-000000000001';
  const childHeader = {
    type: 'session', version: 0, id: CHILD, createdAt: 1787054671000,
    cwd: '/proj', parentSession: SID, origin: 'subagent', delegationDepth: 1,
  };
  const path = writeFixture([
    childHeader,
    { type: 'subagent/descriptor', seq: 0, time: 1787054671100, data: {
      version: 2, mode: 'continuable', provider: 'dsh-subagent', label: 'inspect the repo' } },
    { type: 'turn/start', seq: 1, time: 1787054671200, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 1787054671300, data: {
      content: [{ type: 'text', text: 'child prompt' }], source: { kind: 'user' }, role: 'user', id: 'c-1' } },
    { type: 'assistant/message', seq: 3, time: 1787054671400, data: {
      turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'child work' }], id: 'c-2' } } },
  ]);

  const { values } = drain(parse({ key: path, sessionId: SID, isSubagent: true, agentId: CHILD }, null));
  const msgs = values.filter(r => r.kind === 'message');
  assert.equal(msgs.length, 2);
  for (const m of msgs) {
    assert.equal(m.session_id, SID, 'child messages join the parent session');
    assert.equal(m.agent_id, CHILD);
    assert.equal(m.is_sidechain, 1);
  }
  const subagents = values.filter(r => r.kind === 'subagent');
  assert.equal(subagents.length, 1);
  assert.equal(subagents[0].agent_id, CHILD);
  assert.equal(subagents[0].session_id, SID);
  assert.equal(subagents[0].agent_type, 'dsh-subagent');
  assert.equal(subagents[0].description, 'inspect the repo');
  assert.equal(values.some(r => r.kind === 'session'), false, 'subagent children own no session row');
});

test('deepseek discover() enumerates session artifacts and resolves sidechain identity', () => {
  const root = makeTempDir('obelisk-deepseek-discover-');
  const projectDir = join(root, '--proj--');
  const sessionDir = join(projectDir, SID);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'session.jsonl'), JSON.stringify(HEADER) + '\n');

  const provider = createDeepseekProvider({ rootDir: root });
  const units = provider.discover({ lastCursor: () => null });
  assert.equal(units.length, 1);
  assert.equal(units[0].key, join(sessionDir, 'session.jsonl'));
  assert.equal(units[0].sessionId, SID);
  assert.equal(units[0].isSubagent, undefined);
  assert.equal(units[0].project, '-proj');
  assert.equal(provider.descriptor.id, 'deepseek');
  assert.deepEqual(provider.watchRoots(root), [root]);

  // An unchanged file is not rediscovered; a changed one is. The cursor's mtime
  // must be the artifact's own float mtime, matching the adapter comparison.
  const mtime = statSync(join(sessionDir, 'session.jsonl')).mtimeMs;
  assert.equal(provider.discover({ lastCursor: () => `${mtime}:2` }).length, 0);
  assert.equal(provider.discover({ lastCursor: () => '1:2' }).length, 1);
});

test('deepseek raw() returns the original artifact line for a message uuid', () => {
  const root = makeTempDir('obelisk-deepseek-raw-');
  const projectDir = join(root, '--proj--');
  const sessionDir = join(projectDir, SID);
  mkdirSync(sessionDir, { recursive: true });
  const path = join(sessionDir, 'session.jsonl');
  writeFileSync(path, BASE_EVENTS.map(l => JSON.stringify(l)).join('\n') + '\n');
  const provider = createDeepseekProvider({ rootDir: root });

  const hit = provider.raw({ source: 'deepseek', messageUuid: `deepseek:${SID}:5`, session: null, agentId: null });
  assert.ok(hit, 'raw resolves the tool/call line');
  assert.ok(hit.text.includes('"type":"tool/call"'));
  assert.equal(hit.messageText, null);

  const thinking = provider.raw({ source: 'deepseek', messageUuid: `deepseek:${SID}:4:0`, session: null, agentId: null });
  assert.ok(thinking && thinking.text.includes('"type":"assistant/message"'));

  const miss = provider.raw({ source: 'deepseek', messageUuid: `deepseek:${SID}:999`, session: null, agentId: null });
  assert.equal(miss, null);

  // The persisted jsonl_path path is preferred when the caller supplies it.
  const viaSession = provider.raw({
    source: 'deepseek', messageUuid: `deepseek:${SID}:4`, session: { jsonl_path: path }, agentId: null,
  });
  assert.ok(viaSession && viaSession.text.includes('"type":"assistant/message"'));
});
