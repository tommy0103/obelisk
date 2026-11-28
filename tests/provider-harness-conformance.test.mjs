// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createBuiltinProviderRegistry } from '../packages/core/src/providers/builtins.ts';
import { assertHarnessConformance, harnessContractProblems } from './harness-conformance.mjs';

// The test file in which each built-in provider checks complete parses of its
// fixtures with assertHarnessConformance(). Devin uses its real schema with
// explicitly synthetic rows; other fixture provenance is documented locally.
// The fixtures and the layout a
// provider expects live with that provider's tests, so the check does too.
const CHECKED_IN = {
  claude: 'claude-parse.test.mjs',
  codex: 'codex-parse.test.mjs',
  'codexhost-antigravity': 'codexhost-antigravity-provider.test.mjs',
  copilot: 'copilot-provider.test.mjs',
  deepseek: 'deepseek-tree.test.mjs',
  devin: 'app-devin-index.test.mjs',
  hermes: 'hermes-provider.test.mjs',
  kimi: 'kimi-parse.test.mjs',
  kiro: 'kiro-provider.test.mjs',
  minimax: 'minimax-provider.test.mjs',
  omp: 'omp-parse.test.mjs',
  opencode: 'opencode-provider.test.mjs',
  pi: 'pi-parse.test.mjs',
  zcode: 'app-zcode-index.test.mjs',
};

test('every built-in provider checks its records against the harness contract', () => {
  const builtin = createBuiltinProviderRegistry().list().map(provider => provider.name).sort();
  assert.deepEqual(Object.keys(CHECKED_IN).sort(), builtin,
    'a new provider checks its records with assertHarnessConformance() in its own tests and is listed here');
  for (const [provider, file] of Object.entries(CHECKED_IN)) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.match(source, /\bassertHarnessConformance\(/, `${file} does not check the records of ${provider}`);
  }
});

const SESSION = 'conformance';
const session = (extra = {}) => ({
  kind: 'session', id: SESSION, title: null, project: null, started_at: null, ended_at: null,
  git_branch: null, version: null, message_count: 0, countMode: 'total', jsonl_path: '/tmp/conformance.jsonl',
  source: 'test', ...extra,
});
const message = (uuid, role, text, extra = {}) => ({
  kind: 'message', uuid, session_id: SESSION, type: role, parent_uuid: null, timestamp: '2026-06-10T10:00:00.000Z',
  role, text, content_type: 'text', is_meta: 0, visibility: 'visible', model: null, is_sidechain: 0, agent_id: null,
  input_tokens: null, output_tokens: null, cwd: null, skill: null, source: 'test', ...extra,
});

test('records that say who wrote each message conform', () => {
  assertHarnessConformance([
    session(),
    message('ask', 'user', 'go on'),
    message('reminder', 'user', 'context the harness put in', { is_meta: 1, harness_kind: 'reminder' }),
    // Kept retrievable by its provider, and still named.
    message('back', 'user', 'the sub-agent finished', { harness_kind: 'notification' }),
    message('switch', 'system', 'model a -> b', { is_meta: 1, harness_kind: 'other' }),
    // A message that only brings a tool result back is not harness content.
    message('result', 'toolResult', 'file body', { type: 'user', content_type: 'tool_result' }),
    message('answer', 'assistant', 'done'),
  ]);
});

test('a message the harness wrote must say what it is', () => {
  assert.deepEqual(harnessContractProblems([
    session(),
    message('meta', 'user', 'injected', { is_meta: 1 }),
    message('system', 'system', 'a notice'),
    message('odd', 'user', 'text', { harness_kind: 'banner' }),
  ]), [
    'message meta (role user, "injected"): is_meta without a harness_kind',
    'message system (role system, "a notice"): neither the person\'s nor the model\'s, and no harness_kind',
    'message odd (role user, "text"): harness_kind "banner" is not a known kind',
    // The format does not take it either.
    `session ${SESSION}, local form: turns[0].steps[2]: unknown kind "banner"`,
    `session ${SESSION}, published form: turns[0].steps[2]: unknown kind "banner"`,
  ]);
});

test('who started a session is an agent or not stated, and the records must assemble into valid sessions', () => {
  assert.deepEqual(harnessContractProblems([session({ started_by: 'cron' }), message('ask', 'user', 'go on')]),
    [`session ${SESSION}: started_by "cron" is neither "agent" nor empty`]);
  // Two records under one id inside a session: the format does not allow a step id twice.
  const twice = harnessContractProblems([
    session(),
    message('ask', 'user', 'go on'),
    { kind: 'summary', id: 'ask', session_id: SESSION, timestamp: null, source: 'compaction', content: 'earlier work' },
  ]);
  assert.deepEqual(twice, [
    `session ${SESSION}, local form: turns[0].steps[1]: id "ask" is used twice`,
    `session ${SESSION}, published form: turns[0].steps[1]: id "ask" is used twice`,
  ]);
});
