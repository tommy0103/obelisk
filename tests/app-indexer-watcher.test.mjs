// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Tests for the default watchProjects implementation, which delegates to
// @parcel/watcher through app/src/main/watcher.ts: one recursive native
// subscription per root instead of chokidar 4's per-path model (one fd per
// file + one FSEventStream per directory — the EMFILE flood on ~23k-path
// transcript trees that motivated the switch). These tests exercise the real
// watcher for event delivery and filtering, and injected subscriptions for
// the recovery and reconciliation layers built around it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';

import { createIndexerService } from '../app/src/main/indexer-service.ts';
import { createRecursiveWatcher } from '../app/src/main/watcher.ts';
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
    watchDirs: [root],
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
    watchDirs: [root],
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
    watchDirs: [root],
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

    // The retry loop re-attaches the root.
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
    watchDirs: [root],
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


test('a missing root is retried quietly', async () => {
  const root = join(makeTempDir('obelisk-watch-missing-'), 'not-there-yet');
  const warns = [];
  let probeCalls = 0;
  let lost = 0;
  const watcher = createRecursiveWatcher({
    roots: [root],
    filter: () => true,
    onChange: () => {},
    logger: { warn: (msg) => warns.push(msg) },
    onRootLost: () => { lost += 1; },
    // The real fs probe through the injection point: ENOENT is genuine.
    access: async (p) => { probeCalls += 1; return fs.promises.access(p); },
    subscribe: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
  });

  try {
    assert.ok(await waitFor(() => lost === 1), 'the missing root drives a retry');
    watcher.refreshMissingRoots();
    assert.ok(await waitFor(() => lost === 2), 'the retry re-probes the root');
    assert.equal(probeCalls, 2);
    assert.deepEqual(warns, [], 'a missing root never logs a warning');
  } finally {
    await watcher.close();
  }
});

test('an inaccessible root warns once per failure, and again after a recurrence', async () => {
  const root = makeTempDir('obelisk-watch-denied-');
  const warns = [];
  let denied = true;
  let lost = 0;
  let subscribeCalls = 0;
  let emit = null;
  const access = async () => {
    if (!denied) return;
    const error = new Error('permission denied');
    error.code = 'EACCES';
    throw error;
  };
  const watcher = createRecursiveWatcher({
    roots: [root],
    filter: () => true,
    onChange: () => {},
    logger: { warn: (msg) => warns.push(msg) },
    onRootLost: () => { lost += 1; },
    access,
    subscribe: (_root, callback) => {
      subscribeCalls += 1;
      emit = callback;
      return Promise.resolve({ unsubscribe: () => Promise.resolve() });
    },
  });

  try {
    assert.ok(await waitFor(() => lost === 1), 'the first failure drives a retry');
    watcher.refreshMissingRoots();
    assert.ok(await waitFor(() => lost === 2));
    watcher.refreshMissingRoots();
    assert.ok(await waitFor(() => lost === 3));
    assert.equal(warns.length, 1, 'a permanent failure warns once, not on every retry tick');

    // The root recovers: it establishes (which clears the dedup entry)...
    denied = false;
    watcher.refreshMissingRoots();
    assert.ok(await waitFor(() => subscribeCalls === 1), 'the recovered root is subscribed');

    // ...then its stream dies (one warn for the death) and the retry finds
    // the root inaccessible again — reported again, because the dedup entry
    // was cleared on establishment.
    emit(new Error('stream died'), []);
    assert.ok(await waitFor(() => lost === 4), 'the dead stream drives a retry');
    denied = true;
    watcher.refreshMissingRoots();
    assert.ok(await waitFor(() => lost === 5), 'the recurrence is re-probed');
    const accessWarns = warns.filter((msg) => msg.includes('cannot access'));
    assert.equal(accessWarns.length, 2, 'the same access failure warns again after a recovery');
  } finally {
    await watcher.close();
  }
});
