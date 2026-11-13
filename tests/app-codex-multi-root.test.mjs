// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { codexRootScope } from '../packages/core/src/providers/codex.ts';
import { createConfiguredBuiltinProviderRuntime } from '../packages/core/src/provider-settings.ts';
import { buildIndex as buildAppIndex } from '../app/src/main/indexer.ts';
import { makeTempDir } from './temp-dirs.mjs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const REAL_FIXTURE = new URL('./fixtures/codex/real-rollout-structural-sanitized.jsonl', import.meta.url);

class TestDatabase {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
  }

  get inTransaction() {
    return this.db.isTransaction;
  }

  pragma(statement) {
    this.db.exec(`PRAGMA ${statement}`);
  }

  exec(sql) {
    return this.db.exec(sql);
  }

  prepare(sql) {
    return this.db.prepare(sql);
  }

  close() {
    return this.db.close();
  }
}

function dumpCodexState(db) {
  const q = (sql) => db.prepare(sql).all();
  return {
    sessions: q("SELECT id, title, project, started_at, ended_at, git_branch, version, message_count, jsonl_path, source FROM sessions WHERE source='codex' ORDER BY id"),
    messages: q("SELECT uuid, session_id, type, parent_uuid, timestamp, role, text, content_type, is_meta, visibility, model, is_sidechain, agent_id, input_tokens, output_tokens, turn_duration_ms, cwd, skill, source FROM messages WHERE source='codex' ORDER BY uuid"),
    toolCalls: q("SELECT id, message_uuid, session_id, name, presentation, input_json, file_path FROM tool_calls WHERE session_id LIKE 'codex:%' ORDER BY id"),
    toolResults: q("SELECT tool_use_id, message_uuid, session_id, content, file_path, is_error FROM tool_results WHERE session_id LIKE 'codex:%' ORDER BY tool_use_id"),
    subagents: q("SELECT agent_id, session_id, parent_tool_use_id, agent_type, description, duration_ms, total_tokens FROM subagents WHERE session_id LIKE 'codex:%' ORDER BY agent_id"),
  };
}

function writeRollout(rootDir, {
  id = '019ed000-0000-7000-8000-000000000501',
  subdir = join('sessions', '2026', '06', '15'),
  filename = `rollout-2026-06-15T10-00-00-${id}.jsonl`,
  cwd = '/tmp/codex-app-multi-root',
  userText = 'hello from codex',
  assistantText = 'reply from codex',
  callId = 'call_shared_1',
  parentThreadId = null,
} = {}) {
  const dir = join(rootDir, subdir);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, filename);
  const metaPayload = {
    id,
    timestamp: '2026-06-15T10:00:00Z',
    cwd,
    cli_version: '1.0',
    ...(parentThreadId
      ? { source: { subagent: { thread_spawn: { parent_thread_id: parentThreadId, agent_role: 'worker', agent_nickname: 'Helper' } } } }
      : {}),
  };
  const lines = [
    JSON.stringify({ type: 'session_meta', timestamp: '2026-06-15T10:00:00Z', payload: metaPayload }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-06-15T10:00:01Z', payload: { type: 'user_message', message: userText } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-06-15T10:00:02Z', payload: { type: 'agent_message', message: assistantText } }),
    JSON.stringify({ type: 'response_item', timestamp: '2026-06-15T10:00:03Z', payload: { type: 'function_call', call_id: callId, name: 'shell', arguments: '{"cmd":"pwd"}' } }),
    JSON.stringify({ type: 'response_item', timestamp: '2026-06-15T10:00:04Z', payload: { type: 'function_call_output', call_id: callId, output: cwd } }),
  ];
  writeFileSync(target, `${lines.join('\n')}\n`);
  return target;
}

function appBuildForCodex(home, dbPath, { providerSettings = {}, ...options } = {}) {
  const emptyBase = Object.fromEntries(
    createConfiguredBuiltinProviderRuntime({}, { homeDir: home }).registry.catalog()
      .filter((provider) => provider.id !== 'codex')
      .map((provider) => [provider.id, join(home, 'unused', provider.id)]),
  );
  const mergedSettings = {
    ...providerSettings,
    providerRoots: {
      ...emptyBase,
      ...(providerSettings.providerRoots ?? {}),
    },
  };
  return buildAppIndex({
    dbPath,
    claudeDir: join(home, '.claude'),
    providerSettings: mergedSettings,
    DatabaseImpl: TestDatabase,
    ...options,
  });
}

