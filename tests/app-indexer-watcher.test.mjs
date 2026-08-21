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
    for (let attempt = 0; attempt < 20 && !sawIt; attempt++) {
      fs.appendFileSync(newFile, '{"probe":1}\n');
      sawIt = await waitFor(sawFile, 1500);
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
    // Establish the subscription first: FSEvents latency on CI runners is
    // real and unbounded, so without a probe the test races subscription
    // setup and flakes (macOS CI waited ~11 s and saw nothing).
    let established = false;
    for (let attempt = 0; attempt < 20 && !established; attempt++) {
      fs.appendFileSync(join(root, 'probe.json'), '{}\n');
      established = await waitFor(() =>
        builds.some((b) => (b.changedPaths ?? []).some((p) => p.endsWith('probe.json'))), 1500);
    }
    assert.ok(established, 'the subscription is delivering events');

    const noiseStart = builds.length;
    fs.writeFileSync(join(root, 'noise.txt'), 'not a transcript');
    // Give a wrong-positive time to surface, then send a real one as a control.
    await new Promise((resolve) => setTimeout(resolve, 700));
    const sawNoise = builds.slice(noiseStart)
      .some((b) => (b.changedPaths ?? []).some((p) => p.endsWith('noise.txt')));
    assert.equal(sawNoise, false, 'a .txt write alone must not schedule a build');

    const realFile = join(root, 'real.json');
    let sawReal = false;
    for (let attempt = 0; attempt < 20 && !sawReal; attempt++) {
      fs.appendFileSync(realFile, '{}\n');
      sawReal = await waitFor(() =>
        builds.slice(noiseStart).some((b) => (b.changedPaths ?? []).some((p) => p.endsWith('real.json'))), 1500);
    }
    assert.ok(sawReal, 'the .json control write does schedule a build');

    // Re-scan after the control succeeded: at unbounded CI event latency a
    // wrong-positive .txt build could arrive long after the 700 ms probe.
    const sawNoiseLate = builds.slice(noiseStart)
      .some((b) => (b.changedPaths ?? []).some((p) => p.endsWith('noise.txt')));
    assert.equal(sawNoiseLate, false, 'a .txt write never schedules a build, even at CI event latency');
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

  const drive = async (rounds) => {
    for (let i = 0; i < rounds; i++) {
      timers.flush();
      await new Promise((resolve) => setTimeout(resolve, 30));
      await service.idle();
    }
  };

  try {
    service.start({ buildOnStart: false });
    await service.runBuildNow('startup');
    // Hint promotion is report-first: the first poll fires an appearance
    // build. Drain those before appending, so the assertion below can only
    // be satisfied by detecting the append itself.
    await drive(3);
    const beforeAppend = builds.length;
    assert.ok(beforeAppend > 0, 'the hint-driven first-observation build happened');

    fs.appendFileSync(hinted, '{"line":1}\n');
    let appended = false;
    for (let attempt = 0; attempt < 20 && !appended; attempt++) {
      timers.flush();
      await new Promise((resolve) => setTimeout(resolve, 30));
      await service.idle();
      appended = builds.slice(beforeAppend).some((b) => (b.changedPaths ?? []).includes(hinted));
    }
    assert.ok(appended, 'the append — possibly invisible to the tree backend — is detected by polling');
  } finally {
    service.stop();
    await service.idle();
  }
});

test('an evicted hot file is re-seeded by a later reconcile hint', async () => {
  const root = makeTempDir('obelisk-reseed-');
  const hinted = join(root, 'live.jsonl');
  fs.writeFileSync(hinted, '{"line":0}\n');
  const fillers = Array.from({ length: 64 }, (_, i) => join(root, `filler-${i}.jsonl`));
  for (const filler of fillers) fs.writeFileSync(filler, '{}\n');
  const timers = manualTimers();
  const builds = [];
  let nextHints = [hinted];
  const service = createIndexerService({
    watchTargets: [{ kind: 'tree', path: root }],
    buildIndex: async (args) => { builds.push(args); return { watchHints: nextHints }; },
    subscribe: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
    writeHeartbeat: () => {},
    logger: { warn: () => {} },
    timers,
    stabilityMs: 0,
    debounceMs: 0,
    watchRetryMs: 0,
    hotPolling: true,
  });

  const drive = async (rounds) => {
    for (let i = 0; i < rounds; i++) {
      timers.flush();
      await new Promise((resolve) => setTimeout(resolve, 30));
      await service.idle();
    }
  };

  try {
    service.start({ buildOnStart: false });
    await service.runBuildNow('startup');
    await drive(3);
    assert.ok(
      builds.some((b) => (b.changedPaths ?? []).includes(hinted)),
      'the hinted file is hot after seeding',
    );

    // Evict it by filling the 64-slot hot set with fillers.
    nextHints = fillers;
    await service.runBuildNow('reconcile');
    const afterEvict = builds.length;
    await drive(3);
    fs.appendFileSync(hinted, '{"line":1}\n');
    await drive(6);
    assert.ok(
      !builds.slice(afterEvict).some((b) => (b.changedPaths ?? []).includes(hinted)),
      'the evicted file is no longer polled',
    );

    // The periodic reconcile returns it as a hint: it is re-seeded and its
    // first observation reports again — the degradation loop closes.
    nextHints = [hinted];
    await service.runBuildNow('reconcile');
    let reseeded = false;
    for (let attempt = 0; attempt < 20 && !reseeded; attempt++) {
      timers.flush();
      await new Promise((resolve) => setTimeout(resolve, 30));
      await service.idle();
      reseeded = builds.slice(afterEvict).some((b) => (b.changedPaths ?? []).includes(hinted));
    }
    assert.ok(reseeded, 'a reconcile hint re-seeds the evicted file into the hot set');
  } finally {
    service.stop();
    await service.idle();
  }
});
