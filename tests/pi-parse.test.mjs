// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  createPiProvider,
  piSessionId,
  resolveDefaultPiRoot,
} from '../packages/core/src/providers/pi.ts';
import { createProviderRegistry } from '../packages/core/src/providers/registry.ts';
import { assembleSessionDetail } from '../packages/core/src/session-detail.ts';
import { persist } from '../packages/core/src/persist.ts';
import { createQueryApi } from '../packages/core/src/query.ts';
import { makeTempDir } from './temp-dirs.mjs';

const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');
const FIXTURES = new URL('./fixtures/pi/', import.meta.url);

function drain(generator) {
  const values = [];
  let step = generator.next();
  while (!step.done) {
    values.push(step.value);
    step = generator.next();
  }
  return { values, cursor: step.value };
}

function fixture(name) {
  return readFileSync(new URL(name, FIXTURES), 'utf8');
}

function writeSession(content, { root, relativePath = 'project/session.jsonl' } = {}) {
  const sessionRoot = root ?? makeTempDir('obelisk-pi-');
  const path = join(sessionRoot, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return { root: sessionRoot, path };
}

function parseOnly(root) {
  const provider = createPiProvider({ rootDir: root });
  const units = provider.discover({ lastCursor: () => null });
  assert.equal(units.length, 1);
  return { provider, unit: units[0], ...drain(provider.parse(units[0], null)) };
}

function jsonl(records, trailingNewline = true) {
  return records.map(record => JSON.stringify(record)).join('\n') + (trailingNewline ? '\n' : '');
}

function header(overrides = {}) {
  return {
    type: 'session',
    version: 3,
    id: 'pi-test-session',
    timestamp: '2026-08-02T10:00:00.000Z',
    cwd: '/tmp/pi-test-project',
    ...overrides,
  };
}

function userEntry(id, parentId, text, timestamp = '2026-08-02T10:00:01.000Z') {
  return {
    type: 'message',
    id,
    parentId,
    timestamp,
    message: { role: 'user', content: text, timestamp: Date.parse(timestamp) },
  };
}

test('Pi root resolution follows official precedence and rejects ambiguous relative roots', () => {
  const home = makeTempDir('obelisk-pi-home-');
  const projectCwd = join(home, 'project');
  mkdirSync(projectCwd, { recursive: true });
  assert.deepEqual(resolveDefaultPiRoot({ env: {}, homeDir: home, cwd: projectCwd }), {
    root: join(home, '.pi', 'agent', 'sessions'),
    requiresExplicitRoot: false,
  });

  const agentDir = join(home, 'custom-agent');
  const absoluteSessions = join(home, 'absolute-sessions');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ sessionDir: absoluteSessions }));
  assert.deepEqual(resolveDefaultPiRoot({
    env: { PI_CODING_AGENT_DIR: agentDir },
    homeDir: home,
    cwd: projectCwd,
  }), {
    root: absoluteSessions,
    requiresExplicitRoot: false,
  });

  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ sessionDir: '.pi/relative-sessions' }));
  const relativeSetting = resolveDefaultPiRoot({
    env: { PI_CODING_AGENT_DIR: agentDir },
    homeDir: home,
    cwd: projectCwd,
  });
  assert.equal(relativeSetting.requiresExplicitRoot, true);
  assert.equal(relativeSetting.root, join(agentDir, 'sessions'));
  assert.doesNotMatch(relativeSetting.root, /relative-sessions/);

  const relativeEnv = resolveDefaultPiRoot({
    env: { PI_CODING_AGENT_SESSION_DIR: 'cwd-relative-sessions' },
    homeDir: home,
    cwd: projectCwd,
  });
  assert.equal(relativeEnv.requiresExplicitRoot, true);
  assert.equal(relativeEnv.root, join(home, '.pi', 'agent', 'sessions'));

  const envSessions = join(home, 'env-sessions');
  assert.deepEqual(resolveDefaultPiRoot({
    env: {
      PI_CODING_AGENT_SESSION_DIR: envSessions,
      PI_CODING_AGENT_DIR: agentDir,
    },
    homeDir: home,
    cwd: projectCwd,
  }), {
    root: envSessions,
    requiresExplicitRoot: false,
  });

  const originalSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = 'cwd-relative-sessions';
  try {
    const unresolved = createPiProvider();
    assert.equal(unresolved.descriptor.requiresExplicitRoot, true);
    assert.deepEqual(unresolved.watchTargets(unresolved.descriptor.defaultRoot), []);
    assert.deepEqual(unresolved.discover({ lastCursor: () => null }), []);

    const explicitlySelected = createPiProvider({
      rootDir: join(process.cwd(), '.pi', 'agent', 'sessions'),
    });
    assert.equal(explicitlySelected.rootResolution.requiresExplicitRoot, false);
  } finally {
    if (originalSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = originalSessionDir;
  }
});

test('Pi project settings override global sessionDir using the official launch cwd', () => {
  const home = makeTempDir('obelisk-pi-project-settings-');
  const agentDir = join(home, 'agent');
  const projectCwd = join(home, 'project');
  const globalSessions = join(home, 'global-sessions');
  const projectSessions = join(home, 'project-sessions');
  mkdirSync(join(projectCwd, '.pi'), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ sessionDir: globalSessions }));
  writeFileSync(join(projectCwd, '.pi', 'settings.json'), JSON.stringify({
    sessionDir: projectSessions,
  }));

  assert.deepEqual(resolveDefaultPiRoot({
    env: { PI_CODING_AGENT_DIR: agentDir },
    homeDir: home,
    cwd: projectCwd,
  }), {
    root: projectSessions,
    requiresExplicitRoot: false,
  });

  writeFileSync(join(projectCwd, '.pi', 'settings.json'), JSON.stringify({
    sessionDir: '.pi/project-sessions',
  }));
  assert.deepEqual(resolveDefaultPiRoot({
    env: { PI_CODING_AGENT_DIR: agentDir },
    homeDir: home,
    cwd: projectCwd,
  }), {
    root: join(projectCwd, '.pi', 'project-sessions'),
    requiresExplicitRoot: false,
  });
});

test('malformed Pi settings fall back to the remaining official settings scope', () => {
  const home = makeTempDir('obelisk-pi-malformed-settings-');
  const agentDir = join(home, 'agent');
  const projectCwd = join(home, 'project');
  const projectSettingsDir = join(projectCwd, '.pi');
  const globalSessions = join(home, 'global-sessions');
  const projectSessions = join(home, 'project-sessions');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectSettingsDir, { recursive: true });

  writeFileSync(join(agentDir, 'settings.json'), '{broken');
  assert.deepEqual(resolveDefaultPiRoot({
    env: { PI_CODING_AGENT_DIR: agentDir },
    homeDir: home,
    cwd: projectCwd,
  }), {
    root: join(agentDir, 'sessions'),
    requiresExplicitRoot: false,
  });

  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({
    sessionDir: globalSessions,
  }));
  writeFileSync(join(projectSettingsDir, 'settings.json'), '{broken');
  assert.deepEqual(resolveDefaultPiRoot({
    env: { PI_CODING_AGENT_DIR: agentDir },
    homeDir: home,
    cwd: projectCwd,
  }), {
    root: globalSessions,
    requiresExplicitRoot: false,
  });

  writeFileSync(join(agentDir, 'settings.json'), '{broken');
  writeFileSync(join(projectSettingsDir, 'settings.json'), JSON.stringify({
    sessionDir: projectSessions,
  }));
  assert.deepEqual(resolveDefaultPiRoot({
    env: { PI_CODING_AGENT_DIR: agentDir },
    homeDir: home,
    cwd: projectCwd,
  }), {
    root: projectSessions,
    requiresExplicitRoot: false,
  });
});

test('non-string Pi sessionDir values never select the default corpus', () => {
  const home = makeTempDir('obelisk-pi-invalid-settings-');
  const agentDir = join(home, 'agent');
  const projectCwd = join(home, 'project');
  mkdirSync(join(projectCwd, '.pi'), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(projectCwd, '.pi', 'settings.json'), '{}');

  for (const sessionDir of [false, 0]) {
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ sessionDir }));
    const resolved = resolveDefaultPiRoot({
      env: { PI_CODING_AGENT_DIR: agentDir },
      homeDir: home,
      cwd: projectCwd,
    });
    assert.equal(resolved.requiresExplicitRoot, true);
    assert.match(resolved.reason, /sessionDir must be a string/);
  }
});

test('Pi discovery never certifies an invalid session root as empty', () => {
  const parent = makeTempDir('obelisk-pi-invalid-root-');
  const root = join(parent, 'sessions');
  writeFileSync(root, 'not a directory');
  let status = 'unknown';
  const units = createPiProvider({ rootDir: root }).discover({
    lastCursor: () => null,
    reportCompleteInventory: () => { status = 'complete'; },
    reportIncompleteInventory: () => { status = 'incomplete'; },
  });
  assert.deepEqual(units, []);
  assert.equal(status, 'incomplete');
});

