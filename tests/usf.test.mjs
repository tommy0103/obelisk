// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// USF assembly (docs/usf-spec.md). The first half runs real provider output
// through the assembly, because providers differ in how they give records; the
// second half states the format's rules one at a time on canonical records.

import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCodexProvider } from '../packages/core/src/providers/codex.ts';
import { createDeepseekProvider } from '../packages/core/src/providers/deepseek.ts';
import { createOmpProvider } from '../packages/core/src/providers/omp.ts';
import { createPiProvider } from '../packages/core/src/providers/pi.ts';
import { assembleUsf, isUsfTime, publishedUsf, validateUsf } from '../packages/core/src/usf.ts';
import { makeTempDir } from './temp-dirs.mjs';

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

/** Every record of a provider root, from fresh full parses, in the order persist would get them. */
function recordsOf(provider) {
  const records = [];
  for (const unit of provider.discover({ lastCursor: () => null })) {
    for (const record of provider.parse(unit, null)) records.push(record);
  }
  return records;
}

function piRecords(name) {
  const root = makeTempDir('obelisk-usf-pi-');
  mkdirSync(join(root, 'project'));
  copyFileSync(fixture(`pi/${name}.jsonl`), join(root, 'project', 'session.jsonl'));
  return recordsOf(createPiProvider({ rootDir: root }));
}

function ompRecords() {
  const root = makeTempDir('obelisk-usf-omp-');
  mkdirSync(join(root, '--tmp-omp-project--'));
  copyFileSync(fixture('omp/session.jsonl'), join(root, '--tmp-omp-project--', 'session.jsonl'));
  return recordsOf(createOmpProvider({ rootDir: root }));
}

function codexRecords() {
  const root = makeTempDir('obelisk-usf-codex-');
  mkdirSync(join(root, 'sessions'));
  copyFileSync(fixture('codex/real-rollout-structural-sanitized.jsonl'), join(root, 'sessions', 'rollout.jsonl'));
  return recordsOf(createCodexProvider({ rootDir: root }));
}

function deepseekRecords() {
  const root = join(makeTempDir('obelisk-usf-deepseek-'), 'sessions');
  cpSync(fixture('deepseek/sessions'), root, { recursive: true });
  return recordsOf(createDeepseekProvider({ rootDir: root }));
}

function* everyStep(steps) {
  for (const step of steps) {
    yield step;
    if (step.run) yield* everyStep(step.run.steps);
  }
}
const stepsOf = (session) => session.turns.flatMap((turn) => [...everyStep(turn.steps)]);
const label = (step) => (step.by === 'human' ? 'human' : `${step.by}/${step.kind}`);

/** The records that have no place in the assembled sessions. Empty when nothing was dropped. */
function recordsWithoutAPlace(records, assembly) {
  const steps = new Set();
  const tools = new Set();
  const results = new Set();
  const agents = new Set();
  for (const assembled of assembly.sessions) {
    if (assembled.detached) agents.add(assembled.session.id);
    for (const id of assembled.joined) steps.add(id);
    for (const step of stepsOf(assembled.session)) {
      if (step.run) agents.add(step.run.agent.id);
      if (step.by === 'agent' && step.kind === 'tool') {
        tools.add(step.tool.id);
        if (step.result) results.add(step.tool.id);
      } else {
        steps.add(step.id);
        if (step.by === 'harness' && step.kind === 'result') results.add(step.id);
      }
    }
  }
  const callsOf = new Map();
  const resultsOf = new Map();
  for (const record of records) {
    if (record.kind === 'tool_call') callsOf.set(record.message_uuid, [...(callsOf.get(record.message_uuid) ?? []), record.id]);
    if (record.kind === 'tool_result') resultsOf.set(record.message_uuid, [...(resultsOf.get(record.message_uuid) ?? []), record.tool_use_id]);
  }
  const missing = [];
  for (const record of records) {
    if (record.kind === 'message') {
      if (steps.has(record.uuid)) continue;
      const calls = callsOf.get(record.uuid);
      const carried = resultsOf.get(record.uuid) ?? [];
      // A message that only makes tool calls is represented by the calls.
      if (calls && record.text == null && calls.every((id) => tools.has(id))) continue;
      // A message that only brings results back is represented by the results.
      if (record.content_type === 'tool_result' && carried.every((id) => results.has(id))) continue;
      missing.push(`message ${record.uuid}`);
    } else if (record.kind === 'tool_call') {
      if (!tools.has(record.id)) missing.push(`tool_call ${record.id}`);
    } else if (record.kind === 'tool_result') {
      if (!results.has(record.tool_use_id)) missing.push(`tool_result ${record.tool_use_id}`);
    } else if (record.kind === 'summary') {
      if (!steps.has(record.id)) missing.push(`summary ${record.id}`);
    } else if (record.kind === 'subagent') {
      if (!agents.has(record.agent_id)) missing.push(`subagent ${record.agent_id}`);
    }
  }
  return missing;
}

