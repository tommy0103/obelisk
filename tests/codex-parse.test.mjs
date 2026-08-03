// Phase 5c-2 golden test: pins the codex adapter's parse() record stream.
// Binding-independent (no database). Covers the event_msg↔response_item dedup,
// tool call/result, token patching, turn-duration, the 'total' session count,
// and guardian-thread → delete-session.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCodexProvider, parse } from '../packages/core/src/providers/codex.ts';
import { READ_BUFFER_SIZE, TEXT_LIMIT } from '../packages/core/src/parsing.ts';

function writeFixture(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'obelisk-codex-parse-'));
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

test('codex parse() preserves UTF-8 text split across its 64 KiB JSONL read buffer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'obelisk-codex-utf8-boundary-'));
  const path = join(dir, 'rollout.jsonl');
  const metaLine = `${JSON.stringify({ type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: META })}\n`;
  // Real Codex payloads carry the text in message (event_msg) / output_text
  // (response_item); pad the message itself so 中 lands exactly on the last
  // byte of a 64 KiB read chunk.
  const record = { type: 'event_msg', timestamp: '2026-06-10T10:00:01Z', payload: { type: 'agent_message', message: '中' } };
  const pad = READ_BUFFER_SIZE - 1 - Buffer.byteLength(metaLine) - Buffer.byteLength(JSON.stringify(record).split('中')[0]);
  const agentText = 'x'.repeat(pad) + '中';
  record.payload.message = agentText;
  // Self-calibrate: 中's first byte must sit on the chunk boundary, otherwise
  // this test silently stops covering the bug when READ_BUFFER_SIZE changes.
  const boundaryOffset = Buffer.byteLength(metaLine) + Buffer.byteLength(JSON.stringify(record).split('中')[0]);
  assert.equal(boundaryOffset % READ_BUFFER_SIZE, READ_BUFFER_SIZE - 1);
  const duplicate = `${JSON.stringify({ type: 'response_item', timestamp: '2026-06-10T10:00:01Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: agentText }] } })}\n`;
  writeFileSync(path, Buffer.concat([Buffer.from(metaLine), Buffer.from(`${JSON.stringify(record)}\n`), Buffer.from(duplicate)]));

  const { values } = drain(parse({ key: path, sessionId: '' }, null));
  const assistantMessages = values.filter(record => record.kind === 'message' && record.role === 'assistant');

  // The matching response_item must be deduped. A broken boundary decode makes
  // the two long texts differ, so both messages survive — that is the bug this
  // test exists to catch.
  assert.equal(assistantMessages.length, 1, 'long agent_message deduped against its response_item');
  assert.equal(assistantMessages[0].text, agentText.slice(0, TEXT_LIMIT));
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
  const root = mkdtempSync(join(tmpdir(), 'obelisk-codex-index-meta-'));
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
