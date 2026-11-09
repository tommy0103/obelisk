// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createKimiProvider } from '../packages/core/src/providers/kimi.ts';
import { assembleSessionDetail } from '../packages/core/src/session-detail.ts';
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

function writeKimiFixture() {
  const root = makeTempDir('obelisk-kimi-');
  const sessionDir = join(root, 'sessions', 'workspace-1', 'session-native-1');
  const mainDir = join(sessionDir, 'agents', 'main');
  const childDir = join(sessionDir, 'agents', 'agent-7');
  mkdirSync(mainDir, { recursive: true });
  mkdirSync(childDir, { recursive: true });
  writeFileSync(join(sessionDir, 'state.json'), JSON.stringify({
    title: 'Kimi fixture',
    createdAt: '2026-07-20T10:00:00.000Z',
    updatedAt: '2026-07-20T10:01:00.000Z',
    workDir: '/tmp/kimi-project',
    agents: {
      main: { type: 'main' },
      'agent-7': { type: 'sub', parentAgentId: 'main', labels: { profile: 'explore' } },
    },
  }));

  const mainRecords = [
    { type: 'metadata', protocol_version: '1.5', created_at: 1753005600000 },
    { type: 'config.update', time: 1753005600100, modelAlias: 'kimi-k2' },
    { type: 'context.append_message', time: 1753005601000, message: { role: 'user', content: [{ type: 'text', text: 'inspect the project' }], toolCalls: [], origin: { kind: 'user' } } },
    { type: 'context.append_loop_event', time: 1753005602000, event: { type: 'step.begin', uuid: 'step-1', turnId: '0' } },
    { type: 'context.append_loop_event', time: 1753005602100, event: { type: 'content.part', uuid: 'thinking-1', stepUuid: 'step-1', part: { type: 'thinking', thinking: 'I should inspect it' } } },
    { type: 'context.append_loop_event', time: 1753005602200, event: { type: 'tool.call', uuid: 'tool-event-1', stepUuid: 'step-1', toolCallId: 'call-1', name: 'Read', args: { file_path: '/tmp/kimi-project/a.ts' } } },
    { type: 'context.append_loop_event', time: 1753005602300, event: { type: 'tool.result', parentUuid: 'tool-result-1', toolCallId: 'call-1', result: { output: 'agent_id: agent-7\nfile body', isError: false } } },
    { type: 'context.append_loop_event', time: 1753005602500, event: { type: 'content.part', uuid: 'text-1', stepUuid: 'step-1', part: { type: 'text', text: 'done' } } },
    { type: 'context.append_loop_event', time: 1753005603000, event: { type: 'step.end', uuid: 'step-1', usage: { inputOther: 7, inputCacheRead: 3, inputCacheCreation: 2, output: 3 } } },
    { type: 'context.apply_compaction', time: 1753005604000, summary: 'Earlier work summary', compactedCount: 2 },
  ];
  writeFileSync(join(mainDir, 'wire.jsonl'), mainRecords.map((record) => JSON.stringify(record)).join('\n') + '\n');

  const childRecords = [
    { type: 'metadata', protocol_version: '1.5', created_at: 1753005600000 },
    { type: 'context.append_message', time: 1753005602400, message: { role: 'user', content: [{ type: 'text', text: 'child prompt' }], toolCalls: [], origin: { kind: 'system_trigger', name: 'subagent' } } },
  ];
  writeFileSync(join(childDir, 'wire.jsonl'), childRecords.map((record) => JSON.stringify(record)).join('\n') + '\n');
  return { root, sessionDir };
}