function tokensOf(records) {
  const seen = new Set();
  let total = 0;
  for (const record of records) {
    if (record.kind !== 'message' && record.kind !== 'summary') continue;
    const key = record.kind === 'message' ? record.uuid : `summary:${record.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    total += (record.input_tokens ?? 0) + (record.output_tokens ?? 0);
  }
  return total;
}

for (const [name, load] of [
  ['codex', codexRecords],
  ['deepseek', deepseekRecords],
  ['omp', ompRecords],
  ['pi (tool call)', () => piRecords('tool-session')],
  ['pi (image part and failed model call)', () => piRecords('real-model-session')],
  ['pi (superseded branch)', () => piRecords('harness-source')],
  ['pi (checkpoint fork)', () => piRecords('harness-checkpoint-fork')],
]) {
  test(`${name}: every record of the provider's stream has a place in the USF, and the USF conforms`, () => {
    const records = load();
    assert.ok(records.some((record) => record.kind === 'message'), 'the fixture yields messages');
    const assembly = assembleUsf(records);
    assert.ok(assembly.sessions.length > 0);

    assert.deepEqual(recordsWithoutAPlace(records, assembly), []);
    let tokens = 0;
    for (const { session } of assembly.sessions) {
      assert.deepEqual(validateUsf(session), [], `${session.id} in local form`);
      assert.deepEqual(validateUsf(publishedUsf(session), { profile: 'published' }), [], `${session.id} in published form`);
      for (const step of stepsOf(session)) tokens += (step.usage?.input ?? 0) + (step.usage?.output ?? 0);
    }
    assert.equal(tokens, tokensOf(records), 'usage is neither lost nor counted twice');
  });
}

test('pi: the message that brings a tool result back has no step of its own', () => {
  const [{ session }] = assembleUsf(piRecords('tool-session')).sessions;
  const steps = stepsOf(session);
  const tool = steps.find((step) => step.kind === 'tool');
  assert.equal(tool.result.error, false);
  assert.ok(tool.result.content.length > 0);
  assert.equal(steps.filter((step) => step.by === 'harness').length, 0);
});

test('pi: the parts of one submission are one human step and start one turn', () => {
  const [{ session, stats }] = assembleUsf(piRecords('real-model-session')).sessions;
  assert.equal(stats.partsJoined, 1);
  assert.equal(session.turns.length, 2);
  const first = session.turns[0].steps[0];
  assert.equal(first.by, 'human');
  assert.equal(Array.isArray(first.content) && first.content.length, 2);
});

test('pi: a failed model call is harness content, not something the agent said', () => {
  const [{ session }] = assembleUsf(piRecords('real-model-session')).sessions;
  const failed = stepsOf(session).filter((step) => step.kind === 'error');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].by, 'harness');
});

test('pi: superseded steps carry a state locally and are absent from the published form', () => {
  const [{ session }] = assembleUsf(piRecords('harness-source')).sessions;
  assert.ok(stepsOf(session).some((step) => step.state === 'inactive'));
  const published = publishedUsf(session);
  assert.ok(stepsOf(published).every((step) => !('state' in step)));
  assert.ok(stepsOf(published).length < stepsOf(session).length);
});

test('deepseek: a sub-agent no call is known to have started is a run step of its own', () => {
  const assembly = assembleUsf(deepseekRecords());
  const parent = assembly.sessions.find(({ session }) => session.id.includes('v3-seeded-parent'));
  assert.equal(parent.stats.runsWithoutCall, 1);
  const run = stepsOf(parent.session).find((step) => step.kind === 'run');
  assert.equal(run.by, 'agent');
  assert.deepEqual(run.run.steps.map(label), ['harness/task', 'agent/text']);
  assert.ok(!stepsOf(parent.session).some((step) => step.kind === 'tool' && step.run));
});

// ---- The rules, on canonical records.

