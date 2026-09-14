// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Tier 1 contract golden tests (see docs/adr/0002-two-tier-runtime-contract.md).
//
// These lock the four-verb CLI I/O envelope at the process boundary so the
// upcoming TypeScript / runtime-core refactor cannot silently change what an
// agent (through the CLI or a future MCP transport) observes on stdout:
//   --build   -> { ok: true, db }
//   --search  -> JSON array
//   --query   -> pretty-printed JSON result, or { error, stack } + exit 1 on throw
//   --attune  -> pretty-printed JSON result, or { error, stack } + exit 1 on throw
//
// The sandbox contract (query cannot call attune helpers, attune exposes only
// remember/forget, etc.) is covered separately in runtime.test.mjs; this file is
// only about the transport envelope.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runCli as runRuntime } from './cli-test-helpers.mjs';
import { makeTempDir } from './temp-dirs.mjs';

function tempHome() {
  const home = makeTempDir('obelisk-cli-envelope-');
  mkdirSync(join(home, '.claude'), { recursive: true });
  return home;
}

test('--build emits { ok: true, db } pointing at the resolved db path', () => {
  const home = tempHome();
  const result = runRuntime(['--build'], { home });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(typeof payload.db, 'string');
  assert.ok(
    payload.db.endsWith(join('.obelisk', 'obelisk.sqlite')),
    `db path should resolve under HOME/.obelisk, got ${payload.db}`,
  );
});

test('--search emits a JSON array envelope', () => {
  const home = tempHome();
  const result = runRuntime(['--search', 'zzznomatchzzz'], { home });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.ok(Array.isArray(payload), 'search must return a JSON array');
});

test('--search compact mode bounds hits, context, and snippets', () => {
  const home = tempHome();
  const projectDir = join(home, '.claude', 'projects', '-tmp-compact');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, 'compact-session.jsonl'), [
    {
      uuid: 'compact-user',
      type: 'user',
      timestamp: '2026-08-25T10:00:00.000Z',
      cwd: '/tmp/compact',
      message: { role: 'user', content: 'compact needle with a deliberately long payload' },
    },
    {
      uuid: 'compact-assistant',
      type: 'assistant',
      parentUuid: 'compact-user',
      timestamp: '2026-08-25T10:00:01.000Z',
      cwd: '/tmp/compact',
      message: { role: 'assistant', content: 'nearby context that should be omitted' },
    },
  ].map(line => JSON.stringify(line)).join('\n') + '\n');

  const result = runRuntime([
    '--search', 'compact needle',
    '--compact', '--limit', '1', '--context', '0', '--snippet-length', '12',
  ], { home });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.length, 1);
  assert.equal(payload[0].message.snippet, 'compact need');
  assert.equal('text' in payload[0].message, false);
  assert.deepEqual(payload[0].context, []);
  assert.equal(payload[0].session.id, 'compact-session');
});

test('--search rejects invalid output bounds', () => {
  const home = tempHome();
  const result = runRuntime(['--search', 'needle', '--context', '-1'], { home });

  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).error, /--context requires an integer >= 0/);
});

test('--query returns a pretty-printed JSON result on success', () => {
  const home = tempHome();
  const scriptPath = join(home, 'ok.mjs');
  writeFileSync(scriptPath, 'return { answer: 42 };');

  const result = runRuntime(['--query', scriptPath], { home });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { answer: 42 });
  // Pretty-printed with two-space indentation (JSON.stringify(r, null, 2)).
  assert.match(result.stdout, /\n {2}"answer": 42/);
});

test('--query surfaces a throw as { error, stack } and exits 1', () => {
  const home = tempHome();
  const scriptPath = join(home, 'boom.mjs');
  writeFileSync(scriptPath, "throw new Error('boom-envelope');");

  const result = runRuntime(['--query', scriptPath], { home });

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.error, 'boom-envelope');
  assert.equal(typeof payload.stack, 'string');
});

test('--attune surfaces a throw as { error, stack } and exits 1', () => {
  const home = tempHome();
  // Attune requires an initialized index; bring one up so the script's own
  // throw is what surfaces.
  const initPath = join(home, 'init.mjs');
  writeFileSync(initPath, "return 'init';");
  const init = runRuntime(['--query', initPath], { home });
  assert.equal(init.status, 0, init.stderr || init.stdout);
  const scriptPath = join(home, 'attune-boom.mjs');
  writeFileSync(scriptPath, "throw new Error('attune-envelope');");

  const result = runRuntime(['--attune', scriptPath], { home });

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.error, 'attune-envelope');
  assert.equal(typeof payload.stack, 'string');
});

test('unknown verb prints usage to stderr and exits non-zero', () => {
  const home = tempHome();
  const result = runRuntime(['--nonsense'], { home });

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Usage:/);
  assert.match(result.stderr, /--build/);
});

test('--search tolerates FTS-special input via safe tokenization', () => {
  // A hyphenated term is FTS5 operator syntax. search() falls back to safe
  // per-token quoting instead of crashing, so the CLI returns an array, not an
  // error. (The uniform { error, stack } envelope is exercised via --query/--attune.)
  const home = tempHome();
  const result = runRuntime(['--search', 'foo-bar'], { home });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(Array.isArray(JSON.parse(result.stdout)), 'search must return a JSON array');
});
