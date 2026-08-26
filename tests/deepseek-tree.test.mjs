// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Tests for the deepseek provider's root-tree two-path architecture
// (ADR-0011). Real artifacts live in tests/fixtures/deepseek (verbatim,
// structure-preserving sanitized dsh output per CONTRIBUTING); synthetic
// fixtures cover the state transitions no real log can produce on demand
// (truncation, replacement, identity change, tombstones).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { constants, zstdCompressSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

import { createDeepseekProvider } from '../packages/core/src/providers/deepseek.ts';
import { persist } from '../packages/core/src/persist.ts';
import { assembleSessionDetail } from '../packages/core/src/session-detail.ts';
import { createZstdFrameDecoder, scanZstdFrames } from '../packages/core/src/vendor/dsh-zstd.ts';
import { makeTempDir } from './temp-dirs.mjs';

const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');
const SCOPE = createHash('sha256').update('deepseek-cwd-v1\0').update('/tmp/dsh-project').digest('hex');
const ROOT_ID = `deepseek:root-session-1:${SCOPE}`;
const CHILD_ID = `deepseek:child-session-1:${SCOPE}`;

function drain(gen) {
  const values = [];
  let step = gen.next();
  while (!step.done) { values.push(step.value); step = gen.next(); }
  return { values, ret: step.value };
}

function mkFrame(lines) {
  return zstdCompressSync(Buffer.from(lines.map((line) => JSON.stringify(line)).join('\n') + '\n'), { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
}

// A realistic root+child event set, grouped into append batches (frames).
const HEADER = { type: 'session', version: 0, id: 'root-session-1', createdAt: 1753005600000, cwd: '/tmp/dsh-project', delegationDepth: 0, agentPreset: 'standard' };
const CHILD_HEADER = { type: 'session', version: 0, id: 'child-session-1', createdAt: 1753005604200, cwd: '/tmp/dsh-project', parentSession: 'root-session-1', origin: 'subagent', delegationDepth: 1 };

function rootFrames() {
  return [
    [HEADER],
    [
      { type: 'request/header', seq: 0, time: 1753005600100, data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }, reason: 'initial' } },
      { type: 'user/message', seq: 1, time: 1753005601000, data: { content: [{ type: 'text', text: 'inspect the project' }], source: { kind: 'user' }, role: 'user', id: 'msg-1' } },
    ],
    [
      { type: 'assistant/message', seq: 2, time: 1753005602000, data: {
        turn: 1, step: 1,
        message: { role: 'assistant', content: [
          { type: 'reasoning', text: 'think step' },
          { type: 'text', text: 'doing it' },
          { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"file_path":"/tmp/dsh-project/a.ts"}' },
        ], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' }, id: 'msg-2' },
        usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3 },
      } },
    ],
    // A packed chunk row between the assistant message and the durable call.
    [{ type: 'text-chunks', seq0: 50, time0: 1753005602050, data: { turn: 1, step: 1, index: 0, dt: [3, 3], texts: ['d', 'o', 'i'] } }],
    [
      { type: 'tool/call', seq: 4, time: 1753005602100, data: { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{"file_path":"/tmp/dsh-project/a.ts"}' } },
    ],
    [
      { type: 'tool/result', seq: 5, time: 1753005602500, data: {
        turn: 1, step: 1,
        message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'file body' }] }], role: 'user', id: 'msg-3' },
      } },
      { type: 'user/message', seq: 6, time: 1753005603000, data: { content: [{ type: 'text', text: '<system-reminder>injected</system-reminder>' }], source: { kind: 'plugin', plugin: 'x' }, role: 'user', id: 'msg-4' } },
    ],
    [
      { type: 'assistant/message', seq: 7, time: 1753005604000, data: {
        turn: 1, step: 2,
        message: { role: 'assistant', content: [{ type: 'tool-call', id: 'call-2', name: 'subagent', arguments: '{"prompt":"review the code"}' }], source: { kind: 'model', model: 'deepseek-v4-flash' }, id: 'msg-5' },
        usage: { inputTokens: 5, outputTokens: 1 },
      } },
      { type: 'tool/call', seq: 8, time: 1753005604050, data: { turn: 1, step: 2, callId: 'call-2', name: 'subagent', arguments: '{"prompt":"review the code"}' } },
    ],
    [
      { type: 'tool/result', seq: 9, time: 1753005604100, data: {
        turn: 1, step: 2,
        message: { source: { kind: 'tool', callId: 'call-2' }, content: [{ type: 'tool-result', toolCallId: 'call-2', content: [{ type: 'text', text: 'started subagent child-session-1' }] }], role: 'user', id: 'msg-6' },
      } },
      { type: 'assistant/message', seq: 10, time: 1753005605000, data: {
        turn: 1, step: 3,
        message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }], source: { kind: 'model', model: 'deepseek-v4-flash' }, id: 'msg-7' },
        usage: { inputTokens: 2, outputTokens: 2 },
      } },
      { type: 'session/title', seq: 11, time: 1753005605100, data: { title: 'Fixture title', messageSeqs: [1], source: { kind: 'fallback' } } },
    ],
  ];
}

function childFrames() {
  return [
    [CHILD_HEADER],
    [
      { type: 'subagent/descriptor', seq: 0, time: 1753005604200, data: { version: 2, mode: 'continuable', provider: 'spawn', label: 'review helper', agentProvider: 'deepseek-official', agentModel: 'deepseek-v4-flash' } },
      { type: 'user/message', seq: 1, time: 1753005604300, data: { content: [{ type: 'text', text: 'review the code' }], source: { kind: 'user' }, role: 'user', id: 'msg-c1' } },
    ],
    [
      { type: 'assistant/message', seq: 2, time: 1753005605000, data: {
        turn: 1, step: 1,
        message: { role: 'assistant', content: [{ type: 'reasoning', text: 'child think' }, { type: 'text', text: 'child done' }], source: { kind: 'model', model: 'deepseek-v4-flash' }, id: 'msg-c2' },
        usage: { inputTokens: 20, outputTokens: 5 },
      } },
    ],
  ];
}