const SESSION = 'usf-rules';
const at = (seconds) => `2026-06-10T10:00:${String(seconds).padStart(2, '0')}.000Z`;
const session = (extra = {}) => ({
  kind: 'session', id: SESSION, title: 'Rules', project: null, started_at: null, ended_at: null,
  git_branch: 'main', version: '1.2.3', message_count: 0, countMode: 'total', jsonl_path: '/tmp/rules.jsonl',
  source: 'test', ...extra,
});
const message = (uuid, role, text, seconds, extra = {}) => ({
  kind: 'message', uuid, session_id: SESSION, type: role, parent_uuid: null, timestamp: at(seconds), role, text,
  content_type: 'text', is_meta: 0, visibility: 'visible', model: null, is_sidechain: 0, agent_id: null,
  input_tokens: null, output_tokens: null, cwd: null, skill: null, source: 'test', ...extra,
});
const call = (id, messageUuid, extra = {}) => ({
  kind: 'tool_call', id, message_uuid: messageUuid, session_id: SESSION, name: 'Read', presentation: 'default',
  input_json: '{"file_path":"/a.ts"}', file_path: '/a.ts', ...extra,
});
const result = (callId, messageUuid, content = 'done', extra = {}) => ({
  kind: 'tool_result', tool_use_id: callId, message_uuid: messageUuid, session_id: SESSION, content,
  file_path: null, is_error: 0, ...extra,
});
const only = (records) => {
  const assembly = assembleUsf(records);
  assert.equal(assembly.sessions.length, 1);
  return assembly.sessions[0];
};

test('a turn starts at each submission; what comes before the first belongs to the first turn', () => {
  const { session: usf } = only([
    session(),
    message('note', 'user', 'context the harness put in', 1, { is_meta: 1 }),
    message('ask-1', 'user', 'first', 2),
    message('answer-1', 'assistant', 'one', 3),
    message('ask-2', 'user', 'second', 4),
    message('answer-2', 'assistant', 'two', 5),
  ]);
  assert.deepEqual(usf.turns.map((turn) => turn.steps.map(label)), [
    ['harness/other', 'human', 'agent/text'],
    ['human', 'agent/text'],
  ]);
  assert.deepEqual({ usf: usf.usf, harness: usf.harness, id: usf.id, title: usf.title, git_branch: usf.git_branch },
    { usf: 1, harness: { name: 'test', version: '1.2.3' }, id: SESSION, title: 'Rules', git_branch: 'main' });
});

test('a tool call and its result are one step; a message with several calls gives a step per call and its usage once', () => {
  const { session: usf } = only([
    session(),
    message('ask', 'user', 'read two files', 1),
    message('calls', 'assistant', null, 2, { content_type: 'tool_use', model: 'm-1', input_tokens: 10, output_tokens: 4 }),
    call('call-1', 'calls'),
    call('call-2', 'calls', { input_json: '{"file_path":"/b.ts"}', file_path: '/b.ts' }),
    message('back', 'user', null, 3, { content_type: 'tool_result' }),
    result('call-1', 'back', 'a'),
    result('call-2', 'back', 'b', { is_error: 1 }),
  ]);
  const steps = usf.turns[0].steps;
  assert.deepEqual(steps.map(label), ['human', 'agent/tool', 'agent/tool']);
  assert.deepEqual(steps[1].tool, { id: 'call-1', name: 'Read', input: { file_path: '/a.ts' } });
  assert.deepEqual(steps[1].result, { at: at(3), content: 'a', error: false });
  assert.equal(steps[2].result.error, true);
  assert.equal(steps[2].file, '/b.ts');
  assert.deepEqual(steps[1].usage, { input: 10, output: 4 });
  assert.equal(steps[2].usage, undefined);
  assert.equal(steps[2].model, 'm-1');
});

test('an agent message without text stays as a step unless its tool calls stand for it', () => {
  const { session: usf } = only([
    session(),
    message('ask', 'user', 'think', 1),
    message('thought', 'assistant', null, 2, { content_type: 'thinking', output_tokens: 7 }),
  ]);
  assert.deepEqual(usf.turns[0].steps[1], { by: 'agent', kind: 'reasoning', id: 'thought', at: at(2), usage: { output: 7 }, content: '' });
});

