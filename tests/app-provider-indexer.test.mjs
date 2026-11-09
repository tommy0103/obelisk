// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { storedProviderCursor } from '../packages/core/src/provider-indexing.ts';
import { buildIndex } from '../app/src/main/indexer.ts';
import { createConfiguredBuiltinProviderRuntime } from '../packages/core/src/provider-settings.ts';
import { defaultCopilotUserDataRoots } from '../packages/core/src/providers/copilot.ts';
import { createProviderRegistry } from '../packages/core/src/providers/registry.ts';
import { makeTempDir } from './temp-dirs.mjs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

class TestDatabase {
  constructor(dbPath) { this.db = new DatabaseSync(dbPath); }
  pragma(statement) { this.db.exec(`PRAGMA ${statement}`); }
  exec(sql) { return this.db.exec(sql); }
  prepare(sql) { return this.db.prepare(sql); }
  close() { return this.db.close(); }
}

test('desktop worker indexes Insiders-only Copilot history by default and respects explicit roots', () => {
  const base = makeTempDir('obelisk-copilot-worker-');
  const envKeys = ['APPDATA', 'XDG_CONFIG_HOME', 'HOME', 'USERPROFILE'];
  const previousEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  try {
    for (const key of envKeys) process.env[key] = base;
    const [stable, insiders] = defaultCopilotUserDataRoots();
    const project = join(base, 'project');
    mkdirSync(project, { recursive: true });
    const transcript = readFileSync(new URL('./fixtures/copilot/transcript-v1.jsonl', import.meta.url), 'utf8');
    const sourceId = JSON.parse(transcript.split('\n', 1)[0]).data.sessionId;
    const writeTranscript = (root, workspaceId, sessionId) => {
      const workspace = join(root, 'workspaceStorage', workspaceId);
      const transcripts = join(workspace, 'GitHub.copilot-chat', 'transcripts');
      mkdirSync(transcripts, { recursive: true });
      writeFileSync(join(workspace, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(project).href }));
      writeFileSync(join(transcripts, `${sessionId}.jsonl`), transcript.replaceAll(sourceId, sessionId));
    };
    writeTranscript(insiders, 'insiders-workspace', '44444444-4444-4444-8444-444444444444');
    const claudeDir = join(base, '.claude');
    const codexDir = join(base, '.codex');
    const dbPath = join(base, '.obelisk', 'obelisk.sqlite');
    const mainRuntime = createConfiguredBuiltinProviderRuntime({}, {
      baseRoots: { claude: claudeDir, codex: codexDir },
    });
    const options = {
      providerSettings: {}, providerRoots: mainRuntime.roots,
      claudeDir, codexDir, dbPath, DatabaseImpl: TestDatabase,
    };
    assert.equal(mainRuntime.roots.copilot, stable);
    buildIndex(options);
    const countSessions = path => {
      const db = new DatabaseSync(path);
      try { return db.prepare("SELECT COUNT(*) AS total FROM sessions WHERE source = 'copilot'").get().total; }
      finally { db.close(); }
    };
    assert.equal(countSessions(dbPath), 1, 'default desktop indexing finds Insiders-only sessions');

    writeTranscript(stable, 'stable-workspace', '11111111-1111-4111-8111-111111111111');
    buildIndex(options);
    assert.equal(countSessions(dbPath), 2, 'default desktop indexing keeps both editions');

    const explicitSettings = { providerRoots: { copilot: insiders } };
    const explicitRuntime = createConfiguredBuiltinProviderRuntime(explicitSettings, {
      baseRoots: { claude: claudeDir, codex: codexDir },
    });
    buildIndex({ ...options, providerSettings: explicitSettings, providerRoots: explicitRuntime.roots });
    assert.equal(countSessions(dbPath), 2, 'turning off a Copilot directory retains its indexed history');
    const insidersOnly = { copilotEditions: { stable: false } };
    const insidersRuntime = createConfiguredBuiltinProviderRuntime(insidersOnly, {
      baseRoots: { claude: claudeDir, codex: codexDir },
    });
    assert.equal(insidersRuntime.registry.watchTargets(insidersRuntime.roots).some((target) => target.path.startsWith(stable)), false);
    assert.equal(insidersRuntime.registry.watchTargets(insidersRuntime.roots).some((target) => target.path.startsWith(insiders)), true);
    const selectedDbPath = join(base, 'selected', 'obelisk.sqlite');
    buildIndex({ ...options, providerSettings: insidersOnly, providerRoots: insidersRuntime.roots, dbPath: selectedDbPath });
    assert.equal(countSessions(selectedDbPath), 1, 'only enabled Copilot directories are indexed');
    const disabledSettings = { copilotEditions: { stable: false, insiders: false } };
    const disabledRuntime = createConfiguredBuiltinProviderRuntime(disabledSettings, {
      baseRoots: { claude: claudeDir, codex: codexDir },
    });
    assert.equal(disabledRuntime.registry.watchTargets(disabledRuntime.roots).some((target) => target.path.includes('copilot-chat')), false);
    buildIndex({ ...options, providerSettings: disabledSettings, providerRoots: disabledRuntime.roots, dbPath: selectedDbPath });
    assert.equal(countSessions(selectedDbPath), 1, 'disabling both directories retains indexed history');
    buildIndex({ ...options, providerSettings: disabledSettings, providerRoots: disabledRuntime.roots, dbPath: selectedDbPath, force: true });
    assert.equal(countSessions(selectedDbPath), 0, 'full rebuild only includes enabled Copilot directories');
    const explicitDbPath = join(base, 'explicit', 'obelisk.sqlite');
    buildIndex({ ...options, providerSettings: explicitSettings, providerRoots: explicitRuntime.roots, dbPath: explicitDbPath });
    assert.equal(countSessions(explicitDbPath), 1, 'explicit root indexes only the selected edition');

    writeTranscript(insiders, 'new-insiders-workspace', '22222222-2222-4222-8222-222222222222');
    const restartedRuntime = createConfiguredBuiltinProviderRuntime(explicitSettings, {
      baseRoots: { claude: claudeDir, codex: codexDir },
    });
    buildIndex({ ...options, providerSettings: explicitSettings, providerRoots: restartedRuntime.roots, dbPath: explicitDbPath });
    assert.equal(countSessions(explicitDbPath), 2, 'explicit root remains single-root after refresh and restart');
  } finally {
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    rmSync(base, { recursive: true, force: true });
  }
});

