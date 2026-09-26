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
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildIndex } from '../app/src/main/indexer.ts';
import { createIndexerService } from '../app/src/main/indexer-service.ts';
import { createZcodeProvider } from '../packages/core/src/providers/zcode.ts';
import { persist } from '../packages/core/src/persist.ts';
import { createQueryApi } from '../packages/core/src/query.ts';
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
  const sourcePath = seedSource(home);
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
  const queriedSubagents = createQueryApi(db).subagents({ source: 'zcode', after: '2000-01-01T00:00:00Z', before: '2100-01-01T00:00:00Z' });
  assert.equal(queriedSubagents.length, 2, 'both children have a queryable activity interval');
  assert.ok(queriedSubagents.every(agent => agent.messageCount > 0), 'child messages contribute to subagent counts');
  assert.ok(queriedSubagents.every(agent => agent.total_tokens !== null), 'child model usage contributes to subagent totals');

  const toolErrors = db.prepare("SELECT COUNT(*) c FROM tool_results WHERE session_id LIKE 'zcode:%' AND is_error=1").get().c;
  assert.ok(toolErrors >= 1, 'error tool results indexed');

  const summaries = db.prepare("SELECT COUNT(*) c FROM summaries WHERE source='zcode'").get().c;
  assert.equal(summaries, 1, 'compact summary indexed');

  const source = new DatabaseSync(sourcePath);
  const priced = source.prepare("SELECT id, json_extract(data,'$.tokens.input') input, json_extract(data,'$.tokens.cache.read') cache_read FROM message WHERE json_extract(data,'$.tokens.cache.read') > 0 AND json_extract(data,'$.semantics.kind')='assistant_response' LIMIT 1").get();
  const indexed = db.prepare("SELECT input_tokens FROM messages WHERE source='zcode' AND uuid LIKE ?").get(`%:${priced.id}`);
  assert.equal(indexed.input_tokens, priced.input, 'cached input is already included in source tokens.input');
  assert.ok(priced.cache_read > 0);
  assert.ok(db.prepare("SELECT 1 FROM messages WHERE source='zcode' AND content_type='tool_use' AND text IS NULL LIMIT 1").get(), 'tool-only assistant messages keep tool_use classification');
  assert.ok(db.prepare("SELECT 1 FROM messages WHERE source='zcode' AND content_type='unknown' AND text IS NULL LIMIT 1").get(), 'textless non-tool messages keep unknown classification');
  const summary = db.prepare("SELECT visibility FROM summaries WHERE source='zcode' LIMIT 1").get();
  assert.equal(summary.visibility, 'visible', 'compaction summary is available to standard readers');
  const reasoningParts = source.prepare(`
    SELECT p.message_id, p.data FROM part p
    JOIN message m ON m.id = p.message_id
    WHERE json_extract(p.data,'$.type')='reasoning'
      AND json_extract(m.data,'$.semantics.kind')='assistant_response'
      AND json_extract(m.data,'$.semantics.uiVisibility')='visible'
  `).all();
  const selected = reasoningParts.map(part => ({
    part,
    response: db.prepare("SELECT * FROM messages WHERE source='zcode' AND uuid LIKE ? AND visibility='visible'").get(`%:${part.message_id}`),
  })).find(item => item.response !== undefined);
  assert.ok(selected, 'fixture includes a current assistant response with reasoning');
  const { part: reasoningPart, response } = selected;
  const detail = assembleSessionDetail({
    session: db.prepare('SELECT * FROM sessions WHERE id=?').get(response.session_id),
    messages: db.prepare('SELECT * FROM messages WHERE session_id=?').all(response.session_id),
    toolCalls: db.prepare('SELECT * FROM tool_calls WHERE session_id=?').all(response.session_id),
    toolResults: db.prepare('SELECT * FROM tool_results WHERE session_id=?').all(response.session_id),
  });
  assert.ok(detail.messages.find(message => message.uuid === response.uuid)?._thinking?.includes(JSON.parse(reasoningPart.data).text),
    'reasoning stays on the assistant message that owns its part');
  source.close();

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

