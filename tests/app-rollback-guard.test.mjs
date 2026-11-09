// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Regression tests for the write-transaction runner (docs/adr/0006):
//  - a transient BUSY (auto-rolled-back txn) is retried and recovers;
//  - a persistent BUSY exhausts retries without publishing a partial force rebuild;
//  - the guarded rollback never masks the real error ("cannot rollback ...").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from './temp-dirs.mjs';

const require = createRequire(import.meta.url);
import { buildIndex } from '../app/src/main/indexer.ts';
import { createClaudeProvider } from '../packages/core/src/providers/claude.ts';
const { DatabaseSync } = require('node:sqlite');

// Wraps node:sqlite and simulates SQLite auto-rollback-on-error: a poisoned write
// throws a BUSY-like error AND ends the real transaction, so a following explicit
// ROLLBACK errors with "no transaction is active". `shouldPoison(args)` decides
// which writes are poisoned.
function makeDbClass(shouldPoison) {
  return class PoisonDatabase {
    constructor(dbPath) {
      this.db = new DatabaseSync(dbPath);
      this.inTxn = false;
    }
    get inTransaction() { return this.inTxn; }
    pragma(statement) { this.db.exec(`PRAGMA ${statement}`); }
    exec(sql) {
      const head = sql.trim().slice(0, 8).toUpperCase();
      if (head.startsWith('BEGIN')) { this.inTxn = true; return this.db.exec('BEGIN'); }
      if (head.startsWith('COMMIT')) { this.inTxn = false; return this.db.exec('COMMIT'); }
      if (head.startsWith('ROLLBACK')) {
        if (!this.inTxn) throw new Error('cannot rollback - no transaction is active');
        this.inTxn = false;
        return this.db.exec('ROLLBACK');
      }
      return this.db.exec(sql);
    }
    prepare(sql) {
      const stmt = this.db.prepare(sql);
      const self = this;
      return {
        get: (...args) => stmt.get(...args),
        all: (...args) => stmt.all(...args),
        run: (...args) => {
          if (self.inTxn && shouldPoison(args)) {
            self.db.exec('ROLLBACK'); // SQLite auto-rolled the txn back on the error
            self.inTxn = false;
            throw new Error('SQLITE_BUSY: database is locked');
          }
          return stmt.run(...args);
        },
      };
    }
    close() { return this.db.close(); }
  };
}

function twoFileHome(alphaContent, betaContent) {
  const home = makeTempDir('obelisk-tx-');
  const projectDir = join(home, '.claude', 'projects', '-tmp-proj');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(join(home, '.obelisk'), { recursive: true });
  const msg = (uuid, content) => JSON.stringify({
    uuid, type: 'user', timestamp: '2026-06-10T10:00:00Z', cwd: '/tmp/proj',
    message: { role: 'user', content },
  }) + '\n';
  writeFileSync(join(projectDir, 'alpha.jsonl'), msg('a1', alphaContent));
  writeFileSync(join(projectDir, 'beta.jsonl'), msg('b1', betaContent));
  return { home, dbPath: join(home, '.obelisk', 'obelisk.sqlite'), projectsDir: join(home, '.claude', 'projects') };
}

function subagentHome(description = 'first description') {
  const home = makeTempDir('obelisk-meta-tx-');
  const projectDir = join(home, '.claude', 'projects', '-tmp-proj');
  const subagentDir = join(projectDir, 'session', 'subagents');
  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
  mkdirSync(subagentDir, { recursive: true });
  mkdirSync(join(home, '.obelisk'), { recursive: true });
  const message = uuid => JSON.stringify({
    uuid,
    type: 'user',
    timestamp: '2026-06-10T10:00:00Z',
    cwd: '/tmp/proj',
    message: { role: 'user', content: `message ${uuid}` },
  }) + '\n';
  writeFileSync(join(projectDir, 'session.jsonl'), message('main-message'));
  writeFileSync(join(subagentDir, 'agent.jsonl'), message('agent-message'));
  const metaPath = join(subagentDir, 'agent.meta.json');
  writeFileSync(metaPath, JSON.stringify({ agentType: 'Explore', description }));
  return {
    home,
    dbPath,
    projectsDir: join(home, '.claude', 'projects'),
    metaPath,
    changedMetaPath: join('-tmp-proj', 'session', 'subagents', 'agent.meta.json'),
  };
}

