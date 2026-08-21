// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Tests for the indexer service's default watch integration, which delegates
// to the adaptive-watcher package (ADR-0009): one recursive native
// subscription per tree root instead of chokidar 4's per-path model (one fd
// per file + one FSEventStream per directory — the EMFILE flood on ~23k-path
// transcript trees that motivated the switch). These tests exercise the real
// watcher for event delivery and caller-side filtering, and injected
// subscriptions for the recovery and reconciliation layers built around it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';

import { createIndexerService } from '../app/src/main/indexer-service.ts';
import { makeTempDir } from './temp-dirs.mjs';

async function waitFor(cond, ms = 1000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return cond();
}

function manualTimers() {
  const timers = new Set();
  const intervals = [];
  return {
    intervals,
    setTimeout(fn) {
      timers.add(fn);
      return fn;
    },
    clearTimeout(fn) {
      timers.delete(fn);
    },
    setInterval(fn, ms) {
      intervals.push({ fn, ms });
      return fn;
    },
    clearInterval() {},
    flush() {
      const pending = [...timers];
      timers.clear();
      for (const fn of pending) fn();
    },
  };
}

test('default watcher reports deep new files in freshly created directories', async () => {
  const root = makeTempDir('obelisk-parcelwatch-');
  // A pre-existing populated tree: the per-path model needed one fd per file.
  for (let i = 0; i < 50; i++) {
    const dir = join(root, `proj-${i}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'old.jsonl'), '{}\n');
  }

  const builds = [];
  const service = createIndexerService({
    watchTargets: [{ kind: 'tree', path: root }],
    debounceMs: 10,
    stabilityMs: 0,
    buildIndex: (args) => { builds.push(args); },
    writeHeartbeat: () => {},
    logger: { warn: () => {} },
  });
  service.start({ buildOnStart: false });

  try {
    // A brand-new nested directory plus transcript. The subscription may still
    // be establishing when the test first writes, so rewrite on a deadline
    // instead of assuming the first event lands.
    const deep = join(root, 'proj-new', 'sess-id', 'subagents');
    fs.mkdirSync(deep, { recursive: true });
    const newFile = join(deep, 'agent-1.jsonl');
    const sawFile = () =>
      builds.some((b) => (b.changedPaths ?? []).some((p) => p.endsWith('agent-1.jsonl')));
    let sawIt = false;
    for (let attempt = 0; attempt < 10 && !sawIt; attempt++) {
      fs.appendFileSync(newFile, '{"probe":1}\n');
      sawIt = await waitFor(sawFile);
    }
    assert.ok(sawIt, 'the deep new transcript reached buildIndex as a changed path');
    const hit = builds.find((b) => (b.changedPaths ?? []).some((p) => p.endsWith('agent-1.jsonl')));
    // @parcel/watcher reports real paths — on macOS the temp dir's /var/...
    // symlink resolves to /private/var/...
    const realRoot = fs.realpathSync(root);
    assert.ok(hit.changedPaths.every((p) => p.startsWith(root) || p.startsWith(realRoot)),
      'changed paths are absolute paths under the watched root');
  } finally {
    service.stop();
    await service.idle();
  }
});

test('default watcher filters non-transcript files', async () => {
  const root = makeTempDir('obelisk-parcelwatch-filter-');
  const builds = [];
  const service = createIndexerService({
    watchTargets: [{ kind: 'tree', path: root }],
    debounceMs: 10,
    stabilityMs: 0,
    buildIndex: (args) => { builds.push(args); },
    writeHeartbeat: () => {},
    logger: { warn: () => {} },
  });
  service.start({ buildOnStart: false });

  try {
    fs.writeFileSync(join(root, 'noise.txt'), 'not a transcript');
    // Give a wrong-positive time to surface, then send a real one as a control.
    await new Promise((resolve) => setTimeout(resolve, 700));
    const noiseBuilds = builds.length;
    const realFile = join(root, 'real.json');
    const sawReal = () =>
      builds.slice(noiseBuilds).some((b) => (b.changedPaths ?? []).some((p) => p.endsWith('real.json')));
    let sawIt = false;
    for (let attempt = 0; attempt < 10 && !sawIt; attempt++) {
      fs.appendFileSync(realFile, '{}\n');
      sawIt = await waitFor(sawReal);
    }

    assert.equal(noiseBuilds, 0, 'a .txt write alone must not schedule a build');
    assert.ok(sawIt, 'the .json control write does schedule a build');
  } finally {
    service.stop();
    await service.idle();
  }
});

test('a subscription that errors is re-attached by the watch retry loop', async () => {
  const root = makeTempDir('obelisk-watch-reattach-');
  const timers = manualTimers();
  const subscriptions = [];
  const subscribe = (rootArg, callback) => {
    const sub = {
      root: rootArg,
      callback,
      unsubscribed: false,
      unsubscribe() {
        sub.unsubscribed = true;
        return Promise.resolve();
      },
    };
    subscriptions.push(sub);
    return Promise.resolve(sub);
  };
  const service = createIndexerService({
    watchTargets: [{ kind: 'tree', path: root }],
    buildIndex: async () => {},
    subscribe,
    writeHeartbeat: () => {},
    logger: { warn: () => {} },
    timers,
    stabilityMs: 0,
    debounceMs: 0,
    watchRetryMs: 0,
  });

  try {
    service.start({ buildOnStart: false });
    assert.ok(await waitFor(() => subscriptions.length === 1), 'the root is subscribed');

    // The stream dies asynchronously with an error; the root must not stay
    // "watched" (a dead stream would never deliver another event).
    subscriptions[0].callback(new Error('stream died'), []);
    assert.ok(await waitFor(() => subscriptions[0].unsubscribed), 'the dead stream is unsubscribed');

    // The retry loop (inside the package, driven by the service's timers)
    // re-attaches the root.
    timers.flush();
    assert.ok(await waitFor(() => subscriptions.length === 2), 'the retry loop re-attaches the root');
  } finally {
    service.stop();
  }
});

test('silently missed watcher events are reconciled by a periodic full-inventory build', async () => {
  const root = makeTempDir('obelisk-watch-reconcile-');
  const timers = manualTimers();
  const calls = [];
  const service = createIndexerService({
    watchTargets: [{ kind: 'tree', path: root }],
    buildIndex: async (args) => calls.push(args),
    subscribe: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
    writeHeartbeat: () => {},
    timers,
    stabilityMs: 0,
    debounceMs: 0,
    reconcileMs: 60000,
  });

  try {
    service.start({ buildOnStart: false });
    const reconcile = timers.intervals.find((entry) => entry.ms === 60000);
    assert.ok(reconcile, 'a reconcile interval is scheduled');

    reconcile.fn();
    timers.flush();
    await service.idle();
    assert.deepEqual(calls, [{ reason: 'reconcile', changedPaths: undefined }],
      'the reconcile build is a full-inventory build, not a changed-paths build');
  } finally {
    service.stop();
  }
});


test('build watchHints are promoted into the hot set and polled for later appends', async () => {
  const root = makeTempDir('obelisk-hints-');
  const hinted = join(root, 'live-session.jsonl');
  fs.writeFileSync(hinted, '{"line":0}\n');
  const timers = manualTimers();
  const builds = [];
  const service = createIndexerService({
    watchTargets: [{ kind: 'tree', path: root }],
    buildIndex: async (args) => { builds.push(args); return { watchHints: [hinted] }; },
    subscribe: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
    writeHeartbeat: () => {},
    logger: { warn: () => {} },
    timers,
    stabilityMs: 0,
    debounceMs: 0,
    watchRetryMs: 0,
    hotPolling: true,
  });

  try {
    service.start({ buildOnStart: false });
    await service.runBuildNow('startup');
    // Poll timers live in the manual set alongside service timers; drive
    // ticks and let microtasks settle between them.
    timers.flush();
    await new Promise((resolve) => setTimeout(resolve, 30));

    // The hint was promoted (silently baselined); a later append — possibly
    // invisible to the tree backend — must surface through the poller.
    fs.appendFileSync(hinted, '{"line":1}\n');
    let detected = false;
    for (let attempt = 0; attempt < 20 && !detected; attempt++) {
      timers.flush();
      await new Promise((resolve) => setTimeout(resolve, 30));
      await service.idle();
      detected = builds.some((b) => (b.changedPaths ?? []).includes(hinted));
    }
    assert.ok(detected, 'the hinted transcript is polled and its append schedules a build');
    const hit = builds.find((b) => (b.changedPaths ?? []).includes(hinted));
    assert.equal(hit.reason, 'watch');
  } finally {
    service.stop();
    await service.idle();
  }
});
