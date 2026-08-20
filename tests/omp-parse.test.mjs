// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createOmpProvider } from '../packages/core/src/providers/omp.ts';
import { makeTempDir } from './temp-dirs.mjs';

const FIXTURE = readFileSync(new URL('./fixtures/omp/session.jsonl', import.meta.url), 'utf8');

function drain(generator) {
  const values = [];
  let step = generator.next();
  while (!step.done) {
    values.push(step.value);
    step = generator.next();
  }
  return { values, cursor: step.value };
}

function writeFixture(root, content = FIXTURE) {
  const path = join(root, '--tmp-omp-project--', 'session.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

test('OMP provider defaults to the OMP session root and rejects relative overrides', () => {
  const home = makeTempDir('obelisk-omp-home-');
  const provider = createOmpProvider({ homeDir: home });
  assert.equal(provider.descriptor.defaultRoot, join(home, '.omp', 'agent', 'sessions'));
  assert.equal(provider.descriptor.id, 'omp');
  assert.equal(provider.descriptor.name, 'OMP');
  assert.deepEqual(provider.watchTargets(provider.descriptor.defaultRoot), [
    { kind: 'tree', path: join(home, '.omp', 'agent', 'sessions') },
  ]);

  const unresolved = createOmpProvider({ rootDir: 'relative-sessions', homeDir: home });
  assert.equal(unresolved.descriptor.requiresExplicitRoot, true);
  assert.deepEqual(unresolved.watchTargets(unresolved.descriptor.defaultRoot), []);
  assert.deepEqual(unresolved.discover({ lastCursor: () => null }), []);
});

test('OMP provider projects title-prefixed sessions with independent provenance', () => {
  const root = makeTempDir('obelisk-omp-parse-');
  const path = writeFixture(root);
  const provider = createOmpProvider({ rootDir: root });
  const units = provider.discover({ lastCursor: () => null });
  assert.equal(units.length, 1);
  assert.match(units[0].sessionId, /^omp:omp-fixture-session:/);
  assert.equal(units[0].meta.kind, 'omp-session');

  const { values, cursor } = drain(provider.parse(units[0], null));
  const session = values.find(record => record.kind === 'session');
  const messages = values.filter(record => record.kind === 'message');
  const toolCall = values.find(record => record.kind === 'tool_call');
  const toolResult = values.find(record => record.kind === 'tool_result');

  assert.equal(session.id, units[0].sessionId);
  assert.equal(session.source, 'omp');
  assert.equal(session.title, 'OMP indexed title');
  assert.equal(session.message_count, 6);
  assert.ok(messages.length > 0);
  assert.ok(messages.every(message => message.source === 'omp'));
  assert.equal(messages.some(message => message.text === 'OMP indexed title'), false);
  assert.equal(toolCall.name, 'read');
  assert.equal(toolCall.file_path, '/tmp/omp-project/file.ts');
  assert.equal(toolResult.content, 'OMP tool result');

  const userMessage = messages.find(message => message.text === 'OMP fixture request');
  const raw = provider.raw({
    source: 'omp',
    messageUuid: userMessage.uuid,
    session: { id: session.id, jsonl_path: path },
    agentId: null,
    cursor,
  });
  assert.equal(raw.messageText, 'OMP fixture request');
});

test('OMP title prelude updates the title without changing session identity', () => {
  const root = makeTempDir('obelisk-omp-title-');
  const path = writeFixture(root);
  const provider = createOmpProvider({ rootDir: root });
  const firstUnit = provider.discover({ lastCursor: () => null })[0];
  const first = drain(provider.parse(firstUnit, null));
  const updated = FIXTURE.replace('OMP indexed title', 'Updated OMP title');
  writeFileSync(path, updated);

  const secondUnit = provider.discover({ lastCursor: () => first.cursor })[0];
  const second = drain(provider.parse(secondUnit, first.cursor));
  const session = second.values.find(record => record.kind === 'session');
  assert.equal(secondUnit.sessionId, firstUnit.sessionId);
  assert.equal(session.title, 'Updated OMP title');
});