test('Pi tool fixture projects canonical messages, usage, file paths, raw lines, and persistence', () => {
  const { root, path } = writeSession(fixture('tool-session.jsonl'));
  const { provider, unit, values, cursor } = parseOnly(root);
  const byKind = kind => values.filter(record => record.kind === kind);

  assert.match(cursor, /^\d+(?:\.\d+)?:0:pi-snapshot-v1:/);
  assert.deepEqual(values[0], { kind: 'delete-session', sessionId: unit.sessionId });
  assert.deepEqual(
    byKind('message').map(record => [record.role, record.content_type, record.text]),
    [
      ['user', 'text', 'Read probe.txt and report it'],
      ['assistant', 'tool_use', null],
      ['toolResult', 'tool_result', 'real-pi-tool-result\n'],
      ['assistant', 'text', 'The read tool returned real-pi-tool-result.'],
    ],
  );
  assert.equal(byKind('message')[1].input_tokens, 17);
  assert.equal(byKind('message')[1].output_tokens, 5);
  const toolUseMessage = byKind('message')[1];
  assert.deepEqual(byKind('tool_call').map(record => ({
    id: record.id,
    name: record.name,
    file_path: record.file_path,
  })), [{
    id: `${toolUseMessage.uuid}:tool`,
    name: 'read',
    file_path: 'probe.txt',
  }]);
  assert.equal(byKind('tool_result')[0].file_path, 'probe.txt');
  assert.equal(byKind('session')[0].title, 'Tool probe');
  assert.equal(byKind('session')[0].message_count, 4);
  assert.equal(byKind('session')[0].countMode, 'total');

  const raw = provider.raw({
    source: 'pi',
    messageUuid: byKind('message')[1].uuid,
    session: { id: byKind('session')[0].id, jsonl_path: path },
    agentId: null,
    cursor,
  });
  assert.match(raw.text, /"type":"toolCall"/);
  assert.equal(raw.messageText, null);

  const direct = assembleSessionDetail(values);
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  persist(db, unit, provider.parse(unit, null));
  const persisted = assembleSessionDetail({
    session: db.prepare('SELECT * FROM sessions').get(),
    messages: db.prepare('SELECT * FROM messages ORDER BY timestamp,uuid').all(),
    toolCalls: db.prepare('SELECT * FROM tool_calls').all(),
    toolResults: db.prepare('SELECT * FROM tool_results').all(),
    summaries: db.prepare('SELECT * FROM summaries').all(),
  });
  assert.deepEqual(persisted, direct);
  db.close();
});

test('raw Pi lookup resolves the exact canonical block and rejects replacement provenance', () => {
  const longText = 'long-block-'.repeat(1100);
  const written = writeSession(jsonl([
    header({ id: 'raw-block-session' }),
    userEntry('raw-user', null, 'raw prompt'),
    {
      type: 'message',
      id: 'raw-assistant',
      parentId: 'raw-user',
      timestamp: '2026-08-02T10:00:02.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'exact private thought' },
          { type: 'text', text: longText },
          { type: 'toolCall', id: 'raw-call', name: 'read', arguments: { path: 'raw.ts' } },
        ],
        errorMessage: 'exact synthetic error',
        responseModel: 'probe',
        timestamp: Date.parse('2026-08-02T10:00:02.000Z'),
      },
    },
  ]));
  const { provider, values, cursor } = parseOnly(written.root);
  const session = values.find(record => record.kind === 'session');
  const messages = values.filter(record => (
    record.kind === 'message'
    && record.role === 'assistant'
  ));
  const lookup = message => provider.raw({
    source: 'pi',
    messageUuid: message.uuid,
    session: { id: session.id, jsonl_path: written.path },
    agentId: null,
    cursor,
  });

  assert.equal(lookup(messages.find(message => message.content_type === 'thinking')).messageText, 'exact private thought');
  assert.equal(lookup(messages.find(message => message.content_type === 'text')).messageText, longText);
  assert.equal(messages.find(message => message.content_type === 'text').text.length, 10000);
  assert.equal(lookup(messages.find(message => message.content_type === 'tool_use')).messageText, null);
  assert.equal(lookup(messages.find(message => message.content_type === 'error')).messageText, 'exact synthetic error');
  assert.equal(provider.raw({
    source: 'pi',
    messageUuid: `${session.id}:entry:000002:message:block:9999`,
    session: { id: session.id, jsonl_path: written.path },
    agentId: null,
    cursor,
  }), null);
  assert.equal(provider.raw({
    source: 'pi',
    messageUuid: messages[0].uuid,
    session: { id: session.id, jsonl_path: written.root },
    agentId: null,
    cursor,
  }), null);

  writeFileSync(written.path, jsonl([
    header({ id: 'raw-block-session' }),
    userEntry('replacement-user', null, 'replacement lure'),
    userEntry('replacement-second', 'replacement-user', 'unrelated same-header replacement'),
  ]));
  assert.equal(lookup(messages[0]), null);
});

test('structured tools remain branch-local when Pi reuses a native tool id', () => {
  const records = [
    header({ id: 'branch-tool-id-reuse' }),
    userEntry('root', null, 'shared prompt'),
    {
      type: 'message',
      id: 'active-call',
      parentId: 'root',
      timestamp: '2026-08-02T10:00:02.000Z',
      message: {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'shared-native-id',
          name: 'read',
          arguments: { path: 'active.ts' },
        }],
        model: 'probe',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        timestamp: Date.parse('2026-08-02T10:00:02.000Z'),
      },
    },
    {
      type: 'message',
      id: 'active-result',
      parentId: 'active-call',
      timestamp: '2026-08-02T10:00:03.000Z',
      message: {
        role: 'toolResult',
        toolCallId: 'shared-native-id',
        toolName: 'read',
        content: [{ type: 'text', text: 'ACTIVE RESULT' }],
        isError: false,
        timestamp: Date.parse('2026-08-02T10:00:03.000Z'),
      },
    },
    {
      type: 'message',
      id: 'abandoned-call',
      parentId: 'root',
      timestamp: '2026-08-02T10:00:04.000Z',
      message: {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'shared-native-id',
          name: 'read',
          arguments: { path: 'abandoned.ts' },
        }],
        model: 'probe',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        timestamp: Date.parse('2026-08-02T10:00:04.000Z'),
      },
    },
    {
      type: 'message',
      id: 'abandoned-result',
      parentId: 'abandoned-call',
      timestamp: '2026-08-02T10:00:05.000Z',
      message: {
        role: 'toolResult',
        toolCallId: 'shared-native-id',
        toolName: 'read',
        content: [{ type: 'text', text: 'ABANDONED RESULT' }],
        isError: true,
        timestamp: Date.parse('2026-08-02T10:00:05.000Z'),
      },
    },
    {
      type: 'leaf',
      id: 'select-active',
      parentId: 'abandoned-result',
      targetId: 'active-result',
      timestamp: '2026-08-02T10:00:06.000Z',
    },
  ];
  const { provider, unit, values } = parseOnly(writeSession(jsonl(records)).root);
  const activeToolUse = values.find(record => (
    record.kind === 'message'
    && record.content_type === 'tool_use'
    && record.visibility === 'visible'
  ));
  const inactiveToolUse = values.find(record => (
    record.kind === 'message'
    && record.content_type === 'tool_use'
    && record.visibility === 'inactive'
  ));
  const calls = values.filter(record => record.kind === 'tool_call');
  const results = values.filter(record => record.kind === 'tool_result');
  const activeCall = calls.find(record => record.file_path === 'active.ts');
  const inactiveCall = calls.find(record => record.file_path === 'abandoned.ts');
  const activeResult = results.find(record => record.content === 'ACTIVE RESULT');
  const inactiveResult = results.find(record => record.content === 'ABANDONED RESULT');

  assert.equal(calls.length, 2);
  assert.deepEqual(
    (({ id, message_uuid, file_path }) => ({ id, message_uuid, file_path }))(activeCall),
    {
      id: `${activeToolUse.uuid}:tool`,
      message_uuid: activeToolUse.uuid,
      file_path: 'active.ts',
    },
  );
  assert.deepEqual(
    (({ id, message_uuid, file_path }) => ({ id, message_uuid, file_path }))(inactiveCall),
    {
      id: `${inactiveToolUse.uuid}:tool`,
      message_uuid: inactiveToolUse.uuid,
      file_path: 'abandoned.ts',
    },
  );
  assert.deepEqual(
    (({ tool_use_id, content, file_path, is_error }) => ({
      tool_use_id,
      content,
      file_path,
      is_error,
    }))(activeResult),
    {
      tool_use_id: activeCall.id,
      content: 'ACTIVE RESULT',
      file_path: 'active.ts',
      is_error: 0,
    },
  );
  assert.deepEqual(
    (({ tool_use_id, content, file_path, is_error }) => ({
      tool_use_id,
      content,
      file_path,
      is_error,
    }))(inactiveResult),
    {
      tool_use_id: inactiveCall.id,
      content: 'ABANDONED RESULT',
      file_path: 'abandoned.ts',
      is_error: 1,
    },
  );

  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  persist(db, unit, provider.parse(unit, null));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tool_calls').get().count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tool_results').get().count, 2);
  assert.deepEqual(
    db.prepare('SELECT file_path FROM tool_calls ORDER BY file_path').all().map(row => row.file_path),
    ['abandoned.ts', 'active.ts'],
  );
  const query = createQueryApi(db);
  assert.deepEqual(query.fileHistory('abandoned.ts'), []);
  assert.deepEqual(
    query.fileHistory('abandoned.ts', { includeInactive: true })
      .map(record => [record.toolCall.id, record.visibility]),
    [[inactiveCall.id, 'inactive']],
  );
  assert.deepEqual(query.failures(unit.sessionId), []);
  assert.deepEqual(
    query.failures({ sessionId: unit.sessionId, includeInactive: true })
      .map(record => [record.toolCall.id, record.visibility]),
    [[inactiveCall.id, 'inactive']],
  );
  db.close();
});

