// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

import { createQueryApi } from '../packages/core/src/query.ts';
import { createProviderRegistry } from '../packages/core/src/providers/registry.ts';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');

test('raw query delegates source semantics to the registered provider', () => {
  const calls = [];
  const registry = createProviderRegistry([{
    name: 'alpha',
    descriptor: { id: 'alpha', name: 'Alpha', vendor: 'Test', defaultRoot: '/alpha', color: '#123456' },
    watchTargets: () => [],
    discover: () => [],
    *parse() { yield* []; return null; },
    raw(input) {
      calls.push(input);
      return { text: '0123456789', totalLength: 10 };
    },
  }]);
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.prepare('INSERT INTO sessions (id,jsonl_path,source) VALUES (?,?,?)')
    .run('alpha:session', '/alpha/session.data', 'alpha');
  db.prepare('INSERT INTO messages (uuid,session_id,agent_id,source) VALUES (?,?,?,?)')
    .run('alpha:message', 'alpha:session', 'alpha:agent', 'alpha');
  db.prepare('INSERT INTO subagents (agent_id,session_id,description) VALUES (?,?,?)')
    .run('alpha:agent', 'alpha:session', 'agent metadata');
  db.prepare('INSERT INTO index_state (jsonl_path,mtime,lines_processed,cursor) VALUES (?,?,?,?)')
    .run('/alpha/session.data', 10, 1, 'committed-alpha-cursor');

  const result = createQueryApi(db, { providerRegistry: registry }).raw('alpha:message', {
    offset: 2,
    limit: 4,
  });

  assert.deepEqual(result, {
    text: '2345', totalLength: 10, offset: 2, limit: 4, hasMore: true, visibility: 'visible',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].source, 'alpha');
  assert.equal(calls[0].session.id, 'alpha:session');
  assert.equal(calls[0].cursor, 'committed-alpha-cursor');
  assert.equal(calls[0].subagent.description, 'agent metadata');
  db.close();
});
