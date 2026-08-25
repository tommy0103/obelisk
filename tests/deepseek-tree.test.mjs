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
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { constants, zstdCompressSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

import { createDeepseekProvider } from '../packages/core/src/providers/deepseek.ts';
import { persist } from '../packages/core/src/persist.ts';
import { assembleSessionDetail } from '../packages/core/src/session-detail.ts';
import { scanZstdFrames } from '../packages/core/src/vendor/dsh-zstd.ts';
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
    assert.equal(phase1.length, 1, `split ${split}: phase 1 discovers the tree`);
    const cursor = persist(db, phase1[0], provider.parse(phase1[0], null));
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
