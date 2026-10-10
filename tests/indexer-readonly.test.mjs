// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { cliEntry, repoRoot, runCli } from './cli-test-helpers.mjs';
import { makeTempDir } from './temp-dirs.mjs';

// Real provider output; faults are injected at the index or source boundary.
function fixture() {
  const home = makeTempDir('obelisk-readonly-');
  const warm = runCli(['--build'], { home });
  assert.equal(warm.status, 0, warm.stderr || warm.stdout);
  const project = join(home, '.claude', 'projects', '-tmp-readonly');
  mkdirSync(project, { recursive: true });
  for (const name of ['first', 'second']) {
    copyFileSync(new URL('./fixtures/claude/custom-title-session.jsonl', import.meta.url), join(project, `${name}.jsonl`));
  }
  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
  const db = new DatabaseSync(dbPath);
  db.prepare("DELETE FROM index_state WHERE jsonl_path='__last_build__'").run();
  db.close();
  const query = join(home, 'query.mjs');
  writeFileSync(query, "throw new Error('QUERY_SCRIPT_RAN');\n");
  return { home, dbPath, query };
}

function snapshot(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      state: db.prepare('SELECT * FROM index_state ORDER BY jsonl_path').all(),
      sessions: db.prepare('SELECT * FROM sessions ORDER BY id').all(),
      messages: db.prepare('SELECT * FROM messages ORDER BY uuid').all(),
    };
  } finally {
    db.close();
  }
}

