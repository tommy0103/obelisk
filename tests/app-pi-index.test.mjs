// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { buildIndex } from '../app/src/main/indexer.ts';
import {
  createPiProvider,
  piSessionId,
  PI_CANONICAL_TRANSCRIPT_MARKER,
} from '../packages/core/src/providers/pi.ts';
import { createProviderRegistry } from '../packages/core/src/providers/registry.ts';
import { makeTempDir } from './temp-dirs.mjs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const TOOL_FIXTURE = new URL('./fixtures/pi/tool-session.jsonl', import.meta.url);

class TestDatabase {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
  }

  pragma(statement) { this.db.exec(`PRAGMA ${statement}`); }
  exec(sql) { return this.db.exec(sql); }
  prepare(sql) { return this.db.prepare(sql); }
  close() { return this.db.close(); }
}

class TransactionAwareTestDatabase extends TestDatabase {
  get inTransaction() { return this.db.isTransaction; }
}

function writeFixture(piDir) {
  const sessionPath = join(piDir, '--tmp-pi-real-tool--', 'session.jsonl');
  mkdirSync(dirname(sessionPath), { recursive: true });
  writeFileSync(sessionPath, readFileSync(TOOL_FIXTURE));
  return sessionPath;
}

function invalidMessageLine(id = 'invalid-message') {
  return JSON.stringify({
    type: 'message',
    id,
    parentId: null,
    timestamp: '2026-08-02T10:00:01.000Z',
    message: null,
  });
}

function indexOptions(home, piDir) {
  return {
    claudeDir: join(home, '.claude'),
    codexDir: join(home, '.codex'),
    providerRoots: { pi: piDir },
    dbPath: join(home, '.obelisk', 'obelisk.sqlite'),
    DatabaseImpl: TestDatabase,
  };
}

test('app build indexes Pi through the registry and replays complete session snapshots', () => {
  const home = makeTempDir('obelisk-pi-index-');
  const piDir = join(home, 'pi-sessions');
  const sessionPath = writeFixture(piDir);
  const options = indexOptions(home, piDir);
  const provider = createPiProvider({ rootDir: piDir });
  const sessionId = provider.discover({ lastCursor: () => null })[0].sessionId;

  const first = buildIndex(options);
  assert.deepEqual(first.affectedSessionIds, [sessionId]);

  let db = new TestDatabase(options.dbPath);
  assert.deepEqual(
    db.prepare('SELECT id,title,source,message_count FROM sessions').all().map(row => ({ ...row })),
    [{ id: sessionId, title: 'Tool probe', source: 'pi', message_count: 4 }],
  );
  assert.equal(
    db.prepare("SELECT text FROM messages WHERE source='pi' AND role='assistant' AND content_type='text'").get().text,
    'The read tool returned real-pi-tool-result.',
  );
  assert.deepEqual(
    { ...db.prepare("SELECT name,file_path FROM tool_calls WHERE session_id=?").get(sessionId) },
    { name: 'read', file_path: 'probe.txt' },
  );
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'").get().sql;
  assert.doesNotMatch(schema, /\bpi\b/i);
  db.close();

  const header = readFileSync(TOOL_FIXTURE, 'utf8').split('\n')[0];
  writeFileSync(sessionPath, `${header}\n`);
  const replay = buildIndex({ ...options, changedPaths: [sessionPath] });
  assert.deepEqual(replay.affectedSessionIds, [sessionId]);

  db = new TestDatabase(options.dbPath);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM messages WHERE source='pi'").get().c, 0);
  assert.equal(db.prepare('SELECT message_count FROM sessions WHERE id=?').get(sessionId).message_count, 0);
  db.close();
});

