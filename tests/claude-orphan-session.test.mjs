// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// A Claude project directory can outlive its main transcript: automated runs
// leave `<project>/<sessionId>/subagents/*.jsonl` behind after the parent
// `<sessionId>.jsonl` is cleaned up. Those subagent transcripts are the only
// surviving witness of the session, so they must publish the session row —
// otherwise their messages are indexed but unreachable from the catalogue,
// session detail, and every statement that joins sessions.
//
// The second half pins the title backfill that gives untitled sessions
// (older transcripts, reconstructed subagent-only sessions) a browsable name
// without ever overwriting a real title.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from '../packages/core/src/providers/claude.ts';
import { persist } from '../packages/core/src/persist.ts';
import {
  backfillSessionTitles,
  refreshSessionProjectPaths,
  repairOrphanedSessionCounts,
} from '../packages/core/src/index-finalize.ts';
import { makeTempDir } from './temp-dirs.mjs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');

const PROJECT = '-tmp-obelisk-project';
const SESSION_ID = 'sid-orphan';

function message(uuid, text, { role = 'user', timestamp = '2026-06-10T10:00:00Z', cwd = '/work/project' } = {}) {
  return { uuid, type: role, timestamp, cwd, message: { role, content: text } };
}

function writeSubagentTranscript(root, agentId, lines) {
  const sessionDir = join(root, PROJECT, SESSION_ID);
  mkdirSync(join(sessionDir, 'subagents'), { recursive: true });
  const path = join(sessionDir, 'subagents', `${agentId}.jsonl`);
  writeFileSync(path, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  return path;
}

function writeMainTranscript(root, lines) {
  const path = join(root, PROJECT, `${SESSION_ID}.jsonl`);
  mkdirSync(join(root, PROJECT), { recursive: true });
  writeFileSync(path, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  return path;
}

function subagentUnit(path, agentId) {
  return {
    key: path,
    sessionId: SESSION_ID,
    project: PROJECT,
    isSubagent: true,
    agentId,
  };
}

function drain(gen) {
  const values = [];
  let step = gen.next();
  while (!step.done) { values.push(step.value); step = gen.next(); }
  return values;
}

function sessionRecords(values) {
  return values.filter(record => record.kind === 'session');
}

test('an orphaned subagent transcript publishes the session row', () => {
  const root = makeTempDir('obelisk-orphan-subagent-');
  const path = writeSubagentTranscript(root, 'agent-a', [
    message('sa-1', 'explore the repo'),
    message('sa-2', 'found it', { role: 'assistant' }),
  ]);

  const sessions = sessionRecords(drain(parse(subagentUnit(path, 'agent-a'), null)));

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, SESSION_ID);
  assert.equal(sessions[0].project, PROJECT);
  // The main transcript is gone, so the row points at the path it used to have:
  // `raw` still resolves subagent rows from `<project>/<sessionId>/subagents/`.
  assert.equal(sessions[0].jsonl_path, join(root, PROJECT, `${SESSION_ID}.jsonl`));
  assert.equal(sessions[0].message_count, 2);
  // Several subagent transcripts share one session id, so counts accumulate.
  assert.equal(sessions[0].countMode, 'delta');
  // Nothing in the source names it; the backfill supplies a title later.
  assert.equal(sessions[0].title, null);
});

test('a subagent transcript stays out of the sessions table while its main transcript exists', () => {
  const root = makeTempDir('obelisk-live-subagent-');
  const path = writeSubagentTranscript(root, 'agent-a', [message('sa-1', 'explore the repo')]);
  writeMainTranscript(root, [message('main-1', 'kick off the run')]);

  const sessions = sessionRecords(drain(parse(subagentUnit(path, 'agent-a'), null)));

  assert.deepEqual(sessions, []);
});

test('an unrecognized transcript layout is never treated as orphaned', () => {
  const root = makeTempDir('obelisk-flat-subagent-');
  const path = join(root, 'agent-flat.jsonl');
  writeFileSync(path, `${JSON.stringify(message('flat-1', 'no subagents directory'))}\n`);

  // No `/subagents/` segment means the owning session file cannot be derived,
  // so the adapter must not invent a "missing" parent.
  const sessions = sessionRecords(drain(parse(subagentUnit(path, 'agent-flat'), null)));

  assert.deepEqual(sessions, []);
});

test('orphaned subagent messages land in one browsable session row', () => {
  const root = makeTempDir('obelisk-orphan-persist-');
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);

  const first = writeSubagentTranscript(root, 'agent-a', [
    message('sa-1', 'first line of the run\nsecond line', { timestamp: '2026-06-10T10:00:00Z' }),
    message('sa-2', 'work in progress', { role: 'assistant', timestamp: '2026-06-10T10:00:01Z' }),
  ]);
  const second = writeSubagentTranscript(root, 'agent-b', [
    message('sb-1', 'another branch', { timestamp: '2026-06-10T10:02:00Z' }),
  ]);

  persist(db, subagentUnit(first, 'agent-a'), parse(subagentUnit(first, 'agent-a'), null));
  persist(db, subagentUnit(second, 'agent-b'), parse(subagentUnit(second, 'agent-b'), null));
  refreshSessionProjectPaths(db, new Set([SESSION_ID]));

  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(SESSION_ID);
  assert.ok(row, 'the session must exist even though no main transcript does');
  assert.equal(row.message_count, 3);
  assert.equal(row.project, PROJECT);
  assert.equal(row.project_path, '/work/project');
  assert.equal(row.started_at, '2026-06-10T10:00:00Z');
  assert.equal(row.ended_at, '2026-06-10T10:02:00Z');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(SESSION_ID).n, 3);

  assert.equal(backfillSessionTitles(db), 1);
  assert.equal(
    db.prepare('SELECT title FROM sessions WHERE id = ?').get(SESSION_ID).title,
    'first line of the run',
  );
  db.close();
});