function writeTree(root, { rootFrameCount = Infinity, childFrameCount = Infinity, zstd = true } = {}) {
  const sessionsDir = join(root, 'sessions');
  const projectDir = join(sessionsDir, '--tmp-dsh-project--');
  const suffix = zstd ? '.jsonl.zstd' : '.jsonl';
  const write = (dir, frames, keep) => {
    mkdirSync(dir, { recursive: true });
    const slice = frames.slice(0, Math.min(keep, frames.length));
    if (zstd) writeFileSync(join(dir, `session${suffix}`), Buffer.concat(slice.map(mkFrame)));
    else writeFileSync(join(dir, `session${suffix}`), slice.flat().map((e) => JSON.stringify(e)).join('\n') + '\n');
  };
  write(join(projectDir, 'root-session-1'), rootFrames(), rootFrameCount);
  write(join(projectDir, 'child-session-1'), childFrames(), childFrameCount);
  return sessionsDir;
}

// Production-shaped cursor store: index_state is keyed by unit.key, so tests
// must look cursors up by key — a global `() => cursor` masks key changes.
function cursorStore() {
  const map = new Map();
  return {
    set: (key, cursor) => map.set(key, cursor),
    ctx: () => ({ lastCursor: (key) => map.get(key) ?? null }),
  };
}

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}

function dumpDb(db) {
  const q = (sql) => db.prepare(sql).all();
  return {
    sessions: q('SELECT id, title, project, started_at, ended_at, message_count, source FROM sessions ORDER BY id'),
    messages: q('SELECT uuid, session_id, type, parent_uuid, timestamp, role, text, content_type, is_meta, model, is_sidechain, agent_id, input_tokens, output_tokens FROM messages ORDER BY uuid'),
    tool_calls: q('SELECT id, message_uuid, session_id, name, presentation, input_json, file_path FROM tool_calls ORDER BY id'),
    tool_results: q('SELECT tool_use_id, message_uuid, session_id, content, is_error FROM tool_results ORDER BY tool_use_id'),
    subagents: q('SELECT agent_id, session_id, parent_tool_use_id, agent_type, description FROM subagents ORDER BY agent_id'),
  };
}

test('discovers one unit per root session tree and skips an unchanged tree', () => {
  const dir = makeTempDir('obelisk-tree-');
  const sessionsDir = writeTree(dir);
  const provider = createDeepseekProvider({ rootDir: sessionsDir });

  const units = provider.discover({ lastCursor: () => null });
  assert.equal(units.length, 1); // root + child = ONE unit
  const unit = units[0];
  assert.equal(unit.sessionId, ROOT_ID);
  assert.equal(unit.project, '-tmp-dsh-project');

  const cursor = drain(provider.parse(unit, null)).ret;
  assert.deepEqual(provider.discover({ lastCursor: () => cursor }), []); // unchanged → skipped

  // A change in the CHILD file brings the whole tree unit back.
  const dir2 = makeTempDir('obelisk-tree2-');
  const sessionsDir2 = writeTree(dir2);
  writeTree(dir2, {}); // same content; now append to the child
  const childPath = join(sessionsDir2, '--tmp-dsh-project--', 'child-session-1', 'session.jsonl.zstd');
  const extra = mkFrame([{ type: 'user/message', seq: 3, time: 1753005606000, data: { content: [{ type: 'text', text: 'more' }], source: { kind: 'user' }, role: 'user', id: 'msg-c3' } }]);
  writeFileSync(childPath, Buffer.concat([readFileSync(childPath), extra]));
  const provider2 = createDeepseekProvider({ rootDir: sessionsDir2 });
  const cursor2 = drain(provider2.parse(provider2.discover({ lastCursor: () => null })[0], null)).ret;
  // doctor the cursor to match dir2's unchanged root but stale child count
  const again = provider2.discover({ lastCursor: () => cursor2 });
  assert.deepEqual(again, []);
});

test('projects a whole tree into canonical records with correct linkage', () => {
  const dir = makeTempDir('obelisk-tree-proj-');
  const provider = createDeepseekProvider({ rootDir: writeTree(dir) });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const { values } = drain(provider.parse(unit, null));
  const byKind = (kind) => values.filter((record) => record.kind === kind);

  const messages = byKind('message');
  const texts = messages.filter((m) => m.role === 'user').map((m) => [m.text, m.is_meta, m.is_sidechain]);
  assert.deepEqual(texts, [
    ['inspect the project', 0, 0],
    ['<system-reminder>injected</system-reminder>', 1, 0],
    ['review the code', 0, 1],
  ]);
  // child messages fold into the root session
  assert.ok(messages.filter((m) => m.is_sidechain === 1).every((m) => m.session_id === ROOT_ID && m.agent_id === CHILD_ID));

  // usage counted once, cacheRead included
  const doing = messages.find((m) => m.text === 'doing it');
  assert.equal(doing.input_tokens, 13);
  assert.equal(doing.output_tokens, 4);
  const thinking = messages.find((m) => m.content_type === 'thinking' && m.text === 'think step');
  assert.equal(thinking.input_tokens, null);

  // tool linkage: lowercase file tools get file_path; anchors exist
  const calls = byKind('tool_call');
  assert.deepEqual(calls.map((c) => [c.name, c.file_path, c.presentation]), [
    ['read', '/tmp/dsh-project/a.ts', 'default'],
    ['subagent', null, 'default'],
  ]);
  const uuids = new Set(messages.map((m) => m.uuid));
  for (const record of values) {
    if (record.kind === 'tool_call' || record.kind === 'tool_result') assert.ok(uuids.has(record.message_uuid), `dangling ${record.message_uuid}`);
    if (record.kind === 'message') assert.notEqual(record.parent_uuid, record.uuid);
  }

  // the subagent row merges the parent-contributed link and the
  // child-contributed metadata into ONE record (tree units see both sides)
  const subs = byKind('subagent');
  assert.deepEqual(subs.map((s) => [s.agent_id, s.parent_tool_use_id ?? null, s.agent_type ?? null, s.description ?? null]), [
    [CHILD_ID, `${ROOT_ID}:call-2`, 'deepseek-official', 'review helper'],
  ]);

  const session = byKind('session')[0];
  assert.equal(session.id, ROOT_ID);
  assert.equal(session.title, 'Fixture title');
  assert.equal(session.countMode, 'total');
  assert.equal(session.version, '0');
});