test('an unreadable Pi directory does not block readable sessions on a fresh index', {
  skip: process.platform === 'win32',
}, (t) => {
  const home = makeTempDir('obelisk-pi-partial-inventory-');
  const piDir = join(home, 'pi-sessions');
  writeFixture(piDir);
  const lockedDir = join(piDir, 'locked');
  mkdirSync(lockedDir, { recursive: true });
  chmodSync(lockedDir, 0o000);

  try {
    try {
      readdirSync(lockedDir);
      t.skip('current user can read mode-000 directories');
      return;
    } catch {}

    const options = indexOptions(home, piDir);
    const first = buildIndex(options);
    assert.equal(first.complete, false);
    assert.equal(first.files, 1);
    assert.deepEqual(first.incompleteProviders, ['pi']);
    assert.ok(first.inventoryIssues.some((issue) => (
      issue.provider === 'pi' && issue.path === lockedDir
    )));

    const db = new TestDatabase(options.dbPath);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE source='pi'").get().c, 1);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS c FROM index_state WHERE jsonl_path=?')
        .get(PI_CANONICAL_TRANSCRIPT_MARKER).c,
      0,
    );
    db.close();
  } finally {
    chmodSync(lockedDir, 0o700);
  }

  const recovered = buildIndex(indexOptions(home, piDir));
  assert.equal(recovered.complete, true);
  const db = new TestDatabase(join(home, '.obelisk', 'obelisk.sqlite'));
  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM index_state WHERE jsonl_path=?')
      .get(PI_CANONICAL_TRANSCRIPT_MARKER).c,
    1,
  );
  db.close();
});

test('an incomplete Pi identity census preserves committed provenance over a readable copy', {
  skip: process.platform === 'win32',
}, (t) => {
  const home = makeTempDir('obelisk-pi-partial-copy-');
  const piDir = join(home, 'pi-sessions');
  const lockedDir = join(piDir, 'locked');
  const committedPath = join(lockedDir, 'session.jsonl');
  mkdirSync(lockedDir, { recursive: true });
  writeFileSync(committedPath, readFileSync(TOOL_FIXTURE));
  const options = indexOptions(home, piDir);
  assert.equal(buildIndex(options).complete, true);

  let db = new TestDatabase(options.dbPath);
  const before = {
    session: {
      ...db.prepare("SELECT id,title,message_count,jsonl_path FROM sessions WHERE source='pi'").get(),
    },
    messages: db.prepare(
      "SELECT uuid,text,visibility FROM messages WHERE source='pi' ORDER BY uuid",
    ).all().map(row => ({ ...row })),
  };
  db.close();

  const readablePath = join(piDir, 'readable', 'session.jsonl');
  mkdirSync(dirname(readablePath), { recursive: true });
  writeFileSync(
    readablePath,
    readFileSync(TOOL_FIXTURE, 'utf8').replaceAll(
      'real-pi-tool-result',
      'UNVERIFIED NEW',
    ),
  );
  chmodSync(lockedDir, 0o000);

  try {
    try {
      readdirSync(lockedDir);
      t.skip('current user can read mode-000 directories');
      return;
    } catch {}

    const partial = buildIndex(options);
    assert.equal(partial.complete, false);
    assert.equal(partial.files, 0);
    assert.deepEqual(partial.affectedSessionIds, []);
    assert.ok(partial.inventoryIssues.some((issue) => (
      issue.provider === 'pi' && issue.path === lockedDir
    )));

    db = new TestDatabase(options.dbPath);
    const after = {
      session: {
        ...db.prepare("SELECT id,title,message_count,jsonl_path FROM sessions WHERE source='pi'").get(),
      },
      messages: db.prepare(
        "SELECT uuid,text,visibility FROM messages WHERE source='pi' ORDER BY uuid",
      ).all().map(row => ({ ...row })),
    };
    assert.deepEqual(after, before);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS c FROM index_state WHERE jsonl_path=?')
        .get(readablePath).c,
      0,
    );
    db.close();
  } finally {
    chmodSync(lockedDir, 0o700);
  }
});

test('Pi canonical marker forces one provider-owned replay after projection changes', () => {
  const home = makeTempDir('obelisk-pi-marker-');
  const piDir = join(home, 'pi-sessions');
  writeFixture(piDir);
  const options = indexOptions(home, piDir);
  const sessionId = createPiProvider({ rootDir: piDir })
    .discover({ lastCursor: () => null })[0].sessionId;

  buildIndex(options);
  let db = new TestDatabase(options.dbPath);
  db.prepare("UPDATE messages SET text='stale Pi projection' WHERE source='pi'").run();
  db.prepare('DELETE FROM index_state WHERE jsonl_path=?').run(PI_CANONICAL_TRANSCRIPT_MARKER);
  db.close();

  const replay = buildIndex(options);
  assert.deepEqual(replay.affectedSessionIds, [sessionId]);
  db = new TestDatabase(options.dbPath);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM messages WHERE source='pi' AND text='stale Pi projection'").get().c,
    0,
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM index_state WHERE jsonl_path=?')
      .get(PI_CANONICAL_TRANSCRIPT_MARKER).c,
    1,
  );
  db.close();
});

