// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Package-level tests for @obelisk-apps/adaptive-watcher (ADR-0009). Tree
// targets use injected subscriptions; file targets use an injected stat
// probe; retries and poll ticks are driven by fake timers. The poller tests
// cover the failure mode behind the package: exact files (session_index.jsonl
// & co.) must never reach a recursive directory backend, and metadata changes
// — append, replacement, disappearance — must surface as path invalidations.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';

import { createAdaptiveWatcher } from '../packages/adaptive-watcher/src/index.ts';
import { makeTempDir } from './temp-dirs.mjs';

async function waitFor(cond, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return cond();
}

function fakeTimers() {
  const timers = new Set();
  return {
    setTimeout(fn) {
      timers.add(fn);
      return fn;
    },
    clearTimeout(fn) {
      timers.delete(fn);
    },
    flush() {
      const pending = [...timers];
      timers.clear();
      for (const fn of pending) fn();
    },
    get pendingCount() {
      return timers.size;
    },
  };
}

function fakeSubscribeStore() {
  const subscriptions = [];
  const subscribe = (root, callback) => {
    const sub = {
      root,
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
  return { subscriptions, subscribe };
}

test('tree events arrive as batched path invalidations, duplicate roots subscribe once', async () => {
  const root = makeTempDir('obelisk-adw-tree-');
  const { subscriptions, subscribe } = fakeSubscribeStore();
  const invalidations = [];
  const watcher = createAdaptiveWatcher({
    targets: [
      { kind: 'tree', path: root },
      { kind: 'tree', path: root },
    ],
    onInvalidate: (inv) => invalidations.push(inv),
    subscribe,
    logger: { warn: () => {} },
  });

  try {
    assert.ok(await waitFor(() => subscriptions.length === 1), 'a duplicated tree root subscribes once');
    subscriptions[0].callback(null, [
      { type: 'update', path: join(root, 'a.jsonl') },
      { type: 'create', path: join(root, 'b.txt') },
    ]);
    // The package does not filter — extension filtering is the caller's job.
    assert.deepEqual(invalidations, [{
      type: 'paths',
      paths: [join(root, 'a.jsonl'), join(root, 'b.txt')],
    }]);
  } finally {
    await watcher.close();
  }
});

test('a missing tree root is retried quietly and repeatedly, then established with a rescan', async () => {
  const parent = makeTempDir('obelisk-adw-missing-');
  const root = join(parent, 'late-root');
  const timers = fakeTimers();
  const warns = [];
  const invalidations = [];
  let probeCalls = 0;
  const { subscriptions, subscribe } = fakeSubscribeStore();
  const watcher = createAdaptiveWatcher({
    targets: [{ kind: 'tree', path: root }],
    onInvalidate: (inv) => invalidations.push(inv),
    subscribe,
    // The real fs probe through the injection point: ENOENT is genuine.
    access: async (p) => { probeCalls += 1; return fs.promises.access(p); },
    timers,
    logger: { warn: (msg) => warns.push(msg) },
  });

  try {
    assert.ok(await waitFor(() => timers.pendingCount === 1), 'a missing root schedules a retry');
    assert.equal(probeCalls, 1);
    timers.flush();
    assert.ok(await waitFor(() => timers.pendingCount === 1), 'a missing root is retried');
    assert.equal(probeCalls, 2);
    timers.flush();
    assert.ok(await waitFor(() => timers.pendingCount === 1), 'the retry repeats while the root stays missing');
    assert.equal(probeCalls, 3);
    assert.deepEqual(warns, [], 'a missing root never logs a warning');

    fs.mkdirSync(root, { recursive: true });
    timers.flush();
    assert.ok(await waitFor(() => subscriptions.length === 1), 'the appeared root is subscribed');
    assert.ok(
      await waitFor(() => invalidations.some((inv) => inv.type === 'rescan')),
      'a late establishment emits rescan, not a guessed path list',
    );
    const rescan = invalidations.find((inv) => inv.type === 'rescan');
    assert.deepEqual(rescan.roots, [root]);
  } finally {
    await watcher.close();
  }
});

test('an inaccessible tree root warns once per failure, and again after a recurrence', async () => {
  const root = makeTempDir('obelisk-adw-denied-');
  const timers = fakeTimers();
  const warns = [];
  let denied = true;
  let probeCalls = 0;
  const { subscriptions, subscribe } = fakeSubscribeStore();
  const access = async () => {
    probeCalls += 1;
    if (!denied) return;
    const error = new Error('permission denied');
    error.code = 'EACCES';
    throw error;
  };
  const watcher = createAdaptiveWatcher({
    targets: [{ kind: 'tree', path: root }],
    onInvalidate: () => {},
    subscribe,
    access,
    timers,
    logger: { warn: (msg) => warns.push(msg) },
  });

  try {
    assert.ok(await waitFor(() => timers.pendingCount === 1), 'the first failure schedules a retry');
    assert.equal(warns.length, 1, 'the first failure warns');
    timers.flush();
    assert.ok(await waitFor(() => timers.pendingCount === 1));
    assert.equal(probeCalls, 2);
    timers.flush();
    assert.ok(await waitFor(() => timers.pendingCount === 1));
    assert.equal(probeCalls, 3);
    assert.equal(warns.length, 1, 'a permanent failure warns once, not on every retry tick');

    // The root recovers: it establishes (which clears the dedup entry)...
    denied = false;
    timers.flush();
    assert.ok(await waitFor(() => subscriptions.length === 1), 'the recovered root is subscribed');

    // ...then its stream dies (one warn for the death) and the retry finds
    // the root inaccessible again — reported again, because the dedup entry
    // was cleared on establishment.
    subscriptions[0].callback(new Error('stream died'), []);
    denied = true;
    assert.ok(await waitFor(() => timers.pendingCount === 1), 'the dead stream schedules a retry');
    timers.flush();
    assert.ok(
      await waitFor(() => warns.filter((msg) => msg.includes('cannot access')).length === 2),
      'the same access failure warns again after a recovery',
    );
  } finally {
    await watcher.close();
  }
});

test('file targets are polled for append, replacement, and disappearance — never subscribed', async () => {
  const root = makeTempDir('obelisk-adw-file-');
  const file = join(root, 'session_index.jsonl');
  const timers = fakeTimers();
  const invalidations = [];
  const { subscriptions, subscribe } = fakeSubscribeStore();
  let state = { dev: 1, ino: 11, size: 100, mtimeMs: 1000 };
  let missing = false;
  const stat = async () => {
    if (missing) {
      const error = new Error('no such file');
      error.code = 'ENOENT';
      throw error;
    }
    return { ...state };
  };
  const watcher = createAdaptiveWatcher({
    targets: [{ kind: 'file', path: file }],
    onInvalidate: (inv) => invalidations.push(inv),
    subscribe,
    stat,
    timers,
    logger: { warn: () => {} },
  });

  const tick = async () => {
    timers.flush();
    // A poll tick is async; the next timer is registered when it completes.
    assert.ok(await waitFor(() => timers.pendingCount === 1), 'the next poll tick is scheduled');
  };

  try {
    await tick();
    assert.deepEqual(invalidations, [], 'the first tick only sets the baseline');

    state = { ...state, size: 160, mtimeMs: 2000 };
    await tick();
    assert.deepEqual(invalidations, [{ type: 'paths', paths: [file] }], 'an append is detected');

    state = { dev: 1, ino: 22, size: 160, mtimeMs: 2000 };
    await tick();
    assert.equal(invalidations.length, 2, 'a same-size replacement is detected by identity');

    missing = true;
    await tick();
    assert.equal(invalidations.length, 3, 'a disappearance is detected');

    await tick();
    assert.equal(invalidations.length, 3, 'a still-missing file does not re-report');

    assert.equal(subscriptions.length, 0, 'a file target never reaches the tree backend');
  } finally {
    await watcher.close();
  }
});

test('close unsubscribes trees and leaves no timers behind', async () => {
  const root = makeTempDir('obelisk-adw-close-');
  const file = join(root, 'session_index.jsonl');
  const timers = fakeTimers();
  const { subscriptions, subscribe } = fakeSubscribeStore();
  const watcher = createAdaptiveWatcher({
    targets: [{ kind: 'tree', path: root }, { kind: 'file', path: file }],
    onInvalidate: () => {},
    subscribe,
    stat: async () => ({ dev: 1, ino: 1, size: 1, mtimeMs: 1 }),
    timers,
    logger: { warn: () => {} },
  });

  assert.ok(await waitFor(() => subscriptions.length === 1), 'the tree root is subscribed');
  assert.ok(timers.pendingCount > 0, 'the poll timer is scheduled');

  await watcher.close();
  assert.equal(subscriptions[0].unsubscribed, true, 'the tree subscription is released');
  assert.equal(timers.pendingCount, 0, 'no retry or poll timer survives close');
  timers.flush();
});
