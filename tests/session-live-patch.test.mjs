// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applySessionPatch,
  createSessionPatch,
  createSessionPatchCursor,
} from '../app/src/shared/session-patch.mjs';

function snapshot(overrides = {}) {
  return {
    messages: [
      { uuid: 'message-1', timestamp: '2026-07-14T00:00:01Z', text: 'one' },
      { uuid: 'message-2', timestamp: '2026-07-14T00:00:02Z', text: 'two' },
    ],
    toolCalls: [{ id: 'call-1', message_uuid: 'message-1', name: 'exec', input_json: '"return 1"' }],
    toolResults: [{ tool_use_id: 'call-1', message_uuid: 'message-1', content: 'running', is_error: 0 }],
    subagents: [],
    workflows: [{ run_id: 'workflow-1', status: 'running', agents: [{ agent_id: 'agent-1', state: 'running' }] }],
    summaries: [],
    ...overrides,
  };
}

test('session patch returns only appended and updated rows, then reconstructs the new snapshot', () => {
  const current = snapshot();
  const cursor = createSessionPatchCursor(current);
  const next = snapshot({
    messages: [...current.messages, { uuid: 'message-3', timestamp: '2026-07-14T00:00:03Z', text: 'three' }],
    toolResults: [{ ...current.toolResults[0], content: 'complete' }],
  });

  const patch = createSessionPatch(next, cursor);

  assert.deepEqual(patch.changes.messages.map(row => row.uuid), ['message-3']);
  assert.deepEqual(patch.changes.toolResults.map(row => row.tool_use_id), ['call-1']);
  assert.deepEqual(patch.changes.toolCalls, []);
  assert.deepEqual(patch.removed.messages, []);
  assert.equal(patch.positions.messages['message-3'], 2);
  assert.deepEqual(applySessionPatch(current, cursor, patch), {
    snapshot: next,
    cursor: createSessionPatchCursor(next),
  });
});

test('session patch reports removals and nested workflow updates', () => {
  const current = snapshot();
  const cursor = createSessionPatchCursor(current);
  const next = snapshot({
    messages: [current.messages[1]],
    workflows: [{ run_id: 'workflow-1', status: 'complete', agents: [{ agent_id: 'agent-1', state: 'complete' }] }],
  });

  const patch = createSessionPatch(next, cursor);

  assert.deepEqual(patch.removed.messages, ['message-1']);
  assert.deepEqual(patch.changes.workflows, next.workflows);
  assert.deepEqual(applySessionPatch(current, cursor, patch).snapshot, next);
});

test('session patch repositions existing rows when their content is unchanged', () => {
  const current = snapshot();
  const cursor = createSessionPatchCursor(current);
  const next = snapshot({
    messages: [current.messages[1], current.messages[0]],
  });

  const patch = createSessionPatch(next, cursor);

  assert.deepEqual(applySessionPatch(current, cursor, patch).snapshot, next);
});

test('session patch cursor is compact and never carries transcript content', () => {
  const largeText = 'private transcript content '.repeat(1000);
  const current = snapshot({
    messages: [{ uuid: 'message-large', timestamp: '2026-07-14T00:00:00Z', text: largeText }],
    toolResults: [{ tool_use_id: 'call-large', message_uuid: 'message-large', content: largeText, is_error: 0 }],
  });

  const cursor = createSessionPatchCursor(current);
  const serializedCursor = JSON.stringify(cursor);

  assert.equal(serializedCursor.includes('private transcript content'), false);
  assert.ok(serializedCursor.length < JSON.stringify(current).length / 20);
});
