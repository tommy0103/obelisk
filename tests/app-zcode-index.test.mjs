// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// zcode provider end-to-end and semantic tests.
//
// The corpus fixture is the sanitized real-model aggregate (17 sessions, 0022
// schema) documented in tests/fixtures/zcode/README.md. Synthetic databases
// are built inline for targeted semantics (dual-shape model identity, rewind
// visibility, fingerprint change detection) — the adapter reads only the
// session/message/part tables, so a minimal schema is faithful for those
// paths.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildIndex } from '../app/src/main/indexer.ts';
import { createZcodeProvider } from '../packages/core/src/providers/zcode.ts';
import { persist } from '../packages/core/src/persist.ts';
import { assembleSessionDetail } from '../packages/core/src/session-detail.ts';
import { runCli } from './cli-test-helpers.mjs';
import { makeTempDir } from './temp-dirs.mjs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const AGGREGATE = new URL('./fixtures/zcode/zcode-real-aggregate.sqlite', import.meta.url);

const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}

function drain(records) {
  const values = [];
  for (const record of records) values.push(record);
  return values;
}

class TestDatabase {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
  }
  pragma(statement) { this.db.exec(`PRAGMA ${statement}`); }
  exec(sql) { return this.db.exec(sql); }
  prepare(sql) { return this.db.prepare(sql); }
  close() { return this.db.close(); }
}

function seedSource(home, fixture = AGGREGATE) {
  const dir = join(home, '.zcode', 'cli', 'db');
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'db.sqlite');
  copyFileSync(fixture, dbPath);
  return dbPath;
}

function build(home, { changedPaths, force } = {}) {
  return buildIndex({
    claudeDir: join(home, '.claude'),
    providerRoots: { zcode: join(home, '.zcode', 'cli') },
    dbPath: join(home, '.obelisk', 'obelisk.sqlite'),
    DatabaseImpl: TestDatabase,
    changedPaths,
    force,
  });
}

function openIndex(home) {
  return new TestDatabase(join(home, '.obelisk', 'obelisk.sqlite'));
}

// The aggregate's session ids all share one db-instance discriminator; find
// them by source.
function zcodeSessions(db) {
  return db.prepare("SELECT * FROM sessions WHERE source='zcode' ORDER BY id").all();
}

test('real-model aggregate indexes end to end: sessions, messages, tools, subagents', () => {
  const home = makeTempDir('obelisk-zcode-index-');
  seedSource(home);
  const result = build(home);
  assert.ok(result.complete, `inventory complete: ${JSON.stringify(result.inventoryIssues)}`);

  const db = openIndex(home);
  const sessions = zcodeSessions(db);
  assert.equal(sessions.length, 17, 'all seventeen source sessions indexed');

  const messages = db.prepare("SELECT COUNT(*) c FROM messages WHERE source='zcode'").get().c;
  assert.ok(messages > 80, `messages indexed (${messages})`);

  const tools = db.prepare("SELECT COUNT(*) c FROM tool_calls WHERE session_id LIKE 'zcode:%'").get().c;
  assert.ok(tools >= 10, `tool calls indexed (${tools})`);

  const subagents = db.prepare("SELECT COUNT(*) c FROM subagents WHERE session_id LIKE 'zcode:%'").get().c;
  assert.equal(subagents, 2, 'exactly the two subagent_child sessions emit subagent records');

  const toolErrors = db.prepare("SELECT COUNT(*) c FROM tool_results WHERE session_id LIKE 'zcode:%' AND is_error=1").get().c;
  assert.ok(toolErrors >= 1, 'error tool results indexed');

  const summaries = db.prepare("SELECT COUNT(*) c FROM summaries WHERE source='zcode'").get().c;
  assert.equal(summaries, 1, 'compact summary indexed');

  db.close();
});

test('search finds real-model content through the full stack', () => {
  const home = makeTempDir('obelisk-zcode-search-');
  seedSource(home);
  build(home);
  writeFileSync(join(home, 'q.mjs'), `return {
    hits: search('TODO.txt entries', { source: 'zcode', limit: 5 }).map(h => h.session.id),
  };`);
  const r = runCli(['--query', join(home, 'q.mjs')], { home });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const out = JSON.parse(r.stdout);
  assert.ok(out.hits.length >= 1, 'aggregate content is searchable');
});