test('title backfill fills blanks only, truncates, and skips message-less sessions', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const insertSession = db.prepare('INSERT INTO sessions (id, title, source) VALUES (?, ?, ?)');
  const insertMessage = db.prepare(`
    INSERT INTO messages (uuid, session_id, type, timestamp, role, text, content_type, source)
    VALUES (?, ?, 'user', ?, 'user', ?, 'text', 'claude')
  `);

  insertSession.run('titled', 'Real title', 'claude');
  insertMessage.run('m-titled', 'titled', '2026-08-31T00:00:00Z', 'should not win');

  insertSession.run('blank-title', '   ', 'claude');
  insertMessage.run('m-blank', 'blank-title', '2026-08-31T00:00:01Z', '  \n  first real line  \nsecond');

  insertSession.run('long-title', null, 'claude');
  const longLine = 'x'.repeat(140);
  insertMessage.run('m-long', 'long-title', '2026-08-31T00:00:02Z', `${longLine}\ntail`);

  // Runtime plumbing is skipped: the slash command is not what the session was about.
  insertSession.run('wrapped', null, 'claude');
  insertMessage.run('m-wrap-1', 'wrapped', '2026-08-31T00:00:03Z', '<command-name>/clear</command-name>');
  insertMessage.run(
    'm-wrap-2', 'wrapped', '2026-08-31T00:00:04Z',
    '<user_info>\nPlatform: darwin\n</user_info>\n实现歌房增量报表',
  );

  // Nothing but plumbing: stay untitled rather than invent a name.
  insertSession.run('all-plumbing', null, 'claude');
  insertMessage.run('m-plumb-1', 'all-plumbing', '2026-08-31T00:00:05Z', 'Warmup');
  insertMessage.run('m-plumb-2', 'all-plumbing', '2026-08-31T00:00:06Z', '<user_info>\nPlatform: darwin\n</user_info>');

  insertSession.run('no-messages', null, 'claude');

  assert.equal(backfillSessionTitles(db), 3);
  const title = id => db.prepare('SELECT title FROM sessions WHERE id = ?').get(id).title;
  assert.equal(title('titled'), 'Real title');
  assert.equal(title('blank-title'), 'first real line');
  assert.equal(title('long-title').length, 80);
  assert.equal(title('long-title').endsWith('…'), true);
  assert.equal(title('wrapped'), '实现歌房增量报表');
  assert.equal(title('all-plumbing'), null);
  assert.equal(title('no-messages'), null);

  // Idempotent: a second pass finds nothing left to fill.
  assert.equal(backfillSessionTitles(db), 0);
  db.close();
});

test('a replayed orphan unit recovers its count instead of growing it', () => {
  // Orphan rows are counted with `countMode: 'delta'` (several subagents share
  // one session id). A replay — marker bump, vanished cursor row, retried unit —
  // adds that unit's messages again, so the stored count drifts above the rows.
  // Nothing on the provider side can restate it: the main transcript that owned
  // the total is gone. The repair pass derives it from the rows instead.
  const root = makeTempDir('obelisk-orphan-replay-');
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);

  const first = writeSubagentTranscript(root, 'agent-a', [
    message('sa-1', 'first line of the run', { timestamp: '2026-06-10T10:00:00Z' }),
    message('sa-2', 'work in progress', { role: 'assistant', timestamp: '2026-06-10T10:00:01Z' }),
  ]);
  const unit = subagentUnit(first, 'agent-a');
  persist(db, unit, parse(unit, null));
  assert.equal(db.prepare('SELECT message_count FROM sessions WHERE id = ?').get(SESSION_ID).message_count, 2);

  // Same unit replayed from scratch, exactly what a marker bump produces.
  persist(db, unit, parse(unit, null));
  const drifted = db.prepare('SELECT message_count FROM sessions WHERE id = ?').get(SESSION_ID).message_count;
  assert.equal(drifted, 4, 'delta semantics are what makes the replay visible');

  assert.equal(repairOrphanedSessionCounts(db), 1);
  assert.equal(db.prepare('SELECT message_count FROM sessions WHERE id = ?').get(SESSION_ID).message_count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(SESSION_ID).n, 2);

  // Idempotent: a second pass has nothing left to correct.
  assert.equal(repairOrphanedSessionCounts(db), 0);
  db.close();
});
