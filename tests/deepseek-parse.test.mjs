// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, zstdCompressSync } from 'node:zlib';

import { createDeepseekProvider, decodeChunkRow } from '../packages/core/src/providers/deepseek.ts';
import { assembleSessionDetail } from '../packages/core/src/session-detail.ts';
import { createZstdFrameDecoder, scanZstdFrames } from '../packages/core/src/vendor/dsh-zstd.ts';
import { makeTempDir } from './temp-dirs.mjs';

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
  assert.equal(rootUnit.sessionId, 'deepseek:root-session-1');
  assert.equal(rootUnit.project, '-tmp-dsh-project');
  assert.equal(childUnit.sessionId, 'deepseek:root-session-1');
  assert.equal(childUnit.agentId, 'deepseek:child-session-1');
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
    '6956cf88b3fb37bb106cb4e7a4ea12df7500369c5cd4b90e7c86305eb3d98dd9',
    'complete yielded record sequence changed',
  );

  assert.match(ret, /^\d+(?:\.\d+)?:\d+$/);

  const session = byKind('session')[0];
  assert.deepEqual(
    (({ id, title, project, source, countMode, message_count }) => ({ id, title, project, source, countMode, message_count }))(session),
    {
      id: 'deepseek:root-session-1',
      title: 'Fixture title',
      project: '-tmp-dsh-project',
      source: 'deepseek',
      countMode: 'total',
      message_count: 7,
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
  assert.equal(messages[2].uuid, 'deepseek:root-session-1:t1:s1:text');
  assert.equal(messages[3].uuid, 'deepseek:root-session-1:t1:s1:tool_use');
  assert.equal(messages.find((message) => message.text === 'doing it').input_tokens, 13);
  assert.equal(messages.find((message) => message.text === 'doing it').output_tokens, 4);
  assert.equal(messages.find((message) => message.content_type === 'tool_use').input_tokens, null);

  // tool_calls come from the durable tool/call events and anchor on the
  // deterministic tool_use uuid for the same (turn, step).
  assert.deepEqual(byKind('tool_call').map((record) => [record.id, record.name, record.file_path, record.message_uuid]), [
    ['deepseek:root-session-1:call-1', 'Read', '/tmp/dsh-project/a.ts', 'deepseek:root-session-1:t1:s1:tool_use'],
    ['deepseek:root-session-1:call-2', 'subagent', null, 'deepseek:root-session-1:t1:s2:tool_use'],
  ]);
  assert.deepEqual(byKind('tool_result').map((record) => [record.tool_use_id, record.content, record.is_error, record.message_uuid]), [
    ['deepseek:root-session-1:call-1', 'file body', 0, 'deepseek:root-session-1:t1:s1:tool_use'],
    ['deepseek:root-session-1:call-2', 'started subagent child-session-1', 0, 'deepseek:root-session-1:t1:s2:tool_use'],
  ]);
  assert.deepEqual(byKind('subagent').map((record) => [record.agent_id, record.session_id, record.parent_tool_use_id]), [
    ['deepseek:child-session-1', 'deepseek:root-session-1', 'deepseek:root-session-1:call-2'],
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
    assert.equal(message.agent_id, 'deepseek:child-session-1');
    assert.equal(message.session_id, 'deepseek:root-session-1');
  }
  assert.equal(messages[2].input_tokens, 20);
  assert.equal(messages[2].output_tokens, 5);

  const subagents = byKind('subagent');
  assert.equal(subagents.length, 1);
  assert.deepEqual(
    (({ agent_id, session_id, agent_type, description }) => ({ agent_id, session_id, agent_type, description }))(subagents[0]),
    { agent_id: 'deepseek:child-session-1', session_id: 'deepseek:root-session-1', agent_type: 'deepseek-official', description: 'review helper' },
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
  assert.equal(detail.session.id, 'deepseek:root-session-1');
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
  assert.equal(subagentCall.subagent.agent_id, 'deepseek:child-session-1');
  assert.equal(subagentCall.result.content, 'started subagent child-session-1');
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
  assert.equal(toolCalls[0].id, 'deepseek:toolcall-session:call-evt-1');
  assert.equal(toolCalls[0].name, 'bash');
  assert.match(toolCalls[0].input_json, new RegExp(marker));
  // The anchor is the deterministic tool_use uuid for the event's own (turn, step).
  assert.equal(toolCalls[0].message_uuid, 'deepseek:toolcall-session:t1:s1:tool_use');
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
