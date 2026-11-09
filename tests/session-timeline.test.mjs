// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applySnapshot } from '../app/src/renderer/src/session-timeline.mjs';

test('tail append reuses 908 existing messages without writing to them', () => {
  let oldMessageWrites = 0;
  const current = Array.from({ length: 908 }, (_, index) => new Proxy({
    uuid: `message-${index}`,
    type: index % 2 === 0 ? 'user' : 'assistant',
    text: `message ${index}`,
  }, {
    set(target, property, value) {
      oldMessageWrites++;
      return Reflect.set(target, property, value);
    },
  }));
  const incoming = [
    ...current.map(message => ({ ...message })),
    { uuid: 'message-908', type: 'assistant', text: 'new tail' },
  ];

  const result = applySnapshot(current, incoming);

  assert.equal(result.messages.length, 909);
  for (let index = 0; index < current.length; index++) {
    assert.equal(result.messages[index], current[index]);
  }
  assert.equal(oldMessageWrites, 0);
  assert.deepEqual(result.addedIds, ['message-908']);
  assert.deepEqual(result.updatedIds, []);
  assert.deepEqual(result.removedIds, []);
  assert.equal(result.changed, true);
  assert.equal(result.tailOnly, true);
});

test('a completed tool result replaces only its owning message', () => {
  const first = { uuid: 'message-1', type: 'user', text: 'run it' };
  const second = {
    uuid: 'message-2',
    type: 'assistant',
    tool_calls: [{ id: 'call-1', name: 'Bash', result: null }],
  };
  const third = { uuid: 'message-3', type: 'assistant', text: 'waiting' };
  const incomingSecond = {
    uuid: 'message-2',
    type: 'assistant',
    tool_calls: [{ id: 'call-1', name: 'Bash', result: { content: 'done' } }],
  };

  const result = applySnapshot(
    [first, second, third],
    [{ ...first }, incomingSecond, { ...third }],
  );

  assert.equal(result.messages[0], first);
  assert.equal(result.messages[1], incomingSecond);
  assert.equal(result.messages[2], third);
  assert.deepEqual(result.updatedIds, ['message-2']);
  assert.deepEqual(result.addedIds, []);
  assert.deepEqual(result.removedIds, []);
  assert.equal(result.changed, true);
  assert.equal(result.tailOnly, false);
});

test('an identical snapshot returns the original array', () => {
  const current = [
    { uuid: 'message-1', text: 'same', tool_calls: [{ id: 'call-1' }] },
    { uuid: 'message-2', text: 'same too' },
  ];

  const result = applySnapshot(current, structuredClone(current));

  assert.equal(result.messages, current);
  assert.deepEqual(result.addedIds, []);
  assert.deepEqual(result.updatedIds, []);
  assert.deepEqual(result.removedIds, []);
  assert.equal(result.changed, false);
  assert.equal(result.tailOnly, false);
});

test('removals and reorders preserve matching identities without claiming a tail append', () => {
  const first = { uuid: 'message-1', text: 'first' };
  const second = { uuid: 'message-2', text: 'second' };
  const removed = applySnapshot([first, second], [{ ...second }]);

  assert.deepEqual(removed.removedIds, ['message-1']);
  assert.equal(removed.messages[0], second);
  assert.equal(removed.tailOnly, false);

  const reordered = applySnapshot(
    [first, second],
    [{ ...second }, { ...first }],
  );
  assert.equal(reordered.messages[0], second);
  assert.equal(reordered.messages[1], first);
  assert.deepEqual(reordered.addedIds, []);
  assert.deepEqual(reordered.updatedIds, []);
  assert.deepEqual(reordered.removedIds, []);
  assert.equal(reordered.changed, true);
  assert.equal(reordered.tailOnly, false);
});
