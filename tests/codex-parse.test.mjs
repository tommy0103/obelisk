// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Phase 5c-2 golden test: pins the codex adapter's parse() record stream.
// Binding-independent (no database). Covers the event_msg↔response_item dedup,
// tool call/result, token patching, turn-duration, the 'total' session count,
// and guardian-thread → delete-session.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createCodexProvider, parse } from '../packages/core/src/providers/codex.ts';
import { makeTempDir } from './temp-dirs.mjs';

function writeFixture(lines) {
  const dir = makeTempDir('obelisk-codex-parse-');
  const path = join(dir, 'rollout.jsonl');
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

function drain(gen) {
  const values = [];
  let step = gen.next();
  while (!step.done) { values.push(step.value); step = gen.next(); }
  return { values, ret: step.value };
}

const META = { id: '019e8951-3e7d-7343-a3e3-05bff48a317d', cwd: '/proj', git: { branch: 'main' }, cli_version: '1.2', timestamp: '2026-06-10T10:00:00Z' };

test('codex parse() yields a deduped, tool-aware record stream with a total session', () => {
  const path = writeFixture([
    { type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: META },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:01Z', payload: { type: 'user_message', message: 'hello codex' } },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:02Z', payload: { type: 'agent_message', message: 'hi there' } },
    // Duplicate of the agent_message above — must be deduped (dropped).
    { type: 'response_item', timestamp: '2026-06-10T10:00:02Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi there' }] } },
    { type: 'response_item', timestamp: '2026-06-10T10:00:03Z', payload: { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"cmd":"ls"}' } },
    { type: 'response_item', timestamp: '2026-06-10T10:00:04Z', payload: { type: 'function_call_output', call_id: 'call_1', output: 'file listing' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, output_tokens: 50 } } } },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:05Z', payload: { type: 'task_complete', duration_ms: 1500 } },
  ]);

  const { values } = drain(parse({ key: path, sessionId: '' }, null));
  const byKind = k => values.filter(r => r.kind === k);

  // Three messages: user, assistant text, assistant tool_use. The duplicate
  // response_item 'hi there' was deduped.
  const msgs = byKind('message');
  assert.equal(msgs.length, 3);
  assert.equal(msgs.filter(m => m.text === 'hi there').length, 1, 'agent_message deduped against response_item');
  assert.equal(msgs.every(m => m.source === 'codex'), true);

  // token_count patched the last text-assistant message's tokens.
  const textAssistant = msgs.find(m => m.role === 'assistant' && m.content_type === 'text');
  assert.equal(textAssistant.input_tokens, 100);
  assert.equal(textAssistant.output_tokens, 50);

  // Tool call + result.
  assert.deepEqual(byKind('tool_call').map(t => ({ id: t.id, name: t.name })), [{ id: `codex:${META.id}:call_1`, name: 'shell' }]);
  assert.equal(byKind('tool_result').length, 1);
  assert.equal(byKind('tool_result')[0].tool_use_id, `codex:${META.id}:call_1`);

  // task_complete → turn duration on the text-assistant message.
  assert.deepEqual(byKind('message-turn-duration').map(d => d.turn_duration_ms), [1500]);

  // One session record, full-reparse semantics.
  const sessions = byKind('session');
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].source, 'codex');
  assert.equal(sessions[0].countMode, 'total');
  assert.equal(sessions[0].message_count, 3);
  assert.equal(sessions[0].git_branch, 'main');
});

test('codex parse() resumes a verified append without replaying old records', () => {
  const path = writeFixture([
    { type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: META },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:01Z', payload: { type: 'user_message', message: '旧问题' } },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:02Z', payload: { type: 'agent_message', message: 'old answer' } },
    { type: 'response_item', timestamp: '2026-06-10T10:00:03Z', payload: { type: 'function_call', call_id: 'call_boundary', name: 'shell', arguments: '{}' } },
  ]);
  const first = drain(parse({ key: path, sessionId: '' }, null));
  appendFileSync(path, [
    JSON.stringify({ type: 'response_item', timestamp: '2026-06-10T10:00:04Z', payload: { type: 'function_call_output', call_id: 'call_boundary', output: 'ok' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 7, output_tokens: 3 } } } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-06-10T10:00:05Z', payload: { type: 'task_complete', duration_ms: 25 } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-06-10T10:00:06Z', payload: { type: 'user_message', message: '新增问题' } }),
    '',
  ].join('\n'));

  const second = drain(parse({ key: path, sessionId: '' }, first.ret));
  const messages = second.values.filter(record => record.kind === 'message');
  const result = second.values.find(record => record.kind === 'tool_result');
  const duration = second.values.find(record => record.kind === 'message-turn-duration');
  const session = second.values.find(record => record.kind === 'session');

  assert.deepEqual(messages.map(message => message.text), ['old answer', '新增问题']);
  assert.deepEqual(
    { input: messages[0].input_tokens, output: messages[0].output_tokens },
    { input: 7, output: 3 },
    'a usage event may patch the prior window assistant',
  );
  assert.equal(result.message_uuid, `codex:${META.id}:000004`, 'a result may link to a prior window call');
  assert.equal(duration.uuid, `codex:${META.id}:000003`, 'duration may patch the prior window assistant');
  assert.equal(messages[1].parent_uuid, `codex:${META.id}:000004`, 'the parent chain resumes at the checkpoint');
  assert.equal(session.message_count, 4, 'the session record remains an authoritative total');
});