test('a structurally invalid Pi file retries alone after a canonical replay', () => {
  const home = makeTempDir('obelisk-pi-marker-retry-');
  const piDir = join(home, 'pi-sessions');
  const validPath = writeFixture(piDir);
  const options = {
    ...indexOptions(home, piDir),
    DatabaseImpl: TransactionAwareTestDatabase,
  };
  const provider = createPiProvider({ rootDir: piDir });
  const parseCalls = new Map();
  const countedProvider = {
    ...provider,
    parse(unit, cursor) {
      parseCalls.set(unit.key, (parseCalls.get(unit.key) ?? 0) + 1);
      return provider.parse(unit, cursor);
    },
  };
  const providerRegistry = createProviderRegistry([countedProvider]);

  buildIndex({ ...options, providerRegistry });
  const badPath = join(piDir, '--tmp-pi-bad--', 'session.jsonl');
  mkdirSync(dirname(badPath), { recursive: true });
  writeFileSync(badPath, [
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'permanently-bad',
      timestamp: '2026-08-02T10:00:00.000Z',
      cwd: '/tmp/pi-bad',
    }),
    invalidMessageLine('permanently-bad-message'),
    '',
  ].join('\n'));

  let db = new TransactionAwareTestDatabase(options.dbPath);
  db.prepare('DELETE FROM index_state WHERE jsonl_path=?').run(PI_CANONICAL_TRANSCRIPT_MARKER);
  db.close();
  parseCalls.clear();

  const replay = buildIndex({ ...options, providerRegistry });
  assert.equal(replay.files, 2);
  assert.equal(replay.skipped, 1);
  assert.equal(parseCalls.get(validPath), 1);
  assert.equal(parseCalls.get(badPath), 1);

  db = new TransactionAwareTestDatabase(options.dbPath);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM index_state WHERE jsonl_path=?')
      .get(PI_CANONICAL_TRANSCRIPT_MARKER).c,
    1,
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM index_state WHERE jsonl_path=?').get(badPath).c,
    0,
  );
  db.close();

  const retry = buildIndex({ ...options, providerRegistry });
  assert.equal(retry.files, 1);
  assert.equal(retry.skipped, 1);
  assert.equal(parseCalls.get(validPath), 1, 'the successful session must not replay again');
  assert.equal(parseCalls.get(badPath), 2, 'only the failed session remains retryable');
});

test('a failed Pi unit rolls back a force rebuild to the last complete snapshot', () => {
  const home = makeTempDir('obelisk-pi-force-rollback-');
  const piDir = join(home, 'pi-sessions');
  const sessionPath = writeFixture(piDir);
  const options = {
    ...indexOptions(home, piDir),
    DatabaseImpl: TransactionAwareTestDatabase,
  };
  assert.equal(buildIndex(options).complete, true);

  let db = new TransactionAwareTestDatabase(options.dbPath);
  const before = {
    session: { ...db.prepare("SELECT id,title,message_count,jsonl_path FROM sessions WHERE source='pi'").get() },
    messages: db.prepare("SELECT uuid,text,content_type FROM messages WHERE source='pi' ORDER BY uuid").all()
      .map(row => ({ ...row })),
    cursor: { ...db.prepare('SELECT mtime,lines_processed,cursor FROM index_state WHERE jsonl_path=?').get(sessionPath) },
    lastBuild: { ...db.prepare("SELECT mtime,lines_processed FROM index_state WHERE jsonl_path='__last_build__'").get() },
  };
  db.close();

  const fixtureHeader = readFileSync(TOOL_FIXTURE, 'utf8').split('\n')[0];
  writeFileSync(sessionPath, `${fixtureHeader}\n${invalidMessageLine()}\n`);
  const failed = buildIndex({ ...options, force: true });
  assert.equal(failed.complete, false);
  assert.equal(failed.reason, 'provider_failure');
  assert.deepEqual(failed.affectedSessionIds, []);
  assert.equal(failed.skippedFiles[0].provider, 'pi');
  assert.equal(failed.skippedFiles[0].path, sessionPath);
  assert.match(failed.skippedFiles[0].error, /Malformed Pi message at line 2/);

  db = new TransactionAwareTestDatabase(options.dbPath);
  const after = {
    session: { ...db.prepare("SELECT id,title,message_count,jsonl_path FROM sessions WHERE source='pi'").get() },
    messages: db.prepare("SELECT uuid,text,content_type FROM messages WHERE source='pi' ORDER BY uuid").all()
      .map(row => ({ ...row })),
    cursor: { ...db.prepare('SELECT mtime,lines_processed,cursor FROM index_state WHERE jsonl_path=?').get(sessionPath) },
    lastBuild: { ...db.prepare("SELECT mtime,lines_processed FROM index_state WHERE jsonl_path='__last_build__'").get() },
  };
  db.close();
  assert.deepEqual(after, before);
});