test('a sub-agent hangs on the call that started it when the records name the call', () => {
  const records = [
    session(),
    message('ask', 'user', 'delegate', 1),
    message('spawn', 'assistant', null, 2, { content_type: 'tool_use' }),
    call('call-agent', 'spawn', { name: 'Agent', input_json: '{}', file_path: null }),
    { kind: 'subagent', agent_id: 'agent-1', session_id: SESSION, parent_tool_use_id: 'call-agent', agent_type: 'reviewer', description: 'look' },
    message('task', 'user', 'review it', 3, { agent_id: 'agent-1', is_sidechain: 1 }),
    message('report', 'assistant', 'looks fine', 4, { agent_id: 'agent-1', is_sidechain: 1 }),
  ];
  const { session: usf, stats } = only(records);
  const tool = usf.turns[0].steps[1];
  assert.deepEqual(tool.run.agent, { id: 'agent-1', type: 'reviewer', description: 'look' });
  assert.deepEqual(tool.run.steps.map(label), ['harness/task', 'agent/text']);
  assert.equal(stats.runsWithoutCall, 0);
  assert.equal(usf.turns.length, 1, 'the task handed to a sub-agent is not a submission');
});

test('a sub-agent whose call the records do not name is a run step placed by time, never attached by guess', () => {
  const { session: usf, stats } = only([
    session(),
    message('ask', 'user', 'delegate', 1),
    message('spawn', 'assistant', null, 2, { content_type: 'tool_use' }),
    call('call-agent', 'spawn', { name: 'Agent', input_json: '{}', file_path: null }),
    message('later', 'assistant', 'all done', 9),
    { kind: 'subagent', agent_id: 'agent-1', session_id: SESSION, description: 'look' },
    message('task', 'user', 'review it', 3, { agent_id: 'agent-1', is_sidechain: 1 }),
  ]);
  assert.deepEqual(usf.turns[0].steps.map(label), ['human', 'agent/tool', 'agent/run', 'agent/text']);
  assert.equal(usf.turns[0].steps[1].run, undefined);
  assert.equal(usf.turns[0].steps[2].at, at(3));
  assert.equal(stats.runsWithoutCall, 1);
});

test('a session that is another session\'s sub-agent is a run inside its parent, and stands alone only without it', () => {
  const child = [
    { ...session(), id: 'child', title: 'Child' },
    message('child-task', 'user', 'child task', 3, { session_id: 'child', agent_id: 'child' }),
    message('child-answer', 'assistant', 'child answer', 4, { session_id: 'child', agent_id: 'child' }),
  ];
  const note = { kind: 'subagent', agent_id: 'child', session_id: SESSION, description: 'child' };
  const together = assembleUsf([session(), message('ask', 'user', 'parent', 1), note, ...child]);
  assert.deepEqual(together.sessions.map(({ session: usf, detached }) => [usf.id, detached]), [[SESSION, false]]);
  assert.deepEqual(stepsOf(together.sessions[0].session).map(label), ['human', 'agent/run', 'harness/task', 'agent/text']);

  const alone = assembleUsf([note, ...child]);
  assert.deepEqual(alone.sessions.map(({ session: usf, detached }) => [usf.id, detached]), [['child', true]]);
  // Standing alone, it is still a session a sub-agent started: what it was given is a task.
  assert.equal(alone.sessions[0].session.started_by, 'agent');
  assert.deepEqual(stepsOf(alone.sessions[0].session).map(label), ['harness/task', 'agent/text']);
});

test('a tool result whose call is not among the records is kept as a result step', () => {
  const { session: usf, stats } = only([
    session(),
    message('ask', 'user', 'go on', 1),
    message('back', 'user', null, 2, { content_type: 'tool_result' }),
    result('call-gone', 'back', 'left over', { is_error: 1 }),
  ]);
  assert.deepEqual(usf.turns[0].steps[1], { by: 'harness', id: 'call-gone', at: at(2), kind: 'result', content: 'left over', extra: { error: true } });
  assert.equal(stats.resultsWithoutCall, 1);
});

test('what the harness wrote in the agent\'s place is harness content, with its model and usage', () => {
  const { session: usf } = only([
    session(),
    message('ask', 'user', 'go on', 1),
    message('notice', 'assistant', 'model a -> b', 2, { is_meta: 1, model: 'b', input_tokens: 0, output_tokens: 0 }),
    message('failed', 'assistant', '404 not found', 3, { content_type: 'error', harness_kind: 'error' }),
    { kind: 'summary', id: 'compact-1', session_id: SESSION, timestamp: at(4), source: 'compaction', content: 'earlier work', input_tokens: 300, output_tokens: 20 },
  ]);
  assert.deepEqual(usf.turns[0].steps.slice(1), [
    { by: 'harness', id: 'notice', at: at(2), model: 'b', usage: { input: 0, output: 0 }, kind: 'other', content: 'model a -> b' },
    { by: 'harness', id: 'failed', at: at(3), kind: 'error', content: '404 not found' },
    { by: 'harness', id: 'compact-1', at: at(4), usage: { input: 300, output: 20 }, kind: 'compaction', content: 'earlier work' },
  ]);
});

