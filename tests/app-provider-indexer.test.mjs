import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildIndex } from '../app/src/main/indexer.ts';
import { createProviderRegistry } from '../packages/core/src/providers/registry.ts';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

class TestDatabase {
  constructor(dbPath) { this.db = new DatabaseSync(dbPath); }
  pragma(statement) { this.db.exec(`PRAGMA ${statement}`); }
  exec(sql) { return this.db.exec(sql); }
  prepare(sql) { return this.db.prepare(sql); }
  close() { return this.db.close(); }
}

test('app indexer persists every provider through one registry-driven loop', () => {
  const home = mkdtempSync(join(tmpdir(), 'obelisk-provider-indexer-'));
  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
  const registry = createProviderRegistry([{
    name: 'alpha',
    descriptor: { id: 'alpha', name: 'Alpha', vendor: 'Test', defaultRoot: '/alpha', color: '#123456' },
    watchRoots: () => [],
    discover(ctx) {
      return ctx.lastCursor('alpha:unit') === '10:1'
        ? []
        : [{ key: 'alpha:unit', sessionId: 'alpha:session', project: '-tmp-alpha' }];
    },
    *parse(unit) {
      yield {
        kind: 'session', id: unit.sessionId, title: 'Alpha session', project: unit.project,
        started_at: '2026-07-20T10:00:00.000Z', ended_at: '2026-07-20T10:01:00.000Z',
        git_branch: null, version: null, message_count: 1, countMode: 'total',
        jsonl_path: unit.key, source: 'alpha',
      };
      yield {
        kind: 'message', uuid: 'alpha:message', session_id: unit.sessionId, type: 'user',
        parent_uuid: null, timestamp: '2026-07-20T10:00:00.000Z', role: 'user',
        text: 'registry tracer bullet', content_type: 'text', is_meta: 0, visibility: 'visible', model: null,
        is_sidechain: 0, agent_id: null, input_tokens: null, output_tokens: null,
        cwd: '/tmp/alpha', skill: null, source: 'alpha',
      };
      return '10:1';
    },
    raw: () => null,
  }]);

  const first = buildIndex({
    providerRegistry: registry,
    providerRoots: { alpha: '/alpha' },
    claudeDir: join(home, 'empty-claude'),
    codexDir: join(home, 'empty-codex'),
    dbPath,
    DatabaseImpl: TestDatabase,
  });
  assert.deepEqual(first.affectedSessionIds, ['alpha:session']);
  assert.equal(first.files, 1);

  const db = new TestDatabase(dbPath);
  assert.deepEqual(
    { ...db.prepare('SELECT id,source,message_count FROM sessions').get() },
    { id: 'alpha:session', source: 'alpha', message_count: 1 },
  );
  db.close();

  const second = buildIndex({
    providerRegistry: registry,
    providerRoots: { alpha: '/alpha' },
    dbPath,
    DatabaseImpl: TestDatabase,
  });
  assert.deepEqual(second.affectedSessionIds, []);
  assert.equal(second.files, 0);
});

test('serialized invalid provider settings stay disabled when the worker rebuilds the registry', () => {
  const home = mkdtempSync(join(tmpdir(), 'obelisk-provider-settings-worker-'));
  const result = buildIndex({
    providerSettings: {
      providerRoots: {
        claude: './claude',
        codex: './codex',
        kimi: './kimi',
      },
    },
    providerRoots: { kimi: join(home, '.kimi-code') },
    claudeDir: join(home, '.claude'),
    codexDir: join(home, '.codex'),
    dbPath: join(home, '.obelisk', 'obelisk.sqlite'),
    DatabaseImpl: TestDatabase,
  });

  assert.equal(result.files, 0);
  assert.equal(result.complete, true);
  assert.deepEqual(result.incompleteProviders, []);
});