test('an empty retainedTail checkpoint does not link a later result to discarded tool scope', () => {
  const records = [
    header({ id: 'checkpoint-tool-scope' }),
    {
      type: 'message',
      id: 'discarded-call',
      parentId: null,
      timestamp: '2026-08-02T10:00:01.000Z',
      message: {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'discarded-native-id',
          name: 'read',
          arguments: { path: 'discarded.ts' },
        }],
        model: 'probe',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        timestamp: Date.parse('2026-08-02T10:00:01.000Z'),
      },
    },
    {
      type: 'compaction',
      id: 'empty-checkpoint',
      parentId: 'discarded-call',
      timestamp: '2026-08-02T10:00:02.000Z',
      summary: 'No retained tool context.',
      firstKeptEntryId: 'discarded-call',
      tokensBefore: 10,
      retainedTail: [],
    },
    {
      type: 'message',
      id: 'unresolved-result',
      parentId: 'empty-checkpoint',
      timestamp: '2026-08-02T10:00:03.000Z',
      message: {
        role: 'toolResult',
        toolCallId: 'discarded-native-id',
        toolName: 'read',
        content: [{ type: 'text', text: 'UNRESOLVED RESULT' }],
        isError: false,
        timestamp: Date.parse('2026-08-02T10:00:03.000Z'),
      },
    },
  ];
  const { values } = parseOnly(writeSession(jsonl(records)).root);

  const discardedCalls = values.filter(record => record.kind === 'tool_call');
  assert.equal(discardedCalls.length, 1);
  const discardedCall = discardedCalls[0];
  assert.equal(
    values.find(record => (
      record.kind === 'message'
      && record.uuid === discardedCall.message_uuid
    )).visibility,
    'inactive',
  );
  assert.equal(values.filter(record => record.kind === 'tool_result').length, 0);
  assert.equal(
    values.find(record => record.kind === 'message' && record.text === 'UNRESOLVED RESULT').visibility,
    'visible',
  );
});

test('a legacy compaction does not link a visible result to an inactive tool call', () => {
  const records = [
    header({ id: 'legacy-tool-scope' }),
    {
      type: 'message',
      id: 'discarded-call',
      parentId: null,
      timestamp: '2026-08-02T10:00:01.000Z',
      message: {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'discarded-native-id',
          name: 'read',
          arguments: { path: '/secret/inactive' },
        }],
        model: 'probe',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        timestamp: Date.parse('2026-08-02T10:00:01.000Z'),
      },
    },
    userEntry('kept-user', 'discarded-call', 'kept context', '2026-08-02T10:00:02.000Z'),
    {
      type: 'compaction',
      id: 'legacy-compaction',
      parentId: 'kept-user',
      timestamp: '2026-08-02T10:00:03.000Z',
      summary: 'Discard the tool call.',
      firstKeptEntryId: 'kept-user',
      tokensBefore: 10,
    },
    {
      type: 'message',
      id: 'standalone-result',
      parentId: 'legacy-compaction',
      timestamp: '2026-08-02T10:00:04.000Z',
      message: {
        role: 'toolResult',
        toolCallId: 'discarded-native-id',
        toolName: 'read',
        content: [{ type: 'text', text: 'VISIBLE STANDALONE FAILURE' }],
        isError: true,
        timestamp: Date.parse('2026-08-02T10:00:04.000Z'),
      },
    },
  ];
  const { provider, unit, values } = parseOnly(writeSession(jsonl(records)).root);
  const discardedCall = values.find(record => record.kind === 'tool_call');
  const callMessage = values.find(record => (
    record.kind === 'message'
    && record.uuid === discardedCall.message_uuid
  ));
  const resultMessage = values.find(record => (
    record.kind === 'message'
    && record.text === 'VISIBLE STANDALONE FAILURE'
  ));

  assert.equal(callMessage.visibility, 'inactive');
  assert.equal(resultMessage.visibility, 'visible');
  assert.equal(values.filter(record => record.kind === 'tool_result').length, 0);

  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  persist(db, unit, provider.parse(unit, null));
  const query = createQueryApi(db);
  assert.deepEqual(query.failures(unit.sessionId), []);
  assert.deepEqual(query.fileHistory('/secret/inactive'), []);
  assert.deepEqual(
    query.fileHistory('/secret/inactive', { includeInactive: true })
      .map(record => record.visibility),
    ['inactive'],
  );
  db.close();
});

test('real-model-derived fixture preserves error, image, cache, and reasoning semantics', () => {
  const { root } = writeSession(fixture('real-model-session.jsonl'));
  const { values } = parseOnly(root);
  const messages = values.filter(record => record.kind === 'message');

  assert.deepEqual(messages.map(record => [record.role, record.content_type, record.text]), [
    ['user', 'text', 'Reply with the probe marker'],
    ['user', 'image', '[image image/png; base64 chars=8]'],
    ['assistant', 'error', '404 not found'],
    ['user', 'text', 'Try the responses protocol'],
    ['assistant', 'text', 'REAL_PI_PROBE_OK'],
  ]);
  const success = messages.at(-1);
  assert.equal(success.input_tokens, 4818);
  assert.equal(success.output_tokens, 20);
  assert.equal(messages.some(record => record.content_type === 'thinking'), false);
  assert.equal(values.find(record => record.kind === 'session').message_count, 5);
});

test('durable leaf and null leaf control active visibility without deleting physical evidence', () => {
  const source = writeSession(fixture('harness-source.jsonl'));
  const parsed = parseOnly(source.root);
  const parsedSource = parsed.values;
  const sourceMessages = parsedSource.filter(record => record.kind === 'message');
  assert.equal(sourceMessages.length, 6, 'complete retainedTail must not be projected twice');
  assert.deepEqual(
    sourceMessages.filter(record => record.visibility === 'visible').map(record => record.text),
    ['Harness first user turn'],
  );
  assert.equal(
    parsedSource.find(record => record.kind === 'session').message_count,
    1,
  );
  assert.equal(assembleSessionDetail(parsedSource).messages.length, 1);

  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  persist(db, parsed.unit, parsed.provider.parse(parsed.unit, null));
  assert.equal(createQueryApi(db).sessions({ source: 'pi' })[0].message_count, 1);
  db.close();

  const nullLeaf = writeSession(fixture('harness-null-leaf.jsonl'));
  const parsedNull = parseOnly(nullLeaf.root).values;
  const physical = parsedNull.find(record => record.kind === 'message');
  assert.equal(physical.visibility, 'inactive');
  assert.equal(parsedNull.find(record => record.kind === 'session').message_count, 0);
  assert.equal(
    parsedNull.find(record => record.kind === 'session').title,
    'This physical message is no longer active',
  );
  assert.deepEqual(assembleSessionDetail(parsedNull).messages, []);
});

test('an empty latest session name clears it and falls back to the physical first user', () => {
  const records = [
    header({ id: 'physical-session-title' }),
    {
      ...userEntry('physical-user', null, ''),
      message: {
        role: 'user',
        content: [
          { type: 'image', mimeType: 'image/png', data: 'AAAA' },
          { type: 'text', text: 'physical' },
          { type: 'text', text: 'fallback' },
        ],
        timestamp: Date.parse('2026-08-02T10:00:01.000Z'),
      },
    },
    {
      type: 'session_info',
      id: 'named',
      parentId: 'physical-user',
      timestamp: '2026-08-02T10:00:02.000Z',
      name: '  Named session  ',
    },
    {
      type: 'session_info',
      id: 'blank-name',
      parentId: 'named',
      timestamp: '2026-08-02T10:00:03.000Z',
      name: '   ',
    },
    {
      type: 'leaf',
      id: 'null-leaf',
      parentId: 'blank-name',
      targetId: null,
      timestamp: '2026-08-02T10:00:04.000Z',
    },
  ];
  const { values } = parseOnly(writeSession(jsonl(records)).root);

  assert.equal(values.find(record => record.kind === 'session').title, 'physical fallback');
  assert.equal(
    values.find(record => record.kind === 'message' && record.text === 'physical').visibility,
    'inactive',
  );
});

test('retainedTail replaces complete ancestors when its compaction is on the active branch', () => {
  const records = fixture('harness-source.jsonl')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
    .filter(record => record.type !== 'leaf');
  const { provider, unit, values } = parseOnly(writeSession(jsonl(records)).root);
  const messages = values.filter(record => record.kind === 'message');
  const visibleText = messages
    .filter(record => record.visibility === 'visible')
    .map(record => record.text);

  assert.equal(messages.length, 8, 'physical ancestors and active retained context are both preserved');
  assert.deepEqual(visibleText, [
    'Harness retained user turn',
    'Harness retained assistant turn',
    'Harness post-compaction user turn',
    'Harness post-compaction assistant turn',
  ]);
  assert.equal(
    messages.find(record => record.text === 'Harness first user turn').visibility,
    'inactive',
  );
  assert.equal(
    messages.find(record => record.text === 'Harness retained user turn' && !record.uuid.includes(':tail:')).visibility,
    'inactive',
  );
  assert.equal(values.find(record => record.kind === 'summary').visibility, 'visible');
  assert.deepEqual(assembleSessionDetail(values).messages.map(message => message.text), visibleText);
  assert.deepEqual(
    messages.reduce(
      (total, message) => ({
        input: total.input + (message.input_tokens ?? 0),
        output: total.output + (message.output_tokens ?? 0),
      }),
      { input: 0, output: 0 },
    ),
    { input: 369, output: 69 },
    'retained context copies must not duplicate model usage',
  );

  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  persist(db, unit, provider.parse(unit, null));
  const query = createQueryApi(db);
  assert.equal(query.search('Harness first').length, 0);
  assert.deepEqual(query.thread(unit.sessionId).map(message => message.text), visibleText);
  db.close();
});

