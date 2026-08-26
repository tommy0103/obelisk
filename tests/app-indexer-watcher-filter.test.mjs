// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Integration test for the caller-side watcher filter in indexer-service:
// the adaptive-watcher package is domain-agnostic (ADR-0009), so the caller
// must forward DeepSeek Harness transcripts (.jsonl.zstd) and directory-level
// events (renames arrive as bare paths) — a provider-side filter can never
// fix events dropped here.

import { test, mock } from 'node:test';
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

test('caller forwards .jsonl.zstd and directory events; promotes .jsonl.zstd', async () => {
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
    // Cache-busted import so the mocked watcher package is picked up.
    const { createIndexerService } = await import(`../app/src/main/indexer-service.ts?watcher-filter=${Date.now()}`);
    const timers = manualTimers();
    const builds = [];
    const service = createIndexerService({
      buildIndex: async (args) => builds.push(args),
      watchTargets: [{ kind: 'tree', path: '/tmp/sessions' }],
      writeHeartbeat: () => {},
      timers,
      stabilityMs: 0,
    });
    service.start({ buildOnStart: false }); // constructs the watcher
    assert.ok(captured, 'watcher options captured');
    assert.equal(captured.shouldPromote('/x/session.jsonl.zstd'), true, '.jsonl.zstd promotes into the hot set');
    assert.equal(captured.shouldPromote('/x/session.jsonl'), true);
    assert.equal(captured.shouldPromote('/x/notes.txt'), false);

    captured.onInvalidate({ type: 'paths', paths: ['/x/--proj--/sid/session.jsonl.zstd'] });
    captured.onInvalidate({ type: 'paths', paths: ['/x/--proj--/sid/notes.txt'] }); // unrelated file dropped
    timers.flush();
    await new Promise((resolve) => setImmediate(resolve)); // let the async build record
    assert.deepEqual(
      builds.map((b) => b.changedPaths ?? []),
      [['/x/--proj--/sid/session.jsonl.zstd']],
      '.jsonl.zstd reaches the build',
    );
    captured.onInvalidate({ type: 'paths', paths: ['/x/--proj--'] }); // renamed dir arrives bare
    timers.flush();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(builds.at(-1).changedPaths, ['/x/--proj--'], 'directory event reaches the build');
    service.stop();
  } finally {
    ctx.restore();
    mock.reset();
  }
});