test('incremental append is re-parsed without duplicates; count replaced (total)', () => {
  const home = makeTempDir('obelisk-zcode-append-');
  const src = seedSource(home);
  build(home);
  const db = openIndex(home);
  const before = db.prepare("SELECT COUNT(*) c FROM messages WHERE source='zcode'").get().c;
  const oneSession = db.prepare("SELECT jsonl_path, message_count FROM sessions WHERE source='zcode' ORDER BY started_at LIMIT 1").get();
  db.close();

  // Append one message + part to the source session (rawSessionId is the tail
  // of the unit key).
  const rawSessionId = oneSession.jsonl_path.split('#z:')[1];
  const srcDb = new DatabaseSync(src);
  const now = 1790000000000;
  srcDb.prepare('INSERT INTO message (id, session_id, time_created, time_updated, sequence, data) VALUES (?,?,?,?,?,?)')
    .run('msg_test_append', rawSessionId, now, now, 999, JSON.stringify({
      role: 'user',
      time: { created: now },
      semantics: { origin: 'real_user', kind: 'user_prompt', uiVisibility: 'visible', providerVisibility: 'visible', transcriptVisibility: 'visible' },
    }));
  srcDb.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, sequence, data) VALUES (?,?,?,?,?,?,?)')
    .run('part_test_append', 'msg_test_append', rawSessionId, now, now, 0, JSON.stringify({
      type: 'text', text: 'zcode incremental append needle', time: { start: now, end: now },
    }));
  srcDb.prepare('UPDATE session SET time_updated = ? WHERE id = ?').run(now, rawSessionId);
  srcDb.close();

  clearDebounce(home);
  build(home);
  const db2 = openIndex(home);
  const after = db2.prepare("SELECT COUNT(*) c FROM messages WHERE source='zcode'").get().c;
  assert.equal(after, before + 1, 'exactly one new message row (upsert, no duplicates)');
  const needle = db2.prepare("SELECT COUNT(*) c FROM messages WHERE source='zcode' AND text LIKE '%incremental append needle%'").get().c;
  assert.equal(needle, 1, 'the appended message is indexed and findable');
  const session = db2.prepare('SELECT message_count FROM sessions WHERE jsonl_path = ?').get(oneSession.jsonl_path);
  assert.equal(session.message_count, oneSession.message_count + 1, "countMode 'total' replaced the count");
  db2.close();
});

test('a rewrite that preserves session watermark and counts is caught by the fingerprint', () => {
  const home = makeTempDir('obelisk-zcode-fp-');
  const src = seedSource(home);
  build(home);
  const db = openIndex(home);
  const oneSession = db.prepare("SELECT jsonl_path FROM sessions WHERE source='zcode' ORDER BY started_at LIMIT 1").get();
  const rawSessionId = oneSession.jsonl_path.split('#z:')[1];
  db.close();

  // Rewrite one message's text in place: same row count, same ids, and the
  // message row's own timestamps preserved (the touchSession max() does not
  // regress because it already exceeds these values in the aggregate).
  const srcDb = new DatabaseSync(src);
  const row = srcDb.prepare("SELECT id, data FROM part WHERE session_id = ? AND json_extract(data,'$.type')='text' LIMIT 1").get(rawSessionId);
  const data = JSON.parse(row.data);
  const original = data.text;
  data.text = 'zcode fingerprint rewrite needle';
  srcDb.prepare('UPDATE part SET data = ? WHERE id = ?').run(JSON.stringify(data), row.id);
  srcDb.close();
  assert.notEqual(original, 'zcode fingerprint rewrite needle');

  clearDebounce(home);
  build(home);
  const db2 = openIndex(home);
  const needle = db2.prepare("SELECT COUNT(*) c FROM messages WHERE source='zcode' AND text LIKE '%fingerprint rewrite needle%'").get().c;
  assert.ok(needle >= 1, 'the in-place rewrite was re-parsed (L2 fingerprint)');
  db2.close();
});

