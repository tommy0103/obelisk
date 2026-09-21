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
import { appendFileSync, chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants, zstdCompressSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

import { Context } from '@deepseek-ai/cordis';
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl';

import { createDeepseekProvider, SESSION_FILE_RE } from '../packages/core/src/providers/deepseek.ts';
import { persist } from '../packages/core/src/persist.ts';
import { createQueryApi } from '../packages/core/src/query.ts';
import { assembleSessionDetail } from '../packages/core/src/session-detail.ts';
import { createZstdFrameDecoder, scanZstdFrames } from '../packages/core/src/vendor/dsh-zstd.ts';
import { makeTempDir } from './temp-dirs.mjs';

const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');

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

// Identity is scope-derived and scope normalization is host-specific
// (node:path normalize differs on Windows), so derive the expected ids from a
// real discovery probe instead of hardcoding a POSIX hash.
const PROBE = (() => {
  const dir = makeTempDir('obelisk-tree-probe-');
  const provider = createDeepseekProvider({ rootDir: writeTree(dir) });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const child = unit.meta.members.find((m) => m.agentId !== null);
  return { ROOT: unit.sessionId, CHILD: child.agentId };
})();
const ROOT_ID = PROBE.ROOT;
const CHILD_ID = PROBE.CHILD;

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

test('seeded child indexes only events after its inherited prefix', async () => {
  const dir = makeTempDir('obelisk-seeded-child-');
  const sessionsDir = join(dir, 'sessions');
  const cwd = join(dir, 'project');
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  await ctx.plugin(JsonlSessionPersistence, {
    root: sessionsDir,
    compression: 'none',
    packChunks: false,
    writeBatchMaxDelayMs: 1,
  });
  const rootSession = ctx.sessions.create(SessionId('seed-root'), { meta: { cwd } });
  rootSession.append('turn/start', { turn: 1 });
  rootSession.append('step/start', { turn: 1, step: 1 });
  rootSession.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'parent inherited request' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' });
  rootSession.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'parent response' }],
      source: { provider: 'mock', model: 'mock' },
    }),
  }, { surfaceOp: 'append' });
  rootSession.append('step/end', { turn: 1, step: 1 });
  const rootEnd = rootSession.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  await ctx.sessions.flush(rootSession);

  const child = ctx.sessions.fork(rootSession, rootEnd.seq, SessionId('seed-child'));
  child.append('turn/start', { turn: 2 });
  child.append('step/start', { turn: 2, step: 1 });
  child.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'child-owned request' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' });
  child.append('assistant/message', {
    turn: 2,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'child-owned response' }],
      source: { provider: 'mock', model: 'mock' },
    }),
  }, { surfaceOp: 'append' });
  child.append('step/end', { turn: 2, step: 1 });
  child.append('turn/end', { turn: 2, reason: { kind: 'completed' } });
  await ctx.sessions.flush(child);

  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const unit = provider.discover({ lastCursor: () => null })[0];
  assert.ok(unit);
  const values = drain(provider.parse(unit, null)).values;
  const childMessages = values.filter(value => value.kind === 'message' && value.agent_id !== null);
  assert.deepEqual(childMessages.map(message => message.text).filter(Boolean).sort(), [
    'child-owned request',
    'child-owned response',
  ].sort());
  assert.equal(childMessages.some(message => message.text === 'parent inherited request'), false);
  const direct = assembleSessionDetail(values);
  const db = freshDb();
  persist(db, unit, provider.parse(unit, null));
  const roundTripped = assembleSessionDetail({
    session: db.prepare('SELECT * FROM sessions').get(),
    messages: db.prepare('SELECT * FROM messages ORDER BY timestamp, uuid').all(),
    toolCalls: db.prepare('SELECT * FROM tool_calls').all(),
    toolResults: db.prepare('SELECT * FROM tool_results').all(),
    subagents: db.prepare('SELECT * FROM subagents').all(),
  });
  assert.deepEqual(roundTripped, direct);
  const api = createQueryApi(db);
  const scoped = api.search('child owned', { sessionId: unit.sessionId, limit: 10 });
  assert.ok(scoped.length > 0);
  assert.ok(scoped.every(hit => hit.session.id === unit.sessionId));
  const childAnchor = childMessages.find(message => message.text === 'child-owned response');
  assert.ok(childAnchor);
  assert.equal(api.context(childAnchor.uuid).message.uuid, childAnchor.uuid);
  db.close();
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
  const fixtureRoot = fileURLToPath(new URL('./fixtures/deepseek/sessions', import.meta.url));
  const provider = createDeepseekProvider({ rootDir: fixtureRoot });
  const units = provider.discover({ lastCursor: () => null });
  // The fixture root also carries the generated v2/v3 scenarios (--dsh-v3--,
  // ADR-0014); this test covers the original v0 root+child pair.
  const unit = units.find((u) => u.meta.rootRawId === 'session-5f3c68cc-064b-4981-8c2b-8fbbce0451b3');
  assert.ok(unit, 'the v0 fixture tree is discovered');
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
  const fixtureRoot = fileURLToPath(new URL('./fixtures/deepseek/sessions', import.meta.url));
  for (const proj of readdirSync(fixtureRoot)) {
    for (const sid of readdirSync(join(fixtureRoot, proj))) {
      // Canonical artifacts only, any generation and either compression
      // (ADR-0014): skip session.lock, staging tmp files, and non-artifacts.
      // The basename rule is the adapter's own exported regex — restating it
      // here would silently scan the wrong files if the source changed.
      for (const entry of readdirSync(join(fixtureRoot, proj, sid))) {
        if (!SESSION_FILE_RE.test(entry)) continue;
        const text = entry.endsWith('.zstd')
          ? (() => {
            const buf = readFileSync(join(fixtureRoot, proj, sid, entry));
            const { frames } = scanZstdFrames(buf);
            let out = '';
            for (const frame of frames) {
              const decoder = createZstdFrameDecoder();
              try {
                for (const decoded of decoder.decode(buf, [frame])) out += decoded.toString('utf8');
              } finally {
                decoder.close();
              }
            }
            return out;
          })()
          : readFileSync(join(fixtureRoot, proj, sid, entry), 'utf8');
        assert.ok(!/\/Users\/|tomiya/.test(text), `fixture ${sid}/${entry} leaks a user path`);
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

test('a permission-denied session dir is an inventory error, never a deletion', { skip: process.platform === 'win32' }, () => {
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

test('old-path-only move report with a sibling tree still reconciles the moved tree', () => {
  const dir = makeTempDir('obelisk-movesibling-');
  const sessionsDir = join(dir, 'sessions');
  // Two trees in the SAME project dir (same cwd, different session ids).
  for (const sid of ['root-session-1', 'root-session-2']) {
    const d = join(sessionsDir, '--tmp-dsh-project--', sid);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'session.jsonl'), [
      JSON.stringify({ ...HEADER, id: sid }),
      JSON.stringify({ type: 'user/message', seq: 1, time: 1753005601000, data: { content: [{ type: 'text', text: `from ${sid}` }], source: { kind: 'user' }, role: 'user', id: `m-${sid}` } }),
    ].join('\n') + '\n');
  }
  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const db = freshDb();
  const store = cursorStore();
  for (const unit of provider.discover({ lastCursor: () => null })) {
    store.set(unit.key, persist(db, unit, provider.parse(unit, null)));
  }
  assert.equal(dumpDb(db).sessions.length, 2);

  // Move tree 2 to a new project dir; the watcher reports only the OLD root
  // path — and the old project dir still hosts tree 1.
  const movedFrom = join(sessionsDir, '--tmp-dsh-project--', 'root-session-2', 'session.jsonl');
  mkdirSync(join(sessionsDir, '--moved--'), { recursive: true });
  renameSync(join(sessionsDir, '--tmp-dsh-project--', 'root-session-2'), join(sessionsDir, '--moved--', 'root-session-2'));
  const id2 = `deepseek:root-session-2:${ROOT_ID.split(':')[2]}`;
  const units = provider.discover({
    ...store.ctx(),
    changedPaths: [movedFrom],
    indexedSessions: () => [
      { sessionId: ROOT_ID, jsonlPath: join(sessionsDir, '--tmp-dsh-project--', 'root-session-1', 'session.jsonl') },
      { sessionId: id2, jsonlPath: movedFrom },
    ],
  });
  assert.ok(units.some((u) => u.sessionId === id2), 'moved tree reconciled despite the sibling tree in the old dir');
  assert.ok(!units.some((u) => (u.retractSessionIds ?? []).includes(id2)), 'no tombstone for the moved tree');
  const movedUnit = units.find((u) => u.sessionId === id2);
  persist(db, movedUnit, provider.parse(movedUnit, store.ctx().lastCursor(movedUnit.key)));
  const row = db.prepare('SELECT jsonl_path FROM sessions WHERE id=?').get(id2);
  assert.ok(row.jsonl_path.includes('--moved--'), 'provenance updated');
  assert.equal(dumpDb(db).sessions.length, 2);
  db.close();
});

test('a directory-level rename event triggers reconciliation (not dropped by the suffix filter)', () => {
  const dir = makeTempDir('obelisk-direvent-');
  const sessionsDir = writeTree(dir);
  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const db = freshDb();
  const store = cursorStore();
  const unit = provider.discover({ lastCursor: () => null })[0];
  store.set(unit.key, persist(db, unit, provider.parse(unit, null)));

  renameSync(join(sessionsDir, '--tmp-dsh-project--'), join(sessionsDir, '--renamed--'));
  // Watcher reports the directory paths, not the files inside.
  const units = provider.discover({
    ...store.ctx(),
    changedPaths: [join(sessionsDir, '--tmp-dsh-project--'), join(sessionsDir, '--tmp-dsh-project--', 'root-session-1')],
    indexedSessions: () => [{ sessionId: ROOT_ID, jsonlPath: unit.key }],
  });
  assert.equal(units.length, 1, 'directory events reconcile the tree');
  persist(db, units[0], provider.parse(units[0], store.ctx().lastCursor(units[0].key)));
  const row = db.prepare('SELECT jsonl_path FROM sessions').get();
  assert.ok(row.jsonl_path.includes('--renamed--'));
  db.close();
});

test('a permission-denied root on FIRST index reports an inventory issue (no silent empty)', { skip: process.platform === 'win32' }, () => {
  const dir = makeTempDir('obelisk-rooteacces-');
  const sessionsDir = join(dir, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  chmodSync(sessionsDir, 0o000); // readdir will fail with EACCES
  try {
    const issues = [];
    const provider = createDeepseekProvider({ rootDir: sessionsDir });
    const units = provider.discover({
      lastCursor: () => null,
      reportIncompleteInventory: (i) => issues.push(i),
      // zero indexed sessions — the first-index case
    });
    assert.equal(units.length, 0);
    assert.ok(issues.length > 0, 'inaccessible root is reported even with zero history');
  } finally {
    chmodSync(sessionsDir, 0o755);
  }
});

test('changed paths outside the deepseek root never reconcile deepseek trees', () => {
  const dir = makeTempDir('obelisk-foreign-');
  const sessionsDir = writeTree(dir);
  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const db = freshDb();
  const store = cursorStore();
  const unit = provider.discover({ lastCursor: () => null })[0];
  store.set(unit.key, persist(db, unit, provider.parse(unit, null)));

  // A Claude transcript write elsewhere: must not reschedule or rescan us.
  const units = provider.discover({
    ...store.ctx(),
    changedPaths: ['/Users/someone/.claude/projects/p/session.jsonl'],
  });
  assert.deepEqual(units, [], 'foreign provider paths are ignored entirely');
  db.close();
});

test('changed paths under a symlinked root (realpath) still route to the tree', () => {
  const dir = makeTempDir('obelisk-symlink-');
  const real = writeTree(dir);
  const link = join(dir, 'linked-sessions');
  symlinkSync(real, link);
  const provider = createDeepseekProvider({ rootDir: link });
  const db = freshDb();
  const store = cursorStore();
  const unit = provider.discover({ lastCursor: () => null })[0];
  store.set(unit.key, persist(db, unit, provider.parse(unit, null)));

  // The watcher reports the REAL path (realpath), not the configured symlink.
  // The watcher reports the realpath (macOS: /var → /private/var as well).
  const realChild = join(realpathSync(real), '--tmp-dsh-project--', 'child-session-1', 'session.jsonl.zstd');
  const units = provider.discover({ ...store.ctx(), changedPaths: [realChild] });
  assert.equal(units.length, 1, 'realpath event routed to the tree');
  db.close();
});

test('deleting a child routes to its OWN tree even when a sibling tree shares the project dir', () => {
  const dir = makeTempDir('obelisk-multitree-');
  const sessionsDir = join(dir, 'sessions');
  // Two trees in the SAME project dir (same cwd → same scope, different ids).
  for (const sid of ['root-session-1', 'root-session-2']) {
    const d = join(sessionsDir, '--tmp-dsh-project--', sid);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'session.jsonl'), [
      JSON.stringify({ ...HEADER, id: sid }),
      JSON.stringify({ type: 'user/message', seq: 1, time: 1753005601000, data: { content: [{ type: 'text', text: `from ${sid}` }], source: { kind: 'user' }, role: 'user', id: `m-${sid}` } }),
    ].join('\n') + '\n');
  }
  // Tree 1 has a child.
  const childDir = join(sessionsDir, '--tmp-dsh-project--', 'child-of-1');
  mkdirSync(childDir, { recursive: true });
  const childPath = join(childDir, 'session.jsonl');
  writeFileSync(childPath, [
    JSON.stringify({ type: 'session', version: 0, id: 'child-of-1', createdAt: 1753005600200, cwd: '/tmp/dsh-project', parentSession: 'root-session-1', origin: 'subagent', delegationDepth: 1 }),
    JSON.stringify({ type: 'user/message', seq: 1, time: 1753005601300, data: { content: [{ type: 'text', text: 'child of 1' }], source: { kind: 'user' }, role: 'user', id: 'cm-1' } }),
  ].join('\n') + '\n');

  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const db = freshDb();
  const store = cursorStore();
  for (const unit of provider.discover({ lastCursor: () => null })) {
    store.set(unit.key, persist(db, unit, provider.parse(unit, null)));
  }
  assert.equal(dumpDb(db).sessions.length, 2);
  assert.ok(dumpDb(db).messages.some((m) => m.text === 'child of 1'));

  // Delete the child; the watcher reports only the deleted path.
  rmSync(childPath);
  const units = provider.discover({ ...store.ctx(), changedPaths: [childPath] });
  // The deleted member is in tree 1's checkpoint: routes there precisely.
  assert.ok(units.some((u) => u.sessionId === ROOT_ID), 'tree 1 re-emitted');
  for (const u of units) persist(db, u, provider.parse(u, store.ctx().lastCursor(u.key)));
  const dump = dumpDb(db);
  assert.ok(!dump.messages.some((m) => m.text === 'child of 1'), 'stale sidechain rows retracted');
  assert.ok(dump.messages.some((m) => m.text === 'from root-session-2'), 'sibling tree untouched');
  db.close();
});

test('symlinked root + move reported by old realpath routes to the moved tree', () => {
  const dir = makeTempDir('obelisk-movealias-');
  const real = join(dir, 'real-sessions');
  const hdr = (id) => ({ type: 'session', version: 0, id, createdAt: 1753005600000, cwd: '/tmp/dsh-project', delegationDepth: 0 });
  for (const sid of ['root-a', 'root-z']) {
    const d = join(real, '--tmp-dsh-project--', sid);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'session.jsonl'), [JSON.stringify(hdr(sid))].join('\n') + '\n');
  }
  const link = join(dir, 'linked');
  symlinkSync(real, link);
  const provider = createDeepseekProvider({ rootDir: link });
  const store = cursorStore();
  for (const unit of provider.discover({ lastCursor: () => null })) {
    store.set(unit.key, drain(provider.parse(unit, null)).ret);
  }
  const units0 = provider.discover({ lastCursor: () => null });
  const idA = units0.find((u) => u.sessionId.includes('root-a')).sessionId;

  mkdirSync(join(real, '--moved--'), { recursive: true });
  renameSync(join(real, '--tmp-dsh-project--', 'root-a'), join(real, '--moved--', 'root-a'));
  // Watcher reports only the OLD path, in realpath form (the file is gone).
  const oldReal = join(realpathSync(join(real, '--tmp-dsh-project--')), 'root-a', 'session.jsonl');
  const units = provider.discover({
    ...store.ctx(),
    changedPaths: [oldReal],
    indexedSessions: () => units0.map((u) => ({ sessionId: u.sessionId, jsonlPath: u.key })),
  });
  assert.ok(units.some((u) => u.sessionId === idA), 'moved tree routed by identity despite the alias mismatch');
  assert.ok(!units.some((u) => u.sessionId.includes('root-z')), 'sibling untouched');
});

