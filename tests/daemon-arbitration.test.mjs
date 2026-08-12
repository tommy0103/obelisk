// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { acquireWriterLease, writerLockPathFor } from '../packages/core/src/writer-lease.ts';
import { runCli } from './cli-test-helpers.mjs';
import { makeTempDir } from './temp-dirs.mjs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

test('a passive query does not mutate the index while a fresh daemon owns writes', () => {
  const home = makeTempDir('obelisk-daemon-arbitration-');
  const obeliskDir = join(home, '.obelisk');
  const dbPath = join(obeliskDir, 'obelisk.sqlite');
  mkdirSync(obeliskDir, { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE index_state (jsonl_path TEXT PRIMARY KEY, mtime REAL, lines_processed INTEGER)');
  const marker = db.prepare('INSERT INTO index_state (jsonl_path, mtime, lines_processed) VALUES (?, ?, 0)');
  const now = Date.now();
  marker.run('__app_heartbeat__', now);
  db.close();

  const queryPath = join(home, 'query.mjs');
  writeFileSync(queryPath, "return 'read-only';");
  const result = runCli(['--query', queryPath], { home });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout), 'read-only');

  const check = new DatabaseSync(dbPath, { readOnly: true });
  const tables = check.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
  check.close();
  assert.deepEqual(tables, ['index_state']);
});

test('a passive query reports when a daemon blocks its schema upgrade', () => {
  const home = makeTempDir('obelisk-daemon-schema-');
  const obeliskDir = join(home, '.obelisk');
  const dbPath = join(obeliskDir, 'obelisk.sqlite');
  mkdirSync(obeliskDir, { recursive: true });
  const schema = readFileSync(
    new URL('../packages/core/src/schema.sql', import.meta.url),
    'utf8',
  )
    .replace(', cursor TEXT);', ');')
    .replace(
      ", visibility TEXT DEFAULT 'visible',\n  input_tokens INTEGER, output_tokens INTEGER);",
      ');',
    );
  const db = new DatabaseSync(dbPath);
  db.exec(schema);
  db.prepare('INSERT INTO sessions (id,title,source) VALUES (?,?,?)')
    .run('daemon-legacy', 'Daemon legacy', 'claude');
  db.prepare(`
    INSERT INTO summaries (id,session_id,timestamp,source,content)
    VALUES (?,?,?,?,?)
  `).run('daemon-summary', 'daemon-legacy', '2026-08-05T00:00:00Z', 'compaction', 'summary');
  db.prepare(`
    INSERT INTO index_state (jsonl_path,mtime,lines_processed)
    VALUES ('__app_heartbeat__',?,0)
  `).run(Date.now());
  db.close();

  const queryPath = join(home, 'query.mjs');
  writeFileSync(queryPath, "return summaries('daemon-legacy');");
  const result = runCli(['--query', queryPath], { home });

  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).error, /schema upgrade is blocked by daemon_active/i);
  const check = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(check.prepare('PRAGMA table_info(index_state)').all().some(row => row.name === 'cursor'), false);
  assert.equal(check.prepare('PRAGMA table_info(summaries)').all().some(row => row.name === 'visibility'), false);
  check.close();
});

test('attune refuses to mutate the index while a fresh daemon owns writes', () => {
  const home = makeTempDir('obelisk-daemon-attune-');
  const obeliskDir = join(home, '.obelisk');
  const dbPath = join(obeliskDir, 'obelisk.sqlite');
  mkdirSync(obeliskDir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE index_state (jsonl_path TEXT PRIMARY KEY, mtime REAL, lines_processed INTEGER)');
  const marker = db.prepare('INSERT INTO index_state (jsonl_path, mtime, lines_processed) VALUES (?, ?, 0)');
  const now = Date.now();
  marker.run('__app_heartbeat__', now);
  db.close();

  const attunePath = join(home, 'attune.mjs');
  writeFileSync(attunePath, 'return true;');
  const result = runCli(['--attune', attunePath], { home });
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).error, /daemon owns index writes/i);

  const check = new DatabaseSync(dbPath, { readOnly: true });
  const tables = check.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
  check.close();
  assert.deepEqual(tables, ['index_state']);
});

test('a passive query stays read-only when another process holds the writer lease', () => {
  const home = makeTempDir('obelisk-writer-owned-');
  const obeliskDir = join(home, '.obelisk');
  const dbPath = join(obeliskDir, 'obelisk.sqlite');
  mkdirSync(obeliskDir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE index_state (jsonl_path TEXT PRIMARY KEY, mtime REAL, lines_processed INTEGER)');
  db.close();

  const lease = acquireWriterLease({
    lockPath: writerLockPathFor(dbPath),
    openDb: path => new DatabaseSync(path),
  });
  assert.ok(lease);
  try {
    const queryPath = join(home, 'query.mjs');
    writeFileSync(queryPath, "return 'writer-busy';");
    const result = runCli(['--query', queryPath], { home });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout), 'writer-busy');
  } finally {
    lease.release();
  }

  const check = new DatabaseSync(dbPath, { readOnly: true });
  const tables = check.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
  check.close();
  assert.deepEqual(tables, ['index_state']);
});

test('a passive query fails closed when daemon ownership cannot be read', () => {
  const home = makeTempDir('obelisk-daemon-ownership-error-');
  const obeliskDir = join(home, '.obelisk');
  const dbPath = join(obeliskDir, 'obelisk.sqlite');
  mkdirSync(obeliskDir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE index_state (jsonl_path TEXT PRIMARY KEY)');
  db.close();

  const lease = acquireWriterLease({
    lockPath: writerLockPathFor(dbPath),
    openDb: path => new DatabaseSync(path),
  });
  assert.ok(lease);
  try {
    const queryPath = join(home, 'query.mjs');
    writeFileSync(queryPath, "return 'ownership-unknown';");
    const result = runCli(['--query', queryPath], { home });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(JSON.parse(result.stdout).error, /no such column: mtime/i);
  } finally {
    lease.release();
  }
});