test('the kind of harness content comes from canonical fields, never from parsing message text', () => {
  const { session: usf } = only([
    session(),
    message('ask', 'user', 'go on', 1),
    message('reminder', 'user', '<system-reminder>looks like one</system-reminder>', 2, { is_meta: 1 }),
    message('skill', 'user', '# Skill', 3, { is_meta: 1, content_type: 'skill_instructions', harness_kind: 'skill', skill: 'review' }),
    message('untold', 'user', '# Skill', 4, { is_meta: 1, content_type: 'skill_instructions' }),
  ]);
  assert.deepEqual(usf.turns[0].steps.slice(1).map((step) => [step.kind, step.skill]),
    [['other', undefined], ['skill', 'review'], ['other', undefined]]);
});

test('a message the provider says the harness wrote is harness content of that kind, whatever its role and also when it is not meta', () => {
  const { session: usf } = only([
    session(),
    message('ask', 'user', 'delegate and wait', 1),
    message('stopped', 'user', '[Request interrupted by user]', 2, { is_meta: 1, harness_kind: 'interruption' }),
    message('back', 'user', 'the sub-agent finished: all green', 3, { harness_kind: 'notification' }),
    message('ran', 'bashExecution', 'Ran `ls`', 4, { type: 'user', harness_kind: 'command' }),
    message('cancelled', 'assistant', null, 5, { content_type: 'unknown', harness_kind: 'interruption' }),
    message('answer', 'assistant', 'done', 6),
  ]);
  assert.equal(usf.turns.length, 1, 'none of them is a submission');
  assert.deepEqual(usf.turns[0].steps.map(label),
    ['human', 'harness/interruption', 'harness/notification', 'harness/command', 'harness/interruption', 'agent/text']);
  assert.deepEqual(validateUsf(usf), []);
});

test('a session a sub-agent started has tasks, not submissions, and is one turn', () => {
  const records = [
    message('task-1', 'user', 'look into the failing test', 1),
    message('answer-1', 'assistant', 'found it', 2),
    message('task-2', 'user', 'now fix it', 3),
    message('note', 'user', 'context the harness put in', 4, { is_meta: 1 }),
    message('answer-2', 'assistant', 'fixed', 5),
  ];
  const { session: byAgent } = only([session({ started_by: 'agent' }), ...records]);
  assert.equal(byAgent.started_by, 'agent');
  assert.deepEqual(byAgent.turns.map((turn) => turn.steps.map(label)),
    [['harness/task', 'agent/text', 'harness/task', 'harness/other', 'agent/text']]);
  assert.deepEqual(validateUsf(byAgent), []);

  const { session: byPerson } = only([session({ started_by: null }), ...records]);
  assert.equal('started_by' in byPerson, false);
  assert.deepEqual(byPerson.turns.map((turn) => turn.steps.map(label)),
    [['human', 'agent/text'], ['human', 'harness/other', 'agent/text']]);

  assert.deepEqual(validateUsf({ ...byPerson, started_by: 'agent' }),
    ['turns[0]: a session started by an agent has a human step', 'turns[1]: a session started by an agent has a human step']);
  assert.deepEqual(validateUsf({ ...byPerson, started_by: 'human' }), ['session: "started_by" "human" is not "agent"']);
});

test('agent-started sessions reject human steps even when hidden or inactive', () => {
  const { session: usf } = only([session(), message('ask', 'user', 'a human prompt', 1)]);
  for (const state of ['hidden', 'inactive']) {
    const changed = structuredClone(usf);
    changed.started_by = 'agent';
    changed.turns[0].steps[0].state = state;
    assert.deepEqual(validateUsf(changed), ['turns[0]: a session started by an agent has a human step']);
  }
});

test('steps keep the order the provider gave the messages, not the order of their timestamps', () => {
  const { session: usf } = only([
    session(),
    message('ask', 'user', 'first in the stream', 5),
    message('answer', 'assistant', 'second in the stream', 2),
  ]);
  assert.deepEqual(usf.turns[0].steps.map((step) => step.id), ['ask', 'answer']);
});

