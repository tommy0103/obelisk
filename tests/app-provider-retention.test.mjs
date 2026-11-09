// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createDeepseekProvider } from '../packages/core/src/providers/deepseek.ts';
import { createBuiltinProviderRegistry } from '../packages/core/src/providers/builtins.ts';
import { buildIndex as buildAppIndex } from '../app/src/main/indexer.ts';
import { runCli } from './cli-test-helpers.mjs';
import { createQueryApi } from '../packages/core/src/query.ts';
import { storedProviderCursor } from '../packages/core/src/provider-indexing.ts';
import { createProviderRegistry } from '../packages/core/src/providers/registry.ts';
import { persist } from '../packages/core/src/persist.ts';
import { makeTempDir } from './temp-dirs.mjs';

const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');
const FIXTURES = fileURLToPath(new URL('./fixtures/deepseek/sessions/--dsh-v3--', import.meta.url));

function fixture() {
  const home = makeTempDir('obelisk-retained-tree-');
  const root = join(home, '.dsh', 'sessions');
  const project = join(root, '--dsh-v3--');
  mkdirSync(project, { recursive: true });
  for (const name of ['v3-seeded-parent', 'v3-seeded-child', 'v3-basic', 'v3-ptc']) {
    cpSync(join(FIXTURES, name), join(project, name), { recursive: true });
  }
  const provider = createDeepseekProvider({ rootDir: root });
  return { home, root, project, provider };
}

// The unknown generation is a controlled mutation of real writer output. Its
// body must never reach projection; the old generation remains beside it.
function publishFuture(project, name, changes = {}) {
  const path = join(project, name, 'session.v5.jsonl');
  const previous = join(project, name, 'session.v3.jsonl');
  const [first, ...body] = readFileSync(previous, 'utf8').trimEnd().split('\n');
  writeFileSync(path, [JSON.stringify({ ...JSON.parse(first), version: 5, ...changes }), ...body].join('\n') + '\n');
  return path;
}

for (const watch of [false, true]) {
  test(`a newer child retains the complete last-good tree while a healthy sibling publishes (${watch ? 'watch' : 'refresh'})`, () => {
    const { project, provider } = fixture();
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA);
    try {
      const cursors = new Map();
      const initial = provider.discover({ lastCursor: () => null });
      for (const unit of initial) cursors.set(unit.key, persist(db, unit, provider.parse(unit, null)));
      const parent = initial.find(unit => unit.key.includes('v3-seeded-parent'));
      assert.ok(parent);
      const before = db.prepare('SELECT uuid, text, agent_id FROM messages WHERE session_id=? ORDER BY uuid').all(parent.sessionId);
      assert.ok(before.some(row => row.agent_id !== null), 'the real seeded child contributed rows');
      const changed = publishFuture(project, 'v3-seeded-child');
      const retained = [];
      const skipped = [];
      const units = provider.discover({
        lastCursor: key => cursors.get(key) ?? null,
        ...(watch ? { changedPaths: [changed] } : {}),
        indexedSessions: () => initial.map(unit => ({ sessionId: unit.sessionId, jsonlPath: unit.key })),
        retainSession: id => retained.push(id),
        reportSkippedArtifact: issue => skipped.push(issue),
      });
      assert.ok(!units.some(unit => unit.sessionId === parent.sessionId), 'an incomplete tree must never be projected');
      assert.ok(retained.includes(parent.sessionId), 'last-good retention is explicit in discovery');
      assert.equal(skipped.length, 1);
      for (const unit of units) persist(db, unit, provider.parse(unit, cursors.get(unit.key) ?? null));
      assert.deepEqual(db.prepare('SELECT uuid, text, agent_id FROM messages WHERE session_id=? ORDER BY uuid').all(parent.sessionId), before);
    } finally { db.close(); }
  });
}

class TestDatabase {
  constructor(path) { this.db = new DatabaseSync(path); }
  get inTransaction() { return this.db.isTransaction; }
  pragma(sql) { this.db.exec(`PRAGMA ${sql}`); }
  exec(sql) { return this.db.exec(sql); }
  prepare(sql) { return this.db.prepare(sql); }
  close() { this.db.close(); }
}

function messagesAt(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare('SELECT * FROM messages ORDER BY uuid').all(); }
  finally { db.close(); }
}

for (const replacement of [false, true]) {
  test(`force rebuild preserves last-good trees and publishes healthy siblings (${replacement ? 'replacement database' : 'same database'})`, () => {
    const { home, project, provider } = fixture();
    const dbPath = join(home, 'old.sqlite');
    const options = { dbPath, DatabaseImpl: TestDatabase, providerRegistry: createProviderRegistry([provider]) };
    assert.equal(buildAppIndex(options).complete, true);
    const before = messagesAt(dbPath);
    assert.ok(before.length > 0);
    publishFuture(project, 'v3-seeded-child');
    const target = replacement ? join(home, 'replacement.sqlite') : dbPath;
    const result = buildAppIndex({ ...options, dbPath: target, force: true, ...(replacement ? { preserveDbPath: dbPath } : {}) });
    assert.equal(result.complete, true);
    assert.deepEqual(messagesAt(target), before, 'force publication retains every last-good message');
    assert.equal(result.skipped, 1);
    assert.match(result.skippedFiles[0].error, /Unsupported session format version 5/);
  });
}

test('a retained tree cannot lose a member to another tree during a future-format transition', () => {
  const { home, project, provider } = fixture();
  const dbPath = join(home, 'index.sqlite');
  const options = { dbPath, DatabaseImpl: TestDatabase, providerRegistry: createProviderRegistry([provider]) };
  buildAppIndex(options);
  const before = messagesAt(dbPath);
  publishFuture(project, 'v3-seeded-parent');
  const child = join(project, 'v3-seeded-child', 'session.v3.jsonl');
  const [header, ...body] = readFileSync(child, 'utf8').trimEnd().split('\n');
  writeFileSync(child, [JSON.stringify({ ...JSON.parse(header), parentSession: 'v3-basic' }), ...body].join('\n') + '\n');
  const result = buildAppIndex({ ...options, force: true });
  assert.equal(result.complete, true);
  assert.deepEqual(messagesAt(dbPath), before, 'a shared member must not overwrite last-good retained rows');
});


test('retained checkpoints survive marker replay and restart without certifying projection', () => {
  const { home, project, provider } = fixture();
  const dbPath = join(home, 'index.sqlite');
  const options = { dbPath, DatabaseImpl: TestDatabase, providerRegistry: createProviderRegistry([provider]) };
  const oldRegistry = createProviderRegistry([{ ...provider, indexVersionMarker: '__deepseek_canonical_transcript_v4__' }]);
  buildAppIndex({ ...options, providerRegistry: oldRegistry });
  const before = messagesAt(dbPath);
  const future = publishFuture(project, 'v3-seeded-child', { id: 'changed-future-child', parentSession: 'unknown-root', cwd: '/future-cwd' });
  for (let restart = 0; restart < 2; restart++) {
    assert.equal(buildAppIndex(options).complete, true);
    assert.deepEqual(messagesAt(dbPath), before);
    const db = new DatabaseSync(dbPath);
    const parentPath = join(project, 'v3-seeded-parent', 'session.v3.jsonl');
    assert.equal(storedProviderCursor(db, parentPath), null);
    assert.equal(db.prepare('SELECT replay_required FROM index_state WHERE jsonl_path=?').get(parentPath).replay_required, 1);
    assert.ok(db.prepare('SELECT jsonl_path FROM index_state WHERE jsonl_path=?').get(provider.indexVersionMarker));
    db.close();
  }
  rmSync(future);
  assert.equal(buildAppIndex(options).complete, true);
  assert.deepEqual(messagesAt(dbPath), before, 'recovered source replays without duplicating usage or rows');
  const db = new DatabaseSync(dbPath);
  assert.equal(db.prepare('SELECT replay_required FROM index_state WHERE jsonl_path=?').get(join(project, 'v3-seeded-parent', 'session.v3.jsonl')).replay_required, 0);
  db.close();
});

