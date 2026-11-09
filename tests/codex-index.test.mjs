// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Phase 5c: exercises the full codex buildIndex path (discover → codex.parse →
// persist) for both a fresh full build and an incremental rebuild after append.
// Codex is full-reparse with countMode 'total', so growth must REPLACE the count
// (not accumulate) and upsert messages (no duplicates).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, appendFileSync, utimesSync, statSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import { runCli } from './cli-test-helpers.mjs';
import { makeTempDir } from './temp-dirs.mjs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

function runRuntime(args, home) {
  return runCli(args, { home });
}

const ID = '019ed000-0000-7000-8000-000000000001';

function metaLine() {
  return JSON.stringify({ type: 'session_meta', timestamp: '2026-06-15T10:00:00Z', payload: { id: ID, timestamp: '2026-06-15T10:00:00Z', cwd: '/tmp/cdx', cli_version: '1.0' } });
}
function evt(type, message, ts) {
  return JSON.stringify({ type: 'event_msg', timestamp: ts, payload: { type, message } });
}

function clearDebounce(home) {
  const db = new DatabaseSync(join(home, '.obelisk', 'obelisk.sqlite'));
  db.prepare("DELETE FROM index_state WHERE jsonl_path='__last_build__'").run();
  db.close();
}

function codexCounts(home) {
  writeFileSync(join(home, 'q.mjs'), `return {
    sessions: sql("SELECT COUNT(*) c FROM sessions WHERE source='codex'")[0].c,
    mc: sql("SELECT message_count FROM sessions WHERE source='codex'")[0]?.message_count ?? null,
    msgs: sql("SELECT COUNT(*) c FROM messages WHERE source='codex'")[0].c,
    hits: search('followup', { source: 'codex', limit: 5 }).length,
  };`);
  const r = runRuntime(['--query', join(home, 'q.mjs')], home);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return JSON.parse(r.stdout);
}

test('codex full build then incremental rebuild replaces the total count without duplicates', () => {
  const home = makeTempDir('obelisk-codex-idx-');
  const dir = join(home, '.codex', 'sessions', '2026', '06', '15');
  mkdirSync(dir, { recursive: true });
  const jsonl = join(dir, `rollout-2026-06-15T10-00-00-${ID}.jsonl`);

  // Full build: one user + one agent message.
  writeFileSync(jsonl, [metaLine(), evt('user_message', 'codex hello', '2026-06-15T10:00:01Z'), evt('agent_message', 'codex reply', '2026-06-15T10:00:02Z')].join('\n') + '\n');
  assert.equal(runRuntime(['--build'], home).status, 0);

  let c = codexCounts(home);
  assert.equal(c.sessions, 1, 'one codex session indexed');
  assert.equal(c.mc, 2, 'two messages counted');
  assert.equal(c.msgs, 2);

  // Append a third message; bump mtime; incremental rebuild (full-reparse).
  appendFileSync(jsonl, evt('user_message', 'codex followup', '2026-06-15T10:01:00Z') + '\n');
  const t = statSync(jsonl).mtimeMs / 1000 + 10;
  utimesSync(jsonl, t, t);
  clearDebounce(home);

  c = codexCounts(home);
  // 'total' replace: 3, not 5 (2+3) and not a stale 2.
  assert.equal(c.mc, 3, 'message_count replaced with the new total');
  assert.equal(c.msgs, 3, 'exactly three messages, upserted (no duplicates)');
  assert.equal(c.hits, 1, 'the appended message is searchable');
});

// #104: a real same-mtime append must survive the full discover → parse →
// persist path — the mtime is forced back after appending, so only the
// size/ctime legs of the cursor signature can catch it.
test('codex incremental rebuild detects a real append forced to the same mtime', () => {
  const home = makeTempDir('obelisk-codex-samemtime-');
  const dir = join(home, '.codex', 'sessions', '2026', '06', '15');
  mkdirSync(dir, { recursive: true });
  const jsonl = join(dir, `rollout-2026-06-15T10-00-00-${ID}.jsonl`);

  writeFileSync(jsonl, [metaLine(), evt('user_message', 'codex hello', '2026-06-15T10:00:01Z'), evt('agent_message', 'codex reply', '2026-06-15T10:00:02Z')].join('\n') + '\n');
  assert.equal(runRuntime(['--build'], home).status, 0);
  assert.equal(codexCounts(home).msgs, 2);

  const orig = statSync(jsonl).mtimeMs / 1000;
  appendFileSync(jsonl, evt('user_message', 'same-mtime followup', '2026-06-15T10:01:00Z') + '\n');
  utimesSync(jsonl, orig, orig); // force the mtime back — same-millisecond append
  clearDebounce(home);

  const c = codexCounts(home);
  assert.equal(c.msgs, 3, 'the same-mtime append is re-parsed');
  assert.equal(c.hits, 1, 'the appended message is searchable');
});