test('a tool call stands where its message is, wherever the provider yields the call record', () => {
  const messages = [
    message('ask-1', 'user', 'first', 1),
    message('use-1', 'assistant', null, 2, { content_type: 'tool_use' }),
    message('back-1', 'user', null, 3, { content_type: 'tool_result' }),
    message('answer-1', 'assistant', 'one', 4),
    message('ask-2', 'user', 'second', 5),
    message('use-2', 'assistant', 'reading again', 6),
    message('answer-2', 'assistant', 'two', 8),
  ];
  const others = [
    call('call-1', 'use-1'),
    result('call-1', 'back-1', 'a'),
    call('call-2', 'use-2'),
    result('call-2', 'use-2', 'b'),
  ];
  const expected = [
    ['human', 'agent/tool', 'agent/text'],
    ['human', 'agent/text', 'agent/tool', 'agent/text'],
  ];
  // Providers yield the records that are not messages before the messages
  // (DeepSeek, ZCode), after them (Kimi) or between them (Claude, Codex).
  const interleaved = [messages[0], messages[1], others[0], messages[2], others[1], messages[3], messages[4], messages[5], others[2], others[3], messages[6]];
  for (const records of [[...others, ...messages], [...messages, ...others], interleaved]) {
    const { session: usf } = only([session(), ...records]);
    assert.deepEqual(usf.turns.map((turn) => turn.steps.map(label)), expected);
    assert.deepEqual(usf.turns[0].steps[1].result, { at: at(3), content: 'a', error: false });
  }
});

test('deepseek: no tool call comes before the submission that led to it', () => {
  const assembly = assembleUsf(deepseekRecords());
  let withTools = 0;
  for (const { session: usf } of assembly.sessions) {
    const steps = usf.turns.flatMap((turn) => turn.steps);
    const firstTool = steps.findIndex((step) => step.kind === 'tool');
    const firstHuman = steps.findIndex((step) => step.by === 'human');
    if (firstTool < 0 || firstHuman < 0) continue;
    withTools++;
    assert.ok(firstHuman < firstTool, `${usf.id}: the first tool step is at ${firstTool}, the first submission at ${firstHuman}`);
  }
  assert.ok(withTools > 0, 'the fixture has sessions with tool calls');
});

test('relocating calls preserves summary position, usage, visibility and nested runs', () => {
  const messages = [
    message('ask', 'user', 'first', 5),
    message('use', 'assistant', 'checking', 2, { model: 'model', input_tokens: 10, output_tokens: 4, visibility: 'inactive' }),
    { kind: 'summary', id: 'compact', session_id: SESSION, source: 'compaction', timestamp: at(9), content: 'context' },
    message('task', 'user', 'inspect', 3, { agent_id: 'child', is_sidechain: 1 }),
    message('child-use', 'assistant', null, 4, { agent_id: 'child', content_type: 'tool_use', output_tokens: 2 }),
    message('answer', 'assistant', 'done', 6),
  ];
  const calls = [call('spawn', 'use'), call('second', 'use'), call('inner', 'child-use')];
  const note = { kind: 'subagent', session_id: SESSION, agent_id: 'child', parent_tool_use_id: 'spawn' };
  const before = only([session(), note, ...calls, ...messages]).session;
  const after = only([session(), note, ...messages, ...calls]).session;
  assert.deepEqual(before, after, 'call yield timing must not change the assembled session');
  assert.deepEqual(validateUsf(before), []);
  assert.deepEqual(before.turns[0].steps.map((s) => s.id), ['ask', 'use', 'spawn', 'second', 'compact', 'answer']);
  assert.deepEqual(before.turns[0].steps[1].usage, { input: 10, output: 4 });
  for (const tool of before.turns[0].steps.slice(2, 4)) {
    assert.equal(tool.usage, undefined, 'the text step already accounts for this message');
    assert.equal(tool.model, 'model');
    assert.equal(tool.state, 'inactive');
  }
  const run = before.turns[0].steps[2].run;
  assert.deepEqual(run.steps.map((s) => s.id), ['task', 'inner']);
  assert.deepEqual(run.steps[1].usage, { output: 2 });
});

test('calls without their owning message keep their stream position and result', () => {
  const { session: usf } = only([
    session(), message('ask', 'user', 'go', 1), call('orphan', 'missing'),
    message('answer', 'assistant', 'done', 2), result('orphan', 'missing', 'kept'),
  ]);
  assert.deepEqual(usf.turns[0].steps.map((s) => s.id), ['ask', 'orphan', 'answer']);
  assert.equal(usf.turns[0].steps[1].at, null);
  assert.deepEqual(usf.turns[0].steps[1].result, { at: null, content: 'kept', error: false });
});