test('App indexer without codexDir honors CODEX_HOME', () => {
  const home = makeTempDir('obelisk-app-codex-env-');
  const envCodex = join(home, 'env-codex');
  const dir = join(envCodex, 'sessions', '2026', '06', '15');
  mkdirSync(dir, { recursive: true });
  const rawId = JSON.parse(readFileSync(REAL_FIXTURE, 'utf8').split('\n')[0]).payload.id;
  const envRollout = join(dir, `rollout-${rawId}.jsonl`);
  copyFileSync(REAL_FIXTURE, envRollout);

  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = envCodex;
  try {
    const dbPath = join(home, 'app-env.sqlite');
    const res = appBuildForCodex(home, dbPath, { providerSettings: {}, force: true });
    assert.equal(res.complete, true);
    const db = new DatabaseSync(dbPath);
    const rows = db.prepare("SELECT id, jsonl_path FROM sessions WHERE source='codex'").all();
    db.close();
    assert.deepEqual(rows.map((r) => r.id), [`codex:${rawId}`]);
    assert.equal(rows[0].jsonl_path, envRollout);
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
  }
});

test('multi-root persisted identities are list-independent and preserve default ~/.codex bare IDs', () => {
  const home = makeTempDir('obelisk-app-codex-list-independent-');
  const defaultRoot = join(home, '.codex');
  const rootA = join(home, 'dir-a', 'store');
  const rootB = join(home, 'dir-b', 'store');

  const idDefault = '019ed000-0000-7000-8000-000000000201';
  const idA = '019ed000-0000-7000-8000-000000000202';
  const idB = '019ed000-0000-7000-8000-000000000203';

  writeRollout(defaultRoot, { id: idDefault, userText: 'default msg' });
  const fileA = writeRollout(rootA, { id: idA, userText: 'store a initial' });
  writeRollout(rootB, { id: idB, userText: 'store b initial' });

  const dbPath = join(home, 'index.sqlite');
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const buildWith = (codexRoots, extra = {}) => appBuildForCodex(home, dbPath, {
      providerSettings: { providerRoots: { codex: codexRoots } },
      ...extra,
    });

    assert.equal(buildWith([rootA]).complete, true);
    const scopeA = codexRootScope(rootA, home);
    const scopeB = codexRootScope(rootB, home);
    assert.ok(scopeA && scopeB && scopeA !== scopeB);
    const expectedIdA = `codex:${scopeA}:${idA}`;
    const expectedIdB = `codex:${scopeB}:${idB}`;

    let db = new DatabaseSync(dbPath);
    assert.deepEqual(
      db.prepare("SELECT id FROM sessions WHERE source='codex' ORDER BY id").all().map((r) => r.id),
      [expectedIdA],
    );
    db.close();

    assert.equal(buildWith([rootB, rootA, defaultRoot]).complete, true);
    appendFileSync(fileA, `${JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-06-15T10:05:00Z',
      payload: { type: 'user_message', message: 'store a appended' },
    })}\n`);
    const nextMtime = statSync(fileA).mtimeMs / 1000 + 5;
    utimesSync(fileA, nextMtime, nextMtime);
    assert.equal(buildWith([rootB, rootA, defaultRoot]).complete, true);

    db = new DatabaseSync(dbPath);
    const sessions = db.prepare("SELECT id, message_count FROM sessions WHERE source='codex' ORDER BY id").all();
    assert.deepEqual(
      sessions.map((s) => s.id).sort(),
      [`codex:${idDefault}`, expectedIdA, expectedIdB].sort(),
    );
    assert.equal(sessions.find((s) => s.id === expectedIdA).message_count, 4);
    const rootAMsgs = db.prepare('SELECT text FROM messages WHERE session_id=? ORDER BY uuid').all(expectedIdA);
    assert.deepEqual(rootAMsgs.map((m) => m.text), ['store a initial', 'reply from codex', null, 'store a appended']);
    db.close();

    assert.equal(buildWith([defaultRoot, rootA], { force: true }).complete, true);
    db = new DatabaseSync(dbPath);
    assert.deepEqual(
      db.prepare("SELECT id FROM sessions WHERE source='codex' ORDER BY id").all().map((r) => r.id).sort(),
      [`codex:${idDefault}`, expectedIdA].sort(),
    );
    db.close();
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
  }
});