// #104: an in-place rewrite that preserves size AND mtime can only be caught
// by ctime/ino. Node reports ctime as the status-change time on every
// platform (birthtime is the creation time), so this runs everywhere.
test('codex incremental rebuild detects a same-size rewrite forced to the same mtime', () => {
  const home = makeTempDir('obelisk-codex-samemtime-rewrite-');
  const dir = join(home, '.codex', 'sessions', '2026', '06', '15');
  mkdirSync(dir, { recursive: true });
  const jsonl = join(dir, `rollout-2026-06-15T10-00-00-${ID}.jsonl`);

  // 'alpha' and 'omega' are equal length, keeping size identical.
  writeFileSync(jsonl, [metaLine(), evt('user_message', 'codex alpha value', '2026-06-15T10:00:01Z'), evt('agent_message', 'codex reply', '2026-06-15T10:00:02Z')].join('\n') + '\n');
  assert.equal(runRuntime(['--build'], home).status, 0);

  const orig = statSync(jsonl).mtimeMs / 1000;
  writeFileSync(jsonl, [metaLine(), evt('user_message', 'codex omega value', '2026-06-15T10:00:01Z'), evt('agent_message', 'codex reply', '2026-06-15T10:00:02Z')].join('\n') + '\n');
  utimesSync(jsonl, orig, orig);
  clearDebounce(home);

  writeFileSync(join(home, 'q.mjs'), `return {
    alpha: search('alpha', { source: 'codex', limit: 5 }).length,
    omega: search('omega', { source: 'codex', limit: 5 }).length,
  };`);
  const r = runRuntime(['--query', join(home, 'q.mjs')], home);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.deepEqual(JSON.parse(r.stdout), { alpha: 0, omega: 1 }, 'the rewritten content replaces the old text');
});

// #104: a real replacement swaps the file identity itself (write temp +
// rename over). Size and mtime are forced equal, so only the ctime/ino legs
// can catch it.
test('codex incremental rebuild detects a rename replacement forced to the same mtime', () => {
  const home = makeTempDir('obelisk-codex-samemtime-replace-');
  const dir = join(home, '.codex', 'sessions', '2026', '06', '15');
  mkdirSync(dir, { recursive: true });
  const jsonl = join(dir, `rollout-2026-06-15T10-00-00-${ID}.jsonl`);

  // 'alpha' and 'omega' are equal length, keeping size identical.
  writeFileSync(jsonl, [metaLine(), evt('user_message', 'codex alpha value', '2026-06-15T10:00:01Z'), evt('agent_message', 'codex reply', '2026-06-15T10:00:02Z')].join('\n') + '\n');
  assert.equal(runRuntime(['--build'], home).status, 0);

  const orig = statSync(jsonl).mtimeMs / 1000;
  const tmp = join(dir, 'replacement.tmp');
  writeFileSync(tmp, [metaLine(), evt('user_message', 'codex omega value', '2026-06-15T10:00:01Z'), evt('agent_message', 'codex reply', '2026-06-15T10:00:02Z')].join('\n') + '\n');
  utimesSync(tmp, orig, orig);
  rmSync(jsonl); // Windows cannot rename over an existing path
  renameSync(tmp, jsonl);
  clearDebounce(home);

  writeFileSync(join(home, 'q.mjs'), `return {
    alpha: search('alpha', { source: 'codex', limit: 5 }).length,
    omega: search('omega', { source: 'codex', limit: 5 }).length,
  };`);
  const r = runRuntime(['--query', join(home, 'q.mjs')], home);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.deepEqual(JSON.parse(r.stdout), { alpha: 0, omega: 1 }, 'the replacement content replaces the old text');
});

// A cp -p / rsync -a style touch preserves mtime and size while ctime
// necessarily changes. The build must heal the cursor signature after one
// verified pass instead of re-fingerprinting the whole file on every build
// forever.
test('codex incremental build heals a touched-but-unchanged rollout', () => {
  const home = makeTempDir('obelisk-codex-touch-heal-');
  const dir = join(home, '.codex', 'sessions', '2026', '06', '15');
  mkdirSync(dir, { recursive: true });
  const jsonl = join(dir, `rollout-2026-06-15T10-00-00-${ID}.jsonl`);

  writeFileSync(jsonl, [metaLine(), evt('user_message', 'codex hello', '2026-06-15T10:00:01Z'), evt('agent_message', 'codex reply', '2026-06-15T10:00:02Z')].join('\n') + '\n');
  assert.equal(runRuntime(['--build'], home).status, 0);
  assert.equal(codexCounts(home).msgs, 2);

  const s = statSync(jsonl);
  utimesSync(jsonl, s.atime, s.mtime); // ctime-only change
  clearDebounce(home);
  let c = codexCounts(home);
  assert.equal(c.sessions, 1, 'the touched rollout keeps its session');
  assert.equal(c.msgs, 2, 'the touched rollout stays correctly indexed');

  // A second touch must heal the same way instead of accumulating damage.
  const s2 = statSync(jsonl);
  utimesSync(jsonl, s2.atime, s2.mtime);
  clearDebounce(home);
  c = codexCounts(home);
  assert.equal(c.sessions, 1);
  assert.equal(c.msgs, 2, 'a second touch converges the same way');
});

