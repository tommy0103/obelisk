// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import { createCodexParseMetrics, createCodexProvider, parse } from '../packages/core/src/providers/codex.ts';
import { persist } from '../packages/core/src/persist.ts';
import { assembleSessionDetail } from '../packages/core/src/session-detail.ts';
import {
  discoverCodexJsonlFiles,
  isCodexCompressedPath,
  isCodexTranscriptPath,
  readCodexCompressedBytes,
  readCodexLines,
} from '../packages/core/src/parsing.ts';
import { makeTempDir } from './temp-dirs.mjs';

const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');

const META = {
  id: '019e8951-3e7d-7343-a3e3-05bff48a317d',
  cwd: '/proj',
  git: { branch: 'main' },
  cli_version: '1.2',
  timestamp: '2026-06-10T10:00:00Z',
};

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}

function sampleRolloutLines() {
  return [
    { type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: META },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:01Z', payload: { type: 'user_message', message: 'hello codex' } },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:02Z', payload: { type: 'agent_message', message: 'hi there' } },
    { type: 'response_item', timestamp: '2026-06-10T10:00:02Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi there' }] } },
    { type: 'response_item', timestamp: '2026-06-10T10:00:03Z', payload: { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"cmd":"ls"}' } },
    { type: 'response_item', timestamp: '2026-06-10T10:00:04Z', payload: { type: 'function_call_output', call_id: 'call_1', output: 'file listing' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, output_tokens: 50 } } } },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:05Z', payload: { type: 'task_complete', duration_ms: 1500 } },
  ];
}

function writePlainRollout(filePath, lines = sampleRolloutLines()) {
  const content = lines.map(l => JSON.stringify(l)).join('\n') + '\n';
  writeFileSync(filePath, content, 'utf8');
  return Buffer.from(content, 'utf8');
}

function writeCompressedRollout(filePath, lines = sampleRolloutLines()) {
  const content = lines.map(l => JSON.stringify(l)).join('\n') + '\n';
  const compressed = zstdCompressSync(Buffer.from(content, 'utf8'));
  writeFileSync(filePath, compressed);
  return compressed;
}

function drain(gen) {
  const values = [];
  let step = gen.next();
  while (!step.done) {
    values.push(step.value);
    step = gen.next();
  }
  return { values, ret: step.value };
}

test('predicate functions identify codex paths correctly', () => {
  assert.equal(isCodexCompressedPath('rollout.jsonl.zst'), true);
  assert.equal(isCodexCompressedPath('rollout.jsonl'), false);
  assert.equal(isCodexCompressedPath('rollout.jsonl.zstd'), false);

  assert.equal(isCodexTranscriptPath('rollout.jsonl'), true);
  assert.equal(isCodexTranscriptPath('rollout.jsonl.zst'), true);
  assert.equal(isCodexTranscriptPath('rollout.jsonl.zstd'), false);
  assert.equal(isCodexTranscriptPath('other.txt'), false);
});

test('discoverCodexJsonlFiles discovers both .jsonl and .jsonl.zst and respects sibling precedence', () => {
  const dir = makeTempDir('obelisk-codex-zst-discover-');
  const sessionDir = join(dir, '2026', '06', '10');
  mkdirSync(sessionDir, { recursive: true });

  const plainPath = join(sessionDir, 'rollout-plain.jsonl');
  const zstPath = join(sessionDir, 'rollout-compressed.jsonl.zst');
  const siblingPlain = join(sessionDir, 'rollout-sibling.jsonl');
  const siblingZst = join(sessionDir, 'rollout-sibling.jsonl.zst');

  writePlainRollout(plainPath);
  writeCompressedRollout(zstPath);
  writePlainRollout(siblingPlain);
  writeCompressedRollout(siblingZst);

  const files = discoverCodexJsonlFiles(dir);
  const paths = files.map(f => f.path);

  assert.ok(paths.includes(plainPath), 'discovers plain file');
  assert.ok(paths.includes(zstPath), 'discovers zst file');
  assert.ok(paths.includes(siblingPlain), 'discovers sibling plain file');
  assert.ok(!paths.includes(siblingZst), 'sibling zst file is omitted when plain file exists');
  assert.equal(files.length, 3);
});

test('readCodexCompressedBytes and readCodexLines decompress single- and multi-frame rollouts', () => {
  const dir = makeTempDir('obelisk-codex-zst-read-');
  const singlePath = join(dir, 'single.jsonl.zst');
  const multiPath = join(dir, 'multi.jsonl.zst');

  const lines = sampleRolloutLines();
  const rawText = lines.map(l => JSON.stringify(l)).join('\n') + '\n';
  const buf = Buffer.from(rawText, 'utf8');

  // Single-frame
  writeCompressedRollout(singlePath, lines);
  const decompressedSingle = readCodexCompressedBytes(singlePath);
  assert.deepEqual(decompressedSingle, buf);

  // Multi-frame: concatenate two compressed frames
  const half = Math.floor(buf.length / 2);
  const frame1 = zstdCompressSync(buf.subarray(0, half));
  const frame2 = zstdCompressSync(buf.subarray(half));
  writeFileSync(multiPath, Buffer.concat([frame1, frame2]));

  const decompressedMulti = readCodexCompressedBytes(multiPath);
  assert.deepEqual(decompressedMulti, buf);

  const readLinesArr = [];
  readCodexLines(multiPath, (line) => {
    readLinesArr.push(line);
  });
  assert.equal(readLinesArr.length, lines.length);
});