test('single-root custom index atomically migrates to multi-root array (with subagents and appends) and back', () => {
  const home = makeTempDir('obelisk-app-codex-migration-');
  const rootA = join(home, 'custom-codex-a');
  const rootB = join(home, 'custom-codex-b');
  const parentId = '019ed000-0000-7000-8000-000000000401';
  const childId = '019ed000-0000-7000-8000-000000000402';

  const parentPath = writeRollout(rootA, { id: parentId, userText: 'initial parent' });
  writeRollout(rootA, {
    id: childId,
    filename: `rollout-${childId}.jsonl`,
    parentThreadId: parentId,
    userText: 'initial child',
  });
  writeRollout(rootB, { id: '019ed000-0000-7000-8000-000000000403', userText: 'root B session' });

  const dbPath = join(home, 'migrate.sqlite');
  assert.equal(appBuildForCodex(home, dbPath, {
    providerSettings: { providerRoots: { codex: rootA } },
  }).complete, true);

  let db = new DatabaseSync(dbPath);
  assert.deepEqual(
    db.prepare("SELECT id FROM sessions WHERE source='codex'").all().map((r) => r.id),
    [`codex:${parentId}`],
  );
  assert.equal(db.prepare('SELECT COUNT(*) c FROM subagents WHERE session_id=?').get(`codex:${parentId}`).c, 1);
  db.close();

  appendFileSync(parentPath, `${JSON.stringify({
    type: 'event_msg',
    timestamp: '2026-06-15T10:10:00Z',
    payload: { type: 'user_message', message: 'appended during migration' },
  })}\n`);
  const nextMtime = statSync(parentPath).mtimeMs / 1000 + 5;
  utimesSync(parentPath, nextMtime, nextMtime);

  assert.equal(appBuildForCodex(home, dbPath, {
    providerSettings: { providerRoots: { codex: [rootA, rootB] } },
  }).complete, true);

  const scopeA = codexRootScope(rootA, home);
  const scopeB = codexRootScope(rootB, home);
  const scopedParentId = `codex:${scopeA}:${parentId}`;
  db = new DatabaseSync(dbPath);
  assert.deepEqual(
    db.prepare("SELECT id FROM sessions WHERE source='codex' ORDER BY id").all().map((r) => r.id).sort(),
    [scopedParentId, `codex:${scopeB}:019ed000-0000-7000-8000-000000000403`].sort(),
  );
  assert.equal(db.prepare('SELECT COUNT(*) c FROM messages WHERE session_id=?').get(`codex:${parentId}`).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM subagents WHERE session_id=?').get(`codex:${parentId}`).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM tool_calls WHERE session_id=?').get(`codex:${parentId}`).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM subagents WHERE session_id=?').get(scopedParentId).c, 1);
  assert.ok(
    db.prepare('SELECT text FROM messages WHERE session_id=?').all(scopedParentId).some((m) => m.text === 'appended during migration'),
  );
  db.close();

  const freshPath = join(home, 'fresh.sqlite');
  assert.equal(appBuildForCodex(home, freshPath, {
    providerSettings: { providerRoots: { codex: [rootA, rootB] } },
    force: true,
  }).complete, true);
  const incDb = new DatabaseSync(dbPath);
  const freshDbHandle = new DatabaseSync(freshPath);
  assert.deepEqual(dumpCodexState(incDb), dumpCodexState(freshDbHandle));
  incDb.close();
  freshDbHandle.close();

  assert.equal(appBuildForCodex(home, dbPath, {
    providerSettings: { providerRoots: { codex: rootA } },
  }).complete, true);
  db = new DatabaseSync(dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sessions WHERE id=?').get(scopedParentId).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sessions WHERE id=?').get(`codex:${parentId}`).c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM subagents WHERE session_id=?').get(`codex:${parentId}`).c, 1);
  db.close();
});

