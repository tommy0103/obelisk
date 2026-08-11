import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildIndex } from '../app/src/main/indexer.ts';
import { acquireWriterLease, writerLockPathFor } from '../packages/core/src/writer-lease.ts';
import { makeTempDir } from './temp-dirs.mjs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

class TestDatabase {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
  }
  get inTransaction() { return this.db.isTransaction; }
  exec(sql) { return this.db.exec(sql); }
  pragma(statement) { return this.db.exec(`PRAGMA ${statement}`); }
  prepare(sql) { return this.db.prepare(sql); }
  close() { return this.db.close(); }
}

test('an app build defers without opening the target database when another writer owns the lease', () => {
  const home = makeTempDir('obelisk-app-writer-lease-');
  const claudeDir = join(home, '.claude');
  const projectsDir = join(claudeDir, 'projects');
  const projectDir = join(projectsDir, '-tmp-project');
  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(join(home, '.obelisk'), { recursive: true });
  writeFileSync(join(projectDir, 'session.jsonl'), JSON.stringify({
    uuid: 'message-1',
    type: 'user',
    timestamp: '2026-07-10T00:00:00Z',
    message: { role: 'user', content: 'hello' },
  }) + '\n');

  const lease = acquireWriterLease({
    lockPath: writerLockPathFor(dbPath),
    openDb: path => new DatabaseSync(path),
  });
  assert.ok(lease);
  try {
    const result = buildIndex({
      claudeDir,
      projectsDir,
      dbPath,
      DatabaseImpl: TestDatabase,
      writerLeaseWaitMs: 0,
    });
    assert.equal(result.deferred, true);
    assert.equal(result.reason, 'writer_busy');
    assert.equal(existsSync(dbPath), false);
  } finally {
    lease.release();
  }
});

test('a failed force cleanup leaves the existing index intact', () => {
  const home = makeTempDir('obelisk-app-force-atomic-');
  const claudeDir = join(home, '.claude');
  const projectsDir = join(claudeDir, 'projects');
  const projectDir = join(projectsDir, '-tmp-project');
  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(join(home, '.obelisk'), { recursive: true });
  writeFileSync(join(projectDir, 'session.jsonl'), JSON.stringify({
    uuid: 'message-1',
    type: 'user',
    timestamp: '2026-07-10T00:00:00Z',
    message: { role: 'user', content: 'hello' },
  }) + '\n');
  buildIndex({ claudeDir, projectsDir, dbPath, DatabaseImpl: TestDatabase });

  class FailingCleanupDatabase extends TestDatabase {
    prepare(sql) {
      const statement = super.prepare(sql);
      if (!sql.includes('DELETE FROM sessions')) return statement;
      return {
        get: (...args) => statement.get(...args),
        all: (...args) => statement.all(...args),
        run: () => { throw new Error('cleanup interrupted'); },
      };
    }
  }

  assert.throws(
    () => buildIndex({ claudeDir, projectsDir, dbPath, DatabaseImpl: FailingCleanupDatabase, force: true }),
    /cleanup interrupted/,
  );
  const check = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(check.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 1);
  assert.equal(check.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 1);
  check.close();
});
