// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSessionLiveReloadCoordinator } from '../app/src/renderer/src/session-live-reload.mjs';
import { state } from '../app/src/renderer/src/store.js';
import {
  fetchSessionDetailPatch,
  getCachedSessionDetail,
  loadSessionDetail,
  materializeSessionDetailPatch,
} from '../app/src/renderer/src/data.js';
import { assembleSessionDetail } from '../app/src/shared/session-detail-assembly.mjs';
import { createSessionPatch } from '../app/src/shared/session-patch.mjs';

test('live updates coalesce while scrolling and load only the latest after scroll end', async () => {
  let scrolling = true;
  let loads = 0;
  const commits = [];
  const coordinator = createSessionLiveReloadCoordinator({
    isScrolling: () => scrolling,
    load: async () => ++loads,
    commit: async snapshot => { commits.push(snapshot); },
  });

  await coordinator.request();
  await coordinator.request();
  await coordinator.request();
  assert.equal(loads, 0, 'patch preparation stays off the scrolling renderer task budget');
  assert.deepEqual(commits, []);

  scrolling = false;
  await coordinator.flush();
  assert.equal(loads, 1, 'scroll end loads the latest coalesced state once');
  assert.deepEqual(commits, [1]);

  await coordinator.flush();
  assert.equal(loads, 1, 'an idle flush without another update is a no-op');
});

test('an update arriving during an in-flight load skips the stale snapshot without overlap', async () => {
  let releaseFirstLoad;
  let activeLoads = 0;
  let maxActiveLoads = 0;
  let loads = 0;
  const commits = [];
  const firstLoadGate = new Promise(resolve => { releaseFirstLoad = resolve; });
  const coordinator = createSessionLiveReloadCoordinator({
    isScrolling: () => false,
    load: async () => {
      loads++;
      activeLoads++;
      maxActiveLoads = Math.max(maxActiveLoads, activeLoads);
      if (loads === 1) await firstLoadGate;
      activeLoads--;
      return loads;
    },
    commit: async snapshot => { commits.push(snapshot); },
  });

  const first = coordinator.request();
  const second = coordinator.request();
  releaseFirstLoad();
  await Promise.all([first, second]);

  assert.equal(loads, 2);
  assert.equal(maxActiveLoads, 1, 'snapshot loads remain serialized');
  assert.deepEqual(commits, [2], 'only the freshest loaded snapshot is committed');
});

test('scrolling that starts during IPC defers the loaded snapshot commit', async () => {
  let scrolling = false;
  let releaseLoad;
  let loads = 0;
  const commits = [];
  const loadGate = new Promise(resolve => { releaseLoad = resolve; });
  const coordinator = createSessionLiveReloadCoordinator({
    isScrolling: () => scrolling,
    load: async () => {
      loads++;
      await loadGate;
      return 'loaded-before-scroll-ended';
    },
    commit: async snapshot => { commits.push(snapshot); },
  });

  const request = coordinator.request();
  scrolling = true;
  releaseLoad();
  await request;

  assert.equal(loads, 1);
  assert.deepEqual(commits, []);

  scrolling = false;
  await coordinator.flush();
  assert.equal(loads, 1, 'the already-loaded snapshot is reused');
  assert.deepEqual(commits, ['loaded-before-scroll-ended']);
});

test('a skipped live patch does not advance the visible patch baseline', async t => {
  const sessionId = 'coalesced-patch-session';
  const previousSessions = state.sessions;
  t.after(() => {
    state.sessions = previousSessions;
    state.sessionTitleOverrides.delete(sessionId);
    delete globalThis.window;
  });
  let rows = [
    { uuid: 'message-1', type: 'user', timestamp: '2026-07-14T00:00:01Z', text: 'one' },
  ];
  let patchCalls = 0;
  let releaseFirstPatch;
  let firstPatchStarted;
  const firstPatchGate = new Promise(resolve => { releaseFirstPatch = resolve; });
  const firstPatchReady = new Promise(resolve => { firstPatchStarted = resolve; });

  globalThis.window = {
    obelisk: {
      getSessionMessages: async () => rows,
      getSessionToolCalls: async () => [],
      getSessionToolResults: async () => [],
      getSessionSubagents: async () => [],
      getSessionWorkflows: async () => [],
      getSessionSummaries: async () => [],
      getSessionPatch: async (_id, cursor) => {
        const snapshotAtCall = { messages: assembleSessionDetail({
          messages: rows,
          toolCalls: [],
          toolResults: [],
          subagents: [],
          workflows: [],
        }).messages, workflows: [] };
        patchCalls++;
        if (patchCalls === 1) {
          firstPatchStarted();
          await firstPatchGate;
        }
        return {
          ...createSessionPatch(snapshotAtCall, cursor),
          session: {
            id: sessionId,
            title: 'Live session title',
            message_count: rows.length,
          },
        };
      },
    },
  };
  state.sessions = [{ id: sessionId, title: 'Initial title', message_count: 1, messages: [] }];
  await loadSessionDetail(sessionId);

  const commits = [];
  const coordinator = createSessionLiveReloadCoordinator({
    isScrolling: () => false,
    load: async () => materializeSessionDetailPatch(await fetchSessionDetailPatch(sessionId)),
    commit: async latest => {
      commits.push({
        messages: latest.messages.map(message => message.uuid),
        changedIds: latest.messagePatch.changedIds,
        title: latest.title,
        messageCount: latest.message_count,
      });
      latest.acceptMessagePatch?.();
    },
  });

  rows = [...rows, { uuid: 'message-2', type: 'assistant', timestamp: '2026-07-14T00:00:02Z', text: 'two' }];
  const first = coordinator.request();
  await firstPatchReady;
  rows = [...rows, { uuid: 'message-3', type: 'assistant', timestamp: '2026-07-14T00:00:03Z', text: 'three' }];
  const second = coordinator.request();
  releaseFirstPatch();
  await Promise.all([first, second]);

  assert.deepEqual(commits, [{
    messages: ['message-1', 'message-2', 'message-3'],
    changedIds: ['message-2', 'message-3'],
    title: 'Live session title',
    messageCount: 3,
  }]);
  assert.deepEqual(
    getCachedSessionDetail(sessionId).messages.map(message => message.uuid),
    ['message-1', 'message-2', 'message-3'],
    'accepted patches become the reusable session-detail snapshot',
  );
  assert.deepEqual(
    {
      title: getCachedSessionDetail(sessionId).title,
      messageCount: getCachedSessionDetail(sessionId).message_count,
    },
    { title: 'Live session title', messageCount: 3 },
    'accepted patches retain the current session metadata without a global catalogue reload',
  );
  assert.deepEqual(
    state.sessions.find(session => session.id === sessionId).messages,
    [],
    'the stale full-snapshot copy is invalidated after patch acceptance',
  );
  assert.deepEqual(
    state.sessionTitleOverrides.get(sessionId),
    'Live session title',
    'accepted title changes update the shared breadcrumb/window-title overlay after the visible commit',
  );

  const evictionSessionIds = ['eviction-session-1', 'eviction-session-2', 'eviction-session-3'];
  state.sessions.push(...evictionSessionIds.map(id => ({ id, messages: [] })));
  for (const id of evictionSessionIds) await loadSessionDetail(id);

  assert.equal(getCachedSessionDetail(sessionId), null, 'the oldest accepted snapshot is evicted by the bounded cache');
  assert.deepEqual(
    state.sessions.find(session => session.id === sessionId).messages,
    [],
    'an evicted session cannot fall back to stale initial messages and must reload',
  );
});