test('identity is verifiably scoped (not circular with discovery)', () => {
  const dir = makeTempDir('obelisk-scopeproof-');
  const provider = createDeepseekProvider({ rootDir: writeTree(dir) });
  const unit = provider.discover({ lastCursor: () => null })[0];
  // Not just "whatever discover returns": the composite shape must be present.
  assert.match(unit.sessionId, /^deepseek:root-session-1:[0-9a-f]{64}$/);
  // And two different cwds must never share a scope (the PROBE constants would
  // still pass if cwd namespacing were deleted — this assertion would not).
  const other = `deepseek:root-session-1:${createHash('sha256').update('deepseek-cwd-v1\0').update('/tmp/other-project').digest('hex')}`;
  assert.notEqual(unit.sessionId, other);
});

// ---- format v2/v3 multi-version support (ADR-0014) ----
// Fixtures under tests/fixtures/deepseek/sessions/--dsh-v3-- are generated by
// scripts/gen-dsh-fixtures.mjs with the real DSH 0.1.6 writer (v3), the frozen
// v2 codec (v2 generation), and the real write-open migration path (the
// multi-generation directory) — real provider output per CONTRIBUTING.

const V3_FIXTURES = fileURLToPath(new URL('./fixtures/deepseek/sessions/--dsh-v3--', import.meta.url));