// The central invariant of ADR-0011: for EVERY frame split point, a two-phase
// incremental parse converges the database to the full-parse state.
test('two-phase incremental parse converges to the full parse at every frame boundary', () => {
  const totalFrames = rootFrames().length;
  for (let split = 0; split <= totalFrames; split++) {
    const dirFull = makeTempDir('obelisk-eq-full-');
    const providerFull = createDeepseekProvider({ rootDir: writeTree(dirFull) });
    const dbFull = freshDb();
    const unitFull = providerFull.discover({ lastCursor: () => null })[0];
    persist(dbFull, unitFull, providerFull.parse(unitFull, null));

    const dirSplit = makeTempDir('obelisk-eq-split-');
    const sessionsDir = writeTree(dirSplit, { rootFrameCount: split });
    const provider = createDeepseekProvider({ rootDir: sessionsDir });
    const db = freshDb();
    const phase1 = provider.discover({ lastCursor: () => null });
    // split 0 leaves the root headerless: the whole project suppresses this
    // round (fail closed), so phase 1 may legitimately emit nothing.
    assert.ok(phase1.length === 1 || split === 0, `split ${split}: phase 1 discovers the tree`);
    const cursor = phase1.length === 1 ? persist(db, phase1[0], provider.parse(phase1[0], null)) : null;
    writeTree(dirSplit); // append the remaining root frames
    const phase2 = provider.discover({ lastCursor: () => cursor });
    // split == totalFrames means nothing changed: discovery skips the tree.
    if (phase2.length === 1) persist(db, phase2[0], provider.parse(phase2[0], cursor));
    else assert.equal(split, totalFrames, `split ${split}: only the no-change case may skip phase 2`);

    assert.deepEqual(dumpDb(db), dumpDb(dbFull), `split ${split}: database state must equal the full parse`);
    dbFull.close();
    db.close();
  }
});

test('snapshot fallback: truncation and replacement retract stale rows', () => {
  const dir = makeTempDir('obelisk-fallback-');
  const sessionsDir = writeTree(dir);
  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const db = freshDb();
  const unit = provider.discover({ lastCursor: () => null })[0];
  const cursor = persist(db, unit, provider.parse(unit, null));
  const before = dumpDb(db);
  assert.ok(before.messages.length > 0);

  // Truncation: drop the last three root frames (title + final answer + spawn result).
  const rootPath = join(sessionsDir, '--tmp-dsh-project--', 'root-session-1', 'session.jsonl.zstd');
  const buf = readFileSync(rootPath);
  const { frames } = scanZstdFrames(buf);
  writeFileSync(rootPath, buf.subarray(0, frames[frames.length - 3].start));
  const unit2 = provider.discover({ lastCursor: () => cursor })[0];
  const cursor2 = persist(db, unit2, provider.parse(unit2, cursor));
  const afterTrunc = dumpDb(db);
  assert.ok(afterTrunc.messages.length < before.messages.length, 'truncated rows retracted');
  assert.ok(!afterTrunc.messages.some((m) => m.text === 'final answer'));
  assert.equal(afterTrunc.subagents[0]?.parent_tool_use_id ?? null, null, 'spawn link from removed frames is gone');
  assert.ok(afterTrunc.messages.some((m) => m.is_sidechain === 1), 'child sidechain data intact');

  // Replacement with a new inode and MORE frames: full reparse, no splice.
  const grown = [...rootFrames().slice(0, 4), [
    { type: 'user/message', seq: 90, time: 1753005700000, data: { content: [{ type: 'text', text: 'BRAND_NEW' }], source: { kind: 'user' }, role: 'user', id: 'msg-90' } },
  ]];
  const tmp = rootPath + '.tmp';
  writeFileSync(tmp, Buffer.concat(grown.map(mkFrame)));
  renameSync(tmp, rootPath);
  const unit3 = provider.discover({ lastCursor: () => cursor2 })[0];
  persist(db, unit3, provider.parse(unit3, cursor2));
  const afterReplace = dumpDb(db);
  assert.ok(afterReplace.messages.some((m) => m.text === 'BRAND_NEW'));
  assert.ok(!afterReplace.messages.some((m) => m.text === 'file body' && m.content === undefined));
  assert.ok(!afterReplace.tool_results.some((r) => r.content === 'file body'), 'old content does not survive a replacement');
  db.close();
});

test('identity change in the root header retracts the old session', () => {
  const dir = makeTempDir('obelisk-identity-');
  const sessionsDir = writeTree(dir);
  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const db = freshDb();
  const unit = provider.discover({ lastCursor: () => null })[0];
  const cursor = persist(db, unit, provider.parse(unit, null));

  // Rewrite BOTH headers with a different cwd (new scope → new identity).
  // Upstream a subagent inherits its parent's cwd, so a tree's identity moves
  // as a whole.
  const rootPath = join(sessionsDir, '--tmp-dsh-project--', 'root-session-1', 'session.jsonl.zstd');
  const childPath = join(sessionsDir, '--tmp-dsh-project--', 'child-session-1', 'session.jsonl.zstd');
  const frames = rootFrames();
  frames[0] = [{ ...HEADER, cwd: '/tmp/other-project' }];
  const childFrames2 = childFrames();
  childFrames2[0] = [{ ...CHILD_HEADER, cwd: '/tmp/other-project' }];
  const tmp = rootPath + '.tmp';
  writeFileSync(tmp, Buffer.concat(frames.map(mkFrame)));
  renameSync(tmp, rootPath);
  const tmpc = childPath + '.tmp';
  writeFileSync(tmpc, Buffer.concat(childFrames2.map(mkFrame)));
  renameSync(tmpc, childPath);

  const unit2 = provider.discover({ lastCursor: () => cursor })[0];
  persist(db, unit2, provider.parse(unit2, cursor));
  const dump = dumpDb(db);
  assert.equal(dump.sessions.length, 1);
  assert.notEqual(dump.sessions[0].id, ROOT_ID);
  assert.equal(dump.sessions[0].project, '-tmp-other-project');
  assert.ok(!dump.messages.some((m) => m.session_id === ROOT_ID), 'old-identity rows retracted');
  db.close();
});

