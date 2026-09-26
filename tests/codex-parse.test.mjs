// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Phase 5c-2 golden test: pins the codex adapter's parse() record stream.
// Binding-independent (no database). Covers the event_msg↔response_item dedup,
// tool call/result, token patching, turn-duration, the 'total' session count,
// and guardian-thread → delete-session.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createCodexParseMetrics, createCodexProvider, parse } from '../packages/core/src/providers/codex.ts';
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

function cursorState(cursor) {
  const encoded = cursor.split(':', 6)[5];
  assert.ok(encoded, 'cursor carries provider checkpoint state');
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
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

test('codex v4 checkpoint resumes a cooperative append from its byte offset', () => {
  const path = writeFixture([
    { type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: META },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:01Z', payload: { type: 'user_message', message: '中文 😀 before offset' } },
  ]);
  const first = drain(parse({ key: path, sessionId: '' }, null));
  const state = cursorState(first.ret);
  assert.equal(state.v, 4);
  assert.equal(typeof state.completeLineOffset, 'number');
  assert.equal(state.completeLineOffset, first.ret.split(':')[2] * 1);
  assert.equal(state.sourceSize, state.completeLineOffset);
  assert.equal(typeof state.dev, 'string');
  assert.equal(typeof state.sourceInode, 'string');

  const unchanged = drain(parse({ key: path, sessionId: '' }, first.ret));
  assert.deepEqual(unchanged.values, [], 'an empty suffix emits no patch');
  assert.equal(unchanged.ret, first.ret, 'an empty suffix does not advance the checkpoint');

  appendFileSync(path, `${JSON.stringify({
    type: 'event_msg', timestamp: '2026-06-10T10:00:02Z', payload: { type: 'agent_message', message: 'after offset' },
  })}\n`);
  const second = drain(parse({ key: path, sessionId: '' }, first.ret));
  assert.deepEqual(second.values.filter(record => record.kind === 'message').map(record => record.text), ['after offset']);
  assert.equal(second.values.some(record => record.kind === 'delete-session'), false);
  assert.equal(cursorState(second.ret).verifiedPrefix, false);
});

test('codex parse() accepts a legacy #148 v4 cursor but replays it conservatively', () => {
  const path = writeFixture([
    { type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: META },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:01Z', payload: { type: 'user_message', message: 'legacy prefix' } },
  ]);
  const first = drain(parse({ key: path, sessionId: '' }, null));
  const parts = first.ret.split(':', 6);
  const legacyState = cursorState(first.ret);
  delete legacyState.completeLineOffset;
  delete legacyState.sourceSize;
  delete legacyState.dev;
  delete legacyState.sourceInode;
  delete legacyState.stateComplete;
  const legacyCursor = `${parts.slice(0, 5).join(':')}:${Buffer.from(JSON.stringify(legacyState)).toString('base64url')}`;

  appendFileSync(path, `${JSON.stringify({
    type: 'event_msg', timestamp: '2026-06-10T10:00:02Z', payload: { type: 'agent_message', message: 'legacy suffix' },
  })}\n`);
  const second = drain(parse({ key: path, sessionId: '' }, legacyCursor));
  assert.equal(second.values[0].kind, 'delete-session');
  assert.deepEqual(second.values.filter(record => record.kind === 'message').map(record => record.text), ['legacy prefix', 'legacy suffix']);
  assert.equal(typeof cursorState(second.ret).completeLineOffset, 'number');
});

test('codex strict read mode disables cooperative append', () => {
  const path = writeFixture([
    { type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: META },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:01Z', payload: { type: 'user_message', message: 'strict prefix' } },
  ]);
  const first = drain(parse({ key: path, sessionId: '' }, null));
  appendFileSync(path, `${JSON.stringify({
    type: 'event_msg', timestamp: '2026-06-10T10:00:02Z', payload: { type: 'agent_message', message: 'strict suffix' },
  })}\n`);
  const metrics = createCodexParseMetrics();
  const second = drain(parse({ key: path, sessionId: '', meta: { readMode: 'strict' } }, first.ret, metrics));
  assert.equal(metrics.plan, 'verified-append');
  assert.ok(metrics.sourceBytesRead > Buffer.byteLength('\n'), 'strict mode verifies the existing prefix');
  assert.deepEqual(second.values.filter(record => record.kind === 'message').map(record => record.text), ['strict suffix']);
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

test('codex parse() snapshots an incomplete continuation before linking a later tool result', () => {
  const calls = Array.from({ length: 4097 }, (_, index) => ({
    type: 'response_item', timestamp: '2026-06-10T10:00:01Z',
    payload: { type: 'function_call', call_id: `call_${index}`, name: 'shell', arguments: '{}' },
  }));
  const path = writeFixture([
    { type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: META },
    ...calls,
  ]);
  const first = drain(parse({ key: path, sessionId: '' }, null));
  assert.equal(cursorState(first.ret).stateComplete, false, 'the capped call map marks its continuation incomplete');

  appendFileSync(path, `${JSON.stringify({
    type: 'response_item', timestamp: '2026-06-10T10:00:02Z',
    payload: { type: 'function_call_output', call_id: 'call_0', output: 'replayed safely' },
  })}\n`);
  const second = drain(parse({ key: path, sessionId: '' }, first.ret));
  const result = second.values.find(record => record.kind === 'tool_result');
  assert.equal(result?.message_uuid, `codex:${META.id}:000002`, 'snapshot rebuild restores the prior call association');
  assert.ok(second.values.some(record => record.kind === 'delete-session'), 'the incomplete continuation does not emit an incremental patch');
});

test('codex parse() preserves an output whose source has no matching call', () => {
  const path = writeFixture([
    { type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: META },
    { type: 'response_item', timestamp: '2026-06-10T10:00:01Z', payload: { type: 'function_call_output', call_id: 'missing', output: 'orphan' } },
  ]);
  const { values } = drain(parse({ key: path, sessionId: '' }, null));
  const result = values.find(record => record.kind === 'tool_result');
  assert.equal(result?.message_uuid, '');
});

test('codex parse() does not publish a source mutated before pre-scan', () => {
  const path = writeFixture([
    { type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: META },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:01Z', payload: { type: 'user_message', message: 'stable prefix' } },
  ]);
  const first = drain(parse({ key: path, sessionId: '' }, null));
  appendFileSync(path, `${JSON.stringify({
    type: 'event_msg', timestamp: '2026-06-10T10:00:02Z', payload: { type: 'agent_message', message: 'first suffix view' },
  })}\n`);
  const second = drain(parse({ key: path, sessionId: '' }, first.ret, undefined, {
    beforeScan: () => appendFileSync(path, `${JSON.stringify({
      type: 'event_msg', timestamp: '2026-06-10T10:00:03Z', payload: { type: 'agent_message', message: 'concurrent mutation' },
    })}\n`),
  }));
  assert.deepEqual(second.values, []);
  assert.equal(second.ret, first.ret);
});

test('codex parse() does not publish a suffix mutated after pre-scan', () => {
  const path = writeFixture([
    { type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: META },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:01Z', payload: { type: 'user_message', message: 'stable prefix' } },
  ]);
  const first = drain(parse({ key: path, sessionId: '' }, null));
  appendFileSync(path, `${JSON.stringify({
    type: 'event_msg', timestamp: '2026-06-10T10:00:02Z', payload: { type: 'agent_message', message: 'first suffix view' },
  })}\n`);
  const second = drain(parse({ key: path, sessionId: '' }, first.ret, undefined, {
    afterScan: () => appendFileSync(path, `${JSON.stringify({
      type: 'event_msg', timestamp: '2026-06-10T10:00:03Z', payload: { type: 'agent_message', message: 'concurrent mutation' },
    })}\n`),
  }));
  assert.deepEqual(second.values, []);
  assert.equal(second.ret, first.ret);
});

test('codex parse() fails closed on a malformed complete line and surfaces the freeze', () => {
  const path = writeFixture([
    { type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: META },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:01Z', payload: { type: 'user_message', message: 'valid prefix' } },
  ]);
  const first = drain(parse({ key: path, sessionId: '' }, null));
  appendFileSync(path, '{not valid json}\n');

  // A prior checkpoint exists: the throw surfaces the frozen source through
  // the build's skipped-file diagnostics, and the per-unit rollback keeps the
  // old cursor so the freeze semantics are unchanged. Typical cause: a torn
  // write later completed by an append into a "complete but invalid" line.
  assert.throws(
    () => drain(parse({ key: path, sessionId: '' }, first.ret)),
    /Malformed JSONL line: incremental indexing is frozen/,
  );

  // The source is still corrupt: every rebuild keeps surfacing the defect
  // instead of silently skipping it.
  assert.throws(
    () => drain(parse({ key: path, sessionId: '' }, first.ret)),
    /Malformed JSONL line: incremental indexing is frozen/,
  );
});

test('codex parse() stays silent on a malformed source without a prior checkpoint', () => {
  // Whole-snapshot builds (force rebuild, first sight) have no prior cursor:
  // one corrupt archive file must not block the rebuild.
  const path = writeFixture([
    { type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: META },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:01Z', payload: { type: 'user_message', message: 'valid line' } },
  ]);
  appendFileSync(path, '{not valid json}\n');
  const result = drain(parse({ key: path, sessionId: '' }, null));
  assert.deepEqual(result.values, []);
  assert.equal(result.ret, null, 'no checkpoint is published for a corrupt first sight');
});

test('codex parse() heals a touched-but-unchanged source instead of re-fingerprinting forever', () => {
  const path = writeFixture([
    { type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: META },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:01Z', payload: { type: 'user_message', message: 'stable prefix' } },
  ]);
  const first = drain(parse({ key: path, sessionId: '' }, null));
  const before = statSync(path);
  // cp -p / rsync -a preserve mtime and size while ctime necessarily changes.
  utimesSync(path, before.atime, before.mtime);
  const touched = statSync(path);
  assert.notEqual(touched.ctimeMs, before.ctimeMs, 'the touch must change ctime for this test');

  const second = drain(parse({ key: path, sessionId: '' }, first.ret));
  assert.deepEqual(second.values, [], 'a touch with no new bytes emits nothing');
  const legs = second.ret.split(':', 6);
  assert.equal(legs[0], `${touched.mtimeMs}`, 'the healed cursor adopts the current stat');
  assert.equal(legs[3], `${touched.ctimeMs}`, 'the healed cursor carries the current ctime');
  assert.equal(legs[2], first.ret.split(':', 6)[2], 'the restart offset is preserved');

  // The healed signature now matches: the next build is a stable no-op
  // instead of another full-file fingerprint pass.
  const third = drain(parse({ key: path, sessionId: '' }, second.ret));
  assert.deepEqual(third.values, []);
  assert.equal(third.ret, second.ret, 'the healed cursor is a no-op checkpoint');
});

test('codex strict reconcile heals a touched-but-unchanged source', () => {
  const path = writeFixture([
    { type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: META },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:01Z', payload: { type: 'user_message', message: 'strict stable' } },
  ]);
  const first = drain(parse({ key: path, sessionId: '' }, null));
  const before = statSync(path);
  utimesSync(path, before.atime, before.mtime);
  assert.notEqual(statSync(path).ctimeMs, before.ctimeMs, 'the touch must change ctime for this test');

  const metrics = createCodexParseMetrics();
  const second = drain(parse({ key: path, sessionId: '', meta: { readMode: 'strict' } }, first.ret, metrics));
  assert.equal(metrics.plan, 'verified-append', 'strict mode still verifies the prefix once');
  assert.deepEqual(second.values, []);
  assert.equal(second.ret.split(':', 6)[3], `${statSync(path).ctimeMs}`, 'strict reconcile heals the stat legs');

  const third = drain(parse({ key: path, sessionId: '' }, second.ret));
  assert.equal(third.ret, second.ret, 'the healed cursor is a no-op checkpoint afterwards');
});

test('codex parse() patches the aggregate when a touch coincides with a title change', () => {
  const path = writeFixture([
    { type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: META },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:01Z', payload: { type: 'user_message', message: 'renamed thread' } },
  ]);
  const first = drain(parse({ key: path, sessionId: '', meta: { indexedTitle: 'Old Title' } }, null));
  const before = statSync(path);
  utimesSync(path, before.atime, before.mtime);
  assert.notEqual(statSync(path).ctimeMs, before.ctimeMs, 'the touch must change ctime for this test');

  const second = drain(parse({
    key: path, sessionId: '',
    meta: { indexedTitle: 'New Title', indexedUpdatedAt: '2026-06-11T00:00:00Z' },
  }, first.ret));
  const session = second.values.find(record => record.kind === 'session');
  assert.ok(session, 'the metadata change is patched in the healing pass');
  assert.equal(session.title, 'New Title');
  assert.equal(session.ended_at, '2026-06-11T00:00:00Z');
  assert.equal(cursorState(second.ret).indexedTitle, 'New Title');
  assert.equal(second.ret.split(':', 6)[3], `${statSync(path).ctimeMs}`, 'the cursor heals in the same pass');
});

test('codex parse() does not advance a partial tail and falls back once it is completed', () => {
  const path = writeFixture([
    { type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: META },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:01Z', payload: { type: 'user_message', message: 'complete prefix' } },
  ]);
  const first = drain(parse({ key: path, sessionId: '' }, null));
  const partial = JSON.stringify({
    type: 'event_msg', timestamp: '2026-06-10T10:00:02Z', payload: { type: 'agent_message', message: 'partial tail' },
  });
  appendFileSync(path, partial);

  const second = drain(parse({ key: path, sessionId: '' }, first.ret));
  assert.deepEqual(second.values, [], 'an unterminated suffix emits no patch');
  assert.equal(second.ret, first.ret, 'the checkpoint stays before the partial line');

  appendFileSync(path, '\n' + JSON.stringify({
    type: 'event_msg', timestamp: '2026-06-10T10:00:03Z', payload: { type: 'agent_message', message: 'completed tail' },
  }) + '\n');
  const third = drain(parse({ key: path, sessionId: '' }, first.ret));
  assert.deepEqual(
    third.values.filter(record => record.kind === 'message').map(record => record.text),
    ['partial tail', 'completed tail'],
    'completion of a partial suffix forces a full replay instead of an unsafe byte seek',
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

test('codex cursor keeps dedup state bounded without missing a distant cross-boundary duplicate', () => {
  const path = writeFixture([
    { type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: META },
    ...Array.from({ length: 4096 }, (_, index) => ({
      type: 'response_item',
      timestamp: '2026-06-10T10:00:01Z',
      payload: {
        type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text: `response ${index}` }],
      },
    })),
  ]);
  const first = drain(parse({ key: path, sessionId: '' }, null));
  const state = cursorState(first.ret);

  assert.equal(state.v, 4);
  assert.equal(Buffer.from(state.eventMessageBloom, 'base64url').length, 32 * 1024);
  assert.equal(Buffer.from(state.responseMessageBloom, 'base64url').length, 32 * 1024);
  assert.equal('eventMessageKeys' in state, false);
  assert.equal('responseMessageKeys' in state, false);
  assert.ok(first.ret.length < 130_000, `cursor grew to ${first.ret.length} bytes`);

  appendFileSync(path, `${JSON.stringify({
    type: 'event_msg', timestamp: '2026-06-10T10:00:02Z',
    payload: { type: 'agent_message', message: 'response 0' },
  })}\n`);
  const second = drain(parse({ key: path, sessionId: '' }, first.ret));

  assert.equal(second.values[0].kind, 'delete-session', 'a possible old match takes the exact replay path');
  assert.equal(
    second.values.filter(record => record.kind === 'message' && record.text === 'response 0').length,
    1,
    'the distant duplicate remains canonical after replay',
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

test('codex provider reuses a strengthened cursor for a session-index-only refresh', () => {
  const root = makeTempDir('obelisk-codex-index-refresh-');
  const sessionsDir = join(root, 'sessions', '2026', '06', '10');
  mkdirSync(sessionsDir, { recursive: true });
  const path = join(sessionsDir, `rollout-${META.id}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: META })}\n`);
  const provider = createCodexProvider({ rootDir: root });
  const initial = drain(provider.parse({ key: path, sessionId: '', meta: { source: 'codex', guardian: false } }, null));
  const indexPath = join(root, 'session_index.jsonl');
  writeFileSync(indexPath, `${JSON.stringify({ id: META.id, thread_name: 'Refreshed title', updated_at: '2026-06-10T12:00:00Z' })}\n`);

  const units = provider.discover({ lastCursor: () => initial.ret, changedPaths: [indexPath] });
  assert.deepEqual(units.map(unit => unit.key), [path]);
  assert.equal(units[0].meta.guardian, false);
  assert.equal(units[0].meta.indexedTitle, 'Refreshed title');
});

test('codex parse() persists a session-index-only metadata refresh without replaying the rollout', () => {
  const path = writeFixture([
    { type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: META },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:01Z', payload: { type: 'user_message', message: 'unchanged source' } },
  ]);
  const first = drain(parse({ key: path, sessionId: '', meta: { indexedTitle: 'Before', indexedUpdatedAt: '2026-06-10T11:00:00Z' } }, null));
  const second = drain(parse({
    key: path, sessionId: '', meta: { indexedTitle: 'After', indexedUpdatedAt: '2026-06-10T12:00:00Z' },
  }, first.ret));
  assert.deepEqual(second.values.map(record => record.kind), ['session']);
  assert.equal(second.values[0].title, 'After');
  assert.equal(second.values[0].ended_at, '2026-06-10T12:00:00Z');
  assert.equal(cursorState(second.ret).indexedTitle, 'After');
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