// Copy generated fixture scenarios into a fresh temp sessions root so tests
// can append without touching the pristine artifacts.
function stageV3(dir, scenarios, { include = null } = {}) {
  const sessionsDir = join(dir, 'sessions');
  for (const scenario of scenarios) {
    const target = join(sessionsDir, '--dsh-v3--', scenario);
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(join(V3_FIXTURES, scenario))) {
      if (include !== null && !include.includes(entry)) continue;
      copyFileSync(join(V3_FIXTURES, scenario, entry), join(target, entry));
    }
  }
  return sessionsDir;
}

function parseFirst(provider, cursor = null) {
  const unit = provider.discover({ lastCursor: () => cursor })[0];
  assert.ok(unit, 'unit discovered');
  return { unit, ...drain(provider.parse(unit, cursor)) };
}

// ADR-0007 canonical transcript invariant (hard gate per CONTRIBUTING):
// assembling directly from the adapter must equal assembling after a SQLite
// round-trip. Shared by every ADR-0014 scenario test below so dispatch
// records and seeded-child folding stay inside the gate.
function assertCanonicalRoundTrip(provider, unit, values) {
  const db = freshDb();
  persist(db, unit, provider.parse(unit, null));
  const persisted = assembleSessionDetail({
    session: db.prepare('SELECT * FROM sessions').get(),
    messages: db.prepare('SELECT * FROM messages ORDER BY timestamp, uuid').all(),
    toolCalls: db.prepare('SELECT * FROM tool_calls').all(),
    toolResults: db.prepare('SELECT * FROM tool_results').all(),
    subagents: db.prepare('SELECT * FROM subagents').all(),
  });
  db.close();
  assert.deepEqual(persisted, assembleSessionDetail(values));
}

// Inspect / rewrite the opaque cursor blob (field 3 is base64url JSON).
function cursorState(cursor) {
  return JSON.parse(Buffer.from(cursor.split(':')[2], 'base64url').toString('utf8'));
}
function recodeCursor(cursor, state) {
  const [mtime, count] = cursor.split(':');
  return `${mtime}:${count}:${Buffer.from(JSON.stringify(state)).toString('base64url')}`;
}

test('v3 zstd artifacts are discovered and projected; system prompts stay unindexed', () => {
  const dir = makeTempDir('obelisk-v3-basic-');
  const provider = createDeepseekProvider({ rootDir: stageV3(dir, ['v3-basic']) });
  const { unit, values } = parseFirst(provider);
  const session = values.find((r) => r.kind === 'session');
  assert.equal(session.version, '3');
  assert.equal(session.title, 'v3 basic session');
  const texts = values.filter((r) => r.kind === 'message').map((m) => m.text).filter(Boolean);
  assert.ok(texts.includes('please read a.ts'));
  assert.ok(texts.includes('Let me read it.'));
  assert.ok(texts.includes('need to read the file first'));
  assert.ok(!texts.some((text) => text.includes('fixture system prompt')), 'system/message is not indexed');
  const text = values.find((r) => r.kind === 'message' && r.text === 'Let me read it.');
  assert.equal(text.input_tokens, 12); // inputTokens + cacheReadTokens
  assert.equal(text.output_tokens, 5);
  const call = values.find((r) => r.kind === 'tool_call' && r.name === 'read');
  assert.equal(call.file_path, '/dsh-fixtures/a.ts');
  assert.ok(values.some((r) => r.kind === 'tool_result' && r.content === 'contents of a.ts'));

  // Canonical transcript invariant (ADR-0007): direct assembly equals the
  // SQLite round-trip.
  assertCanonicalRoundTrip(provider, unit, values);
});

