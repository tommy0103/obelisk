#!/usr/bin/env node
// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only
//
// Measures the Hermes pre-query refresh at the scale reported in issue #253. Run it on the base
// commit and on the change under review, and record both in the benchmark doc.
//
//   npm run bench:hermes
//   npm run bench:hermes -- --sessions 2500 --messages 160000 --content-bytes 9000
//
// It builds a synthetic WAL store in a temp dir, indexes it through the real discovery/persist
// pipeline, and reports wall time plus projected-payload reads. Only the temp dir is written.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  createProviderIndexPlan,
  indexProviderPlan,
} from '../packages/core/src/provider-indexing.ts';
import { createHermesProvider } from '../packages/core/src/providers/hermes.ts';
import { createProviderRegistry } from '../packages/core/src/providers/registry.ts';

const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  options.set(process.argv[index], process.argv[index + 1]);
}
const number = (name, fallback) => {
  const value = Number(options.get(name) ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return Math.floor(value);
};
const SESSIONS = number('--sessions', 2500);
const MESSAGES = number('--messages', 160000);
const CONTENT_BYTES = number('--content-bytes', 9000);
const RUNS = number('--runs', 3);
const PER_SESSION = Math.max(1, Math.ceil(MESSAGES / SESSIONS));

const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');
// The shipped Hermes shape, cut to the columns the adapter projects plus the unexplained-write
// probe column (`api_content`). Keep this in step with SESSION_COLUMNS / PROJECTED_MESSAGE_COLUMNS.
const STORE_DDL = `
  CREATE TABLE schema_version (version INTEGER NOT NULL);
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT, title TEXT, parent_session_id TEXT,
    started_at REAL NOT NULL, ended_at REAL, end_reason TEXT, message_count INTEGER DEFAULT 0,
    tool_call_count INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
    cwd TEXT, git_branch TEXT, profile_name TEXT, archived INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
    content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL,
    reasoning TEXT, reasoning_content TEXT, api_content TEXT, active INTEGER NOT NULL DEFAULT 1,
    compacted INTEGER NOT NULL DEFAULT 0, display_kind TEXT, codex_message_items TEXT,
    _compressed_summary INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX messages_session ON messages (session_id);`;

const CONTENT = 'x'.repeat(CONTENT_BYTES);
const PAYLOAD_SQL = /FROM messages WHERE session_id = \? ORDER BY rowid/;

function createStore(home) {
  const path = join(home, 'state.db');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF;');
  db.exec(STORE_DDL);
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(32);
  const insertSession = db.prepare(
    `INSERT INTO sessions (id, source, model, title, started_at, ended_at, end_reason,
       message_count, tool_call_count, cwd, archived, hidden)
     VALUES (?, 'cli', 'bench-model', ?, ?, ?, 'cli_close', ?, 0, '/bench/project', 0, 0)`,
  );
  const insertMessage = db.prepare(
    `INSERT INTO messages (session_id, role, content, timestamp, active, compacted)
     VALUES (?, ?, ?, ?, 1, 0)`,
  );
  db.exec('BEGIN');
  for (let session = 0; session < SESSIONS; session += 1) {
    const id = `bench_${String(session).padStart(6, '0')}`;
    insertSession.run(id, `Session ${session}`, 1767225600, 1767225600 + PER_SESSION, PER_SESSION);
    for (let message = 0; message < PER_SESSION; message += 1) {
      insertMessage.run(id, message % 2 === 0 ? 'user' : 'assistant', CONTENT, 1767225600 + message);
    }
  }
  db.exec('COMMIT');
  db.close();
  return path;
}

function indexDb(home) {
  // On disk, not :memory: — an index at this scale holds the whole transcript and has to match
  // what the app and CLI actually write.
  const db = new DatabaseSync(join(home, 'index.sqlite'));
  db.exec(SCHEMA);
  return db;
}

function measure(db, registry, readCounter) {
  readCounter.value = 0;
  const started = performance.now();
  const plan = createProviderIndexPlan(db, registry, {});
  const result = indexProviderPlan({
    db,
    plan,
    runTransaction: (_label, work) => work(),
    onError: (error) => { throw error; },
  });
  return {
    ms: performance.now() - started,
    items: plan.items.length,
    committed: result.committed.length,
    payloadReads: readCounter.value,
  };
}

const home = mkdtempSync(join(tmpdir(), 'obelisk-hermes-bench-'));
try {
  const storePath = createStore(home);
  const readCounter = { value: 0 };
  const provider = createHermesProvider({
    rootDir: home,
    openStore: path => {
      const db = new DatabaseSync(path, { readOnly: true });
      return new Proxy(db, {
        get(target, property) {
          if (property === 'prepare') {
            return (sql) => {
              if (PAYLOAD_SQL.test(String(sql))) readCounter.value += 1;
              return target.prepare(sql);
            };
          }
          const value = target[property];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  });
  const registry = createProviderRegistry([provider]);
  const db = indexDb(home);

  const cold = [];
  for (let round = 0; round < 6; round += 1) {
    const result = measure(db, registry, readCounter);
    cold.push(result);
    if (result.items === 0) break;
  }
  const coldMs = cold.reduce((sum, round) => sum + round.ms, 0);

  const idle = [];
  for (let run = 0; run < RUNS; run += 1) idle.push(measure(db, registry, readCounter));

  const writer = new DatabaseSync(storePath);
  writer.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
    .run('bench_000000', 'user', 'one more line', 1767229999);
  writer.close();
  const append = measure(db, registry, readCounter);
  // The call that follows a write settles the store; in CLI mode it is a separate invocation.
  const appendConfirm = measure(db, registry, readCounter);

  const unexplainedWriter = new DatabaseSync(storePath);
  unexplainedWriter.prepare('UPDATE messages SET api_content = ? WHERE session_id = ?')
    .run('[response interrupted]', 'bench_000001');
  unexplainedWriter.close();
  const unexplained = measure(db, registry, readCounter);
  const unexplainedConfirm = measure(db, registry, readCounter);

  const show = (label, result) => console.log(
    `${label.padEnd(24)} ${result.ms.toFixed(1).padStart(9)} ms  ${String(result.payloadReads).padStart(7)} payload reads  ${result.items} units`,
  );
  console.log(`\nHermes refresh benchmark: ${SESSIONS} sessions, ${SESSIONS * PER_SESSION} messages, ${CONTENT_BYTES} content bytes each\n`);
  cold.forEach((result, round) => show(`cold round ${round + 1}`, result));
  console.log(`${'cold total'.padEnd(24)} ${coldMs.toFixed(1).padStart(9)} ms`);
  idle.forEach((result, run) => show(`idle run ${run + 1}`, result));
  show('one-session append', append);
  show('append confirmation', appendConfirm);
  show('unexplained write', unexplained);
  show('unexplained confirmation', unexplainedConfirm);
  console.log('\nExpected after the fix: idle 0 payload reads, append 1, unexplained = one candidate pass.\n');
  db.close();
} finally {
  rmSync(home, { recursive: true, force: true });
}
