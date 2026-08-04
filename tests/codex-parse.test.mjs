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

test('codex streaming parse preserves legacy UTF-8 chunk-boundary output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'obelisk-codex-boundary-'));
  const path = join(dir, 'rollout.jsonl');
  const metaLine = JSON.stringify({
    type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: META,
  });
  const text = 'a你b';
  const event = {
    type: 'event_msg',
    timestamp: '2026-06-10T10:00:01Z',
    payload: { type: 'user_message', message: text },
  };
  const eventLine = JSON.stringify(event);
  const eventPrefixBytes = Buffer.byteLength(eventLine.slice(0, eventLine.indexOf('你')));
  const paddingPrefix = '{"type":"noop","padding":"';
  const paddingSuffix = '"}';
  const fixedBytes = Buffer.byteLength(`${metaLine}\n${paddingPrefix}${paddingSuffix}\n`) + eventPrefixBytes;
  const paddingBytes = (64 * 1024 - 1 - (fixedBytes % (64 * 1024)) + 64 * 1024) % (64 * 1024);
  const responseLine = JSON.stringify({
    type: 'response_item',
    timestamp: '2026-06-10T10:00:02Z',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  });
  writeFileSync(path, `${metaLine}\n${paddingPrefix}${'x'.repeat(paddingBytes)}${paddingSuffix}\n${eventLine}\n${responseLine}\n`);

  const { values } = drain(parse({ key: path, sessionId: '' }, null));
  const messages = values.filter(record => record.kind === 'message');

  // The original reader decodes each 64 KiB read independently. The optimized
  // parser intentionally mirrors that established output until a separate,
  // explicitly semantic migration changes it.
  assert.equal(messages.length, 2);
  assert.notEqual(messages[0].text, messages[1].text);
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

test('codex parse() skips large control records without changing canonical output', () => {
  const ignored = 'x'.repeat(3 * 1024 * 1024);
  const path = writeFixture([
    { type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: META },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:01Z', payload: { type: 'user_message', message: 'original evidence' } },
    { type: 'world_state', timestamp: '2026-06-10T10:00:02Z', payload: { instructions: ignored } },
    {
      type: 'compacted',
      timestamp: '2026-06-10T10:00:03Z',
      payload: {
        message: 'legacy adapter ignores this summary',
        replacement_history: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: ignored }] }],
      },
    },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:04Z', payload: { type: 'agent_message', message: 'new evidence' } },
  ]);

  const { values } = drain(parse({ key: path, sessionId: '' }, null));
  assert.deepEqual(
    values.filter(record => record.kind === 'message').map(message => message.text),
    ['original evidence', 'new evidence'],
  );
  assert.equal(values.filter(record => record.kind === 'summary').length, 0);
});

test('codex parse() keeps the first session_meta as the canonical identity', () => {
  const replayedMeta = { ...META, id: '019e8951-3e7d-7343-a3e3-05bff48a3999', cwd: '/other' };
  const path = writeFixture([
    { type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: META },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:01Z', payload: { type: 'user_message', message: 'before replay' } },
    { type: 'session_meta', timestamp: '2026-06-10T10:00:02Z', payload: replayedMeta },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:03Z', payload: { type: 'agent_message', message: 'after replay' } },
  ]);

  const { values } = drain(parse({ key: path, sessionId: '' }, null));
  const session = values.find(record => record.kind === 'session');
  assert.equal(session.id, `codex:${META.id}`);
  assert.equal(session.jsonl_path, path);
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