test('pending replay remains incomplete until a recovered seed is durable', () => {
  const { home, project, provider } = fixture();
  const dbPath = join(home, 'index.sqlite');
  const options = { dbPath, DatabaseImpl: TestDatabase, providerRegistry: createProviderRegistry([provider]) };
  assert.equal(buildAppIndex(options).complete, true);
  const before = messagesAt(dbPath);
  const future = publishFuture(project, 'v3-seeded-parent');
  assert.equal(buildAppIndex({ ...options, changedPaths: [future] }).complete, true);
  const child = join(project, 'v3-seeded-child', 'session.v3.jsonl');
  const durableChild = readFileSync(child, 'utf8');
  rmSync(future);
  writeFileSync(child, durableChild.split('\n')[0] + '\n');
  for (const extra of [{ changedPaths: [future] }, {}]) {
    const result = buildAppIndex({ ...options, ...extra });
    assert.equal(result.complete, false, 'pending replay cannot certify a header-only child');
    assert.deepEqual(messagesAt(dbPath), before);
    const db = new DatabaseSync(dbPath);
    const state = db.prepare('SELECT cursor, replay_required FROM index_state WHERE jsonl_path=?')
      .get(join(project, 'v3-seeded-parent', 'session.v3.jsonl'));
    assert.ok(state.cursor, 'historical membership remains available for retry');
    assert.equal(state.replay_required, 1);
    db.close();
  }
  writeFileSync(child, durableChild);
  assert.equal(buildAppIndex(options).complete, true);
  assert.deepEqual(messagesAt(dbPath), before);
});

test('missing historical trees defer deletion until unknown content clears', () => {
  const { home, project, provider } = fixture();
  const dbPath = join(home, 'index.sqlite');
  const options = { dbPath, DatabaseImpl: TestDatabase, providerRegistry: createProviderRegistry([provider]) };
  buildAppIndex(options);
  publishFuture(project, 'v3-seeded-child');
  rmSync(join(project, 'v3-basic'), { recursive: true });
  assert.equal(buildAppIndex(options).complete, true);
  const rows = messagesAt(dbPath);
  assert.ok(rows.some(row => row.agent_id !== null), 'the retained child stays visible');
  assert.ok(rows.some(row => row.uuid.includes('v3-basic')), 'absence is not deletion proof while unknown content may own the old identity');
  rmSync(join(project, 'v3-seeded-parent'), { recursive: true });
  rmSync(join(project, 'v3-seeded-child'), { recursive: true });
  assert.equal(buildAppIndex(options).complete, true);
  assert.ok(messagesAt(dbPath).every(row => row.uuid.includes('v3-ptc')));
});


function appendHealthy(project) {
  const path = join(project, 'v3-ptc', 'session.v3.jsonl');
  const records = readFileSync(path, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  appendFileSync(path, JSON.stringify({
    type: 'user/message', seq: Math.max(...records.map(record => record.seq ?? -1)) + 1,
    time: 2000, data: { id: 'healthy-progress', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'healthy sibling progressed' }] },
    surfaceOp: 'append',
  }) + '\n');
  return path;
}

for (const force of [false, true]) {
  test(`healthy siblings progress and discovery skips remain visible (${force ? 'force' : 'watch'})`, () => {
    const { home, project, provider } = fixture();
    const dbPath = join(home, 'index.sqlite');
    const options = { dbPath, DatabaseImpl: TestDatabase, providerRegistry: createProviderRegistry([provider]) };
    buildAppIndex(options);
    const future = publishFuture(project, 'v3-seeded-child');
    const healthy = appendHealthy(project);
    const result = buildAppIndex({ ...options, force, changedPaths: [future, healthy] });
    assert.equal(result.complete, true);
    assert.equal(result.skipped, 1);
    assert.equal(result.skippedFiles[0].path, future);
    const db = new DatabaseSync(dbPath);
    assert.equal(createQueryApi(db).search('healthy sibling progressed').length, 1);
    assert.ok(db.prepare('SELECT uuid FROM messages WHERE agent_id IS NOT NULL').get());
    db.close();
  });
}

test('the built CLI preserves last-good history and reports future artifacts on stderr', () => {
  const { home, project } = fixture();
  let built = runCli(['--build'], { home });
  assert.equal(built.status, 0, built.stderr || built.stdout);
  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
  const before = messagesAt(dbPath);
  const future = publishFuture(project, 'v3-seeded-child');
  built = runCli(['--build'], { home });
  assert.equal(built.status, 0, built.stderr || built.stdout);
  assert.deepEqual(JSON.parse(built.stdout), { ok: true, db: dbPath });
  assert.ok(built.stderr.includes(future));
  assert.match(built.stderr, /Unsupported session format version 5/);
  assert.deepEqual(messagesAt(dbPath), before);
});

for (const command of ['query', 'search']) {
  test(`CLI ${command} refresh reports future artifacts while returning last-good history`, () => {
    const { home, project } = fixture();
    const initial = runCli(['--build'], { home });
    assert.equal(initial.status, 0, initial.stderr || initial.stdout);
    const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
    const before = messagesAt(dbPath);
    const future = publishFuture(project, 'v3-seeded-child');
    appendHealthy(project);
    const queryPath = join(home, 'query.mjs');
    writeFileSync(queryPath, "return search('healthy sibling progressed');");
    const db = new DatabaseSync(dbPath);
    // Model a query after the recent-build debounce has elapsed, without a
    // wall-clock sleep or changing transcript/checkpoint evidence.
    db.prepare("UPDATE index_state SET mtime=0 WHERE jsonl_path='__last_build__'").run();
    db.close();
    const args = command === 'query' ? ['--query', queryPath] : ['--search', 'healthy sibling progressed'];
    const result = runCli(args, { home });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const hits = JSON.parse(result.stdout);
    assert.equal(hits.length, 1, 'the command actually refreshed and found the new sibling message');
    assert.ok(result.stderr.includes(future));
    assert.match(result.stderr, /Warning: skipped deepseek artifact .*Unsupported session format version 5/);
    const after = messagesAt(dbPath);
    assert.deepEqual(after.filter(row => row.text !== 'healthy sibling progressed'), before);
  });
}