function detailRows(db, sessionId = `codex:${META.id}`) {
  return {
    session: db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId),
    messages: db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY timestamp, uuid').all(sessionId),
    toolCalls: db.prepare('SELECT * FROM tool_calls WHERE session_id=? ORDER BY id').all(sessionId),
    toolResults: db.prepare('SELECT * FROM tool_results WHERE session_id=? ORDER BY tool_use_id').all(sessionId),
    subagents: db.prepare('SELECT * FROM subagents WHERE session_id=? ORDER BY agent_id').all(sessionId),
    workflows: [],
    summaries: db.prepare('SELECT * FROM summaries WHERE session_id=? ORDER BY id').all(sessionId),
  };
}

test('parse() produces identical canonical records for plain and compressed rollouts (deep equality)', () => {
  const dir = makeTempDir('obelisk-codex-zst-parse-');
  const plainPath = join(dir, 'rollout.jsonl');
  const zstPath = join(dir, 'rollout.jsonl.zst');

  writePlainRollout(plainPath);
  writeCompressedRollout(zstPath);

  const plainRes = drain(parse({ key: plainPath, sessionId: '' }, null));
  const zstRes = drain(parse({ key: zstPath, sessionId: '' }, null));

  assert.equal(plainRes.values.length, zstRes.values.length);

  // Deep comparison of every record, normalizing only jsonl_path
  const normalize = (records) => records.map(r => {
    if (r.kind === 'session') {
      const copy = { ...r };
      delete copy.jsonl_path;
      return copy;
    }
    return r;
  });

  assert.deepEqual(normalize(plainRes.values), normalize(zstRes.values));

  // Verify zst cursor format: mtime:lines:size:ctimeMs:ino:codex-zst-v1:dev
  const parts = zstRes.ret.split(':');
  assert.equal(parts.length, 7);
  assert.equal(parts[5], 'codex-zst-v1');

  // ADR-0007 verification: direct assembly equals SQLite round-trip
  const db = freshDb();
  persist(db, { key: zstPath, sessionId: `codex:${META.id}` }, zstRes.values[Symbol.iterator]());
  const detailDirect = assembleSessionDetail(zstRes.values);
  const detailDb = assembleSessionDetail(detailRows(db, `codex:${META.id}`));
  assert.deepEqual(detailDirect, detailDb, 'ADR-0007: direct assembly equals SQLite persistence round-trip');
  db.close();
});

test('discovery skips unchanged compressed files with matching cursor', () => {
  const rootDir = makeTempDir('obelisk-codex-zst-skip-');
  const sessDir = join(rootDir, 'sessions', '2026', '06', '10');
  mkdirSync(sessDir, { recursive: true });
  const zstPath = join(sessDir, 'rollout.jsonl.zst');
  writeCompressedRollout(zstPath);

  const provider = createCodexProvider({ rootDir });
  const initialUnits = provider.discover({ lastCursor: () => null });
  assert.equal(initialUnits.length, 1);

  const { ret: cursor } = drain(parse(initialUnits[0], null));
  const cursors = new Map([[zstPath, cursor]]);

  const subsequentUnits = provider.discover({ lastCursor: (key) => cursors.get(key) ?? null });
  assert.deepEqual(subsequentUnits, [], 'unchanged compressed file is skipped');

  // Verify parse() on unchanged compressed source with matching cursor returns noop
  const metrics = createCodexParseMetrics();
  const noopRes = drain(parse(initialUnits[0], cursor, metrics));
  assert.equal(metrics.plan, 'noop');
  assert.equal(noopRes.values.length, 0);
  assert.equal(noopRes.ret, cursor);
});