test('discovery emits a tombstone for an indexed session whose file disappeared', () => {
  const dir = makeTempDir('obelisk-tombstone-');
  const sessionsDir = writeTree(dir);
  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const db = freshDb();
  const unit = provider.discover({ lastCursor: () => null })[0];
  const cursor = persist(db, unit, provider.parse(unit, null));
  assert.equal(dumpDb(db).sessions.length, 1);

  rmSync(join(sessionsDir, '--tmp-dsh-project--'), { recursive: true, force: true });
  const units = provider.discover({
    lastCursor: () => cursor,
    indexedSessions: () => [{ sessionId: ROOT_ID, jsonlPath: unit.key }],
  });
  const tombstone = units.find((u) => (u.retractSessionIds ?? []).includes(ROOT_ID));
  assert.ok(tombstone, 'tombstone unit emitted');
  persist(db, tombstone, provider.parse(tombstone, cursor));
  assert.equal(dumpDb(db).sessions.length, 0);
  assert.equal(dumpDb(db).messages.length, 0);
  db.close();
});

test('parse output assembles and survives a SQLite round-trip (whole tree)', () => {
  const dir = makeTempDir('obelisk-roundtrip-');
  const provider = createDeepseekProvider({ rootDir: writeTree(dir) });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const { values } = drain(provider.parse(unit, null));

  const fresh = assembleSessionDetail(values);
  assert.equal(fresh.session.id, ROOT_ID);
  assert.equal(fresh.session.title, 'Fixture title');
  // The assembled main timeline shows the root's messages; child sidechain
  // messages attach via the subagent on the spawn tool call.
  assert.deepEqual(fresh.messages.map((m) => m.text).filter(Boolean), [
    'inspect the project',
    'doing it',
    '<system-reminder>injected</system-reminder>',
    'final answer',
  ]);
  const subagentCall = fresh.messages.flatMap((m) => m.tool_calls ?? []).find((c) => c.name === 'subagent');
  assert.ok(subagentCall?.subagent);
  assert.equal(subagentCall.subagent.agent_id, CHILD_ID);

  const db = freshDb();
  persist(db, unit, provider.parse(unit, null));
  const persisted = assembleSessionDetail({
    session: db.prepare('SELECT * FROM sessions').get(),
    messages: db.prepare('SELECT * FROM messages ORDER BY timestamp, uuid').all(),
    toolCalls: db.prepare('SELECT * FROM tool_calls').all(),
    toolResults: db.prepare('SELECT * FROM tool_results').all(),
    subagents: db.prepare('SELECT * FROM subagents').all(),
  });
  assert.deepEqual(persisted, fresh);
  db.close();
});

test('parses the real sanitized dsh artifacts end to end', () => {
  const fixtureRoot = new URL('./fixtures/deepseek/sessions', import.meta.url).pathname;
  const provider = createDeepseekProvider({ rootDir: fixtureRoot });
  const units = provider.discover({ lastCursor: () => null });
  assert.equal(units.length, 1); // the real root+child pair is one tree
  const unit = units[0];
  const { values } = drain(provider.parse(unit, null));
  const kinds = new Set(values.map((record) => record.kind));
  assert.ok(kinds.has('session') && kinds.has('message') && kinds.has('tool_call') && kinds.has('tool_result') && kinds.has('subagent'));
  const uuids = new Set(values.filter((r) => r.kind === 'message').map((r) => r.uuid));
  for (const record of values) {
    if (record.kind === 'tool_call' || record.kind === 'tool_result') assert.ok(uuids.has(record.message_uuid));
    if (record.kind === 'message') assert.notEqual(record.parent_uuid, record.uuid);
  }
  const db = freshDb();
  persist(db, unit, provider.parse(unit, null));
  const persisted = assembleSessionDetail({
    session: db.prepare('SELECT * FROM sessions').get(),
    messages: db.prepare('SELECT * FROM messages ORDER BY timestamp, uuid').all(),
    toolCalls: db.prepare('SELECT * FROM tool_calls').all(),
    toolResults: db.prepare('SELECT * FROM tool_results').all(),
    subagents: db.prepare('SELECT * FROM subagents').all(),
  });
  assert.deepEqual(persisted, assembleSessionDetail(values));
  db.close();
});

test('raw() resolves uuids back to source lines, scope-aware and sidechain-aware', () => {
  const dir = makeTempDir('obelisk-raw-');
  const sessionsDir = writeTree(dir);
  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const { values } = drain(provider.parse(unit, null));

  const userMsg = values.find((r) => r.kind === 'message' && r.text === 'inspect the project');
  const raw = provider.raw({ source: 'deepseek', messageUuid: userMsg.uuid, session: { jsonl_path: unit.key }, agentId: null });
  assert.ok(raw.text.includes('inspect the project'));

  // Sidechain message: uuid names the child session; agentId steers the lookup
  // to the child's file even though the session row points at the root file.
  const childMsg = values.find((r) => r.kind === 'message' && r.text === 'review the code');
  const childRaw = provider.raw({ source: 'deepseek', messageUuid: childMsg.uuid, session: { jsonl_path: unit.key }, agentId: childMsg.agent_id });
  assert.ok(childRaw.text.includes('review the code'));

  assert.equal(provider.raw({ source: 'deepseek', messageUuid: 'deepseek:bogus', session: null, agentId: null }), null);
});

test('plaintext logs index the same content as zstd-framed logs', () => {
  const dirPlain = makeTempDir('obelisk-plain-');
  const dirZstd = makeTempDir('obelisk-zstd-');
  const providerPlain = createDeepseekProvider({ rootDir: writeTree(dirPlain, { zstd: false }) });
  const providerZstd = createDeepseekProvider({ rootDir: writeTree(dirZstd, { zstd: true }) });
  const dump = (provider) => {
    const db = freshDb();
    const unit = provider.discover({ lastCursor: () => null })[0];
    persist(db, unit, provider.parse(unit, null));
    const d = dumpDb(db);
    db.close();
    return d;
  };
  assert.deepEqual(dump(providerPlain), dump(providerZstd));
});