test('kimi provider discovers a changed session directory and returns a stable cursor', () => {
  const { root, sessionDir } = writeKimiFixture();
  const provider = createKimiProvider({ rootDir: root });
  const units = provider.discover({ lastCursor: () => null });

  assert.equal(units.length, 1);
  assert.equal(units[0].key, sessionDir);
  assert.equal(units[0].sessionId, 'kimi:session-native-1');
  assert.match(
    units[0].meta.currentCursor,
    /^\d+:0:kimi-manifest-v1:[A-Za-z0-9_-]{43}$/,
  );

  const unchanged = provider.discover({ lastCursor: () => units[0].meta.currentCursor });
  assert.deepEqual(unchanged, []);

  const legacyCursor = units[0].meta.currentCursor.split(':').slice(0, 2).join(':');
  assert.deepEqual(
    provider.discover({ lastCursor: () => legacyCursor }).map(unit => unit.key),
    [sessionDir],
    'a legacy cursor cannot prove that the session is unchanged',
  );
});

test('kimi provider folds main and subagent wire logs into the canonical transcript language', () => {
  const { root } = writeKimiFixture();
  const provider = createKimiProvider({ rootDir: root });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const { values, ret } = drain(provider.parse(unit, null));
  const byKind = (kind) => values.filter((record) => record.kind === kind);

  const goldenRecords = values.map((record) => record.kind === 'session'
    ? { ...record, jsonl_path: '<fixture-wire>' }
    : record);
  assert.equal(
    createHash('sha256').update(JSON.stringify(goldenRecords)).digest('hex'),
    '09d76616919435a46a3395194349e696e0d8f6717a24b018515e1f3867ec347a',
    'complete yielded record sequence changed',
  );

  assert.deepEqual(values[0], { kind: 'delete-session', sessionId: 'kimi:session-native-1' });
  assert.equal(ret, unit.meta.currentCursor);

  const session = byKind('session')[0];
  assert.deepEqual(
    (({ id, title, project, source, countMode }) => ({ id, title, project, source, countMode }))(session),
    {
      id: 'kimi:session-native-1',
      title: 'Kimi fixture',
      project: '-tmp-kimi-project',
      source: 'kimi',
      countMode: 'total',
    },
  );

  const messages = byKind('message');
  assert.deepEqual(messages.map((message) => [message.role, message.content_type, message.text]), [
    ['user', 'text', 'inspect the project'],
    ['assistant', 'thinking', 'I should inspect it'],
    ['assistant', 'tool_use', null],
    ['assistant', 'text', 'done'],
    ['user', 'text', 'child prompt'],
  ]);
  assert.equal(messages.at(-1).agent_id, 'kimi:session-native-1:agent-7');
  assert.equal(messages.at(-1).is_sidechain, 1);
  assert.equal(messages.find((message) => message.text === 'done').input_tokens, 12);
  assert.equal(messages.find((message) => message.text === 'done').output_tokens, 3);

  assert.deepEqual(byKind('tool_call').map((record) => [record.id, record.name, record.file_path]), [
    ['kimi:session-native-1:main:call-1', 'Read', '/tmp/kimi-project/a.ts'],
  ]);
  assert.deepEqual(byKind('tool_result').map((record) => [record.tool_use_id, record.is_error]), [
    ['kimi:session-native-1:main:call-1', 0],
  ]);
  assert.deepEqual(byKind('summary').map((record) => record.content), ['Earlier work summary']);
  assert.deepEqual(byKind('subagent').map((record) => [record.agent_id, record.parent_tool_use_id, record.agent_type]), [
    ['kimi:session-native-1:agent-7', 'kimi:session-native-1:main:call-1', 'explore'],
  ]);

  const detail = assembleSessionDetail(values);
  assert.equal(detail.messages.some((message) => message.text === 'child prompt'), false);
  assert.equal(detail.messages.flatMap((message) => message.tool_calls ?? [])[0].result.content.includes('file body'), true);
});

test('kimi provider ignores a torn final wire line until it is completed', () => {
  const { root, sessionDir } = writeKimiFixture();
  const wirePath = join(sessionDir, 'agents', 'main', 'wire.jsonl');
  writeFileSync(wirePath, readFileSync(wirePath, 'utf8') + '{"type":"context.append_message"');
  const provider = createKimiProvider({ rootDir: root });
  const unit = provider.discover({ lastCursor: () => null })[0];

  const { values, ret } = drain(provider.parse(unit, null));

  assert.equal(values.filter(record => record.kind === 'message').length, 5);
  assert.equal(ret, unit.meta.currentCursor);
});