test('a deleted session is retracted by the tombstone path', () => {
  const home = makeTempDir('obelisk-zcode-tombstone-');
  const src = seedSource(home);
  build(home);
  const db = openIndex(home);
  const victim = db.prepare("SELECT id, jsonl_path FROM sessions WHERE source='zcode' ORDER BY started_at LIMIT 1").get();
  const before = zcodeSessions(db).length;
  db.close();

  const rawSessionId = victim.jsonl_path.split('#z:')[1];
  const snapshot = readSourceRows(src, rawSessionId);
  deleteSourceSession(src, rawSessionId);

  clearDebounce(home);
  build(home);
  const db2 = openIndex(home);
  assert.equal(zcodeSessions(db2).length, before - 1, 'the deleted session was retracted');
  const leftovers = db2.prepare('SELECT COUNT(*) c FROM messages WHERE session_id = ?').get(victim.id).c;
  assert.equal(leftovers, 0, 'the retracted session has no message rows left');
  db2.close();

  // Byte-identical restore must be re-detected: the tombstone left a cursor
  // that can never equal a real fingerprint, so the resurrected session is
  // treated as changed and fully re-indexed (incremental ≡ cold rebuild).
  restoreSourceRows(src, rawSessionId, snapshot);
  clearDebounce(home);
  const third = build(home);
  assert.ok(third.affectedSessionIds.includes(victim.id), 'restore re-indexes the victim');
  const db3 = openIndex(home);
  assert.equal(zcodeSessions(db3).length, before, 'session count restored');
  const revived = db3.prepare('SELECT message_count FROM sessions WHERE id = ?').get(victim.id);
  assert.ok(revived, 'revived session row exists');
  db3.close();
});

function readSourceRows(src, rawSessionId) {
  const sdb = new DatabaseSync(src);
  const rows = {
    session: sdb.prepare('SELECT * FROM session WHERE id = ?').get(rawSessionId),
    messages: sdb.prepare('SELECT * FROM message WHERE session_id = ?').all(rawSessionId),
    parts: sdb.prepare('SELECT * FROM part WHERE session_id = ?').all(rawSessionId),
  };
  sdb.close();
  return rows;
}

function deleteSourceSession(src, rawSessionId) {
  const sdb = new DatabaseSync(src);
  sdb.prepare('DELETE FROM part WHERE session_id = ?').run(rawSessionId);
  sdb.prepare('DELETE FROM message WHERE session_id = ?').run(rawSessionId);
  sdb.prepare('DELETE FROM session WHERE id = ?').run(rawSessionId);
  sdb.close();
}

function restoreSourceRows(src, rawSessionId, snapshot) {
  const sdb = new DatabaseSync(src);
  const sessionCols = Object.keys(snapshot.session);
  sdb.prepare(`INSERT INTO session (${sessionCols.join(',')}) VALUES (${sessionCols.map(() => '?').join(',')})`)
    .run(...sessionCols.map((c) => snapshot.session[c]));
  for (const [table, key] of [['message', 'messages'], ['part', 'parts']]) {
    for (const row of snapshot[key]) {
      const cols = Object.keys(row);
      sdb.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
        .run(...cols.map((c) => row[c]));
    }
  }
  sdb.close();
}

test('rewind marks superseded messages inactive and keeps retained history', () => {
  const home = makeTempDir('obelisk-zcode-rewind-');
  seedSource(home);
  build(home);
  const db = openIndex(home);
  // The a7 scenario performed a double rewind: rewritten user prompts retain
  // history; superseded branches are inactive.
  const inactive = db.prepare("SELECT COUNT(*) c FROM messages WHERE source='zcode' AND visibility='inactive'").get().c;
  assert.ok(inactive >= 1, `rewind produced inactive rows (${inactive})`);
  const rewritten = db.prepare("SELECT COUNT(*) c FROM messages WHERE source='zcode' AND text LIKE '%rewritten%'").get().c;
  assert.ok(rewritten >= 2, 'rewritten prompts are indexed');
  db.close();
});

test('compaction summary is indexed as a summary record, tail ancestors inactive', () => {
  const home = makeTempDir('obelisk-zcode-compact-');
  seedSource(home);
  build(home);
  const db = openIndex(home);
  const summary = db.prepare("SELECT * FROM summaries WHERE source='zcode'").get();
  assert.ok(summary, 'one compact summary row');
  assert.ok(summary.content.includes('Primary Request'), 'summary body carries the real model summary');
  // tail_start_id is the INCLUSIVE last-summarized message: every message up
  // to and including it is inactive, later messages stay active.
  const inactive = db.prepare(
    "SELECT COUNT(*) c FROM messages WHERE session_id = ? AND visibility = 'inactive'",
  ).get(summary.session_id).c;
  assert.ok(inactive >= 1, `compaction tail produced inactive rows (${inactive})`);
  const active = db.prepare(
    "SELECT COUNT(*) c FROM messages WHERE session_id = ? AND visibility != 'inactive'",
  ).get(summary.session_id).c;
  assert.ok(active >= 1, 'messages after the compaction tail remain active');
  db.close();
});