function runFaultCli(args, home, mode) {
  const dbUrl = pathToFileURL(join(repoRoot, 'packages/cli/dist/core/src/db.js')).href;
  const indexingUrl = pathToFileURL(join(repoRoot, 'packages/cli/dist/core/src/provider-indexing.js')).href;
  const leaseUrl = pathToFileURL(join(repoRoot, 'packages/cli/dist/core/src/writer-lease.js')).href;
  const preload = join(home, 'readonly-preload.mjs');
  writeFileSync(preload, `
    import { mock } from 'node:test';
    import { DatabaseSync } from 'node:sqlite';
    const original = await import(${JSON.stringify(dbUrl)});
    const indexing = await import(${JSON.stringify(indexingUrl)});
    const leasing = await import(${JSON.stringify(leaseUrl)});
    const mode = ${JSON.stringify(mode)};
    const permission = (path) => Object.assign(new Error(mode.split(':')[1] + ': access denied, ' + path),
      { code: mode.split(':')[1], path });
    const sourceFailure = () => {
      if (['source:EACCES', 'source:EPERM'].includes(mode)) throw permission('source-store.sqlite');
      const source = new DatabaseSync(':memory:');
      try {
        source.exec('CREATE TABLE probe (id); PRAGMA query_only=ON; UPDATE probe SET id=id WHERE 0');
      } finally { source.close(); }
    };
    let opened;
    let holder;
    mock.module(${JSON.stringify(dbUrl)}, { namedExports: {
      ...original,
      openReadDb() {
        if (mode.startsWith('read:')) throw permission(original.DB_PATH);
        return original.openReadDb();
      },
      openDb() {
        if (mode.startsWith('open:')) throw permission(original.DB_PATH);
        if (mode === 'cantopen') return new DatabaseSync(original.DB_PATH + '/missing/database.sqlite');
        if (mode === 'io-error') throw Object.assign(new Error('disk I/O error'), {code:'ERR_SQLITE_ERROR',errcode:10});
        if (mode === 'extended-readonly') throw Object.assign(new Error('attempt to write a readonly database'), {code:'ERR_SQLITE_ERROR',errcode:1544});
        if (mode === 'symbolic-readonly') throw Object.assign(new Error('attempt to write a readonly database'), {code:'SQLITE_READONLY_DIRECTORY'});
        if (mode === 'misleading-text') throw new Error('provider text mentions SQLITE_READONLY');
        opened = original.openDb();
        if (mode === 'read-only-connection') {
          opened.close();
          opened = new DatabaseSync(original.DB_PATH, {readOnly:true});
        } else if (mode === 'query-only') opened.exec('PRAGMA query_only=ON');
        const close = opened.close.bind(opened);
        opened.close = () => { process.stderr.write('WRITE_CONNECTION_CLOSED\\n'); close(); };
        if (mode === 'source:unsafe-rollback') {
          const exec = opened.exec.bind(opened);
          opened.exec = (sql) => {
            if (sql === 'ROLLBACK') throw new Error('injected rollback failure');
            return exec(sql);
          };
        }
        if (mode === 'source:unsafe-rollback' || mode === 'source:probe-io') {
          const prepare = opened.prepare.bind(opened);
          let probes = 0;
          opened.prepare = (sql) => {
            if (sql === 'UPDATE index_state SET mtime=mtime WHERE 0') {
              process.stderr.write('INDEX_WRITE_PROBE\\n');
              if (++probes > 1 && mode === 'source:probe-io') {
                throw Object.assign(new Error('disk I/O error'), { code:'ERR_SQLITE_ERROR', errcode:10 });
              }
            }
            return prepare(sql);
          };
        }
        if (mode === 'busy') {
          holder = new DatabaseSync(original.DB_PATH);
          holder.exec('BEGIN IMMEDIATE');
          process.on('exit', () => { holder.exec('ROLLBACK'); holder.close(); });
        }
        if (mode === 'readonly-during-persist') {
          const prepare = opened.prepare.bind(opened);
          opened.prepare = (sql) => {
            if (/INSERT INTO messages/.test(sql)) opened.exec('PRAGMA query_only=ON');
            return prepare(sql);
          };
        }
        return opened;
      },
      openWriterLeaseDb(path) {
        if (mode.startsWith('lease:')) throw permission(path);
        const db = original.openWriterLeaseDb(path);
        if (mode === 'lease-readonly') db.exec('PRAGMA query_only=ON');
        return db;
      },
    }});
    mock.module(${JSON.stringify(leaseUrl)}, { namedExports: {
      ...leasing,
      acquireWriterLease(options) {
        if (mode.startsWith('directory:')) throw permission(options.lockPath);
        return leasing.acquireWriterLease(options);
      },
    }});
    mock.module(${JSON.stringify(indexingUrl)}, { namedExports: {
      ...indexing,
      createProviderIndexPlan(...args) {
        process.stderr.write('PROVIDER_DISCOVERY_STARTED\\n');
        const plan = indexing.createProviderIndexPlan(...args);
        if (mode === 'source-discovery-readonly') sourceFailure();
        if (mode.startsWith('source:')) {
          const item = plan.items[0];
          plan.items[0] = { ...item, provider: { ...item.provider,
            *parse() { sourceFailure(); return null; },
          } };
        }
        if (mode === 'readonly-after-discovery') opened.exec('PRAGMA query_only=ON');
        return plan;
      },
    }});
  `);
  const env = { ...process.env, HOME: home, USERPROFILE: home,
    APPDATA: join(home, 'AppData/Roaming'), XDG_CONFIG_HOME: join(home, '.config') };
  delete env.DSH_HOME;
  delete env.HERMES_HOME;
  return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning',
    '--experimental-test-module-mocks', '--import', pathToFileURL(preload).href, cliEntry, ...args],
  { cwd: repoRoot, env, encoding: 'utf8', timeout: 30000 });
}

