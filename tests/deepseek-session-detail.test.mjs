// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Provider conformance (ADR-0007): a deepseek parse() record stream must pass
// directly through assembleSessionDetail, and the assembled result must
// survive a persist round-trip unchanged.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { assembleSessionDetail } from '../packages/core/src/session-detail.ts';
import { persist } from '../packages/core/src/persist.ts';
import { parse as parseDeepseek } from '../packages/core/src/providers/deepseek.ts';
import { makeTempDir } from './temp-dirs.mjs';

const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');

const SID = 'session-019e8951-3e7d-7343-a3e3-05bff48a317d';

function writeDeepseekFixture(lines) {
  const dir = makeTempDir('obelisk-deepseek-detail-');
  const path = join(dir, 'session.jsonl');
  writeFileSync(path, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`);
  return path;
}

const FIXTURE = [
  {
    type: 'session', version: 0, id: SID, createdAt: 1787054668467,
    cwd: '/proj', delegationDepth: 0,
  },
  {
    type: 'user/message', seq: 0, time: 1787054669201, data: {
      content: [{ type: 'text', text: 'inspect the repository' }],
      source: { kind: 'user' }, role: 'user', id: 'm-1' } },
  {
    type: 'assistant/message', seq: 1, time: 1787054669400, data: {
      turn: 1, step: 1, message: { role: 'assistant', content: [
        { type: 'reasoning', text: 'think first' },
        { type: 'text', text: 'I will inspect it.' },
      ], id: 'a-1' }, usage: { inputTokens: 100, outputTokens: 50 } } },
  {
    type: 'tool/call', seq: 2, time: 1787054669500, data: {
      turn: 1, step: 1, callId: 'call_1', name: 'bash', arguments: '{"command":"ls"}' } },
  {
    type: 'tool/result', seq: 3, time: 1787054669600, data: {
      turn: 1, step: 1, message: { role: 'user', content: [
        { type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'package.json' }] },
      ], source: { kind: 'tool', tool: 'bash' }, id: 'tr-1' } } },
  {
    type: 'session/title', seq: 4, time: 1787054669700, data: {
      title: 'inspect the repo', messageSeqs: [0], source: { kind: 'fallback' } } },
];

test('a deepseek record stream assembles directly into session detail', () => {
  const path = writeDeepseekFixture(FIXTURE);
  const records = [...parseDeepseek({ key: path, sessionId: SID }, null)];
  const detail = assembleSessionDetail(records);

  // The reasoning block folds into the assistant message's thinking; the text
  // block is the visible message text.
  assert.deepEqual(detail.messages.map(message => message.text), [
    'inspect the repository',
    'I will inspect it.',
  ]);
  const assistant = detail.messages[1];
  assert.equal(assistant._thinking, 'think first');
  assert.equal(assistant.tool_calls?.[0].name, 'bash');
  assert.equal(assistant.tool_calls?.[0].result?.content, 'package.json');
  assert.equal(detail.session.title, 'inspect the repo');

  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  persist(db, { key: path, sessionId: SID }, parseDeepseek({ key: path, sessionId: SID }, null));
  const persistedDetail = assembleSessionDetail({
    session: db.prepare('SELECT * FROM sessions').get(),
    messages: db.prepare('SELECT * FROM messages ORDER BY timestamp, uuid').all(),
    toolCalls: db.prepare('SELECT * FROM tool_calls').all(),
    toolResults: db.prepare('SELECT * FROM tool_results').all(),
  });
  assert.deepEqual(persistedDetail, detail);
  db.close();
});

test('deepseek messages survive a persist round-trip with meta and source intact', () => {
  const path = writeDeepseekFixture([
    FIXTURE[0],
    {
      type: 'user/message', seq: 0, time: 1787054669201, data: {
        content: [{ type: 'text', text: 'system context' }],
        source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }, role: 'user', id: 'm-1' } },
  ]);
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  persist(db, { key: path, sessionId: SID }, parseDeepseek({ key: path, sessionId: SID }, null));
  const row = db.prepare('SELECT * FROM messages').get();
  assert.equal(row.is_meta, 1);
  assert.equal(row.source, 'deepseek');
  assert.equal(row.visibility, 'visible');
  const session = db.prepare('SELECT * FROM sessions').get();
  assert.equal(session.source, 'deepseek');
  assert.equal(session.version, '0');
  db.close();
});