test('dual-shape model identity: fresh rows read new keys, legacy rows read old keys, conflicts resolve to new', () => {
  const home = makeTempDir('obelisk-zcode-shapes-');
  const src = seedSource(home);
  const srcDb = new DatabaseSync(src);
  // Pick one assistant message and clone its row with different identity
  // shapes but identical semantics/timestamps.
  const base = srcDb.prepare("SELECT * FROM message WHERE json_extract(data,'$.role')='assistant' AND json_extract(data,'$.semantics.kind')='assistant_response' LIMIT 1").get();
  const baseData = JSON.parse(base.data);
  const t = 1790000100000;
  const stripIdentity = (data) => {
    for (const key of ['providerId', 'modelId', 'reasoningLevel', 'providerID', 'modelID', 'variant', 'modelSelection', 'model']) {
      delete data[key];
    }
    return data;
  };
  const mk = (id, identity) => JSON.stringify({
    ...stripIdentity({ ...baseData }),
    time: { created: t, completed: t },
    semantics: { origin: 'agent_runtime', kind: 'assistant_response', uiVisibility: 'visible', providerVisibility: 'visible', transcriptVisibility: 'visible' },
    ...identity,
  });
  const userBase = srcDb.prepare("SELECT * FROM message WHERE json_extract(data,'$.role')='user' AND json_extract(data,'$.semantics.kind')='user_prompt' LIMIT 1").get();
  const userBaseData = JSON.parse(userBase.data);
  const mkUser = (id, identity) => JSON.stringify({
    ...stripIdentity({ ...userBaseData }),
    time: { created: t },
    semantics: { origin: 'real_user', kind: 'user_prompt', uiVisibility: 'visible', providerVisibility: 'visible', transcriptVisibility: 'visible' },
    ...identity,
  });
  const rows = [
    ['msg_shape_new', mk('msg_shape_new', { providerId: 'account:bigmodel-individual-coding-plan', modelId: 'GLM-5.3', reasoningLevel: 'max' })],
    ['msg_shape_old', mk('msg_shape_old', { providerID: 'builtin:bigmodel-coding-plan', modelID: 'GLM-4.7', variant: 'high' })],
    ['msg_shape_conflict', mk('msg_shape_conflict', {
      providerId: 'account:bigmodel-individual-coding-plan', modelId: 'GLM-5.3',
      providerID: 'builtin:bigmodel-coding-plan', modelID: 'GLM-4.7', variant: 'high',
    })],
    ['msg_shape_invalid', mk('msg_shape_invalid', { providerId: 'account:x', modelId: null })],
    // new shape PRESENT but invalid while the legacy shape is fully valid:
    // the new shape still owns the selection — no per-field fallback (the
    // exact regression design §4.4a forbids).
    ['msg_shape_invalid_legacy', mk('msg_shape_invalid_legacy', {
      providerId: 'account:x', modelId: null,
      providerID: 'builtin:bigmodel-coding-plan', modelID: 'GLM-4.7', variant: 'high',
    })],
    // user read point: fresh $.modelSelection + legacy $.model
    ['msg_shape_user', mkUser('msg_shape_user', {
      modelSelection: { providerId: 'account:bigmodel-individual-coding-plan', modelId: 'GLM-5.3-user' },
      model: { providerID: 'builtin:bigmodel-coding-plan', modelID: 'GLM-4.7-user' },
    })],
  ];
  const firstSession = srcDb.prepare('SELECT id FROM session LIMIT 1').get().id;
  for (const [id, data] of rows) {
    srcDb.prepare('INSERT INTO message (id, session_id, time_created, time_updated, sequence, data) VALUES (?,?,?,?,?,?)')
      .run(id, firstSession, t, t, 2000 + rows.findIndex(r => r[0] === id), data);
    srcDb.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, sequence, data) VALUES (?,?,?,?,?,?,?)')
      .run(`${id}_p`, id, firstSession, t, t, 0, JSON.stringify({ type: 'text', text: `shape probe ${id}`, time: { start: t, end: t } }));
  }
  // timeline read point (to-side): fresh toModelSelection + legacy toModel
  const timelineT = 1790000150000;
  srcDb.prepare('INSERT INTO message (id, session_id, time_created, time_updated, sequence, data) VALUES (?,?,?,?,?,?)')
    .run('msg_shape_timeline', firstSession, timelineT, timelineT, 3000, JSON.stringify({
      role: 'assistant',
      time: { created: timelineT },
      semantics: { origin: 'agent_runtime', kind: 'timeline_event', uiVisibility: 'visible', providerVisibility: 'hidden', transcriptVisibility: 'visible' },
    }));
  srcDb.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, sequence, data) VALUES (?,?,?,?,?,?,?)')
    .run('msg_shape_timeline_p', 'msg_shape_timeline', firstSession, timelineT, timelineT, 0, JSON.stringify({
      type: 'timeline',
      toModelSelection: { providerId: 'account:bigmodel-individual-coding-plan', modelId: 'GLM-5.3-tl' },
      toModel: { providerID: 'builtin:bigmodel-coding-plan', modelID: 'GLM-4.7-tl' },
      time: { start: timelineT, end: timelineT },
    }));
  srcDb.prepare('UPDATE session SET time_updated = ? WHERE id = ?').run(timelineT, firstSession);
  srcDb.close();

  build(home);
  const db = openIndex(home);
  const model = (needle) => db.prepare('SELECT model FROM messages WHERE text = ?').get(`shape probe ${needle}`)?.model;
  assert.equal(model('msg_shape_new'), 'GLM-5.3', 'fresh shape reads new keys');
  assert.equal(model('msg_shape_old'), 'GLM-4.7', 'legacy-only row reads old keys');
  assert.equal(model('msg_shape_conflict'), 'GLM-5.3', 'both shapes present: new shape is authoritative, no per-field fallback');
  assert.equal(model('msg_shape_invalid'), null, 'present-but-invalid new shape yields null, never borrows old members');
  assert.equal(model('msg_shape_invalid_legacy'), null, 'invalid new shape with a fully valid legacy shape still yields null (no fallback)');
  assert.equal(model('msg_shape_user'), 'GLM-5.3-user', 'user rows read $.modelSelection over legacy $.model');
  const timelineText = db.prepare("SELECT text FROM messages WHERE uuid LIKE '%msg_shape_timeline'").get()?.text;
  assert.ok(timelineText?.includes('GLM-5.3-tl'), `timeline card text uses the new-shape model (${timelineText})`);
  assert.ok(!timelineText?.includes('GLM-4.7-tl'), 'timeline card text never borrows the legacy shape');
  db.close();
});