for (const mode of ['query-only', 'read-only-connection', 'lease-readonly']) {
  for (const verb of ['query', 'search', 'build']) {
    test(`${verb} fails before discovery when the index writer is ${mode}, without publishing stale results`, () => {
      const { home, dbPath, query } = fixture();
      const before = snapshot(dbPath);
      const args = verb === 'query' ? ['--query', query] : verb === 'search' ? ['--search', 'needle'] : ['--build'];
      const result = runFaultCli(args, home, mode);
      assert.equal(result.status, 1, result.stderr || result.stdout);
      const failure = JSON.parse(result.stdout);
      assert.deepEqual(Object.keys(failure).sort(), ['error', 'stack'], 'the frozen CLI error envelope is unchanged');
      assert.match(failure.error, /Cannot refresh the Obelisk index/);
      assert.ok(failure.error.includes(dbPath), 'diagnostic identifies the actual index');
      assert.match(failure.error, /attempt to write a readonly database/);
      assert.match(failure.error, /host-approved permissions/);
      assert.match(failure.stack, /Caused by: Error: attempt to write a readonly database/);
      assert.doesNotMatch(failure.error, /QUERY_SCRIPT_RAN/);
      assert.doesNotMatch(result.stderr, /PROVIDER_DISCOVERY_STARTED|failed to index .* unit/);
      if (mode !== 'lease-readonly') assert.match(result.stderr, /WRITE_CONNECTION_CLOSED/);
      assert.deepEqual(snapshot(dbPath), before, 'failed refresh preserves data and every progress marker');
      const recovered = runCli(['--build'], { home });
      assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
      assert.equal(JSON.parse(recovered.stdout).ok, true, 'the writer lease was released');
      assert.ok(snapshot(dbPath).messages.length > 0, 'the same real transcripts index after write access returns');
    });
  }
}

for (const args of [['--search', 'needle'], ['--build']]) {
  test(`${args[0]} aborts a read-only failure after discovery instead of skipping each source unit`, () => {
    const { home, dbPath } = fixture();
    const before = snapshot(dbPath);
    const result = runFaultCli(args, home, 'readonly-after-discovery');
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(JSON.parse(result.stdout).error, /Cannot refresh the Obelisk index/);
    assert.match(result.stderr, /PROVIDER_DISCOVERY_STARTED/);
    assert.doesNotMatch(result.stderr, /failed to index .* unit/);
    assert.deepEqual(snapshot(dbPath), before);
  });
  test(`${args[0]} rolls back a read-only failure during persistence without publishing a cursor`, () => {
    const { home, dbPath } = fixture();
    const before = snapshot(dbPath);
    const result = runFaultCli(args, home, 'readonly-during-persist');
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(JSON.parse(result.stdout).error, /Cannot refresh the Obelisk index/);
    assert.match(JSON.parse(result.stdout).error, /attempt to write a readonly database/);
    assert.doesNotMatch(result.stderr, /failed to index .* unit/);
    assert.deepEqual(snapshot(dbPath), before, 'force cleanup and partial unit writes both roll back');
  });
}

for (const mode of ['extended-readonly', 'symbolic-readonly']) {
  test(`${mode} preserves the SQLite error and identifies the index`, () => {
    const { home, dbPath } = fixture();
    const before = snapshot(dbPath);
    const result = runFaultCli(['--search', 'needle'], home, mode);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(JSON.parse(result.stdout).error, /Cannot refresh the Obelisk index/);
    assert.ok(JSON.parse(result.stdout).error.includes(dbPath));
    assert.doesNotMatch(result.stderr, /PROVIDER_DISCOVERY_STARTED/);
    assert.deepEqual(snapshot(dbPath), before);
  });
}

test('a provider message mentioning SQLITE_READONLY does not invent a SQLite permission failure', () => {
  const { home } = fixture();
  const result = runFaultCli(['--search', 'needle'], home, 'misleading-text');
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).error, 'provider text mentions SQLITE_READONLY');
});

test('an unrelated I/O failure retains its original diagnostic instead of being labelled read-only', () => {
  const { home } = fixture();
  const result = runFaultCli(['--search', 'needle'], home, 'io-error');
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).error, 'disk I/O error');
});

test('a busy index writer defers before discovery and is not misclassified as read-only', () => {
  const { home, dbPath } = fixture();
  const before = snapshot(dbPath);
  const result = runFaultCli(['--build'], home, 'busy');
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).error, 'Index rebuild was not published: database_busy');
  assert.doesNotMatch(result.stderr, /PROVIDER_DISCOVERY_STARTED|failed to index .* unit/);
  assert.deepEqual(snapshot(dbPath), before);
  const recovered = runCli(['--build'], { home });
  assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
});