for (const replacement of [false, true]) {
  test(`retention preserves tool rows, aggregates and searchable history (${replacement ? 'replacement' : 'in-place'})`, () => {
    const { home, project, provider } = fixture();
    const dbPath = join(home, 'index.sqlite');
    const options = { dbPath, DatabaseImpl: TestDatabase, providerRegistry: createProviderRegistry([provider]) };
    buildAppIndex(options);
    const canonical = path => {
      const db = new DatabaseSync(path);
      try {
        return Object.fromEntries(['messages', 'tool_calls', 'tool_results', 'sessions', 'summaries', 'subagents', 'workflows', 'workflow_agents']
          .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
      } finally { db.close(); }
    };
    const before = canonical(dbPath);
    assert.ok(before.tool_calls.length > 0 && before.tool_results.length > 0);
    publishFuture(project, 'v3-ptc');
    const target = replacement ? join(home, 'replacement.sqlite') : dbPath;
    const result = buildAppIndex({ ...options, dbPath: target, force: true, ...(replacement ? { preserveDbPath: dbPath } : {}) });
    assert.equal(result.complete, true);
    // Compare canonical values, independent of storage row order for rebuilt siblings.
    const order = rows => rows.map(row => JSON.stringify(row)).sort();
    const after = canonical(target);
    for (const table of Object.keys(before)) assert.deepEqual(order(after[table]), order(before[table]), table);
    const db = new DatabaseSync(target);
    assert.equal(createQueryApi(db).search('run the ptc script').length, 1);
    db.close();
  });
}

for (const version of [null, '4', -1, 1.5, { invalid: true }]) {
  test(`a malformed version ${JSON.stringify(version)} cannot certify a replacement snapshot`, () => {
    const { home, project, provider } = fixture();
    const dbPath = join(home, 'index.sqlite');
    const options = { dbPath, DatabaseImpl: TestDatabase, providerRegistry: createProviderRegistry([provider]) };
    buildAppIndex(options);
    const before = messagesAt(dbPath);
    publishFuture(project, 'v3-seeded-child', { version });
    const result = buildAppIndex({ ...options, force: true });
    assert.equal(result.complete, false);
    assert.equal(result.reason, 'incomplete_snapshot');
    assert.match(result.inventoryIssues[0].error, /Malformed session header/);
    assert.deepEqual(messagesAt(dbPath), before);
  });
}

test('a fresh database publishes healthy siblings without a partial future-format tree', () => {
  const { home, project, provider } = fixture();
  publishFuture(project, 'v3-seeded-child');
  const dbPath = join(home, 'index.sqlite');
  const result = buildAppIndex({ dbPath, DatabaseImpl: TestDatabase, providerRegistry: createProviderRegistry([provider]), force: true });
  assert.equal(result.complete, true);
  assert.equal(result.skipped, 1);
  const rows = messagesAt(dbPath);
  assert.ok(rows.length > 0);
  assert.ok(rows.every(row => !row.uuid.includes('v3-seeded-')));
});

test('a failed force publication rolls back both retained history and rebuilt siblings', () => {
  const { home, project, provider } = fixture();
  const dbPath = join(home, 'index.sqlite');
  const options = { dbPath, DatabaseImpl: TestDatabase, providerRegistry: createProviderRegistry([provider]) };
  buildAppIndex(options);
  const before = messagesAt(dbPath);
  publishFuture(project, 'v3-seeded-child');
  const failing = { ...provider, *parse(unit, cursor) {
    const next = yield* provider.parse(unit, cursor);
    throw new Error(`injected publication failure after ${next}`);
  } };
  const result = buildAppIndex({ ...options, force: true, providerRegistry: createProviderRegistry([failing]) });
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'provider_failure');
  assert.equal(result.skipped, 2, 'both the discovery skip and failed unit are reported');
  assert.deepEqual(messagesAt(dbPath), before);
  assert.equal(buildAppIndex({ ...options, force: true }).complete, true);
  assert.deepEqual(messagesAt(dbPath), before, 'restarting the complete publication converges');
});

test('an unavailable sessions root cannot delete last-good trees', () => {
  const { home, root, provider } = fixture();
  const dbPath = join(home, 'index.sqlite');
  const options = { dbPath, DatabaseImpl: TestDatabase, providerRegistry: createProviderRegistry([provider]) };
  buildAppIndex(options);
  const before = messagesAt(dbPath);
  rmSync(root, { recursive: true });
  assert.equal(buildAppIndex(options).complete, false);
  assert.equal(buildAppIndex({ ...options, force: true }).complete, false);
  assert.deepEqual(messagesAt(dbPath), before);
});

test('watch recovery replays every current and historical owner before publishing', () => {
  const { home, project, provider } = fixture();
  const dbPath = join(home, 'index.sqlite');
  const options = { dbPath, DatabaseImpl: TestDatabase, providerRegistry: createProviderRegistry([provider]) };
  buildAppIndex(options);
  const before = messagesAt(dbPath);
  const childPath = join(project, 'v3-seeded-child', 'session.v3.jsonl');
  const [header, ...body] = readFileSync(childPath, 'utf8').trimEnd().split('\n');
  const future = publishFuture(project, 'v3-seeded-parent');
  writeFileSync(childPath, [JSON.stringify({ ...JSON.parse(header), parentSession: 'v3-basic' }), ...body].join('\n') + '\n');
  buildAppIndex({ ...options, changedPaths: [future, childPath] });
  assert.deepEqual(messagesAt(dbPath), before);
  rmSync(future);
  assert.equal(buildAppIndex({ ...options, changedPaths: [future] }).complete, true);
  const after = messagesAt(dbPath);
  const childRows = after.filter(row => row.agent_id !== null);
  assert.equal(childRows.length, before.filter(row => row.agent_id !== null).length);
  assert.ok(childRows.every(row => row.session_id.includes('v3-basic')), 'the new owner is projected in the same recovery');
  const snapshotPath = join(home, 'fresh.sqlite');
  buildAppIndex({ ...options, dbPath: snapshotPath, force: true });
  assert.deepEqual(after, messagesAt(snapshotPath), 'watch recovery equals a complete source snapshot');
});

for (const destination of ['existing', 'new']) {
  for (const order of ['a-destination', 'z-destination']) {
    for (const failure of ['unfinished seed', 'divergent member', 'unreadable root']) {
      for (const mode of ['refresh', 'watch', 'marker replay']) {
        test(`ownership transfers publish atomically (${destination}, ${order}, ${failure}, ${mode})`, () => {
          const { home, root, project, provider } = fixture();
          const targetProject = join(root, '--destination--');
          const healthyProject = join(root, '--healthy--');
          mkdirSync(targetProject);
          mkdirSync(healthyProject);
          renameSync(join(project, 'v3-ptc'), join(healthyProject, 'v3-ptc'));
          const destinationDir = join(targetProject, order);
          if (destination === 'existing') renameSync(join(project, 'v3-basic'), destinationDir);
          const dbPath = join(home, 'index.sqlite');
          const options = { dbPath, providerRegistry: createProviderRegistry([provider]) };
          const initialOptions = mode === 'marker replay' ? {
            ...options, providerRegistry: createProviderRegistry([{ ...provider, indexVersionMarker: '__deepseek_canonical_transcript_v4__' }]),
          } : options;
          assert.equal(buildAppIndex(initialOptions).complete, true);
          const before = messagesAt(dbPath);
          if (destination === 'new') cpSync(join(FIXTURES, 'v3-basic'), destinationDir, { recursive: true });
          const destinationId = destination === 'new' ? 'new-destination' : 'v3-basic';
          const rootPath = join(destinationDir, 'session.v3.jsonl.zstd');
          // Use the real plain writer fixture for controlled header replacement.
          if (destination === 'new') {
            rmSync(rootPath);
            cpSync(join(FIXTURES, 'v3-ptc', 'session.v3.jsonl'), join(destinationDir, 'session.v3.jsonl'));
          }
          const activeRoot = destination === 'new' ? join(destinationDir, 'session.v3.jsonl') : rootPath;
          if (destination === 'new') {
            const [header, ...body] = readFileSync(activeRoot, 'utf8').trimEnd().split('\n');
            writeFileSync(activeRoot, [JSON.stringify({ ...JSON.parse(header), id: destinationId }), ...body].join('\n') + '\n');
          }
          const childDir = join(targetProject, 'v3-seeded-child');
          renameSync(join(project, 'v3-seeded-child'), childDir);
          const childPath = join(childDir, 'session.v3.jsonl');
          const [header, ...body] = readFileSync(childPath, 'utf8').trimEnd().split('\n');
          const durable = [JSON.stringify({ ...JSON.parse(header), parentSession: destinationId }), ...body].join('\n') + '\n';
          writeFileSync(childPath, durable);
          const rootBytes = readFileSync(activeRoot);
          const duplicate = join(targetProject, 'copy-child');
          if (failure === 'unfinished seed') writeFileSync(childPath, durable.split('\n')[0] + '\n');
          if (failure === 'divergent member') {
            cpSync(childDir, duplicate, { recursive: true });
            appendFileSync(join(duplicate, 'session.v3.jsonl'), '\n');
          }
          if (failure === 'unreadable root') writeFileSync(activeRoot, 'not a session header\n');
          const healthy = appendHealthy(healthyProject);
          for (let attempt = 0; attempt < 2; attempt++) {
            const result = buildAppIndex({ ...options, ...(mode === 'watch' ? { changedPaths: [childPath, healthy] } : {}) });
            assert.equal(result.complete, false, 'a withheld owner cannot certify the transfer complete');
            assert.deepEqual(messagesAt(dbPath).filter(row => row.text !== 'healthy sibling progressed'), before,
              'neither owner may publish part of a failed transfer');
            assert.equal(messagesAt(dbPath).filter(row => row.text === 'healthy sibling progressed').length, 1);
            assert.ok(result.affectedSessionIds.every(id => !id.includes('v3-seeded-parent') && !id.includes(destinationId)),
              'rolled-back or withheld owners emit no success notification');
          }
          writeFileSync(childPath, durable);
          writeFileSync(activeRoot, rootBytes);
          if (failure === 'divergent member') rmSync(duplicate, { recursive: true });
          const recovered = buildAppIndex({ ...options, changedPaths: [childPath, activeRoot] });
          assert.equal(recovered.complete, true);
          const childRows = messagesAt(dbPath).filter(row => row.agent_id !== null);
          assert.equal(childRows.length, before.filter(row => row.agent_id !== null).length);
          assert.ok(childRows.every(row => row.session_id.includes(destinationId)));
          const fresh = join(home, 'fresh.sqlite');
          assert.equal(buildAppIndex({ ...options, dbPath: fresh, force: true }).complete, true);
          assert.deepEqual(messagesAt(dbPath), messagesAt(fresh));
        });
      }
    }
  }
}