test('an invalid provider root cannot erase a previously indexed source snapshot', () => {
  const home = mkdtempSync(join(tmpdir(), 'obelisk-provider-settings-preserve-'));
  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
  const sourcePath = join(home, '.claude', 'projects', 'session.jsonl');
  const registry = createProviderRegistry([{
    name: 'claude',
    descriptor: { id: 'claude', name: 'Claude', vendor: 'Test', defaultRoot: join(home, '.claude'), color: '#123456' },
    watchRoots: () => [],
    discover: (ctx) => ctx.lastCursor(sourcePath) === '10:1'
      ? []
      : [{ key: sourcePath, sessionId: 'claude:preserved' }],
    *parse(unit) {
      yield {
        kind: 'session', id: unit.sessionId, title: 'Preserved', project: null,
        started_at: null, ended_at: null, git_branch: null, version: null,
        message_count: 0, countMode: 'total', jsonl_path: sourcePath, source: 'claude',
      };
      return '10:1';
    },
    raw: () => null,
  }]);

  assert.equal(buildIndex({
    providerRegistry: registry,
    dbPath,
    DatabaseImpl: TestDatabase,
  }).complete, true);

  const result = buildIndex({
    force: true,
    providerSettings: {
      providerRoots: {
        claude: './invalid',
        codex: './invalid',
        kimi: './invalid',
        pi: './invalid',
      },
    },
    claudeDir: join(home, '.claude'),
    codexDir: join(home, '.codex'),
    dbPath,
    DatabaseImpl: TestDatabase,
  });

  assert.equal(result.complete, false);
  assert.equal(result.reason, 'incomplete_snapshot');
  assert.deepEqual(result.incompleteProviders, ['claude']);
  assert.equal(result.inventoryIssues[0].path, sourcePath);
  const db = new TestDatabase(dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE id=?').get('claude:preserved').c, 1);
  db.close();
});

test('an incomplete canonical inventory converges without replaying readable units forever', () => {
  const home = mkdtempSync(join(tmpdir(), 'obelisk-provider-incomplete-replay-'));
  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
  const marker = '__alpha_canonical_v1__';
  let incomplete = true;
  let parseCalls = 0;
  const provider = {
    name: 'alpha',
    descriptor: { id: 'alpha', name: 'Alpha', vendor: 'Test', defaultRoot: '/alpha', color: '#123456' },
    indexVersionMarker: marker,
    watchRoots: () => [],
    discover(ctx) {
      if (incomplete) {
        ctx.reportIncompleteInventory({
          path: '/alpha/locked',
          error: 'EACCES: permission denied',
        });
      }
      return ctx.lastCursor('alpha:unit') === '10:1'
        ? []
        : [{
            key: 'alpha:unit',
            sessionId: 'alpha:session',
          }];
    },
    *parse(unit) {
      parseCalls += 1;
      yield {
        kind: 'session', id: unit.sessionId, title: 'Alpha', project: null,
        started_at: null, ended_at: null, git_branch: null, version: null,
        message_count: 0, countMode: 'total', jsonl_path: unit.key, source: 'alpha',
      };
      return '10:1';
    },
    raw: () => null,
  };
  const options = {
    providerRegistry: createProviderRegistry([provider]),
    dbPath,
    DatabaseImpl: TestDatabase,
  };

  const first = buildIndex(options);
  const second = buildIndex(options);
  assert.equal(first.complete, false);
  assert.equal(second.complete, false);
  assert.deepEqual(first.incompleteProviders, ['alpha']);
  assert.deepEqual(first.inventoryIssues, [{
    provider: 'alpha',
    path: '/alpha/locked',
    error: 'EACCES: permission denied',
  }]);
  assert.equal(first.files, 1);
  assert.equal(second.files, 1);
  assert.equal(parseCalls, 2, 'readable units remain available while certification retries');

  const forced = buildIndex({ ...options, force: true });
  assert.equal(forced.complete, false);
  assert.equal(forced.reason, 'incomplete_snapshot');
  assert.equal(forced.files, 1);
  assert.equal(parseCalls, 2, 'force rejects the whole snapshot before parsing even safe units');

  let db = new TestDatabase(dbPath);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE source='alpha'").get().c, 1);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM index_state WHERE jsonl_path=?').get(marker).c,
    1,
  );
  db.close();

  incomplete = false;
  assert.equal(buildIndex(options).complete, true);
  assert.equal(parseCalls, 2, 'completed units keep their cursors after the partial replay');
  db = new TestDatabase(dbPath);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM index_state WHERE jsonl_path=?').get(marker).c,
    1,
  );
  db.close();
  assert.equal(buildIndex(options).files, 0);
  assert.equal(parseCalls, 2);
});

