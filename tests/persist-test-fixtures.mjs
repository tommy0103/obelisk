// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const appDir = fileURLToPath(new URL('../app/', import.meta.url));
const BetterSqlite3 = require(require.resolve('better-sqlite3', { paths: [appDir] }));

export const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');

export const bindings = [
  ['node:sqlite', () => new DatabaseSync(':memory:')],
  ['better-sqlite3', () => new BetterSqlite3(':memory:')],
];

export function openNodeSqlite() {
  return new DatabaseSync(':memory:');
}

export function messageRecord(id, changes = {}) {
  return {
    kind: 'message',
    uuid: `message-${id}`,
    session_id: 'session-1',
    type: 'assistant',
    parent_uuid: null,
    timestamp: `2026-09-01T10:${String(Number(id) % 60).padStart(2, '0')}:00.000Z`,
    role: 'assistant',
    text: `stable searchable text ${id}`,
    content_type: 'text',
    is_meta: 0,
    visibility: 'visible',
    model: 'model-1',
    is_sidechain: 0,
    agent_id: null,
    input_tokens: 10,
    output_tokens: 20,
    cwd: '/workspace',
    skill: null,
    source: 'codex',
    ...changes,
  };
}

export function toolCallRecord(id, changes = {}) {
  return {
    kind: 'tool_call',
    id: `call-${id}`,
    message_uuid: `message-${id}`,
    session_id: 'session-1',
    name: 'exec_command',
    presentation: 'default',
    input_json: '{"cmd":"true"}',
    file_path: null,
    ...changes,
  };
}

export function toolResultRecord(id, changes = {}) {
  return {
    kind: 'tool_result',
    tool_use_id: `call-${id}`,
    message_uuid: `message-${id}`,
    session_id: 'session-1',
    content: 'done',
    file_path: null,
    is_error: 0,
    ...changes,
  };
}