test('a temp force rebuild uses live Pi provenance before publishing an empty snapshot', () => {
  const home = makeTempDir('obelisk-pi-temp-provenance-');
  const piDir = join(home, 'pi-sessions');
  writeFixture(piDir);
  const options = indexOptions(home, piDir);
  assert.equal(buildIndex(options).complete, true);

  const unavailableDir = `${piDir}.unavailable`;
  renameSync(piDir, unavailableDir);
  const tempDbPath = join(home, '.obelisk', 'obelisk.rebuild.tmp');
  const rebuilt = buildIndex({
    ...options,
    dbPath: tempDbPath,
    preserveDbPath: options.dbPath,
    force: true,
  });
  assert.equal(rebuilt.complete, false);
  assert.equal(rebuilt.reason, 'incomplete_snapshot');
  assert.deepEqual(rebuilt.incompleteProviders, ['pi']);

  const live = new TestDatabase(options.dbPath);
  assert.equal(live.prepare("SELECT COUNT(*) AS c FROM sessions WHERE source='pi'").get().c, 1);
  live.close();
  renameSync(unavailableDir, piDir);
});

test('an unavailable Pi root keeps replay pending on the missing session cursor', () => {
  const home = makeTempDir('obelisk-pi-incomplete-marker-');
  const piDir = join(home, 'pi-sessions');
  const sessionPath = writeFixture(piDir);
  const options = indexOptions(home, piDir);

  buildIndex(options);
  let db = new TestDatabase(options.dbPath);
  db.prepare(`
    UPDATE messages
    SET text='stale Pi projection'
    WHERE uuid = (
      SELECT uuid FROM messages WHERE source='pi' ORDER BY uuid LIMIT 1
    )
  `).run();
  db.prepare('DELETE FROM index_state WHERE jsonl_path=?').run(PI_CANONICAL_TRANSCRIPT_MARKER);
  db.close();

  const unavailableDir = `${piDir}.unavailable`;
  renameSync(piDir, unavailableDir);
  const forced = buildIndex({ ...options, force: true });
  assert.equal(forced.complete, false);
  assert.equal(forced.reason, 'incomplete_snapshot');
  assert.deepEqual(forced.incompleteProviders, ['pi']);
  const unavailable = buildIndex(options);
  assert.equal(unavailable.files, 0);

  db = new TestDatabase(options.dbPath);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM index_state WHERE jsonl_path=?')
      .get(PI_CANONICAL_TRANSCRIPT_MARKER).c,
    1,
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM index_state WHERE jsonl_path=?')
      .get(sessionPath).c,
    0,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM messages WHERE text='stale Pi projection'").get().c,
    1,
  );
  db.close();

  renameSync(unavailableDir, piDir);
  const replay = buildIndex(options);
  assert.equal(replay.files, 1);
  db = new TestDatabase(options.dbPath);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM index_state WHERE jsonl_path=?')
      .get(PI_CANONICAL_TRANSCRIPT_MARKER).c,
    1,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM messages WHERE text='stale Pi projection'").get().c,
    0,
  );
  db.close();
});