test('unavailable, empty, and removed multi-root retention semantics match contract', () => {
  const home = makeTempDir('obelisk-app-codex-retention-');
  const rootA = join(home, 'codex-a');
  const rootB = join(home, 'codex-b');
  const emptyRoot = join(home, 'codex-empty');
  mkdirSync(emptyRoot, { recursive: true });

  const idA = '019ed000-0000-7000-8000-000000000501';
  const idB = '019ed000-0000-7000-8000-000000000502';
  writeRollout(rootA, { id: idA, userText: 'root A stays' });
  writeRollout(rootB, { id: idB, userText: 'root B session' });

  const dbPath = join(home, 'retention.sqlite');
  const twoRootsAndEmpty = { providerRoots: { codex: [rootA, rootB, emptyRoot] } };

  const initial = appBuildForCodex(home, dbPath, { providerSettings: twoRootsAndEmpty, force: true });
  assert.equal(initial.complete, true);

  const scopeA = codexRootScope(rootA, home);
  const scopeB = codexRootScope(rootB, home);

  rmSync(rootB, { recursive: true, force: true });
  const blocked = appBuildForCodex(home, dbPath, { providerSettings: twoRootsAndEmpty, force: true });
  assert.equal(blocked.complete, false);
  assert.equal(blocked.reason, 'incomplete_snapshot');
  assert.ok(blocked.incompleteProviders.includes('codex'));

  let db = new DatabaseSync(dbPath);
  assert.deepEqual(
    db.prepare("SELECT id FROM sessions WHERE source='codex' ORDER BY id").all().map((r) => r.id).sort(),
    [`codex:${scopeA}:${idA}`, `codex:${scopeB}:${idB}`].sort(),
  );
  db.close();

  writeRollout(rootA, { id: '019ed000-0000-7000-8000-000000000503', userText: 'root A second' });
  const partialRefresh = appBuildForCodex(home, dbPath, { providerSettings: twoRootsAndEmpty, force: false });
  assert.equal(partialRefresh.complete, false);
  assert.ok(partialRefresh.incompleteProviders.includes('codex'));
  db = new DatabaseSync(dbPath);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM sessions WHERE source='codex'").get().c, 3);
  db.close();

  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const lockedRoot = join(home, 'codex-locked');
    mkdirSync(join(lockedRoot, 'sessions'), { recursive: true });
    chmodSync(join(lockedRoot, 'sessions'), 0o000);
    try {
      const eaccesBuild = appBuildForCodex(home, dbPath, {
        providerSettings: { providerRoots: { codex: [rootA, lockedRoot] } },
        force: true,
      });
      assert.equal(eaccesBuild.complete, false);
      assert.ok(eaccesBuild.incompleteProviders.includes('codex'));
    } finally {
      chmodSync(join(lockedRoot, 'sessions'), 0o755);
    }
  }

  const onlyRootA = { providerRoots: { codex: [rootA] } };
  assert.equal(appBuildForCodex(home, dbPath, { providerSettings: onlyRootA, force: false }).complete, true);
  db = new DatabaseSync(dbPath);
  assert.equal(
    db.prepare('SELECT COUNT(*) c FROM sessions WHERE id=?').get(`codex:${scopeB}:${idB}`).c,
    1,
    'ordinary refresh retains cached history for a deliberately removed root',
  );
  db.close();

  assert.equal(appBuildForCodex(home, dbPath, { providerSettings: onlyRootA, force: true }).complete, true);
  db = new DatabaseSync(dbPath);
  assert.deepEqual(
    db.prepare("SELECT id FROM sessions WHERE source='codex' ORDER BY id").all().map((r) => r.id).sort(),
    [`codex:${scopeA}:${idA}`, `codex:${scopeA}:019ed000-0000-7000-8000-000000000503`].sort(),
    'deliberate force rebuild publishes only the explicitly selected root set',
  );
  db.close();
});

