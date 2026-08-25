// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { constants, zstdCompressSync } from 'node:zlib';

import { createDeepseekProvider, decodeChunkRow } from '../packages/core/src/providers/deepseek.ts';
import { persist } from '../packages/core/src/persist.ts';
import { assembleSessionDetail } from '../packages/core/src/session-detail.ts';
import { createZstdFrameDecoder, scanZstdFrames } from '../packages/core/src/vendor/dsh-zstd.ts';
import { makeTempDir } from './temp-dirs.mjs';

const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');

const SCOPE = createHash('sha256').update('deepseek-cwd-v1\0').update('/tmp/dsh-project').digest('hex');
const ROOT_ID = `deepseek:root-session-1:${SCOPE}`;
const CHILD_ID = `deepseek:child-session-1:${SCOPE}`;

function drain(gen) {
  const values = [];
  let step = gen.next();
  while (!step.done) {
    values.push(step.value);
    step = gen.next();
  }
  return { values, ret: step.value };
}

function writeRootSession(sessionDir) {
  mkdirSync(sessionDir, { recursive: true });
  const events = [
    { type: 'session', version: 0, id: 'root-session-1', createdAt: 1753005600000, cwd: '/tmp/dsh-project', delegationDepth: 0, agentPreset: 'standard' },
    { type: 'request/header', seq: 0, time: 1753005600100, data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } } } },
    { type: 'user/message', seq: 1, time: 1753005601000, data: { content: [{ type: 'text', text: 'inspect the project' }], source: { kind: 'user' }, role: 'user', id: 'msg-1' }, surfaceOp: 'append' },
    { type: 'session/title', seq: 2, time: 1753005601100, data: { title: 'Fixture title', messageSeqs: [1], source: { kind: 'fallback' } } },
    { type: 'assistant/message', seq: 3, time: 1753005602000, data: {
      turn: 1, step: 1,
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'think step' },
          { type: 'text', text: 'doing it' },
          { type: 'tool-call', id: 'call-1', name: 'Read', arguments: '{"file_path":"/tmp/dsh-project/a.ts"}' },
        ],
        source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        id: 'msg-2',
      },
      usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, reasoningTokens: 6 },
    }, surfaceOp: 'append' },
    { type: 'tool/call', seq: 4, time: 1753005602100, data: { turn: 1, step: 1, callId: 'call-1', name: 'Read', arguments: '{"file_path":"/tmp/dsh-project/a.ts"}' }, surfaceOp: 'append' },
    { type: 'tool/result', seq: 5, time: 1753005602500, data: {
      turn: 1, step: 1,
      message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'file body' }] }], role: 'user', id: 'msg-3' },
    }, surfaceOp: 'append' },
    { type: 'user/message', seq: 6, time: 1753005603000, data: { content: [{ type: 'text', text: '<system-reminder>injected</system-reminder>' }], source: { kind: 'system' }, role: 'user', id: 'msg-4' }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 7, time: 1753005604000, data: {
      turn: 1, step: 2,
      message: {
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'call-2', name: 'subagent', arguments: '{"prompt":"review the code"}' }],
        source: { kind: 'model', model: 'deepseek-v4-flash' },
        id: 'msg-5',
      },
      usage: { inputTokens: 5, outputTokens: 1 },
    }, surfaceOp: 'append' },
    { type: 'tool/call', seq: 8, time: 1753005604050, data: { turn: 1, step: 2, callId: 'call-2', name: 'subagent', arguments: '{"prompt":"review the code"}' }, surfaceOp: 'append' },
    { type: 'tool/result', seq: 9, time: 1753005604100, data: {
      turn: 1, step: 2,
      message: { source: { kind: 'tool', callId: 'call-2' }, content: [{ type: 'tool-result', toolCallId: 'call-2', content: [{ type: 'text', text: 'started subagent child-session-1' }] }], role: 'user', id: 'msg-6' },
    }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 10, time: 1753005605000, data: {
      turn: 1, step: 3,
      message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }], source: { kind: 'model', model: 'deepseek-v4-flash' }, id: 'msg-7' },
      usage: { inputTokens: 2, outputTokens: 2 },
    }, surfaceOp: 'append' },
    // A packed chunk run expands to assistant/chunk deltas the parse skips.
    { type: 'text-chunks', seq0: 100, time0: 1753005606000, data: { turn: 1, step: 4, index: 0, dt: [10, 10], texts: ['a', 'b', 'c'] } },
  ];
  writeFileSync(join(sessionDir, 'session.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n');
}