test('an unresolved Pi root keeps replay pending on the unresolved session cursor', () => {
  const home = makeTempDir('obelisk-pi-unresolved-marker-');
  const piDir = join(home, 'pi-sessions');
  const sessionPath = writeFixture(piDir);
  const options = indexOptions(home, piDir);

  buildIndex(options);
  let db = new TestDatabase(options.dbPath);
  db.prepare("UPDATE messages SET text='stale unresolved projection' WHERE source='pi'").run();
  db.prepare('DELETE FROM index_state WHERE jsonl_path=?').run(PI_CANONICAL_TRANSCRIPT_MARKER);
  db.close();

  const unresolvedProvider = createPiProvider({ rootDir: 'relative-session-root' });
  assert.equal(unresolvedProvider.rootResolution.requiresExplicitRoot, true);
  const unresolved = buildIndex({
    ...options,
    providerRegistry: createProviderRegistry([unresolvedProvider]),
  });
  assert.equal(unresolved.files, 0);

  db = new TestDatabase(options.dbPath);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM index_state WHERE jsonl_path=?')
      .get(PI_CANONICAL_TRANSCRIPT_MARKER).c,
    1,
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM index_state WHERE jsonl_path=?')
      .get(sessionPath).c,
    0,
  );
  assert.ok(
    db.prepare("SELECT COUNT(*) AS c FROM messages WHERE text='stale unresolved projection'").get().c > 0,
  );
  db.close();

  const replay = buildIndex(options);
  assert.equal(replay.files, 1);
  db = new TestDatabase(options.dbPath);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM index_state WHERE jsonl_path=?')
      .get(PI_CANONICAL_TRANSCRIPT_MARKER).c,
    1,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM messages WHERE text='stale unresolved projection'").get().c,
    0,
  );
  db.close();
});

test('Pi identity marker retracts a legacy id through a non-selected identical copy', () => {
  const home = makeTempDir('obelisk-pi-identity-marker-');
  const piDir = join(home, 'pi-sessions');
  const selectedPath = writeFixture(piDir);
  const copiedPath = join(piDir, 'z-copy', 'session.jsonl');
  mkdirSync(dirname(copiedPath), { recursive: true });
  writeFileSync(copiedPath, readFileSync(TOOL_FIXTURE));
  const options = indexOptions(home, piDir);
  const sourceHeader = JSON.parse(readFileSync(TOOL_FIXTURE, 'utf8').split('\n')[0]);
  const legacyId = `pi:${sourceHeader.id}`;
  const currentId = piSessionId(sourceHeader);

  buildIndex(options);
  let db = new TestDatabase(options.dbPath);
  db.prepare("UPDATE sessions SET id=?, jsonl_path=? WHERE source='pi'").run(legacyId, copiedPath);
  for (const table of ['messages', 'tool_calls', 'tool_results', 'summaries']) {
    db.prepare(`UPDATE ${table} SET session_id=? WHERE session_id=?`).run(legacyId, currentId);
  }
  db.prepare('UPDATE index_state SET jsonl_path=? WHERE jsonl_path=?').run(copiedPath, selectedPath);
  db.prepare('DELETE FROM index_state WHERE jsonl_path=?').run(PI_CANONICAL_TRANSCRIPT_MARKER);
  db.close();

  const replay = buildIndex(options);
  assert.deepEqual(new Set(replay.affectedSessionIds), new Set([legacyId, currentId]));
  db = new TestDatabase(options.dbPath);
  assert.deepEqual(
    db.prepare("SELECT id,jsonl_path FROM sessions WHERE source='pi'").all().map(row => ({ ...row })),
    [{ id: currentId, jsonl_path: selectedPath }],
  );
  db.close();
});

