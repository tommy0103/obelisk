import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { assembleSessionDetail } from '../packages/core/src/session-detail.ts';
import { persist } from '../packages/core/src/persist.ts';
import { parse as parseCodex } from '../packages/core/src/providers/codex.ts';
import { makeTempDir } from './temp-dirs.mjs';

const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');

function writeCodexFixture(lines) {
  const dir = makeTempDir('obelisk-provider-detail-');
  const path = join(dir, 'rollout.jsonl');
  writeFileSync(path, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`);
  return path;
}

test('a provider record stream assembles directly into session detail', () => {
  const threadId = '019e8951-3e7d-7343-a3e3-05bff48a317d';
  const path = writeCodexFixture([
    {
      type: 'session_meta',
      timestamp: '2026-06-10T10:00:00Z',
      payload: { id: threadId, cwd: '/proj', timestamp: '2026-06-10T10:00:00Z' },
    },
    {
      type: 'event_msg',
      timestamp: '2026-06-10T10:00:01Z',
      payload: { type: 'user_message', message: 'inspect the repository' },
    },
    {
      type: 'event_msg',
      timestamp: '2026-06-10T10:00:02Z',
      payload: { type: 'agent_message', message: 'I will inspect it.' },
    },
    {
      type: 'response_item',
      timestamp: '2026-06-10T10:00:03Z',
      payload: { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"cmd":"ls"}' },
    },
    {
      type: 'response_item',
      timestamp: '2026-06-10T10:00:04Z',
      payload: { type: 'function_call_output', call_id: 'call_1', output: 'package.json' },
    },
  ]);

  const records = [...parseCodex({ key: path, sessionId: '' }, null)];
  const detail = assembleSessionDetail(records);

  assert.deepEqual(detail.messages.map(message => message.text), [
    'inspect the repository',
    'I will inspect it.',
  ]);
  assert.equal(detail.messages[1].tool_calls?.[0].name, 'shell');
  assert.equal(detail.messages[1].tool_calls?.[0].result?.content, 'package.json');

  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  persist(db, { key: path, sessionId: '' }, parseCodex({ key: path, sessionId: '' }, null));
  const persistedDetail = assembleSessionDetail({
    session: db.prepare('SELECT * FROM sessions').get(),
    messages: db.prepare('SELECT * FROM messages ORDER BY timestamp, uuid').all(),
    toolCalls: db.prepare('SELECT * FROM tool_calls').all(),
    toolResults: db.prepare('SELECT * FROM tool_results').all(),
  });
  assert.deepEqual(persistedDetail, detail);
  db.close();
});

test('Codex token_count without usage remains persistable', () => {
  const threadId = '019e8951-3e7d-7343-a3e3-05bff48a3180';
  const path = writeCodexFixture([
    {
      type: 'session_meta',
      timestamp: '2026-07-14T12:21:21.000Z',
      payload: { id: threadId, cwd: '/tmp/demo', timestamp: '2026-07-14T12:21:21.000Z' },
    },
    {
      type: 'event_msg',
      timestamp: '2026-07-14T12:21:30.000Z',
      payload: { type: 'agent_message', message: 'hello' },
    },
    {
      type: 'event_msg',
      timestamp: '2026-07-14T12:21:31.000Z',
      payload: { type: 'token_count', info: null },
    },
  ]);
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);

  assert.doesNotThrow(() => {
    persist(db, { key: path, sessionId: `codex:${threadId}` }, parseCodex({
      key: path,
      sessionId: `codex:${threadId}`,
    }, null));
  });
  const usage = db.prepare(
    'SELECT input_tokens, output_tokens FROM messages WHERE text = ?',
  ).get('hello');
  assert.equal(usage.input_tokens, null);
  assert.equal(usage.output_tokens, null);
  db.close();
});

test('provider-classified hidden context never reaches session detail', () => {
  const threadId = '019e8951-3e7d-7343-a3e3-05bff48a317e';
  const path = writeCodexFixture([
    {
      type: 'session_meta',
      timestamp: '2026-06-10T10:00:00Z',
      payload: { id: threadId, cwd: '/proj', timestamp: '2026-06-10T10:00:00Z' },
    },
    {
      type: 'response_item',
      timestamp: '2026-06-10T10:00:01Z',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/proj</cwd>\n</environment_context>' }],
      },
    },
    {
      type: 'response_item',
      timestamp: '2026-06-10T10:00:02Z',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<codex_internal_context source="goal">\nsecret state\n</codex_internal_context>' }],
      },
    },
    {
      type: 'event_msg',
      timestamp: '2026-06-10T10:00:03Z',
      payload: { type: 'user_message', message: 'show the actual request' },
    },
  ]);

  const records = [...parseCodex({ key: path, sessionId: '' }, null)];
  const detail = assembleSessionDetail(records);

  assert.deepEqual(detail.messages.map(message => message.text), ['show the actual request']);
  assert.equal(
    records.filter(record => record.kind === 'message' && record.visibility === 'hidden').length,
    2,
  );
  assert.equal(
    records.find(record => record.kind === 'session').message_count,
    1,
  );
});

test('provider normalization removes only structural image wrappers before deduplication', () => {
  const threadId = '019e8951-3e7d-7343-a3e3-05bff48a317f';
  const path = writeCodexFixture([
    {
      type: 'session_meta',
      timestamp: '2026-06-10T10:00:00Z',
      payload: { id: threadId, cwd: '/proj', timestamp: '2026-06-10T10:00:00Z' },
    },
    {
      type: 'event_msg',
      timestamp: '2026-06-10T10:00:01Z',
      payload: { type: 'user_message', message: 'look at this screenshot' },
    },
    {
      type: 'response_item',
      timestamp: '2026-06-10T10:00:01Z',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'look at this screenshot' },
          { type: 'input_text', text: '<image>' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
          { type: 'input_text', text: '</image>' },
        ],
      },
    },
  ]);

  const records = [...parseCodex({ key: path, sessionId: '' }, null)];
  const detail = assembleSessionDetail(records);

  assert.deepEqual(detail.messages.map(message => message.text), ['look at this screenshot']);
});

test('canonical visibility survives persistence before row-based assembly', () => {
  const threadId = '019e8951-3e7d-7343-a3e3-05bff48a3180';
  const path = writeCodexFixture([
    {
      type: 'session_meta',
      timestamp: '2026-06-10T10:00:00Z',
      payload: { id: threadId, cwd: '/proj', timestamp: '2026-06-10T10:00:00Z' },
    },
    {
      type: 'response_item',
      timestamp: '2026-06-10T10:00:01Z',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<environment_context>hidden</environment_context>' }],
      },
    },
    {
      type: 'event_msg',
      timestamp: '2026-06-10T10:00:02Z',
      payload: { type: 'user_message', message: 'visible request' },
    },
  ]);
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);

  persist(db, { key: path, sessionId: '' }, parseCodex({ key: path, sessionId: '' }, null));
  const messages = db.prepare('SELECT * FROM messages ORDER BY timestamp, uuid').all();
  const assembled = assembleSessionDetail({ messages }).messages;

  assert.equal(messages[0].visibility, 'hidden');
  assert.deepEqual(assembled.map(message => message.text), ['visible request']);
  db.close();
});

test('provider normalization classifies Skill instructions before assembly', () => {
  const threadId = '019e8951-3e7d-7343-a3e3-05bff48a3181';
  const path = writeCodexFixture([
    {
      type: 'session_meta',
      timestamp: '2026-06-10T10:00:00Z',
      payload: { id: threadId, cwd: '/proj', timestamp: '2026-06-10T10:00:00Z' },
    },
    {
      type: 'response_item',
      timestamp: '2026-06-10T10:00:01Z',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Base directory for this skill: /tmp/skill\n# Instructions' }],
      },
    },
  ]);

  const records = [...parseCodex({ key: path, sessionId: '' }, null)];
  const message = records.find(record => record.kind === 'message');

  assert.equal(message.content_type, 'skill_instructions');
  assert.equal(message.is_meta, 1);
  assert.equal(message.visibility, 'visible');
});