test('replaying unchanged compressed parent preserves child contributions', () => {
  const root = makeTempDir('obelisk-codex-zst-child-preservation-');
  const dir = join(root, 'sessions', '2026', '06', '10');
  mkdirSync(dir, { recursive: true });

  const parentId = '019ed000-0000-7000-8000-000000000301';
  const childId = '019ed000-0000-7000-8000-000000000302';
  const parentSessionId = `codex:${parentId}`;
  const parentPath = join(dir, `rollout-${parentId}.jsonl.zst`);
  const childPath = join(dir, `rollout-${childId}.jsonl.zst`);

  // Write compressed parent and child
  writeCompressedRollout(parentPath, [
    { type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: { id: parentId, cwd: '/tmp/proj', cli_version: '1.0' } },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:01Z', payload: { type: 'user_message', message: 'parent prompt' } },
  ]);

  writeCompressedRollout(childPath, [
    {
      type: 'session_meta',
      timestamp: '2026-06-10T10:00:02Z',
      payload: {
        id: childId,
        cwd: '/tmp/proj',
        source: { subagent: { thread_spawn: { parent_thread_id: parentId, agent_role: 'worker' } } },
      },
    },
    { type: 'event_msg', timestamp: '2026-06-10T10:00:03Z', payload: { type: 'user_message', message: 'child prompt' } },
  ]);

  const provider = createCodexProvider({ rootDir: root });
  const db = freshDb();
  const cursorMap = new Map();

  // Initial discovery and persistence of parent + child
  const initialUnits = provider.discover({ lastCursor: (k) => cursorMap.get(k) ?? null });
  assert.equal(initialUnits.length, 2);

  for (const unit of initialUnits) {
    cursorMap.set(unit.key, persist(db, unit, provider.parse(unit, null)));
  }

  // Verify child contributions are in DB
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id=?').get(parentSessionId).count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM subagents WHERE session_id=?').get(parentSessionId).count, 1);

  // Now simulate a changedPaths event or explicit re-parse of parent only
  const parentUnit = initialUnits.find(u => u.key === parentPath);
  const parentCursor = cursorMap.get(parentPath);
  cursorMap.set(parentPath, persist(db, parentUnit, provider.parse(parentUnit, parentCursor)));

  // Child contributions must still be intact!
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id=?').get(parentSessionId).count, 2, 'child message preserved');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM subagents WHERE session_id=?').get(parentSessionId).count, 1, 'child subagent preserved');

  db.close();
});

test('malformed completed line in compressed rollout with prior cursor throws CODEX_MALFORMED_LINE_ERROR', () => {
  const dir = makeTempDir('obelisk-codex-zst-malformed-');
  const zstPath = join(dir, 'rollout.jsonl.zst');

  // Step 1: Initial valid parse
  writeCompressedRollout(zstPath);
  const { ret: cursor } = drain(parse({ key: zstPath, sessionId: '' }, null));
  assert.ok(cursor);

  // Step 2: Replace with valid zstd archive containing a malformed completed JSONL line
  const badContent = Buffer.from(
    JSON.stringify({ type: 'session_meta', timestamp: '2026-06-10T10:00:00Z', payload: META }) + '\n'
    + 'this is not valid json\n',
    'utf8'
  );
  writeFileSync(zstPath, zstdCompressSync(badContent));

  assert.throws(
    () => drain(parse({ key: zstPath, sessionId: '' }, cursor)),
    /Malformed JSONL line/,
    'throws CODEX_MALFORMED_LINE_ERROR when prior cursor exists'
  );
});

test('rawCodex lookup works on compressed rollouts and resolves plain-to-zst transitions', () => {
  const rootDir = makeTempDir('obelisk-codex-zst-raw-');
  const sessDir = join(rootDir, 'sessions', '2026', '06', '10');
  mkdirSync(sessDir, { recursive: true });
  const zstPath = join(sessDir, `rollout-2026-06-10T10-00-00-${META.id}.jsonl.zst`);
  writeCompressedRollout(zstPath);

  const provider = createCodexProvider({ rootDir });
  const rawRecord = provider.raw({
    agentId: null,
    messageUuid: `codex:${META.id}:2`,
    session: { jsonl_path: zstPath },
  });

  assert.ok(rawRecord !== null, 'raw lookup succeeds on .jsonl.zst');
  assert.match(rawRecord.text, /user_message/);
  assert.equal(rawRecord.messageText, 'hello codex');

  // Also test representation transition: session record stored old plaintext path,
  // but now only the .zst exists on disk
  const oldPlainPath = zstPath.slice(0, -'.zst'.length);
  const transitionedRaw = provider.raw({
    agentId: null,
    messageUuid: `codex:${META.id}:2`,
    session: { jsonl_path: oldPlainPath },
  });
  assert.ok(transitionedRaw !== null, 'resolves .zst when old path was .jsonl');
  assert.equal(transitionedRaw.messageText, 'hello codex');
});

test('discoverAt reports incomplete inventory on corrupt compressed file', () => {
  const rootDir = makeTempDir('obelisk-codex-zst-corrupt-');
  const sessDir = join(rootDir, 'sessions', '2026', '06', '10');
  mkdirSync(sessDir, { recursive: true });
  const corruptPath = join(sessDir, 'rollout-corrupt.jsonl.zst');
  writeFileSync(corruptPath, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00])); // incomplete zstd frame

  const reported = [];
  const provider = createCodexProvider({ rootDir });
  const units = provider.discover({
    lastCursor: () => null,
    reportIncompleteInventory: (issue) => reported.push(issue),
  });

  assert.equal(units.length, 0);
  assert.equal(reported.length, 1);
  assert.equal(reported[0].path, corruptPath);
});
