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

test('attune writes memories while a fresh daemon owns index writes', () => {
  const home = makeTempDir('obelisk-daemon-attune-');
  const obeliskDir = join(home, '.obelisk');
  const dbPath = join(obeliskDir, 'obelisk.sqlite');
  mkdirSync(obeliskDir, { recursive: true });
  const schema = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');
  const db = new DatabaseSync(dbPath);
  db.exec(schema);
  db.prepare('INSERT INTO index_state (jsonl_path, mtime, lines_processed) VALUES (?, ?, 0)')
    .run('__app_heartbeat__', Date.now());
  db.close();

  // A live transcript that an index build would pick up: attune must not
  // trigger any indexing while the daemon owns writes.
  const projectDir = join(home, '.claude', 'projects', '-proj');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, 'sid-live.jsonl'), `${JSON.stringify({
    uuid: 'msg-live', type: 'user', timestamp: '2026-06-10T10:00:00Z',
    message: { role: 'user', content: 'must stay unindexed' },
  })}\n`);

  const memoryPath = join(home, 'memory.md');
  const attunePath = join(home, 'attune.mjs');
  writeFileSync(memoryPath, '# Daemon-time memory\n');
  writeFileSync(attunePath, `
    return remember({
      path: ${JSON.stringify(memoryPath)},
      project: 'daemon-test',
      summary: 'Decision: memory writes stay available while the daemon owns index writes.'
    });
  `);
  const result = runCli(['--attune', attunePath], { home });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.project, 'daemon-test');
  assert.ok(payload.id);

  const check = new DatabaseSync(dbPath, { readOnly: true });
  const memory = check.prepare('SELECT summary, deleted_at FROM memories WHERE id=?').get(payload.id);
  assert.match(memory.summary, /memory writes stay available/);
  assert.equal(memory.deleted_at, null);
  // The FTS trigger fired, so recall sees the memory immediately.
  assert.ok(check.prepare("SELECT id FROM memories_fts WHERE memories_fts MATCH 'daemon'").all().some(row => row.id === payload.id));
  // No index build ran as a side effect of attune.
  assert.equal(check.prepare('SELECT COUNT(*) AS c FROM messages').get().c, 0);
  check.close();
});

test('attune reports honestly when the index is not initialized', () => {
  const home = makeTempDir('obelisk-daemon-attune-empty-');
  const attunePath = join(home, 'attune.mjs');
  writeFileSync(attunePath, 'return true;');

  const result = runCli(['--attune', attunePath], { home });
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).error, /index is not initialized/i);
});

test('attune reports honestly when the memory layer is incomplete', () => {
  const home = makeTempDir('obelisk-daemon-attune-partial-');
  const obeliskDir = join(home, '.obelisk');
  mkdirSync(obeliskDir, { recursive: true });
  // A database with a full-column memories table but no memories_fts or
  // maintenance triggers: writes would "succeed" yet never be recallable.
  const db = new DatabaseSync(join(obeliskDir, 'obelisk.sqlite'));
  db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY, session_id TEXT, project TEXT,
      message_start TEXT, message_end TEXT,
      path TEXT, anchors TEXT, summary TEXT, created_at TEXT,
      deleted_at TEXT, deleted_reason TEXT
    );
  `);
  db.close();

  const memoryPath = join(home, 'memory.md');
  const attunePath = join(home, 'attune.mjs');
  writeFileSync(memoryPath, '# Unreachable memory\n');
  writeFileSync(attunePath, `
    return remember({
      path: ${JSON.stringify(memoryPath)},
      project: 'partial-test',
      summary: 'Decision: this write must be refused, not silently unrecallable.'
    });
  `);

  const result = runCli(['--attune', attunePath], { home });
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).error, /predates the memory layer/i);

  const check = new DatabaseSync(join(obeliskDir, 'obelisk.sqlite'), { readOnly: true });
  assert.equal(check.prepare('SELECT COUNT(*) AS c FROM memories').get().c, 0);
  check.close();
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
