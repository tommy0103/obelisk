// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSessionReaderStateCache } from '../app/src/renderer/src/session-reader-state.mjs';
import { resolveReaderAnchorIndex } from '../app/src/renderer/src/session-timeline-viewport.mjs';

test('reader state cache stores only semantic state in independent session snapshots', () => {
  const cache = createSessionReaderStateCache({ maxEntries: 4 });

  cache.set('session-a', {
    mode: 'anchor',
    anchor: {
      itemKey: 'message:a-120',
      messageUuid: 'a-120',
      offset: 18,
      fallbackIndex: 120,
    },
    disclosures: [{ key: 'tool:a-call', messageUuid: 'a-120', open: true, raw: false }],
    expandedMessageIds: ['a-120'],
    scrollTop: 98_000,
    currentMsgIdx: 120,
  });

  const restored = cache.get('session-a');
  assert.deepEqual(restored, {
    mode: 'anchor',
    anchor: {
      itemKey: 'message:a-120',
      messageUuid: 'a-120',
      offset: 18,
      fallbackIndex: 120,
    },
    disclosures: [{ key: 'tool:a-call', messageUuid: 'a-120', open: true, raw: false }],
    expandedMessageIds: ['a-120'],
  });
  assert.equal(cache.get('session-b'), null);

  restored.anchor.offset = 999;
  restored.disclosures[0].open = false;
  restored.expandedMessageIds.push('mutated');
  assert.equal(cache.get('session-a').anchor.offset, 18);
  assert.equal(cache.get('session-a').disclosures[0].open, true);
  assert.deepEqual(cache.get('session-a').expandedMessageIds, ['a-120']);
});

test('reader state cache evicts the least recently used session', () => {
  const cache = createSessionReaderStateCache({ maxEntries: 2 });
  const state = messageUuid => ({
    mode: 'anchor',
    anchor: { itemKey: `message:${messageUuid}`, messageUuid, offset: 0, fallbackIndex: 0 },
  });

  cache.set('session-a', state('a'));
  cache.set('session-b', state('b'));
  cache.get('session-a');
  cache.set('session-c', state('c'));

  assert.equal(cache.get('session-b'), null);
  assert.equal(cache.get('session-a').anchor.messageUuid, 'a');
  assert.equal(cache.get('session-c').anchor.messageUuid, 'c');
});

test('reader anchors resolve by stable identity before falling back to position', () => {
  const items = [
    { key: 'message:first', messageUuid: 'first' },
    { key: 'workflow:shared', messageUuid: 'shared' },
    { key: 'message:shared', messageUuid: 'shared' },
    { key: 'message:last', messageUuid: 'last' },
  ];

  assert.equal(resolveReaderAnchorIndex({
    itemKey: 'message:shared',
    messageUuid: 'shared',
    fallbackIndex: 0,
  }, items), 2);
  assert.equal(resolveReaderAnchorIndex({
    itemKey: 'missing',
    messageUuid: 'shared',
    fallbackIndex: 0,
  }, items), 1);
  assert.equal(resolveReaderAnchorIndex({
    itemKey: 'missing',
    messageUuid: 'missing',
    fallbackIndex: 99,
  }, items), 3);
  assert.equal(resolveReaderAnchorIndex(null, items), 0);
  assert.equal(resolveReaderAnchorIndex(null, []), null);
});
