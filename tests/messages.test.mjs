// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createPiProvider } from '../packages/core/src/providers/pi.ts';
import { createOmpProvider } from '../packages/core/src/providers/omp.ts';
import { persist } from '../packages/core/src/persist.ts';
import { createQueryApi } from '../packages/core/src/query.ts';

const schema = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');
const ids = rows => rows.map(row => row.uuid);

function providerDb(t, source) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(schema);
  const create = source === 'pi' ? createPiProvider : createOmpProvider;
  const provider = create({ rootDir: fileURLToPath(new URL(`./fixtures/${source}/`, import.meta.url)) });
  const units = provider.discover({ lastCursor: () => null });
  assert.ok(units.length > 0, 'discover real checked-in provider transcripts');
  for (const unit of units) persist(db, unit, provider.parse(unit, null));
  return { db, api: createQueryApi(db) };
}

// Relational edge probes supplement provider fixtures; these are not provider wire fixtures.
function relationalDb(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(schema);
  db.prepare('INSERT INTO sessions(id,title) VALUES (?,?)').run('s', 'Message window');
  const insert = db.prepare(`INSERT INTO messages(uuid,session_id,parent_uuid,timestamp,agent_id,content_type,is_meta,visibility)
    VALUES (?,'s',?,?,?,?,?,?)`);
  const rows = [
    ['root', null, null, null, 'text', 0, 'visible'],
    ['a', 'root', '2026-01-01T00:00:01Z', null, 'text', 0, 'visible'],
    ['b', 'a', '2026-01-01T00:00:01Z', null, 'thinking', 0, 'visible'],
    ['c', 'b', '2026-01-01T00:00:01Z', null, 'text', 1, 'visible'],
    ['d', 'c', '2026-01-01T00:00:02Z', null, 'text', 0, 'hidden'],
    ['e', 'd', '2026-01-01T00:00:03Z', null, 'text', 0, 'inactive'],
    ['f', 'e', '2026-01-01T00:00:04Z', null, 'text', 0, null],
    ['g', 'f', '2026-01-01T00:00:05Z', null, 'text', 0, 'visible'],
    ['agent', null, '2026-01-01T00:00:03Z', 'worker', 'text', 0, 'visible'],
    ['fork', 'a', '2026-01-01T00:00:01Z', null, 'text', 0, 'visible'],
    ['orphan', 'missing', '2026-01-01T00:00:06Z', null, 'text', 0, 'visible'],
    ['cycle-a', 'cycle-b', '2026-01-01T00:00:07Z', null, 'text', 0, 'hidden'],
    ['cycle-b', 'cycle-a', '2026-01-01T00:00:08Z', null, 'text', 0, 'hidden'],
    ['cycle-target', 'cycle-a', '2026-01-01T00:00:09Z', null, 'text', 0, 'visible'],
  ];
  for (const row of rows) insert.run(...row);
  return { db, api: createQueryApi(db) };
}

for (const source of ['pi', 'omp']) {
  test(`messages() preserves ${source} ancestor tails and visibility from real transcripts`, t => {
    const { db, api } = providerDb(t, source);
    const rows = db.prepare('SELECT * FROM messages').all();
    for (const includeInactive of [false, true]) for (const includeMeta of [false, true]) {
      for (const contentTypes of [undefined, ['text']]) for (const count of [1, 2, 5]) for (const row of rows) {
        const previous = api.context(row.uuid, { includeInactive });
        const current = api.messages({ around: row.uuid, relation: 'parents', beforeCount: count,
          includeInactive, includeMeta, contentTypes, includeSession: true });
        if (!previous) { assert.equal(current, null); continue; }
        const eligible = previous.parentChain.filter(m => (includeMeta || !m.is_meta)
          && (!contentTypes || contentTypes.includes(m.content_type)));
        assert.deepEqual(current.messages.slice(0, -1), eligible.slice(-count));
        assert.deepEqual(current.anchor, previous.message);
        assert.deepEqual(current.session, previous.session);
        assert.equal(current.hasMore, eligible.length > count);
        assert.equal(current.nextCursor, null);
      }
    }
  });
}

test('messages() exact lookup exposes a chosen anchor without loading its ancestry', t => {
  const { api } = relationalDb(t);
  const value = api.messages('c');
  assert.equal(value.anchor.uuid, 'c', 'explicit meta anchor remains readable');
  assert.deepEqual(ids(value.messages), ['c']);
  assert.equal(value.session, null);
  assert.equal(value.hasMore, false);
  assert.equal(api.messages('d'), null, 'hidden remains unavailable');
  assert.equal(api.messages('e'), null, 'inactive is opt-in');
  assert.equal(api.messages({ uuid: 'e', includeInactive: true }).anchor.visibility, 'inactive');
  assert.equal(api.messages('missing'), null);
});

test('messages() selects N qualifying ancestors across hidden and inactive bridges', t => {
  const { api } = relationalDb(t);
  assert.deepEqual(ids(api.messages({ around: 'g', relation: 'parents', beforeCount: 2, contentTypes: ['text'] }).messages), ['a', 'f', 'g']);
  assert.deepEqual(ids(api.messages({ around: 'g', relation: 'parents', beforeCount: 2, contentTypes: ['text'], includeInactive: true }).messages), ['e', 'f', 'g']);
  assert.deepEqual(ids(api.messages({ around: 'g', relation: 'parents', beforeCount: 4, includeMeta: true }).messages), ['a', 'b', 'c', 'f', 'g']);
  assert.deepEqual(ids(api.messages({ around: 'orphan', relation: 'parents', beforeCount: 4 }).messages), ['orphan'], 'no stitching across a missing parent');
});