test('legacy compaction exposes only firstKeptEntryId ancestors and later descendants', () => {
  const records = [
    header({ id: 'first-kept-context' }),
    userEntry('old-root', null, 'old root'),
    userEntry('old-near', 'old-root', 'old near', '2026-08-02T10:00:02.000Z'),
    userEntry('kept-start', 'old-near', 'kept start', '2026-08-02T10:00:03.000Z'),
    userEntry('kept-end', 'kept-start', 'kept end', '2026-08-02T10:00:04.000Z'),
    {
      type: 'compaction',
      id: 'legacy-compaction',
      parentId: 'kept-end',
      timestamp: '2026-08-02T10:00:05.000Z',
      summary: 'Earlier context summary',
      firstKeptEntryId: 'kept-start',
      tokensBefore: 100,
    },
    userEntry('post-compaction', 'legacy-compaction', 'post compaction', '2026-08-02T10:00:06.000Z'),
  ];
  const { provider, unit, values } = parseOnly(writeSession(jsonl(records)).root);
  const messages = values.filter(record => record.kind === 'message');
  assert.deepEqual(
    messages.filter(record => record.visibility === 'visible').map(record => record.text),
    ['kept start', 'kept end', 'post compaction'],
  );
  assert.deepEqual(
    messages.filter(record => record.visibility === 'inactive').map(record => record.text),
    ['old root', 'old near'],
  );
  assert.equal(values.find(record => record.kind === 'summary').visibility, 'visible');

  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  persist(db, unit, provider.parse(unit, null));
  const query = createQueryApi(db);
  assert.equal(query.search('old near').length, 0);
  assert.deepEqual(
    query.thread(unit.sessionId).map(message => message.text),
    ['kept start', 'kept end', 'post compaction'],
  );
  db.close();
});

test('a later legacy compaction can retain context across an earlier compaction', () => {
  const records = [
    header({ id: 'nested-compaction-context' }),
    userEntry('root', null, 'root'),
    userEntry('near-first', 'root', 'near first', '2026-08-02T10:00:02.000Z'),
    {
      type: 'compaction',
      id: 'first-compaction',
      parentId: 'near-first',
      timestamp: '2026-08-02T10:00:03.000Z',
      summary: 'First summary',
      firstKeptEntryId: 'near-first',
      tokensBefore: 50,
    },
    userEntry('after-first', 'first-compaction', 'after first', '2026-08-02T10:00:04.000Z'),
    {
      type: 'compaction',
      id: 'second-compaction',
      parentId: 'after-first',
      timestamp: '2026-08-02T10:00:05.000Z',
      summary: 'Second summary',
      firstKeptEntryId: 'root',
      tokensBefore: 100,
    },
    userEntry('after-second', 'second-compaction', 'after second', '2026-08-02T10:00:06.000Z'),
  ];
  const { values } = parseOnly(writeSession(jsonl(records)).root);

  assert.deepEqual(
    values
      .filter(record => record.kind === 'message' && record.visibility === 'visible')
      .map(record => record.text),
    ['root', 'near first', 'after first', 'after second'],
  );
  assert.deepEqual(
    values
      .filter(record => record.kind === 'summary' && record.visibility === 'visible')
      .map(record => record.content),
    ['First summary', 'Second summary'],
  );
});

test('a retained-tail checkpoint bounds a later legacy compaction like Pi 0.83 storage', () => {
  const records = [
    header({ id: 'mixed-compaction-context' }),
    userEntry('root', null, 'discarded root'),
    {
      type: 'compaction',
      id: 'checkpoint',
      parentId: 'root',
      timestamp: '2026-08-02T10:00:02.000Z',
      summary: 'Checkpoint summary',
      firstKeptEntryId: 'root',
      tokensBefore: 50,
      retainedTail: [{
        role: 'user',
        content: 'checkpoint tail',
        timestamp: Date.parse('2026-08-02T10:00:02.000Z'),
      }],
    },
    userEntry('after-checkpoint', 'checkpoint', 'discarded after checkpoint', '2026-08-02T10:00:03.000Z'),
    {
      type: 'compaction',
      id: 'later-legacy',
      parentId: 'after-checkpoint',
      timestamp: '2026-08-02T10:00:04.000Z',
      summary: 'Later legacy summary',
      firstKeptEntryId: 'root',
      tokensBefore: 100,
    },
    userEntry('head', 'later-legacy', 'active head', '2026-08-02T10:00:05.000Z'),
  ];
  const { values } = parseOnly(writeSession(jsonl(records)).root);

  assert.deepEqual(
    values
      .filter(record => record.kind === 'message' && record.visibility === 'visible')
      .map(record => record.text),
    ['active head'],
  );
  assert.deepEqual(
    values
      .filter(record => record.kind === 'summary' && record.visibility === 'visible')
      .map(record => record.content),
    ['Later legacy summary'],
  );
});

test('legacy checkpoint fork accepts a truncated parent before firstKeptEntryId', () => {
  const records = [
    header({ id: 'legacy-checkpoint-fork' }),
    userEntry('kept-start', 'omitted-parent', 'kept start'),
    userEntry('kept-end', 'kept-start', 'kept end', '2026-08-02T10:00:02.000Z'),
    {
      type: 'compaction',
      id: 'legacy-compaction',
      parentId: 'kept-end',
      timestamp: '2026-08-02T10:00:03.000Z',
      summary: 'Omitted source context summary',
      firstKeptEntryId: 'kept-start',
      tokensBefore: 100,
    },
    userEntry('post-compaction', 'legacy-compaction', 'post compaction', '2026-08-02T10:00:04.000Z'),
  ];
  const { values } = parseOnly(writeSession(jsonl(records)).root);

  assert.deepEqual(
    values
      .filter(record => record.kind === 'message' && record.visibility === 'visible')
      .map(record => record.text),
    ['kept start', 'kept end', 'post compaction'],
  );
  assert.equal(values.find(record => record.kind === 'summary').visibility, 'visible');
});

test('checkpoint fork materializes retainedTail exactly once and reconnects later parent identity', () => {
  const { root, path } = writeSession(fixture('harness-checkpoint-fork.jsonl'));
  const { provider, unit, values, cursor } = parseOnly(root);
  const messages = values.filter(record => record.kind === 'message');
  assert.deepEqual(messages.map(record => [record.content_type, record.text]), [
    ['text', 'Harness retained user turn'],
    ['thinking', 'retained reasoning'],
    ['text', 'Harness retained assistant turn'],
    ['text', 'Harness post-compaction user turn'],
    ['text', 'Harness post-compaction assistant turn'],
  ]);
  assert.equal(messages[1].input_tokens, null);
  assert.equal(messages[2].input_tokens, null);
  assert.equal(messages[2].output_tokens, null);
  assert.equal(messages[4].input_tokens, 123);
  assert.equal(messages[4].output_tokens, 23);
  assert.equal(messages[3].parent_uuid, messages[2].uuid);
  assert.equal(values.filter(record => record.kind === 'summary').length, 1);
  assert.deepEqual(assembleSessionDetail(values).messages.map(message => message.text), [
    'Harness retained user turn',
    'Harness retained assistant turn',
    'Harness post-compaction user turn',
    'Harness post-compaction assistant turn',
  ]);
  const raw = message => provider.raw({
    source: 'pi',
    messageUuid: message.uuid,
    session: { id: unit.sessionId, jsonl_path: path },
    agentId: null,
    cursor,
  });
  assert.doesNotMatch(raw(messages[1]).text, /"retainedTail"/);
  assert.equal(JSON.parse(raw(messages[1]).text).role, 'assistant');
  assert.equal(raw(messages[1]).messageText, 'retained reasoning');
  assert.equal(raw(messages[2]).messageText, 'Harness retained assistant turn');
});

test('retained-tail raw evidence never exposes hidden sibling messages', () => {
  const records = [
    header({ id: 'retained-raw-visibility' }),
    userEntry('root', null, 'discarded root'),
    {
      type: 'compaction',
      id: 'checkpoint',
      parentId: 'root',
      timestamp: '2026-08-02T10:00:02.000Z',
      summary: 'Checkpoint summary',
      firstKeptEntryId: 'root',
      tokensBefore: 50,
      retainedTail: [
        {
          role: 'user',
          content: 'visible retained evidence',
          timestamp: Date.parse('2026-08-02T10:00:02.000Z'),
        },
        {
          role: 'custom',
          content: 'HIDDEN RETAINED SIBLING',
          display: false,
          timestamp: Date.parse('2026-08-02T10:00:03.000Z'),
        },
      ],
    },
  ];
  const { root } = writeSession(jsonl(records));
  const { provider, unit, values } = parseOnly(root);
  const visible = values.find(record => (
    record.kind === 'message'
    && record.visibility === 'visible'
    && record.text === 'visible retained evidence'
  ));
  const hidden = values.find(record => (
    record.kind === 'message'
    && record.visibility === 'hidden'
  ));
  assert.ok(visible);
  assert.ok(hidden);

  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  persist(db, unit, provider.parse(unit, null));
  const query = createQueryApi(db, {
    providerRegistry: createProviderRegistry([provider]),
  });
  const raw = query.raw(visible.uuid);
  assert.equal(raw.text, JSON.stringify(records[2].retainedTail[0]));
  assert.doesNotMatch(raw.text, /HIDDEN RETAINED SIBLING/);
  assert.equal(query.raw(hidden.uuid), null);
  db.close();
});

test('a retained tail beginning with a tool result remains standalone active evidence', () => {
  const records = [
    header({ id: 'retained-tool-result' }),
    {
      type: 'message',
      id: 'physical-call',
      parentId: null,
      timestamp: '2026-08-02T10:00:01.000Z',
      message: {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'split-call',
          name: 'read',
          arguments: { path: 'probe.txt' },
        }],
        usage: { input: 5, output: 2 },
        timestamp: 1785664801000,
      },
    },
    {
      type: 'compaction',
      id: 'checkpoint',
      parentId: 'physical-call',
      timestamp: '2026-08-02T10:00:02.000Z',
      summary: 'The preceding tool turn was split.',
      firstKeptEntryId: 'physical-call',
      tokensBefore: 100,
      retainedTail: [{
        role: 'toolResult',
        toolCallId: 'split-call',
        toolName: 'read',
        content: [{ type: 'text', text: 'RETAINED RESULT' }],
        isError: false,
        timestamp: 1785664802000,
      }],
    },
    userEntry('after-checkpoint', 'checkpoint', 'after', '2026-08-02T10:00:03.000Z'),
  ];
  const { provider, unit, values } = parseOnly(writeSession(jsonl(records)).root);
  assert.deepEqual(
    values
      .filter(record => record.kind === 'message' && record.visibility === 'visible')
      .map(record => record.text),
    ['RETAINED RESULT', 'after'],
  );
  assert.deepEqual(
    assembleSessionDetail(values).messages.map(message => message.text),
    ['RETAINED RESULT', 'after'],
  );

  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  persist(db, unit, provider.parse(unit, null));
  assert.deepEqual(
    assembleSessionDetail({
      session: db.prepare('SELECT * FROM sessions').get(),
      messages: db.prepare('SELECT * FROM messages ORDER BY timestamp,uuid').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls').all(),
      toolResults: db.prepare('SELECT * FROM tool_results').all(),
      summaries: db.prepare('SELECT * FROM summaries').all(),
    }).messages.map(message => message.text),
    ['RETAINED RESULT', 'after'],
  );
  db.close();
});

