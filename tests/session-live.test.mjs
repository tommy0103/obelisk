// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createSessionLiveState,
  consumeSessionDirty,
  markSessionDirty,
  noteSessionUpdated,
} from '../app/src/renderer/src/session-live.mjs';

test('session live state marks non-visible updated sessions as dirty', () => {
  const live = createSessionLiveState();

  const action = noteSessionUpdated(live, 'session-2', 'session-1');

  assert.deepEqual(action, { reload: false, sessionId: 'session-2' });
  assert.equal(consumeSessionDirty(live, 'session-2'), true);
  assert.equal(consumeSessionDirty(live, 'session-2'), false);
});

test('session live state reloads the visible session without leaving it dirty', () => {
  const live = createSessionLiveState();

  const action = noteSessionUpdated(live, 'session-1', 'session-1');

  assert.deepEqual(action, { reload: true, sessionId: 'session-1' });
  assert.equal(consumeSessionDirty(live, 'session-1'), false);
});

test('a rejected visible commit can put the session back into the dirty set', () => {
  const live = createSessionLiveState();

  noteSessionUpdated(live, 'session-1', 'session-1');
  markSessionDirty('session-1', live);

  assert.equal(consumeSessionDirty(live, 'session-1'), true);
});
