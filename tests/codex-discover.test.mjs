// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Codex discovery skip logic (#114): a cursor-clean transcript — guardian or
// not — is skipped without reading its contents. Guardian detection only runs
// for files that actually need re-parsing; stale guardian rows from pre-fix
// databases are retracted by the marker-driven full replay instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createCodexProvider } from '../packages/core/src/providers/codex.ts';
import { makeTempDir } from './temp-dirs.mjs';

const GUARDIAN_ID = '019ed5c4-8d52-7bc0-91f3-447a15e987d1';
const PLAIN_ID = '019e8951-3e7d-7343-a3e3-05bff48a317d';

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

function cursorAt(path, offsetMs) {
  return `${String(statSync(path).mtimeMs + offsetMs)}:2`;
}

test('codex discovery skips guardian and plain transcripts with clean cursors', () => {
  const rootDir = makeTempDir('obelisk-codex-discover-');
  const guardianPath = writeRollout(rootDir, GUARDIAN_ID, {
    thread_source: 'subagent',
    source: { subagent: { other: 'guardian' } },
  });
  const plainPath = writeRollout(rootDir, PLAIN_ID, {});
  const cursors = new Map([
    [guardianPath, cursorAt(guardianPath, 1000)],
    [plainPath, cursorAt(plainPath, 1000)],
  ]);

  const units = createCodexProvider({ rootDir }).discover({
    lastCursor: (key) => cursors.get(key) ?? null,
  });
  assert.deepEqual(units, [], 'both cursor-clean files are skipped');
});

test('codex discovery still flags a guardian transcript whose cursor is stale', () => {
  const rootDir = makeTempDir('obelisk-codex-discover-');
  const guardianPath = writeRollout(rootDir, GUARDIAN_ID, {
    thread_source: 'subagent',
    source: { subagent: { other: 'guardian' } },
  });

  const units = createCodexProvider({ rootDir }).discover({
    lastCursor: () => cursorAt(guardianPath, -10000),
  });
  assert.equal(units.length, 1, 'stale cursor forces re-planning');
  assert.equal(units[0].sessionId, '', 'guardian units carry no session id');
  assert.equal(units[0].meta.guardian, true, 'guardian detection runs for re-planned files');
});