test('subagent classification is authoritative from task_type and parent link', () => {
  const home = makeTempDir('obelisk-zcode-subagent-');
  seedSource(home);
  build(home);
  const db = openIndex(home);
  // The a3 scenario spawned two subagent children (general-purpose + Explore);
  // the fork child (task_type 'fork') and the selection-side chat are NOT
  // subagents and must not be classified as one.
  const subs = db.prepare("SELECT * FROM subagents WHERE session_id LIKE 'zcode:%' ORDER BY agent_id").all();
  assert.equal(subs.length, 2, `exactly the two subagent_child sessions (${subs.length})`);
  const types = subs.map(s => s.agent_type).sort();
  assert.ok(types.includes('zcode-general-purpose'), `agent_type observed verbatim (${types.join(',')})`);
  assert.ok(types.every(t => t === null || t.startsWith('zcode-')), 'no heuristic stripping in the adapter');
  db.close();
});

test('changedPaths outside the zcode db never wake the provider', () => {
  const home = makeTempDir('obelisk-zcode-routing-');
  const src = seedSource(home);
  const first = build(home);
  assert.ok(first.affectedSessionIds.length > 0);
  clearDebounce(home);
  const second = build(home, { changedPaths: ['/tmp/some/other/file.jsonl'] });
  assert.equal(second.affectedSessionIds.length, 0, 'foreign paths produce no zcode units');
  // A change routed through the WAL sidecar path must reach the provider:
  // append one message via a writer connection, then pass ONLY the -wal path.
  const walPath = `${src}-wal`;
  const writer = new DatabaseSync(src);
  const now = 1790000200000;
  const oneSession = writer.prepare('SELECT id FROM session ORDER BY time_created LIMIT 1').get().id;
  writer.prepare('INSERT INTO message (id, session_id, time_created, time_updated, sequence, data) VALUES (?,?,?,?,?,?)')
    .run('msg_wal_route', oneSession, now, now, 5000, JSON.stringify({
      role: 'user',
      time: { created: now },
      semantics: { origin: 'real_user', kind: 'user_prompt', uiVisibility: 'visible', providerVisibility: 'visible', transcriptVisibility: 'visible' },
    }));
  writer.prepare('UPDATE session SET time_updated = ? WHERE id = ?').run(now, oneSession);
  writer.close();
  const third = build(home, { changedPaths: [walPath] });
  assert.ok(third.affectedSessionIds.length > 0, 'the WAL sidecar path routes to the provider');
  const db = openIndex(home);
  const routed = db.prepare("SELECT COUNT(*) c FROM messages WHERE source='zcode' AND text IS NULL AND uuid LIKE '%msg_wal_route'").get().c;
  assert.equal(routed, 1, 'the appended message was indexed via the WAL-routed build');
  db.close();
});