test('full tree marks abandoned messages inactive while indexing every summary and explicit user bash action', () => {
  const records = [
    header(),
    userEntry('root-user', null, 'shared root'),
    userEntry('abandoned-user', 'root-user', 'abandoned branch'),
    {
      type: 'message',
      id: 'abandoned-assistant',
      parentId: 'abandoned-user',
      timestamp: '2026-08-02T10:00:03.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'discarded answer' }],
        model: 'probe',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        timestamp: Date.parse('2026-08-02T10:00:03.000Z'),
      },
    },
    {
      type: 'custom_message',
      id: 'inactive-custom',
      parentId: 'abandoned-assistant',
      timestamp: '2026-08-02T10:00:03.500Z',
      customType: 'probe',
      content: 'superseded extension context',
      display: true,
    },
    {
      type: 'branch_summary',
      id: 'branch-summary',
      parentId: 'root-user',
      timestamp: '2026-08-02T10:00:04.000Z',
      fromId: 'abandoned-assistant',
      summary: 'The abandoned branch tried a discarded answer.',
    },
    {
      type: 'custom_message',
      id: 'hidden-custom',
      parentId: 'branch-summary',
      timestamp: '2026-08-02T10:00:05.000Z',
      customType: 'probe',
      content: 'hidden extension context',
      display: false,
    },
    {
      type: 'custom_message',
      id: 'visible-custom',
      parentId: 'hidden-custom',
      timestamp: '2026-08-02T10:00:06.000Z',
      customType: 'probe',
      content: 'visible extension context',
      display: true,
    },
    {
      type: 'message',
      id: 'bash',
      parentId: 'visible-custom',
      timestamp: '2026-08-02T10:00:07.000Z',
      message: {
        role: 'bashExecution',
        command: 'printf probe',
        output: 'x'.repeat(12_000),
        exitCode: 0,
        cancelled: false,
        truncated: true,
        fullOutputPath: '/tmp/must-not-be-read',
        excludeFromContext: true,
        timestamp: Date.parse('2026-08-02T10:00:07.000Z'),
      },
    },
    {
      type: 'compaction',
      id: 'compaction',
      parentId: 'bash',
      timestamp: '2026-08-02T10:00:08.000Z',
      summary: 'Earlier active work.',
      firstKeptEntryId: 'root-user',
      tokensBefore: 42,
    },
    userEntry('active-user', 'compaction', 'active request', '2026-08-02T10:00:09.000Z'),
  ];
  const { root } = writeSession(jsonl(records));
  const { provider, unit, values } = parseOnly(root);
  const messages = values.filter(record => record.kind === 'message');

  assert.equal(messages.find(record => record.text === 'abandoned branch').visibility, 'inactive');
  assert.equal(messages.find(record => record.text === 'abandoned branch').is_meta, 0);
  assert.equal(messages.find(record => record.text === 'superseded extension context').visibility, 'inactive');
  assert.equal(messages.find(record => record.text === 'hidden extension context').visibility, 'hidden');
  assert.equal(messages.find(record => record.text === 'visible extension context').visibility, 'visible');
  const bash = messages.find(record => record.role === 'bashExecution');
  assert.equal(bash.type, 'user');
  assert.equal(bash.content_type, 'bash_execution');
  assert.equal(bash.is_meta, 0);
  assert.equal(bash.text.length, 10_000);
  assert.match(bash.text, /\[Output truncated\. Full output: \/tmp\/must-not-be-read\]$/);
  assert.equal(values.filter(record => record.kind === 'tool_call').length, 0);
  assert.deepEqual(
    values.filter(record => record.kind === 'summary').map(record => record.source),
    ['pi:branch_summary', 'pi:compaction'],
  );

  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  persist(db, unit, provider.parse(unit, null));
  const query = createQueryApi(db);
  assert.equal(query.search('abandoned').length, 0);
  assert.equal(query.search('abandoned', { includeInactive: true })[0].message.visibility, 'inactive');
  assert.equal(query.search('superseded extension').length, 0);
  assert.equal(query.search('superseded extension', { includeInactive: true }).length, 0);
  assert.equal(
    query.search('superseded extension', {
      includeInactive: true,
      includeMeta: true,
    })[0].message.visibility,
    'inactive',
  );
  assert.equal(query.search('active request').length, 1);
  assert.equal(query.thread(unit.sessionId).some(message => message.text === 'abandoned branch'), false);
  assert.equal(
    query.thread(unit.sessionId, { includeInactive: true })
      .find(message => message.text === 'abandoned branch').visibility,
    'inactive',
  );
  db.close();
});

test('inactive Pi summaries remain available for accounting and explicit historical queries', () => {
  const records = [
    header({ id: 'summary-visibility' }),
    userEntry('root', null, 'shared root'),
    userEntry('abandoned', 'root', 'abandoned prompt'),
    {
      type: 'branch_summary',
      id: 'abandoned-summary',
      parentId: 'abandoned',
      timestamp: '2026-08-02T10:00:03.000Z',
      fromId: 'abandoned',
      summary: 'ABANDONED SUMMARY SECRET',
      usage: { input: 9, output: 2, cacheRead: 3, cacheWrite: 4 },
    },
    userEntry('active', 'root', 'active prompt', '2026-08-02T10:00:04.000Z'),
  ];
  const { provider, unit, values } = parseOnly(writeSession(jsonl(records)).root);
  const summary = values.find(record => record.kind === 'summary');
  assert.equal(summary.visibility, 'inactive');
  assert.equal(summary.input_tokens, 16);
  assert.deepEqual(assembleSessionDetail(values).summaries, []);

  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  persist(db, unit, provider.parse(unit, null));
  const query = createQueryApi(db);
  assert.deepEqual(query.summaries(unit.sessionId), []);
  assert.equal(
    query.summaries({ sessionId: unit.sessionId, includeInactive: true })[0].visibility,
    'inactive',
  );
  assert.deepEqual(
    assembleSessionDetail({ summaries: db.prepare('SELECT * FROM summaries').all() }).summaries,
    [],
  );
  assert.deepEqual(
    { ...db.prepare('SELECT content,visibility,input_tokens,output_tokens FROM summaries').get() },
    {
      content: 'ABANDONED SUMMARY SECRET',
      visibility: 'inactive',
      input_tokens: 16,
      output_tokens: 2,
    },
  );
  db.close();
});

test('lowercase read, edit, and write arguments.path populate call and matching result file paths', () => {
  const records = [header()];
  let parent = null;
  for (const [index, name] of ['read', 'edit', 'write'].entries()) {
    const callEntry = `call-entry-${index}`;
    const callId = `call-${index}`;
    records.push({
      type: 'message',
      id: callEntry,
      parentId: parent,
      timestamp: `2026-08-02T10:00:0${index + 1}.000Z`,
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: callId, name, arguments: { path: `src/${name}.ts` } }],
        model: 'probe',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        timestamp: 1785664800000 + index,
      },
    });
    records.push({
      type: 'message',
      id: `result-entry-${index}`,
      parentId: callEntry,
      timestamp: `2026-08-02T10:00:1${index + 1}.000Z`,
      message: {
        role: 'toolResult',
        toolCallId: callId,
        toolName: name,
        content: [{ type: 'text', text: `${name} result` }],
        isError: false,
        timestamp: 1785664801000 + index,
      },
    });
    parent = `result-entry-${index}`;
  }
  const { root } = writeSession(jsonl(records));
  const { values } = parseOnly(root);
  assert.deepEqual(
    values.filter(record => record.kind === 'tool_call').map(record => record.file_path),
    ['src/read.ts', 'src/edit.ts', 'src/write.ts'],
  );
  assert.deepEqual(
    values.filter(record => record.kind === 'tool_result').map(record => record.file_path),
    ['src/read.ts', 'src/edit.ts', 'src/write.ts'],
  );
});

test('tool-result nested model usage is retained on its canonical message', () => {
  const records = [
    header(),
    {
      type: 'message',
      id: 'result',
      parentId: null,
      timestamp: '2026-08-02T10:00:01.000Z',
      message: {
        role: 'toolResult',
        toolCallId: 'nested-call',
        toolName: 'agent',
        content: [{ type: 'text', text: 'nested result' }],
        usage: { input: 11, output: 7, cacheRead: 3, cacheWrite: 2 },
        isError: false,
        timestamp: 1785664801000,
      },
    },
  ];
  const { values } = parseOnly(writeSession(jsonl(records)).root);
  const result = values.find(record => record.kind === 'message');
  assert.equal(result.input_tokens, 16);
  assert.equal(result.output_tokens, 7);
});

