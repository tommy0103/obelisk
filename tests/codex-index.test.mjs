// Phase 5c: exercises the full codex buildIndex path (discover → codex.parse →
// persist) for both a fresh full build and an incremental rebuild after append.
// Codex is full-reparse with countMode 'total', so growth must REPLACE the count
// (not accumulate) and upsert messages (no duplicates).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, appendFileSync, utimesSync, statSync } from 'node:fs';
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