test('a multi-generation directory indexes only the highest generation', () => {
  const dir = makeTempDir('obelisk-v3-multigen-');
  const provider = createDeepseekProvider({ rootDir: stageV3(dir, ['v3-migrated']) });
  const units = provider.discover({ lastCursor: () => null });
  assert.equal(units.length, 1, 'v2/v3 twins are one unit, not a duplicate or a divergence');
  const { values } = drain(provider.parse(units[0], null));
  const session = values.find((r) => r.kind === 'session');
  assert.equal(session.version, '3');
  assert.equal(session.title, 'migrated session', 'the post-migration append exists only in v3');
  assert.ok(values.some((r) => r.kind === 'message' && r.text === 'legacy v2 question'));
  // The migrated dispatch (renamed tool/ptc-dispatch, historical :code:
  // subCallId scheme) is indexed like any other sub-call.
  const sub = values.find((r) => r.kind === 'tool_call' && r.name === 'read');
  assert.ok(sub.id.endsWith(encodeURIComponent('call-9:code:0')));
  assert.ok(values.some((r) => r.kind === 'tool_result' && r.content === 'legacy dispatch content'));
  // Dispatch records stay inside the ADR-0007 gate.
  assertCanonicalRoundTrip(provider, units[0], values);
});

test('a v2-only artifact parses: code-dispatch spelling, system prompt unindexed', () => {
  const dir = makeTempDir('obelisk-v2-only-');
  const provider = createDeepseekProvider({ rootDir: stageV3(dir, ['v3-migrated'], { include: ['session.v2.jsonl'] }) });
  const { unit, values } = parseFirst(provider);
  const session = values.find((r) => r.kind === 'session');
  assert.equal(session.version, '2');
  const texts = values.filter((r) => r.kind === 'message').map((m) => m.text).filter(Boolean);
  assert.ok(texts.includes('legacy v2 question'));
  assert.ok(!texts.some((text) => text.includes('v2 system prompt')), 'request/header system field is not indexed');
  const sub = values.find((r) => r.kind === 'tool_call' && r.name === 'read');
  assert.ok(sub, 'tool/code-dispatch settle projects a tool_call');
  assert.ok(values.some((r) => r.kind === 'tool_result' && r.content === 'legacy dispatch content'));
  assertCanonicalRoundTrip(provider, unit, values);
});

test('compaction replace rows stay indexed: pre-compaction history remains searchable (ADR-0014)', () => {
  const dir = makeTempDir('obelisk-v3-compact-');
  const provider = createDeepseekProvider({ rootDir: stageV3(dir, ['v3-compacted']) });
  const { values } = parseFirst(provider);
  const texts = values.filter((r) => r.kind === 'message').map((m) => m.text).filter(Boolean);
  // Obelisk indexes the append-only log verbatim: a replace surfaceOp does
  // NOT retract the shadowed originals — finding past work is the product's
  // purpose (see tests/dsh-context-window-plugin.test.mjs).
  for (const kept of ['first question', 'first answer', 'second question', 'second answer']) {
    assert.ok(texts.includes(kept), `shadowed original stays indexed: ${kept}`);
  }
  assert.ok(texts.includes('[compacted summary] first and second exchanges'), 'the replacement row is indexed too');
  assert.ok(texts.includes('third question'));
  assert.ok(texts.includes('third answer'));
});

test('a v3 seeded subagent skips the inherited prefix at the end-seed marker', () => {
  const dir = makeTempDir('obelisk-v3-seeded-');
  const provider = createDeepseekProvider({ rootDir: stageV3(dir, ['v3-seeded-parent', 'v3-seeded-child']) });
  const units = provider.discover({ lastCursor: () => null });
  assert.equal(units.length, 1, 'child folds into the parent tree');
  const { values } = drain(provider.parse(units[0], null));
  const childTexts = values.filter((r) => r.kind === 'message' && r.agent_id !== null).map((m) => m.text).filter(Boolean);
  assert.deepEqual(childTexts.sort(), ['child answer', 'child task']);
  assert.ok(values.some((r) => r.kind === 'message' && r.agent_id === null && r.text === 'parent question'));
  const sub = values.find((r) => r.kind === 'subagent');
  assert.equal(sub.agent_type, 'deepseek');
  assert.equal(sub.description, 'seeded child');
  // Seeded-child folding stays inside the ADR-0007 gate.
  assertCanonicalRoundTrip(provider, units[0], values);
});

test('PTC dispatches index as tool_call/tool_result under the outer run_code anchor', () => {
  const dir = makeTempDir('obelisk-v3-ptc-');
  // The staged dir deliberately keeps session.migration.*.tmp /
  // session.v9.*.tmp write-noise siblings: discovery must ignore them.
  const provider = createDeepseekProvider({ rootDir: stageV3(dir, ['v3-ptc']) });
  const { unit, values } = parseFirst(provider);
  const calls = values.filter((r) => r.kind === 'tool_call').map((c) => c.name).sort();
  assert.deepEqual(calls, ['read', 'run_code', 'write']);
  const anchor = `${unit.sessionId}:t1:s1:tool_use`;
  const anchors = new Set(values.filter((r) => r.kind === 'tool_call').map((c) => c.message_uuid));
  assert.deepEqual([...anchors], [anchor], 'outer call and both sub-calls share the run_code anchor');
  const messageUuids = new Set(values.filter((r) => r.kind === 'message').map((m) => m.uuid));
  assert.ok(messageUuids.has(anchor), 'the anchor message exists');
  const results = values.filter((r) => r.kind === 'tool_result').map((r) => r.content).sort();
  assert.ok(results.includes('a.ts contents via ptc'));
  assert.ok(results.includes('wrote b.ts'));
  const readCall = values.find((r) => r.kind === 'tool_call' && r.name === 'read');
  assert.equal(readCall.file_path, '/dsh-fixtures/a.ts');
  // Dispatch-produced records stay inside the ADR-0007 gate.
  assertCanonicalRoundTrip(provider, unit, values);
});

test('a replace surfaceOp in a new window stays on the fast path (no retraction, by design)', () => {
  const dir = makeTempDir('obelisk-v3-replace-win-');
  const sessionsDir = stageV3(dir, ['v3-ptc']);
  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const store = cursorStore();
  const unit = provider.discover({ lastCursor: () => null })[0];
  store.set(unit.key, drain(provider.parse(unit, null)).ret);

  // A compaction-style replace lands in a new append batch, shadowing the
  // original user message (seq 2) in DSH's own surface — but Obelisk keeps
  // the full log (ADR-0014).
  const path = join(sessionsDir, '--dsh-v3--', 'v3-ptc', 'session.v3.jsonl');
  appendFileSync(path, JSON.stringify({
    type: 'user/message', seq: 13, time: 1753005609000,
    data: { id: 'u-ptc-fix', role: 'user', content: [{ type: 'text', text: 'corrected ptc prompt' }], source: { kind: 'user' } },
    surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 },
    sourceEventSeqs: [2],
  }) + '\n');

  const unit2 = provider.discover(store.ctx())[0];
  assert.ok(unit2, 'the changed tree is re-emitted');
  const { values } = drain(provider.parse(unit2, store.ctx().lastCursor(unit2.key)));
  assert.ok(!values.some((r) => r.kind === 'delete-session'), 'no retraction: the delta path suffices');
  assert.equal(values.find((r) => r.kind === 'session').countMode, 'delta');
  const texts = values.filter((r) => r.kind === 'message').map((m) => m.text).filter(Boolean);
  assert.ok(texts.includes('corrected ptc prompt'), 'replacement indexed as an ordinary append');
});

