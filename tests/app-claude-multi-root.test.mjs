// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Desktop worker / App indexer integration tests for multi-root Claude Code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createConfiguredBuiltinProviderRuntime } from '../packages/core/src/provider-settings.ts';
import { buildIndex } from '../app/src/main/indexer.ts';
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

const SLUG = '-tmp-demo-app';
const CWD = '/tmp/demo-app';
const SHARED_SID = '11111111-1111-4111-8111-111111111111';
const FORK_ONLY_SID = '22222222-2222-4222-8222-222222222222';

function writeSession(dir, sessionId, rows) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

test('claude multi-root: vanished automatic sibling root fails closed on force rebuild and retains indexed sessions', () => {
  const fakeHome = makeTempDir('obelisk-claude-vanish-');
  const defaultRoot = join(fakeHome, '.claude');
  const forkRoot = join(fakeHome, '.claude-vendor');
  writeSession(join(defaultRoot, 'projects', SLUG), SHARED_SID, [
    { uuid: 'u-up', type: 'user', timestamp: '2026-08-01T10:00:00.000Z', cwd: CWD, message: { role: 'user', content: 'upstream msg' } },
  ]);
  writeSession(join(forkRoot, 'projects', SLUG), FORK_ONLY_SID, [
    { uuid: 'u-fk', type: 'user', timestamp: '2026-08-01T10:01:00.000Z', cwd: CWD, message: { role: 'user', content: 'fork msg' } },
  ]);

  const dbPath = join(fakeHome, '.obelisk', 'obelisk.sqlite');
  const first = buildIndex({
    claudeDir: defaultRoot,
    codexDir: join(fakeHome, '.codex'),
    dbPath,
    providerSettings: {},
    DatabaseImpl: TestDatabase,
  });
  assert.equal(first.complete, true);

  const db = new DatabaseSync(dbPath);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE source = 'claude'").get().c, 2);
  db.close();

  // Sibling fork root vanishes from disk while default root stays intact
  rmSync(forkRoot, { recursive: true, force: true });

  const forced = buildIndex({
    claudeDir: defaultRoot,
    codexDir: join(fakeHome, '.codex'),
    dbPath,
    providerSettings: {},
    DatabaseImpl: TestDatabase,
    force: true,
  });
  assert.equal(forced.complete, false, 'force rebuild aborts when previously indexed sibling root vanished');
  assert.equal(forced.incompleteProviders.includes('claude'), true);

  const dbAfter = new DatabaseSync(dbPath);
  assert.equal(dbAfter.prepare("SELECT COUNT(*) AS c FROM sessions WHERE source = 'claude'").get().c, 2, 'indexed sessions are retained');
  dbAfter.close();
});

test('claude multi-root: desktop runtime and buildIndex discover sibling roots even when baseRoots.claude is DEFAULT_CLAUDE_DIR shape', () => {
  const fakeHome = makeTempDir('obelisk-claude-desktop-');
  const defaultRoot = join(fakeHome, '.claude');
  const vendorRoot = join(fakeHome, '.claude-vendor');
  const codexRoot = join(fakeHome, '.codex');
  writeSession(join(defaultRoot, 'projects', SLUG), SHARED_SID, [
    { uuid: 'u-up', type: 'user', timestamp: '2026-08-01T10:00:00.000Z', cwd: CWD, message: { role: 'user', content: 'desktop upstream' } },
  ]);
  writeSession(join(vendorRoot, 'projects', SLUG), FORK_ONLY_SID, [
    { uuid: 'u-fk', type: 'user', timestamp: '2026-08-01T10:01:00.000Z', cwd: CWD, message: { role: 'user', content: 'desktop vendor' } },
  ]);

  // Simulate app/src/main/index.ts getRuntimePaths()
  const runtime = createConfiguredBuiltinProviderRuntime({}, {
    baseRoots: { claude: defaultRoot, codex: codexRoot },
    automaticClaudeRoots: true,
    claudeHomeDir: fakeHome,
  });
  const watchPaths = runtime.registry.watchTargets(runtime.roots).map((t) => t.path);
  assert.equal(watchPaths.includes(join(defaultRoot, 'projects')), true);
  assert.equal(watchPaths.includes(join(vendorRoot, 'projects')), true);

  const dbPath = join(fakeHome, '.obelisk', 'obelisk.sqlite');
  const built = buildIndex({
    providerRoots: runtime.roots,
    providerSettings: {},
    claudeDir: runtime.roots.claude,
    codexDir: codexRoot,
    dbPath,
    DatabaseImpl: TestDatabase,
  });
  assert.equal(built.complete, true);

  const db = new DatabaseSync(dbPath);
  const sessions = db.prepare("SELECT id, source FROM sessions WHERE source = 'claude' ORDER BY id").all();
  assert.equal(sessions.length, 2, 'desktop buildIndex indexes both default and sibling roots');
  assert.equal(sessions.some((s) => s.id === SHARED_SID), true);
  assert.equal(sessions.some((s) => s.id === `claude-vendor:${FORK_ONLY_SID}`), true);
  db.close();
});