function canonicalAt(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Object.fromEntries(['sessions', 'messages', 'tool_calls', 'tool_results', 'summaries', 'subagents', 'workflows', 'workflow_agents']
      .map(table => [table, db.prepare(`SELECT * FROM ${table}`).all().map(row => JSON.stringify(row)).sort()]));
  } finally { db.close(); }
}

for (const command of ['query', 'search']) {
  test(`built CLI ${command} recovery rolls back a failed ownership set`, () => {
    const { home, project } = fixture();
    const initial = runCli(['--build'], { home });
    assert.equal(initial.status, 0, initial.stderr || initial.stdout);
    const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
    const before = messagesAt(dbPath);
    const future = publishFuture(project, 'v3-seeded-parent');
    assert.equal(runCli(['--build'], { home }).status, 0);
    const child = join(project, 'v3-seeded-child', 'session.v3.jsonl');
    const [header, ...body] = readFileSync(child, 'utf8').trimEnd().split('\n');
    const durable = [JSON.stringify({ ...JSON.parse(header), parentSession: 'v3-basic' }), ...body].join('\n') + '\n';
    writeFileSync(child, durable.split('\n')[0] + '\n');
    rmSync(future);
    appendHealthy(project);
    const query = join(home, 'query.mjs');
    writeFileSync(query, "return search('healthy sibling progressed');");
    const refresh = () => {
      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE index_state SET mtime=0 WHERE jsonl_path='__last_build__'").run();
      db.close();
      return runCli(command === 'query' ? ['--query', query] : ['--search', 'healthy sibling progressed'], { home });
    };
    const failed = refresh();
    assert.equal(failed.status, 0, failed.stderr || failed.stdout);
    assert.match(failed.stderr, /Seed marker is not durable/);
    assert.equal(JSON.parse(failed.stdout).length, 1);
    assert.deepEqual(messagesAt(dbPath).filter(row => row.text !== 'healthy sibling progressed'), before);
    writeFileSync(child, durable);
    assert.equal(refresh().status, 0);
    const recovered = canonicalAt(dbPath);
    const fresh = runCli(['--build'], { home });
    assert.equal(fresh.status, 0, fresh.stderr || fresh.stdout);
    assert.deepEqual(canonicalAt(dbPath), recovered);
    const after = new DatabaseSync(dbPath);
    assert.equal(after.prepare('SELECT count(*) n FROM index_state WHERE replay_required=1').get().n, 0);
    after.close();
  });
}

for (const evidence of ['missing checkpoint', 'foreign checkpoint', 'deleted old root']) {
  for (const mode of ['watch', 'force', 'replacement']) {
    test(`ownership recovery preserves canonical history (${evidence}, ${mode})`, () => {
      const { home, project, provider } = fixture();
      const dbPath = join(home, 'index.sqlite');
      const options = { dbPath, providerRegistry: createProviderRegistry([provider]) };
      assert.equal(buildAppIndex(options).complete, true);
      const before = canonicalAt(dbPath);
      const oldRoot = join(project, 'v3-seeded-parent', 'session.v3.jsonl');
      const childPath = join(project, 'v3-seeded-child', 'session.v3.jsonl');
      const [header, ...body] = readFileSync(childPath, 'utf8').trimEnd().split('\n');
      const durable = [JSON.stringify({ ...JSON.parse(header), parentSession: 'v3-basic' }), ...body].join('\n') + '\n';
      const db = new DatabaseSync(dbPath);
      if (evidence === 'missing checkpoint') db.prepare('DELETE FROM index_state WHERE jsonl_path=?').run(oldRoot);
      if (evidence === 'foreign checkpoint') {
        const foreign = db.prepare('SELECT cursor FROM index_state WHERE jsonl_path=?')
          .get(join(project, 'v3-basic', 'session.v3.jsonl.zstd')).cursor;
        db.prepare('UPDATE index_state SET cursor=? WHERE jsonl_path=?').run(foreign, oldRoot);
      }
      db.close();
      if (evidence === 'deleted old root') rmSync(join(project, 'v3-seeded-parent'), { recursive: true });
      writeFileSync(childPath, durable.split('\n')[0] + '\n');
      const target = mode === 'replacement' ? join(home, 'replacement.sqlite') : dbPath;
      const next = { ...options, dbPath: target };
      const failed = buildAppIndex({ ...next, force: mode !== 'watch',
        ...(mode === 'replacement' ? { preserveDbPath: dbPath } : { changedPaths: [childPath] }) });
      assert.equal(failed.complete, false);
      // Replacement publication never swaps a failed target into place.
      assert.deepEqual(canonicalAt(dbPath), before);
      writeFileSync(childPath, durable);
      const recovered = buildAppIndex({ ...next, force: mode !== 'watch',
        ...(mode === 'replacement' ? { preserveDbPath: dbPath } : { changedPaths: [childPath] }) });
      assert.equal(recovered.complete, true);
      const fresh = join(home, 'fresh.sqlite');
      assert.equal(buildAppIndex({ ...options, dbPath: fresh, force: true }).complete, true);
      assert.deepEqual(canonicalAt(target), canonicalAt(fresh), 'all canonical tables converge after transfer');
      const after = new DatabaseSync(target);
      assert.equal(after.prepare('SELECT count(*) n FROM index_state WHERE replay_required=1').get().n, 0);
      after.close();
    });
  }
}