test('compaction and branch-summary model usage survives canonical persistence', () => {
  const records = [
    header({ id: 'summary-usage' }),
    userEntry('user', null, 'summarize this'),
    {
      type: 'branch_summary',
      id: 'branch-summary',
      parentId: 'user',
      timestamp: '2026-08-02T10:00:02.000Z',
      fromId: 'user',
      summary: 'Branch summary',
      usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 3 },
    },
    {
      type: 'compaction',
      id: 'compaction',
      parentId: 'branch-summary',
      timestamp: '2026-08-02T10:00:03.000Z',
      summary: 'Compaction summary',
      firstKeptEntryId: 'user',
      tokensBefore: 100,
      usage: { input: 20, output: 5, cacheRead: 6, cacheWrite: 7 },
    },
  ];
  const { provider, unit, values } = parseOnly(writeSession(jsonl(records)).root);
  assert.deepEqual(
    values.filter(record => record.kind === 'summary').map(record => ({
      source: record.source,
      input: record.input_tokens,
      output: record.output_tokens,
    })),
    [
      { source: 'pi:branch_summary', input: 15, output: 4 },
      { source: 'pi:compaction', input: 33, output: 5 },
    ],
  );

  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  persist(db, unit, provider.parse(unit, null));
  assert.deepEqual(
    db.prepare('SELECT input_tokens,output_tokens FROM summaries ORDER BY timestamp').all()
      .map(row => ({ ...row })),
    [
      { input_tokens: 15, output_tokens: 4 },
      { input_tokens: 33, output_tokens: 5 },
    ],
  );
  db.close();
});

test('retained-tail summaries keep distinct canonical identities through persistence', () => {
  const records = [
    header({ id: 'retained-summary-identities' }),
    userEntry('root', null, 'summarize retained context'),
    {
      type: 'compaction',
      id: 'checkpoint',
      parentId: 'root',
      timestamp: '2026-08-02T10:00:03.000Z',
      summary: 'Outer compaction',
      firstKeptEntryId: 'root',
      tokensBefore: 100,
      retainedTail: [
        {
          role: 'branchSummary',
          summary: 'First retained summary',
          timestamp: Date.parse('2026-08-02T10:00:01.000Z'),
        },
        {
          role: 'branchSummary',
          summary: 'Second retained summary',
          timestamp: Date.parse('2026-08-02T10:00:02.000Z'),
        },
      ],
    },
  ];
  const { provider, unit, values } = parseOnly(writeSession(jsonl(records)).root);
  const retained = values.filter(record => (
    record.kind === 'summary'
    && record.source === 'pi:branch_summary'
  ));
  assert.deepEqual(retained.map(record => record.content), [
    'First retained summary',
    'Second retained summary',
  ]);
  assert.equal(new Set(retained.map(record => record.id)).size, 2);

  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  persist(db, unit, provider.parse(unit, null));
  assert.deepEqual(
    db.prepare("SELECT content FROM summaries WHERE source='pi:branch_summary' ORDER BY timestamp")
      .all().map(row => row.content),
    retained.map(record => record.content),
  );
  const byTimestamp = (left, right) => String(left.timestamp).localeCompare(String(right.timestamp));
  assert.deepEqual(
    assembleSessionDetail({
      summaries: db.prepare('SELECT * FROM summaries ORDER BY timestamp').all(),
    }).summaries.sort(byTimestamp),
    assembleSessionDetail(values).summaries.sort(byTimestamp),
  );
  db.close();
});

test('malformed physical JSON lines follow Pi while structural errors fail atomically', () => {
  const complete = jsonl([header(), userEntry('user', null, 'no newline')], false);
  assert.equal(parseOnly(writeSession(complete).root).values.filter(record => record.kind === 'message').length, 1);

  const completedCorruption = [
    JSON.stringify(header()),
    JSON.stringify(userEntry('before', null, 'before malformed line')),
    '{broken}',
    JSON.stringify(userEntry('after', 'before', 'after malformed line')),
    '',
  ].join('\n');
  assert.deepEqual(
    parseOnly(writeSession(completedCorruption).root).values
      .filter(record => record.kind === 'message')
      .map(record => record.text),
    ['before malformed line', 'after malformed line'],
  );

  const terminalGarbage = `${jsonl([header(), userEntry('user', null, 'prefix')])}not-json`;
  assert.deepEqual(
    parseOnly(writeSession(terminalGarbage).root).values
      .filter(record => record.kind === 'message')
      .map(record => record.text),
    ['prefix'],
  );

  const invalidValue = writeSession(`${JSON.stringify(header())}\n42\n`);
  const valueProvider = createPiProvider({ rootDir: invalidValue.root });
  const valueUnit = valueProvider.discover({ lastCursor: () => null })[0];
  assert.throws(
    () => drain(valueProvider.parse(valueUnit, null)),
    /Malformed Pi JSONL value at line 2/,
  );

  const invalidMessage = writeSession(jsonl([
    header(),
    {
      type: 'message',
      id: 'invalid-message',
      parentId: null,
      timestamp: '2026-08-02T10:00:01.000Z',
      message: null,
    },
  ]));
  const messageProvider = createPiProvider({ rootDir: invalidMessage.root });
  const messageUnit = messageProvider.discover({ lastCursor: () => null })[0];
  assert.throws(
    () => drain(messageProvider.parse(messageUnit, null)),
    /Malformed Pi message/,
  );
});

test('official v1 migration preserves canonical identities and v2 hookMessage becomes custom metadata', () => {
  const v1 = [
    {
      type: 'session',
      id: 'legacy-v1',
    },
    {
      type: 'message',
      timestamp: '2026-08-02T10:00:01.000Z',
      message: { role: 'user', content: 'legacy user', timestamp: 1785664800000 },
    },
    {
      type: 'compaction',
      timestamp: '2026-08-02T10:00:02.000Z',
      summary: 'legacy summary',
      firstKeptEntryIndex: 1,
      tokensBefore: 100,
    },
    {
      type: 'message',
      timestamp: '2026-08-02T10:00:03.000Z',
      message: { role: 'user', content: 'legacy tail', timestamp: 1785664803000 },
    },
  ];
  const written = writeSession(`${v1.map(record => JSON.stringify(record)).join('\n\n')}\n`);
  const firstParse = parseOnly(written.root);
  const first = firstParse.values;
  const migrated = [
    { ...v1[0], version: 3 },
    { ...v1[1], id: 'random-migrated-1', parentId: null },
    {
      ...v1[2],
      id: 'random-migrated-2',
      parentId: 'random-migrated-1',
      firstKeptEntryId: 'random-migrated-1',
      firstKeptEntryIndex: undefined,
    },
    { ...v1[3], id: 'random-migrated-3', parentId: 'random-migrated-2' },
  ];
  writeFileSync(written.path, jsonl(migrated));
  const secondParse = parseOnly(written.root);
  const second = secondParse.values;
  assert.deepEqual(
    first.filter(record => record.kind === 'message').map(record => record.uuid),
    second.filter(record => record.kind === 'message').map(record => record.uuid),
  );
  assert.deepEqual(
    first.filter(record => record.kind === 'summary').map(record => record.id),
    second.filter(record => record.kind === 'summary').map(record => record.id),
  );
  const firstSession = first.find(record => record.kind === 'session');
  const secondSession = second.find(record => record.kind === 'session');
  assert.equal(firstSession.version, 'session-v1');
  assert.equal(secondSession.version, 'session-v3');
  assert.equal(firstSession.started_at, null);
  assert.equal(firstSession.project, null);
  assert.equal(firstSession.id, secondSession.id);
  assert.ok(first.filter(record => record.kind === 'message').every(record => record.cwd === null));
  const rawAfterMigration = firstParse.provider.raw({
    source: 'pi',
    messageUuid: first.find(record => record.kind === 'message').uuid,
    session: { id: firstSession.id, jsonl_path: written.path },
    agentId: null,
    cursor: secondParse.cursor,
  });
  assert.deepEqual(JSON.parse(rawAfterMigration.text), migrated[1].message);
  assert.equal(rawAfterMigration.messageText, 'legacy user');

  const v2 = [
    header({ version: 2, id: 'legacy-v2' }),
    {
      type: 'message',
      id: 'hook',
      parentId: null,
      timestamp: '2026-08-02T10:00:01.000Z',
      message: {
        role: 'hookMessage',
        customType: 'legacy-hook',
        content: 'extension context',
        display: true,
        timestamp: 1785664800000,
      },
    },
  ];
  const hook = parseOnly(writeSession(jsonl(v2)).root).values.find(record => record.kind === 'message');
  assert.deepEqual(
    (({ type, role, content_type, is_meta, visibility }) => ({ type, role, content_type, is_meta, visibility }))(hook),
    { type: 'system', role: 'custom', content_type: 'custom', is_meta: 1, visibility: 'visible' },
  );
});

test('invalid tree identity, cycle, and leaf target fail closed', () => {
  const cases = [
    {
      pattern: /Duplicate Pi entry id/,
      records: [header(), userEntry('same', null, 'one'), userEntry('same', 'same', 'two')],
    },
    {
      pattern: /cycle/,
      records: [header(), userEntry('a', 'b', 'a'), userEntry('b', 'a', 'b')],
    },
    {
      pattern: /cycle/,
      records: [
        header(),
        userEntry('a', 'b', 'a'),
        userEntry('b', 'a', 'b'),
        {
          type: 'compaction',
          id: 'unrelated-compaction',
          parentId: null,
          timestamp: '2026-08-02T10:00:03.000Z',
          summary: 'Must not mask the cycle',
          firstKeptEntryId: 'a',
          tokensBefore: 10,
        },
      ],
    },
    {
      pattern: /leaf target .* does not exist/,
      records: [
        header(),
        userEntry('a', null, 'a'),
        { type: 'leaf', id: 'leaf', parentId: 'a', targetId: 'missing', timestamp: '2026-08-02T10:00:02.000Z' },
      ],
    },
  ];
  for (const { records, pattern } of cases) {
    const { root } = writeSession(jsonl(records));
    const provider = createPiProvider({ rootDir: root });
    const unit = provider.discover({ lastCursor: () => null })[0];
    assert.throws(() => drain(provider.parse(unit, null)), pattern);
  }
});

