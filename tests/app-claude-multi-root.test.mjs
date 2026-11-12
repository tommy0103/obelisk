// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Desktop worker / App indexer / Watcher integration tests for explicitly configured Claude roots.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createConfiguredBuiltinProviderRuntime } from '../packages/core/src/provider-settings.ts';
import {
  CLAUDE_CANONICAL_TRANSCRIPT_MARKER,
  canonicalSessionId,
  rootTagFor,
} from '../packages/core/src/providers/claude.ts';
import { buildIndex } from '../app/src/main/indexer.ts';
import { createIndexerService } from '../app/src/main/indexer-service.ts';
import { makeTempDir } from './temp-dirs.mjs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');

class TestDatabase {
  constructor(dbPath) { this.db = new DatabaseSync(dbPath); }
  pragma(statement) { this.db.exec(`PRAGMA ${statement}`); }
  exec(sql) { return this.db.exec(sql); }
  prepare(sql) { return this.db.prepare(sql); }
  close() { return this.db.close(); }
}

const REAL_FIXTURE_TEXT = readFileSync(new URL('./fixtures/claude/custom-title-session.jsonl', import.meta.url), 'utf8');
const REAL_FIXTURE_USER = REAL_FIXTURE_TEXT.trim().split('\n').map(JSON.parse).find((r) => r.type === 'user');
const REAL_SID = REAL_FIXTURE_USER.sessionId;
const REAL_SLUG = '-private-tmp-obelisk-title-capture';

