// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Integration test for the caller-side watcher filter in indexer-service:
// the adaptive-watcher package is domain-agnostic (ADR-0009), so the caller
// must forward DeepSeek Harness transcripts (.jsonl.zstd) and directory-level
// events (renames arrive as bare paths) — a provider-side filter can never
// fix events dropped here.

import { test, mock } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const SERVICE_URL = new URL('../app/src/main/indexer-service.ts', import.meta.url);
const WATCHER_URL = new URL('../../../packages/adaptive-watcher/src/index.ts', SERVICE_URL).href;

function manualTimers() {
  const pending = new Set();
  return {
    setTimeout: (fn) => { pending.add(fn); return fn; },
    clearTimeout: (fn) => pending.delete(fn),
    flush: () => { for (const fn of [...pending]) fn(); pending.clear(); },
  };
}

test('caller routes provider-declared exact files regardless of suffix', async () => {
  let captured = null;
  const ctx = mock.module(WATCHER_URL, {
    namedExports: {
      createAdaptiveWatcher: (opts) => {
        captured = opts;
        return { stop() {}, ready: Promise.resolve() };
      },
    },
  });
  try {
    const { createIndexerService } = await import(`../app/src/main/indexer-service.ts?watcher-filter=${Date.now()}`);
    const timers = manualTimers();
    const builds = [];
    const dir = mkdtempSync(join(tmpdir(), 'obelisk-wf-'));
    const sourceDb = join(dir, 'db.sqlite');
    const pinnedTranscript = join(dir, 'history.jsonl');
    writeFileSync(sourceDb, 'sqlite fixture');
    writeFileSync(pinnedTranscript, '');
    const service = createIndexerService({
      buildIndex: async (args) => builds.push(args),
      watchTargets: [
        { kind: 'tree', path: dir },
        { kind: 'file', path: sourceDb },
        { kind: 'file', path: pinnedTranscript },
      ],
      writeHeartbeat: () => {},
      timers,
      stabilityMs: 0,
    });
    service.start({ buildOnStart: false });

    // Only transcripts discovered under a tree join the hot overlay.
    assert.equal(captured.shouldPromote(join(dir, 'session.jsonl.zstd')), true, '.jsonl.zstd promotes');
    assert.equal(captured.shouldPromote(join(dir, 'session.jsonl')), true);
    assert.equal(captured.shouldPromote(join(dir, 'notes.txt')), false);
    assert.equal(captured.shouldPromote(pinnedTranscript), false, 'pinned .jsonl stays out of the hot overlay');

    mkdirSync(join(dir, 'repo.v2')); // dotted directory name
    writeFileSync(join(dir, 'notes.txt'), 'x'); // plain non-transcript file
    const unrelatedDb = join(dir, 'unrelated.sqlite');
    writeFileSync(unrelatedDb, 'not a provider target');

    // Transcripts forward synchronously.
    captured.onInvalidate({ type: 'paths', paths: [join(dir, 'sid', 'session.jsonl.zstd')] });
    timers.flush();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(builds.map((b) => b.changedPaths ?? []), [[join(dir, 'sid', 'session.jsonl.zstd')]]);

    // Exact file targets are provider-declared sources. Their suffix is not a
    // caller-side concern, and they are already pinned in the file poller.
    captured.onInvalidate({ type: 'paths', paths: [sourceDb] });
    timers.flush();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(builds.at(-1).changedPaths, [sourceDb], 'exact file update reaches the indexer');

    // Non-transcripts resolve asynchronously: real directories and missing
    // paths (rename sources) forward; real stray files are dropped.
    captured.onInvalidate({
      type: 'paths',
      paths: [join(dir, 'repo.v2'), join(dir, 'notes.txt'), unrelatedDb, join(dir, 'renamed-away')],
    });
    const forwarded = await (async () => {
      for (let i = 0; i < 40; i++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        timers.flush();
        const all = builds.flatMap((b) => b.changedPaths ?? []);
        if (all.some((p) => p.endsWith('repo.v2')) && all.some((p) => p.endsWith('renamed-away'))) return all;
      }
      return builds.flatMap((b) => b.changedPaths ?? []);
    })();
    assert.ok(forwarded.some((p) => p.endsWith('repo.v2')), 'dotted directory forwarded');
    assert.ok(forwarded.some((p) => p.endsWith('renamed-away')), 'missing rename source forwarded');
    assert.ok(!forwarded.some((p) => p.endsWith('notes.txt')), 'real stray file dropped');
    assert.ok(!forwarded.includes(unrelatedDb), 'non-target SQLite file dropped');
    service.stop();
  } finally {
    ctx.restore();
    mock.reset();
  }
});