test('missing parents form official Pi orphan roots without exposing inactive branches', () => {
  const records = [
    header({ id: 'orphan-root' }),
    userEntry('inactive-root', null, 'inactive root'),
    userEntry('orphan', 'omitted-parent', 'orphan root', '2026-08-02T10:00:02.000Z'),
    userEntry('orphan-child', 'orphan', 'orphan child', '2026-08-02T10:00:03.000Z'),
  ];
  const { provider, unit, values } = parseOnly(writeSession(jsonl(records)).root);
  assert.deepEqual(
    values
      .filter(record => record.kind === 'message' && record.visibility === 'visible')
      .map(record => record.text),
    ['orphan root', 'orphan child'],
  );
  assert.equal(
    values.find(record => record.kind === 'message' && record.text === 'inactive root').visibility,
    'inactive',
  );

  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  persist(db, unit, provider.parse(unit, null));
  const query = createQueryApi(db);
  assert.deepEqual(query.thread(unit.sessionId).map(message => message.text), [
    'orphan root',
    'orphan child',
  ]);
  assert.deepEqual(assembleSessionDetail(values).messages.map(message => message.text), [
    'orphan root',
    'orphan child',
  ]);
  db.close();
});

test('discovery deduplicates identical same-project copies and rejects divergent copies', () => {
  const root = makeTempDir('obelisk-pi-copies-');
  const original = fixture('tool-session.jsonl');
  writeSession(original, { root, relativePath: 'a/session.jsonl' });
  writeSession(original, { root, relativePath: 'b/session.jsonl' });
  const provider = createPiProvider({ rootDir: root });
  assert.equal(provider.discover({ lastCursor: () => null }).length, 1);

  writeSession(`${original}${JSON.stringify({
    type: 'session_info',
    id: 'divergent-name',
    parentId: '9db96a87',
    timestamp: '2026-08-02T09:42:39.000Z',
    name: 'Diverged copy',
  })}\n`, { root, relativePath: 'b/session.jsonl' });
  const divergent = provider.discover({ lastCursor: () => null });
  assert.equal(divergent.length, 2);
  for (const unit of divergent) {
    assert.throws(() => drain(provider.parse(unit, null)), /Divergent Pi session copies/);
  }
});

test('discovery follows readable Pi JSONL file symlinks without retracting provenance', () => {
  const written = writeSession(jsonl([
    header({ id: 'symlink-session' }),
    userEntry('symlink-user', null, 'symlink evidence'),
  ]));
  const provider = createPiProvider({ rootDir: written.root });
  const original = provider.discover({ lastCursor: () => null })[0];
  const parsed = drain(provider.parse(original, null));
  const targetDir = makeTempDir('obelisk-pi-symlink-target-');
  const target = join(targetDir, 'session.jsonl');
  renameSync(written.path, target);
  symlinkSync(target, written.path);

  const units = provider.discover({
    lastCursor: key => key === written.path ? parsed.cursor : null,
    changedPaths: [written.path],
    indexedSessions: () => [{
      sessionId: original.sessionId,
      jsonlPath: written.path,
    }],
  });

  assert.equal(units.some(unit => unit.meta?.kind === 'pi-tombstone'), false);
  assert.equal(units.length, 1);
  assert.equal(units[0].sessionId, original.sessionId);
  assert.equal(
    drain(provider.parse(units[0], null)).values
      .find(record => record.kind === 'message').text,
    'symlink evidence',
  );
});

test('a malformed Pi file does not force unrelated unchanged sessions to reparse', () => {
  const root = makeTempDir('obelisk-pi-bad-file-scope-');
  const damaged = writeSession(jsonl([
    header({ id: 'damaged-session' }),
    userEntry('damaged-user', null, 'damaged source'),
  ]), { root, relativePath: 'a/session.jsonl' });
  const unchanged = writeSession(jsonl([
    header({ id: 'unchanged-session' }),
    userEntry('unchanged-user', null, 'unchanged source'),
  ]), { root, relativePath: 'b/session.jsonl' });
  const provider = createPiProvider({ rootDir: root });
  const cursors = new Map();
  const indexed = [];
  for (const unit of provider.discover({ lastCursor: () => null })) {
    cursors.set(unit.key, drain(provider.parse(unit, null)).cursor);
    indexed.push({ sessionId: unit.sessionId, jsonlPath: unit.key });
  }

  writeFileSync(damaged.path, '{broken}\n');
  const units = provider.discover({
    lastCursor: key => cursors.get(key) ?? null,
    indexedSessions: () => indexed,
  });

  assert.deepEqual(units.map(unit => unit.key), [damaged.path]);
  assert.equal(units.some(unit => unit.key === unchanged.path), false);
  assert.throws(() => drain(provider.parse(units[0], null)), /Empty Pi session/);
});

test('discovery ignores exported subagent artifact transcripts', () => {
  const root = makeTempDir('obelisk-pi-subagent-artifacts-');
  const session = writeSession(fixture('tool-session.jsonl'), { root });
  writeSession(jsonl([{
    version: 1,
    recordType: 'message',
    source: 'subagent',
    text: 'not a Pi session',
  }]), { root, relativePath: 'project/subagent-artifacts/worker_transcript.jsonl' });

  const units = createPiProvider({ rootDir: root }).discover({ lastCursor: () => null });

  assert.deepEqual(units.map(unit => unit.key), [session.path]);
});

test('a moved session with an unreadable identity cannot retract its last good snapshot', () => {
  const written = writeSession(jsonl([
    header({ id: 'moved-torn-session' }),
    userEntry('moved-user', null, 'last good evidence'),
  ]));
  const provider = createPiProvider({ rootDir: written.root });
  const original = provider.discover({ lastCursor: () => null })[0];
  const parsed = drain(provider.parse(original, null));
  const movedPath = join(written.root, 'moved', 'session.jsonl');
  mkdirSync(dirname(movedPath), { recursive: true });
  renameSync(written.path, movedPath);
  writeFileSync(movedPath, '{torn header\n');
  let incomplete = false;

  const units = provider.discover({
    lastCursor: key => key === written.path ? parsed.cursor : null,
    indexedSessions: () => [{
      sessionId: original.sessionId,
      jsonlPath: written.path,
    }],
    reportIncompleteInventory: () => { incomplete = true; },
  });

  assert.equal(incomplete, false, 'a bad identity is not an incomplete filesystem traversal');
  assert.deepEqual(units.map(unit => unit.key), [movedPath]);
  assert.equal(units[0].retractSessionIds, undefined);
  assert.equal(units.some(unit => unit.meta?.kind === 'pi-tombstone'), false);
  assert.throws(() => drain(provider.parse(units[0], null)), /Empty Pi session/);
});

test('a bad selected copy forces an unchanged valid duplicate to refresh provenance', () => {
  const root = makeTempDir('obelisk-pi-bad-copy-');
  const content = fixture('tool-session.jsonl');
  const second = writeSession(content, { root, relativePath: 'b/session.jsonl' });
  const provider = createPiProvider({ rootDir: root });
  const initialUnit = provider.discover({ lastCursor: () => null })[0];
  const initial = drain(provider.parse(initialUnit, null));
  const cursors = new Map([[second.path, initial.cursor]]);

  const first = writeSession(content, { root, relativePath: 'a/session.jsonl' });
  const selected = provider.discover({
    lastCursor: key => cursors.get(key) ?? null,
  })[0];
  assert.equal(selected.key, first.path);
  const selectedParse = drain(provider.parse(selected, null));
  cursors.set(first.path, selectedParse.cursor);

  writeFileSync(first.path, '{broken}\n');
  const recovery = provider.discover({
    lastCursor: key => cursors.get(key) ?? null,
    indexedSessions: () => [{
      sessionId: initialUnit.sessionId,
      jsonlPath: first.path,
    }],
  });
  const survivor = recovery.find(unit => unit.key === second.path);

  assert.ok(survivor, 'the valid copy must bypass its unchanged cursor');
  assert.equal(survivor.sessionId, initialUnit.sessionId);
  assert.equal(
    drain(provider.parse(survivor, null)).values
      .find(record => record.kind === 'session').jsonl_path,
    second.path,
  );
});

test('the same official project-local session id remains distinct across cwd namespaces', () => {
  const root = makeTempDir('obelisk-pi-project-ids-');
  const firstHeader = header({ id: 'shared-custom-id', cwd: '/tmp/pi-project-a' });
  const secondHeader = header({ id: 'shared-custom-id', cwd: '/tmp/pi-project-b' });
  writeSession(jsonl([
    firstHeader,
    userEntry('project-a-user', null, 'project A evidence'),
  ]), { root, relativePath: 'a/session.jsonl' });
  writeSession(jsonl([
    secondHeader,
    userEntry('project-b-user', null, 'project B evidence'),
  ]), { root, relativePath: 'b/session.jsonl' });

  const provider = createPiProvider({ rootDir: root });
  const units = provider.discover({ lastCursor: () => null });
  assert.equal(units.length, 2);
  assert.deepEqual(
    new Set(units.map(unit => unit.sessionId)),
    new Set([piSessionId(firstHeader), piSessionId(secondHeader)]),
  );

  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  for (const unit of units) persist(db, unit, provider.parse(unit, null));
  assert.deepEqual(
    new Set(db.prepare("SELECT id FROM sessions WHERE source='pi'").all().map(row => row.id)),
    new Set([piSessionId(firstHeader), piSessionId(secondHeader)]),
  );
  assert.equal(createQueryApi(db).search('project evidence').length, 2);
  db.close();
});

