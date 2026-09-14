// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { querySessionCatalogue } from '../app/src/main/session-catalogue.ts';
import { createSessionCatalogue, createSessionCatalogueState } from '../app/src/renderer/src/session-catalogue.mjs';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, project TEXT, project_path TEXT,
    started_at TEXT, ended_at TEXT, git_branch TEXT, version TEXT, message_count INTEGER, jsonl_path TEXT, source TEXT)`);
  const insert = db.prepare('INSERT INTO sessions (id, title, project, started_at, git_branch, source) VALUES (?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < 1105; i++) {
    insert.run(`session-${String(i).padStart(4, '0')}`, i === 0 ? 'ÉCOLE 100%_历史' : `Conversation ${i}`,
      i < 5 ? 'older-only' : 'current', new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), i === 0 ? 'branch/旧' : 'main', i % 2 ? 'codex' : 'claude');
  }
  return db;
}

test('all indexed sessions beyond 1,000 remain reachable and ordered in both directions', t => {
  const db = fixture(t);
  for (const sortDesc of [true, false]) {
    let previous = [];
    for (let limit = 100; limit < 1201; limit += 100) {
      const page = querySessionCatalogue(db, { limit, sortDesc });
      assert.equal(page.total, 1105);
      assert.equal(page.sessions.length, Math.min(limit, 1105));
      const ids = page.sessions.map(s => s.id);
      assert.deepEqual(ids.slice(0, previous.length), previous);
      assert.equal(new Set(ids).size, ids.length);
      previous = ids;
    }
    assert.equal(previous[0], sortDesc ? 'session-1104' : 'session-0000');
    assert.equal(previous.at(-1), sortDesc ? 'session-0000' : 'session-1104');
  }
});

test('metadata search and exact project/source filters cover the full matching history', t => {
  const db = fixture(t);
  for (const query of ['école', '历史', '100%_', 'branch/旧', 'older-only']) {
    const page = querySessionCatalogue(db, { query });
    assert.ok(page.sessions.some(s => s.id === 'session-0000'), query);
  }
  assert.equal(querySessionCatalogue(db, { query: '100%X' }).total, 0);
  assert.equal(querySessionCatalogue(db, { project: 'older-only', source: 'codex' }).total, 2);
  assert.equal(querySessionCatalogue(db, { project: 'older%' }).total, 0);
  assert.equal(querySessionCatalogue(db, { query: "' OR 1=1 --" }).total, 0);
});

test('new activity, deletion and inserts cannot leave holes or duplicates between loaded batches', t => {
  const db = fixture(t);
  querySessionCatalogue(db, { limit: 100 });
  db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run('2027-01-01T00:00:00.000Z', 'session-0000');
  db.prepare('DELETE FROM sessions WHERE id = ?').run('session-1090');
  const page = querySessionCatalogue(db, { limit: 200 });
  const expected = db.prepare("SELECT id FROM sessions ORDER BY COALESCE(ended_at, started_at) DESC, id DESC LIMIT 200").all().map(r => r.id);
  assert.deepEqual(page.sessions.map(r => r.id), expected);
  assert.equal(page.total, 1104);
});

test('refresh retains a reader pushed beyond the loaded prefix by newer sessions', t => {
  const db = fixture(t);
  const page = querySessionCatalogue(db, { limit: 100, anchorId: 'session-0008' });
  assert.ok(page.sessions.some(s => s.id === 'session-0008'));
  assert.equal(page.total, 1105);
  assert.equal(querySessionCatalogue(db, { limit: 100, anchorId: 'deleted' }).sessions.length, 100);
});

test('equal timestamps have a stable order and invalid limits cannot remove the bound', t => {
  const db = fixture(t);
  db.exec("UPDATE sessions SET started_at = NULL, ended_at = NULL");
  const page = querySessionCatalogue(db, { limit: 100 });
  assert.equal(page.sessions[0].id, 'session-1104');
  for (const limit of [-1, 0, 1.5, Infinity, '100']) assert.throws(() => querySessionCatalogue(db, { limit }), /positive integer/);
});

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('a late response cannot overwrite a newer search', async () => {
  const first = deferred();
  const state = createSessionCatalogueState();
  const loader = createSessionCatalogue({ state, query: opts => opts.query === 'old' ? first.promise : Promise.resolve({ sessions: [{ id: 'new' }], total: 1 }) });
  const pending = loader.configure({ query: 'old' });
  void loader.configure({ query: 'new' });
  first.resolve({ sessions: [{ id: 'old' }], total: 1 });
  await pending;
  assert.deepEqual(state.rows.map(r => r.id), ['new']);
});

test('automatic refresh patches retained row identities, coalesces updates and preserves the commit-time reader', async () => {
  const state = createSessionCatalogueState();
  let response = { sessions: [{ id: 'one', title: 'Before' }], total: 1 };
  let position = { id: 'one', offset: -10 };
  let restored;
  let calls = 0;
  const loader = createSessionCatalogue({ state, query: async () => { calls++; return response; }, capture: () => position, restore: p => { restored = p; } });
  await loader.configure({});
  const original = state.rows[0];
  const delayed = deferred();
  response = delayed.promise;
  const pending = loader.refresh();
  void loader.refresh();
  void loader.refresh();
  position = { id: 'one', offset: -25 };
  const result = { sessions: [{ id: 'two' }, { id: 'one', title: 'After' }], total: 2 };
  response = result;
  delayed.resolve(result);
  await pending;
  assert.equal(calls, 3);
  assert.equal(state.rows[1], original);
  assert.equal(original.title, 'After');
  assert.deepEqual(restored, position);
});

test('loading more preserves the expanded window across refresh and errors can be retried', async () => {
  const state = createSessionCatalogueState();
  let fail = false;
  const loader = createSessionCatalogue({ state, query: async opts => {
    if (fail) throw new Error('offline');
    return { sessions: Array.from({ length: opts.limit }, (_, i) => ({ id: String(i) })), total: 300 };
  } });
  await loader.configure({});
  await loader.more();
  assert.equal(state.rows.length, 200);
  fail = true;
  await loader.refresh();
  assert.equal(state.rows.length, 200);
  assert.equal(state.error, 'offline');
  fail = false;
  await loader.refresh();
  assert.equal(state.rows.length, 200);
  assert.equal(state.error, '');
});

test('leaving the list prevents an in-flight result from modifying its saved state', async () => {
  const response = deferred();
  const state = createSessionCatalogueState();
  const loader = createSessionCatalogue({ state, query: () => response.promise });
  const pending = loader.configure({});
  loader.dispose();
  response.resolve({ sessions: [{ id: 'late' }], total: 1 });
  await pending;
  assert.deepEqual(state.rows, []);
});

test('a failed superseded request does not prevent the new search from loading', async () => {
  let reject;
  const first = new Promise((_, r) => { reject = r; });
  const state = createSessionCatalogueState();
  const loader = createSessionCatalogue({ state, query: opts => opts.query === 'old' ? first : Promise.resolve({ sessions: [{ id: 'new' }], total: 1 }) });
  const pending = loader.configure({ query: 'old' });
  void loader.configure({ query: 'new' });
  reject(new Error('old failure'));
  await pending;
  assert.equal(state.rows[0].id, 'new');
  assert.equal(state.error, '');
});

test('a stalled request has a deadline and does not leave loading stuck', async () => {
  const state = createSessionCatalogueState();
  const loader = createSessionCatalogue({ state, query: () => new Promise(() => {}), timeoutMs: 10 });
  await loader.configure({});
  assert.equal(state.loading, false);
  assert.match(state.error, /timed out/);
});