test('marker replay invalidates provider unit keys that differ from source paths', () => {
  const home = mkdtempSync(join(tmpdir(), 'obelisk-provider-unit-key-replay-'));
  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
  const unitKey = 'alpha:session-unit';
  const sourcePath = '/alpha/session/agents/main/wire.jsonl';
  const marker = '__alpha_canonical_v1__';
  let incomplete = false;
  let parseCalls = 0;
  const provider = {
    name: 'alpha',
    descriptor: { id: 'alpha', name: 'Alpha', vendor: 'Test', defaultRoot: '/alpha', color: '#123456' },
    indexVersionMarker: marker,
    sessionUnitKey: () => unitKey,
    watchRoots: () => [],
    discover(ctx) {
      if (incomplete) {
        ctx.reportIncompleteInventory({ path: '/alpha/locked', error: 'EACCES' });
        return [];
      }
      return ctx.lastCursor(unitKey) === '10:1'
        ? []
        : [{ key: unitKey, sessionId: 'alpha:session' }];
    },
    *parse(unit) {
      parseCalls += 1;
      yield {
        kind: 'session', id: unit.sessionId, title: 'Alpha', project: null,
        started_at: null, ended_at: null, git_branch: null, version: null,
        message_count: 0, countMode: 'total', jsonl_path: sourcePath, source: 'alpha',
      };
      return '10:1';
    },
    raw: () => null,
  };
  const options = {
    providerRegistry: createProviderRegistry([provider]),
    dbPath,
    DatabaseImpl: TestDatabase,
  };

  assert.equal(buildIndex(options).complete, true);
  assert.equal(parseCalls, 1);
  let db = new TestDatabase(dbPath);
  db.prepare('DELETE FROM index_state WHERE jsonl_path=?').run(marker);
  db.close();

  incomplete = true;
  assert.equal(buildIndex(options).complete, false);
  db = new TestDatabase(dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM index_state WHERE jsonl_path=?').get(unitKey).c, 0);
  db.close();

  incomplete = false;
  assert.equal(buildIndex(options).complete, true);
  assert.equal(parseCalls, 2, 'the missing unit retries after an incomplete marker replay');
});

test('a provider can withhold inventory-dependent tombstones from a partial census', () => {
  const home = mkdtempSync(join(tmpdir(), 'obelisk-provider-incomplete-tombstone-'));
  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
  const marker = '__alpha_canonical_v1__';
  let removeSession = false;
  let parseCalls = 0;
  const provider = {
    name: 'alpha',
    descriptor: { id: 'alpha', name: 'Alpha', vendor: 'Test', defaultRoot: '/alpha', color: '#123456' },
    indexVersionMarker: marker,
    watchRoots: () => [],
    discover(ctx) {
      if (removeSession) {
        ctx.reportIncompleteInventory({
          path: '/alpha/locked',
          error: 'EACCES: permission denied',
        });
        return [
          {
            key: 'alpha:readable',
            sessionId: 'alpha:readable-session',
          },
        ];
      }
      return [{
        key: 'alpha:unit',
        sessionId: 'alpha:session',
      }];
    },
    *parse(unit) {
      parseCalls += 1;
      yield {
        kind: 'session', id: unit.sessionId, title: 'Alpha', project: null,
        started_at: null, ended_at: null, git_branch: null, version: null,
        message_count: 0, countMode: 'total', jsonl_path: unit.key, source: 'alpha',
      };
      return '10:1';
    },
    raw: () => null,
  };
  const options = {
    providerRegistry: createProviderRegistry([provider]),
    dbPath,
    DatabaseImpl: TestDatabase,
  };

  assert.equal(buildIndex(options).complete, true);
  assert.equal(parseCalls, 1);

  let db = new TestDatabase(dbPath);
  db.prepare('DELETE FROM index_state WHERE jsonl_path=?').run(marker);
  db.close();

  removeSession = true;
  const incomplete = buildIndex(options);
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.files, 1);
  assert.equal(parseCalls, 2, 'the readable unit committed and the tombstone was filtered before parse');

  db = new TestDatabase(dbPath);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE id='alpha:session'").get().c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE id='alpha:readable-session'").get().c, 1);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM index_state WHERE jsonl_path=?').get(marker).c,
    1,
  );
  db.close();
});