test('messages() temporal neighbors stay in the anchor agent and use deterministic timestamp ties', t => {
  const { api } = relationalDb(t);
  const value = api.messages({ around: 'f', beforeCount: 2, afterCount: 1, contentTypes: ['text'] });
  assert.deepEqual(ids(value.messages), ['a', 'fork', 'f', 'g']);
  assert.equal(value.hasMore, true);
  assert.equal(value.messages.some(m => m.uuid === 'agent'), false);
  const path = api.messages({ around: 'f', relation: 'parents', beforeCount: 2, contentTypes: ['text'] });
  assert.deepEqual(ids(path.messages), ['root', 'a', 'f'], 'parent mode excludes the other fork');
  assert.deepEqual(ids(api.messages({ around: 'root', beforeCount: 3, afterCount: 2 }).messages), ['root', 'a', 'b'], 'null timestamps sort first');
});

test('messages() paginates a filtered session without dropping timestamp ties', t => {
  const { api } = relationalDb(t);
  const options = { sessionId: 's', agentId: null, contentTypes: ['text'], limit: 2 };
  let page = api.messages(options);
  const collected = [...page.messages];
  assert.equal(page.anchor, null);
  assert.ok(page.nextCursor);
  while (page.nextCursor) {
    page = api.messages({ ...options, cursor: page.nextCursor });
    collected.push(...page.messages);
  }
  assert.deepEqual(ids(collected), ['root', 'a', 'fork', 'f', 'g', 'orphan', 'cycle-target']);
  assert.equal(page.hasMore, false);
  assert.equal(new Set(ids(collected)).size, collected.length);
  assert.deepEqual(ids(api.messages({ ...options, after: '2026-01-01T00:00:01Z', before: '2026-01-01T00:00:06Z' }).messages), ['f', 'g']);
  assert.deepEqual(ids(api.messages({ sessionId: 's', agentId: 'worker' }).messages), ['agent']);
  assert.deepEqual(api.messages({ sessionId: 'missing' }).messages, []);
});

test('messages() range reads and attached session metadata are bounded and optional', t => {
  const { api } = relationalDb(t);
  assert.equal(api.messages({ sessionId: 's', limit: 1 }).messages.length, 1);
  assert.equal(api.messages({ sessionId: 's', limit: 0 }).messages.length, 0);
  assert.equal(api.messages({ sessionId: 's', includeSession: true }).session.title, 'Message window');
  assert.equal(api.messages({ uuid: 'a', includeSession: true }).session.id, 's');
  assert.equal(api.messages({ around: 'a', beforeCount: 0, afterCount: 0 }).messages.length, 1);
});

test('messages() preserves indexed evidence when owner session metadata is missing', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(schema);
  db.prepare("INSERT INTO messages(uuid,session_id,visibility) VALUES ('orphan-owner','absent','visible')").run();
  const api = createQueryApi(db);
  const lookup = api.messages({ uuid: 'orphan-owner', includeSession: true });
  assert.equal(lookup.anchor.uuid, 'orphan-owner');
  assert.equal(lookup.session, null);
  const page = api.messages({ sessionId: 'absent', includeSession: true });
  assert.deepEqual(ids(page.messages), ['orphan-owner']);
  assert.equal(page.session, null);
});

test('messages() rejects ambiguous selectors, unsupported modes, and unbounded counts', t => {
  const { api } = relationalDb(t);
  for (const options of [undefined, null, [], {}, { sessionId: 's', around: 'a' }, { around: '' },
    { around: 'a', relation: 'unknown' }, { around: 'a', relation: 'parents', afterCount: 1 },
    { around: 'a', limit: 2 }, { sessionId: 's', beforeCount: 2 }, { uuid: 'a', relation: 'parents' },
    { sessionId: 's', offset: 1 }, { sessionId: 's', agentId: 1 }, { sessionId: 's', cursor: {} },
    { sessionId: 's', includeInactive: 'yes' }, { sessionId: 's', contentTypes: [] },
    { sessionId: 's', contentTypes: [1] }, { sessionId: 's', after: 1 }]) {
    assert.throws(() => api.messages(options), /messages\(\)/);
  }
  for (const limit of [-1, 0.5, NaN, Infinity, 501, '5', null]) assert.throws(() => api.messages({ sessionId: 's', limit }), RangeError);
  assert.throws(() => api.messages({ around: 'a', beforeCount: 300, afterCount: 300 }), RangeError);
});

test('messages() reports hidden parent cycles without returning partial evidence', t => {
  const { api } = relationalDb(t);
  assert.throws(() => api.messages({ around: 'cycle-target', relation: 'parents' }), /cyclic parent path/);
});

test('messages() fails explicitly on excessive filtered traversal without returning partial evidence', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(schema);
  db.exec('BEGIN');
  const insert = db.prepare("INSERT INTO messages(uuid,session_id,parent_uuid,visibility) VALUES (?,'probe',?,?)");
  for (let i = 0; i < 10002; i++) insert.run(`bridge-${i}`, i ? `bridge-${i - 1}` : null, 'hidden');
  insert.run('target', 'bridge-10001', 'visible');
  db.exec('COMMIT');
  assert.throws(() => createQueryApi(db).messages({ around: 'target', relation: 'parents' }), /parent traversal exceeded/);
});
