// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Codex discovery skip logic (#114): a transcript whose cursor signature still
// matches — guardian or not — is skipped without reading its contents. Guardian
// detection only runs for files that actually need re-parsing; stale guardian
// rows from pre-fix databases are retracted by the marker-driven full replay
// instead. Codex cursors use the shared mtime+ctime+size+inode signature
// (CONTRIBUTING), so a same-mtime rewrite is re-planned even for guardians.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createCodexProvider } from '../packages/core/src/providers/codex.ts';
import { makeTempDir } from './temp-dirs.mjs';

const GUARDIAN_ID = '019ed5c4-8d52-7bc0-91f3-447a15e987d1';
const PLAIN_ID = '019e8951-3e7d-7343-a3e3-05bff48a317d';

const GUARDIAN_META = {
  thread_source: 'subagent',
  source: { subagent: { other: 'guardian' } },
};

function writeRollout(rootDir, id, metaExtra) {
  const dir = join(rootDir, 'sessions', '2026', '06', '15');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-06-15T10-00-00-${id}.jsonl`);
  writeFileSync(path, [
    JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-06-15T10:00:00Z',
      payload: { id, timestamp: '2026-06-15T10:00:00Z', cwd: '/tmp/cdx', cli_version: '1.0', ...metaExtra },
    }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-06-15T10:00:01Z', payload: { type: 'user_message', message: 'hello' } }),
    '',
  ].join('\n'));
  return path;
}

// `${mtime}:${lines}:${size}:${ctimeMs}:${ino}` — see codexCursorSignatureDiffers.
function cursorFor(path, overrides = {}) {
  const s = statSync(path);
  return [overrides.mtimeMs ?? s.mtimeMs, 2, overrides.size ?? s.size, s.ctimeMs, s.ino].join(':');
}

function discoverWith(rootDir, cursors) {
  return createCodexProvider({ rootDir }).discover({
    lastCursor: (key) => cursors.get(key) ?? null,
  });
}

test('codex discovery skips guardian and plain transcripts with matching cursor signatures', () => {
  const rootDir = makeTempDir('obelisk-codex-discover-');
  const guardianPath = writeRollout(rootDir, GUARDIAN_ID, GUARDIAN_META);
  const plainPath = writeRollout(rootDir, PLAIN_ID, {});
  const cursors = new Map([
    [guardianPath, cursorFor(guardianPath)],
    [plainPath, cursorFor(plainPath)],
  ]);

  assert.deepEqual(discoverWith(rootDir, cursors), [], 'both cursor-clean files are skipped');
});

test('codex discovery re-plans a guardian transcript rewritten at the same mtime', () => {
  const rootDir = makeTempDir('obelisk-codex-discover-');
  const guardianPath = writeRollout(rootDir, GUARDIAN_ID, GUARDIAN_META);
  // Same mtime, different size: a same-millisecond append must not be skipped.
  const cursors = new Map([[guardianPath, cursorFor(guardianPath, { size: statSync(guardianPath).size + 1 })]]);

  const units = discoverWith(rootDir, cursors);
  assert.equal(units.length, 1, 'a changed signature forces re-planning');
  assert.equal(units[0].sessionId, '', 'guardian units carry no session id');
  assert.equal(units[0].meta.guardian, true, 'guardian detection runs for re-planned files');
});

test('codex discovery recognizes a legacy guardian model before session metadata', () => {
  const rootDir = makeTempDir('obelisk-codex-discover-');
  const dir = join(rootDir, 'sessions', '2026', '06', '15');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-06-15T10-00-00-${GUARDIAN_ID}.jsonl`);
  writeFileSync(path, [
    JSON.stringify({ type: 'turn_context', payload: { model: 'codex-auto-review' } }),
    JSON.stringify({
      type: 'session_meta',
      payload: { id: GUARDIAN_ID, cwd: '/tmp/cdx', thread_source: 'subagent' },
    }),
    '',
  ].join('\n'));

  const units = discoverWith(rootDir, new Map());
  assert.equal(units[0].sessionId, '');
  assert.equal(units[0].meta.guardian, true);
});

test('codex discovery fails closed on a legacy mtime-only cursor, even at the current mtime', () => {
  const rootDir = makeTempDir('obelisk-codex-discover-');
  const guardianPath = writeRollout(rootDir, GUARDIAN_ID, GUARDIAN_META);
  // A two-part cursor cannot prove the file is unchanged, so it re-parses
  // once and upgrades to the full signature — even when mtimes match.
  const legacyCursor = `${String(statSync(guardianPath).mtimeMs)}:2`;
  const cursors = new Map([[guardianPath, legacyCursor]]);

  const units = discoverWith(rootDir, cursors);
  assert.equal(units.length, 1, 'a legacy cursor at the current mtime is re-planned');
  assert.equal(units[0].meta.guardian, true);
});

test('codex discovery honors an exact changedPaths report over a matching cursor', () => {
  const rootDir = makeTempDir('obelisk-codex-discover-');
  const guardianPath = writeRollout(rootDir, GUARDIAN_ID, GUARDIAN_META);
  const plainPath = writeRollout(rootDir, PLAIN_ID, {});
  const cursors = new Map([
    [guardianPath, cursorFor(guardianPath)],
    [plainPath, cursorFor(plainPath)],
  ]);

  // The watcher path: an exact change report must re-plan the file even when
  // its cursor signature still matches.
  const units = createCodexProvider({ rootDir }).discover({
    lastCursor: (key) => cursors.get(key) ?? null,
    changedPaths: [guardianPath],
  });
  assert.deepEqual(units.map((u) => u.key), [guardianPath], 'only the reported file is re-planned');
});