test('resolves the sessions root from $DSH_HOME (blank counts as unset)', () => {
  const original = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = '/tmp/custom-dsh-home';
    assert.equal(createDeepseekProvider().descriptor.defaultRoot, join('/tmp/custom-dsh-home', 'sessions'));
    process.env.DSH_HOME = '   ';
    assert.equal(createDeepseekProvider().descriptor.defaultRoot, join(homedir(), '.dsh', 'sessions'));
    delete process.env.DSH_HOME;
    assert.equal(createDeepseekProvider().descriptor.defaultRoot, join(homedir(), '.dsh', 'sessions'));
  } finally {
    if (original === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = original;
  }
});

test('one-shot subagent descriptors fall back to provider for agent_type', () => {
  const dir = makeTempDir('obelisk-oneshot-');
  const sessionsDir = join(dir, 'sessions');
  const childDir = join(sessionsDir, '--tmp-dsh-project--', 'one-shot-child');
  mkdirSync(childDir, { recursive: true });
  const rootDir2 = join(sessionsDir, '--tmp-dsh-project--', 'root-session-1');
  mkdirSync(rootDir2, { recursive: true });
  writeFileSync(join(rootDir2, 'session.jsonl'), [JSON.stringify(HEADER)].join('\n') + '\n');
  writeFileSync(join(childDir, 'session.jsonl'), [
    JSON.stringify({ ...CHILD_HEADER, id: 'one-shot-child' }),
    JSON.stringify({ type: 'subagent/descriptor', seq: 0, time: 1753005604200, data: { version: 2, mode: 'one-shot', provider: 'code', label: 'fix the bug' } }),
    JSON.stringify({ type: 'user/message', seq: 1, time: 1753005604300, data: { content: [{ type: 'text', text: 'do it' }], source: { kind: 'user' }, role: 'user', id: 'm-1' } }),
  ].join('\n') + '\n');

  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const { values } = drain(provider.parse(unit, null));
  const sub = values.find((r) => r.kind === 'subagent' && r.agent_type !== undefined && r.agent_type !== null);
  assert.equal(sub.agent_type, 'code');
  assert.equal(sub.description, 'fix the bug');
});

test('malformed lines and packed chunk rows never abort the parse', () => {
  const dir = makeTempDir('obelisk-malformed-');
  const sessionsDir = join(dir, 'sessions');
  const sessionDir = join(sessionsDir, '--tmp-dsh-project--', 'bad-session');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'session.jsonl'), [
    JSON.stringify({ ...HEADER, id: 'bad-session' }),
    '{"type":"user/message","seq":1,BROKEN',
    JSON.stringify({ type: 'text-chunks', seq0: 10, time0: 1753005601500, data: { turn: 1, step: 1, index: 0, dt: [5], texts: ['a', 'b', 'c'] } }), // dt/members arity mismatch
    JSON.stringify({ type: 'user/message', seq: 2, time: 1753005602000, data: { content: [{ type: 'text', text: 'survives' }], source: { kind: 'user' }, role: 'user', id: 'm-2' } }),
  ].join('\n') + '\n');
  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const { values } = drain(provider.parse(unit, null));
  assert.ok(values.find((r) => r.kind === 'message' && r.text === 'survives'));
});

// ---- round-4 review regressions ----

test('changed-path reconciliation routes a deleted child to its tree', () => {
  const dir = makeTempDir('obelisk-delchild-');
  const sessionsDir = writeTree(dir);
  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const db = freshDb();
  const unit = provider.discover({ lastCursor: () => null })[0];
  const cursor = persist(db, unit, provider.parse(unit, null));
  assert.ok(dumpDb(db).messages.some((m) => m.is_sidechain === 1));

  // Delete the child file; the watcher reports the DELETED path.
  const childPath = join(sessionsDir, '--tmp-dsh-project--', 'child-session-1', 'session.jsonl.zstd');
  rmSync(childPath);
  const units = provider.discover({ lastCursor: () => cursor, changedPaths: [childPath] });
  assert.equal(units.length, 1, 'deleted child must route to its tree');
  persist(db, units[0], provider.parse(units[0], cursor));
  assert.ok(!dumpDb(db).messages.some((m) => m.is_sidechain === 1), 'stale sidechain rows retracted');
  assert.ok(dumpDb(db).messages.some((m) => m.text === 'inspect the project'), 'root rows kept');
  db.close();
});

test('a moved root keeps its session (tombstones key on identity, not path)', () => {
  const dir = makeTempDir('obelisk-move-');
  const sessionsDir = writeTree(dir);
  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const db = freshDb();
  const store = cursorStore();
  const unit = provider.discover({ lastCursor: () => null })[0];
  store.set(unit.key, persist(db, unit, provider.parse(unit, null)));

  // Move the whole project dir (both members) to a new directory name. The
  // new unit key has NO cursor in production — convergence must not depend on
  // finding the old one.
  renameSync(join(sessionsDir, '--tmp-dsh-project--'), join(sessionsDir, '--moved--'));
  const units = provider.discover({
    ...store.ctx(),
    indexedSessions: () => [{ sessionId: ROOT_ID, jsonlPath: unit.key }],
  });
  assert.ok(!units.some((u) => (u.retractSessionIds ?? []).length > 0), 'no tombstone for a moved tree');
  assert.equal(units.length, 1);
  // lastCursor(new key) is null in production; parse must handle it.
  persist(db, units[0], provider.parse(units[0], store.ctx().lastCursor(units[0].key)));
  assert.equal(dumpDb(db).sessions.length, 1, 'session survives the move');
  assert.equal(dumpDb(db).sessions[0].id, ROOT_ID);
  db.close();
});

test('a moved AND truncated tree converges (stale rows retracted despite the path change)', () => {
  const dir = makeTempDir('obelisk-movetrunc-');
  const sessionsDir = writeTree(dir);
  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const db = freshDb();
  const store = cursorStore();
  const unit = provider.discover({ lastCursor: () => null })[0];
  store.set(unit.key, persist(db, unit, provider.parse(unit, null)));

  renameSync(join(sessionsDir, '--tmp-dsh-project--'), join(sessionsDir, '--moved--'));
  // Truncate the moved root: drop the last three frames (spawn result + final).
  const rootPath = join(sessionsDir, '--moved--', 'root-session-1', 'session.jsonl.zstd');
  const buf = readFileSync(rootPath);
  const { frames } = scanZstdFrames(buf);
  writeFileSync(rootPath, buf.subarray(0, frames[frames.length - 3].start));

  // The new path has no cursor — the fallback must still retract stale rows.
  const units = provider.discover(store.ctx());
  assert.equal(units.length, 1);
  persist(db, units[0], provider.parse(units[0], null));
  const dump = dumpDb(db);
  assert.ok(!dump.messages.some((m) => m.text === 'final answer'), 'stale rows retracted');
  assert.ok(dump.messages.some((m) => m.text === 'inspect the project'), 'kept rows intact');
  assert.equal(
    dump.sessions[0].message_count,
    dump.messages.filter((m) => m.agent_id === null && m.content_type !== 'tool_use').length,
    'message_count matches the actual rows (anchors are structural, not counted)',
  );
  db.close();
});

