// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Adapters cut the text they emit at TEXT_LIMIT, which is what the index is built
// with. A caller that parses transcripts without persisting them to the index, and
// needs the records whole, can change that limit with setTextLimit(). These tests pin
// both halves: the default is untouched, and a changed limit reaches adapter output —
// through the shared helpers (Claude) and through the one place an adapter applies
// the limit by hand (Pi bash output, which keeps its trailing notice inside the limit).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { TEXT_LIMIT, extractMessageIsMeta, getTextLimit, setTextLimit, trunc, truncJson } from '../packages/core/src/parsing.ts';
import { createClaudeProvider } from '../packages/core/src/providers/claude.ts';
import { createPiProvider } from '../packages/core/src/providers/pi.ts';
import { createOmpProvider } from '../packages/core/src/providers/omp.ts';
import { makeTempDir } from './temp-dirs.mjs';

const LONG = 25_000;
const PROSE = 'p'.repeat(LONG);
const COMMAND = 'c'.repeat(LONG);
const OUTPUT = 'o'.repeat(LONG);
const BASH_NOTICE = '\n\n[Output truncated. Full output: /tmp/must-not-be-read]';

function write(path, records) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, records.map(record => JSON.stringify(record)).join('\n') + '\n');
}

function parseOnly(provider) {
  const units = provider.discover({ lastCursor: () => null });
  assert.equal(units.length, 1);
  return [...provider.parse(units[0], null)];
}

function claudeRecords(createProvider = createClaudeProvider) {
  const root = makeTempDir('obelisk-text-limit-claude-');
  write(join(root, 'projects', '-tmp-project', 'sid-long.jsonl'), [
    { uuid: 'u1', type: 'user', timestamp: '2026-06-10T10:00:00Z', cwd: '/tmp/project', message: { role: 'user', content: PROSE } },
    { uuid: 'a1', type: 'assistant', parentUuid: 'u1', timestamp: '2026-06-10T10:00:05Z', message: { role: 'assistant', model: 'probe', content: [{ type: 'tool_use', id: 'tc1', name: 'Bash', input: { command: COMMAND } }] } },
    { uuid: 'u2', type: 'user', parentUuid: 'a1', timestamp: '2026-06-10T10:00:10Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tc1', content: OUTPUT }] } },
  ]);
  const records = parseOnly(createProvider({ rootDir: root }));
  return {
    text: records.find(record => record.kind === 'message' && record.uuid === 'u1').text,
    command: JSON.parse(records.find(record => record.kind === 'tool_call').input_json).command,
    result: records.find(record => record.kind === 'tool_result').content,
  };
}

function piBashText(overrides = {}, createProvider = createPiProvider) {
  const root = makeTempDir('obelisk-text-limit-pi-');
  write(join(root, 'project', 'session.jsonl'), [
    { type: 'session', version: 3, id: 'pi-text-limit', timestamp: '2026-08-02T10:00:00.000Z', cwd: '/tmp/pi-test-project' },
    { type: 'message', id: 'root-user', parentId: null, timestamp: '2026-08-02T10:00:01.000Z', message: { role: 'user', content: 'run it', timestamp: Date.parse('2026-08-02T10:00:01.000Z') } },
    {
      type: 'message',
      id: 'bash',
      parentId: 'root-user',
      timestamp: '2026-08-02T10:00:07.000Z',
      message: {
        role: 'bashExecution',
        command: 'printf probe',
        output: OUTPUT,
        exitCode: 0,
        cancelled: false,
        truncated: true,
        fullOutputPath: '/tmp/must-not-be-read',
        timestamp: Date.parse('2026-08-02T10:00:07.000Z'),
        ...overrides,
      },
    },
  ]);
  const records = parseOnly(createProvider({ rootDir: root }));
  return records.find(record => record.kind === 'message' && record.role === 'bashExecution').text;
}

test('by default adapters emit text cut at TEXT_LIMIT', () => {
  assert.equal(TEXT_LIMIT, 10000);
  assert.equal(getTextLimit(), TEXT_LIMIT);

  const claude = claudeRecords();
  assert.equal(claude.text, PROSE.slice(0, TEXT_LIMIT));
  assert.equal(claude.command, `${COMMAND.slice(0, TEXT_LIMIT)}...[truncated]`);
  assert.equal(claude.result, OUTPUT.slice(0, TEXT_LIMIT));

  const bash = piBashText();
  assert.equal(bash.length, TEXT_LIMIT);
  assert.ok(bash.endsWith(BASH_NOTICE));
});

test('with the limit lifted adapters emit message text, tool input and tool result whole', t => {
  t.after(() => setTextLimit(TEXT_LIMIT));
  setTextLimit(Infinity);
  assert.equal(getTextLimit(), Infinity);

  const claude = claudeRecords();
  assert.equal(claude.text, PROSE);
  assert.equal(claude.command, COMMAND);
  assert.equal(claude.result, OUTPUT);

  const bash = piBashText();
  assert.ok(bash.includes(OUTPUT), 'the whole command output is emitted');
  assert.ok(bash.endsWith(BASH_NOTICE));
});

test('setting the default limit again restores the cut', t => {
  t.after(() => setTextLimit(TEXT_LIMIT));
  setTextLimit(Infinity);
  setTextLimit(TEXT_LIMIT);

  assert.equal(claudeRecords().text.length, TEXT_LIMIT);
  assert.equal(piBashText().length, TEXT_LIMIT);
});