test('twelve reasoning parts keep source order in direct and persisted detail', () => {
  const home = makeTempDir('obelisk-zcode-reasoning-order-');
  const src = seedSource(home);
  const source = new DatabaseSync(src);
  const response = source.prepare(`
    SELECT m.* FROM message m JOIN session s ON s.id = m.session_id
    WHERE json_extract(m.data, '$.role') = 'assistant'
      AND json_extract(m.data, '$.semantics.uiVisibility') = 'visible'
      AND s.parent_id IS NULL
    LIMIT 1
  `).get();
  assert.ok(response, 'fixture has a first-class assistant response');
  const insert = source.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, sequence, data) VALUES (?,?,?,?,?,?,?)');
  for (let n = 0; n < 12; n++) {
    insert.run(`prt_reasoning_order_${n}`, response.id, response.session_id,
      response.time_created, response.time_updated, 100 + n,
      JSON.stringify({ type: 'reasoning', text: `ordering-marker-${n}` }));
  }
  source.close();

  const provider = createZcodeProvider({ rootDir: join(home, '.zcode', 'cli') });
  const unit = provider.discover({ lastCursor: () => null }).find(item => item.meta.rawSessionId === response.session_id);
  assert.ok(unit);
  const records = drain(provider.parse(unit, null));
  const db = freshDb();
  persist(db, unit, provider.parse(unit, null));
  const direct = assembleSessionDetail(records);
  const persisted = assembleSessionDetail({
    session: db.prepare('SELECT * FROM sessions WHERE id = ?').get(unit.sessionId),
    messages: db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp, uuid').all(unit.sessionId),
    toolCalls: db.prepare('SELECT * FROM tool_calls WHERE session_id = ?').all(unit.sessionId),
    toolResults: db.prepare('SELECT * FROM tool_results WHERE session_id = ?').all(unit.sessionId),
  });
  assert.deepEqual(persisted, direct, 'the reasoning sequence survives SQLite');
  const text = direct.messages.find(message => message.uuid === `${unit.sessionId}:${response.id}`)?._thinking;
  assert.ok(text, 'all reasoning parts attach to their assistant response');
  for (let n = 0; n < 11; n++) {
    assert.ok(text.indexOf(`ordering-marker-${n}\n`) < text.indexOf(`ordering-marker-${n + 1}`),
      `reasoning ${n} precedes ${n + 1}`);
  }
  db.close();
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

test('rewinding past a compaction restores the retained prefix', () => {
  const home = makeTempDir('obelisk-zcode-rewind-compact-');
  const src = seedSource(home);
  const source = new DatabaseSync(src);
  const session = { ...source.prepare('SELECT * FROM session LIMIT 1').get() };
  session.id = 'ses_rewind_compaction_probe';
  session.parent_id = null;
  session.task_type = 'interactive';
  session.revert = JSON.stringify({
    targetMessageID: 'msg_branch_3',
    keptMessageIDs: ['msg_branch_1', 'msg_branch_2'],
    branchCutAfterMessageID: 'msg_branch_5',
  });
  const columns = Object.keys(session);
  source.prepare(`INSERT INTO session (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
    .run(...columns.map(column => session[column]));
  const insertMessage = source.prepare('INSERT INTO message (id, session_id, time_created, time_updated, sequence, data) VALUES (?,?,?,?,?,?)');
  const insertPart = source.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, sequence, data) VALUES (?,?,?,?,?,?,?)');
  for (let n = 1; n <= 6; n++) {
    const id = `msg_branch_${n}`;
    const role = n % 2 === 0 ? 'assistant' : 'user';
    insertMessage.run(id, session.id, n, n, n, JSON.stringify({
      role,
      time: { created: n },
      semantics: {
        kind: role === 'user' ? 'user_prompt' : 'assistant_response',
        uiVisibility: 'visible', providerVisibility: 'visible', transcriptVisibility: 'visible',
      },
    }));
    insertPart.run(`prt_branch_${n}`, id, session.id, n, n, 0, JSON.stringify(
      n === 4
        ? { type: 'compaction', tail_start_id: 'msg_branch_2', auto: true }
        : { type: 'text', text: `branch message ${n}` },
    ));
  }
  source.close();

  build(home);
  const db = openIndex(home);
  const indexed = db.prepare("SELECT id FROM sessions WHERE jsonl_path LIKE '%#z:ses_rewind_compaction_probe'").get();
  assert.ok(indexed, 'the rewound session is indexed');
  const rows = db.prepare('SELECT uuid, visibility FROM messages WHERE session_id = ? ORDER BY uuid').all(indexed.id);
  assert.deepEqual(rows.map(row => [row.uuid.split(':').at(-1), row.visibility]), [
    ['msg_branch_1', 'visible'],
    ['msg_branch_2', 'visible'],
    ['msg_branch_3', 'inactive'],
    ['msg_branch_4', 'inactive'],
    ['msg_branch_5', 'inactive'],
    ['msg_branch_6', 'visible'],
  ], 'only the superseded compaction branch is inactive');
  db.close();
});

test('legacy createdMessageID rewind keeps the newly appended branch', () => {
  const home = makeTempDir('obelisk-zcode-legacy-rewind-');
  const src = seedSource(home);
  const source = new DatabaseSync(src);
  const session = { ...source.prepare('SELECT * FROM session LIMIT 1').get() };
  session.id = 'ses_legacy_rewind_probe';
  session.parent_id = null;
  session.task_type = 'interactive';
  session.revert = JSON.stringify({
    targetMessageID: 'msg_legacy_3',
    keptMessageIDs: ['msg_legacy_1', 'msg_legacy_2'],
    createdMessageID: 'msg_legacy_5',
  });
  const columns = Object.keys(session);
  source.prepare(`INSERT INTO session (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
    .run(...columns.map(column => session[column]));
  const insertMessage = source.prepare('INSERT INTO message (id, session_id, time_created, time_updated, sequence, data) VALUES (?,?,?,?,?,?)');
  const insertPart = source.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, sequence, data) VALUES (?,?,?,?,?,?,?)');
  for (let n = 1; n <= 6; n++) {
    const id = `msg_legacy_${n}`;
    const role = n % 2 === 0 ? 'assistant' : 'user';
    insertMessage.run(id, session.id, n, n, n, JSON.stringify({
      role,
      time: { created: n },
      semantics: {
        kind: role === 'user' ? 'user_prompt' : 'assistant_response',
        uiVisibility: 'visible', providerVisibility: 'visible', transcriptVisibility: 'visible',
      },
    }));
    insertPart.run(`prt_legacy_${n}`, id, session.id, n, n, 0,
      JSON.stringify({ type: 'text', text: `legacy branch message ${n}` }));
  }
  source.close();

  build(home);
  const db = openIndex(home);
  const indexed = db.prepare("SELECT id FROM sessions WHERE jsonl_path LIKE '%#z:ses_legacy_rewind_probe'").get();
  assert.ok(indexed, 'legacy rewound session is indexed');
  const rows = db.prepare('SELECT uuid, visibility FROM messages WHERE session_id = ? ORDER BY uuid').all(indexed.id);
  assert.deepEqual(rows.map(row => [row.uuid.split(':').at(-1), row.visibility]), [
    ['msg_legacy_1', 'visible'],
    ['msg_legacy_2', 'visible'],
    ['msg_legacy_3', 'inactive'],
    ['msg_legacy_4', 'inactive'],
    ['msg_legacy_5', 'visible'],
    ['msg_legacy_6', 'visible'],
  ]);
  db.close();
});

test('compaction preserves the source-declared message segment', () => {
  const home = makeTempDir('obelisk-zcode-preserved-');
  const src = seedSource(home);
  const source = new DatabaseSync(src);
  const marker = source.prepare("SELECT id, message_id, data FROM part WHERE json_extract(data, '$.compactBoundary') IS NOT NULL LIMIT 1").get();
  assert.ok(marker, 'real fixture includes a compact boundary');
  const markerData = JSON.parse(marker.data);
  const owner = source.prepare('SELECT session_id FROM message WHERE id = ?').get(marker.message_id);
  const before = source.prepare('SELECT id FROM message WHERE session_id = ? AND sequence IN (6, 7, 8, 9) ORDER BY sequence')
    .all(owner.session_id).map(row => row.id);
  assert.equal(before.length, 4, 'fixture has a preceding preservable segment and timeline marker');
  markerData.compactBoundary.preservedSegment = {
    headMessageId: before[1], anchorMessageId: marker.message_id, tailMessageId: before[2],
  };
  markerData.compactBoundary.keptMessageCount = 2;
  source.prepare('UPDATE part SET data = ? WHERE id = ?').run(JSON.stringify(markerData), marker.id);
  source.close();

  build(home);
  const db = openIndex(home);
  const visibility = id => db.prepare('SELECT visibility FROM messages WHERE uuid LIKE ?').get(`%:${id}`)?.visibility;
  assert.equal(visibility(before[0]), 'inactive', 'older summarized message remains inactive');
  assert.equal(visibility(before[1]), 'visible', 'preserved segment head remains current evidence');
  assert.equal(visibility(before[2]), 'visible', 'preserved segment tail remains current evidence');
  assert.equal(visibility(before[3]), 'inactive', 'the old timeline marker is superseded');
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
  for (const sub of subs) {
    const child = db.prepare('SELECT * FROM sessions WHERE id=?').get(sub.agent_id);
    const detail = assembleSessionDetail({
      session: child,
      messages: db.prepare('SELECT * FROM messages WHERE session_id=?').all(sub.agent_id),
      toolCalls: db.prepare('SELECT * FROM tool_calls WHERE session_id=?').all(sub.agent_id),
      toolResults: db.prepare('SELECT * FROM tool_results WHERE session_id=?').all(sub.agent_id),
    });
    assert.ok(detail.messages.length > 0, 'a child session exposes its own conversation in session detail');
  }
  db.close();
});

test('parent deletion, restoration, and rewrite converge child links without child edits', () => {
  const home = makeTempDir('obelisk-zcode-parent-link-');
  const src = seedSource(home);
  build(home);
  const source = new DatabaseSync(src);
  const child = source.prepare("SELECT id, parent_id FROM session WHERE task_type='subagent_child' LIMIT 1").get();
  source.close();
  const indexed = openIndex(home);
  const childId = indexed.prepare('SELECT id FROM sessions WHERE jsonl_path LIKE ?').get(`%#z:${child.id}`).id;
  const parentId = indexed.prepare('SELECT id FROM sessions WHERE jsonl_path LIKE ?').get(`%#z:${child.parent_id}`).id;
  assert.ok(indexed.prepare('SELECT 1 FROM subagents WHERE agent_id=? AND session_id=?').get(childId, parentId));
  indexed.close();

  const snapshot = readSourceRows(src, child.parent_id);
  deleteSourceSession(src, child.parent_id);
  clearDebounce(home);
  build(home);
  let db = openIndex(home);
  assert.equal(db.prepare('SELECT 1 FROM subagents WHERE agent_id=?').get(childId), undefined, 'orphan child has no dangling link');
  assert.ok(db.prepare('SELECT 1 FROM messages WHERE session_id=?').get(childId), 'child conversation survives parent deletion');
  db.close();

  restoreSourceRows(src, child.parent_id, snapshot);
  clearDebounce(home);
  build(home);
  db = openIndex(home);
  assert.ok(db.prepare('SELECT 1 FROM subagents WHERE agent_id=? AND session_id=?').get(childId, parentId), 'byte-identical parent restore recreates child link');
  db.close();

  const writer = new DatabaseSync(src);
  writer.prepare('UPDATE session SET title=? WHERE id=?').run('parent title changed', child.parent_id);
  writer.close();
  clearDebounce(home);
  build(home);
  db = openIndex(home);
  assert.ok(db.prepare('SELECT 1 FROM subagents WHERE agent_id=? AND session_id=?').get(childId, parentId), 'parent-only rewrite preserves child link');
  db.close();
});

test('retargeting a configured root symlink does not erase unchanged sessions', () => {
  const home = makeTempDir('obelisk-zcode-symlink-');
  const firstRoot = makeTempDir('obelisk-zcode-source-a-');
  const secondRoot = makeTempDir('obelisk-zcode-source-b-');
  seedSource(firstRoot);
  seedSource(secondRoot);
  mkdirSync(join(home, '.zcode'), { recursive: true });
  const link = join(home, '.zcode', 'cli');
  symlinkSync(join(firstRoot, '.zcode', 'cli'), link);
  build(home);
  const first = openIndex(home);
  const ids = zcodeSessions(first).map(session => session.id);
  assert.equal(ids.length, 17);
  first.close();

  rmSync(link);
  symlinkSync(join(secondRoot, '.zcode', 'cli'), link);
  clearDebounce(home);
  build(home);
  const second = openIndex(home);
  assert.deepEqual(zcodeSessions(second).map(session => session.id), ids);
  second.close();
});

test('a legacy realpath identity is replaced without tombstoning the live cursor key', () => {
  const home = makeTempDir('obelisk-zcode-identity-upgrade-');
  seedSource(home);
  const provider = createZcodeProvider({ rootDir: join(home, '.zcode', 'cli') });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const parsed = provider.parse(unit, null);
  let result = parsed.next();
  while (!result.done) result = parsed.next();
  const cursor = result.value;
  const legacyId = `zcode:old-realpath:${unit.sessionId.split(':').at(-1)}`;
  const units = provider.discover({
    lastCursor: key => key === unit.key ? cursor : null,
    indexedSessions: () => [{ sessionId: legacyId, jsonlPath: unit.key }],
  });
  const replacement = units.find(candidate => candidate.key === unit.key);
  assert.deepEqual(replacement.retractSessionIds, [unit.sessionId, legacyId]);
  assert.equal(units.filter(candidate => candidate.key === unit.key).length, 1,
    'the replacement must not be followed by a tombstone on the same cursor key');
});

test('raw projection supplies the full text of a long ZCode message', () => {
  const home = makeTempDir('obelisk-zcode-fulltext-');
  const src = seedSource(home);
  const source = new DatabaseSync(src);
  const part = source.prepare("SELECT id, message_id, data FROM part WHERE json_extract(data,'$.type')='text' LIMIT 1").get();
  const data = JSON.parse(part.data);
  data.text = `${'x'.repeat(11000)}full-text-tail`;
  source.prepare('UPDATE part SET data=? WHERE id=?').run(JSON.stringify(data), part.id);
  source.close();
  build(home);
  const db = openIndex(home);
  const message = db.prepare("SELECT * FROM messages WHERE source='zcode' AND uuid LIKE ?").get(`%:${part.message_id}`);
  const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(message.session_id);
  assert.ok(!message.text?.includes('full-text-tail'), 'indexed text is truncated');
  const provider = createZcodeProvider({ rootDir: join(home, '.zcode', 'cli') });
  const raw = provider.raw({ source: 'zcode', messageUuid: message.uuid, session, agentId: null });
  assert.ok(raw.messageText.includes('full-text-tail'), 'raw messageText retains the complete body');
  assert.ok(raw.text.includes('full-text-tail'), 'raw() keeps later pages available to the query API');
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

test('App file watcher forwards ZCode WAL changes through changedPaths into the index', async () => {
  const home = makeTempDir('obelisk-zcode-app-watch-');
  const src = seedSource(home);
  const provider = createZcodeProvider({ rootDir: join(home, '.zcode', 'cli') });
  const builds = [];
  const warnings = [];
  const service = createIndexerService({
    watchTargets: provider.watchTargets(join(home, '.zcode', 'cli')),
    buildIndex: (args) => {
      builds.push(args);
      return build(home, { changedPaths: args.changedPaths });
    },
    writeHeartbeat: () => {},
    watchPollMs: 30,
    debounceMs: 0,
    stabilityMs: 0,
    reconcileMs: 0,
    logger: { warn: (message) => warnings.push(message) },
  });
  let writer;
  try {
    writer = new DatabaseSync(src);
    writer.exec('PRAGMA journal_mode=WAL');
    // Keep the WAL present before the watcher starts, so its first poll has
    // an actual sidecar to observe on every SQLite/platform combination.
    writer.prepare('UPDATE session SET title=title WHERE id=(SELECT id FROM session LIMIT 1)').run();
    assert.ok(existsSync(`${src}-wal`));
    service.start({ buildOnStart: false });
    await service.runBuildNow('startup');
    // The poller's first observation reports an appearance. Drain it before
    // mutating the source, so only a subsequent WAL invalidation can index the rewrite.
    for (let attempt = 0; attempt < 50 && !builds.some((args) => args.changedPaths?.includes(`${src}-wal`)); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await service.idle();
    }
    assert.ok(builds.some((args) => args.changedPaths?.includes(`${src}-wal`)),
      'the pinned WAL target is observed before the rewrite');
    await service.idle();
    builds.length = 0;
    clearDebounce(home);
    const part = writer.prepare("SELECT id, data FROM part WHERE json_extract(data,'$.type')='text' LIMIT 1").get();
    assert.ok(part, 'real fixture has a text part to rewrite');
    const data = JSON.parse(part.data);
    data.text = 'zcode app watcher wal needle';
    writer.prepare('UPDATE part SET data = ? WHERE id = ?').run(JSON.stringify(data), part.id);
    assert.ok(existsSync(`${src}-wal`), 'the WAL sidecar exists while the writer stays open');

    let indexed = false;
    for (let attempt = 0; attempt < 100 && !indexed; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      await service.idle();
      const db = openIndex(home);
      indexed = db.prepare("SELECT COUNT(*) c FROM messages WHERE source='zcode' AND text LIKE '%app watcher wal needle%'").get().c > 0;
      db.close();
    }
    assert.ok(builds.some((args) => args.changedPaths?.includes(`${src}-wal`)),
      'the pinned WAL target reaches the App build callback');
    assert.ok(indexed, 'changed-path indexing projects the WAL rewrite into the shared index');
    assert.deepEqual(warnings, [], 'the App build reports no indexing errors');
  } finally {
    service.stop();
    await service.idle();
    writer?.close();
  }
});

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
      summaries: db.prepare('SELECT * FROM summaries WHERE session_id = ?').all(sessionId),
    });
    assert.deepEqual(persisted, direct, `session ${sessionId} round-trips identically`);
    compared += 1;
  }
  assert.ok(compared >= 15, `every fixture session compared (${compared})`);
  db.close();
});
