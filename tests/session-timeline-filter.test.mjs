// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  filterSessionTimelineItems,
  normalizeSessionTimelineVisibility,
} from '../app/src/renderer/src/session-timeline-filter.mjs';

function item(kind, uuid, message = {}) {
  return {
    key: `${kind}:${uuid}`,
    kind,
    messageUuid: uuid,
    message: {
      uuid,
      type: 'assistant',
      text: '',
      tool_calls: [],
      ...message,
    },
  };
}

test('timeline visibility defaults every content type to visible', () => {
  assert.deepEqual(normalizeSessionTimelineVisibility(), {
    tools: true,
    thinking: true,
  });
  assert.deepEqual(normalizeSessionTimelineVisibility({ tools: false }), {
    tools: false,
    thinking: true,
  });
});

test('tool filtering removes tool-only roots without hiding mixed text messages', () => {
  const items = [
    item('meta', 'meta'),
    item('workflow', 'workflow'),
    item('workflow-tools', 'workflow-tools'),
    item('skill', 'skill'),
    item('message', 'tool-only', { tool_calls: [{ id: 'call-1', name: 'Bash' }] }),
    item('message', 'mixed', {
      text: 'The command completed.',
      tool_calls: [{ id: 'call-2', name: 'Bash' }],
    }),
  ];

  const visible = filterSessionTimelineItems(items, { tools: false, thinking: true });

  assert.deepEqual(visible.map(entry => entry.messageUuid), ['meta', 'mixed']);
  assert.equal(visible[1], items[5]);
});

test('thinking filtering removes standalone thinking while preserving message content', () => {
  const items = [
    item('thinking', 'thinking'),
    item('message', 'thinking-only', { _thinking: 'private reasoning' }),
    item('message', 'mixed', { text: 'Public answer', _thinking: 'private reasoning' }),
    item('message', 'summary', { summary: 'Session summary' }),
  ];

  const visible = filterSessionTimelineItems(items, { tools: true, thinking: false });

  assert.deepEqual(visible.map(entry => entry.messageUuid), ['mixed', 'summary']);
});

test('turning off both extras can produce a recoverable empty timeline', () => {
  const items = [
    item('thinking', 'thinking'),
    item('message', 'tool-only', { tool_calls: [{ id: 'call-1', name: 'Bash' }] }),
  ];

  assert.deepEqual(
    filterSessionTimelineItems(items, { tools: false, thinking: false }),
    [],
  );
});