test('app indexer persists every provider through one registry-driven loop', () => {
  const home = makeTempDir('obelisk-provider-indexer-');
  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
  const registry = createProviderRegistry([{
    name: 'alpha',
    descriptor: { id: 'alpha', name: 'Alpha', vendor: 'Test', defaultRoot: '/alpha', color: '#123456' },
    watchTargets: () => [],
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
  const home = makeTempDir('obelisk-provider-settings-worker-');
  const result = buildIndex({
    providerSettings: {
      providerRoots: {
        claude: './claude',
        codex: './codex',
        kimi: './kimi',
        copilot: join(home, 'empty-copilot'),
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
  const home = makeTempDir('obelisk-provider-settings-preserve-');
  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
  const sourcePath = join(home, '.claude', 'projects', 'session.jsonl');
  const registry = createProviderRegistry([{
    name: 'claude',
    descriptor: { id: 'claude', name: 'Claude', vendor: 'Test', defaultRoot: join(home, '.claude'), color: '#123456' },
    watchTargets: () => [],
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
        copilot: join(home, 'empty-copilot'),
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
  const home = makeTempDir('obelisk-provider-incomplete-replay-');
  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
  const marker = '__alpha_canonical_v1__';
  let incomplete = true;
  let parseCalls = 0;
  const provider = {
    name: 'alpha',
    descriptor: { id: 'alpha', name: 'Alpha', vendor: 'Test', defaultRoot: '/alpha', color: '#123456' },
    indexVersionMarker: marker,
    watchTargets: () => [],
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
  const home = makeTempDir('obelisk-provider-unit-key-replay-');
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
    watchTargets: () => [],
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
  assert.equal(storedProviderCursor(db, unitKey), null, 'the old checkpoint cannot resume projection');
  assert.equal(db.prepare('SELECT replay_required FROM index_state WHERE jsonl_path=?').get(unitKey).replay_required, 1);
  assert.equal(db.prepare('SELECT cursor FROM index_state WHERE jsonl_path=?').get(unitKey).cursor, '10:1', 'historical identity evidence survives invalidation');
  db.close();

  incomplete = false;
  assert.equal(buildIndex(options).complete, true);
  assert.equal(parseCalls, 2, 'the missing unit retries after an incomplete marker replay');
});

test('a provider can withhold inventory-dependent tombstones from a partial census', () => {
  const home = makeTempDir('obelisk-provider-incomplete-tombstone-');
  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
  const marker = '__alpha_canonical_v1__';
  let removeSession = false;
  let parseCalls = 0;
  const provider = {
    name: 'alpha',
    descriptor: { id: 'alpha', name: 'Alpha', vendor: 'Test', defaultRoot: '/alpha', color: '#123456' },
    indexVersionMarker: marker,
    watchTargets: () => [],
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
  const home = makeTempDir('obelisk-provider-force-keys-');
  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
  const unitKey = '__remote-1__';
  const marker = 'alpha-v1';
  let present = true;
  let parseCalls = 0;
  const provider = {
    name: 'alpha',
    descriptor: { id: 'alpha', name: 'Alpha', vendor: 'Test', defaultRoot: '/alpha', color: '#123456' },
    indexVersionMarker: marker,
    watchTargets: () => [],
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
  const home = makeTempDir('obelisk-provider-force-certification-');
  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
  const unitKey = 'alpha:unit';
  const marker = 'alpha-marker';
  const provider = {
    name: 'alpha',
    descriptor: { id: 'alpha', name: 'Alpha', vendor: 'Test', defaultRoot: '/alpha', color: '#123456' },
    indexVersionMarker: marker,
    watchTargets: () => [],
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

test('desktop worker exposes transient provider reads to the existing inventory retry path', async () => {
  const { RetryableSourceReadError } = await import('../packages/core/src/providers/source-read-error.ts');
  class TransactionDatabase extends TestDatabase { get inTransaction() { return this.db.isTransaction; } }
  const home = makeTempDir('obelisk-provider-read-retry-'); let unstable = true;
  const registry = createProviderRegistry([{
    name: 'alpha', descriptor: { id: 'alpha', name: 'Alpha', vendor: 'Test', defaultRoot: home, color: '#123456' },
    watchTargets: () => [], raw: () => null,
    discover: ctx => ctx.lastCursor('alpha:unit') ? [] : [{ key: 'alpha:unit', sessionId: 'alpha:session' }],
    *parse(unit) {
      if (unstable) throw new RetryableSourceReadError(home, 'source changed before parse');
      yield { kind: 'session', id: unit.sessionId, title: 'recovered', project: null, started_at: null, ended_at: null, git_branch: null, version: null, message_count: 0, countMode: 'total', jsonl_path: unit.key, source: 'alpha' };
      return '10:0';
    },
  }]);
  const options = { providerRegistry: registry, providerRoots: { alpha: home },
    claudeDir: join(home, 'empty-claude'), codexDir: join(home, 'empty-codex'),
    dbPath: join(home, 'index.sqlite'), DatabaseImpl: TransactionDatabase };
  const failed = buildIndex(options);
  assert.equal(failed.complete, false);
  assert.deepEqual(failed.inventoryIssues, [{ provider: 'alpha', path: home, error: 'source changed before parse' }]);
  unstable = false;
  const retry = buildIndex(options);
  assert.equal(retry.complete, true); assert.deepEqual(retry.inventoryIssues, []);
  assert.equal(buildIndex(options).files, 0);
});

function atomicProvider(name = 'atomic') {
  const state = { version: 0, fail: false, busy: false, retain: false, calls: [] };
  const provider = {
    name,
    descriptor: { id: name, name: 'Atomic', vendor: 'Test', defaultRoot: '/atomic', color: '#123456' },
    indexVersionMarker: '__atomic_v2__', watchTargets: () => [], raw: () => null,
    discover(ctx) {
      if (state.retain) ctx.retainSession(`${name}:a`);
      return ['a', 'healthy', 'b'].map(id => ({
        key: `${name}:${id}`, sessionId: `${name}:${id}`,
        ...(id === 'healthy' ? {} : { atomicGroup: 'transfer' }),
      })).filter(unit => ctx.lastCursor(unit.key) !== `${10 + state.version}:${state.version + 1}`);
    },
    *parse(unit, cursor) {
      state.calls.push(unit.sessionId);
      yield { kind: 'session', id: unit.sessionId, title: `v${state.version}`, project: null,
        started_at: null, ended_at: null, git_branch: null, version: null,
        message_count: cursor === null ? state.version + 1 : 1, countMode: cursor === null ? 'total' : 'delta',
        jsonl_path: unit.key, source: name };
      for (let version = cursor === null ? 0 : state.version; version <= state.version; version++) {
        yield { kind: 'message', uuid: `${unit.sessionId}:${version}`, session_id: unit.sessionId, type: 'user',
          parent_uuid: null, timestamp: null, role: 'user', text: `v${version}`, content_type: 'text',
          is_meta: 0, visibility: 'visible', model: null, is_sidechain: 0, agent_id: null,
          input_tokens: null, output_tokens: null, cwd: null, skill: null, source: name };
      }
      if (unit.sessionId === `${name}:b` && state.busy) {
        state.busy = false;
        throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      }
      if (unit.sessionId === `${name}:b` && state.fail) throw new Error('receiver failed after writing');
      return `${10 + state.version}:${state.version + 1}`;
    },
  };
  return { state, provider };
}

for (const replay of [false, true]) {
  test(`a failed publication group rolls back every member and keeps unrelated progress (${replay ? 'marker replay' : 'incremental'})`, () => {
    const home = makeTempDir('obelisk-atomic-rollback-');
    const dbPath = join(home, 'index.sqlite');
    const { state, provider } = atomicProvider();
    const options = { dbPath, providerRegistry: createProviderRegistry([provider]) };
    const seed = replay ? { ...options, providerRegistry: createProviderRegistry([{ ...provider, indexVersionMarker: '__atomic_v1__' }]) } : options;
    assert.equal(buildIndex(seed).complete, true);
    state.version = 1;
    state.fail = true;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = buildIndex(options);
      assert.equal(result.complete, false);
      assert.deepEqual(result.affectedSessionIds, attempt === 0 ? ['atomic:healthy'] : []);
      const db = new DatabaseSync(dbPath);
      for (const id of ['a', 'b']) {
        assert.equal(db.prepare('SELECT message_count FROM sessions WHERE id=?').get(`atomic:${id}`).message_count, 1);
        assert.equal(db.prepare('SELECT count(*) n FROM messages WHERE session_id=?').get(`atomic:${id}`).n, 1);
        const row = db.prepare('SELECT cursor,replay_required FROM index_state WHERE jsonl_path=?').get(`atomic:${id}`);
        assert.equal(row.cursor, '10:1');
        assert.equal(row.replay_required, 1);
      }
      assert.equal(db.prepare("SELECT message_count FROM sessions WHERE id='atomic:healthy'").get().message_count, 2);
      db.close();
    }
    state.fail = false;
    const recovered = buildIndex(options);
    assert.equal(recovered.complete, true);
    assert.deepEqual(recovered.affectedSessionIds, ['atomic:a', 'atomic:b']);
    const db = new DatabaseSync(dbPath);
    assert.equal(db.prepare('SELECT count(*) n FROM index_state WHERE replay_required=1').get().n, 0);
    assert.ok(db.prepare('SELECT message_count FROM sessions').all().every(row => row.message_count === 2));
    db.close();
  });
}

test('a transient BUSY retries the whole publication group without double counting', () => {
  const home = makeTempDir('obelisk-atomic-retry-');
  const dbPath = join(home, 'index.sqlite');
  const { state, provider } = atomicProvider();
  const options = { dbPath, providerRegistry: createProviderRegistry([provider]) };
  assert.equal(buildIndex(options).complete, true);
  state.version = 1;
  state.busy = true;
  state.calls.length = 0;
  const result = buildIndex(options);
  assert.equal(result.complete, true);
  assert.deepEqual(state.calls, ['atomic:a', 'atomic:b', 'atomic:a', 'atomic:b', 'atomic:healthy']);
  assert.deepEqual(result.affectedSessionIds, ['atomic:a', 'atomic:b', 'atomic:healthy']);
  const db = new DatabaseSync(dbPath);
  assert.ok(db.prepare('SELECT message_count FROM sessions').all().every(row => row.message_count === 2));
  assert.equal(db.prepare('SELECT count(*) n FROM messages').get().n, 6);
  db.close();
});

test('retaining one member preserves its entire publication group in a force snapshot', () => {
  const home = makeTempDir('obelisk-atomic-retained-');
  const dbPath = join(home, 'index.sqlite');
  const { state, provider } = atomicProvider();
  const options = { dbPath, providerRegistry: createProviderRegistry([provider]) };
  assert.equal(buildIndex(options).complete, true);
  state.version = 1;
  state.retain = true;
  state.calls.length = 0;
  const result = buildIndex({ ...options, force: true });
  assert.equal(result.complete, true);
  assert.deepEqual(state.calls, ['atomic:healthy']);
  const db = new DatabaseSync(dbPath);
  assert.deepEqual(db.prepare('SELECT id,message_count FROM sessions ORDER BY id').all().map(row => [row.id,row.message_count]),
    [['atomic:a',1],['atomic:b',1],['atomic:healthy',2]]);
  db.close();
});


test('identical publication group keys remain isolated across providers', () => {
  const home = makeTempDir('obelisk-atomic-provider-scope-');
  const dbPath = join(home, 'index.sqlite');
  const alpha = atomicProvider('alpha');
  const beta = atomicProvider('beta');
  const options = { dbPath, providerRegistry: createProviderRegistry([alpha.provider, beta.provider]) };
  assert.equal(buildIndex(options).complete, true);
  alpha.state.version = beta.state.version = 1;
  alpha.state.fail = true;
  const result = buildIndex(options);
  assert.equal(result.complete, false);
  assert.ok(result.affectedSessionIds.includes('beta:a') && result.affectedSessionIds.includes('beta:b'));
  assert.ok(!result.affectedSessionIds.includes('alpha:a') && !result.affectedSessionIds.includes('alpha:b'));
  const db = new DatabaseSync(dbPath);
  assert.equal(db.prepare("SELECT message_count FROM sessions WHERE id='alpha:a'").get().message_count, 1);
  assert.equal(db.prepare("SELECT message_count FROM sessions WHERE id='beta:a'").get().message_count, 2);
  db.close();
});