function run(home, dbPath, projectsDir, DatabaseImpl) {
  return buildIndex({
    force: true,
    claudeDir: join(home, '.claude'),
    codexDir: join(home, '.codex'),
    projectsDir,
    dbPath,
    DatabaseImpl,
  });
}

function makeBeginBusyDbClass(shouldFail) {
  const Base = makeDbClass(() => false);
  return class BeginBusyDatabase extends Base {
    constructor(dbPath) {
      super(dbPath);
      this.isWriterLease = dbPath.endsWith('writer.lock.sqlite');
      this.beginCalls = 0;
    }
    exec(sql) {
      if (!this.isWriterLease && sql.trim().toUpperCase().startsWith('BEGIN')) {
        this.beginCalls += 1;
        if (shouldFail(this.beginCalls)) {
          throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
        }
      }
      return super.exec(sql);
    }
  };
}

test('a failed changed file is not reported as an affected session', () => {
  const { home, dbPath, projectsDir } = twoFileHome('POISON alpha', 'hello beta');
  const Db = makeDbClass((args) => args.some(a => typeof a === 'string' && a.includes('POISON')));

  const result = buildIndex({
    force: false,
    claudeDir: join(home, '.claude'),
    codexDir: join(home, '.codex'),
    projectsDir,
    dbPath,
    DatabaseImpl: Db,
    changedPaths: ['-tmp-proj/alpha.jsonl'],
  });

  assert.deepEqual(result.affectedSessionIds, []);
  assert.equal(result.skipped, 1);
});

test('a transient BUSY during force cleanup is retried and recovers', () => {
  const { home, dbPath, projectsDir } = twoFileHome('hello alpha', 'hello beta');
  // Fire exactly once, on the first write inside a transaction, then never again.
  let fired = false;
  const Db = makeDbClass(() => (fired ? false : (fired = true)));

  let result;
  assert.doesNotThrow(() => { result = run(home, dbPath, projectsDir, Db); });

  const check = new DatabaseSync(dbPath);
  const sessions = check.prepare('SELECT COUNT(*) AS c FROM sessions').get().c;
  check.close();
  assert.equal(sessions, 2, 'the retried file recovered; both files indexed');
  assert.equal(result.skipped, 0, 'nothing was skipped');
});

test('a transient BUSY during a file transaction is retried and recovers', () => {
  const { home, dbPath, projectsDir } = twoFileHome('hello alpha', 'hello beta');
  let fired = false;
  const Db = makeDbClass((args) => {
    const isAlphaWrite = args.some(arg => typeof arg === 'string' && arg.includes('hello alpha'));
    if (!isAlphaWrite || fired) return false;
    fired = true;
    return true;
  });

  const result = run(home, dbPath, projectsDir, Db);
  const check = new DatabaseSync(dbPath);
  const sessions = check.prepare('SELECT COUNT(*) AS c FROM sessions').get().c;
  check.close();
  assert.equal(sessions, 2);
  assert.equal(result.skipped, 0);
});

test('a persistent BUSY rolls back the complete force rebuild', () => {
  const { home, dbPath, projectsDir } = twoFileHome('POISON alpha', 'hello beta');
  // Always poison writes that carry alpha's marker text; beta is untouched.
  const Db = makeDbClass((args) => args.some(a => typeof a === 'string' && a.includes('POISON')));

  let result;
  assert.doesNotThrow(() => { result = run(home, dbPath, projectsDir, Db); });

  const check = new DatabaseSync(dbPath);
  const sessions = check.prepare('SELECT id FROM sessions ORDER BY id').all().map(r => r.id);
  check.close();
  assert.deepEqual(sessions, [], 'no partial force snapshot is published');
  assert.equal(result.complete, false);
  assert.equal(result.skipped, 1, 'the skipped file is reported in the build result');
  assert.equal(result.skippedFiles[0].diagnostics?.phase, 'work', 'diagnostics record the failing phase');
});

test('BEGIN contention during force cleanup defers the build', () => {
  const { home, dbPath, projectsDir } = twoFileHome('hello alpha', 'hello beta');
  const Db = makeBeginBusyDbClass(beginCall => beginCall === 1);

  const result = run(home, dbPath, projectsDir, Db);
  assert.equal(result.deferred, true);
  assert.equal(result.reason, 'database_busy');
});