for (const layout of ['same directory', 'moved directory', 'reused directory']) {
  for (const mode of ['watch', 'force', 'replacement']) {
    test(`adopting an indexed root retires its standalone identity only after success (${layout}, ${mode})`, () => {
      const { home, project, provider } = fixture();
      const dbPath = join(home, 'index.sqlite');
      const options = { dbPath, providerRegistry: createProviderRegistry([provider]) };
      assert.equal(buildAppIndex(options).complete, true);
      const before = canonicalAt(dbPath);
      const oldDir = join(project, 'v3-ptc');
      const adoptedDir = layout === 'same directory' ? oldDir : join(project, 'moved-ptc');
      if (adoptedDir !== oldDir) renameSync(oldDir, adoptedDir);
      if (layout === 'reused directory') {
        cpSync(join(FIXTURES, 'v3-ptc'), oldDir, { recursive: true });
        const replacement = join(oldDir, 'session.v3.jsonl');
        const [first, ...rest] = readFileSync(replacement, 'utf8').trimEnd().split('\n');
        writeFileSync(replacement, [JSON.stringify({ ...JSON.parse(first), id: 'replacement-root' }), ...rest].join('\n') + '\n');
      }
      const adopted = join(adoptedDir, 'session.v3.jsonl');
      const originalRoot = readFileSync(adopted, 'utf8');
      const [header, ...body] = readFileSync(adopted, 'utf8').trimEnd().split('\n');
      writeFileSync(adopted, [JSON.stringify({ ...JSON.parse(header), parentSession: 'v3-seeded-parent' }), ...body].join('\n') + '\n');
      const seed = join(project, 'v3-seeded-child', 'session.v3.jsonl');
      const durable = readFileSync(seed, 'utf8');
      writeFileSync(seed, durable.split('\n')[0] + '\n');
      const target = mode === 'replacement' ? join(home, 'replacement.sqlite') : dbPath;
      const build = () => buildAppIndex({ ...options, dbPath: target, force: mode !== 'watch',
        ...(mode === 'replacement' ? { preserveDbPath: dbPath } : { changedPaths: [adopted] }) });
      assert.equal(build().complete, false);
      const withoutReplacement = snapshot => Object.fromEntries(Object.entries(snapshot)
        .map(([table, rows]) => [table, rows.filter(row => !row.includes('deepseek:replacement-root:'))]));
      assert.deepEqual(withoutReplacement(canonicalAt(dbPath)), before);
      writeFileSync(seed, durable);
      const recovered = build();
      assert.equal(recovered.complete, true);
      assert.ok(recovered.affectedSessionIds.some(id => id.startsWith('deepseek:v3-ptc:')), 'retired roots notify consumers');
      const fresh = join(home, 'fresh.sqlite');
      assert.equal(buildAppIndex({ ...options, dbPath: fresh, force: true }).complete, true);
      assert.deepEqual(canonicalAt(target), canonicalAt(fresh), 'no standalone ghost or duplicate aggregate remains');
      const after = new DatabaseSync(target);
      assert.equal(after.prepare('SELECT count(*) n FROM index_state WHERE replay_required=1').get().n, 0);
      if (layout === 'reused directory') {
        const cursor = after.prepare('SELECT cursor FROM index_state WHERE jsonl_path=?').get(join(oldDir, 'session.v3.jsonl')).cursor;
        assert.ok(JSON.parse(Buffer.from(cursor.split(':')[2], 'base64url').toString()).sessionId.startsWith('deepseek:replacement-root:'));
      }
      after.close();
      // A former root may become independent again. Its old pre-adoption cursor
      // must not certify rows that were retired while it belonged to the parent.
      writeFileSync(adopted, originalRoot);
      assert.equal(buildAppIndex({ ...options, dbPath: target, changedPaths: [adopted] }).complete, true);
      const independent = join(home, 'independent.sqlite');
      assert.equal(buildAppIndex({ ...options, dbPath: independent, force: true }).complete, true);
      assert.deepEqual(canonicalAt(target), canonicalAt(independent), 'adoption followed by independence replays complete history');
    });
  }
}

// Controlled replacement boundary, as in cross-tree recovery above: released
// DSH headers are immutable; this models replacement of ancestry plus a future
// envelope changing scope, not a normal append by the current writer.
function replaceChildParentWithFutureRoot(project, rootName) {
  cpSync(join(FIXTURES, 'v3-ptc'), join(project, rootName), { recursive: true });
  const rootPath = join(project, rootName, 'session.v3.jsonl');
  const [rootHeader, ...rootBody] = readFileSync(rootPath, 'utf8').trimEnd().split('\n');
  writeFileSync(rootPath, [JSON.stringify({ ...JSON.parse(rootHeader), id: rootName }), ...rootBody].join('\n') + '\n');
  const future = publishFuture(project, rootName, { cwd: '/future-scope' });
  const childPath = join(project, 'v3-seeded-child', 'session.v3.jsonl');
  const [childHeader, ...childBody] = readFileSync(childPath, 'utf8').trimEnd().split('\n');
  writeFileSync(childPath, [JSON.stringify({ ...JSON.parse(childHeader), parentSession: rootName }), ...childBody].join('\n') + '\n');
  return { future, rootPath };
}

for (const rootName of ['a-new-parent', 'z-new-parent']) {
  for (const mode of ['refresh', 'watch', 'force', 'replacement']) {
    test(`a rootless group cannot release last-good child history (${rootName}, ${mode})`, () => {
      const { home, root, project } = fixture();
      const roots = Object.fromEntries(createBuiltinProviderRegistry().catalog()
        .map(provider => [provider.id, join(home, 'empty', provider.id)]));
      roots.deepseek = root;
      const dbPath = join(home, 'index.sqlite');
      const options = { dbPath, providerRoots: roots };
      assert.equal(buildAppIndex(options).complete, true);
      const before = messagesAt(dbPath);
      const parentKey = join(project, 'v3-seeded-parent', 'session.v3.jsonl');
      const initialDb = new DatabaseSync(dbPath);
      const checkpoint = initialDb.prepare('SELECT cursor FROM index_state WHERE jsonl_path=?').get(parentKey).cursor;
      initialDb.close();
      const { future, rootPath } = replaceChildParentWithFutureRoot(project, rootName);
      const healthy = appendHealthy(project);
      const target = mode === 'replacement' ? join(home, 'replacement.sqlite') : dbPath;
      const nextOptions = { ...options, dbPath: target };
      const result = buildAppIndex({
        ...nextOptions, force: mode === 'force' || mode === 'replacement',
        ...(mode === 'replacement' ? { preserveDbPath: dbPath } : {}),
        ...(mode === 'watch' ? { changedPaths: [future, healthy] } : {}),
      });
      assert.equal(result.complete, true);
      assert.equal(result.skipped, 1);
      assert.equal(result.skippedFiles[0].path, future);
      const retained = messagesAt(target);
      assert.deepEqual(retained.filter(row => row.text !== 'healthy sibling progressed'), before,
        'a member without a publishable root cannot certify its historical owner complete');
      assert.equal(retained.filter(row => row.text === 'healthy sibling progressed').length, 1);
      const db = new DatabaseSync(target);
      const state = db.prepare('SELECT cursor,replay_required FROM index_state WHERE jsonl_path=?').get(parentKey);
      assert.equal(state.cursor, checkpoint);
      assert.equal(state.replay_required, 1);
      db.close();
      if (mode === 'replacement') assert.deepEqual(messagesAt(dbPath), before);
      rmSync(future);
      const recovered = buildAppIndex({ ...nextOptions, ...(mode === 'watch' ? { changedPaths: [future] } : {}) });
      assert.equal(recovered.complete, true);
      assert.equal(recovered.skipped, 0);
      const recoveredDb = new DatabaseSync(target);
      const owner = recoveredDb.prepare('SELECT id FROM sessions WHERE jsonl_path=?').get(rootPath).id;
      const childRows = messagesAt(target).filter(row => row.agent_id !== null);
      assert.equal(childRows.length, before.filter(row => row.agent_id !== null).length);
      assert.ok(childRows.every(row => row.session_id === owner), 'the child is published under its recovered owner');
      assert.equal(recoveredDb.prepare('SELECT replay_required FROM index_state WHERE jsonl_path=?').get(parentKey).replay_required, 0);
      recoveredDb.close();
      const fresh = join(home, 'fresh.sqlite');
      assert.equal(buildAppIndex({ ...nextOptions, dbPath: fresh, force: true }).complete, true);
      assert.deepEqual(messagesAt(target), messagesAt(fresh));
    });
  }
}