for (const code of ['EACCES', 'EPERM', 'EROFS']) {
  for (const boundary of ['read', 'directory', 'lease', 'open']) {
    test(`${code} at the index ${boundary} boundary preserves the error, path, and recovery guidance`, () => {
      const { home, dbPath, query } = fixture();
      const before = snapshot(dbPath);
      const result = runFaultCli(['--query', query], home, `${boundary}:${code}`);
      assert.equal(result.status, 1, result.stderr || result.stdout);
      const failure = JSON.parse(result.stdout);
      assert.match(failure.error, /Cannot (?:access|refresh) the Obelisk index/);
      assert.ok(failure.error.includes(dbPath));
      assert.ok(failure.error.includes(code));
      assert.match(failure.error, /host-approved permissions/);
      assert.match(failure.stack, /Caused by: Error:/);
      assert.doesNotMatch(result.stderr, /PROVIDER_DISCOVERY_STARTED|failed to index .* unit/);
      assert.doesNotMatch(failure.error, /QUERY_SCRIPT_RAN/);
      assert.deepEqual(snapshot(dbPath), before);
      const recovered = runCli(['--build'], { home });
      assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
      assert.ok(snapshot(dbPath).messages.length > 0);
    });
  }
}

test('SQLite CANTOPEN identifies the index without asserting that a sandbox caused the failure', () => {
  const { home, dbPath } = fixture();
  const result = runFaultCli(['--search', 'needle'], home, 'cantopen');
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const failure = JSON.parse(result.stdout);
  assert.match(failure.error, /Cannot access the Obelisk index/);
  assert.ok(failure.error.includes(dbPath));
  assert.match(failure.error, /unable to open database file/);
  assert.match(failure.error, /if this command is sandboxed/);
});

for (const code of ['SQLITE_READONLY', 'EACCES', 'EPERM']) {
  test(`a ${code} source failure stays local and readable sibling transcripts still index`, () => {
    const { home, dbPath } = fixture();
    const result = runFaultCli(['--search', 'needle'], home, `source:${code}`);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stderr, /Warning: failed to index claude unit/);
    assert.doesNotMatch(result.stdout + result.stderr, /Cannot (?:access|refresh) the Obelisk index|host-approved permissions/);
    const after = snapshot(dbPath);
    assert.ok(after.messages.length > 0, 'readable sibling records are committed');
    assert.ok(after.state.some(row => row.jsonl_path.endsWith('second.jsonl')));
    assert.ok(!after.state.some(row => row.jsonl_path.endsWith('first.jsonl')), 'failed source gets no cursor');
  });
  test(`a ${code} source failure makes a force snapshot incomplete without blaming index permissions`, () => {
    const { home, dbPath } = fixture();
    const before = snapshot(dbPath);
    const result = runFaultCli(['--build'], home, `source:${code}`);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).error, 'Index rebuild was not published: provider_failure');
    assert.match(result.stderr, /Warning: failed to index claude unit/);
    assert.doesNotMatch(result.stdout + result.stderr, /Cannot (?:access|refresh) the Obelisk index|host-approved permissions/);
    assert.deepEqual(snapshot(dbPath), before);
  });
}

test('a source SQLite failure during discovery is not attributed to the writable index', () => {
  const { home, dbPath } = fixture();
  const before = snapshot(dbPath);
  const result = runFaultCli(['--search', 'needle'], home, 'source-discovery-readonly');
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).error, 'attempt to write a readonly database');
  assert.deepEqual(snapshot(dbPath), before);
});

for (const mode of ['source:unsafe-rollback', 'source:probe-io']) {
  test(`${mode} aborts with the primary source error instead of misattributing it or advancing progress`, () => {
    const { home, dbPath } = fixture();
    const before = snapshot(dbPath);
    const result = runFaultCli(['--search', 'needle'], home, mode);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).error, 'attempt to write a readonly database');
    assert.doesNotMatch(result.stdout + result.stderr, /Cannot (?:access|refresh) the Obelisk index|failed to index .* unit/);
    assert.equal((result.stderr.match(/INDEX_WRITE_PROBE/g) ?? []).length,
      mode === 'source:unsafe-rollback' ? 1 : 2, 'no new probe runs in an unusable transaction');
    assert.deepEqual(snapshot(dbPath), before);
    const recovered = runCli(['--build'], { home });
    assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
  });
}