test('a finite limit applies to text and to strings inside tool input alike', t => {
  t.after(() => setTextLimit(TEXT_LIMIT));
  setTextLimit(50);

  assert.equal(trunc(PROSE), PROSE.slice(0, 50));
  assert.equal(truncJson({ command: COMMAND, nested: [COMMAND], short: 'kept' }),
    JSON.stringify({ command: `${COMMAND.slice(0, 50)}...[truncated]`, nested: [`${COMMAND.slice(0, 50)}...[truncated]`], short: 'kept' }));

  const claude = claudeRecords();
  assert.equal(claude.text.length, 50);
  assert.equal(claude.result.length, 50);
  assert.equal(piBashText().length, 50);
});

test('setTextLimit rejects a limit that is not a positive integer or Infinity and keeps the current one', () => {
  for (const limit of [0, -1, 1.5, NaN, -Infinity, '10000', null, undefined]) {
    assert.throws(() => setTextLimit(limit), RangeError);
  }
  assert.equal(getTextLimit(), TEXT_LIMIT);
});

test('changing the output limit preserves Claude command and skill classification', t => {
  t.after(() => setTextLimit(TEXT_LIMIT));
  const root = makeTempDir('obelisk-text-limit-classification-');
  const captured = readFileSync(new URL('./fixtures/claude/custom-title-session.jsonl', import.meta.url), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line)).find(record => record.type === 'user');
  const samples = [
    { content: '<command-name>/review</command-name>', isMeta: false, expected: [1, 'text'] },
    { content: 'Base directory for this skill: /tmp/skill\nInstructions', isMeta: true, expected: [1, 'skill_instructions'] },
    { content: [{ type: 'text', text: 'Base directory for this skill: /tmp/skill\nInstructions' }], isMeta: true, expected: [1, 'skill_instructions'] },
    // Classification retains the default indexed semantics, including at a larger output limit.
    { content: ' '.repeat(TEXT_LIMIT) + '<command-name>/review</command-name>', isMeta: false, expected: [0, 'text'] },
  ];
  // Derived stress inputs retain the captured provider envelope; content is intentionally varied.
  const records = samples.map((sample, i) => ({
    ...captured, uuid: `classification-${i}`, isMeta: sample.isMeta,
    message: { ...captured.message, content: sample.content },
  }));
  write(join(root, 'projects', '-tmp-project', 'classification.jsonl'), records);
  for (const limit of [1, 10, TEXT_LIMIT, Infinity]) {
    setTextLimit(limit);
    const messages = parseOnly(createClaudeProvider({ rootDir: root })).filter(record => record.kind === 'message');
    assert.deepEqual(messages.map(record => [record.is_meta, record.content_type]), samples.map(sample => sample.expected));
    assert.ok(messages.every(record => record.text.length <= limit));
    assert.equal(extractMessageIsMeta(records[0]), 1);
  }
});

for (const [source, createProvider] of [['pi', createPiProvider], ['omp', createOmpProvider]]) {
  test(`${source} bash truncation preserves Unicode in the body and trailing notice`, t => {
    t.after(() => setTextLimit(TEXT_LIMIT));
    const suffix = '\n\nCommand exited with code 1';
    for (const limit of [39, TEXT_LIMIT]) {
      setTextLimit(limit);
      const prefix = 'Ran `';
      const commandPrefix = 'c'.repeat(limit - suffix.length - prefix.length - 1);
      const text = piBashText({ command: `${commandPrefix}😀`, output: 'ok', exitCode: 1, truncated: false }, createProvider);
      assert.equal(text, `${prefix}${commandPrefix}${suffix}`);
      assert.equal(Buffer.from(text).toString('utf8'), text);
    }
    const noticePrefix = '\n\n[Output truncated. Full output: /tmp/';
    setTextLimit(noticePrefix.length + 1);
    const notice = piBashText({ fullOutputPath: '/tmp/😀.txt' }, createProvider);
    assert.equal(notice, noticePrefix);
    assert.equal(Buffer.from(notice).toString('utf8'), notice);

    setTextLimit(Infinity);
    const whole = piBashText({ command: 'echo 😀', output: 'ok', fullOutputPath: '/tmp/😀.txt' }, createProvider);
    assert.equal(whole, 'Ran `echo 😀`\n```\nok\n```\n\n[Output truncated. Full output: /tmp/😀.txt]');
  });
}

test('the compiled parsing export configures compiled providers', async t => {
  const parsing = await import('@obelisk/core/parsing');
  const { createClaudeProvider: claude } = await import('@obelisk/core/providers/claude');
  const { createPiProvider: pi } = await import('@obelisk/core/providers/pi');
  const { createOmpProvider: omp } = await import('@obelisk/core/providers/omp');
  t.after(() => parsing.setTextLimit(parsing.TEXT_LIMIT));
  assert.equal(parsing.getTextLimit(), TEXT_LIMIT);
  assert.equal(claudeRecords(claude).text.length, TEXT_LIMIT);
  parsing.setTextLimit(Infinity);
  assert.deepEqual(claudeRecords(claude), { text: PROSE, command: COMMAND, result: OUTPUT });
  for (const provider of [pi, omp]) assert.ok(piBashText({}, provider).includes(OUTPUT));
  parsing.setTextLimit(TEXT_LIMIT);
  assert.equal(claudeRecords(claude).text.length, TEXT_LIMIT);
});
