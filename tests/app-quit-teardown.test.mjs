// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Behavior tests for the deferred quit (#187). The race itself lives in
// process teardown and cannot be asserted here; what can be pinned is the
// contract the quit path depends on: the first request is prevented and
// re-issued only after the stop settles or the bound elapses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeferredQuit } from '../app/src/main/quit-teardown.ts';

async function waitFor(cond, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return cond();
}

function fakeEvent() {
  return {
    prevented: false,
    preventDefault() { this.prevented = true; },
  };
}

test('the first quit request is deferred until the stop settles, then re-issued', async () => {
  let quits = 0;
  let resolveStop = null;
  const beforeQuit = createDeferredQuit({
    quit: () => { quits += 1; },
    stop: () => new Promise((resolve) => { resolveStop = resolve; }),
  });

  const event = fakeEvent();
  beforeQuit(event);
  assert.equal(event.prevented, true, 'the first quit request is prevented');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(quits, 0, 'no quit while the stop is pending');

  resolveStop();
  assert.ok(await waitFor(() => quits === 1), 'quit is re-issued once the stop settles');
});

test('a re-entrant quit request passes through without preventing or double-stopping', async () => {
  let quits = 0;
  let stops = 0;
  const beforeQuit = createDeferredQuit({
    quit: () => { quits += 1; },
    stop: () => { stops += 1; return Promise.resolve(); },
  });

  beforeQuit(fakeEvent());
  const reentrant = fakeEvent();
  beforeQuit(reentrant);
  assert.equal(reentrant.prevented, false, 'the re-entrant quit is not prevented');
  assert.equal(stops, 1, 'stop runs once');
  assert.ok(await waitFor(() => quits === 1));
});

test('a wedged stop is bounded: quit proceeds after boundMs', async () => {
  let quits = 0;
  const beforeQuit = createDeferredQuit({
    quit: () => { quits += 1; },
    stop: () => new Promise(() => {}),
    boundMs: 30,
  });

  beforeQuit(fakeEvent());
  assert.equal(quits, 0);
  assert.ok(await waitFor(() => quits === 1), 'quit proceeds once the bound elapses');
});

test('a rejected stop still ends in quit', async () => {
  let quits = 0;
  const beforeQuit = createDeferredQuit({
    quit: () => { quits += 1; },
    stop: () => Promise.reject(new Error('stop failed')),
  });

  beforeQuit(fakeEvent());
  assert.ok(await waitFor(() => quits === 1), 'a failed stop does not block quit');
});