test('CLI rebuild retains children whose current scoped group has no root', () => {
  const { home, project } = fixture();
  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
  const initial = runCli(['--build'], { home });
  assert.equal(initial.status, 0, initial.stderr || initial.stdout);
  const before = messagesAt(dbPath);
  const { future } = replaceChildParentWithFutureRoot(project, 'new-parent');
  appendHealthy(project);
  const result = runCli(['--build'], { home });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).ok, true);
  assert.ok(result.stderr.includes(future));
  const after = messagesAt(dbPath);
  assert.deepEqual(after.filter(row => row.text !== 'healthy sibling progressed'), before);
  assert.equal(after.filter(row => row.text === 'healthy sibling progressed').length, 1);
});

test('desktop replacement retains history with the production SQLite binding', () => {
  const { home, project, provider } = fixture();
  const dbPath = join(home, 'old.sqlite');
  const options = { dbPath, providerRegistry: createProviderRegistry([provider]) };
  assert.equal(buildAppIndex(options).complete, true);
  const before = messagesAt(dbPath);
  publishFuture(project, 'v3-seeded-child');
  const target = join(home, 'replacement.sqlite');
  const result = buildAppIndex({ ...options, dbPath: target, preserveDbPath: dbPath, force: true });
  assert.equal(result.complete, true);
  assert.equal(result.skipped, 1);
  assert.deepEqual(messagesAt(target), before);
  assert.deepEqual(messagesAt(dbPath), before, 'the source connection is read-only');
});

for (const direction of ['alias to real', 'real to alias']) {
  for (const mode of ['refresh', 'watch', 'force', 'replacement']) {
    test(`changing a source path alias retains future-format child history (${direction}, ${mode})`, () => {
      const { home, root, project } = fixture();
      const alias = join(home, 'sessions-alias');
      symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const [initialRoot, nextRoot] = direction === 'alias to real' ? [alias, root] : [root, alias];
      const isolatedRoots = Object.fromEntries(createBuiltinProviderRegistry().catalog()
        .map(provider => [provider.id, join(home, 'empty', provider.id)]));
      const dbPath = join(home, 'index.sqlite');
      const options = { dbPath, providerRoots: { ...isolatedRoots, deepseek: initialRoot } };
      assert.equal(buildAppIndex(options).complete, true);
      const before = messagesAt(dbPath);
      assert.ok(before.some(row => row.agent_id !== null));
      const future = publishFuture(project, 'v3-seeded-child', { cwd: '/future-scope' });
      const oldChild = join(project, 'v3-seeded-child', 'session.v3.jsonl');
      // Replacement also covers a migration that removed the old generation.
      if (mode === 'replacement') rmSync(oldChild);
      const healthy = appendHealthy(project);
      const target = mode === 'replacement' ? join(home, 'replacement.sqlite') : dbPath;
      const nextOptions = { ...options, dbPath: target, providerRoots: { ...isolatedRoots, deepseek: nextRoot } };
      const result = buildAppIndex({
        ...nextOptions,
        force: mode === 'force' || mode === 'replacement',
        ...(mode === 'replacement' ? { preserveDbPath: dbPath } : {}),
        ...(mode === 'watch' ? { changedPaths: [future, healthy] } : {}),
      });
      assert.equal(result.complete, true);
      assert.equal(result.skipped, 1);
      const after = messagesAt(target);
      assert.deepEqual(after.filter(row => row.text !== 'healthy sibling progressed'), before,
        'the full last-good tree survives either spelling of the same source');
      assert.equal(after.filter(row => row.text === 'healthy sibling progressed').length, 1,
        'retention must not suppress the healthy sibling');
      if (mode === 'replacement') assert.deepEqual(messagesAt(dbPath), before);
      if (mode === 'replacement') cpSync(join(FIXTURES, 'v3-seeded-child', 'session.v3.jsonl'), oldChild);
      rmSync(future);
      const recovered = buildAppIndex(nextOptions);
      assert.equal(recovered.complete, true);
      assert.equal(recovered.skipped, 0);
      assert.deepEqual(messagesAt(target), after, 'recovery does not duplicate or lose messages');
    });
  }
}

for (const relocation of ['rebound alias', 'relocated tree', 'relocated child']) {
  for (const changedId of [false, true]) {
    for (const mode of ['refresh', 'watch', 'force', 'replacement']) {
      test(`historical ownership survives namespace reuse (${relocation}, ${changedId ? 'changed identity' : 'changed scope'}, ${mode})`, () => {
        const { home, root, project } = fixture();
        const movedProject = join(root, '--relocated--');
        const alias = join(home, 'sessions-alias');
        const isMove = relocation !== 'rebound alias';
        if (isMove) {
          mkdirSync(movedProject);
          renameSync(join(project, 'v3-ptc'), join(movedProject, 'v3-ptc'));
        } else {
          symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
        }
        const initialRoot = isMove ? root : alias;
        const isolatedRoots = Object.fromEntries(createBuiltinProviderRegistry().catalog()
          .map(provider => [provider.id, join(home, 'empty', provider.id)]));
        const dbPath = join(home, 'index.sqlite');
        const options = { dbPath, providerRoots: { ...isolatedRoots, deepseek: initialRoot } };
        assert.equal(buildAppIndex(options).complete, true);
        const before = messagesAt(dbPath);
        const oldParentKey = join(initialRoot, '--dsh-v3--', 'v3-seeded-parent', 'session.v3.jsonl');
        const initialDb = new DatabaseSync(dbPath);
        const checkpoint = initialDb.prepare('SELECT cursor FROM index_state WHERE jsonl_path=?').get(oldParentKey).cursor;
        initialDb.close();
        if (isMove) {
          const movedMembers = relocation === 'relocated tree'
            ? ['v3-seeded-parent', 'v3-seeded-child'] : ['v3-seeded-child'];
          for (const member of movedMembers) {
            renameSync(join(project, member), join(movedProject, member));
          }
          rmSync(join(project, 'v3-basic'), { recursive: true });
        } else {
          rmSync(alias);
          const other = join(home, 'other-sessions');
          mkdirSync(join(other, '--dsh-v3--'), { recursive: true });
          symlinkSync(other, alias, process.platform === 'win32' ? 'junction' : 'dir');
        }
        const currentProject = isMove ? movedProject : project;
        const future = publishFuture(currentProject, 'v3-seeded-child', {
          cwd: '/future-scope', ...(changedId ? { id: 'future-child' } : {}),
        });
        const oldChild = join(currentProject, 'v3-seeded-child', 'session.v3.jsonl');
        if (mode === 'replacement') rmSync(oldChild);
        const healthy = appendHealthy(currentProject);
        const target = mode === 'replacement' ? join(home, 'replacement.sqlite') : dbPath;
        const nextOptions = { ...options, dbPath: target, providerRoots: { ...isolatedRoots, deepseek: root } };
        const result = buildAppIndex({
          ...nextOptions,
          force: mode === 'force' || mode === 'replacement',
          ...(mode === 'replacement' ? { preserveDbPath: dbPath } : {}),
          ...(mode === 'watch' ? { changedPaths: [future, healthy] } : {}),
        });
        assert.equal(result.complete, true);
        assert.equal(result.skipped, 1);
        const after = messagesAt(target);
        const expected = before;
        assert.deepEqual(after.filter(row => row.text !== 'healthy sibling progressed'), expected,
          'a present historical directory cannot authorize a partial-tree replacement');
        assert.equal(after.filter(row => row.text === 'healthy sibling progressed').length, 1,
          'a healthy sibling in the current project must continue publishing');
        const db = new DatabaseSync(target);
        const retained = db.prepare('SELECT cursor, replay_required FROM index_state WHERE jsonl_path=?').get(oldParentKey);
        assert.equal(retained.cursor, checkpoint);
        assert.equal(retained.replay_required, 1);
        db.close();
        if (mode === 'replacement') {
          assert.deepEqual(messagesAt(dbPath), before);
          cpSync(join(FIXTURES, 'v3-seeded-child', 'session.v3.jsonl'), oldChild);
        }
        rmSync(future);
        assert.equal(buildAppIndex(nextOptions).complete, true);
        const recovered = isMove ? after.filter(row => !row.session_id.startsWith('deepseek:v3-basic:')) : after;
        assert.deepEqual(messagesAt(target), recovered, 'recovery publishes the full tree and retires proven deletions');
        const fresh = join(home, 'fresh.sqlite');
        assert.equal(buildAppIndex({ ...nextOptions, dbPath: fresh, force: true }).complete, true);
        assert.deepEqual(messagesAt(target), messagesAt(fresh));
      });
    }
  }
}

