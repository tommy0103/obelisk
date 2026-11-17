// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// USF assembly (docs/usf-spec.md). The first half runs real provider output
// through the assembly, because providers differ in how they give records; the
// second half states the format's rules one at a time on canonical records.

import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, mkdirSync } from 'node:fs';
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
    message('failed', 'assistant', '404 not found', 3, { content_type: 'error' }),
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
    message('skill', 'user', '# Skill', 3, { is_meta: 1, content_type: 'skill_instructions', skill: 'review' }),
  ]);
  assert.deepEqual(usf.turns[0].steps.slice(1).map((step) => [step.kind, step.skill]), [['other', undefined], ['skill', 'review']]);
});

test('steps keep the order the provider gave the records, not the order of their timestamps', () => {
  const { session: usf } = only([
    session(),
    message('ask', 'user', 'first in the stream', 5),
    message('answer', 'assistant', 'second in the stream', 2),
  ]);
  assert.deepEqual(usf.turns[0].steps.map((step) => step.id), ['ask', 'answer']);
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