test('a timestamp that cannot be read as a time is null', () => {
  const { session: usf, stats } = only([
    session(),
    message('ask', 'user', 'when', 1, { timestamp: 'p-0040' }),
    message('answer', 'assistant', 'then', 2, { timestamp: '2026-06-10T18:00:00+08:00' }),
  ]);
  assert.deepEqual(usf.turns[0].steps.map((step) => step.at), [null, '2026-06-10T18:00:00+08:00']);
  assert.equal(stats.notATime, 1);
  assert.equal(isUsfTime('2026-06-10'), false);
});

test('USF assembly rejects an incomplete provider delta', () => {
  assert.throws(() => assembleUsf([session({ countMode: 'delta' })]), /fresh full parse/);
});

test('records USF has no place for are counted, not silently skipped', () => {
  const assembly = assembleUsf([
    session(),
    message('ask', 'user', 'go on', 1),
    message('ask', 'user', 'go on', 1),
    { kind: 'message-turn-duration', uuid: 'ask', turn_duration_ms: 12 },
  ]);
  assert.deepEqual(assembly.notCarried, { 'message-turn-duration': 1 });
  assert.equal(assembly.duplicateMessages, 1);
  assert.equal(stepsOf(assembly.sessions[0].session).length, 1);
});

test('validation reports what the format does not allow', () => {
  const { session: usf } = only([
    session(),
    message('ask', 'user', 'go on', 1),
    message('answer', 'assistant', 'done', 2, { visibility: 'inactive' }),
  ]);
  assert.deepEqual(validateUsf(usf), []);
  assert.match(validateUsf(usf, { profile: 'published' }).join('\n'), /"state" "inactive" is not allowed here/);

  const broken = structuredClone(usf);
  broken.turns[0].steps[0].unknown = true;
  broken.turns[0].steps[1].id = 'ask';
  broken.turns[0].steps[1].usage = { output: 1.5 };
  broken.turns[0].steps[0].masks = [{ in: 'content', at: 0, n: 1, rule: 'r' }];
  const problems = validateUsf(broken).join('\n');
  assert.match(problems, /"unknown" is not a field of the format/);
  assert.match(problems, /id "ask" is used twice/);
  assert.match(problems, /1\.5 is not an integer/);
  assert.match(problems, /"masks" is only allowed in the published form/);
});

test('validation rejects malformed field values and incomplete content parts', () => {
  const { session: valid } = only([session(), message('ask', 'user', 'hello', 1)]);
  const cases = [
    (s) => { s.turns = {}; },
    (s) => { s.id = 42; },
    (s) => { s.title = []; },
    (s) => { s.git_branch = false; },
    (s) => { s.harness.name = null; },
    (s) => { s.harness.version = 1; },
    (s) => { s.turns[0].steps[0].skill = null; },
    (s) => { s.turns[0].steps[0].extra = []; },
    (s) => { s.turns[0].steps[0].content = [{ type: 'text' }]; },
    (s) => { s.turns[0].steps[0].content = [{ type: 'text', text: 'hi', unknown: true }]; },
    (s) => { s.turns[0].steps[0].content = [{ type: 'image' }]; },
    (s) => { s.turns[0].steps[0].content = [{ type: 'file', media_type: 'text/plain', blob: { sha256: 'x', bytes: -1 } }]; },
    (s) => { s.turns[0].steps[0] = { by: 'agent', kind: 'text', id: 'a', at: null, content: '', usage: null }; },
    (s) => { s.turns[0].steps[0] = { by: 'agent', kind: 'text', id: 'a', at: null, content: '', usage: { output: '1' } }; },
    (s) => { s.turns[0].steps[0] = { by: 'agent', kind: 'tool', id: 'a', at: null, tool: { id: 1, name: false, input: {} } }; },
    (s) => { s.turns[0].steps[0] = { by: 'agent', kind: 'run', id: 'a', at: null, run: { agent: { id: null }, steps: [] } }; },
    (s) => { s.turns[0].steps[0].extra = { '\ud800': 'invalid key' }; },
    (s) => { s.turns[0].steps[0].extra = { missing: undefined }; },
  ];
  for (const mutate of cases) {
    const broken = structuredClone(valid);
    mutate(broken);
    assert.ok(validateUsf(broken).length > 0, String(mutate));
  }
});

test('an orphan result survives even when its carrier message is absent', () => {
  const { session: usf, stats } = only([session(), result('missing-call', 'missing-message', 'retained')]);
  assert.deepEqual(stepsOf(usf), [{ by: 'harness', kind: 'result', id: 'missing-call', at: null, content: 'retained' }]);
  assert.equal(stats.resultsWithoutCall, 1);
});