test('app replay keeps Pi identity stable across migration and retracts replacement and unlink', () => {
  const home = makeTempDir('obelisk-pi-provenance-');
  const piDir = join(home, 'pi-sessions');
  const sessionPath = writeFixture(piDir);
  const options = indexOptions(home, piDir);
  const original = readFileSync(sessionPath, 'utf8');
  const records = original.trimEnd().split('\n').map(line => JSON.parse(line));

  buildIndex(options);
  const stableId = piSessionId(records[0]);

  records[0].version = 2;
  writeFileSync(sessionPath, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  buildIndex({ ...options, changedPaths: [sessionPath] });
  let db = new TestDatabase(options.dbPath);
  assert.deepEqual(
    db.prepare("SELECT id FROM sessions WHERE source='pi'").all().map(row => row.id),
    [stableId],
  );
  db.close();

  records[0].version = 3;
  records[0].id = 'replacement-session';
  const replacementId = piSessionId(records[0]);
  writeFileSync(sessionPath, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const replacement = buildIndex({ ...options, changedPaths: [sessionPath] });
  assert.deepEqual(
    new Set(replacement.affectedSessionIds),
    new Set([stableId, replacementId]),
  );
  db = new TestDatabase(options.dbPath);
  assert.deepEqual(
    db.prepare("SELECT id FROM sessions WHERE source='pi'").all().map(row => row.id),
    [replacementId],
  );
  db.close();

  unlinkSync(sessionPath);
  const removed = buildIndex({ ...options, changedPaths: [sessionPath] });
  assert.deepEqual(removed.affectedSessionIds, [replacementId]);
  db = new TestDatabase(options.dbPath);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE source='pi'").get().c, 0);
  assert.equal(
    db.prepare('SELECT mtime FROM index_state WHERE jsonl_path=?').get(sessionPath).mtime,
    0,
  );
  db.close();
});

test('a failed Pi identity replacement preserves the prior session snapshot', () => {
  const home = makeTempDir('obelisk-pi-replacement-rollback-');
  const piDir = join(home, 'pi-sessions');
  const sessionPath = writeFixture(piDir);
  const options = indexOptions(home, piDir);
  const header = JSON.parse(readFileSync(TOOL_FIXTURE, 'utf8').split('\n')[0]);
  const priorId = piSessionId(header);

  assert.equal(buildIndex(options).complete, true);
  writeFileSync(sessionPath, [
    JSON.stringify({ ...header, id: 'invalid-replacement' }),
    invalidMessageLine(),
    '',
  ].join('\n'));

  assert.throws(
    () => buildIndex({ ...options, changedPaths: [sessionPath] }),
    /Malformed Pi message at line 2/,
  );

  const db = new TestDatabase(options.dbPath);
  assert.deepEqual(
    db.prepare("SELECT id,message_count FROM sessions WHERE source='pi'").all().map(row => ({ ...row })),
    [{ id: priorId, message_count: 4 }],
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages WHERE session_id=?').get(priorId).c, 4);
  db.close();
});

test('passive Pi inventory retracts deleted sessions when its configured root remains readable', () => {
  const home = makeTempDir('obelisk-pi-passive-delete-');
  const piDir = join(home, 'pi-sessions');
  const sessionPath = writeFixture(piDir);
  const options = indexOptions(home, piDir);

  buildIndex(options);
  unlinkSync(sessionPath);
  const removed = buildIndex(options);

  assert.equal(removed.files, 1);
  const db = new TestDatabase(options.dbPath);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE source='pi'").get().c, 0);
  db.close();
});

test('a terminal malformed line follows Pi by publishing the valid replacement prefix', () => {
  const home = makeTempDir('obelisk-pi-torn-replacement-');
  const piDir = join(home, 'pi-sessions');
  const sessionPath = writeFixture(piDir);
  const options = indexOptions(home, piDir);
  const records = readFileSync(TOOL_FIXTURE, 'utf8')
    .trimEnd()
    .split('\n')
    .map(line => JSON.parse(line));
  const oldId = piSessionId(records[0]);

  buildIndex(options);
  let db = new TestDatabase(options.dbPath);
  assert.equal(
    db.prepare("SELECT id FROM sessions WHERE source='pi'").get().id,
    oldId,
  );
  const committedCursor = db.prepare(
    'SELECT cursor FROM index_state WHERE jsonl_path=?',
  ).get(sessionPath).cursor;
  db.close();

  const replacementHeader = { ...records[0], id: 'torn-replacement' };
  const replacementId = piSessionId(replacementHeader);
  writeFileSync(sessionPath, `${JSON.stringify(replacementHeader)}\n{"type":"message"`);
  const prefix = buildIndex({ ...options, changedPaths: [sessionPath] });
  assert.deepEqual(
    new Set(prefix.affectedSessionIds),
    new Set([oldId, replacementId]),
  );

  db = new TestDatabase(options.dbPath);
  assert.deepEqual(
    db.prepare("SELECT id,message_count FROM sessions WHERE source='pi'").all().map(row => ({ ...row })),
    [{ id: replacementId, message_count: 0 }],
  );
  assert.notEqual(
    db.prepare('SELECT cursor FROM index_state WHERE jsonl_path=?').get(sessionPath).cursor,
    committedCursor,
  );
  db.close();

  records[0] = replacementHeader;
  writeFileSync(sessionPath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
  const completed = buildIndex({ ...options, changedPaths: [sessionPath] });
  assert.deepEqual(completed.affectedSessionIds, [replacementId]);
  db = new TestDatabase(options.dbPath);
  assert.deepEqual(
    db.prepare("SELECT id,message_count FROM sessions WHERE source='pi'").all().map(row => ({ ...row })),
    [{ id: replacementId, message_count: 4 }],
  );
  db.close();
});