function writeChildSession(sessionDir) {
  mkdirSync(sessionDir, { recursive: true });
  const events = [
    { type: 'session', version: 0, id: 'child-session-1', createdAt: 1753005604200, cwd: '/tmp/dsh-project', parentSession: 'root-session-1', origin: 'subagent', delegationDepth: 1, agentPreset: 'standard' },
    { type: 'subagent/descriptor', seq: 0, time: 1753005604200, data: { version: 2, mode: 'continuable', provider: 'spawn', label: 'review helper', agentProvider: 'deepseek-official', agentModel: 'deepseek-v4-flash' } },
    { type: 'user/message', seq: 1, time: 1753005604300, data: { content: [{ type: 'text', text: 'review the code' }], source: { kind: 'user' }, role: 'user', id: 'msg-c1' }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 2, time: 1753005605000, data: {
      turn: 1, step: 1,
      message: {
        role: 'assistant',
        content: [{ type: 'reasoning', text: 'child think' }, { type: 'text', text: 'child done' }],
        source: { kind: 'model', model: 'deepseek-v4-flash' },
        id: 'msg-c2',
      },
      usage: { inputTokens: 20, outputTokens: 5 },
    }, surfaceOp: 'append' },
  ];
  writeFileSync(join(sessionDir, 'session.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n');
}

function writeDshFixture() {
  const root = makeTempDir('obelisk-deepseek-');
  const sessionsDir = join(root, 'sessions');
  const projectDir = join(sessionsDir, '--tmp-dsh-project--');
  writeRootSession(join(projectDir, 'root-session-1'));
  writeChildSession(join(projectDir, 'child-session-1'));
  return root;
}

function mkFrame(lines) {
  return zstdCompressSync(Buffer.from(lines.map((line) => JSON.stringify(line)).join('\n') + '\n'), { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
}

test('deepseek provider discovers root and subagent session files with stable cursors', () => {
  const root = writeDshFixture();
  const provider = createDeepseekProvider({ rootDir: join(root, 'sessions') });
  const units = provider.discover({ lastCursor: () => null });

  assert.equal(units.length, 2);
  const rootUnit = units.find((unit) => unit.agentId === undefined);
  const childUnit = units.find((unit) => unit.agentId !== undefined);
  assert.ok(rootUnit);
  assert.ok(childUnit);
  assert.equal(rootUnit.sessionId, ROOT_ID);
  assert.equal(rootUnit.project, '-tmp-dsh-project');
  assert.equal(childUnit.sessionId, ROOT_ID);
  assert.equal(childUnit.agentId, CHILD_ID);
  assert.equal(childUnit.isSubagent, true);

  const cursorByKey = new Map(units.map((unit) => {
    const { ret } = drain(provider.parse(unit, null));
    return [unit.key, ret];
  }));
  const unchanged = provider.discover({ lastCursor: (key) => cursorByKey.get(key) ?? null });
  assert.deepEqual(unchanged, []);
});

test('deepseek provider folds a session log into the canonical transcript language', () => {
  const root = writeDshFixture();
  const provider = createDeepseekProvider({ rootDir: join(root, 'sessions') });
  const unit = provider.discover({ lastCursor: () => null }).find((u) => u.agentId === undefined);
  const { values, ret } = drain(provider.parse(unit, null));
  const byKind = (kind) => values.filter((record) => record.kind === kind);

  const goldenRecords = values.map((record) => record.kind === 'session'
    ? { ...record, jsonl_path: '<fixture-session>' }
    : record);
  assert.equal(
    createHash('sha256').update(JSON.stringify(goldenRecords)).digest('hex'),
    'bbb7fa7a1b7090ad8c70641f50ba0d1ca6982dca3b81d1795251d1e9c4c429dc',
    'complete yielded record sequence changed',
  );

  assert.match(ret, /^\d+(?:\.\d+)?:\d+:\d+:\d+(?:\.\d+)?:\d+$/);

  const session = byKind('session')[0];
  assert.deepEqual(
    (({ id, title, project, source, countMode, message_count }) => ({ id, title, project, source, countMode, message_count }))(session),
    {
      id: ROOT_ID,
      title: 'Fixture title',
      project: '-tmp-dsh-project',
      source: 'deepseek',
      countMode: 'total',
      message_count: 5, // synthetic tool_use anchors are structural, not counted
    },
  );

  const messages = byKind('message');
  assert.deepEqual(messages.map((message) => [message.role, message.content_type, message.text, message.is_meta, message.model]), [
    ['user', 'text', 'inspect the project', 0, null],
    ['assistant', 'thinking', 'think step', 0, 'deepseek-v4-flash'],
    ['assistant', 'text', 'doing it', 0, 'deepseek-v4-flash'],
    ['assistant', 'tool_use', null, 0, 'deepseek-v4-flash'],
    ['user', 'text', '<system-reminder>injected</system-reminder>', 1, null],
    ['assistant', 'tool_use', null, 0, 'deepseek-v4-flash'],
    ['assistant', 'text', 'final answer', 0, 'deepseek-v4-flash'],
  ]);
  assert.equal(messages[0].parent_uuid, null);
  assert.equal(messages[2].parent_uuid, messages[1].uuid);
  assert.equal(messages[2].uuid, `${ROOT_ID}:t1:s1:text`);
  assert.equal(messages[3].uuid, `${ROOT_ID}:t1:s1:tool_use`);
  assert.equal(messages.find((message) => message.text === 'doing it').input_tokens, 13);
  assert.equal(messages.find((message) => message.text === 'doing it').output_tokens, 4);
  assert.equal(messages.find((message) => message.content_type === 'tool_use').input_tokens, null);

  // tool_calls come from the durable tool/call events and anchor on the
  // deterministic tool_use uuid for the same (turn, step).
  assert.deepEqual(byKind('tool_call').map((record) => [record.id, record.name, record.file_path, record.message_uuid]), [
    [`${ROOT_ID}:call-1`, 'Read', '/tmp/dsh-project/a.ts', `${ROOT_ID}:t1:s1:tool_use`],
    [`${ROOT_ID}:call-2`, 'subagent', null, `${ROOT_ID}:t1:s2:tool_use`],
  ]);
  assert.deepEqual(byKind('tool_result').map((record) => [record.tool_use_id, record.content, record.is_error, record.message_uuid]), [
    [`${ROOT_ID}:call-1`, 'file body', 0, `${ROOT_ID}:t1:s1:tool_use`],
    [`${ROOT_ID}:call-2`, 'started subagent child-session-1', 0, `${ROOT_ID}:t1:s2:tool_use`],
  ]);
  assert.deepEqual(byKind('subagent').map((record) => [record.agent_id, record.session_id, record.parent_tool_use_id]), [
    [CHILD_ID, ROOT_ID, `${ROOT_ID}:call-2`],
  ]);
});

test('deepseek provider projects a subagent log as sidechain messages plus a subagent record', () => {
  const root = writeDshFixture();
  const provider = createDeepseekProvider({ rootDir: join(root, 'sessions') });
  const unit = provider.discover({ lastCursor: () => null }).find((u) => u.agentId !== undefined);
  const { values } = drain(provider.parse(unit, null));
  const byKind = (kind) => values.filter((record) => record.kind === kind);

  const messages = byKind('message');
  assert.deepEqual(messages.map((message) => [message.role, message.content_type, message.text]), [
    ['user', 'text', 'review the code'],
    ['assistant', 'thinking', 'child think'],
    ['assistant', 'text', 'child done'],
  ]);
  for (const message of messages) {
    assert.equal(message.is_sidechain, 1);
    assert.equal(message.agent_id, CHILD_ID);
    assert.equal(message.session_id, ROOT_ID);
  }
  assert.equal(messages[2].input_tokens, 20);
  assert.equal(messages[2].output_tokens, 5);

  const subagents = byKind('subagent');
  assert.equal(subagents.length, 1);
  assert.deepEqual(
    (({ agent_id, session_id, agent_type, description }) => ({ agent_id, session_id, agent_type, description }))(subagents[0]),
    { agent_id: CHILD_ID, session_id: ROOT_ID, agent_type: 'deepseek-official', description: 'review helper' },
  );
  // total_tokens is derived at query time from the sidechain messages, not stored.
  assert.equal(subagents[0].total_tokens, undefined);
  assert.ok(subagents[0].duration_ms > 0);

  assert.equal(byKind('session').length, 0);
});

test('deepseek provider passes the fresh parse through assembleSessionDetail', () => {
  const root = writeDshFixture();
  const provider = createDeepseekProvider({ rootDir: join(root, 'sessions') });
  const unit = provider.discover({ lastCursor: () => null }).find((u) => u.agentId === undefined);
  const { values } = drain(provider.parse(unit, null));

  const detail = assembleSessionDetail(values);
  assert.equal(detail.session.id, ROOT_ID);
  assert.equal(detail.session.title, 'Fixture title');

  const texts = detail.messages.map((message) => message.text).filter(Boolean);
  assert.deepEqual(texts, [
    'inspect the project',
    'doing it',
    '<system-reminder>injected</system-reminder>',
    'final answer',
  ]);
  const withThinking = detail.messages.find((message) => message._thinking);
  assert.equal(withThinking.text, 'doing it');
  assert.equal(withThinking._thinking, 'think step');

  // The text message absorbs the tool_use anchor's calls during assembly.
  const subagentCall = detail.messages.flatMap((message) => message.tool_calls ?? []).find((toolCall) => toolCall.name === 'subagent');
  assert.ok(subagentCall);
  assert.equal(subagentCall.subagent.agent_id, CHILD_ID);
  assert.equal(subagentCall.result.content, 'started subagent child-session-1');

  // The assembled detail must survive a SQLite persist round-trip unchanged.
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  persist(db, unit, provider.parse(unit, null));
  const persistedDetail = assembleSessionDetail({
    session: db.prepare('SELECT * FROM sessions').get(),
    messages: db.prepare('SELECT * FROM messages ORDER BY timestamp, uuid').all(),
    toolCalls: db.prepare('SELECT * FROM tool_calls').all(),
    toolResults: db.prepare('SELECT * FROM tool_results').all(),
    subagents: db.prepare('SELECT * FROM subagents').all(),
  });
  assert.deepEqual(persistedDetail, detail);
  db.close();
});

test('deepseek provider indexes a durable tool/call event and anchors it on the (turn, step) tool_use uuid', () => {
  const root = makeTempDir('obelisk-deepseek-toolcall-');
  const sessionDir = join(root, 'sessions', '--tmp-dsh-project--', 'toolcall-session');
  mkdirSync(sessionDir, { recursive: true });
  const marker = 'nonce-verify-1234';
  const events = [
    { type: 'session', version: 0, id: 'toolcall-session', createdAt: 1753005600000, cwd: '/tmp/dsh-project', delegationDepth: 0, agentPreset: 'standard' },
    { type: 'user/message', seq: 1, time: 1753005601000, data: { content: [{ type: 'text', text: 'go' }], source: { kind: 'user' }, role: 'user', id: 'm1' }, surfaceOp: 'append' },
    // Assistant message with text only — no tool-call content part.
    { type: 'assistant/message', seq: 2, time: 1753005602000, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'running' }], source: { kind: 'model', model: 'deepseek-v4-flash' }, id: 'm2' }, usage: { inputTokens: 5, outputTokens: 2 } }, surfaceOp: 'append' },
    // The durable tool/call event carries the marker (the nonce) alone.
    { type: 'tool/call', seq: 3, time: 1753005603000, data: { turn: 1, step: 1, callId: 'call-evt-1', name: 'bash', arguments: JSON.stringify({ command: `obelisk --search "${marker}" --nonce "${marker}"` }) }, surfaceOp: 'append' },
  ];
  writeFileSync(join(sessionDir, 'session.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n');

  const provider = createDeepseekProvider({ rootDir: join(root, 'sessions') });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const { values } = drain(provider.parse(unit, null));
  const toolCalls = values.filter((record) => record.kind === 'tool_call');

  assert.equal(toolCalls.length, 1);
  const toolCallDbId = `deepseek:toolcall-session:${SCOPE}`;
  assert.equal(toolCalls[0].id, `${toolCallDbId}:call-evt-1`);
  assert.equal(toolCalls[0].name, 'bash');
  assert.match(toolCalls[0].input_json, new RegExp(marker));
  // The anchor is the deterministic tool_use uuid for the event's own (turn, step).
  assert.equal(toolCalls[0].message_uuid, `${toolCallDbId}:t1:s1:tool_use`);
  // Even without a tool-call content part in the assistant/message, the anchor
  // message itself is emitted so downstream uuid filters and the ADR-0008
  // nonce resolver never see a dangling reference.
  const anchors = values.filter((record) => record.kind === 'message' && record.content_type === 'tool_use');
  assert.deepEqual(anchors.map((record) => record.uuid), [`${toolCallDbId}:t1:s1:tool_use`]);
});

