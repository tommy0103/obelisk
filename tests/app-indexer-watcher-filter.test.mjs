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

test('caller promotes transcripts and routes directory events without sync IO', async () => {
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
    const service = createIndexerService({
      buildIndex: async (args) => builds.push(args),
      watchTargets: [{ kind: 'tree', path: '/tmp/sessions' }],
      writeHeartbeat: () => {},
      timers,
      stabilityMs: 0,
    });
    service.start({ buildOnStart: false });

    // Hot-set promotion stays transcript-gated.
    assert.equal(captured.shouldPromote('/x/session.jsonl.zstd'), true, '.jsonl.zstd promotes');
    assert.equal(captured.shouldPromote('/x/session.jsonl'), true);
    assert.equal(captured.shouldPromote('/x/notes.txt'), false);

    const dir = mkdtempSync(join(tmpdir(), 'obelisk-wf-'));
    mkdirSync(join(dir, 'repo.v2')); // dotted directory name
    writeFileSync(join(dir, 'notes.txt'), 'x'); // plain non-transcript file

    // Transcripts forward synchronously.
    captured.onInvalidate({ type: 'paths', paths: [join(dir, 'sid', 'session.jsonl.zstd')] });
    timers.flush();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(builds.map((b) => b.changedPaths ?? []), [[join(dir, 'sid', 'session.jsonl.zstd')]]);

    // Non-transcripts resolve asynchronously: real directories and missing
    // paths (rename sources) forward; real stray files are dropped.
    captured.onInvalidate({ type: 'paths', paths: [join(dir, 'repo.v2'), join(dir, 'notes.txt'), join(dir, 'renamed-away')] });
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
    service.stop();
  } finally {
    ctx.restore();
    mock.reset();
  }
});
