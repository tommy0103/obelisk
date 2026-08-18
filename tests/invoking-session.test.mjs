// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Nonce self-search: the CLI embeds a unique invocation nonce in its argv
// (--search --nonce <token>, or the as-typed --query file path). Providers
// write the tool-call record before the tool finishes, so after the pre-query
// index refresh the nonce is in the fresh index. The session with the newest
// matching record is the invoking session; matches far apart in time are
// unrelated history (newest wins), while a near-simultaneous collision or no
// match at all resolves to null.
// When the first lookup misses, one incremental recovery build plus a bounded
// poll close the index-freshness gap before falling back to honest null.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createQueryApi } from '../packages/core/src/query.ts';
import { resolveInvokingSessionId, resolveInvokingSessionIdWithWait } from '../packages/core/src/core.ts';
import { acquireWriterLease, writerLockPathFor } from '../packages/core/src/writer-lease.ts';
import { cliEntry, repoRoot, runCli } from './cli-test-helpers.mjs';
import { makeTempDir } from './temp-dirs.mjs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');

const NONCE = 'obq-7f3c9a2e-4b1d-8e5f-unique';
// The unit fixtures below use fixed timestamps in this era; pin nowMs to it so
// the resolver's recency window (default 15min) keeps them in scope.
const FIXTURE_NOW_MS = Date.parse('2026-08-11T10:00:10Z');

function tempHome(prefix) {
  const home = makeTempDir(prefix);
  mkdirSync(join(home, '.claude'), { recursive: true });
  return home;
}

function runCliAsync(args, { home }) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [
      '--disable-warning=ExperimentalWarning',
      cliEntry,
      ...args,
    ], {
      cwd: repoRoot,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', status => resolveRun({ status, stdout, stderr }));
  });
}

function invokingDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const insertSession = db.prepare(`
    INSERT INTO sessions (id, title, project, started_at, ended_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  insertSession.run('sid-self', 'Invoking session', 'quiet-zero', '2026-08-11T10:00:00Z', null);
  insertSession.run('sid-history', 'Historical session', 'quiet-zero', '2026-08-01T10:00:00Z', '2026-08-01T11:00:00Z');
  const insertMessage = db.prepare(`
    INSERT INTO messages (uuid, session_id, type, role, text, timestamp, visibility, source)
    VALUES (?,?,?,?,?,?,?,?)
  `);
  // The invoking session holds the obelisk tool call whose command line
  // contains the nonce, plus ordinary needle evidence in both sessions.
  insertMessage.run('msg-self-call', 'sid-self', 'assistant', 'assistant', null, '2026-08-11T10:00:01Z', 'visible', 'claude');
  insertMessage.run('msg-self', 'sid-self', 'assistant', 'assistant', 'self needle reply', '2026-08-11T10:00:02Z', 'visible', 'claude');
  insertMessage.run('msg-history', 'sid-history', 'assistant', 'assistant', 'historical needle reply', '2026-08-01T10:00:01Z', 'visible', 'claude');
  db.prepare(`
    INSERT INTO tool_calls (id, message_uuid, session_id, name, input_json)
    VALUES (?,?,?,?,?)
  `).run('call-self', 'msg-self-call', 'sid-self', 'Bash', JSON.stringify({ command: `obelisk --search "needle" --nonce ${NONCE}` }));
  return db;
}

test('resolver finds the invoking session via the tool-call command line', () => {
  const db = invokingDb();

  assert.equal(resolveInvokingSessionId(db, NONCE, { nowMs: FIXTURE_NOW_MS }), 'sid-self');
  db.close();
});

test('resolver matches a JSON-escaped nonce in tool_calls input_json', () => {
  // Windows-style nonces contain backslashes, which JSON encoding doubles in
  // stored input_json; the raw LIKE pattern alone would miss the record.
  const db = invokingDb();
  const winNonce = 'C:\\tmp\\obq.win789.mjs';
  db.prepare('INSERT INTO tool_calls (id, message_uuid, session_id, name, input_json) VALUES (?,?,?,?,?)')
    .run('call-win', 'msg-self-call', 'sid-self', 'Bash', JSON.stringify({ command: `obelisk --query ${winNonce}` }));

  assert.equal(resolveInvokingSessionId(db, winNonce, { nowMs: FIXTURE_NOW_MS }), 'sid-self');
  db.close();
});

test('resolver finds the invoking session via message text', () => {
  const db = invokingDb();
  db.prepare('INSERT INTO messages (uuid, session_id, type, role, text, timestamp) VALUES (?,?,?,?,?,?)')
    .run('msg-self-nonce', 'sid-self', 'user', 'user', `ran obelisk --query /tmp/obq.${NONCE}.mjs`, '2026-08-11T10:00:03Z');

  assert.equal(resolveInvokingSessionId(db, `/tmp/obq.${NONCE}.mjs`, { nowMs: FIXTURE_NOW_MS }), 'sid-self');
  db.close();
});

test('resolver returns null for missing or unknown nonces', () => {
  const db = invokingDb();

  assert.equal(resolveInvokingSessionId(db, undefined), null);
  assert.equal(resolveInvokingSessionId(db, null), null);
  assert.equal(resolveInvokingSessionId(db, ''), null);
  assert.equal(resolveInvokingSessionId(db, 'obq-never-appears-anywhere'), null);
  db.close();
});

test('same nonce far apart in time resolves to the newest session', () => {
  // Matches far apart are unrelated history (a replayed command line), not
  // ambiguity: the invoking record is always written "now", so newest wins.
  const db = invokingDb();
  db.prepare('INSERT INTO messages (uuid, session_id, type, role, text, timestamp) VALUES (?,?,?,?,?,?)')
    .run('msg-history-call', 'sid-history', 'assistant', 'assistant', null, '2026-08-11T09:50:05Z');
  db.prepare('INSERT INTO tool_calls (id, message_uuid, session_id, name, input_json) VALUES (?,?,?,?,?)')
    .run('call-history', 'msg-history-call', 'sid-history', 'Bash', JSON.stringify({ command: `obelisk --search "needle" --nonce ${NONCE}` }));

  assert.equal(resolveInvokingSessionId(db, NONCE, { nowMs: FIXTURE_NOW_MS }), 'sid-self');
  db.close();
});

test('same nonce within the collision epsilon resolves to null', () => {
  // Two sessions whose newest matching records land seconds apart are a
  // genuine concurrent collision: honest unknown.
  const db = invokingDb();
  db.prepare('INSERT INTO messages (uuid, session_id, type, role, text, timestamp) VALUES (?,?,?,?,?,?)')
    .run('msg-history-call', 'sid-history', 'assistant', 'assistant', null, '2026-08-11T10:00:06Z');
  db.prepare('INSERT INTO tool_calls (id, message_uuid, session_id, name, input_json) VALUES (?,?,?,?,?)')
    .run('call-history', 'msg-history-call', 'sid-history', 'Bash', JSON.stringify({ command: `obelisk --search "needle" --nonce ${NONCE}` }));

  // sid-self at 10:00:01 vs sid-history at 10:00:06: 5s apart, within 10s.
  assert.equal(resolveInvokingSessionId(db, NONCE, { nowMs: FIXTURE_NOW_MS }), null);
  db.close();
});

test('a session merely quoting the command loses to the real execution', () => {
  // sid-history mentions the nonce in message text two minutes BEFORE sid-self
  // executed it: the quote is older than the real execution, so newest-wins
  // resolves to the executing session instead of poisoning to null.
  const db = invokingDb();
  db.prepare('INSERT INTO messages (uuid, session_id, type, role, text, timestamp) VALUES (?,?,?,?,?,?)')
    .run('msg-history-quote', 'sid-history', 'user', 'user', `what does obelisk --search "needle" --nonce ${NONCE} do?`, '2026-08-11T09:58:01Z');

  assert.equal(resolveInvokingSessionId(db, NONCE, { nowMs: FIXTURE_NOW_MS }), 'sid-self');
  db.close();
});

test('resolver bounds the tool_calls scan to the recency window', () => {
  const db = invokingDb();

  // In window (9s after the tool call): resolves.
  assert.equal(resolveInvokingSessionId(db, NONCE, { nowMs: FIXTURE_NOW_MS }), 'sid-self');
  // Older than the 15-minute window: honest null — only stale/replayed nonces.
  assert.equal(resolveInvokingSessionId(db, NONCE, { nowMs: FIXTURE_NOW_MS + 20 * 60 * 1000 }), null);
  // An explicit wider window still reaches the older record.
  assert.equal(
    resolveInvokingSessionId(db, NONCE, { nowMs: FIXTURE_NOW_MS + 20 * 60 * 1000, recencyMs: 30 * 60 * 1000 }),
    'sid-self',
  );
  db.close();
});

test('resolver tolerates a partially built index', () => {
  // A read-only query can face a DB with only index_state (writer lease held,
  // schema never published). The nonce cannot resolve: honest null, no throw.
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE index_state (jsonl_path TEXT PRIMARY KEY, mtime REAL, lines_processed INTEGER)');

  assert.equal(resolveInvokingSessionId(db, NONCE), null);
  db.close();
});

test('search hits and sessions rows mark only the invoking session', () => {
  const db = invokingDb();
  const api = createQueryApi(db, { invokingSessionId: 'sid-self' });

  const hits = api.search('needle', { limit: 10 });
  const byId = Object.fromEntries(hits.map(h => [h.session.id, h.session]));
  assert.equal(byId['sid-self'].is_invoking, true);
  assert.equal(byId['sid-history'].is_invoking, undefined);

  const rows = api.sessions({ limit: 10 });
  const rowById = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.equal(rowById['sid-self'].is_invoking, true);
  assert.equal(rowById['sid-history'].is_invoking, undefined);
  db.close();
});

test('overview exposes the invoking session in the current section', () => {
  const db = invokingDb();

  assert.equal(createQueryApi(db, { invokingSessionId: 'sid-self' }).overview().current.session_id, 'sid-self');
  db.close();
});

test('unknown invocation marks nothing and leaves results unchanged', () => {
  for (const opts of [{}, { invokingSessionId: null }]) {
    const db = invokingDb();
    const api = createQueryApi(db, opts);

    const hits = api.search('needle', { limit: 10 });
    assert.equal(hits.length, 2);
    assert.ok(hits.every(h => h.session.is_invoking === undefined));
    assert.ok(api.sessions({ limit: 10 }).every(r => r.is_invoking === undefined));
    assert.equal(api.overview().current.session_id, null);
    db.close();
  }
});

test('cli --search --nonce marks the invoking session end to end', () => {
  const home = makeTempDir('obelisk-invoking-home-');
  const projectDir = join(home, '.claude', 'projects', '-tmp-invoking');
  mkdirSync(projectDir, { recursive: true });
  const nonce = 'obq-e2e-91c2-live-invocation';
  // Fresh timestamps: the CLI process resolves in real time, and the
  // resolver's recency window only reaches recent tool-call records.
  const now = new Date().toISOString();
  const lines = [
    {
      uuid: 'e2e-user', type: 'user', timestamp: now, cwd: '/tmp/invoking',
      message: { role: 'user', content: 'find the e2e needle evidence' },
    },
    {
      uuid: 'e2e-call', type: 'assistant', timestamp: now, cwd: '/tmp/invoking',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_e2e', name: 'Bash', input: { command: `obelisk --search "e2e needle" --nonce ${nonce}` } }] },
    },
  ];
  writeFileSync(join(projectDir, 'e2e-invoking-session.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');

  const withNonce = runCli(['--search', 'e2e needle', '--nonce', nonce], { home });
  assert.equal(withNonce.status, 0, withNonce.stderr || withNonce.stdout);
  const hits = JSON.parse(withNonce.stdout);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].session.id, 'e2e-invoking-session');
  assert.equal(hits[0].session.is_invoking, true);

  // Without the nonce the same hit is ordinary historical evidence.
  const withoutNonce = runCli(['--search', 'e2e needle'], { home });
  assert.equal(withoutNonce.status, 0, withoutNonce.stderr || withoutNonce.stdout);
  const plainHits = JSON.parse(withoutNonce.stdout);
  assert.equal(plainHits.length, 1);
  assert.equal(plainHits[0].session.is_invoking, undefined);
});

test('wait helper skips the recovery build and poll on an immediate hit', () => {
  const result = resolveInvokingSessionIdWithWait(NONCE, null, {
    openRead: () => invokingDb(),
    build: () => { throw new Error('build must not run on an immediate hit'); },
    pollIntervalMs: 5,
    pollCapMs: 20,
    resolveOpts: { nowMs: FIXTURE_NOW_MS },
  });

  assert.equal(result, 'sid-self');
});

test('wait helper re-resolves after the recovery build publishes the nonce', () => {
  const dir = makeTempDir('obelisk-invoking-build-');
  const dbPath = join(dir, 'obelisk.sqlite');
  const seed = new DatabaseSync(dbPath);
  seed.exec(SCHEMA);
  seed.close();

  const result = resolveInvokingSessionIdWithWait(NONCE, null, {
    openRead: () => new DatabaseSync(dbPath, { readOnly: true }),
    build: () => {
      // The recovery build indexes the transcript that carries the nonce. The
      // tool-call join needs a message row with a fresh (real-time) timestamp.
      const db = new DatabaseSync(dbPath);
      db.prepare('INSERT INTO messages (uuid, session_id, type, role, text, timestamp) VALUES (?,?,?,?,?,?)')
        .run('msg-built', 'sid-self', 'assistant', 'assistant', null, new Date().toISOString());
      db.prepare('INSERT INTO tool_calls (id, message_uuid, session_id, name, input_json) VALUES (?,?,?,?,?)')
        .run('call-built', 'msg-built', 'sid-self', 'Bash', JSON.stringify({ command: `obelisk --search "needle" --nonce ${NONCE}` }));
      db.close();
      return {};
    },
    pollIntervalMs: 5,
    pollCapMs: 20,
  });

  assert.equal(result, 'sid-self');
});

test('wait helper never runs the recovery build on an uninitialized index', () => {
  // Schema setup under a fresh daemon heartbeat stays read-only (ADR 0006):
  // with only index_state present, the carve-out build must not run; the poll
  // fallback resolves honest null.
  const dir = makeTempDir('obelisk-invoking-noschema-');
  const dbPath = join(dir, 'obelisk.sqlite');
  const seed = new DatabaseSync(dbPath);
  seed.exec('CREATE TABLE index_state (jsonl_path TEXT PRIMARY KEY, mtime REAL, lines_processed INTEGER)');
  seed.close();

  const result = resolveInvokingSessionIdWithWait(NONCE, null, {
    openRead: () => new DatabaseSync(dbPath, { readOnly: true }),
    build: () => { throw new Error('recovery build must not run schema setup'); },
    pollIntervalMs: 10,
    pollCapMs: 25,
  });

  assert.equal(result, null);
  const check = new DatabaseSync(dbPath, { readOnly: true });
  const tables = check.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
  check.close();
  assert.deepEqual(tables, ['index_state'], 'the index was not mutated');
});

test('wait helper returns null within the cap when the nonce never appears', () => {
  const dir = makeTempDir('obelisk-invoking-timeout-');
  const dbPath = join(dir, 'obelisk.sqlite');
  const seed = new DatabaseSync(dbPath);
  seed.exec(SCHEMA);
  seed.close();

  const startedAt = Date.now();
  const result = resolveInvokingSessionIdWithWait('obq-never-indexed', null, {
    openRead: () => new DatabaseSync(dbPath, { readOnly: true }),
    build: () => ({ skip: true, reason: 'daemon_active' }),
    pollIntervalMs: 15,
    pollCapMs: 40,
  });

  assert.equal(result, null);
  assert.ok(Date.now() - startedAt < 2000, 'shrunk poll timings keep the test fast');
});

test('cli runs one incremental recovery build when the recent-build debounce skips the refresh', () => {
  const home = tempHome('obelisk-invoking-fresh-');
  const projectDir = join(home, '.claude', 'projects', '-tmp-fresh');
  mkdirSync(projectDir, { recursive: true });
  // Warm the index so __last_build__ is fresh and the normal pre-query refresh
  // skips via the 30s recent-build debounce.
  const warm = runCli(['--search', 'warmup'], { home });
  assert.equal(warm.status, 0, warm.stderr || warm.stdout);

  // The transcript appears only after the warm build, so just the recovery
  // build can index the nonce.
  const nonce = 'obq-fresh-after-debounce';
  const now = new Date().toISOString();
  const lines = [
    {
      uuid: 'fresh-user', type: 'user', timestamp: now, cwd: '/tmp/fresh',
      message: { role: 'user', content: 'find the fresh needle evidence' },
    },
    {
      uuid: 'fresh-call', type: 'assistant', timestamp: now, cwd: '/tmp/fresh',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_fresh', name: 'Bash', input: { command: `obelisk --search "fresh needle" --nonce ${nonce}` } }] },
    },
  ];
  writeFileSync(join(projectDir, 'fresh-invoking-session.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');

  const result = runCli(['--search', 'fresh needle', '--nonce', nonce], { home });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const hits = JSON.parse(result.stdout);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].session.id, 'fresh-invoking-session');
  assert.equal(hits[0].session.is_invoking, true);
});

test('cli polls fresh snapshots until a concurrent writer indexes the nonce', async () => {
  const home = tempHome('obelisk-invoking-poll-');
  const warm = runCli(['--search', 'warmup'], { home });
  assert.equal(warm.status, 0, warm.stderr || warm.stdout);
  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');

  // Hold the writer lease so the CLI's recovery build skips with writer_busy.
  // The nonce enters the index only through the delayed insert below, so a
  // resolved mark can only come from the bounded poll.
  const lease = acquireWriterLease({
    lockPath: writerLockPathFor(dbPath),
    openDb: path => new DatabaseSync(path),
  });
  assert.ok(lease);
  const nonce = 'obq-polled-by-concurrent-writer';
  try {
    const pending = runCliAsync(['--search', 'polled needle', '--nonce', nonce], { home });
    await new Promise(resolveWait => setTimeout(resolveWait, 800));
    const now = new Date().toISOString();
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA busy_timeout=2000');
    db.prepare('INSERT INTO sessions (id, title, project, started_at) VALUES (?,?,?,?)')
      .run('sid-polled', 'Polled session', 'quiet-zero', now);
    db.prepare(`
      INSERT INTO messages (uuid, session_id, type, role, text, timestamp, visibility, source)
      VALUES (?,?,?,?,?,?,?,?)
    `).run('msg-polled', 'sid-polled', 'assistant', 'assistant', 'polled needle reply', now, 'visible', 'claude');
    db.prepare('INSERT INTO tool_calls (id, message_uuid, session_id, name, input_json) VALUES (?,?,?,?,?)')
      .run('call-polled', 'msg-polled', 'sid-polled', 'Bash', JSON.stringify({ command: `obelisk --search "polled needle" --nonce ${nonce}` }));
    db.close();

    const result = await pending;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const hits = JSON.parse(result.stdout);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].session.id, 'sid-polled');
    assert.equal(hits[0].session.is_invoking, true);
  } finally {
    lease.release();
  }
});

// Run a script against core source in a child process with an isolated HOME:
// DB_PATH is fixed at module load, so in-process buildIndex calls would touch
// the real ~/.obelisk. Same pattern as tests/pi-runtime.test.mjs.
function runCoreScript(home, script, env = {}) {
  const coreUrl = pathToFileURL(join(repoRoot, 'packages/core/src/core.ts')).href;
  // The deepseek provider prefers $DSH_HOME over ~/.dsh; a harness shell that
  // exports DSH_HOME would point the build at the real session store.
  const childEnv = { ...process.env, HOME: home, USERPROFILE: home, OBELISK_CORE_URL: coreUrl, ...env };
  delete childEnv.DSH_HOME;
  const run = spawnSync(process.execPath, [
    '--experimental-strip-types',
    '--disable-warning=ExperimentalWarning',
    '--input-type=module',
    '-e',
    script,
  ], {
    cwd: repoRoot,
    env: childEnv,
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

function claudeTextLine(uuid, type, ts) {
  return JSON.stringify({ uuid, type, timestamp: ts, cwd: '/tmp/proj', message: { role: type, content: `${type} ${uuid}` } });
}

test('ignoreRecentBuild keeps the recovery build incremental and indexes new lines', () => {
  const home = tempHome('obelisk-invoking-incremental-');
  const projectDir = join(home, '.claude', 'projects', '-tmp-proj');
  mkdirSync(projectDir, { recursive: true });
  const jsonl = join(projectDir, 'sess.jsonl');
  writeFileSync(jsonl, [
    claudeTextLine('u1', 'user', '2026-08-11T10:00:00Z'),
    claudeTextLine('a1', 'assistant', '2026-08-11T10:00:05Z'),
  ].join('\n') + '\n');

  const out = runCoreScript(home, `
    import { appendFileSync, statSync, utimesSync } from 'node:fs';
    import { DatabaseSync } from 'node:sqlite';
    const core = await import(process.env.OBELISK_CORE_URL);
    const jsonl = process.env.OBELISK_TEST_JSONL;
    const out = {};
    const first = core.buildIndex();
    out.first = { skip: first.skip === true, complete: first.complete === true };
    // Sentinel: a full republish deletes and re-inserts every row, wiping
    // direct edits; an incremental build leaves unchanged files untouched.
    const db = new DatabaseSync(core.DB_PATH);
    db.prepare("UPDATE messages SET model='sentinel-model' WHERE uuid='a1'").run();
    db.close();
    const debounced = core.buildIndex();
    out.debounceSkipReason = debounced.reason || null;
    appendFileSync(jsonl, [
      ${JSON.stringify(claudeTextLine('u2', 'user', '2026-08-11T10:01:00Z'))},
      ${JSON.stringify(claudeTextLine('a2', 'assistant', '2026-08-11T10:01:05Z'))},
    ].join('\\n') + '\\n');
    const t = statSync(jsonl).mtimeMs / 1000 + 10;
    utimesSync(jsonl, t, t);
    const incremental = core.buildIndex({ ignoreRecentBuild: true });
    out.incremental = { skip: incremental.skip === true, reason: incremental.reason || null, complete: incremental.complete === true };
    const check = new DatabaseSync(core.DB_PATH, { readOnly: true });
    out.messageCount = check.prepare('SELECT COUNT(*) AS c FROM messages').get().c;
    out.sentinel = check.prepare("SELECT model FROM messages WHERE uuid='a1'").get().model;
    out.cursor = check.prepare("SELECT lines_processed FROM index_state WHERE jsonl_path LIKE '%sess.jsonl'").get().lines_processed;
    check.close();
    process.stdout.write(JSON.stringify(out));
  `, { OBELISK_TEST_JSONL: jsonl });

  assert.deepEqual(out.first, { skip: false, complete: true });
  assert.equal(out.debounceSkipReason, 'recent_build', 'plain rebuild stays debounced');
  assert.deepEqual(out.incremental, { skip: false, reason: null, complete: true });
  assert.equal(out.messageCount, 4, 'the appended lines were indexed');
  assert.equal(out.sentinel, 'sentinel-model', 'unchanged file was not wiped and republished');
  assert.equal(out.cursor, 4, 'cursor resumed and advanced to 4 lines');
});

test('ignoreDaemonOwnership builds under a fresh heartbeat; default still skips daemon_active', () => {
  const home = tempHome('obelisk-invoking-carveout-');
  const projectDir = join(home, '.claude', 'projects', '-tmp-proj');
  mkdirSync(projectDir, { recursive: true });
  const jsonl = join(projectDir, 'sess.jsonl');
  writeFileSync(jsonl, claudeTextLine('u1', 'user', '2026-08-11T10:00:00Z') + '\n');

  const out = runCoreScript(home, `
    import { appendFileSync, statSync, utimesSync } from 'node:fs';
    import { DatabaseSync } from 'node:sqlite';
    const core = await import(process.env.OBELISK_CORE_URL);
    const jsonl = process.env.OBELISK_TEST_JSONL;
    const out = {};
    core.buildIndex();
    const db = new DatabaseSync(core.DB_PATH);
    db.prepare("INSERT OR REPLACE INTO index_state (jsonl_path, mtime, lines_processed) VALUES ('__app_heartbeat__', ?, 0)").run(Date.now());
    db.close();
    appendFileSync(jsonl, ${JSON.stringify(claudeTextLine('u2', 'user', '2026-08-11T10:01:00Z'))} + '\\n');
    const t = statSync(jsonl).mtimeMs / 1000 + 10;
    utimesSync(jsonl, t, t);
    // ignoreRecentBuild isolates the heartbeat gate from the debounce.
    const held = core.buildIndex({ ignoreRecentBuild: true });
    out.heldReason = held.reason || null;
    const carveOut = core.buildIndex({ ignoreRecentBuild: true, ignoreDaemonOwnership: true });
    out.carveOut = { skip: carveOut.skip === true, reason: carveOut.reason || null, complete: carveOut.complete === true };
    const check = new DatabaseSync(core.DB_PATH, { readOnly: true });
    out.messageCount = check.prepare('SELECT COUNT(*) AS c FROM messages').get().c;
    check.close();
    process.stdout.write(JSON.stringify(out));
  `, { OBELISK_TEST_JSONL: jsonl });

  assert.equal(out.heldReason, 'daemon_active', 'default keeps the daemon_active skip');
  assert.deepEqual(out.carveOut, { skip: false, reason: null, complete: true });
  assert.equal(out.messageCount, 2, 'the carve-out build indexed the appended line');
});

test('cli resolves the nonce via the carve-out build under a fresh daemon heartbeat', () => {
  const home = tempHome('obelisk-invoking-daemon-');
  const warm = runCli(['--search', 'warmup'], { home });
  assert.equal(warm.status, 0, warm.stderr || warm.stdout);

  // A fresh heartbeat makes the pre-query refresh skip with daemon_active.
  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
  const db = new DatabaseSync(dbPath);
  db.prepare("INSERT OR REPLACE INTO index_state (jsonl_path, mtime, lines_processed) VALUES ('__app_heartbeat__', ?, 0)").run(Date.now());
  db.close();

  // The transcript appears only after the warm build, so just the carve-out
  // recovery build can index the nonce.
  const projectDir = join(home, '.claude', 'projects', '-tmp-daemon');
  mkdirSync(projectDir, { recursive: true });
  const nonce = 'obq-daemon-mode-carve-out';
  const now = new Date().toISOString();
  const lines = [
    {
      uuid: 'daemon-user', type: 'user', timestamp: now, cwd: '/tmp/daemon',
      message: { role: 'user', content: 'find the daemon needle evidence' },
    },
    {
      uuid: 'daemon-call', type: 'assistant', timestamp: now, cwd: '/tmp/daemon',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_daemon', name: 'Bash', input: { command: `obelisk --search "daemon needle" --nonce ${nonce}` } }] },
    },
  ];
  writeFileSync(join(projectDir, 'daemon-invoking-session.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');

  const result = runCli(['--search', 'daemon needle', '--nonce', nonce], { home });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const hits = JSON.parse(result.stdout);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].session.id, 'daemon-invoking-session');
  assert.equal(hits[0].session.is_invoking, true);
});