function copyRealFixture(rootDir, { project = REAL_SLUG, sessionId = REAL_SID } = {}) {
  const dir = join(rootDir, 'projects', project);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${sessionId}.jsonl`);
  writeFileSync(filePath, REAL_FIXTURE_TEXT);
  return filePath;
}

function appendUserTurn(filePath, { uuid, parentUuid, text, timestamp = '2026-09-14T18:05:00.000Z' }) {
  appendFileSync(filePath, JSON.stringify({
    ...REAL_FIXTURE_USER,
    uuid,
    parentUuid,
    timestamp,
    message: { role: 'user', content: text },
  }) + '\n');
}

test('desktop multi-root: honors explicit providerRoots.claude array, ignores unconfigured siblings, and preserves IDs across restart and reorder', () => {
  const fakeHome = makeTempDir('obelisk-app-claude-explicit-');
  const defaultRoot = join(fakeHome, '.claude');
  const siblingRoot = join(fakeHome, '.claude-vendor');
  const workA = join(fakeHome, 'profiles', 'a', 'store');
  const workB = join(fakeHome, 'profiles', 'b', 'store'); // identical basename
  const codexRoot = join(fakeHome, '.codex');

  copyRealFixture(defaultRoot);
  copyRealFixture(siblingRoot);
  const fileA = copyRealFixture(workA);
  const fileB = copyRealFixture(workB);

  // Initial settings: `[workA, workB]` (explicitly omits defaultRoot and siblingRoot).
  const initialSettings = { providerRoots: { claude: [workA, workB] } };
  const runtime1 = createConfiguredBuiltinProviderRuntime(initialSettings, {
    homeDir: fakeHome,
    baseRoots: { claude: defaultRoot, codex: codexRoot },
  });
  const watchPaths1 = runtime1.registry.watchTargets(runtime1.roots).map((t) => t.path);
  assert.equal(watchPaths1.includes(join(workA, 'projects')), true);
  assert.equal(watchPaths1.includes(join(workB, 'projects')), true);
  assert.equal(watchPaths1.includes(join(defaultRoot, 'projects')), false);
  assert.equal(watchPaths1.includes(join(siblingRoot, 'projects')), false);

  const dbPath = join(fakeHome, '.obelisk', 'obelisk.sqlite');
  const build1 = buildIndex({
    providerRoots: runtime1.roots,
    providerSettings: initialSettings,
    claudeDir: runtime1.roots.claude,
    defaultClaudeDir: defaultRoot,
    codexDir: codexRoot,
    dbPath,
    DatabaseImpl: TestDatabase,
  });
  assert.equal(build1.complete, true);

  let db = new DatabaseSync(dbPath);
  const beforeRows = db.prepare("SELECT id, jsonl_path, message_count FROM sessions WHERE source='claude' ORDER BY jsonl_path").all();
  assert.equal(beforeRows.length, 2, 'only the two explicitly configured roots are indexed');
  const sidA = beforeRows.find((r) => r.jsonl_path === fileA).id;
  const sidB = beforeRows.find((r) => r.jsonl_path === fileB).id;
  assert.notEqual(sidA, sidB);
  db.close();

  // Simulated restart with reordered array `[workB, workA]` and an appended turn in `fileA`.
  appendUserTurn(fileA, { uuid: 'u-restart-2', parentUuid: REAL_FIXTURE_USER.uuid, text: 'after restart' });
  const restartedSettings = { providerRoots: { claude: [workB, workA] } };
  const runtime2 = createConfiguredBuiltinProviderRuntime(restartedSettings, {
    homeDir: fakeHome,
    baseRoots: { claude: defaultRoot, codex: codexRoot },
  });
  const build2 = buildIndex({
    providerRoots: runtime2.roots,
    providerSettings: restartedSettings,
    claudeDir: runtime2.roots.claude,
    defaultClaudeDir: defaultRoot,
    codexDir: codexRoot,
    dbPath,
    DatabaseImpl: TestDatabase,
  });
  assert.equal(build2.complete, true);

  db = new DatabaseSync(dbPath);
  const afterRows = db.prepare("SELECT id, jsonl_path, message_count FROM sessions WHERE source='claude' ORDER BY jsonl_path").all();
  assert.equal(afterRows.length, 2, 'reordering and restarting does not split sessions');
  assert.equal(afterRows.find((r) => r.jsonl_path === fileA).id, sidA);
  assert.equal(afterRows.find((r) => r.jsonl_path === fileA).message_count, 2);
  assert.equal(afterRows.find((r) => r.jsonl_path === fileB).id, sidB);
  db.close();
});

test('desktop multi-root: manual rebuild with preserveDbPath migrates pre-v7 custom single-root bare IDs, orphan history, and memories atomically', () => {
  const fakeHome = makeTempDir('obelisk-app-claude-rebuild-migrate-');
  const defaultRoot = join(fakeHome, '.claude');
  const customA = join(fakeHome, 'profiles', 'work');
  const customB = join(fakeHome, 'profiles', 'extra');
  const codexRoot = join(fakeHome, '.codex');
  const mainA = copyRealFixture(customA);
  copyRealFixture(customB);

  const orphanSid = '88888888-8888-4888-8888-888888888888';
  const orphanMainPath = join(customA, 'projects', REAL_SLUG, `${orphanSid}.jsonl`);
  const orphanSubDir = join(customA, 'projects', REAL_SLUG, orphanSid, 'subagents');
  mkdirSync(orphanSubDir, { recursive: true });
  writeFileSync(join(orphanSubDir, 'agent-o1.jsonl'), JSON.stringify({
    ...REAL_FIXTURE_USER,
    uuid: 'orphan-child-1',
    sessionId: orphanSid,
    isSidechain: true,
    agentId: 'agent-o1',
    message: { role: 'user', content: 'orphan child after rebuild' },
  }) + '\n');

  // Seed legacy pre-v7 database at `oldDbPath`.
  const oldDbPath = join(fakeHome, '.obelisk', 'obelisk.sqlite');
  mkdirSync(join(fakeHome, '.obelisk'), { recursive: true });
  const seed = new DatabaseSync(oldDbPath);
  seed.exec(SCHEMA);
  seed.prepare(`
    INSERT INTO sessions (id, title, project, started_at, ended_at, message_count, jsonl_path, source)
    VALUES (?, 'obelisk fixture capture', ?, ?, ?, 1, ?, 'claude')
  `).run(REAL_SID, REAL_SLUG, REAL_FIXTURE_USER.timestamp, REAL_FIXTURE_USER.timestamp, mainA);
  seed.prepare(`
    INSERT INTO messages (uuid, session_id, type, timestamp, role, text, content_type, is_meta, visibility, is_sidechain, source)
    VALUES (?, ?, 'user', ?, 'user', ?, 'text', 0, 'visible', 0, 'claude')
  `).run(REAL_FIXTURE_USER.uuid, REAL_SID, REAL_FIXTURE_USER.timestamp, REAL_FIXTURE_USER.message.content);
  seed.prepare(`
    INSERT INTO memories (id, session_id, project, path, summary, created_at)
    VALUES ('mem-app-1', ?, ?, 'notes/app.md', 'memory from single custom root', '2026-09-14T18:10:00.000Z')
  `).run(REAL_SID, REAL_SLUG);
  seed.prepare(`
    INSERT INTO sessions (id, title, project, started_at, ended_at, message_count, jsonl_path, source)
    VALUES (?, 'Legacy Orphan', ?, '2026-09-14T17:00:00.000Z', '2026-09-14T17:05:00.000Z', 1, ?, 'claude')
  `).run(orphanSid, REAL_SLUG, orphanMainPath);
  seed.prepare(`
    INSERT INTO messages (uuid, session_id, type, timestamp, role, text, content_type, is_meta, visibility, is_sidechain, source)
    VALUES ('orphan-main-1', ?, 'user', '2026-09-14T17:00:00.000Z', 'user', 'legacycachedmainneedle', 'text', 0, 'visible', 0, 'claude')
  `).run(orphanSid);
  seed.prepare("INSERT INTO index_state (jsonl_path, mtime, lines_processed) VALUES ('__claude_canonical_transcript_v6__', 1, 0)").run();
  seed.close();

  // Simulate desktop `settings:rebuildIndex` building into `tempDbPath` with `preserveDbPath: oldDbPath`.
  const settings = { providerRoots: { claude: [customA, customB] } };
  const runtime = createConfiguredBuiltinProviderRuntime(settings, {
    homeDir: fakeHome,
    baseRoots: { claude: defaultRoot, codex: codexRoot },
  });
  const tempDbPath = join(fakeHome, '.obelisk', 'obelisk.sqlite.rebuild.tmp');
  const rebuilt = buildIndex({
    reason: 'manual-rebuild',
    force: true,
    providerRoots: runtime.roots,
    providerSettings: settings,
    claudeDir: runtime.roots.claude,
    defaultClaudeDir: defaultRoot,
    codexDir: codexRoot,
    dbPath: tempDbPath,
    preserveDbPath: oldDbPath,
    DatabaseImpl: TestDatabase,
  });
  assert.equal(rebuilt.complete, true, JSON.stringify(rebuilt));

  const tagA = rootTagFor(customA, defaultRoot);
  const tagB = rootTagFor(customB, defaultRoot);
  const sidA = canonicalSessionId(REAL_SID, tagA);
  const sidB = canonicalSessionId(REAL_SID, tagB);
  const migratedOrphanSid = canonicalSessionId(orphanSid, tagA);

  const db = new DatabaseSync(tempDbPath);
  const sessionIds = db.prepare("SELECT id FROM sessions WHERE source='claude' ORDER BY id").all().map((r) => r.id);
  assert.deepEqual(sessionIds, [migratedOrphanSid, sidA, sidB].sort());
  assert.equal(db.prepare('SELECT session_id FROM memories WHERE id = ?').get('mem-app-1').session_id, sidA);

  const orphanMsgs = db.prepare('SELECT text FROM messages WHERE session_id = ? ORDER BY uuid').all(migratedOrphanSid).map((r) => r.text);
  assert.deepEqual(orphanMsgs, ['orphan child after rebuild', 'legacycachedmainneedle']);
  assert.equal(db.prepare('SELECT message_count FROM sessions WHERE id = ?').get(migratedOrphanSid).message_count, 2);
  assert.ok(db.prepare('SELECT 1 FROM index_state WHERE jsonl_path = ?').get(CLAUDE_CANONICAL_TRANSCRIPT_MARKER));
  db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1)");
  db.close();
});

test('desktop multi-root: unavailable configured root aborts force rebuild while empty and excluded roots follow retention policy', () => {
  const fakeHome = makeTempDir('obelisk-app-claude-retention-');
  const defaultRoot = join(fakeHome, '.claude');
  const rootA = join(fakeHome, 'profiles', 'a');
  const rootB = join(fakeHome, 'profiles', 'b');
  const emptyRoot = join(fakeHome, 'profiles', 'empty');
  const codexRoot = join(fakeHome, '.codex');
  mkdirSync(emptyRoot, { recursive: true });
  copyRealFixture(rootA);
  copyRealFixture(rootB);

  const dbPath = join(fakeHome, '.obelisk', 'obelisk.sqlite');
  const buildWith = (claudeRoots, force = false) => {
    const providerSettings = { providerRoots: { claude: claudeRoots } };
    const runtime = createConfiguredBuiltinProviderRuntime(providerSettings, {
      homeDir: fakeHome,
      baseRoots: { claude: defaultRoot, codex: codexRoot },
    });
    return buildIndex({
      providerRoots: runtime.roots,
      providerSettings,
      claudeDir: runtime.roots.claude,
      defaultClaudeDir: defaultRoot,
      codexDir: codexRoot,
      dbPath,
      force,
      DatabaseImpl: TestDatabase,
    });
  };
  const countClaude = () => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { return db.prepare("SELECT COUNT(*) c FROM sessions WHERE source='claude'").get().c; }
    finally { db.close(); }
  };

  assert.equal(buildWith([rootA, rootB]).complete, true);
  assert.equal(countClaude(), 2);

  // Temporarily missing configured rootB -> force rebuild fails closed and retains both sessions.
  const movedB = join(fakeHome, 'profiles', 'b-offline');
  renameSync(rootB, movedB);
  const aborted = buildWith([rootA, rootB], true);
  assert.equal(aborted.complete, false);
  assert.equal(aborted.incompleteProviders.includes('claude'), true);
  assert.equal(countClaude(), 2);
  renameSync(movedB, rootB);

  // Deliberately remove rootB from configuration -> ordinary refresh retains cached session; force rebuild publishes only [rootA].
  assert.equal(buildWith([rootA], false).complete, true);
  assert.equal(countClaude(), 2);
  assert.equal(buildWith([rootA], true).complete, true);
  assert.equal(countClaude(), 1);

  // Switch to an existing empty root -> force rebuild succeeds cleanly without mistaking it for an unavailable root.
  assert.equal(buildWith([emptyRoot], true).complete, true);
  assert.equal(countClaude(), 0);
});

test('desktop multi-root: watcher detects writes in every selected root via watchTargets', async () => {
  const fakeHome = makeTempDir('obelisk-app-claude-watcher-');
  const defaultRoot = join(fakeHome, '.claude');
  const rootA = join(fakeHome, 'profiles', 'a');
  const rootB = join(fakeHome, 'profiles', 'b');
  const codexRoot = join(fakeHome, '.codex');
  const fileA = copyRealFixture(rootA);
  const fileB = copyRealFixture(rootB);

  const settings = { providerRoots: { claude: [rootA, rootB] } };
  const runtime = createConfiguredBuiltinProviderRuntime(settings, {
    homeDir: fakeHome,
    baseRoots: { claude: defaultRoot, codex: codexRoot },
  });
  const watchTargets = runtime.registry.watchTargets(runtime.roots);
  const dbPath = join(fakeHome, '.obelisk', 'obelisk.sqlite');

  const builds = [];
  const service = createIndexerService({
    watchTargets,
    hotPolling: true,
    watchPollMs: 20,
    debounceMs: 0,
    stabilityMs: 0,
    reconcileMs: 60000,
    subscribe: async () => ({ unsubscribe: async () => {} }),
    buildIndex: async (args) => {
      const result = buildIndex({
        ...args,
        providerRoots: runtime.roots,
        providerSettings: settings,
        claudeDir: runtime.roots.claude,
        defaultClaudeDir: defaultRoot,
        codexDir: codexRoot,
        dbPath,
        DatabaseImpl: TestDatabase,
      });
      builds.push(result);
      return result;
    },
  });

  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 4000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, `timed out waiting for: ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  };
  const countMessagesFor = (jsonlPath) => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare('SELECT message_count FROM sessions WHERE jsonl_path = ?').get(jsonlPath);
      return row?.message_count ?? 0;
    } finally {
      db.close();
    }
  };

  try {
    service.start({ buildOnStart: true });
    await waitFor(() => builds.some((b) => b.complete) && countMessagesFor(fileA) === 1 && countMessagesFor(fileB) === 1, 'initial build of both roots');

    // Append to rootA and verify watcher hot-polling picks it up without native events.
    appendUserTurn(fileA, { uuid: 'watch-a-2', parentUuid: REAL_FIXTURE_USER.uuid, text: 'watched write in rootA' });
    await waitFor(() => countMessagesFor(fileA) === 2, 'rootA incremental update via watcher');

    // Append to rootB and verify watcher hot-polling picks it up too.
    appendUserTurn(fileB, { uuid: 'watch-b-2', parentUuid: REAL_FIXTURE_USER.uuid, text: 'watched write in rootB' });
    await waitFor(() => countMessagesFor(fileB) === 2, 'rootB incremental update via watcher');
  } finally {
    await service.stop();
    await service.idle();
  }
});