test('codex parse() falls back when an unterminated tail is completed', () => {
  const path = writeFixture([]);
  const prefix = [
    { type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: META },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:01Z', payload: { type: 'user_message', message: 'partial tail' } },
  ];
  writeFileSync(path, prefix.map(line => JSON.stringify(line)).join('\n'));
  const first = drain(parse({ key: path, sessionId: '' }, null));
  appendFileSync(path, '\n' + JSON.stringify({
    type: 'event_msg', timestamp: '2026-06-10T10:00:02Z', payload: { type: 'agent_message', message: 'completed tail' },
  }) + '\n');

  const second = drain(parse({ key: path, sessionId: '' }, first.ret));
  assert.deepEqual(
    second.values.filter(record => record.kind === 'message').map(record => record.text),
    ['partial tail', 'completed tail'],
    'the completed prior line forces a complete snapshot instead of an unsafe byte seek',
  );
});

test('codex parse() retracts a response_item duplicated by a later event_msg', () => {
  const path = writeFixture([
    { type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: META },
    { type: 'response_item', timestamp: '2026-06-10T10:00:01Z', payload: {
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'boundary answer' }],
    } },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:01.500Z', payload: {
      type: 'token_count', info: { last_token_usage: { input_tokens: 1, output_tokens: 1 } },
    } },
  ]);
  const first = drain(parse({ key: path, sessionId: '' }, null));
  appendFileSync(path, `${JSON.stringify({
    type: 'event_msg', timestamp: '2026-06-10T10:00:02Z',
    payload: { type: 'agent_message', message: 'boundary answer' },
  })}\n`);

  const second = drain(parse({ key: path, sessionId: '' }, first.ret));
  assert.equal(second.values[0].kind, 'delete-session');
  assert.deepEqual(
    second.values.filter(record => record.kind === 'message').map(record => record.text),
    ['boundary answer'],
    'the replay keeps the event message and retracts the previously persisted response item',
  );
});

test('codex parse() retracts a guardian thread via delete-session and emits nothing else', () => {
  const path = writeFixture([
    { type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: { ...META, source: { subagent: { other: 'guardian' } } } },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:01Z', payload: { type: 'user_message', message: 'ignored' } },
  ]);

  const { values } = drain(parse({ key: path, sessionId: '' }, null));

  assert.equal(values.length, 1);
  assert.equal(values[0].kind, 'delete-session');
  assert.match(values[0].sessionId, /^codex:/);
});

test('codex provider folds session_index metadata into its canonical session record', () => {
  const root = makeTempDir('obelisk-codex-index-meta-');
  const sessionsDir = join(root, 'sessions', '2026', '06', '10');
  mkdirSync(sessionsDir, { recursive: true });
  const path = join(sessionsDir, `rollout-${META.id}.jsonl`);
  writeFileSync(path, `${JSON.stringify({
    type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: META,
  })}\n`);
  const indexPath = join(root, 'session_index.jsonl');
  writeFileSync(indexPath, `${JSON.stringify({
    id: META.id, thread_name: 'Indexed title', updated_at: '2026-06-10T11:00:00Z',
  })}\n`);
  const provider = createCodexProvider({ rootDir: root });
  const units = provider.discover({ lastCursor: () => '9999999999999:1', changedPaths: [indexPath] });

  assert.equal(units.length, 1);
  const { values } = drain(provider.parse(units[0], null));
  const session = values.find(record => record.kind === 'session');
  assert.equal(session.title, 'Indexed title');
  assert.equal(session.ended_at, '2026-06-10T11:00:00Z');
});

test('codex provider discovers, watches, and reads archived sessions', () => {
  const root = makeTempDir('obelisk-codex-archive-');
  const archiveDir = join(root, 'archived_sessions');
  mkdirSync(archiveDir, { recursive: true });
  const path = join(archiveDir, `rollout-${META.id}.jsonl`);
  writeFileSync(path, [
    JSON.stringify({ type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: META }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-06-10T10:00:01Z', payload: { type: 'user_message', message: 'archived Codex sentinel' } }),
    '',
  ].join('\n'));

  const provider = createCodexProvider({ rootDir: root });
  const units = provider.discover({
    lastCursor: () => '9999999999999:1',
    changedPaths: [path],
  });

  assert.deepEqual(units.map(unit => unit.key), [path]);
  assert.deepEqual(provider.watchTargets(root), [
    { kind: 'tree', path: join(root, 'sessions') },
    { kind: 'tree', path: archiveDir },
    { kind: 'file', path: join(root, 'session_index.jsonl') },
  ]);
  const raw = provider.raw({
    messageUuid: `codex:${META.id}:000002`,
    agentId: 'codex:archive-agent',
  });
  assert.match(raw.text, /archived Codex sentinel/);
});