test('PTC anchors resolve across windows while the parent is in flight, and prune at its result', () => {
  const dir = makeTempDir('obelisk-v3-ptc-anchor-');
  const sessionsDir = stageV3(dir, ['v3-ptc']);
  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const store = cursorStore();

  // Realistic interleaving: dispatches land across watcher windows WHILE the
  // outer run_code call is still executing — upstream settles every sub-call
  // before the outer tool/result. Truncate the fixture right before that
  // result (header + seq 0..9: both dispatches seen, parent still open).
  const path = join(sessionsDir, '--dsh-v3--', 'v3-ptc', 'session.v3.jsonl');
  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  const cutoff = lines.findIndex((l) => JSON.parse(l).type === 'tool/result');
  assert.ok(cutoff > 0);
  writeFileSync(path, lines.slice(0, cutoff).join('\n') + '\n');

  const unit = provider.discover({ lastCursor: () => null })[0];
  const anchor = `${unit.sessionId}:t1:s1:tool_use`;
  store.set(unit.key, drain(provider.parse(unit, null)).ret);
  assert.equal(cursorState(store.ctx().lastCursor(unit.key)).members[path].ptcAnchors['call-1'], anchor,
    'an in-flight parent keeps its anchor mapping');

  // A dispatch in a later window resolves via the checkpointed map.
  appendFileSync(path, [
    { type: 'tool/ptc-dispatch-start', seq: 10, time: 1753005608000, data: { rootCallId: 'call-1', parentCallId: 'call-1', subCallId: 'call-1:ptc:3', name: 'edit', arguments: { file_path: '/dsh-fixtures/c.ts' } } },
    { type: 'tool/ptc-dispatch', seq: 11, time: 1753005608100, data: { rootCallId: 'call-1', parentCallId: 'call-1', subCallId: 'call-1:ptc:3', name: 'edit', arguments: { file_path: '/dsh-fixtures/c.ts' }, isError: false, content: [{ type: 'text', text: 'edited c.ts' }] } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const unit2 = provider.discover(store.ctx())[0];
  const parsed2 = drain(provider.parse(unit2, store.ctx().lastCursor(unit2.key)));
  const { values } = parsed2;
  const call = values.find((r) => r.kind === 'tool_call' && r.name === 'edit');
  assert.ok(call, 'new dispatch projected');
  assert.equal(call.message_uuid, anchor, 'anchor resolved from the checkpointed map, not a synthetic fallback');
  assert.ok(!values.some((r) => r.kind === 'message' && r.uuid === anchor), 'existing anchor is not re-emitted');
  assert.equal(values.find((r) => r.kind === 'session').countMode, 'delta');
  store.set(unit2.key, parsed2.ret);

  // The parent's result lands: its mapping (and any nested sub-call ids) is
  // pruned — the checkpointed map holds only in-flight calls.
  appendFileSync(path, JSON.stringify({
    type: 'tool/result', seq: 12, time: 1753005608200, data: {
      turn: 1, step: 1,
      message: { id: 'tr-call-1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'run_code finished' }] }], source: { kind: 'tool', callId: 'call-1' } },
    }, surfaceOp: 'append',
  }) + '\n');
  const unit3 = provider.discover(store.ctx())[0];
  const ret3 = drain(provider.parse(unit3, store.ctx().lastCursor(unit3.key))).ret;
  assert.equal(cursorState(ret3).members[path].ptcAnchors?.['call-1'] ?? null, null, 'settled parent is pruned from the checkpoint');
});

test('watcher routing matches versioned filenames and ignores lock/tmp noise', () => {
  const dir = makeTempDir('obelisk-v3-watch-');
  const sessionsDir = stageV3(dir, ['v3-basic']);
  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const store = cursorStore();
  const unit = provider.discover({ lastCursor: () => null })[0];
  store.set(unit.key, drain(provider.parse(unit, null)).ret);
  const sessionDir = dirname(unit.key);

  const withPaths = (paths) => provider.discover({ ...store.ctx(), changedPaths: paths });
  assert.deepEqual(withPaths([join(sessionDir, 'session.lock')]), [], 'lock file touches route nowhere');
  assert.deepEqual(withPaths([join(sessionDir, 'session.migration.deadbeef.jsonl.zstd.tmp')]), [], 'staging files route nowhere');
  assert.equal(withPaths([unit.key]).length, 1, 'the versioned artifact routes to its tree');
});

test('raw() resolves v3 (zstd) source lines', () => {
  const dir = makeTempDir('obelisk-v3-raw-');
  const provider = createDeepseekProvider({ rootDir: stageV3(dir, ['v3-basic']) });
  const { unit, values } = parseFirst(provider);
  const userMsg = values.find((r) => r.kind === 'message' && r.text === 'please read a.ts');
  const raw = provider.raw({ source: 'deepseek', messageUuid: userMsg.uuid, session: { jsonl_path: unit.key }, agentId: null });
  assert.ok(raw.text.includes('please read a.ts'));
});

// A session write-opened by a newer DSH publishes a higher-generation twin
// beside the frozen original (issue #181's "silent staleness": the old path
// still exists, so no tombstone fires — but it will never grow again).
test('an upstream v2→v3 migration continues the indexed session: no tombstone, no duplicate, no staleness', () => {
  const dir = makeTempDir('obelisk-v3-mig-cursor-');
  // Phase 1: only the v2 generation exists (the pre-migration on-disk state).
  const sessionsDir = stageV3(dir, ['v3-migrated'], { include: ['session.v2.jsonl'] });
  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const db = freshDb();
  const store = cursorStore();
  const unit = provider.discover({ lastCursor: () => null })[0];
  assert.ok(unit, 'the v2 tree is discovered');
  store.set(unit.key, persist(db, unit, provider.parse(unit, null)));
  assert.ok(dumpDb(db).messages.some((m) => m.text === 'legacy v2 question'));
  const sessionId = unit.sessionId;

  // Phase 2: the real write-open migration publishes the v3 twin beside the
  // frozen v2 original. The checkpoint and the indexed rows still reference
  // the v2 path.
  copyFileSync(
    join(V3_FIXTURES, 'v3-migrated', 'session.v3.jsonl'),
    join(sessionsDir, '--dsh-v3--', 'v3-migrated', 'session.v3.jsonl'),
  );
  const units = provider.discover({
    ...store.ctx(),
    indexedSessions: () => [{ sessionId, jsonlPath: unit.key }],
  });
  assert.equal(units.length, 1, 'the twin pair is one unit — no duplicate, no divergent suppression');
  assert.equal(units[0].sessionId, sessionId, 'identity survives the migration');
  assert.ok(!units.some((u) => (u.retractSessionIds ?? []).length > 0), 'no tombstone: the identity is still live');
  assert.ok(units[0].key.endsWith('session.v3.jsonl'), 'the unit keys on the highest generation');

  // The new unit key has no cursor in production: the member-path change
  // forces the snapshot fallback, which retracts and re-emits under the SAME
  // session id — never a second session row.
  const { values } = drain(provider.parse(units[0], store.ctx().lastCursor(units[0].key)));
  assert.ok(values.some((r) => r.kind === 'delete-session'), 'the changed member path forces the snapshot fallback');
  assert.equal(values.find((r) => r.kind === 'session').countMode, 'total');
  assertCanonicalRoundTrip(provider, units[0], values);
  persist(db, units[0], provider.parse(units[0], null));
  const dump = dumpDb(db);
  assert.equal(dump.sessions.length, 1, 'exactly one session row after the migration');
  assert.equal(dump.sessions[0].id, sessionId);
  assert.equal(dump.sessions[0].title, 'migrated session', 'the post-migration append (v3-only) is indexed');
  assert.ok(dump.messages.some((m) => m.text === 'legacy v2 question'), 'pre-migration history carries over');
  assert.equal(db.prepare('SELECT jsonl_path FROM sessions').get().jsonl_path, units[0].key,
    'provenance follows the new generation');
  db.close();
});

// The gate accepts 0–3 and nothing beyond: a version-4 file must never be
// parsed as a known format, and per CONTRIBUTING it must not poison the
// provider — skip, record, and suppress the project directory.
test('a version-4 header is rejected at the gate and suppresses its whole project directory (fail closed)', () => {
  const dir = makeTempDir('obelisk-version4-');
  const sessionsDir = join(dir, 'sessions');
  // A v4 artifact (the first rejectable generation) beside a healthy v0
  // sibling in the SAME project directory.
  const projectDir = join(sessionsDir, '--tmp-dsh-project--');
  const write = (name, file, header, text) => {
    const d = join(projectDir, name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, file), [
      JSON.stringify(header),
      JSON.stringify({ type: 'user/message', seq: 1, time: 1753005601000, data: { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user', id: 'm-1' } }),
    ].join('\n') + '\n');
  };
  write('v4-session', 'session.v4.jsonl', { ...HEADER, version: 4, id: 'v4-session' }, 'from the future');
  write('healthy-session', 'session.jsonl', { ...HEADER, id: 'healthy-session' }, 'healthy');
  // An unrelated project stays live.
  const otherDir = join(sessionsDir, '--other--', 'other-session');
  mkdirSync(otherDir, { recursive: true });
  writeFileSync(join(otherDir, 'session.jsonl'), [
    JSON.stringify({ ...HEADER, id: 'other-session', cwd: '/other' }),
    JSON.stringify({ type: 'user/message', seq: 1, time: 1753005601000, data: { content: [{ type: 'text', text: 'other' }], source: { kind: 'user' }, role: 'user', id: 'm-2' } }),
  ].join('\n') + '\n');

  const issues = [];
  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const units = provider.discover({ lastCursor: () => null, reportIncompleteInventory: (i) => issues.push(i) });
  assert.ok(units.some((u) => u.sessionId.includes('other-session')), 'other projects stay live');
  assert.ok(!units.some((u) => u.sessionId.includes('healthy-session') || u.sessionId.includes('v4-session')),
    'the whole project directory is suppressed — no partial snapshot');
  assert.ok(issues.some((i) => i.error === 'Unsupported session format version 4'));
});

// v1 was never shipped in a tagged release but is physically v0: the gate
// accepts it and the projection takes the v0 path (header seedLength honored).
test('a version-1 header takes the v0 path: header seedLength still marks the inherited prefix', () => {
  const dir = makeTempDir('obelisk-version1-');
  const sessionsDir = join(dir, 'sessions');
  const projectDir = join(sessionsDir, '--tmp-dsh-project--');
  mkdirSync(join(projectDir, 'v1-root'), { recursive: true });
  writeFileSync(join(projectDir, 'v1-root', 'session.v1.jsonl'), [
    JSON.stringify({ ...HEADER, version: 1, id: 'v1-root' }),
    JSON.stringify({ type: 'user/message', seq: 1, time: 1753005601000, data: { content: [{ type: 'text', text: 'root question' }], source: { kind: 'user' }, role: 'user', id: 'm-1' } }),
  ].join('\n') + '\n');
  mkdirSync(join(projectDir, 'v1-child'), { recursive: true });
  writeFileSync(join(projectDir, 'v1-child', 'session.v1.jsonl'), [
    JSON.stringify({ ...CHILD_HEADER, version: 1, id: 'v1-child', parentSession: 'v1-root', seedLength: 2 }),
    JSON.stringify({ type: 'user/message', seq: 0, time: 1753005601000, data: { content: [{ type: 'text', text: 'inherited question' }], source: { kind: 'user' }, role: 'user', id: 'm-i1' } }),
    JSON.stringify({ type: 'assistant/message', seq: 1, time: 1753005602000, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'inherited answer' }], source: { kind: 'model', model: 'deepseek-v4-flash' }, id: 'm-i2' } } }),
    JSON.stringify({ type: 'subagent/descriptor', seq: 2, time: 1753005602200, data: { version: 1, mode: 'continuable', provider: 'spawn', label: 'v1 child', agentProvider: 'deepseek-official' } }),
    JSON.stringify({ type: 'user/message', seq: 3, time: 1753005603000, data: { content: [{ type: 'text', text: 'child owned' }], source: { kind: 'user' }, role: 'user', id: 'm-c1' } }),
  ].join('\n') + '\n');

  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const unit = provider.discover({ lastCursor: () => null })[0];
  assert.ok(unit, 'the v1 tree passes the gate');
  const { values } = drain(provider.parse(unit, null));
  assert.equal(values.find((r) => r.kind === 'session').version, '1');
  const childTexts = values.filter((r) => r.kind === 'message' && r.agent_id !== null).map((m) => m.text).filter(Boolean);
  assert.deepEqual(childTexts, ['child owned'], 'seedLength excludes the inherited prefix on the v0 path');
});

// The resolved v2/v3 seed prefix is checkpointed per member so fast-path
// windows never re-read the head; a pre-ADR-0014 checkpoint (no seededPrefix)
// must self-heal by recomputing the marker once (ADR-0014).
test('seeded v3 appends stay on the fast path: the checkpointed seededPrefix (or a head recompute) keeps inherited rows out', () => {
  const dir = makeTempDir('obelisk-v3-seeded-fast-');
  const sessionsDir = stageV3(dir, ['v3-seeded-parent', 'v3-seeded-child']);
  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const store = cursorStore();
  const unit = provider.discover({ lastCursor: () => null })[0];
  assert.ok(unit);
  const cursor = drain(provider.parse(unit, null)).ret;
  store.set(unit.key, cursor);

  // The resolved inherited prefix (the end-seed marker's seq) is checkpointed
  // on the member's own record (cursor shape v2 — ADR-0014).
  const childPath = join(sessionsDir, '--dsh-v3--', 'v3-seeded-child', 'session.v3.jsonl');
  assert.equal(cursorState(cursor).members[childPath].seededPrefix, 4);

  // Window 2: child-owned events append; the fast path excludes the inherited
  // rows via the checkpoint — delta only, no retraction.
  appendFileSync(childPath, [
    { type: 'turn/start', seq: 12, time: 1200, data: { turn: 3 } },
    { type: 'user/message', seq: 13, time: 1210, data: { id: 'u-child-2', role: 'user', content: [{ type: 'text', text: 'child follow-up' }], source: { kind: 'user' }, surfaceOp: 'append' } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const unit2 = provider.discover(store.ctx())[0];
  assert.ok(unit2);
  const parsed = drain(provider.parse(unit2, store.ctx().lastCursor(unit2.key)));
  assert.equal(parsed.values.find((r) => r.kind === 'session').countMode, 'delta');
  assert.ok(!parsed.values.some((r) => r.kind === 'delete-session'));
  assert.deepEqual(
    parsed.values.filter((r) => r.kind === 'message').map((m) => m.text).filter(Boolean),
    ['child follow-up'],
    'the inherited parent rows stay excluded on the fast path',
  );
  assert.equal(cursorState(parsed.ret).members[childPath].seededPrefix, 4, 'the checkpoint survives the round-trip');
  store.set(unit2.key, parsed.ret);

  // Window 3: a checkpoint whose member record lacks seededPrefix (written
  // before the field existed) — the parse recomputes the marker from the file
  // head once, still excluding inherited.
  const legacy = cursorState(parsed.ret);
  delete legacy.members[childPath].seededPrefix;
  store.set(unit2.key, recodeCursor(parsed.ret, legacy));
  appendFileSync(childPath, [
    { type: 'user/message', seq: 14, time: 1220, data: { id: 'u-child-3', role: 'user', content: [{ type: 'text', text: 'after legacy cursor' }], source: { kind: 'user' }, surfaceOp: 'append' } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const unit3 = provider.discover(store.ctx())[0];
  const parsed3 = drain(provider.parse(unit3, store.ctx().lastCursor(unit3.key)));
  assert.equal(parsed3.values.find((r) => r.kind === 'session').countMode, 'delta');
  assert.deepEqual(
    parsed3.values.filter((r) => r.kind === 'message').map((m) => m.text).filter(Boolean),
    ['after legacy cursor'],
    'the recompute-from-head path also excludes inherited rows',
  );
  assert.equal(cursorState(parsed3.ret).members[childPath].seededPrefix, 4, 'recomputed and re-checkpointed');
});

// Regression (reproduced against the real writer): a seeded v3 subagent whose
// FIRST index happens before the seed batch lands — DSH persists the header
// first, so a header-only file is a real intermediate state. The adapter must
// fail closed, not checkpoint a phony cut of 0 that leaks the inherited
// parent prefix into the child's sidechain on every later window (ADR-0014).
test('a seeded child indexed before its seed batch lands fails closed (no sticky cut 0)', () => {
  const dir = makeTempDir('obelisk-v3-seed-race-');
  const sessionsDir = stageV3(dir, ['v3-seeded-parent', 'v3-seeded-child']);
  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const store = cursorStore();

  // Truncate the child to its header only — the seed batch has not landed.
  const childPath = join(sessionsDir, '--dsh-v3--', 'v3-seeded-child', 'session.v3.jsonl');
  const full = readFileSync(join(V3_FIXTURES, 'v3-seeded-child', 'session.v3.jsonl'), 'utf8');
  writeFileSync(childPath, `${full.split('\n')[0]}\n`);

  const unit = provider.discover({ lastCursor: () => null })[0];
  assert.ok(unit);
  const first = drain(provider.parse(unit, null));
  assert.equal(first.values.length, 0, 'nothing is emitted before the seed marker is durable');
  assert.equal(first.ret, null, 'no cursor is recorded — nothing is checkpointed');

  // The seed batch lands: the inherited prefix stays excluded from the start.
  writeFileSync(childPath, full);
  const unit2 = provider.discover(store.ctx())[0];
  const second = drain(provider.parse(unit2, store.ctx().lastCursor(unit2.key)));
  const childTexts = second.values.filter((r) => r.kind === 'message' && r.agent_id !== null).map((m) => m.text).filter(Boolean);
  assert.deepEqual(childTexts.sort(), ['child answer', 'child task']);
  assert.equal(cursorState(second.ret).members[childPath].seededPrefix, 4, 'the observed marker is checkpointed');
  store.set(unit2.key, second.ret);

  // A later append window stays clean — no leak via a sticky 0.
  appendFileSync(childPath, JSON.stringify({ type: 'user/message', seq: 12, time: 1250, data: { id: 'u-child-late', role: 'user', content: [{ type: 'text', text: 'later append' }], source: { kind: 'user' } }, surfaceOp: 'append' }) + '\n');
  const unit3 = provider.discover(store.ctx())[0];
  const third = drain(provider.parse(unit3, store.ctx().lastCursor(unit3.key)));
  const thirdTexts = third.values.filter((r) => r.kind === 'message').map((m) => m.text).filter(Boolean);
  assert.deepEqual(thirdTexts, ['later append'], 'delta window contains only child-owned rows');
});

// Cursor shape v1 (six parallel path-keyed maps, before the ADR-0014
// consolidation) must never be lenient-read into the v2 per-member shape:
// missing optional fields would silently break parent chains on the fast
// path. It decodes as null and the parse self-heals via the snapshot
// fallback (ADR-0014).
test('a v1-shape cursor is rejected whole and self-heals via snapshot (never lenient-read)', () => {
  const dir = makeTempDir('obelisk-v1-cursor-');
  const sessionsDir = stageV3(dir, ['v3-seeded-parent', 'v3-seeded-child']);
  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const store = cursorStore();
  const unit = provider.discover({ lastCursor: () => null })[0];
  const cursor = drain(provider.parse(unit, null)).ret;

  // Forge the pre-consolidation shape: six top-level path-keyed maps, v: 1.
  const current = cursorState(cursor);
  const legacy = { v: 1, sessionId: current.sessionId, members: {}, lastMessageUuid: {}, lastMessageParentUuid: {}, anchorSteps: {}, seededPrefix: {}, ptcAnchors: {} };
  for (const [path, m] of Object.entries(current.members)) {
    legacy.members[path] = { agentId: m.agentId, headerHash: m.headerHash, inode: m.inode, count: m.count, prefixHash: m.prefixHash };
    if (m.lastMessageUuid !== undefined) legacy.lastMessageUuid[path] = m.lastMessageUuid;
    if (m.lastMessageParentUuid !== undefined) legacy.lastMessageParentUuid[path] = m.lastMessageParentUuid;
    if (m.anchorSteps !== undefined) legacy.anchorSteps[path] = m.anchorSteps;
    if (m.seededPrefix !== undefined) legacy.seededPrefix[path] = m.seededPrefix;
    if (m.ptcAnchors !== undefined) legacy.ptcAnchors[path] = m.ptcAnchors;
  }
  store.set(unit.key, recodeCursor(cursor, legacy));

  const childPath = join(sessionsDir, '--dsh-v3--', 'v3-seeded-child', 'session.v3.jsonl');
  appendFileSync(childPath, JSON.stringify({ type: 'user/message', seq: 12, time: 1300, data: { id: 'u-child-9', role: 'user', content: [{ type: 'text', text: 'post-legacy append' }], source: { kind: 'user' } }, surfaceOp: 'append' }) + '\n');

  const unit2 = provider.discover(store.ctx())[0];
  assert.ok(unit2);
  const parsed = drain(provider.parse(unit2, store.ctx().lastCursor(unit2.key)));
  assert.equal(parsed.values[0].kind, 'delete-session', 'foreign-shape cursor → snapshot fallback, not a lenient delta');
  assert.equal(parsed.values.find((r) => r.kind === 'session').countMode, 'total');
  const childTexts = parsed.values.filter((r) => r.kind === 'message' && r.agent_id !== null).map((m) => m.text).filter(Boolean);
  assert.deepEqual(childTexts.sort(), ['child answer', 'child task', 'post-legacy append'],
    'the snapshot re-parse keeps the parent chain AND the inherited-prefix exclusion');
  assert.equal(cursorState(parsed.ret).v, 2, 'the replacement checkpoint is the v2 shape');
});

// When the outer tool/call predates the checkpoint window and the parent map
// misses (a cursor from an older build), the dispatch must mint a
// deterministic synthetic anchor — once — instead of dangling (ADR-0014).
test('a dispatch on a parent-map miss mints a deterministic anchor once, never dangling', () => {
  const dir = makeTempDir('obelisk-v3-ptc-mint-');
  const sessionsDir = stageV3(dir, ['v3-ptc']);
  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const store = cursorStore();
  const unit = provider.discover({ lastCursor: () => null })[0];
  const cursor = drain(provider.parse(unit, null)).ret;
  store.set(unit.key, cursor);

  // Strip the parent-callId map from the member's checkpoint record (an older
  // build's cursor): the outer run_code tool/call is outside this window and
  // unresolvable.
  const stripped = cursorState(cursor);
  const ptcPath = join(sessionsDir, '--dsh-v3--', 'v3-ptc', 'session.v3.jsonl');
  delete stripped.members[ptcPath].ptcAnchors;
  store.set(unit.key, recodeCursor(cursor, stripped));

  const path = join(sessionsDir, '--dsh-v3--', 'v3-ptc', 'session.v3.jsonl');
  appendFileSync(path, [
    { type: 'tool/ptc-dispatch', seq: 13, time: 1753005608000, data: { rootCallId: 'call-1', parentCallId: 'call-1', subCallId: 'call-1:ptc:9', name: 'edit', arguments: { file_path: '/dsh-fixtures/c.ts' }, isError: false, content: [{ type: 'text', text: 'minted anchor edit' }] } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const unit2 = provider.discover(store.ctx())[0];
  const parsed = drain(provider.parse(unit2, store.ctx().lastCursor(unit2.key)));
  const minted = `${unit.sessionId}:ptc:${encodeURIComponent('call-1')}`;
  const call = parsed.values.find((r) => r.kind === 'tool_call' && r.name === 'edit');
  assert.ok(call, 'the dispatch projects despite the map miss');
  assert.equal(call.message_uuid, minted, 'the miss mints the deterministic synthetic anchor');
  assert.ok(parsed.values.some((r) => r.kind === 'message' && r.uuid === minted && r.content_type === 'tool_use'),
    'the minted anchor message is emitted');
  assert.ok(parsed.values.some((r) => r.kind === 'tool_result' && r.content === 'minted anchor edit'));
  store.set(unit2.key, parsed.ret);

  // A later window dispatching under the same parent reuses the checkpointed
  // mint — the anchor message must NOT be re-emitted.
  appendFileSync(path, [
    { type: 'tool/ptc-dispatch', seq: 14, time: 1753005608100, data: { rootCallId: 'call-1', parentCallId: 'call-1', subCallId: 'call-1:ptc:10', name: 'read', arguments: { file_path: '/dsh-fixtures/d.ts' }, isError: false, content: [{ type: 'text', text: 'second window read' }] } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const unit3 = provider.discover(store.ctx())[0];
  const parsed3 = drain(provider.parse(unit3, store.ctx().lastCursor(unit3.key)));
  const second = parsed3.values.find((r) => r.kind === 'tool_call' && r.name === 'read');
  assert.ok(second);
  assert.equal(second.message_uuid, minted, 'the minted uuid resolves from the checkpoint');
  assert.ok(!parsed3.values.some((r) => r.kind === 'message' && r.uuid === minted),
    'the minted anchor is not re-emitted in later windows');
});

// A nested run_code's dispatches carry the OUTER SUB-CALL's subCallId as
// parentCallId — the anchor must chain through it to the outer call's anchor.
// isError and the newer `error` field both mark a failed settle.
test('nested run_code dispatches chain to the outer anchor; isError and error both mark failures', () => {
  const dir = makeTempDir('obelisk-v3-ptc-nested-');
  const sessionsDir = stageV3(dir, ['v3-ptc']);
  const path = join(sessionsDir, '--dsh-v3--', 'v3-ptc', 'session.v3.jsonl');
  appendFileSync(path, [
    { type: 'turn/start', seq: 13, time: 1753005608500, data: { turn: 2 } },
    { type: 'step/start', seq: 14, time: 1753005608550, data: { turn: 2, step: 1 } },
    { type: 'tool/call', seq: 15, time: 1753005608600, data: { turn: 2, step: 1, callId: 'call-2', name: 'run_code', arguments: '{"code":"nested"}' } },
    { type: 'tool/ptc-dispatch', seq: 16, time: 1753005608700, data: { rootCallId: 'call-2', parentCallId: 'call-2', subCallId: 'call-2:ptc:1', name: 'run_code', arguments: { code: 'nested' }, isError: false, content: [{ type: 'text', text: 'nested run finished' }] } },
    { type: 'tool/ptc-dispatch', seq: 17, time: 1753005608800, data: { rootCallId: 'call-2', parentCallId: 'call-2:ptc:1', subCallId: 'call-2:ptc:1:ptc:1', name: 'read', arguments: { file_path: '/dsh-fixtures/e.ts' }, isError: true, content: [{ type: 'text', text: 'inner read failed' }] } },
    { type: 'tool/ptc-dispatch', seq: 18, time: 1753005608900, data: { rootCallId: 'call-2', parentCallId: 'call-2', subCallId: 'call-2:ptc:2', name: 'bash', arguments: { cmd: 'ls' }, error: 'spawn failed', content: [{ type: 'text', text: '' }] } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const provider = createDeepseekProvider({ rootDir: sessionsDir });
  const { unit, values } = parseFirst(provider);
  const anchor2 = `${unit.sessionId}:t2:s1:tool_use`;
  const bySuffix = (suffix) => values.find((r) => r.kind === 'tool_call' && r.id.endsWith(encodeURIComponent(suffix)));
  const nestedRun = bySuffix('call-2:ptc:1');
  const innerRead = bySuffix('call-2:ptc:1:ptc:1');
  const bash = bySuffix('call-2:ptc:2');
  assert.ok(nestedRun && innerRead && bash, 'all three dispatches project');
  assert.equal(nestedRun.message_uuid, anchor2);
  assert.equal(innerRead.message_uuid, anchor2, 'the nested sub-call resolves through the outer sub-call to the same anchor');
  assert.equal(bash.message_uuid, anchor2);
  assert.equal(values.filter((r) => r.kind === 'message' && r.uuid === anchor2).length, 1,
    'one anchor message serves the whole nested group');
  // is_error: the isError flag and the newer error field both mark failure.
  const innerResult = values.find((r) => r.kind === 'tool_result' && r.tool_use_id === innerRead.id);
  assert.equal(innerResult.is_error, 1, 'isError: true marks the result failed');
  const bashResult = values.find((r) => r.kind === 'tool_result' && r.tool_use_id === bash.id);
  assert.equal(bashResult.is_error, 1, 'a settle event with only the error field still marks failure');
  assertCanonicalRoundTrip(provider, unit, values);
});