// A profile can appear after watcher startup. The tree carries Hermes's exact database names,
// so its files reach the indexer without a synchronous enumeration on Electron's main thread.
test('Hermes profile stores reach the indexer through the declared tree file names', async () => {
  let captured = null;
  const ctx = mock.module(WATCHER_URL, {
    namedExports: {
      createAdaptiveWatcher: (opts) => {
        captured = opts;
        return { stop() {}, ready: Promise.resolve() };
      },
    },
  });
  try {
    const { createHermesProvider } = await import('../packages/core/src/providers/hermes.ts');
    const { createIndexerService } = await import(`../app/src/main/indexer-service.ts?watcher-hermes=${Date.now()}`);
    const home = mkdtempSync(join(tmpdir(), 'obelisk-hermes-wf-'));
    const profileStore = join(home, 'profiles', 'coder', 'state.db');
    mkdirSync(join(home, 'profiles', 'coder'), { recursive: true });
    writeFileSync(profileStore, 'sqlite fixture');
    writeFileSync(`${profileStore}-wal`, '');

    const provider = createHermesProvider({
      rootDir: home,
      openStore: () => { throw new Error('the watcher filter must not open a store'); },
    });
    const targets = provider.watchTargets(home);
    assert.deepEqual(targets.find(target => target.kind === 'tree'), {
      kind: 'tree', path: join(home, 'profiles'), fileNames: ['state.db', 'state.db-wal'],
    });
    assert.equal(targets.some(target => target.kind === 'file' && target.path === profileStore), false);

    const timers = manualTimers();
    const builds = [];
    const service = createIndexerService({
      buildIndex: async (args) => builds.push(args),
      watchTargets: targets,
      writeHeartbeat: () => {},
      timers,
      stabilityMs: 0,
    });
    service.start({ buildOnStart: false });

    // The tree forwards both SQLite files and promotes them to the bounded hot poller.
    captured.onInvalidate({ type: 'paths', paths: [`${profileStore}-wal`] });
    timers.flush();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      builds.at(-1).changedPaths,
      [`${profileStore}-wal`],
      'a profile store update reaches the indexer',
    );
    assert.equal(captured.shouldPromote(profileStore), true);
    assert.equal(captured.shouldPromote(`${profileStore}-wal`), true);
    assert.equal(captured.shouldPromote(`${profileStore}-shm`), false);

    // A profile created later is covered without rebuilding the target list.
    const lateStore = join(home, 'profiles', 'late', 'state.db');
    mkdirSync(join(home, 'profiles', 'late'), { recursive: true });
    writeFileSync(lateStore, 'sqlite fixture');
    captured.onInvalidate({ type: 'paths', paths: [lateStore] });
    timers.flush();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      builds.flatMap((build) => build.changedPaths ?? []).includes(lateStore),
      true,
      'a newly created profile database reaches the indexer immediately',
    );
    const stray = join(home, 'profiles', 'late', 'other.db');
    writeFileSync(stray, 'not a provider store');
    assert.equal(captured.shouldPromote(stray), false, 'other databases stay out of the hot overlay');
    captured.onInvalidate({ type: 'paths', paths: [stray] });
    await new Promise((resolve) => setImmediate(resolve));
    timers.flush();
    assert.equal(builds.flatMap(build => build.changedPaths ?? []).includes(stray), false);
    service.stop();
  } finally {
    ctx.restore();
    mock.reset();
  }
});