test('kimi provider normalizes think parts and drops empty thinking placeholders', () => {
  const root = makeTempDir('obelisk-kimi-think-');
  const sessionDir = join(root, 'sessions', 'workspace-1', 'session-think-1');
  const mainDir = join(sessionDir, 'agents', 'main');
  const wirePath = join(mainDir, 'wire.jsonl');
  mkdirSync(mainDir, { recursive: true });
  writeFileSync(join(sessionDir, 'state.json'), JSON.stringify({ workDir: '/tmp/think' }));
  const records = [
    { type: 'metadata', protocol_version: '1.5', created_at: 1 },
    { type: 'context.append_loop_event', time: 2, event: { type: 'step.begin', uuid: 'step-1' } },
    { type: 'context.append_loop_event', time: 3, event: {
      type: 'content.part', uuid: 'think-1', stepUuid: 'step-1',
      part: { type: 'think', think: 'private reasoning' },
    } },
    { type: 'context.append_loop_event', time: 4, event: {
      type: 'content.part', uuid: 'think-empty', stepUuid: 'step-1',
      part: { type: 'think', think: '' },
    } },
    { type: 'context.append_loop_event', time: 5, event: {
      type: 'content.part', uuid: 'answer-1', stepUuid: 'step-1',
      part: { type: 'text', text: 'visible answer' },
    } },
  ];
  writeFileSync(wirePath, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const provider = createKimiProvider({ rootDir: root });
  const unit = provider.discover({ lastCursor: () => null })[0];

  const { values } = drain(provider.parse(unit, null));
  const messages = values.filter(record => record.kind === 'message');

  assert.deepEqual(messages.map(record => ({
    text: record.text,
    content_type: record.content_type,
  })), [
    { text: 'private reasoning', content_type: 'thinking' },
    { text: 'visible answer', content_type: 'text' },
  ]);
  assert.equal(values.find(record => record.kind === 'session').message_count, 2);
  assert.equal(provider.raw({
    source: 'kimi',
    messageUuid: messages[0].uuid,
    session: { jsonl_path: wirePath },
    agentId: null,
  }).messageText, 'private reasoning');
});

test('kimi provider removes injection messages inside an undone range', () => {
  const root = makeTempDir('obelisk-kimi-undo-');
  const sessionDir = join(root, 'sessions', 'workspace-1', 'session-undo-1');
  const mainDir = join(sessionDir, 'agents', 'main');
  mkdirSync(mainDir, { recursive: true });
  writeFileSync(join(sessionDir, 'state.json'), JSON.stringify({
    workDir: '/tmp/kimi-undo',
    agents: { main: { type: 'main' } },
  }));
  const records = [
    { type: 'metadata', protocol_version: '1.5', created_at: 1753005600000 },
    { type: 'context.append_message', time: 1, message: { role: 'user', content: 'before clear', toolCalls: [], origin: { kind: 'user' } } },
    { type: 'context.append_loop_event', time: 2, event: { type: 'content.part', uuid: 'before-answer', stepUuid: 's1', part: { type: 'text', text: 'kept answer' } } },
    { type: 'context.clear', time: 3 },
    { type: 'context.append_message', time: 4, message: { role: 'user', content: 'undone prompt', toolCalls: [], origin: { kind: 'user' } } },
    { type: 'context.append_message', time: 5, message: { role: 'user', content: 'persistent injection', toolCalls: [], origin: { kind: 'injection' } } },
    { type: 'context.append_message', time: 6, message: { role: 'user', content: 'ephemeral system trigger', toolCalls: [], origin: { kind: 'system_trigger' } } },
    { type: 'context.append_loop_event', time: 7, event: { type: 'content.part', uuid: 'undone-answer', stepUuid: 's2', part: { type: 'text', text: 'undone answer' } } },
    { type: 'context.undo', time: 8, count: 1 },
  ];
  writeFileSync(join(mainDir, 'wire.jsonl'), records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const provider = createKimiProvider({ rootDir: root });
  const unit = provider.discover({ lastCursor: () => null })[0];

  const { values } = drain(provider.parse(unit, null));
  assert.deepEqual(
    values.filter(record => record.kind === 'message').map(record => record.text),
    ['before clear', 'kept answer'],
  );
  assert.equal(values.find(record => record.kind === 'session').message_count, 2);
});

test('kimi provider removes a prompt-owned injection that precedes an undone prompt', () => {
  const root = makeTempDir('obelisk-kimi-undo-injection-');
  const sessionDir = join(root, 'sessions', 'workspace-1', 'session-undo-injection-1');
  const mainDir = join(sessionDir, 'agents', 'main');
  mkdirSync(mainDir, { recursive: true });
  writeFileSync(join(sessionDir, 'state.json'), JSON.stringify({
    workDir: '/tmp/kimi-undo-injection',
    agents: { main: { type: 'main' } },
  }));
  const records = [
    { type: 'metadata', protocol_version: '1.5', created_at: 1753005600000 },
    { type: 'context.append_message', time: 1, message: { role: 'user', id: 'p1', content: 'kept prompt', toolCalls: [], origin: { kind: 'user' } } },
    { type: 'context.append_loop_event', time: 2, event: { type: 'content.part', uuid: 'kept-answer', stepUuid: 's1', part: { type: 'text', text: 'kept answer' } } },
    { type: 'context.append_message', time: 3, message: { role: 'user', id: 'inj-1', content: 'compressed image context', toolCalls: [], origin: { kind: 'injection', ownerPromptId: 'X', variant: 'image_compression' } } },
    { type: 'context.append_message', time: 4, message: { role: 'user', id: 'X', content: 'undone prompt', toolCalls: [], origin: { kind: 'user' } } },
    { type: 'context.undo', time: 5, count: 1 },
  ];
  writeFileSync(join(mainDir, 'wire.jsonl'), records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const provider = createKimiProvider({ rootDir: root });
  const unit = provider.discover({ lastCursor: () => null })[0];

  const { values } = drain(provider.parse(unit, null));
  assert.deepEqual(
    values.filter(record => record.kind === 'message').map(record => record.text),
    ['kept prompt', 'kept answer'],
  );
  assert.equal(values.find(record => record.kind === 'session').message_count, 2);
});

test('kimi provider scopes changed-path discovery to one session and bypasses an unchanged cursor', () => {
  const root = makeTempDir('obelisk-kimi-changed-path-');
  const firstDir = join(root, 'sessions', 'workspace-1', 'session-1');
  const secondDir = join(root, 'sessions', 'workspace-1', 'session-2');
  for (const sessionDir of [firstDir, secondDir]) {
    mkdirSync(join(sessionDir, 'agents', 'main'), { recursive: true });
    writeFileSync(join(sessionDir, 'state.json'), JSON.stringify({ workDir: '/tmp/project' }));
    writeFileSync(join(sessionDir, 'agents', 'main', 'wire.jsonl'), '{"type":"metadata"}\n');
  }
  const provider = createKimiProvider({ rootDir: root });
  const initial = provider.discover({ lastCursor: () => null });
  const cursorByKey = new Map(initial.map(unit => [unit.key, unit.meta.currentCursor]));

  const units = provider.discover({
    lastCursor: key => cursorByKey.get(key) ?? null,
    changedPaths: [join(firstDir, 'state.json')],
  });

  assert.deepEqual(units.map(unit => unit.key), [firstDir]);
});

test('kimi provider presents user-slash activations as real user prompts', () => {
  const root = makeTempDir('obelisk-kimi-user-slash-');
  const sessionDir = join(root, 'sessions', 'workspace-1', 'session-user-slash-1');
  const mainDir = join(sessionDir, 'agents', 'main');
  mkdirSync(mainDir, { recursive: true });
  writeFileSync(join(sessionDir, 'state.json'), JSON.stringify({ workDir: '/tmp/user-slash' }));
  const records = [
    { type: 'metadata', protocol_version: '1.5', created_at: 1 },
    { type: 'context.append_message', time: 2, message: {
      role: 'user', content: 'User activated the skill and loaded its full instructions.', toolCalls: [],
      origin: {
        kind: 'skill_activation', trigger: 'user-slash', skillName: 'obelisk',
        skillArgs: '  synthesize my history  ',
      },
    } },
    { type: 'context.append_message', time: 3, message: {
      role: 'user', content: 'Expanded plugin command implementation.', toolCalls: [],
      origin: {
        kind: 'plugin_command', trigger: 'user-slash', pluginId: 'demo',
        commandName: 'ship', commandArgs: '  --fast  ',
      },
    } },
    { type: 'context.append_message', time: 4, message: {
      role: 'user', content: 'Model-triggered skill instructions.', toolCalls: [],
      origin: { kind: 'skill_activation', trigger: 'model-tool', skillName: 'review' },
    } },
  ];
  writeFileSync(join(mainDir, 'wire.jsonl'), records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const provider = createKimiProvider({ rootDir: root });
  const unit = provider.discover({ lastCursor: () => null })[0];

  const { values } = drain(provider.parse(unit, null));

  const messages = values.filter(record => record.kind === 'message');
  assert.deepEqual(messages.map(record => ({
    text: record.text,
    is_meta: record.is_meta,
  })), [
    { text: '/obelisk synthesize my history', is_meta: 0 },
    { text: '/demo:ship --fast', is_meta: 0 },
    { text: 'Model-triggered skill instructions.', is_meta: 1 },
  ]);
  assert.equal(provider.raw({
    source: 'kimi',
    messageUuid: messages[0].uuid,
    session: { jsonl_path: join(mainDir, 'wire.jsonl') },
    agentId: null,
  }).messageText, '/obelisk synthesize my history');
});

test('kimi provider maps protocol-1.0 embedded tool calls and results', () => {
  const root = makeTempDir('obelisk-kimi-legacy-tools-');
  const sessionDir = join(root, 'sessions', 'workspace-1', 'session-tools-1');
  const mainDir = join(sessionDir, 'agents', 'main');
  mkdirSync(mainDir, { recursive: true });
  writeFileSync(join(sessionDir, 'state.json'), JSON.stringify({ workDir: '/tmp/tools' }));
  const records = [
    { type: 'metadata', protocol_version: '1.0', created_at: 1 },
    { type: 'context.append_message', time: 2, message: {
      role: 'assistant', content: [],
      toolCalls: [{ type: 'function', id: 'legacy-call', function: { name: 'Read', arguments: '{"file_path":"/tmp/tools/a.ts"}' } }],
    } },
    { type: 'context.append_message', time: 3, message: {
      role: 'tool', content: [{ type: 'text', text: 'legacy result' }], toolCalls: [], toolCallId: 'legacy-call',
    } },
  ];
  writeFileSync(join(mainDir, 'wire.jsonl'), records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const provider = createKimiProvider({ rootDir: root });
  const unit = provider.discover({ lastCursor: () => null })[0];

  const { values } = drain(provider.parse(unit, null));
  assert.deepEqual(values.filter(record => record.kind === 'tool_call').map(record => ({
    id: record.id, name: record.name, file_path: record.file_path,
  })), [{
    id: 'kimi:session-tools-1:main:legacy-call', name: 'Read', file_path: '/tmp/tools/a.ts',
  }]);
  assert.deepEqual(values.filter(record => record.kind === 'tool_result').map(record => ({
    tool_use_id: record.tool_use_id, content: record.content,
  })), [{
    tool_use_id: 'kimi:session-tools-1:main:legacy-call', content: 'legacy result',
  }]);
});