test('identity migration retracts a legacy row attached to a non-selected identical copy', () => {
  const root = makeTempDir('obelisk-pi-identity-migration-');
  const content = fixture('tool-session.jsonl');
  const first = writeSession(content, { root, relativePath: 'a/session.jsonl' });
  const second = writeSession(content, { root, relativePath: 'b/session.jsonl' });
  const provider = createPiProvider({ rootDir: root });
  const initialUnit = provider.discover({ lastCursor: () => null })[0];
  const initial = drain(provider.parse(initialUnit, null));
  const sourceHeader = JSON.parse(content.split('\n')[0]);
  const legacyId = `pi:${sourceHeader.id}`;

  const migration = provider.discover({
    lastCursor: key => key === first.path ? initial.cursor : null,
    indexedSessions: () => [{ sessionId: legacyId, jsonlPath: second.path }],
  });
  assert.equal(migration.length, 1);
  assert.equal(migration[0].key, first.path);
  assert.equal(migration[0].sessionId, piSessionId(sourceHeader));
  assert.deepEqual(migration[0].retractSessionIds, [legacyId]);
  assert.deepEqual(
    drain(provider.parse(migration[0], null)).values
      .filter(record => record.kind === 'delete-session')
      .map(record => record.sessionId),
    [piSessionId(sourceHeader)],
  );
});

test('unlinking a deduplicated Pi copy reparses the surviving source instead of deleting the session', () => {
  const root = makeTempDir('obelisk-pi-copy-move-');
  const content = fixture('tool-session.jsonl');
  const first = writeSession(content, { root, relativePath: 'a/session.jsonl' });
  const second = writeSession(content, { root, relativePath: 'b/session.jsonl' });
  const provider = createPiProvider({ rootDir: root });
  const original = provider.discover({ lastCursor: () => null })[0];
  const parsed = drain(provider.parse(original, null));

  unlinkSync(first.path);
  const survivors = provider.discover({
    lastCursor: key => key === first.path ? parsed.cursor : null,
    changedPaths: [first.path],
    indexedSessions: () => [{ sessionId: original.sessionId, jsonlPath: first.path }],
  });
  assert.equal(survivors.length, 1);
  assert.equal(survivors[0].key, second.path);
  assert.deepEqual(survivors[0].retractSessionIds, undefined);
  assert.equal(
    drain(provider.parse(survivors[0], null)).values.find(record => record.kind === 'session').jsonl_path,
    second.path,
  );
});

test('replacing one Pi copy preserves the original identity when another copy survives', () => {
  const root = makeTempDir('obelisk-pi-copy-replace-');
  const content = fixture('tool-session.jsonl');
  const first = writeSession(content, { root, relativePath: 'a/session.jsonl' });
  const second = writeSession(content, { root, relativePath: 'b/session.jsonl' });
  const provider = createPiProvider({ rootDir: root });
  const original = provider.discover({ lastCursor: () => null })[0];
  drain(provider.parse(original, null));

  writeFileSync(first.path, jsonl([
    header({ id: 'replacement-copy' }),
    userEntry('replacement-user', null, 'replacement'),
  ]));
  const units = provider.discover({
    lastCursor: () => null,
    changedPaths: [first.path],
    indexedSessions: () => [{ sessionId: original.sessionId, jsonlPath: first.path }],
  });

  assert.deepEqual(
    units.map(unit => ({ path: unit.key, sessionId: unit.sessionId, retract: unit.retractSessionIds })),
    [
      {
        path: first.path,
        sessionId: piSessionId(header({ id: 'replacement-copy' })),
        retract: undefined,
      },
      { path: second.path, sessionId: original.sessionId, retract: undefined },
    ],
  );
});

test('changed-path discovery bypasses cursors while an unchanged passive pull is skipped', () => {
  const first = writeSession(fixture('tool-session.jsonl'));
  const provider = createPiProvider({ rootDir: first.root });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const { cursor } = drain(provider.parse(unit, null));

  assert.deepEqual(provider.discover({ lastCursor: () => cursor }), []);
  assert.deepEqual(
    provider.discover({ lastCursor: () => cursor, changedPaths: [first.path] }).map(candidate => candidate.key),
    [first.path],
  );
});

test('Pi snapshot cursors detect same-identity and replacement writes that preserve mtime', () => {
  const written = writeSession(jsonl([
    header({ id: 'preserved-mtime' }),
    userEntry('before', null, 'before'),
  ]));
  const provider = createPiProvider({ rootDir: written.root });
  const initialUnit = provider.discover({ lastCursor: () => null })[0];
  const initial = drain(provider.parse(initialUnit, null));

  const replaceAtSameMtime = (content) => {
    const before = statSync(written.path);
    const replacement = `${written.path}.replacement`;
    writeFileSync(replacement, content);
    utimesSync(replacement, before.atime, before.mtime);
    renameSync(replacement, written.path);
    utimesSync(written.path, before.atime, before.mtime);
  };

  replaceAtSameMtime(jsonl([
    header({ id: 'preserved-mtime' }),
    userEntry('after', null, 'after!'),
  ]));
  const sameIdentity = provider.discover({
    lastCursor: () => initial.cursor,
    indexedSessions: () => [{ sessionId: initialUnit.sessionId, jsonlPath: written.path }],
  });
  assert.equal(sameIdentity.length, 1);
  assert.equal(sameIdentity[0].sessionId, initialUnit.sessionId);
  const updated = drain(provider.parse(sameIdentity[0], initial.cursor));

  replaceAtSameMtime(jsonl([
    header({ id: 'replacement-mtime' }),
    userEntry('replacement', null, 'replacement'),
  ]));
  const replacement = provider.discover({
    lastCursor: () => updated.cursor,
    indexedSessions: () => [{ sessionId: initialUnit.sessionId, jsonlPath: written.path }],
  });
  assert.equal(replacement.length, 1);
  assert.equal(replacement[0].sessionId, piSessionId(header({ id: 'replacement-mtime' })));
  assert.deepEqual(replacement[0].retractSessionIds, [initialUnit.sessionId]);
});

test('incomplete Pi inventories never infer deletion from changed paths', () => {
  const parent = makeTempDir('obelisk-pi-incomplete-');
  const unreadableRoot = join(parent, 'sessions');
  writeFileSync(unreadableRoot, 'not a directory');
  const indexedPath = join(unreadableRoot, 'project', 'session.jsonl');
  const provider = createPiProvider({ rootDir: unreadableRoot });

  assert.deepEqual(provider.discover({
    lastCursor: () => null,
    changedPaths: [unreadableRoot],
    indexedSessions: () => [{ sessionId: 'pi:preserve-me', jsonlPath: indexedPath }],
  }), []);
});

test('a file disappearing during discovery marks the inventory incomplete without throwing', () => {
  const written = writeSession(jsonl([
    header({ id: 'discovery-race' }),
    userEntry('message', null, 'vanishing source'),
  ]));
  const provider = createPiProvider({ rootDir: written.root });
  let incomplete = false;

  const units = provider.discover({
    lastCursor: () => null,
    indexedSessions: () => {
      unlinkSync(written.path);
      return [];
    },
    reportIncompleteInventory: () => { incomplete = true; },
  });

  assert.deepEqual(units, []);
  assert.equal(incomplete, true);
});

test('indexed provenance retracts a replaced identity and emits an unlink tombstone', () => {
  const written = writeSession(jsonl([header({ id: 'before' }), userEntry('a', null, 'before')]));
  const provider = createPiProvider({ rootDir: written.root });
  const beforeUnit = provider.discover({ lastCursor: () => null })[0];
  const before = drain(provider.parse(beforeUnit, null));
  const beforeSession = before.values.find(record => record.kind === 'session').id;

  writeFileSync(written.path, jsonl([header({ id: 'after' }), userEntry('b', null, 'after')]));
  const afterUnit = provider.discover({
    lastCursor: () => before.cursor,
    changedPaths: [written.path],
    indexedSessions: () => [{ sessionId: beforeSession, jsonlPath: written.path }],
  })[0];
  assert.deepEqual(afterUnit.retractSessionIds, [beforeSession]);
  const after = drain(provider.parse(afterUnit, null));
  const afterSession = after.values.find(record => record.kind === 'session').id;
  assert.notEqual(afterSession, beforeSession);
  assert.deepEqual(
    after.values.filter(record => record.kind === 'delete-session').map(record => record.sessionId),
    [afterSession],
  );

  unlinkSync(written.path);
  const tombstones = provider.discover({
    lastCursor: () => after.cursor,
    changedPaths: [written.path],
    indexedSessions: () => [{ sessionId: afterSession, jsonlPath: written.path }],
  });
  assert.equal(tombstones.length, 1);
  assert.deepEqual(tombstones[0].retractSessionIds, [afterSession]);
  const tombstone = drain(provider.parse(tombstones[0], after.cursor));
  assert.deepEqual(tombstone.values, []);
  assert.equal(tombstone.cursor, '0:0');
});

test('session identity combines Pi project-local header id with stable cwd namespace', () => {
  const source = JSON.parse(fixture('tool-session.jsonl').split('\n')[0]);
  const migrated = {
    ...source,
    version: source.version === 3 ? 2 : 3,
    timestamp: '2030-01-01T00:00:00.000Z',
    parentSession: '/tmp/parent.jsonl',
  };
  assert.equal(piSessionId(source), piSessionId(migrated));
  assert.notEqual(piSessionId(source), piSessionId({ ...source, id: 'different-session' }));
  assert.notEqual(piSessionId(source), piSessionId({ ...source, cwd: '/tmp/other-project' }));
});

test('long linear Pi trees validate without repeated prefix walks', () => {
  const records = [header({ id: 'long-linear' })];
  let parentId = null;
  for (let index = 0; index < 5000; index++) {
    const id = `entry-${index}`;
    records.push(userEntry(id, parentId, `message ${index}`));
    parentId = id;
  }
  const { values } = parseOnly(writeSession(jsonl(records)).root);
  assert.equal(values.filter(record => record.kind === 'message').length, 5000);
});