test('caller routes OpenCode dynamic channel databases without synchronous directory listing', async () => {
  let captured = null;
  const ctx = mock.module(WATCHER_URL, {
    namedExports: {
      createAdaptiveWatcher: (opts) => {
        captured = opts;
        return { stop() {}, ready: Promise.resolve() };
      },
    },
  });
  try {
    const { createOpencodeProvider } = await import('../packages/core/src/providers/opencode.ts');
    const { createIndexerService } = await import(`../app/src/main/indexer-service.ts?watcher-opencode=${Date.now()}`);
    const home = mkdtempSync(join(tmpdir(), 'obelisk-opencode-wf-'));
    const opencodeDir = join(home, 'data');
    mkdirSync(opencodeDir, { recursive: true });

    const provider = createOpencodeProvider({
      rootDir: opencodeDir,
      homeDir: home,
      openDatabase: () => { throw new Error('watcher filter must not open database'); },
    });
    const targets = provider.watchTargets(opencodeDir);

    const timers = manualTimers();
    const builds = [];
    const service = createIndexerService({
      buildIndex: async (args) => builds.push(args),
      watchTargets: targets,
      writeHeartbeat: () => {},
      timers,
      stabilityMs: 0,
    });
    service.start({ buildOnStart: false });

    // Newly created channel database (created AFTER watcher started) promotes immediately
    const channelDb = join(opencodeDir, 'opencode-dev.db');
    const channelWal = join(opencodeDir, 'opencode-dev.db-wal');
    writeFileSync(channelDb, '');
    writeFileSync(channelWal, '');

    assert.equal(captured.shouldPromote(channelDb), true, 'new channel db promotes immediately');
    assert.equal(captured.shouldPromote(channelWal), true, 'new channel wal promotes immediately');
    assert.equal(captured.shouldPromote(join(opencodeDir, 'opencode.db-shm')), false, 'shm is rejected');
    assert.equal(captured.shouldPromote(join(opencodeDir, 'stray.db')), false, 'non-channel db is rejected');

    captured.onInvalidate({ type: 'paths', paths: [channelDb] });
    timers.flush();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      builds.flatMap((build) => build.changedPaths ?? []).includes(channelDb),
      true,
      'newly created channel db triggers index build',
    );

    service.stop();
  } finally {
    ctx.restore();
    mock.reset();
  }
});

test('merged OpenCode predicate preserves Hermes profile database names', async () => {
  const { createProviderRegistry } = await import('../packages/core/src/providers/registry.ts');
  const { createHermesProvider } = await import('../packages/core/src/providers/hermes.ts');
  const { createOpencodeProvider } = await import('../packages/core/src/providers/opencode.ts');
  let captured;
  const ctx = mock.module(WATCHER_URL, { namedExports: { createAdaptiveWatcher: opts => {
    captured = opts; return { stop() {}, ready: Promise.resolve() };
  } } });
  try {
    const { createIndexerService } = await import(`../app/src/main/indexer-service.ts?merged=${Date.now()}`);
    const root = mkdtempSync(join(tmpdir(), 'obelisk-merged-watch-'));
    const profiles = join(root, 'profiles');
    mkdirSync(join(profiles, 'coder'), { recursive: true });
    const wal = join(profiles, 'coder', 'state.db-wal'); writeFileSync(wal, '');
    const targets = createProviderRegistry([
      createHermesProvider({ rootDir: root }), createOpencodeProvider({ rootDir: profiles }),
    ]).watchTargets();
    const timers = manualTimers(); const builds = [];
    const service = createIndexerService({ watchTargets: targets, stabilityMs: 0, timers,
      writeHeartbeat() {}, buildIndex: async args => builds.push(args) });
    try {
      service.start({ buildOnStart: false });
      assert.equal(captured.shouldPromote(wal), true);
      captured.onInvalidate({ type: 'paths', paths: [wal] }); timers.flush();
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(builds.map(b => b.changedPaths), [[wal]]);
    } finally { service.stop(); }
  } finally { ctx.restore(); mock.reset(); }
});