function clearDebounce(home) {
  const db = openIndex(home);
  db.prepare("DELETE FROM index_state WHERE jsonl_path='__last_build__'").run();
  db.close();
}

test('provider-level: missing source is quiet without prior sessions, incomplete with them', () => {
  const home = makeTempDir('obelisk-zcode-missing-');
  const provider = createZcodeProvider({ rootDir: join(home, '.zcode', 'cli') });
  let issue;
  const units = provider.discover({
    lastCursor: () => null,
    reportIncompleteInventory(value) { issue = value; },
  });
  assert.deepEqual(units, []);
  assert.equal(issue, undefined, 'no prior sessions: a missing source is a quiet empty state');

  let issue2;
  const units2 = provider.discover({
    lastCursor: () => null,
    indexedSessions: () => [{ sessionId: 'zcode:abc:sess_x', jsonlPath: join(home, '.zcode', 'cli', 'db', 'db.sqlite#z:sess_x') }],
    reportIncompleteInventory(value) { issue2 = value; },
  });
  assert.deepEqual(units2, []);
  assert.ok(issue2, 'prior sessions + missing source: inventory is incomplete, no tombstones fired');
});

test('provider-level: unreadable database reports incomplete inventory and keeps no units', () => {
  const home = makeTempDir('obelisk-zcode-unreadable-');
  const dir = join(home, '.zcode', 'cli', 'db');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'db.sqlite'), 'this is not a sqlite database');
  const provider = createZcodeProvider({ rootDir: join(home, '.zcode', 'cli') });
  let issue;
  const units = provider.discover({
    lastCursor: () => null,
    reportIncompleteInventory(value) { issue = value; },
  });
  assert.deepEqual(units, [], 'an unreadable database yields no units');
  assert.ok(issue, 'the inventory problem is reported (fail closed, no tombstones)');
});

test('parse output assembles and survives a SQLite round-trip (ADR-0007 hard gate)', () => {
  const home = makeTempDir('obelisk-zcode-roundtrip-');
  seedSource(home);
  const provider = createZcodeProvider({ rootDir: join(home, '.zcode', 'cli') });
  const units = provider.discover({ lastCursor: () => null });
  assert.ok(units.length >= 15, `fixture units discovered (${units.length})`);

  // Direct assembly from the adapter's in-memory records for every unit, then
  // the same assembly from rows persisted to a real SQLite database: the two
  // must be identical (canonical transcript contract).
  const directBySession = new Map();
  const db = freshDb();
  for (const unit of units) {
    const values = drain(provider.parse(unit, null));
    persist(db, unit, provider.parse(unit, null));
    for (const value of values) {
      const key = value.kind === 'session' ? value.id : value.session_id;
      const bucket = directBySession.get(key) ?? [];
      bucket.push(value);
      directBySession.set(key, bucket);
    }
  }
  let compared = 0;
  for (const [sessionId, values] of directBySession) {
    const direct = assembleSessionDetail(values);
    const persisted = assembleSessionDetail({
      session: db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId),
      messages: db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp, uuid').all(sessionId),
      toolCalls: db.prepare('SELECT * FROM tool_calls WHERE session_id = ?').all(sessionId),
      toolResults: db.prepare('SELECT * FROM tool_results WHERE session_id = ?').all(sessionId),
      subagents: db.prepare('SELECT * FROM subagents WHERE session_id = ?').all(sessionId),
    });
    assert.deepEqual(persisted, direct, `session ${sessionId} round-trips identically`);
    compared += 1;
  }
  assert.ok(compared >= 15, `every fixture session compared (${compared})`);
  db.close();
});