for (const rootSpelling of ['alias', 'rebound real path', 'replaced directory']) {
  for (const mode of ['refresh', 'watch', 'force', 'replacement']) {
    test(`a rebound configured namespace is not historical deletion evidence (${rootSpelling}, ${mode})`, () => {
      const { home, root, project } = fixture();
      const alias = join(home, 'sessions-alias');
      symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const isolatedRoots = Object.fromEntries(createBuiltinProviderRegistry().catalog()
        .map(provider => [provider.id, join(home, 'empty', provider.id)]));
      const dbPath = join(home, 'index.sqlite');
      const options = { dbPath, providerRoots: { ...isolatedRoots, deepseek: alias } };
      assert.equal(buildAppIndex(options).complete, true);
      const before = messagesAt(dbPath);
      const other = join(home, 'other-sessions');
      const otherProject = join(other, '--dsh-v3--');
      mkdirSync(otherProject, { recursive: true });
      cpSync(join(project, 'v3-seeded-child'), join(otherProject, 'relocated-future'), { recursive: true });
      cpSync(join(project, 'v3-ptc'), join(otherProject, 'v3-ptc'), { recursive: true });
      publishFuture(otherProject, 'relocated-future', { id: 'future-child', cwd: '/future-scope' });
      rmSync(alias);
      if (rootSpelling === 'replaced directory') renameSync(other, alias);
      else symlinkSync(other, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const currentProject = rootSpelling === 'replaced directory' ? join(alias, '--dsh-v3--') : otherProject;
      const future = join(currentProject, 'relocated-future', 'session.v5.jsonl');
      const healthy = appendHealthy(currentProject);
      const target = mode === 'replacement' ? join(home, 'replacement.sqlite') : dbPath;
      const nextOptions = {
        ...options, dbPath: target,
        providerRoots: { ...isolatedRoots, deepseek: rootSpelling === 'rebound real path' ? other : alias },
      };
      const result = buildAppIndex({
        ...nextOptions, force: mode === 'force' || mode === 'replacement',
        ...(mode === 'replacement' ? { preserveDbPath: dbPath } : {}),
        ...(mode === 'watch' ? { changedPaths: [realpathSync(future), realpathSync(healthy)] } : {}),
      });
      assert.equal(result.complete, true);
      assert.equal(result.skipped, 1);
      const after = messagesAt(target);
      assert.deepEqual(after.filter(row => row.text !== 'healthy sibling progressed'), before,
        'the original physical namespace was excluded, not proven absent');
      assert.equal(after.filter(row => row.text === 'healthy sibling progressed').length, 1);
      if (mode === 'replacement') assert.deepEqual(messagesAt(dbPath), before);
      // Reinclude the original source: retained debt must replay its complete tree.
      rmSync(future);
      const recoveredOptions = { ...nextOptions, providerRoots: { ...isolatedRoots, deepseek: root } };
      assert.equal(buildAppIndex(recoveredOptions).complete, true);
      const fresh = join(home, 'fresh.sqlite');
      assert.equal(buildAppIndex({ ...recoveredOptions, dbPath: fresh, force: true }).complete, true);
      assert.deepEqual(messagesAt(target), messagesAt(fresh));
    });
  }
}

for (const force of [false, true]) {
  test(`a future native-id collision does not freeze an intact scoped sibling (${force ? 'force' : 'watch'})`, () => {
    const { home, root, project, provider } = fixture();
    const dbPath = join(home, 'index.sqlite');
    const options = { dbPath, providerRegistry: createProviderRegistry([provider]) };
    assert.equal(buildAppIndex(options).complete, true);
    const before = messagesAt(dbPath);
    const other = join(root, '--future-peer--');
    mkdirSync(other);
    cpSync(join(FIXTURES, 'v3-ptc'), join(other, 'v3-ptc'), { recursive: true });
    const future = publishFuture(other, 'v3-ptc', { cwd: '/different-project' });
    const healthy = appendHealthy(project);
    const result = buildAppIndex({ ...options, force, changedPaths: [future, healthy] });
    assert.equal(result.complete, true);
    assert.equal(result.skipped, 1);
    const after = messagesAt(dbPath);
    assert.deepEqual(after.filter(row => row.text !== 'healthy sibling progressed'), before);
    assert.equal(after.filter(row => row.text === 'healthy sibling progressed').length, 1,
      'a native id shared across scopes is not proof of a missing historical member');
  });
}

test('a source alias still protects the project when historical membership is unavailable', () => {
  const { home, root, project } = fixture();
  const alias = join(home, 'sessions-alias');
  symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const dbPath = join(home, 'index.sqlite');
  const options = { dbPath, providerRegistry: createProviderRegistry([createDeepseekProvider({ rootDir: alias })]) };
  assert.equal(buildAppIndex(options).complete, true);
  const before = messagesAt(dbPath);
  const db = new DatabaseSync(dbPath);
  db.prepare('UPDATE index_state SET cursor=NULL WHERE jsonl_path=?')
    .run(join(alias, '--dsh-v3--', 'v3-seeded-parent', 'session.v3.jsonl'));
  db.close();
  publishFuture(project, 'v3-seeded-child', { cwd: '/future-scope' });
  const result = buildAppIndex({
    ...options, force: true,
    providerRegistry: createProviderRegistry([createDeepseekProvider({ rootDir: root })]),
  });
  assert.equal(result.complete, true);
  assert.equal(result.skipped, 1);
  assert.deepEqual(messagesAt(dbPath), before, 'unknown historical ownership uses the same physical project');
});

test('a reused unit key cannot certify another retained identity\'s historical membership', () => {
  const { home, root, project, provider } = fixture();
  const dbPath = join(home, 'index.sqlite');
  const options = { dbPath, providerRegistry: createProviderRegistry([provider]) };
  assert.equal(buildAppIndex(options).complete, true);
  const parent = join(project, 'v3-seeded-parent', 'session.v3.jsonl');
  const [header, ...body] = readFileSync(parent, 'utf8').trimEnd().split('\n');
  writeFileSync(parent, [JSON.stringify({ ...JSON.parse(header), id: 'replacement-parent' }), ...body].join('\n') + '\n');
  const pending = join(root, '--pending--', 'pending');
  mkdirSync(pending, { recursive: true });
  writeFileSync(join(pending, 'session.v3.jsonl'), '');
  assert.equal(buildAppIndex(options).complete, false);
  const before = messagesAt(dbPath);
  assert.ok(before.some(row => row.session_id.startsWith('deepseek:v3-seeded-parent:')));
  assert.ok(before.some(row => row.session_id.startsWith('deepseek:replacement-parent:')),
    'incomplete inventory deferred retirement while the reused key indexed the new root');
  rmSync(join(root, '--pending--'), { recursive: true });
  const future = publishFuture(project, 'v3-seeded-child', { id: 'future-child', cwd: '/future-scope' });
  const retained = buildAppIndex({ ...options, force: true });
  assert.equal(retained.complete, true);
  assert.equal(retained.skipped, 1);
  assert.deepEqual(messagesAt(dbPath), before,
    'a checkpoint from the replacement root is not evidence about the old tree');
  rmSync(future);
  assert.equal(buildAppIndex(options).complete, true);
  const fresh = join(home, 'fresh.sqlite');
  assert.equal(buildAppIndex({ ...options, dbPath: fresh, force: true }).complete, true);
  assert.deepEqual(messagesAt(dbPath), messagesAt(fresh));
});

for (const futureSession of ['v3-seeded-child', 'v3-seeded-parent', 'v3-ptc']) {
  test(`removing an old source alias preserves the last-good tree (${futureSession})`, () => {
    const { home, root, project } = fixture();
    const alias = join(home, 'sessions-alias');
    symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const dbPath = join(home, 'index.sqlite');
    const options = { dbPath, providerRegistry: createProviderRegistry([createDeepseekProvider({ rootDir: alias })]) };
    assert.equal(buildAppIndex(options).complete, true);
    const before = messagesAt(dbPath);
    publishFuture(project, futureSession, { cwd: '/future-scope' });
    rmSync(alias);
    const result = buildAppIndex({
      ...options, force: true,
      providerRegistry: createProviderRegistry([createDeepseekProvider({ rootDir: root })]),
    });
    assert.equal(result.complete, true);
    assert.equal(result.skipped, 1);
    assert.deepEqual(messagesAt(dbPath), before, 'an unresolvable historical namespace needs conservative retention');
  });
}

test('replay retracts the old root identity using historical evidence', () => {
  const { home, project, provider } = fixture();
  const dbPath = join(home, 'index.sqlite');
  const options = { dbPath, DatabaseImpl: TestDatabase, providerRegistry: createProviderRegistry([provider]) };
  buildAppIndex(options);
  const future = publishFuture(project, 'v3-ptc');
  buildAppIndex(options);
  rmSync(future);
  const root = join(project, 'v3-ptc', 'session.v3.jsonl');
  const [header, ...body] = readFileSync(root, 'utf8').trimEnd().split('\n');
  writeFileSync(root, [JSON.stringify({ ...JSON.parse(header), id: 'renamed-root' }), ...body].join('\n') + '\n');
  assert.equal(buildAppIndex({ ...options, changedPaths: [future] }).complete, true);
  const db = new DatabaseSync(dbPath);
  assert.equal(db.prepare("SELECT count(*) n FROM sessions WHERE id LIKE 'deepseek:v3-ptc:%'").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM sessions WHERE id LIKE 'deepseek:renamed-root:%'").get().n, 1);
  db.close();
  const snapshotPath = join(home, 'fresh.sqlite');
  buildAppIndex({ ...options, dbPath: snapshotPath, force: true });
  assert.deepEqual(messagesAt(dbPath), messagesAt(snapshotPath));
});

for (const mode of ['refresh', 'force', 'marker replay']) {
  test(`moving a live identity and reusing its old directory preserves both roots (${mode})`, () => {
    const { home, project, provider } = fixture();
    const dbPath = join(home, 'index.sqlite');
    const options = { dbPath, DatabaseImpl: TestDatabase, providerRegistry: createProviderRegistry([provider]) };
    const seed = mode === 'marker replay' ? { ...options, providerRegistry: createProviderRegistry([{ ...provider, indexVersionMarker: '__deepseek_canonical_transcript_v4__' }]) } : options;
    buildAppIndex(seed);
    const old = join(project, 'v3-ptc');
    renameSync(old, join(project, 'a-moved'));
    cpSync(join(FIXTURES, 'v3-ptc'), old, { recursive: true });
    const path = join(old, 'session.v3.jsonl');
    const [header, ...body] = readFileSync(path, 'utf8').trimEnd().split('\n');
    writeFileSync(path, [JSON.stringify({ ...JSON.parse(header), id: 'replacement-root' }), ...body].join('\n') + '\n');
    assert.equal(buildAppIndex({ ...options, force: mode === 'force' }).complete, true);
    const db = new DatabaseSync(dbPath);
    assert.equal(db.prepare("SELECT count(*) n FROM sessions WHERE id LIKE 'deepseek:v3-ptc:%'").get().n, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM sessions WHERE id LIKE 'deepseek:replacement-root:%'").get().n, 1);
    db.close();
    const fresh = join(home, 'fresh.sqlite');
    buildAppIndex({ ...options, dbPath: fresh, force: true });
    assert.deepEqual(messagesAt(dbPath), messagesAt(fresh));
  });
}

for (const force of [false, true]) {
  test(`an identity race after discovery preserves last-good until a stable retry (${force ? 'force' : 'marker replay'})`, () => {
    const { home, project, provider } = fixture();
    const dbPath = join(home, 'index.sqlite');
    const options = { dbPath, DatabaseImpl: TestDatabase, providerRegistry: createProviderRegistry([provider]) };
    buildAppIndex({ ...options, providerRegistry: createProviderRegistry([{ ...provider, indexVersionMarker: '__deepseek_canonical_transcript_v4__' }]) });
    const before = messagesAt(dbPath);
    const path = join(project, 'v3-ptc', 'session.v3.jsonl');
    const [header, ...body] = readFileSync(path, 'utf8').trimEnd().split('\n');
    writeFileSync(path, [JSON.stringify({ ...JSON.parse(header), id: 'replacement-root' }), ...body].join('\n') + '\n');
    let raced = false;
    const racy = { ...provider, *parse(unit, cursor) {
      if (!raced && unit.key === path) {
        raced = true;
        writeFileSync(path, [JSON.stringify({ ...JSON.parse(header), id: 'raced-root' }), ...body].join('\n') + '\n');
      }
      return yield* provider.parse(unit, cursor);
    } };
    const result = buildAppIndex({ ...options, force, providerRegistry: createProviderRegistry([racy]) });
    assert.equal(result.complete, false);
    assert.equal(result.skipped, 1);
    assert.match(result.skippedFiles[0].error, /changed after discovery/);
    assert.deepEqual(messagesAt(dbPath), before);
    assert.equal(buildAppIndex({ ...options, force }).complete, true);
    const fresh = join(home, 'fresh.sqlite');
    buildAppIndex({ ...options, dbPath: fresh, force: true });
    assert.deepEqual(messagesAt(dbPath), messagesAt(fresh));
  });
}

test('a not-yet-durable seed cannot replace an existing force snapshot', () => {
  const { home, project, provider } = fixture();
  const dbPath = join(home, 'index.sqlite');
  const options = { dbPath, DatabaseImpl: TestDatabase, providerRegistry: createProviderRegistry([provider]) };
  buildAppIndex(options);
  const before = messagesAt(dbPath);
  const path = join(project, 'v3-seeded-child', 'session.v3.jsonl');
  const original = readFileSync(path, 'utf8');
  writeFileSync(path, original.split('\n', 1)[0] + '\n');
  const result = buildAppIndex({ ...options, force: true });
  assert.equal(result.complete, false);
  assert.match(result.skippedFiles[0].error, /Seed marker is not durable/);
  assert.deepEqual(messagesAt(dbPath), before);
  writeFileSync(path, original);
  assert.equal(buildAppIndex({ ...options, force: true }).complete, true);
  assert.deepEqual(messagesAt(dbPath), before);
});

test('v4 tool failures remain visible beside an unsupported v5 tree', () => {
  const { home, root, project, provider } = fixture();
  const v4 = fileURLToPath(new URL('./fixtures/deepseek/sessions/--dsh-v4--/v4-failed-tool', import.meta.url));
  cpSync(v4, join(root, '--dsh-v4--', 'v4-failed-tool'), { recursive: true });
  publishFuture(project, 'v3-seeded-child');
  const dbPath = join(home, 'index.sqlite');
  const result = buildAppIndex({ dbPath, DatabaseImpl: TestDatabase, providerRegistry: createProviderRegistry([provider]), force: true });
  assert.equal(result.complete, true);
  assert.equal(result.skipped, 1);
  const db = new DatabaseSync(dbPath);
  assert.equal(db.prepare("SELECT count(*) n FROM tool_results WHERE is_error=1 AND session_id LIKE 'deepseek:v4-%'").get().n, 1);
  db.close();
});
