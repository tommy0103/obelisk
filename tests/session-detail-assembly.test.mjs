import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleSessionDetail } from '../app/src/shared/session-detail-assembly.mjs';

test('session assembly preserves thinking and attaches tool result and subagent evidence', () => {
  const messages = [
    {
      uuid: 'thinking-1', timestamp: '2026-06-10T10:00:00Z',
      type: 'assistant', content_type: 'thinking', text: 'reasoning',
    },
    {
      uuid: 'answer-1', timestamp: '2026-06-10T10:00:01Z',
      type: 'assistant', content_type: 'text', text: 'answer',
    },
    {
      uuid: 'tool-1', timestamp: '2026-06-10T10:00:02Z',
      type: 'assistant', content_type: 'tool_use', text: '',
    },
    {
      uuid: 'result-1', timestamp: '2026-06-10T10:00:03Z',
      type: 'user', content_type: 'tool_result', text: '',
    },
  ];
  const assembled = assembleSessionDetail({
    messages,
    toolCalls: [{ id: 'call-1', message_uuid: 'tool-1', name: 'Agent', input_json: '{"description":"inspect"}' }],
    toolResults: [{ tool_use_id: 'call-1', message_uuid: 'result-1', content: 'done', is_error: 0 }],
    subagents: [{ agent_id: 'agent-1', parent_tool_use_id: 'call-1', agent_type: 'reviewer', description: 'inspect' }],
    workflows: [],
  }).messages;

  assert.equal(assembled.length, 1);
  assert.equal(assembled[0].uuid, 'answer-1');
  assert.equal(assembled[0]._thinking, 'reasoning');
  assert.deepEqual(assembled[0].tool_calls[0].result.content, 'done');
  assert.equal(assembled[0].tool_calls[0].subagent.agent_id, 'agent-1');
});

test('orphan tool results stay out of the timeline and do not break assistant merging', () => {
  const assembled = assembleSessionDetail({
    messages: [
      { uuid: 'answer', type: 'assistant', content_type: 'text', text: 'answer' },
      { uuid: 'orphan-result', type: 'user', content_type: 'tool_result', text: '' },
      { uuid: 'tool', type: 'assistant', content_type: 'tool_use', text: '' },
    ],
    toolCalls: [{
      id: 'call',
      message_uuid: 'tool',
      name: 'Read',
      input_json: '{"path":"/tmp/file"}',
    }],
    toolResults: [{
      tool_use_id: 'missing-call',
      message_uuid: '',
      content: 'orphaned failure',
      is_error: 1,
    }],
  }).messages;

  assert.equal(assembled.length, 1);
  assert.equal(assembled[0].uuid, 'answer');
  assert.deepEqual(assembled[0].tool_calls.map(call => call.id), ['call']);
});

test('session assembly keeps Skill evidence standalone and embeds matching workflow agents', () => {
  const assembled = assembleSessionDetail({
    messages: [
      { uuid: 'skill-1', type: 'assistant', content_type: 'tool_use', text: '' },
      { uuid: 'skill-md', type: 'user', content_type: 'skill_instructions', is_meta: 1, text: '# Skill instructions' },
      { uuid: 'workflow-1', type: 'assistant', content_type: 'tool_use', text: '' },
    ],
    toolCalls: [
      { id: 'call-skill', message_uuid: 'skill-1', name: 'Skill', presentation: 'skill', input_json: '{"skill":"obelisk"}' },
      { id: 'call-workflow', message_uuid: 'workflow-1', name: 'Workflow', presentation: 'default', input_json: '{}' },
    ],
    toolResults: [{ tool_use_id: 'call-workflow', content: 'complete', is_error: 0 }],
    subagents: [],
    workflows: [{
      run_id: 'run-1',
      parent_tool_use_id: 'call-workflow',
      workflow_name: 'review',
      status: 'complete',
      agents: [{ agent_id: 'agent-1', phase: 'review', label: 'Reviewer', state: 'complete' }],
    }],
  }).messages;

  assert.equal(assembled[0]._skillMd, '# Skill instructions');
  assert.equal(assembled[1].tool_calls[0].workflow.run_id, 'run-1');
  assert.deepEqual(assembled[1].tool_calls[0].workflow.agents, [{
    agent_id: 'agent-1',
    phase: 'review',
    label: 'Reviewer',
    state: 'complete',
    tokens: null,
    duration_ms: null,
  }]);
});