test('custom single-root to [defaultRoot, customRoot] migration preserves shared-ID default sessions and custom Claude root parity', () => {
  const home = makeTempDir('obelisk-app-codex-shared-migration-');
  const defaultCodex = join(home, '.codex');
  const customCodex = join(home, 'custom-codex');
  const externalClaude = join(home, 'external-drive', 'my-claude');
  mkdirSync(join(externalClaude, 'projects'), { recursive: true });

  const sharedId = '019ed000-0000-7000-8000-000000000999';
  const defaultFile = writeRollout(defaultCodex, { id: sharedId, userText: 'default copy' });
  const customFile = writeRollout(customCodex, { id: sharedId, userText: 'custom copy' });

  const dbPath = join(home, 'shared-migrate.sqlite');
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const emptyOthers = Object.fromEntries(
      createConfiguredBuiltinProviderRuntime({}, { homeDir: home }).registry.catalog()
        .filter((provider) => provider.id !== 'codex' && provider.id !== 'claude')
        .map((provider) => [provider.id, join(home, 'unused', provider.id)]),
    );
    const runAppBuild = (codexSetting) => buildAppIndex({
      dbPath,
      claudeDir: externalClaude,
      providerSettings: {
        providerRoots: {
          ...emptyOthers,
          claude: externalClaude,
          codex: codexSetting,
        },
      },
      DatabaseImpl: TestDatabase,
    });

    // Step 1: Index custom single root -> bare codex:<sharedId>.
    assert.equal(runAppBuild(customCodex).complete, true);
    let db = new DatabaseSync(dbPath);
    assert.deepEqual(
      db.prepare("SELECT id FROM sessions WHERE source='codex'").all().map((r) => r.id),
      [`codex:${sharedId}`],
    );
    db.close();

    // Step 2: Transition to [defaultCodex, customCodex] (default first!) WITH external custom Claude root.
    // Both default (~/.codex) and customCodex must survive, and main/worker runtime IDs must agree.
    assert.equal(runAppBuild([defaultCodex, customCodex]).complete, true);
    const scopeCustom = codexRootScope(customCodex, home);
    const mainRuntime = createConfiguredBuiltinProviderRuntime({
      providerRoots: { claude: externalClaude, codex: [defaultCodex, customCodex] },
    }, { homeDir: home });
    const mainUnits = mainRuntime.registry.get('codex').discover({ lastCursor: () => null });
    assert.deepEqual(
      mainUnits.map((u) => u.sessionId).sort(),
      [`codex:${sharedId}`, `codex:${scopeCustom}:${sharedId}`].sort(),
    );

    db = new DatabaseSync(dbPath);
    const rows = db.prepare("SELECT id, jsonl_path FROM sessions WHERE source='codex' ORDER BY id").all()
      .map((row) => ({ id: row.id, jsonl_path: row.jsonl_path }));
    assert.deepEqual(rows, [
      { id: `codex:${sharedId}`, jsonl_path: defaultFile },
      { id: `codex:${scopeCustom}:${sharedId}`, jsonl_path: customFile },
    ]);
    const defaultMsgs = db.prepare('SELECT text FROM messages WHERE session_id=?').all(`codex:${sharedId}`);
    const customMsgs = db.prepare('SELECT text FROM messages WHERE session_id=?').all(`codex:${scopeCustom}:${sharedId}`);
    assert.ok(defaultMsgs.some((m) => m.text === 'default copy'));
    assert.ok(!defaultMsgs.some((m) => m.text === 'custom copy'));
    assert.ok(customMsgs.some((m) => m.text === 'custom copy'));
    assert.ok(!customMsgs.some((m) => m.text === 'default copy'));
    db.close();

    // Step 3: Subsequent incremental refresh stays converged with both sessions intact.
    assert.equal(runAppBuild([defaultCodex, customCodex]).complete, true);
    db = new DatabaseSync(dbPath);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM sessions WHERE source='codex'").get().c, 2);
    db.close();
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
  }
});