test('deepseek provider indexes incrementally by frame cursor with delta count mode', () => {
  const root = makeTempDir('obelisk-deepseek-incr-');
  const sessionDir = join(root, 'sessions', '--tmp-dsh-project--', 'incr-session');
  mkdirSync(sessionDir, { recursive: true });
  const logPath = join(sessionDir, 'session.jsonl.zstd');
  const header = [{ type: 'session', version: 0, id: 'incr-session', createdAt: 1753005600000, cwd: '/tmp/dsh-project', delegationDepth: 0, agentPreset: 'standard' }];
  const batch1 = [
    { type: 'user/message', seq: 1, time: 1753005601000, data: { content: [{ type: 'text', text: 'one' }], source: { kind: 'user' }, role: 'user', id: 'm1' }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 2, time: 1753005602000, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'two' }], source: { kind: 'model', model: 'deepseek-v4-flash' }, id: 'm2' }, usage: { inputTokens: 2, outputTokens: 1 } }, surfaceOp: 'append' },
  ];
  const batch2 = [
    { type: 'user/message', seq: 3, time: 1753005603000, data: { content: [{ type: 'text', text: 'three' }], source: { kind: 'user' }, role: 'user', id: 'm3' }, surfaceOp: 'append' },
  ];
  writeFileSync(logPath, Buffer.concat([mkFrame(header), mkFrame(batch1), mkFrame(batch2)]));

  const provider = createDeepseekProvider({ rootDir: join(root, 'sessions') });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const byKind = (values, kind) => values.filter((record) => record.kind === kind);

  // Full first parse: emits everything, countMode total, cursor = 3 frames.
  let { values, ret } = drain(provider.parse(unit, null));
  assert.equal(byKind(values, 'message').length, 3);
  assert.equal(byKind(values, 'session')[0].countMode, 'total');
  assert.equal(byKind(values, 'session')[0].message_count, 3);
  assert.equal(ret.split(':')[1], '3');

  // Append a new frame (live flush) and re-parse from the cursor: only the new
  // event is emitted, in delta mode.
  const batch3 = [
    { type: 'assistant/message', seq: 4, time: 1753005604000, data: { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'four' }], source: { kind: 'model', model: 'deepseek-v4-flash' }, id: 'm4' }, usage: { inputTokens: 3, outputTokens: 1 } }, surfaceOp: 'append' },
  ];
  writeFileSync(logPath, Buffer.concat([readFileSync(logPath), mkFrame(batch3)]));

  ({ values, ret } = drain(provider.parse(unit, ret)));
  const newMessages = byKind(values, 'message');
  assert.equal(newMessages.length, 1);
  assert.equal(newMessages[0].text, 'four');
  assert.equal(byKind(values, 'session')[0].countMode, 'delta');
  assert.equal(byKind(values, 'session')[0].message_count, 1);

  // No new committed frames: an empty delta, cursor advances without records.
  ({ values } = drain(provider.parse(unit, ret)));
  assert.equal(values.length, 0);
});

test('deepseek provider falls back to a full reparse when committed frames shrink', () => {
  const root = makeTempDir('obelisk-deepseek-shrink-');
  const sessionDir = join(root, 'sessions', '--tmp-dsh-project--', 'shrink-session');
  mkdirSync(sessionDir, { recursive: true });
  const logPath = join(sessionDir, 'session.jsonl.zstd');
  const header = [{ type: 'session', version: 0, id: 'shrink-session', createdAt: 1753005600000, cwd: '/tmp/dsh-project', delegationDepth: 0, agentPreset: 'standard' }];
  const batch1 = [
    { type: 'user/message', seq: 1, time: 1753005601000, data: { content: [{ type: 'text', text: 'one' }], source: { kind: 'user' }, role: 'user', id: 'm1' }, surfaceOp: 'append' },
  ];
  const batch2 = [
    { type: 'user/message', seq: 2, time: 1753005602000, data: { content: [{ type: 'text', text: 'two' }], source: { kind: 'user' }, role: 'user', id: 'm2' }, surfaceOp: 'append' },
  ];
  writeFileSync(logPath, Buffer.concat([mkFrame(header), mkFrame(batch1), mkFrame(batch2)]));

  const provider = createDeepseekProvider({ rootDir: join(root, 'sessions') });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const { ret } = drain(provider.parse(unit, null));
  assert.equal(ret.split(':')[1], '3');

  // dsh crash-repair truncates the torn tail: drop the last committed frame.
  const { frames } = scanZstdFrames(readFileSync(logPath));
  writeFileSync(logPath, readFileSync(logPath).subarray(0, frames[1].end));

  // The surviving committed prefix is re-indexed from scratch (countMode total).
  const { values } = drain(provider.parse(unit, ret));
  assert.equal(values.filter((record) => record.kind === 'message').length, 1);
  assert.equal(values.find((record) => record.kind === 'message').text, 'one');
  assert.equal(values.find((record) => record.kind === 'session').countMode, 'total');
});

test('deepseek provider decodes packed chunk rows and reads multi-frame zstd logs', () => {
  // decodeChunkRow reconstructs exact seq/time from seq0/time0 plus dt gaps.
  const expanded = decodeChunkRow({
    type: 'reasoning-chunks', seq0: 10, time0: 1000,
    data: { turn: 1, step: 1, index: 2, dt: [5, -2], texts: ['x', 'y', 'z'] },
  });
  assert.deepEqual(expanded.map((event) => [event.seq, event.time, event.data.chunk.text]), [
    [10, 1000, 'x'],
    [11, 1005, 'y'],
    [12, 1003, 'z'],
  ]);
  assert.throws(() => decodeChunkRow({ type: 'text-chunks', seq0: 0, time0: 0, data: { turn: 1, step: 1, index: 0, dt: [], texts: [] } }));

  // A multi-frame zstd artifact reads identically to the plaintext log.
  const root = makeTempDir('obelisk-deepseek-zstd-');
  const projectDir = join(root, 'sessions', '--tmp-dsh-project--');
  writeRootSession(join(projectDir, 'root-session-1'));
  const lines = readFileSync(join(projectDir, 'root-session-1', 'session.jsonl'), 'utf8').split('\n').filter(Boolean);
  const frames = [
    lines.slice(0, 1).join('\n') + '\n',
    lines.slice(1, 6).join('\n') + '\n',
    lines.slice(6).join('\n') + '\n',
  ].map((text) => zstdCompressSync(Buffer.from(text), { params: { [constants.ZSTD_c_checksumFlag]: 1 } }));
  writeFileSync(join(projectDir, 'root-session-1', 'session.jsonl.zstd'), Buffer.concat(frames));

  const provider = createDeepseekProvider({ rootDir: join(root, 'sessions') });
  const unit = provider.discover({ lastCursor: () => null }).find((u) => u.agentId === undefined);
  const { values } = drain(provider.parse(unit, null));
  assert.equal(values.filter((record) => record.kind === 'message').length, 7);
});