test('subagent-only records still produce a session without a session header', () => {
  const { session: usf } = only([message('task', 'user', 'retained', 1, { agent_id: 'child', is_sidechain: 1 })]);
  assert.equal(usf.id, SESSION);
  assert.deepEqual(stepsOf(usf).map(label), ['agent/run', 'harness/task']);
});

test('a detached subtree is emitted once even when descendants arrive before their parent', () => {
  const records = [
    session({ id: 'grandchild' }),
    message('leaf', 'assistant', 'retained', 3, { session_id: 'grandchild' }),
    session({ id: 'child' }),
    message('task', 'user', 'task', 2, { session_id: 'child' }),
    { kind: 'subagent', session_id: 'absent', agent_id: 'child' },
    { kind: 'subagent', session_id: 'child', agent_id: 'grandchild' },
  ];
  const assembly = assembleUsf(records);
  assert.deepEqual(assembly.sessions.map(({ session: s, detached }) => [s.id, detached]), [['child', true]]);
  assert.equal(stepsOf(assembly.sessions[0].session).filter((s) => s.id === 'leaf').length, 1);
});

test('a child with no main messages still carries its nested agents', () => {
  const { session: usf } = only([
    session(), session({ id: 'child' }),
    { kind: 'subagent', session_id: SESSION, agent_id: 'child' },
    { kind: 'subagent', session_id: 'child', agent_id: 'leaf' },
    message('leaf-task', 'user', 'retained', 2, { session_id: 'child', agent_id: 'leaf' }),
  ]);
  assert.ok(stepsOf(usf).some((s) => s.id === 'leaf-task'));
});

test('unlinked runs are placed by time across offsets without reordering provider steps', () => {
  const { session: usf } = only([
    session(), message('ask', 'user', 'ask', 1), message('answer', 'assistant', 'answer', 9),
    { kind: 'subagent', session_id: SESSION, agent_id: 'child' },
    message('task', 'user', 'task', 3, { agent_id: 'child', timestamp: '2026-06-10T11:00:03+01:00' }),
  ]);
  assert.deepEqual(usf.turns[0].steps.map((s) => s.id), ['ask', 'child', 'answer']);
});

test('validation accepts complete multipart content and published metadata', () => {
  const { session: usf } = only([session(), message('ask', 'user', 'hello', 1)]);
  usf.turns[0].steps[0].content = [
    { type: 'text', text: 'hello' },
    { type: 'image', media_type: 'image/png', blob: { sha256: 'a'.repeat(64), bytes: 10 } },
    { type: 'file', media_type: 'text/plain', blob: { sha256: 'b'.repeat(64), bytes: 0 } },
  ];
  assert.deepEqual(validateUsf(usf), []);
  Object.assign(usf.turns[0], { v: 1, id: 'turn-hash', parent: null });
  assert.deepEqual(validateUsf(usf, { profile: 'published' }), []);
  for (const metadata of [{ v: '1' }, { id: 1 }, { parent: [] }]) {
    const broken = structuredClone(usf);
    Object.assign(broken.turns[0], metadata);
    assert.ok(validateUsf(broken, { profile: 'published' }).length > 0);
  }
});

test('validation reports cyclic and non-JSON input without throwing', () => {
  const { session: usf } = only([session(), message('ask', 'user', 'hello', 1)]);
  for (const value of [1n, () => {}, new Date(), usf]) {
    usf.turns[0].steps[0].extra = { value };
    assert.ok(validateUsf(usf).length > 0);
  }
});

test('cyclic subagent sessions are rejected instead of duplicating their records', () => {
  assert.throws(() => assembleUsf([
    session({ id: 'a' }), session({ id: 'b' }),
    { kind: 'subagent', session_id: 'a', agent_id: 'b' },
    { kind: 'subagent', session_id: 'b', agent_id: 'a' },
  ]), /acyclic subagent session relationships/);
});

test('codex: a turn starts at each prompt the person typed and nowhere else', () => {
  const typed = readFileSync(fixture('codex/real-rollout-structural-sanitized.jsonl'), 'utf8').split('\n')
    .filter(line => line.length > 0).map(line => JSON.parse(line))
    .filter(line => line.type === 'event_msg' && line.payload?.type === 'user_message').length;
  const [{ session }] = assembleUsf(codexRecords()).sessions;
  const human = session.turns.flatMap(turn => turn.steps).filter(step => step.by === 'human');
  assert.ok(typed > 0, 'the fixture records prompts as events');
  assert.equal(human.length, typed, 'the rollout also has user-role items Codex wrote itself');
  assert.equal(session.turns.length, typed);
});
