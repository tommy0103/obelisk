// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createGlobalDataRefreshCoordinator } from '../app/src/renderer/src/session-global-refresh.mjs';

test('conversation detail defers and coalesces global catalogue invalidations until route exit', async () => {
  let conversationDetailActive = true;
  let loads = 0;
  const coordinator = createGlobalDataRefreshCoordinator({
    isDeferred: () => conversationDetailActive,
    load: async () => ++loads,
    commit: () => {},
  });

  await coordinator.invalidate();
  await coordinator.invalidate();
  await coordinator.invalidate();
  assert.equal(loads, 0, 'detail updates never start a global catalogue IPC');

  conversationDetailActive = false;
  await coordinator.flush();
  assert.equal(loads, 1, 'route exit loads the latest invalidation exactly once');

  await coordinator.flush();
  assert.equal(loads, 1, 'an idle route flush is a no-op');
});

test('initial catalogue load is allowed on a cold conversation route', async () => {
  let loads = 0;
  const coordinator = createGlobalDataRefreshCoordinator({
    isDeferred: () => true,
    load: async () => ++loads,
    commit: () => {},
  });

  await coordinator.initialize();
  assert.equal(loads, 1, 'deep links still receive the catalogue needed to resolve the session');

  await coordinator.invalidate();
  assert.equal(loads, 1, 'later daemon invalidations remain deferred');
});

test('an invalidation arriving during a load is retained without overlapping loads', async () => {
  let deferred = false;
  let loads = 0;
  let activeLoads = 0;
  let maxActiveLoads = 0;
  let releaseFirstLoad;
  const firstLoadGate = new Promise(resolve => { releaseFirstLoad = resolve; });
  const coordinator = createGlobalDataRefreshCoordinator({
    isDeferred: () => deferred,
    load: async () => {
      loads++;
      activeLoads++;
      maxActiveLoads = Math.max(maxActiveLoads, activeLoads);
      if (loads === 1) await firstLoadGate;
      activeLoads--;
      return loads;
    },
    commit: () => {},
  });

  const first = coordinator.invalidate();
  const second = coordinator.invalidate();
  deferred = true;
  releaseFirstLoad();
  await Promise.all([first, second]);

  assert.equal(loads, 1, 'detail activation prevents the queued reload');
  assert.equal(maxActiveLoads, 1, 'global snapshots never overlap');

  deferred = false;
  await coordinator.flush();
  assert.equal(loads, 2, 'route exit catches up with the retained invalidation');
});

test('a failed catalogue load remains dirty for the next flush', async () => {
  let loads = 0;
  const coordinator = createGlobalDataRefreshCoordinator({
    isDeferred: () => false,
    load: async () => {
      loads++;
      if (loads === 1) throw new Error('temporary IPC failure');
      return loads;
    },
    commit: () => {},
  });

  await assert.rejects(coordinator.invalidate(), /temporary IPC failure/);
  await coordinator.flush();
  assert.equal(loads, 2, 'the failed invalidation is retried instead of being lost');
});

test('a catalogue fetched before navigation never commits inside conversation detail', async () => {
  let deferred = false;
  let loads = 0;
  let releaseLoad;
  const loadGate = new Promise(resolve => { releaseLoad = resolve; });
  const commits = [];
  const coordinator = createGlobalDataRefreshCoordinator({
    isDeferred: () => deferred,
    load: async () => {
      loads++;
      await loadGate;
      return 'catalogue-snapshot';
    },
    commit: snapshot => { commits.push(snapshot); },
  });

  const request = coordinator.invalidate();
  deferred = true;
  releaseLoad();
  await request;

  assert.equal(loads, 1);
  assert.deepEqual(commits, [], 'route activation gates the reactive commit after IPC resolves');

  deferred = false;
  await coordinator.flush();
  assert.equal(loads, 1, 'the already-fetched snapshot is reused');
  assert.deepEqual(commits, ['catalogue-snapshot']);
});