test('session assembly trusts canonical classification instead of parsing provider text', () => {
  const detail = assembleSessionDetail({
    messages: [{
      uuid: 'provider-owned-classification',
      type: 'user',
      content_type: 'text',
      is_meta: 0,
      text: '<system-reminder>text alone does not define presentation semantics</system-reminder>',
    }],
  });

  assert.equal(detail.messages[0].is_meta, 0);
});

test('canonical ordering is stable across provider and SQLite iteration order', () => {
  const detail = assembleSessionDetail([
    {
      kind: 'message', uuid: 'b', session_id: 'session', type: 'user', parent_uuid: null,
      timestamp: '2026-06-10T10:00:00Z', role: 'user', text: 'second', content_type: 'text',
      is_meta: 0, visibility: 'visible', model: null, is_sidechain: 0, agent_id: null,
      input_tokens: null, output_tokens: null, cwd: null, skill: null, source: 'test',
    },
    {
      kind: 'message', uuid: 'a', session_id: 'session', type: 'user', parent_uuid: null,
      timestamp: '2026-06-10T10:00:00Z', role: 'user', text: 'first', content_type: 'text',
      is_meta: 0, visibility: 'visible', model: null, is_sidechain: 0, agent_id: null,
      input_tokens: null, output_tokens: null, cwd: null, skill: null, source: 'test',
    },
  ]);

  assert.deepEqual(detail.messages.map(message => message.uuid), ['a', 'b']);
});

test('session detail remains active-only across direct and persisted visibility values', () => {
  const message = (uuid, visibility) => ({
    kind: 'message',
    uuid,
    session_id: 'session',
    type: 'user',
    parent_uuid: null,
    timestamp: `2026-06-10T10:00:0${uuid.length}Z`,
    role: 'user',
    text: uuid,
    content_type: 'text',
    is_meta: 0,
    visibility,
    model: null,
    is_sidechain: 0,
    agent_id: null,
    input_tokens: null,
    output_tokens: null,
    cwd: null,
    skill: null,
    source: 'pi',
  });
  const summary = (id, visibility) => ({
    kind: 'summary',
    id,
    session_id: 'session',
    timestamp: null,
    source: 'pi:branch_summary',
    content: id,
    visibility,
    input_tokens: null,
    output_tokens: null,
  });
  const direct = assembleSessionDetail([
    message('visible', 'visible'),
    message('inactive', 'inactive'),
    message('hidden', 'hidden'),
    summary('visible-summary', 'visible'),
    summary('inactive-summary', 'inactive'),
    summary('hidden-summary', 'hidden'),
  ]);
  assert.deepEqual(direct.messages.map(row => row.text), ['visible']);
  assert.deepEqual(direct.summaries.map(row => row.content), ['visible-summary']);

  const persisted = assembleSessionDetail({
    messages: [
      { ...message('visible', 'visible'), kind: undefined },
      { ...message('inactive', 'inactive'), kind: undefined },
      { ...message('hidden', 'hidden'), kind: undefined },
      { ...message('unknown', 'future-state'), kind: undefined },
    ],
    summaries: [
      { ...summary('visible-summary', 'visible'), kind: undefined },
      { ...summary('inactive-summary', 'inactive'), kind: undefined },
      { ...summary('hidden-summary', 'hidden'), kind: undefined },
      { ...summary('unknown-summary', 'future-state'), kind: undefined },
    ],
  });
  assert.deepEqual(persisted.messages.map(row => row.text), ['visible']);
  assert.deepEqual(persisted.summaries.map(row => row.content), ['visible-summary']);
});

test('direct session assembly rejects an incomplete provider delta', () => {
  assert.throws(() => assembleSessionDetail([{
    kind: 'session', id: 'session', title: null, project: null,
    started_at: null, ended_at: null, git_branch: null, version: null,
    message_count: 1, countMode: 'delta', jsonl_path: '/session.jsonl', source: 'test',
  }]), /fresh full parse/);
});
