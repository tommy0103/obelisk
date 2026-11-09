// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSessionUserScroll } from '../app/src/renderer/src/session-user-scroll.mjs';

function createScheduler() {
  let now = 0;
  let nextId = 1;
  const tasks = new Map();
  return {
    setTimeout(callback, delay) {
      const id = nextId++;
      tasks.set(id, { callback, due: now + delay });
      return id;
    },
    clearTimeout(id) {
      tasks.delete(id);
    },
    advance(milliseconds) {
      now += milliseconds;
      while (true) {
        const ready = [...tasks.entries()]
          .filter(([, task]) => task.due <= now)
          .sort((left, right) => left[1].due - right[1].due)[0];
        if (!ready) return;
        tasks.delete(ready[0]);
        ready[1].callback();
      }
    },
  };
}

function dispatch(target, type, properties = {}) {
  const event = new Event(type);
  for (const [key, value] of Object.entries(properties)) {
    Object.defineProperty(event, key, { value });
  }
  target.dispatchEvent(event);
}

test('native scrollend ends a user scroll after a short wheel-burst grace period', () => {
  const scheduler = createScheduler();
  const target = new EventTarget();
  target.scrollTop = 100;
  target.onscrollend = null;
  let ended = 0;
  const userScroll = createSessionUserScroll({
    quietMs: 450,
    scrollEndGraceMs: 100,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
    onEnd: () => { ended++; },
  });

  userScroll.attach(target);
  dispatch(target, 'wheel', { deltaY: -24 });
  assert.equal(userScroll.isActive(), true);
  assert.equal(userScroll.hasUpwardIntent(), true);

  scheduler.advance(150);
  assert.equal(userScroll.isActive(), true, '150ms silence must not end native momentum');
  assert.equal(ended, 0);

  dispatch(target, 'scrollend');
  scheduler.advance(99);
  assert.equal(userScroll.isActive(), true, 'a following wheel packet can retain scroll ownership');
  scheduler.advance(1);
  assert.equal(userScroll.isActive(), false);
  assert.equal(ended, 1);

  userScroll.detach();
  dispatch(target, 'wheel', { deltaY: 12 });
  assert.equal(userScroll.isActive(), false, 'detached controllers ignore later DOM events');
});

test('unsupported scrollend falls back to a 450ms quiet window', () => {
  const scheduler = createScheduler();
  const target = new EventTarget();
  target.scrollTop = 0;
  let ended = 0;
  const userScroll = createSessionUserScroll({
    quietMs: 450,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
    onEnd: () => { ended++; },
  });

  userScroll.attach(target);
  dispatch(target, 'wheel', { deltaY: 12 });
  scheduler.advance(449);
  assert.equal(userScroll.isActive(), true);
  scheduler.advance(1);
  assert.equal(userScroll.isActive(), false);
  assert.equal(ended, 1);
});

test('a missed native scrollend still settles through the quiet watchdog', () => {
  const scheduler = createScheduler();
  const target = new EventTarget();
  target.scrollTop = 0;
  target.onscrollend = null;
  let ended = 0;
  const userScroll = createSessionUserScroll({
    quietMs: 450,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
    onEnd: () => { ended++; },
  });

  userScroll.attach(target);
  dispatch(target, 'wheel', { deltaY: -12 });
  scheduler.advance(450);

  assert.equal(userScroll.isActive(), false);
  assert.equal(ended, 1, 'a boundary wheel cannot freeze live commits forever');
});

test('downward wheel intent re-enables tail following after an upward escape', () => {
  const target = new EventTarget();
  target.scrollTop = 100;
  target.onscrollend = null;
  const userScroll = createSessionUserScroll();
  userScroll.attach(target);

  dispatch(target, 'wheel', { deltaY: -1 });
  assert.equal(userScroll.hasUpwardIntent(), true);
  dispatch(target, 'wheel', { deltaY: 1 });
  assert.equal(userScroll.hasUpwardIntent(), false);
  userScroll.detach();
});
