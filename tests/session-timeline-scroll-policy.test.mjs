// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSessionTimelineScrollPolicy } from '../app/src/renderer/src/session-timeline-scroll-policy.mjs';

test('virtualizer scroll writes are discarded throughout a user scroll', () => {
  let scrolling = true;
  const element = { scrollTop: 100 };
  const writes = [];
  const suppressed = [];
  const instance = { scrollElement: element };
  const policy = createSessionTimelineScrollPolicy({
    isUserScrolling: () => scrolling,
    writeScroll: (offset, options) => {
      writes.push({ offset, ...options });
      element.scrollTop = offset + (options.adjustments || 0);
    },
    onSuppressedAdjustment: (offset, options) => {
      suppressed.push({ offset, ...options });
    },
  });

  policy.scrollToFn(100, { behavior: 'auto', adjustments: 24 }, instance);
  policy.scrollToFn(124, { behavior: 'auto' }, instance);
  assert.deepEqual(writes, [], 'momentum is never interrupted by a programmatic write');
  assert.deepEqual(
    suppressed,
    [{ offset: 100, behavior: 'auto', adjustments: 24 }],
    'measurement adjustments are exposed for compositor compensation',
  );

  scrolling = false;
  assert.equal(element.scrollTop, 100, 'scrollend never replays a suppressed correction');
  policy.scrollToFn(100, { behavior: 'auto', adjustments: 8 }, instance);
  assert.deepEqual(
    writes,
    [{ offset: 100, behavior: 'auto', adjustments: 8 }],
    'new corrections produced after scrollend remain available for live commits',
  );
});

test('explicit UUID and pagination navigation can bypass the user-scroll guard', () => {
  const element = { scrollTop: 100 };
  const writes = [];
  const instance = { scrollElement: element };
  const policy = createSessionTimelineScrollPolicy({
    isUserScrolling: () => true,
    writeScroll: (offset, options) => { writes.push({ offset, ...options }); },
  });

  policy.runExplicit(() => {
    policy.scrollToFn(720, { behavior: 'auto' }, instance);
  });

  assert.deepEqual(writes, [{ offset: 720, behavior: 'auto' }]);
});

test('settlement never replays a measurement correction from before the latest user scroll', () => {
  let scrolling = true;
  const element = { scrollTop: 100 };
  const writes = [];
  const instance = { scrollElement: element };
  const policy = createSessionTimelineScrollPolicy({
    isUserScrolling: () => scrolling,
    writeScroll: (offset, options) => {
      writes.push({ offset, ...options });
      element.scrollTop = offset + (options.adjustments || 0);
    },
  });

  policy.scrollToFn(100, { behavior: 'auto', adjustments: -24 }, instance);
  element.scrollTop = 300;
  scrolling = false;

  assert.deepEqual(writes, [], 'the completed gesture owns its final scroll position');
  assert.equal(element.scrollTop, 300, 'scrollend must not roll the viewport backward');
});