test('an unreadable member suppresses its whole project (fail closed, no partial snapshot)', () => {
  const dir = makeTempDir('obelisk-failclosed-');
  const sessionsDir = writeTree(dir);
  // A second, unrelated tree in ANOTHER project stays live.
  const otherDir = join(sessionsDir, '--other--', 'other-session');
  mkdirSync(otherDir, { recursive: true });
  writeFileSync(join(otherDir, 'session.jsonl'), [
    JSON.stringify({ type: 'session', version: 0, id: 'other-session', createdAt: 1753005600000, cwd: '/other', delegationDepth: 0 }),
    JSON.stringify({ type: 'user/message', seq: 1, time: 1753005601000, data: { content: [{ type: 'text', text: 'other' }], source: { kind: 'user' }, role: 'user', id: 'm-1' } }),
  ].join('\n') + '\n');

  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const db = freshDb();
  const store = cursorStore();
  for (const unit of provider.discover({ lastCursor: () => null })) {
    store.set(unit.key, persist(db, unit, provider.parse(unit, null)));
  }
  const before = dumpDb(db);

  // Corrupt the child file (valid header frame, invalid frame magic later).
  const childPath = join(sessionsDir, '--tmp-dsh-project--', 'child-session-1', 'session.jsonl.zstd');
  writeFileSync(childPath, Buffer.concat([readFileSync(childPath), Buffer.from('%%%not-a-frame%%%')]));

  const issues = [];
  // Fresh discovery (no cursors): the corrupted project suppresses its tree,
  // the unrelated tree still yields a unit.
  const units = provider.discover({ lastCursor: () => null, reportIncompleteInventory: (issue) => issues.push(issue) });
  assert.ok(issues.length > 0, 'inventory issue reported');
  assert.ok(!units.some((u) => u.sessionId === ROOT_ID), 'affected tree suppressed');
  assert.ok(units.some((u) => u.sessionId.includes('other-session')), 'unrelated tree still discovered');
  assert.deepEqual(dumpDb(db), before, 'last-good snapshot preserved');
  db.close();
});

test('an in-place edit of an early frame invalidates the prefix proof', () => {
  const dir = makeTempDir('obelisk-prefix-');
  const sessionsDir = writeTree(dir);
  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const db = freshDb();
  const unit = provider.discover({ lastCursor: () => null })[0];
  const cursor = persist(db, unit, provider.parse(unit, null));

  // Rewrite frame 1 (tampered text) but keep the last committed frame
  // byte-identical, then append a new frame — a pure boundary hash would pass.
  const rootPath = join(sessionsDir, '--tmp-dsh-project--', 'root-session-1', 'session.jsonl.zstd');
  const frames = rootFrames();
  frames[1] = [
    { type: 'request/header', seq: 0, time: 1753005600100, data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }, reason: 'initial' } },
    { type: 'user/message', seq: 1, time: 1753005601000, data: { content: [{ type: 'text', text: 'TAMPERED' }], source: { kind: 'user' }, role: 'user', id: 'msg-1' } },
  ];
  frames.push([{ type: 'user/message', seq: 99, time: 1753005700000, data: { content: [{ type: 'text', text: 'appended' }], source: { kind: 'user' }, role: 'user', id: 'm-99' } }]);
  const tmp = rootPath + '.tmp';
  writeFileSync(tmp, Buffer.concat(frames.map(mkFrame)));
  renameSync(tmp, rootPath);

  const unit2 = provider.discover({ lastCursor: () => cursor })[0];
  persist(db, unit2, provider.parse(unit2, cursor));
  const texts = dumpDb(db).messages.map((m) => m.text);
  assert.ok(texts.includes('TAMPERED'), 'tampered early frame is re-indexed');
  assert.ok(!texts.includes('inspect the project'), 'no OLD_PREFIX splice');
  db.close();
});