test('deepseek provider resolves raw lines by identity', () => {
  const root = writeDshFixture();
  const provider = createDeepseekProvider({ rootDir: join(root, 'sessions') });
  const unit = provider.discover({ lastCursor: () => null }).find((u) => u.agentId === undefined);
  const { values } = drain(provider.parse(unit, null));
  const userMessage = values.find((record) => record.kind === 'message' && record.role === 'user' && record.is_meta === 0);
  const textMessage = values.find((record) => record.kind === 'message' && record.text === 'doing it');

  const rawUser = provider.raw({ source: 'deepseek', messageUuid: userMessage.uuid, session: { jsonl_path: unit.key }, agentId: null });
  assert.ok(rawUser);
  assert.equal(rawUser.messageText, 'inspect the project');
  assert.match(rawUser.text, /"type":"user\/message"/);

  const rawAssistant = provider.raw({ source: 'deepseek', messageUuid: textMessage.uuid, session: { jsonl_path: unit.key }, agentId: null });
  assert.ok(rawAssistant);
  assert.equal(rawAssistant.messageText, 'doing it');
  assert.match(rawAssistant.text, /"type":"assistant\/message"/);
});

test('deepseek provider scopes changed-path discovery to the touched session file', () => {
  const root = writeDshFixture();
  const provider = createDeepseekProvider({ rootDir: join(root, 'sessions') });
  const initial = provider.discover({ lastCursor: () => null });
  const cursorByKey = new Map(initial.map((unit) => {
    const { ret } = drain(provider.parse(unit, null));
    return [unit.key, ret];
  }));
  const childKey = initial.find((unit) => unit.agentId !== undefined).key;

  const units = provider.discover({
    lastCursor: (key) => cursorByKey.get(key) ?? null,
    changedPaths: [childKey],
  });
  assert.deepEqual(units.map((unit) => unit.key), [childKey]);
});

test('vendored zstd decoder scans multi-frame logs and tolerates a torn tail', () => {
  const frame = (text) => zstdCompressSync(Buffer.from(text), { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
  const joined = Buffer.concat([frame('line1\n'), frame('line2\n'), frame('line3\n')]);

  const scan = scanZstdFrames(joined);
  assert.equal(scan.frames.length, 3);
  assert.equal(scan.tornStart, undefined);
  const decoder = createZstdFrameDecoder();
  let out = '';
  try {
    for (const decoded of decoder.decode(joined, scan.frames)) out += decoded.toString('utf8');
  } finally {
    decoder.close();
  }
  assert.equal(out, 'line1\nline2\nline3\n');

  // A torn final frame is structurally incomplete: complete frames remain, the
  // torn prefix is reported (and callers drop it), never decoded as garbage.
  const torn = Buffer.concat([joined, frame('torn-frame-bytes').subarray(0, 10)]);
  const tornScan = scanZstdFrames(torn);
  assert.equal(tornScan.frames.length, 3);
  assert.ok(tornScan.tornStart !== undefined);
  const tornDecoder = createZstdFrameDecoder();
  let tornOut = '';
  try {
    for (const decoded of tornDecoder.decode(torn, tornScan.frames)) tornOut += decoded.toString('utf8');
  } finally {
    tornDecoder.close();
  }
  assert.equal(tornOut, 'line1\nline2\nline3\n');

  // Invalid frame magic is corrupt storage, not a torn tail.
  const corrupt = Buffer.from('not-a-zstd-frame');
  assert.throws(() => scanZstdFrames(corrupt), /invalid frame magic/);
});

// Regression: upstream tool names are lowercase ('read'/'edit'/'write'/'skill'),
// unlike Claude's capitalized names the shared parsing.ts helpers recognize.
test('deepseek provider maps lowercase dsh tool names to file_path and skill presentation', () => {
  const root = makeTempDir('obelisk-deepseek-lowercase-');
  const sessionDir = join(root, 'sessions', '--proj--', 'lc-session');
  mkdirSync(sessionDir, { recursive: true });
  const events = [
    { type: 'session', version: 0, id: 'lc-session', createdAt: 1753005600000, cwd: '/proj', delegationDepth: 0 },
    { type: 'tool/call', seq: 1, time: 1753005601000, data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"file_path":"/proj/x.ts"}' } },
    { type: 'tool/call', seq: 2, time: 1753005602000, data: { turn: 1, step: 2, callId: 'c2', name: 'skill', arguments: '{"name":"pdf"}' } },
  ];
  writeFileSync(join(sessionDir, 'session.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n');

  const provider = createDeepseekProvider({ rootDir: join(root, 'sessions') });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const { values } = drain(provider.parse(unit, null));
  const calls = values.filter((record) => record.kind === 'tool_call');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, 'read');
  assert.equal(calls[0].file_path, '/proj/x.ts');
  assert.equal(calls[0].presentation, 'default');
  assert.equal(calls[1].name, 'skill');
  assert.equal(calls[1].presentation, 'skill');
});

// Regression: a malformed packed chunk row must not abort the whole session's
// parse — its members only duplicate content the final assistant/message holds.
test('deepseek provider tolerates a malformed packed chunk row', () => {
  const root = makeTempDir('obelisk-deepseek-badchunk-');
  const sessionDir = join(root, 'sessions', '--proj--', 'bad-chunk-session');
  mkdirSync(sessionDir, { recursive: true });
  const events = [
    { type: 'session', version: 0, id: 'bad-chunk-session', createdAt: 1753005600000, cwd: '/proj', delegationDepth: 0 },
    { type: 'user/message', seq: 1, time: 1753005601000, data: { content: [{ type: 'text', text: 'before' }], source: { kind: 'user' }, role: 'user', id: 'm-1' } },
    // dt length (1) does not match members (3): malformed storage row.
    { type: 'text-chunks', seq0: 10, time0: 1753005601500, data: { turn: 1, step: 1, index: 0, dt: [5], texts: ['a', 'b', 'c'] } },
    { type: 'assistant/message', seq: 2, time: 1753005602000, data: {
      turn: 1, step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'after' }], source: { kind: 'model', model: 'deepseek-v4-flash' }, id: 'm-2' },
      usage: { inputTokens: 1, outputTokens: 1 },
    } },
  ];
  writeFileSync(join(sessionDir, 'session.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n');

  const provider = createDeepseekProvider({ rootDir: join(root, 'sessions') });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const { values } = drain(provider.parse(unit, null));
  const texts = values.filter((record) => record.kind === 'message').map((record) => record.text);
  assert.deepEqual(texts, ['before', 'after']);
});