test('BEGIN contention during finalize defers the build', () => {
  const { home, dbPath, projectsDir } = twoFileHome('hello alpha', 'hello beta');
  const Db = makeBeginBusyDbClass(beginCall => beginCall === 3);

  const result = buildIndex({
    force: false,
    claudeDir: join(home, '.claude'),
    codexDir: join(home, '.codex'),
    projectsDir,
    dbPath,
    DatabaseImpl: Db,
  });
  assert.equal(result.deferred, true);
  assert.equal(result.reason, 'database_busy');
});

test('a marker replay resumes after the last committed file when the next transaction defers', () => {
  const { home, dbPath, projectsDir } = subagentHome();
  const StableDb = makeDbClass(() => false);
  assert.equal(run(home, dbPath, projectsDir, StableDb).complete, true);

  const marker = createClaudeProvider({ rootDir: join(home, '.claude') }).indexVersionMarker;
  let db = new DatabaseSync(dbPath);
  db.prepare('DELETE FROM index_state WHERE jsonl_path=?').run(marker);
  db.close();

  const InterruptedDb = makeBeginBusyDbClass(beginCall => beginCall === 2);
  const interrupted = buildIndex({
    force: false,
    claudeDir: join(home, '.claude'),
    codexDir: join(home, '.codex'),
    projectsDir,
    dbPath,
    DatabaseImpl: InterruptedDb,
  });
  assert.equal(interrupted.deferred, true);
  assert.equal(interrupted.reason, 'database_busy');

  db = new DatabaseSync(dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM index_state WHERE jsonl_path=?').get(marker).c, 1);
  db.close();

  const resumed = buildIndex({
    force: false,
    claudeDir: join(home, '.claude'),
    codexDir: join(home, '.codex'),
    projectsDir,
    dbPath,
    DatabaseImpl: StableDb,
  });
  assert.equal(resumed.files, 1, 'the committed file is not replayed after restart');
  assert.equal(resumed.complete, true);

  db = new DatabaseSync(dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages').get().c, 2);
  db.close();
});

test('a finalize database error is propagated instead of swallowed as malformed input', () => {
  const { home, dbPath, projectsDir } = twoFileHome('hello alpha', 'hello beta');
  const Db = makeDbClass(args => args.some(arg => arg === '__last_build__'));

  assert.throws(() => buildIndex({
    force: false,
    claudeDir: join(home, '.claude'),
    codexDir: join(home, '.codex'),
    projectsDir,
    dbPath,
    DatabaseImpl: Db,
  }), /SQLITE_BUSY/);
});

test('a changed subagent meta file is applied and reported only after its file transaction commits', () => {
  const { home, dbPath, projectsDir, metaPath, changedMetaPath } = subagentHome();
  const Db = makeDbClass(() => false);
  buildIndex({
    force: true,
    claudeDir: join(home, '.claude'),
    codexDir: join(home, '.codex'),
    projectsDir,
    dbPath,
    DatabaseImpl: Db,
  });
  writeFileSync(metaPath, JSON.stringify({ agentType: 'Explore', description: 'updated description' }));

  const result = buildIndex({
    force: false,
    changedPaths: [changedMetaPath],
    claudeDir: join(home, '.claude'),
    codexDir: join(home, '.codex'),
    projectsDir,
    dbPath,
    DatabaseImpl: Db,
  });
  const check = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(check.prepare('SELECT description FROM subagents WHERE agent_id=?').get('agent').description, 'updated description');
  check.close();
  assert.deepEqual(result.affectedSessionIds, ['session']);
});

test('a failed subagent meta transaction does not report its session as affected', () => {
  const { home, dbPath, projectsDir, metaPath, changedMetaPath } = subagentHome();
  buildIndex({
    force: true,
    claudeDir: join(home, '.claude'),
    codexDir: join(home, '.codex'),
    projectsDir,
    dbPath,
    DatabaseImpl: makeDbClass(() => false),
  });
  writeFileSync(metaPath, JSON.stringify({ agentType: 'Explore', description: 'POISON META' }));
  const FailingDb = makeDbClass(args => args.some(arg => typeof arg === 'string' && arg.includes('POISON META')));

  const result = buildIndex({
    force: false,
    changedPaths: [changedMetaPath],
    claudeDir: join(home, '.claude'),
    codexDir: join(home, '.codex'),
    projectsDir,
    dbPath,
    DatabaseImpl: FailingDb,
  });
  assert.deepEqual(result.affectedSessionIds, []);
  assert.equal(result.skipped, 1);
});