test('a provisional anchor is stable across runs (checkpoint remembers it)', () => {
  const dir = makeTempDir('obelisk-provisional-');
  const sessionsDir = join(dir, 'sessions');
  const sessionDir = join(sessionsDir, '--tmp-dsh-project--', 'prov-session');
  mkdirSync(sessionDir, { recursive: true });
  const path = join(sessionDir, 'session.jsonl');
  // An aborted step: durable tool/calls but no assistant/message ever.
  const first = [
    { type: 'session', version: 0, id: 'prov-session', createdAt: 1753005600000, cwd: '/tmp/dsh-project', delegationDepth: 0 },
    { type: 'user/message', seq: 1, time: 1753005601000, data: { content: [{ type: 'text', text: 'go' }], source: { kind: 'user' }, role: 'user', id: 'm-1' } },
    { type: 'tool/call', seq: 2, time: 1753005601100, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' } },
  ];
  writeFileSync(path, first.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const db = freshDb();
  const unit = provider.discover({ lastCursor: () => null })[0];
  const cursor = persist(db, unit, provider.parse(unit, null));
  const anchorBefore = db.prepare("SELECT uuid, parent_uuid, timestamp FROM messages WHERE content_type='tool_use'").get();
  assert.ok(anchorBefore);

  // A second call of the same aborted step arrives in a later window.
  writeFileSync(path, [...first, { type: 'tool/call', seq: 3, time: 1753005601500, data: { turn: 1, step: 1, callId: 'c2', name: 'bash', arguments: '{}' } }].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const unit2 = provider.discover({ lastCursor: () => cursor })[0];
  persist(db, unit2, provider.parse(unit2, cursor));
  const anchorAfter = db.prepare("SELECT uuid, parent_uuid, timestamp FROM messages WHERE content_type='tool_use'").get();
  assert.deepEqual(anchorAfter, anchorBefore, 'provisional anchor row is not rewritten across runs');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM tool_calls').get().c, 2);
  db.close();
});

test('headerless artifacts are reported as incomplete inventory, not silently skipped', () => {
  const dir = makeTempDir('obelisk-headerless-');
  const sessionsDir = join(dir, 'sessions');
  const sessionDir = join(sessionsDir, '--proj--', 'empty-session');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'session.jsonl'), '');
  const issues = [];
  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const units = provider.discover({ lastCursor: () => null, reportIncompleteInventory: (issue) => issues.push(issue) });
  assert.equal(units.length, 0);
  assert.equal(issues.length, 1);
  assert.ok(issues[0].path.endsWith('session.jsonl'));
});

test('fixtures stay free of user-identifying absolute paths', () => {
  const fixtureRoot = new URL('./fixtures/deepseek/sessions', import.meta.url).pathname;
  for (const proj of readdirSync(fixtureRoot)) {
    for (const sid of readdirSync(join(fixtureRoot, proj))) {
      const buf = readFileSync(join(fixtureRoot, proj, sid, 'session.jsonl.zstd'));
      const { frames } = scanZstdFrames(buf);
      for (const frame of frames) {
        const decoder = createZstdFrameDecoder();
        let text = '';
        try {
          for (const decoded of decoder.decode(buf, [frame])) text += decoded.toString('utf8');
        } finally {
          decoder.close();
        }
        assert.ok(!/\/Users\/|tomiya/.test(text), `fixture ${sid} leaks a user path`);
      }
    }
  }
});

test('duplicate files with the same scoped identity are one member (no double counting)', () => {
  const dir = makeTempDir('obelisk-dup-');
  const sessionsDir = join(dir, 'sessions');
  for (const name of ['root-session-1', 'root-session-1-copy']) {
    const d = join(sessionsDir, '--tmp-dsh-project--', name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'session.jsonl'), [
      JSON.stringify(HEADER),
      JSON.stringify({ type: 'user/message', seq: 1, time: 1753005601000, data: { content: [{ type: 'text', text: 'one' }], source: { kind: 'user' }, role: 'user', id: 'm-1' } }),
    ].join('\n') + '\n');
  }
  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const db = freshDb();
  const units = provider.discover({ lastCursor: () => null });
  assert.equal(units.length, 1, 'identical copies dedupe to one member');
  persist(db, units[0], provider.parse(units[0], null));
  const dump = dumpDb(db);
  assert.equal(dump.messages.length, 1);
  assert.equal(dump.sessions[0].message_count, 1); // ADR-0007: count matches rows
  db.close();
});