// Regression: one-shot subagent descriptors carry only `provider`/`label`
// (agentProvider/agentModel exist only in continuable mode).
test('deepseek provider falls back to descriptor.provider for one-shot subagent agent_type', () => {
  const root = makeTempDir('obelisk-deepseek-oneshot-');
  const sessionDir = join(root, 'sessions', '--proj--', 'one-shot-child');
  mkdirSync(sessionDir, { recursive: true });
  const events = [
    { type: 'session', version: 0, id: 'one-shot-child', createdAt: 1753005600000, cwd: '/proj', parentSession: 'root-x', origin: 'subagent', delegationDepth: 1 },
    { type: 'subagent/descriptor', seq: 0, time: 1753005600100, data: { version: 2, mode: 'one-shot', provider: 'code', label: 'fix the bug' } },
    { type: 'user/message', seq: 1, time: 1753005601000, data: { content: [{ type: 'text', text: 'do it' }], source: { kind: 'user' }, role: 'user', id: 'm-1' } },
  ];
  writeFileSync(join(sessionDir, 'session.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n');

  const provider = createDeepseekProvider({ rootDir: join(root, 'sessions') });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const { values } = drain(provider.parse(unit, null));
  const subagent = values.find((record) => record.kind === 'subagent');
  assert.equal(subagent.agent_type, 'code');
  assert.equal(subagent.description, 'fix the bug');
});

// Regression: the sessions root honors $DSH_HOME (blank counts as unset),
// matching upstream resolveDshHome semantics.
test('deepseek provider resolves the sessions root from $DSH_HOME', () => {
  const original = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = '/tmp/custom-dsh-home';
    assert.equal(createDeepseekProvider().descriptor.defaultRoot, join('/tmp/custom-dsh-home', 'sessions'));
    process.env.DSH_HOME = '   ';
    assert.equal(createDeepseekProvider().descriptor.defaultRoot, join(homedir(), '.dsh', 'sessions'));
    delete process.env.DSH_HOME;
    assert.equal(createDeepseekProvider().descriptor.defaultRoot, join(homedir(), '.dsh', 'sessions'));
  } finally {
    if (original === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = original;
  }
});

// Regression: a delta-window-first message must get the same parent_uuid a
// full reparse would give it (seeded from the last event before the window).
test('deepseek provider seeds the parent chain across an incremental window boundary', () => {
  const root = makeTempDir('obelisk-deepseek-parentseed-');
  const sessionDir = join(root, 'sessions', '--tmp-dsh-project--', 'seed-session');
  mkdirSync(sessionDir, { recursive: true });
  const path = join(sessionDir, 'session.jsonl');
  const header = { type: 'session', version: 0, id: 'seed-session', createdAt: 1753005600000, cwd: '/tmp/dsh-project', delegationDepth: 0 };
  const first = [
    header,
    { type: 'user/message', seq: 1, time: 1753005601000, data: { content: [{ type: 'text', text: 'one' }], source: { kind: 'user' }, role: 'user', id: 'm-1' } },
  ];
  const second = [
    { type: 'assistant/message', seq: 2, time: 1753005602000, data: {
      turn: 1, step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'two' }], source: { kind: 'model', model: 'deepseek-v4-flash' }, id: 'm-2' },
      usage: { inputTokens: 1, outputTokens: 1 },
    } },
  ];
  writeFileSync(path, first.map((event) => JSON.stringify(event)).join('\n') + '\n');

  const provider = createDeepseekProvider({ rootDir: join(root, 'sessions') });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const cursor = drain(provider.parse(unit, null)).ret;

  writeFileSync(path, [...first, ...second].map((event) => JSON.stringify(event)).join('\n') + '\n');
  const { values } = drain(provider.parse(unit, cursor));
  const appended = values.find((record) => record.kind === 'message' && record.text === 'two');
  const scope = createHash('sha256').update('deepseek-cwd-v1\0').update('/tmp/dsh-project').digest('hex');
  assert.equal(appended.parent_uuid, `deepseek:seed-session:${scope}:um-1`);
});

