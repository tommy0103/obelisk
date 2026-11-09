// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reconcileTimelineItems } from '../app/src/renderer/src/session-timeline-items.mjs';

function message(uuid, overrides = {}) {
  return {
    uuid,
    type: 'assistant',
    text: 'message',
    tool_calls: [],
    ...overrides,
  };
}

test('timeline items preserve the rendered order and identity of every navigable root', () => {
  const messages = [
    message('meta', { is_meta: 1 }),
    message('workflow', {
      text: '',
      tool_calls: [
        { id: 'workflow-call', name: 'Workflow', workflow: { workflow_name: 'Build' } },
        { id: 'bash-call', name: 'Bash' },
      ],
    }),
    message('skill', {
      text: '',
      tool_calls: [{ id: 'skill-call', name: 'Skill' }],
    }),
    message('thinking', { content_type: 'thinking' }),
    message('normal'),
  ];

  const items = reconcileTimelineItems([], messages);

  assert.deepEqual(items.map(item => ({
    key: item.key,
    kind: item.kind,
    anchorUuid: item.anchorUuid,
    messageUuid: item.messageUuid,
  })), [
    { key: 'meta:meta', kind: 'meta', anchorUuid: 'meta', messageUuid: 'meta' },
    { key: 'workflow:workflow', kind: 'workflow', anchorUuid: 'workflow', messageUuid: 'workflow' },
    { key: 'workflow-tools:workflow', kind: 'workflow-tools', anchorUuid: 'workflow-tools', messageUuid: 'workflow' },
    { key: 'skill:skill', kind: 'skill', anchorUuid: 'skill', messageUuid: 'skill' },
    { key: 'thinking:thinking', kind: 'thinking', anchorUuid: 'thinking', messageUuid: 'thinking' },
    { key: 'message:normal', kind: 'message', anchorUuid: 'normal', messageUuid: 'normal' },
  ]);
  assert.equal(items[1].workflowCall.id, 'workflow-call');
  assert.deepEqual(items[2].toolCalls.map(call => call.id), ['bash-call']);
});

test('snapshot reconciliation reuses unchanged timeline items and replaces only updated roots', () => {
  const first = message('first');
  const second = message('second');
  const initial = reconcileTimelineItems([], [first, second]);
  const updatedSecond = { ...second, text: 'updated' };

  const reconciled = reconcileTimelineItems(initial, [first, updatedSecond]);

  assert.equal(reconciled[0], initial[0]);
  assert.notEqual(reconciled[1], initial[1]);
  assert.equal(reconciled[1].message, updatedSecond);
});

test('tail appends do not rebuild existing timeline items', () => {
  const existingMessages = Array.from({ length: 1000 }, (_, index) => message(`message-${index}`));
  const initial = reconcileTimelineItems([], existingMessages);
  const appended = reconcileTimelineItems(initial, [
    ...existingMessages,
    message('message-1000'),
  ]);

  assert.equal(appended.length, 1001);
  assert.equal(appended[0], initial[0]);
  assert.equal(appended[999], initial[999]);
  assert.equal(appended[1000].key, 'message:message-1000');
});