test('force rebuild resets arbitrary provider keys and rewrites arbitrary provider markers', () => {
  const home = mkdtempSync(join(tmpdir(), 'obelisk-provider-force-keys-'));
  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
  const unitKey = '__remote-1__';
  const marker = 'alpha-v1';
  let present = true;
  let parseCalls = 0;
  const provider = {
    name: 'alpha',
    descriptor: { id: 'alpha', name: 'Alpha', vendor: 'Test', defaultRoot: '/alpha', color: '#123456' },
    indexVersionMarker: marker,
    watchRoots: () => [],
    discover(ctx) {
      if (!present || ctx.lastCursor(unitKey) === '10:1') return [];
      return [{ key: unitKey, sessionId: 'alpha:session' }];
    },
    *parse(unit) {
      parseCalls += 1;
      yield {
        kind: 'session', id: unit.sessionId, title: 'Alpha', project: null,
        started_at: null, ended_at: null, git_branch: null, version: null,
        message_count: 0, countMode: 'total', jsonl_path: unit.key, source: 'alpha',
      };
      return '10:1';
    },
    raw: () => null,
  };
  const options = {
    providerRegistry: createProviderRegistry([provider]),
    dbPath,
    DatabaseImpl: TestDatabase,
  };

  assert.equal(buildIndex(options).complete, true);
  present = false;
  assert.equal(buildIndex({ ...options, force: true }).complete, true);
  let db = new TestDatabase(dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM index_state WHERE jsonl_path=?').get(unitKey).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM index_state WHERE jsonl_path=?').get(marker).c, 1);
  db.close();

  present = true;
  assert.equal(buildIndex(options).complete, true);
  db = new TestDatabase(dbPath);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE source='alpha'").get().c, 1);
  db.close();
  assert.equal(parseCalls, 2);
});

test('force rebuild keeps legacy providers without inventory certification compatible', () => {
  const home = mkdtempSync(join(tmpdir(), 'obelisk-provider-force-certification-'));
  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
  const unitKey = 'alpha:unit';
  const marker = 'alpha-marker';
  const provider = {
    name: 'alpha',
    descriptor: { id: 'alpha', name: 'Alpha', vendor: 'Test', defaultRoot: '/alpha', color: '#123456' },
    indexVersionMarker: marker,
    watchRoots: () => [],
    discover(ctx) {
      return ctx.lastCursor(unitKey) === '10:1'
        ? []
        : [{ key: unitKey, sessionId: 'alpha:session' }];
    },
    *parse(unit) {
      yield {
        kind: 'session', id: unit.sessionId, title: 'Last good Alpha', project: null,
        started_at: null, ended_at: null, git_branch: null, version: null,
        message_count: 0, countMode: 'total', jsonl_path: unit.key, source: 'alpha',
      };
      return '10:1';
    },
    raw: () => null,
  };
  const options = {
    providerRegistry: createProviderRegistry([provider]),
    dbPath,
    DatabaseImpl: TestDatabase,
  };
  assert.equal(buildIndex(options).complete, true);

  const forced = buildIndex({ ...options, force: true });
  assert.equal(forced.complete, true);
  assert.deepEqual(forced.incompleteProviders, []);

  const afterDb = new TestDatabase(dbPath);
  assert.deepEqual(
    { ...afterDb.prepare("SELECT id,title,source FROM sessions WHERE source='alpha'").get() },
    { id: 'alpha:session', title: 'Last good Alpha', source: 'alpha' },
  );
  assert.equal(afterDb.prepare('SELECT COUNT(*) AS c FROM index_state WHERE jsonl_path=?').get(unitKey).c, 1);
  assert.equal(afterDb.prepare('SELECT COUNT(*) AS c FROM index_state WHERE jsonl_path=?').get(marker).c, 1);
  afterDb.close();
});