test('divergent copies of one identity fail closed (no arbitrary winner overwrites last-good)', () => {
  const dir = makeTempDir('obelisk-divergent-');
  const sessionsDir = join(dir, 'sessions');
  const write = (name, text) => {
    const d = join(sessionsDir, '--tmp-dsh-project--', name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'session.jsonl'), [
      JSON.stringify(HEADER),
      JSON.stringify({ type: 'user/message', seq: 1, time: 1753005601000, data: { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user', id: 'm-1' } }),
    ].join('\n') + '\n');
  };
  write('root-session-1', 'FROM_A');
  write('root-session-1-copy', 'FROM_B_DIFFERENT');
  const issues = [];
  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const units = provider.discover({ lastCursor: () => null, reportIncompleteInventory: (i) => issues.push(i) });
  assert.equal(units.length, 0, 'divergent copies publish nothing');
  assert.ok(issues.some((i) => i.error.includes('Divergent')));
});

// NOTE: this uses a SYNTHETIC event order (durable tool/call before the step's
// assistant/message). Real dsh logs persist the assistant/message first; the
// synthetic order is a robustness check for the seed-parent rule, not evidence
// of real-order coverage (that is covered by the split-point equivalence test).
test('a step straddling two runs does not create a parent cycle (text <-> tool_use)', () => {
  const dir = makeTempDir('obelisk-cycle-');
  const sessionsDir = join(dir, 'sessions');
  const sessionDir = join(sessionsDir, '--tmp-dsh-project--', 'cycle-session');
  mkdirSync(sessionDir, { recursive: true });
  const path = join(sessionDir, 'session.jsonl');
  // Window 1: user message + the durable tool/call (provisional anchor,
  // parent = user message).
  const first = [
    { type: 'session', version: 0, id: 'cycle-session', createdAt: 1753005600000, cwd: '/tmp/dsh-project', delegationDepth: 0 },
    { type: 'user/message', seq: 1, time: 1753005601000, data: { content: [{ type: 'text', text: 'go' }], source: { kind: 'user' }, role: 'user', id: 'm-1' } },
    { type: 'tool/call', seq: 2, time: 1753005601100, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' } },
  ];
  writeFileSync(path, first.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const db = freshDb();
  const store = cursorStore();
  let unit = provider.discover({ lastCursor: () => null })[0];
  store.set(unit.key, persist(db, unit, provider.parse(unit, null)));

  // Window 2: the step's assistant/message arrives (canonical anchor + text).
  const second = [{ type: 'assistant/message', seq: 3, time: 1753005602000, data: {
    turn: 1, step: 1,
    message: { role: 'assistant', content: [
      { type: 'text', text: 'done' },
      { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
    ], source: { kind: 'model', model: 'm' }, id: 'a-1' },
    usage: { inputTokens: 9, outputTokens: 3 },
  } }];
  writeFileSync(path, first.concat(second).map((e) => JSON.stringify(e)).join('\n') + '\n');
  unit = provider.discover(store.ctx())[0];
  store.set(unit.key, persist(db, unit, provider.parse(unit, store.ctx().lastCursor(unit.key))));

  // Walk every parent chain to the root: no cycles, finite depth.
  const rows = db.prepare('SELECT uuid, parent_uuid FROM messages').all();
  const byUuid = new Map(rows.map((r) => [r.uuid, r.parent_uuid]));
  for (const row of rows) {
    const seen = new Set();
    let cur = row.uuid;
    while (byUuid.get(cur)) {
      assert.ok(!seen.has(cur), `parent cycle at ${cur}`);
      seen.add(cur);
      cur = byUuid.get(cur);
    }
  }
  // And the chain matches the full-parse shape exactly.
  const dbFull = freshDb();
  const unitF = provider.discover({ lastCursor: () => null })[0];
  persist(dbFull, unitF, provider.parse(unitF, null));
  const chainOf = (dbX) => dbX.prepare('SELECT uuid, parent_uuid FROM messages ORDER BY uuid').all();
  assert.deepEqual(chainOf(db), chainOf(dbFull));
  // The canonical row won: anchor carries the assistant's model/usage.
  const anchor = db.prepare("SELECT model, input_tokens FROM messages WHERE content_type='tool_use'").get();
  assert.equal(anchor.model, 'm');
  db.close();
  dbFull.close();
});

test('an offline source root reports incomplete inventory and emits no tombstones', () => {
  const dir = makeTempDir('obelisk-offline-');
  const sessionsDir = writeTree(dir);
  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const db = freshDb();
  const unit = provider.discover({ lastCursor: () => null })[0];
  persist(db, unit, provider.parse(unit, null));

  // Source root goes away entirely (offline/unmounted).
  rmSync(sessionsDir, { recursive: true, force: true });
  const issues = [];
  const units = provider.discover({
    lastCursor: () => null,
    reportIncompleteInventory: (i) => issues.push(i),
    indexedSessions: () => [{ sessionId: ROOT_ID, jsonlPath: unit.key }],
  });
  assert.ok(issues.length > 0, 'offline root reported');
  assert.ok(!units.some((u) => (u.retractSessionIds ?? []).length > 0), 'no tombstone while inventory is incomplete');
  assert.equal(dumpDb(db).sessions.length, 1, 'last-good snapshot preserved');
  db.close();
});

test('a deleted root with a surviving child becomes a tombstone, not a phantom child-only snapshot', () => {
  const dir = makeTempDir('obelisk-phantom-');
  const sessionsDir = writeTree(dir);
  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const db = freshDb();
  const store = cursorStore();
  const unit = provider.discover({ lastCursor: () => null })[0];
  store.set(unit.key, persist(db, unit, provider.parse(unit, null)));

  rmSync(join(sessionsDir, '--tmp-dsh-project--', 'root-session-1', 'session.jsonl.zstd'));
  const units = provider.discover({
    ...store.ctx(),
    indexedSessions: () => [{ sessionId: ROOT_ID, jsonlPath: unit.key }],
  });
  assert.ok(!units.some((u) => u.sessionId === ROOT_ID && (u.retractSessionIds ?? []).length === 0),
    'no live child-only unit for the orphan');
  const tombstone = units.find((u) => (u.retractSessionIds ?? []).includes(ROOT_ID));
  assert.ok(tombstone, 'tombstone emitted for the deleted root identity');
  persist(db, tombstone, provider.parse(tombstone, null));
  assert.equal(dumpDb(db).sessions.length, 0);
  db.close();
});

test('an unknown higher header version is skipped and recorded, never parsed as v0', () => {
  const dir = makeTempDir('obelisk-version-');
  const sessionsDir = join(dir, 'sessions');
  const sessionDir = join(sessionsDir, '--tmp-dsh-project--', 'v99-session');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'session.jsonl'), [
    JSON.stringify({ type: 'session', version: 99, id: 'v99-session', createdAt: 1753005600000, cwd: '/tmp/dsh-project', delegationDepth: 0 }),
    JSON.stringify({ type: 'user/message', seq: 1, time: 1753005601000, data: { content: [{ type: 'text', text: 'future' }], source: { kind: 'user' }, role: 'user', id: 'm-1' } }),
  ].join('\n') + '\n');
  const issues = [];
  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const units = provider.discover({ lastCursor: () => null, reportIncompleteInventory: (i) => issues.push(i) });
  assert.equal(units.length, 0);
  assert.ok(issues.some((i) => i.error.includes('version 99')));
});

test('a permission-denied session dir is an inventory error, never a deletion', () => {
  const dir = makeTempDir('obelisk-eacces-');
  const sessionsDir = writeTree(dir);
  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const db = freshDb();
  const store = cursorStore();
  const unit = provider.discover({ lastCursor: () => null })[0];
  store.set(unit.key, persist(db, unit, provider.parse(unit, null)));
  const before = dumpDb(db);

  // Remove traverse permission from the child's session dir: the file exists
  // but stat() fails with EACCES — existsSync would report "gone".
  const childDir = join(sessionsDir, '--tmp-dsh-project--', 'child-session-1');
  chmodSync(childDir, 0o000);
  try {
    const issues = [];
    const units = provider.discover({
      ...store.ctx(),
      reportIncompleteInventory: (i) => issues.push(i),
      indexedSessions: () => [{ sessionId: ROOT_ID, jsonlPath: unit.key }],
    });
    assert.ok(issues.length > 0, 'permission error reported as inventory issue');
    assert.ok(!units.some((u) => (u.retractSessionIds ?? []).length > 0), 'no tombstone on a permission error');
    assert.deepEqual(dumpDb(db), before, 'last-good snapshot preserved');
  } finally {
    chmodSync(childDir, 0o755);
  }
  db.close();
});

test('a watcher report of only the OLD path after a move reconciles provenance immediately', () => {
  const dir = makeTempDir('obelisk-movehint-');
  const sessionsDir = writeTree(dir);
  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const db = freshDb();
  const store = cursorStore();
  const unit = provider.discover({ lastCursor: () => null })[0];
  store.set(unit.key, persist(db, unit, provider.parse(unit, null)));

  renameSync(join(sessionsDir, '--tmp-dsh-project--'), join(sessionsDir, '--moved--'));
  // The watcher reports only the old (now nonexistent) root path.
  const units = provider.discover({ ...store.ctx(), changedPaths: [unit.key] });
  assert.equal(units.length, 1, 'unroutable change falls back to reconciling the tree');
  const newUnit = units[0];
  persist(db, newUnit, provider.parse(newUnit, store.ctx().lastCursor(newUnit.key)));
  const session = db.prepare('SELECT jsonl_path FROM sessions').get();
  assert.ok(session.jsonl_path.includes('--moved--'), 'provenance updated immediately');
  db.close();
});