// Regression: a shrink below the cursor forces a full reparse AND retracts the
// rows projected from the frames that are gone, so no stale messages survive.
test('deepseek provider retracts stale rows on the shrink fallback', () => {
  const root = makeTempDir('obelisk-deepseek-retract-');
  const sessionDir = join(root, 'sessions', '--tmp-dsh-project--', 'retract-session');
  mkdirSync(sessionDir, { recursive: true });
  const path = join(sessionDir, 'session.jsonl');
  const header = { type: 'session', version: 0, id: 'retract-session', createdAt: 1753005600000, cwd: '/tmp/dsh-project', delegationDepth: 0 };
  const event = (seq, text) => ({ type: 'user/message', seq, time: 1753005601000 + seq, data: { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user', id: `m-${seq}` } });
  writeFileSync(path, [header, event(1, 'keep-1'), event(2, 'stale-2'), event(3, 'stale-3')].map((e) => JSON.stringify(e)).join('\n') + '\n');

  const provider = createDeepseekProvider({ rootDir: join(root, 'sessions') });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const cursor = persist(db, unit, provider.parse(unit, null));
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages').get().c, 3);

  // The file shrinks below the cursor (repair/replacement): full reparse.
  writeFileSync(path, [header, event(1, 'keep-1')].map((e) => JSON.stringify(e)).join('\n') + '\n');
  persist(db, unit, provider.parse(unit, cursor));
  const remaining = db.prepare('SELECT text FROM messages ORDER BY timestamp').all().map((row) => row.text);
  assert.deepEqual(remaining, ['keep-1']);
  db.close();
});

// Regression: an assistant turn with usage but no text/reasoning/tool-call
// parts still emits a message so the step's tokens are never dropped.
test('deepseek provider keeps usage of a parts-less assistant turn', () => {
  const root = makeTempDir('obelisk-deepseek-usageonly-');
  const sessionDir = join(root, 'sessions', '--proj--', 'usage-session');
  mkdirSync(sessionDir, { recursive: true });
  const events = [
    { type: 'session', version: 0, id: 'usage-session', createdAt: 1753005600000, cwd: '/proj', delegationDepth: 0 },
    { type: 'assistant/message', seq: 1, time: 1753005601000, data: {
      turn: 1, step: 1,
      message: { role: 'assistant', content: [], source: { kind: 'model', model: 'deepseek-v4-flash' }, id: 'm-1' },
      usage: { inputTokens: 42, outputTokens: 7 },
    } },
  ];
  writeFileSync(join(sessionDir, 'session.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');

  const provider = createDeepseekProvider({ rootDir: join(root, 'sessions') });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const { values } = drain(provider.parse(unit, null));
  const messages = values.filter((record) => record.kind === 'message');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content_type, 'unknown'); // CONTRIBUTING: textless rows are 'unknown', not 'text'
  assert.equal(messages[0].input_tokens, 42);
  assert.equal(messages[0].output_tokens, 7);
});

// Regression (CONTRIBUTING): session identity must not be the source id alone
// — two projects reusing one raw id must not overwrite each other.
test('deepseek provider namespaces identity by project scope', () => {
  const root = makeTempDir('obelisk-deepseek-scope-');
  const provider0 = createDeepseekProvider({ rootDir: join(root, 'sessions') });
  for (const project of ['--proj-a--', '--proj-b--']) {
    const sessionDir = join(root, 'sessions', project, 'shared-id');
    mkdirSync(sessionDir, { recursive: true });
    const cwd = project === '--proj-a--' ? '/proj/a' : '/proj/b';
    const events = [
      { type: 'session', version: 0, id: 'shared-id', createdAt: 1753005600000, cwd, delegationDepth: 0 },
      { type: 'user/message', seq: 1, time: 1753005601000, data: { content: [{ type: 'text', text: `hi from ${cwd}` }], source: { kind: 'user' }, role: 'user', id: 'm-1' } },
    ];
    writeFileSync(join(sessionDir, 'session.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  const units = provider0.discover({ lastCursor: () => null });
  assert.equal(units.length, 2);
  const sessionIds = units.map((unit) => unit.sessionId);
  assert.notEqual(sessionIds[0], sessionIds[1]);
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  for (const unit of units) persist(db, unit, provider0.parse(unit, null));
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages').get().c, 2);
  db.close();
});

// Regression (CONTRIBUTING): the cursor must detect same-millisecond rewrites
// via the mtime+size+ctime+inode signature, not mtime alone.
test('deepseek provider re-discovers a same-mtime changed file via the cursor signature', () => {
  const root = makeTempDir('obelisk-deepseek-cursor-');
  const sessionDir = join(root, 'sessions', '--proj--', 'cursor-session');
  mkdirSync(sessionDir, { recursive: true });
  const path = join(sessionDir, 'session.jsonl');
  const header = { type: 'session', version: 0, id: 'cursor-session', createdAt: 1753005600000, cwd: '/proj', delegationDepth: 0 };
  writeFileSync(path, [header].map((e) => JSON.stringify(e)).join('\n') + '\n');

  const provider = createDeepseekProvider({ rootDir: join(root, 'sessions') });
  const cursor = drain(provider.parse(provider.discover({ lastCursor: () => null })[0], null)).ret;

  // Same file, unchanged: signature matches, skipped.
  assert.deepEqual(provider.discover({ lastCursor: () => cursor }), []);

  // Fabricate a cursor with the right mtime/count but wrong size/ctime/ino:
  // the file must come back into discovery.
  const [mtime, count] = cursor.split(':');
  const staleCursor = `${mtime}:${count}:1:1:1`;
  assert.equal(provider.discover({ lastCursor: () => staleCursor }).length, 1);
});

// ---- real-artifact fixtures (CONTRIBUTING: fixtures are real provider output) ----

const REAL_FIXTURE_ROOT = new URL('./fixtures/deepseek/sessions', import.meta.url).pathname;

test('deepseek provider parses real dsh artifacts (zstd, packed chunks, subagent) end to end', () => {
  const provider = createDeepseekProvider({ rootDir: REAL_FIXTURE_ROOT });
  const units = provider.discover({ lastCursor: () => null });
  assert.equal(units.length, 2);
  const rootUnit = units.find((unit) => unit.agentId === undefined);
  const childUnit = units.find((unit) => unit.agentId !== undefined);
  assert.ok(rootUnit && childUnit);
  assert.equal(childUnit.isSubagent, true);
  assert.equal(childUnit.sessionId, rootUnit.sessionId); // folds into the root

  const rootRecords = drain(provider.parse(rootUnit, null)).values;
  const childRecords = drain(provider.parse(childUnit, null)).values;
  const kinds = new Set(rootRecords.map((record) => record.kind));
  assert.ok(kinds.has('session') && kinds.has('message') && kinds.has('tool_call') && kinds.has('tool_result'));

  // Every tool_call/tool_result anchors on a message that actually exists.
  const messageUuids = new Set(
    [...rootRecords, ...childRecords].filter((record) => record.kind === 'message').map((record) => record.uuid),
  );
  for (const record of [...rootRecords, ...childRecords]) {
    if (record.kind === 'tool_call' || record.kind === 'tool_result') {
      assert.ok(messageUuids.has(record.message_uuid), `dangling anchor: ${record.message_uuid}`);
    }
  }
  // No message links to itself (trace()/context() safety on real data).
  for (const record of [...rootRecords, ...childRecords]) {
    if (record.kind === 'message') assert.notEqual(record.parent_uuid, record.uuid);
  }
  const subagentRow = childRecords.find((record) => record.kind === 'subagent');
  assert.ok(subagentRow && subagentRow.agent_id === childUnit.agentId);

  // Persist round-trip over BOTH units preserves the assembled detail.
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  persist(db, rootUnit, provider.parse(rootUnit, null));
  persist(db, childUnit, provider.parse(childUnit, null));
  const fresh = assembleSessionDetail([...rootRecords, ...childRecords]);
  const persisted = assembleSessionDetail({
    session: db.prepare('SELECT * FROM sessions').get(),
    messages: db.prepare('SELECT * FROM messages ORDER BY timestamp, uuid').all(),
    toolCalls: db.prepare('SELECT * FROM tool_calls').all(),
    toolResults: db.prepare('SELECT * FROM tool_results').all(),
    subagents: db.prepare('SELECT * FROM subagents').all(),
  });
  assert.deepEqual(persisted, fresh);
  db.close();
});

// Regression: two tool/calls of one step straddling the cursor must not make
// the re-emitted anchor its own parent (trace()/context() infinite loop).
test('deepseek provider never self-links a re-emitted anchor at a frame boundary', () => {
  const root = makeTempDir('obelisk-deepseek-selfparent-');
  const sessionDir = join(root, 'sessions', '--proj--', 'self-parent-session');
  mkdirSync(sessionDir, { recursive: true });
  const path = join(sessionDir, 'session.jsonl');
  const header = { type: 'session', version: 0, id: 'self-parent-session', createdAt: 1753005600000, cwd: '/proj', delegationDepth: 0 };
  const first = [
    header,
    { type: 'assistant/message', seq: 1, time: 1753005601000, data: {
      turn: 1, step: 1,
      message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }], source: { kind: 'model', model: 'deepseek-v4-flash' }, id: 'a-1' },
      usage: { inputTokens: 1, outputTokens: 1 },
    } },
    { type: 'tool/call', seq: 2, time: 1753005601100, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' } },
  ];
  writeFileSync(path, first.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const provider = createDeepseekProvider({ rootDir: join(root, 'sessions') });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const cursor = drain(provider.parse(unit, null)).ret;

  // Second durable tool/call of the SAME step lands in a later window.
  const second = [{ type: 'tool/call', seq: 3, time: 1753005601200, data: { turn: 1, step: 1, callId: 'c2', name: 'bash', arguments: '{}' } }];
  writeFileSync(path, [...first, ...second].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const { values } = drain(provider.parse(unit, cursor));
  const anchor = values.find((record) => record.kind === 'message' && record.content_type === 'tool_use');
  assert.ok(anchor);
  assert.notEqual(anchor.parent_uuid, anchor.uuid);
  assert.equal(anchor.parent_uuid, null); // self-link guarded, chain stays finite
});

// Regression: an equal-count replacement must be reparsed (signature mismatch),
// not accepted as "no new events".
test('deepseek provider reparses an equal-line-count replacement', () => {
  const root = makeTempDir('obelisk-deepseek-replaced-');
  const sessionDir = join(root, 'sessions', '--proj--', 'replace-session');
  mkdirSync(sessionDir, { recursive: true });
  const path = join(sessionDir, 'session.jsonl');
  const header = { type: 'session', version: 0, id: 'replace-session', createdAt: 1753005600000, cwd: '/proj', delegationDepth: 0 };
  const event = (text) => ({ type: 'user/message', seq: 1, time: 1753005601000, data: { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user', id: 'm-1' } });
  writeFileSync(path, [header, event('OLD_TEXT')].map((e) => JSON.stringify(e)).join('\n') + '\n');

  const provider = createDeepseekProvider({ rootDir: join(root, 'sessions') });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const cursor = persist(db, unit, provider.parse(unit, null));

  // Replace with the SAME line count but different content (mtime/size change).
  writeFileSync(path, [header, event('NEW_TEXT!!')].map((e) => JSON.stringify(e)).join('\n') + '\n');
  persist(db, unit, provider.parse(unit, cursor));
  const texts = db.prepare('SELECT text FROM messages').all().map((row) => row.text);
  assert.deepEqual(texts, ['NEW_TEXT!!']);
  db.close();
});

// Regression: unit-scoped retraction — a root shrink must not drop unchanged
// child data; a child shrink must not drop the parent-contributed columns.
test('deepseek provider retracts only the reparsed unit scope on shrink', () => {
  const root = makeTempDir('obelisk-deepseek-scopedretract-');
  const sessionsDir = join(root, 'sessions');
  const projectDir = join(sessionsDir, '--proj--');
  const cwd = '/proj';
  const rootHeader = { type: 'session', version: 0, id: 'root-s', createdAt: 1753005600000, cwd, delegationDepth: 0 };
  const childHeader = { type: 'session', version: 0, id: 'child-s', createdAt: 1753005600100, cwd, parentSession: 'root-s', origin: 'subagent', delegationDepth: 1 };
  const rootEvents = (extra) => [
    rootHeader,
    { type: 'assistant/message', seq: 1, time: 1753005601000, data: {
      turn: 1, step: 1,
      message: { role: 'assistant', content: [{ type: 'tool-call', id: 'sp', name: 'subagent', arguments: '{}' }], source: { kind: 'model', model: 'deepseek-v4-flash' }, id: 'a-1' },
      usage: { inputTokens: 1, outputTokens: 1 },
    } },
    { type: 'tool/call', seq: 2, time: 1753005601100, data: { turn: 1, step: 1, callId: 'sp', name: 'subagent', arguments: '{}' } },
    { type: 'tool/result', seq: 3, time: 1753005601200, data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'sp' }, content: [{ type: 'tool-result', toolCallId: 'sp', content: [{ type: 'text', text: 'started subagent child-s' }] }], role: 'user', id: 'r-1' } } },
    ...extra,
  ];
  const childEvents = (extra) => [
    childHeader,
    { type: 'subagent/descriptor', seq: 1, time: 1753005600200, data: { version: 2, mode: 'one-shot', provider: 'code', label: 'helper' } },
    { type: 'user/message', seq: 2, time: 1753005601300, data: { content: [{ type: 'text', text: 'child says hi' }], source: { kind: 'user' }, role: 'user', id: 'cm-1' } },
    ...extra,
  ];
  const rootDir2 = join(projectDir, 'root-s');
  const childDir2 = join(projectDir, 'child-s');
  mkdirSync(rootDir2, { recursive: true });
  mkdirSync(childDir2, { recursive: true });
  const rootPath = join(rootDir2, 'session.jsonl');
  const childPath = join(childDir2, 'session.jsonl');
  const extraRoot = [{ type: 'user/message', seq: 4, time: 1753005601400, data: { content: [{ type: 'text', text: 'stale root msg' }], source: { kind: 'user' }, role: 'user', id: 'm-9' } }];
  const extraChild = [{ type: 'user/message', seq: 5, time: 1753005601500, data: { content: [{ type: 'text', text: 'stale child msg' }], source: { kind: 'user' }, role: 'user', id: 'cm-9' } }];
  writeFileSync(rootPath, rootEvents(extraRoot).map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(childPath, childEvents(extraChild).map((e) => JSON.stringify(e)).join('\n') + '\n');

  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const cursors = new Map();
  for (const unit of provider.discover({ lastCursor: () => null })) {
    cursors.set(unit.key, persist(db, unit, provider.parse(unit, null)));
  }
  const childRowCount = () => db.prepare('SELECT COUNT(*) AS c FROM messages WHERE agent_id IS NOT NULL').get().c;
  const subagentRow = () => db.prepare('SELECT * FROM subagents').get();
  assert.equal(childRowCount(), 2); // two sidechain messages incl. the stale one
  assert.ok(subagentRow().parent_tool_use_id);

  // Root shrinks: stale root rows retracted, child rows and subagent row intact.
  writeFileSync(rootPath, rootEvents([]).map((e) => JSON.stringify(e)).join('\n') + '\n');
  const rootUnit = provider.discover({ lastCursor: (key) => cursors.get(key) ?? null }).find((u) => u.key === rootPath);
  cursors.set(rootPath, persist(db, rootUnit, provider.parse(rootUnit, cursors.get(rootPath))));
  assert.deepEqual(db.prepare('SELECT text FROM messages WHERE agent_id IS NULL AND type=\'user\'').all(), []);
  assert.equal(childRowCount(), 2); // child data NOT cascaded away
  assert.ok(subagentRow().parent_tool_use_id);

  // Child shrinks: stale child rows retracted, parent-contributed column kept.
  writeFileSync(childPath, childEvents([]).map((e) => JSON.stringify(e)).join('\n') + '\n');
  const childUnit = provider.discover({ lastCursor: (key) => cursors.get(key) ?? null }).find((u) => u.key === childPath);
  persist(db, childUnit, provider.parse(childUnit, cursors.get(childPath)));
  assert.equal(childRowCount(), 1); // only the kept child message
  assert.equal(subagentRow().parent_tool_use_id !== null, true); // parent contribution preserved
  assert.equal(subagentRow().agent_type, 'code'); // child metadata re-merged
  db.close();
});

// Regression: raw() must disambiguate duplicate raw ids across projects by scope.
test('deepseek provider raw lookup honors the project scope', () => {
  const root = makeTempDir('obelisk-deepseek-rawscope-');
  const sessionsDir = join(root, 'sessions');
  const markerByCwd = { '/proj/a': 'CONTENT_FROM_A', '/proj/b': 'CONTENT_FROM_B' };
  for (const [cwd, marker] of Object.entries(markerByCwd)) {
    const dir = join(sessionsDir, `--${cwd.slice(1).replace('/', '-')}--`, 'dup-id');
    mkdirSync(dir, { recursive: true });
    const events = [
      { type: 'session', version: 0, id: 'dup-id', createdAt: 1753005600000, cwd, delegationDepth: 0 },
      { type: 'user/message', seq: 1, time: 1753005601000, data: { content: [{ type: 'text', text: marker }], source: { kind: 'user' }, role: 'user', id: 'm-1' } },
    ];
    writeFileSync(join(dir, 'session.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const units = provider.discover({ lastCursor: () => null });
  assert.equal(units.length, 2);
  for (const unit of units) {
    const { values } = drain(provider.parse(unit, null));
    const msg = values.find((record) => record.kind === 'message');
    const raw = provider.raw({ source: 'deepseek', messageUuid: msg.uuid, session: null, agentId: null });
    assert.ok(raw.text.includes(msg.text), `raw for ${msg.uuid} returned the wrong project's file`);
  }
});

// Regression: parent seeding scans back past any number of chunk-only frames
// (no format bound on how far the previous projectable event is).
test('deepseek provider seeds the parent chain beyond chunk-only frames', () => {
  const root = makeTempDir('obelisk-deepseek-deepseed-');
  const sessionDir = join(root, 'sessions', '--tmp-dsh-project--', 'deep-seed-session');
  mkdirSync(sessionDir, { recursive: true });
  const path = join(sessionDir, 'session.jsonl.zstd');
  const header = { type: 'session', version: 0, id: 'deep-seed-session', createdAt: 1753005600000, cwd: '/tmp/dsh-project', delegationDepth: 0 };
  const firstMsg = { type: 'user/message', seq: 1, time: 1753005601000, data: { content: [{ type: 'text', text: 'early' }], source: { kind: 'user' }, role: 'user', id: 'm-1' } };
  // Six frames of packed chunk rows only — no projectable event among them.
  const chunkFrame = (i) => ({ type: 'text-chunks', seq0: 10 + i * 10, time0: 1753005602000 + i, data: { turn: 1, step: 1, index: 0, dt: [1, 1], texts: ['a', 'b', 'c'] } });
  const frames = [
    mkFrame([header]),
    mkFrame([firstMsg]),
    ...Array.from({ length: 6 }, (_, i) => mkFrame([chunkFrame(i)])),
  ];
  writeFileSync(path, Buffer.concat(frames));

  const provider = createDeepseekProvider({ rootDir: join(root, 'sessions') });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const cursor = drain(provider.parse(unit, null)).ret;

  const lateMsg = { type: 'assistant/message', seq: 100, time: 1753005603000, data: {
    turn: 2, step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text: 'late' }], source: { kind: 'model', model: 'deepseek-v4-flash' }, id: 'm-2' },
    usage: { inputTokens: 1, outputTokens: 1 },
  } };
  writeFileSync(path, Buffer.concat([...frames, mkFrame([lateMsg])]));
  const { values } = drain(provider.parse(unit, cursor));
  const late = values.find((record) => record.kind === 'message' && record.text === 'late');
  const scope = createHash('sha256').update('deepseek-cwd-v1\0').update('/tmp/dsh-project').digest('hex');
  assert.equal(late.parent_uuid, `deepseek:deep-seed-session:${scope}:um-1`);
});

// Regression: a step straddling runs (provisional anchor from a durable
// tool/call, canonical anchor from the assistant/message in a later window)
// must converge to the canonical row — model/usage survive and the anchor is
// not double-counted.
test('deepseek provider converges a straddled anchor to its canonical row', () => {
  const root = makeTempDir('obelisk-deepseek-straddle-');
  const sessionDir = join(root, 'sessions', '--tmp-dsh-project--', 'straddle-session');
  mkdirSync(sessionDir, { recursive: true });
  const path = join(sessionDir, 'session.jsonl');
  const header = { type: 'session', version: 0, id: 'straddle-session', createdAt: 1753005600000, cwd: '/tmp/dsh-project', delegationDepth: 0 };
  const first = [
    header,
    { type: 'user/message', seq: 1, time: 1753005601000, data: { content: [{ type: 'text', text: 'go' }], source: { kind: 'user' }, role: 'user', id: 'm-1' } },
    { type: 'tool/call', seq: 2, time: 1753005601100, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' } },
  ];
  writeFileSync(path, first.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const provider = createDeepseekProvider({ rootDir: join(root, 'sessions') });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const cursor = persist(db, unit, provider.parse(unit, null));

  const second = [
    { type: 'tool/call', seq: 3, time: 1753005601200, data: { turn: 1, step: 1, callId: 'c2', name: 'bash', arguments: '{}' } },
    { type: 'assistant/message', seq: 4, time: 1753005602000, data: {
      turn: 1, step: 1,
      message: { role: 'assistant', content: [
        { type: 'text', text: 'done' },
        { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
        { type: 'tool-call', id: 'c2', name: 'bash', arguments: '{}' },
      ], source: { kind: 'model', model: 'deepseek-v4-flash' }, id: 'a-1' },
      usage: { inputTokens: 9, outputTokens: 3 },
    } },
  ];
  writeFileSync(path, [...first, ...second].map((e) => JSON.stringify(e)).join('\n') + '\n');
  persist(db, unit, provider.parse(unit, cursor));

  const scope = createHash('sha256').update('deepseek-cwd-v1\0').update('/tmp/dsh-project').digest('hex');
  const anchorUuid = `deepseek:straddle-session:${scope}:t1:s1:tool_use`;
  const anchor = db.prepare('SELECT * FROM messages WHERE uuid=?').get(anchorUuid);
  assert.equal(anchor.model, 'deepseek-v4-flash'); // canonical row survived
  assert.notEqual(anchor.parent_uuid, anchor.uuid);
  // user + text message only: the anchor is structural and never double-counted.
  assert.equal(db.prepare('SELECT message_count AS c FROM sessions').get().c, 2);
  db.close();
});

// Regression: a replacement with MORE lines but a new inode is a replacement,
// not an append (no OLD_PREFIX + NEW_SUFFIX splicing).
test('deepseek provider reparses an inode-changed file even when it grew', () => {
  const root = makeTempDir('obelisk-deepseek-inode-');
  const sessionDir = join(root, 'sessions', '--proj--', 'inode-session');
  mkdirSync(sessionDir, { recursive: true });
  const path = join(sessionDir, 'session.jsonl');
  const header = { type: 'session', version: 0, id: 'inode-session', createdAt: 1753005600000, cwd: '/proj', delegationDepth: 0 };
  const event = (seq, text) => ({ type: 'user/message', seq, time: 1753005601000 + seq, data: { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user', id: `m-${seq}` } });
  writeFileSync(path, [header, event(1, 'OLD_PREFIX')].map((e) => JSON.stringify(e)).join('\n') + '\n');

  const provider = createDeepseekProvider({ rootDir: join(root, 'sessions') });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const cursor = persist(db, unit, provider.parse(unit, null));

  // Replace via rename (new inode) with a LONGER file of different content.
  const tmpPath = join(sessionDir, 'session.jsonl.tmp');
  writeFileSync(tmpPath, [header, event(1, 'NEW_A'), event(2, 'NEW_B'), event(3, 'NEW_C')].map((e) => JSON.stringify(e)).join('\n') + '\n');
  renameSync(tmpPath, path);
  persist(db, unit, provider.parse(unit, cursor));
  const texts = db.prepare('SELECT text FROM messages ORDER BY timestamp').all().map((row) => row.text);
  assert.deepEqual(texts, ['NEW_A', 'NEW_B', 'NEW_C']);
  db.close();
});

// Regression: a root shrink that removes a spawn clears the now-dangling
// parent_tool_use_id, and ended_at is replaced (not max-merged) on 'total'.
test('deepseek provider clears stale aggregates on a root shrink', () => {
  const root = makeTempDir('obelisk-deepseek-aggregates-');
  const sessionsDir = join(root, 'sessions');
  const sessionDir = join(sessionsDir, '--proj--', 'agg-session');
  mkdirSync(sessionDir, { recursive: true });
  const path = join(sessionDir, 'session.jsonl');
  const header = { type: 'session', version: 0, id: 'agg-session', createdAt: 1753005600000, cwd: '/proj', delegationDepth: 0 };
  const spawnEvents = [
    { type: 'assistant/message', seq: 1, time: 1753005601000, data: {
      turn: 1, step: 1,
      message: { role: 'assistant', content: [{ type: 'tool-call', id: 'sp', name: 'subagent', arguments: '{}' }], source: { kind: 'model', model: 'm' }, id: 'a-1' },
      usage: { inputTokens: 1, outputTokens: 1 },
    } },
    { type: 'tool/call', seq: 2, time: 1753005601100, data: { turn: 1, step: 1, callId: 'sp', name: 'subagent', arguments: '{}' } },
    { type: 'tool/result', seq: 3, time: 1753005601200, data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'sp' }, content: [{ type: 'tool-result', toolCallId: 'sp', content: [{ type: 'text', text: 'started subagent kid-1' }] }], role: 'user', id: 'r-1' } } },
  ];
  const lateEvent = { type: 'user/message', seq: 4, time: 1753005699000, data: { content: [{ type: 'text', text: 'late' }], source: { kind: 'user' }, role: 'user', id: 'm-9' } };
  writeFileSync(path, [header, ...spawnEvents, lateEvent].map((e) => JSON.stringify(e)).join('\n') + '\n');

  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const cursor = persist(db, unit, provider.parse(unit, null));
  assert.ok(db.prepare('SELECT parent_tool_use_id AS p FROM subagents').get().p);
  assert.equal(db.prepare('SELECT ended_at AS e FROM sessions').get().e, new Date(1753005699000).toISOString()); // late event time

  // Truncation removes BOTH the spawn and the late event.
  writeFileSync(path, [header].map((e) => JSON.stringify(e)).join('\n') + '\n');
  persist(db, unit, provider.parse(unit, cursor));
  assert.equal(db.prepare('SELECT parent_tool_use_id AS p FROM subagents').get()?.p ?? null, null);
  // Header-only file: no event timestamps remain, so the authoritative total reparse clears ended_at.
  assert.equal(db.prepare('SELECT ended_at AS e FROM sessions').get().e, null);
  db.close();
});

// Regression: a nested subagent whose intermediate parent raw id exists in
// ANOTHER project must not fold along that project's chain.
test('deepseek provider resolves ancestry within the project scope only', () => {
  const root = makeTempDir('obelisk-deepseek-ancestry-');
  const sessionsDir = join(root, 'sessions');
  // Project A has a session 'mid-1' (a root there).
  const dirA = join(sessionsDir, '--proj-a--', 'mid-1');
  mkdirSync(dirA, { recursive: true });
  writeFileSync(join(dirA, 'session.jsonl'), [
    JSON.stringify({ type: 'session', version: 0, id: 'mid-1', createdAt: 1753005600000, cwd: '/proj/a', delegationDepth: 0 }),
  ].join('\n') + '\n');
  // Project B: grandchild -> parent 'mid-1' — but B has no 'mid-1'; it must
  // NOT fold into A's session.
  const dirB = join(sessionsDir, '--proj-b--', 'grandchild-1');
  mkdirSync(dirB, { recursive: true });
  writeFileSync(join(dirB, 'session.jsonl'), [
    JSON.stringify({ type: 'session', version: 0, id: 'grandchild-1', createdAt: 1753005600000, cwd: '/proj/b', parentSession: 'mid-1', origin: 'subagent', delegationDepth: 2 }),
    JSON.stringify({ type: 'user/message', seq: 1, time: 1753005601000, data: { content: [{ type: 'text', text: 'gc' }], source: { kind: 'user' }, role: 'user', id: 'm-1' } }),
  ].join('\n') + '\n');

  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const units = provider.discover({ lastCursor: () => null });
  const a = units.find((u) => u.key.includes('--proj-a--'));
  const b = units.find((u) => u.key.includes('--proj-b--'));
  assert.notEqual(b.sessionId, a.sessionId); // no phantom fold across projects
  assert.ok(b.sessionId.includes('mid-1')); // folds to its OWN scope's (missing) parent id, not A's row
});