// A torn write completed by a later append becomes a "complete but invalid"
// JSONL line. The freeze stays fail-closed, but every incremental build must
// surface the frozen source as a skipped-file warning, and repairing the
// source resumes indexing.
test('codex incremental build surfaces a frozen malformed rollout and resumes after repair', () => {
  const home = makeTempDir('obelisk-codex-malformed-freeze-');
  const dir = join(home, '.codex', 'sessions', '2026', '06', '15');
  mkdirSync(dir, { recursive: true });
  const jsonl = join(dir, `rollout-2026-06-15T10-00-00-${ID}.jsonl`);

  writeFileSync(jsonl, [metaLine(), evt('user_message', 'codex hello', '2026-06-15T10:00:01Z'), evt('agent_message', 'codex reply', '2026-06-15T10:00:02Z')].join('\n') + '\n');
  assert.equal(runRuntime(['--build'], home).status, 0);
  assert.equal(codexCounts(home).msgs, 2);

  appendFileSync(jsonl, '{not valid json}\n');
  clearDebounce(home);
  let c = codexCounts(home);
  assert.equal(c.msgs, 2, 'the frozen rollout keeps its indexed rows');

  // The same corrupt source keeps surfacing the skipped-file warning on
  // every incremental build instead of failing silently.
  clearDebounce(home);
  const r = runRuntime(['--query', join(home, 'q.mjs')], home);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stderr, /Malformed JSONL line: incremental indexing is frozen/, 'the CLI surfaces the frozen source');

  // Repair the source: the same prefix plus a valid appended message.
  writeFileSync(jsonl, [
    metaLine(),
    evt('user_message', 'codex hello', '2026-06-15T10:00:01Z'),
    evt('agent_message', 'codex reply', '2026-06-15T10:00:02Z'),
    evt('user_message', 'followup after repair', '2026-06-15T10:02:00Z'),
  ].join('\n') + '\n');
  clearDebounce(home);
  c = codexCounts(home);
  assert.equal(c.msgs, 3, 'a repaired rollout resumes indexing');
  assert.equal(c.hits, 1, 'the repaired append is searchable');
});

// RFC #172: the CLI's pre-query refresh is a full-inventory pass and, for a
// CLI-only user, their reconciliation — there is no watcher to reconcile
// against. It must select strict read mode, so an append is verified rather
// than trusted: a cooperative append would clear verifiedPrefix on the stored
// cursor, a verified append keeps it true.
test('codex CLI query refresh verifies prefixes instead of trusting cooperative appends', () => {
  const home = makeTempDir('obelisk-codex-cli-strict-');
  const dir = join(home, '.codex', 'sessions', '2026', '06', '15');
  mkdirSync(dir, { recursive: true });
  const jsonl = join(dir, `rollout-2026-06-15T10-00-00-${ID}.jsonl`);

  writeFileSync(jsonl, [metaLine(), evt('user_message', 'codex hello', '2026-06-15T10:00:01Z')].join('\n') + '\n');
  assert.equal(runRuntime(['--build'], home).status, 0);

  const cursorState = () => {
    const db = new DatabaseSync(join(home, '.obelisk', 'obelisk.sqlite'));
    try {
      const cursor = db.prepare('SELECT cursor FROM index_state WHERE jsonl_path = ?').get(jsonl)?.cursor;
      assert.ok(typeof cursor === 'string' && cursor.length > 0, 'a provider cursor is stored for the rollout');
      return JSON.parse(Buffer.from(cursor.split(':', 6)[5], 'base64url').toString('utf8'));
    } finally {
      db.close();
    }
  };
  assert.equal(cursorState().verifiedPrefix, true, 'the force snapshot establishes a verified cursor');

  appendFileSync(jsonl, evt('user_message', 'codex followup', '2026-06-15T10:01:00Z') + '\n');
  clearDebounce(home);
  const c = codexCounts(home); // --query triggers the pre-query refresh build
  assert.equal(c.msgs, 2, 'the appended message is indexed by the refresh');
  assert.equal(c.hits, 1, 'the appended message is searchable');
  assert.equal(cursorState().verifiedPrefix, true, 'the CLI refresh takes verified append, not cooperative');
});