test('shared-ID scope-migration + bare-reclaim is a single atomic transaction on transient failure', () => {
  const home = makeTempDir('obelisk-app-codex-atomic-migration-');
  const defaultCodex = join(home, '.codex');
  const customCodex = join(home, 'custom-codex');

  const sharedId = '019ed000-0000-7000-8000-000000000998';
  const childId = '019ed000-0000-7000-8000-000000000997';
  writeRollout(defaultCodex, { id: sharedId, userText: 'default parent' });
  writeRollout(defaultCodex, {
    id: childId,
    filename: `rollout-${childId}.jsonl`,
    parentThreadId: sharedId,
    userText: 'default child',
  });
  const customFile = writeRollout(customCodex, { id: sharedId, userText: 'custom parent' });
  writeRollout(customCodex, {
    id: childId,
    filename: `rollout-${childId}.jsonl`,
    parentThreadId: sharedId,
    userText: 'custom child',
  });

  const dbPath = join(home, 'atomic-migrate.sqlite');
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const emptyOthers = Object.fromEntries(
      createConfiguredBuiltinProviderRuntime({}, { homeDir: home }).registry.catalog()
        .filter((provider) => provider.id !== 'codex')
        .map((provider) => [provider.id, join(home, 'unused', provider.id)]),
    );
    const runBuild = (codexSetting) => buildAppIndex({
      dbPath,
      claudeDir: emptyOthers.claude,
      providerSettings: { providerRoots: { ...emptyOthers, codex: codexSetting } },
      DatabaseImpl: TestDatabase,
    });

    // 1. Index defaultCodex first (leaves valid cursor in index_state for defaultCodex),
    //    then switch to single customCodex (replaces bare codex:<sharedId> with customCodex).
    assert.equal(runBuild([defaultCodex]).complete, true);
    assert.equal(runBuild(customCodex).complete, true);

    // 2. Append a malformed completed line to customChildFile so discover() still plans
    //    both parent and child inside the SAME atomicGroup, and parse() throws
    //    CODEX_MALFORMED_LINE_ERROR on the child. Because scope-migration and
    //    bare-reclaim share ONE atomicGroup, the entire transaction rolls back
    //    cleanly without letting defaultCodex commit a partial reclaim.
    const customChildFile = join(customCodex, 'sessions', '2026', '06', '15', `rollout-${childId}.jsonl`);
    const originalChildContent = readFileSync(customChildFile, 'utf8');
    appendFileSync(customChildFile, '{broken-json-line\n');
    const brokenMtime = statSync(customChildFile).mtimeMs / 1000 + 5;
    utimesSync(customChildFile, brokenMtime, brokenMtime);

    const failedMigration = runBuild([defaultCodex, customCodex]);
    assert.equal(failedMigration.complete, false);
    assert.equal(failedMigration.skipped > 0, true);
    let db = new DatabaseSync(dbPath);
    const midRows = db.prepare("SELECT id, jsonl_path FROM sessions WHERE source='codex'").all()
      .map((r) => ({ id: r.id, jsonl_path: r.jsonl_path }));
    assert.deepEqual(midRows, [{ id: `codex:${sharedId}`, jsonl_path: customFile }],
      'rollback preserves the prior customCodex session intact when any member of the migration group fails');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM subagents WHERE session_id=?').get(`codex:${sharedId}`).c, 1);
    db.close();

    // 3. Repair customChildFile and retry incremental refresh -> both defaultCodex (bare)
    //    and customCodex (scoped) converge atomically with both subagent trees intact.
    writeFileSync(customChildFile, originalChildContent);
    const fixedMtime = statSync(customChildFile).mtimeMs / 1000 + 10;
    utimesSync(customChildFile, fixedMtime, fixedMtime);

    assert.equal(runBuild([defaultCodex, customCodex]).complete, true);
    const scopeCustom = codexRootScope(customCodex, home);
    const scopedId = `codex:${scopeCustom}:${sharedId}`;
    db = new DatabaseSync(dbPath);
    const finalRows = db.prepare("SELECT id, jsonl_path FROM sessions WHERE source='codex' ORDER BY id").all()
      .map((r) => ({ id: r.id, jsonl_path: r.jsonl_path }));
    assert.equal(finalRows.length, 2);
    assert.equal(finalRows[0].id, `codex:${sharedId}`);
    assert.equal(finalRows[1].id, scopedId);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM subagents WHERE session_id=?').get(`codex:${sharedId}`).c, 1);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM subagents WHERE session_id=?').get(scopedId).c, 1);
    db.close();

    // 4. Verify BUSY deferral mid-migration: first run throws SQLITE_BUSY on
    //    BEGIN IMMEDIATE for the migration transaction (so retries exhaust and
    //    build returns deferred='database_busy'), then clean retry still finds
    //    and publishes defaultCodex's bare session despite its earlier cursor.
    assert.equal(runBuild(customCodex).complete, true);
    class BusyOnBeginDatabase extends TestDatabase {
      exec(sql) {
        if (sql === 'BEGIN IMMEDIATE') {
          const err = new Error('database is locked');
          err.code = 'SQLITE_BUSY';
          throw err;
        }
        return super.exec(sql);
      }
    }
    const busyRes = buildAppIndex({
      dbPath,
      claudeDir: emptyOthers.claude,
      providerSettings: { providerRoots: { ...emptyOthers, codex: [defaultCodex, customCodex] } },
      DatabaseImpl: BusyOnBeginDatabase,
      LockDatabaseImpl: TestDatabase,
    });
    assert.equal(busyRes.deferred, true);
    assert.equal(busyRes.reason, 'database_busy');
    db = new DatabaseSync(dbPath);
    assert.deepEqual(
      db.prepare("SELECT id, jsonl_path FROM sessions WHERE source='codex'").all()
        .map((r) => ({ id: r.id, jsonl_path: r.jsonl_path })),
      [{ id: `codex:${sharedId}`, jsonl_path: customFile }],
      'SQLITE_BUSY rolls back the entire shared atomicGroup without partial migration',
    );
    db.close();
    assert.equal(runBuild([defaultCodex, customCodex]).complete, true);
    db = new DatabaseSync(dbPath);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM sessions WHERE source='codex'").get().c, 2);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM subagents WHERE session_id=?').get(`codex:${sharedId}`).c, 1);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM subagents WHERE session_id=?').get(scopedId).c, 1);
    db.close();
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
  }
});
