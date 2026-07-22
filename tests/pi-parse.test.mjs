import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  createPiProvider,
  defaultPiSessionsRoot,
} from '../packages/core/src/providers/pi.ts';
import { persist } from '../packages/core/src/persist.ts';
import { createQueryApi } from '../packages/core/src/query.ts';
import { createProviderRegistry } from '../packages/core/src/providers/registry.ts';
import { assembleSessionDetail } from '../packages/core/src/session-detail.ts';

const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');

function drain(generator) {
  const values = [];
  let step = generator.next();
  while (!step.done) {
    values.push(step.value);
    step = generator.next();
  }
  return { values, cursor: step.value };
}

function coreFixture({ explicitTitle = true, torn = false, firstUserText = 'Inspect the Pi fixture' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'obelisk-pi-'));
  const projectDir = join(root, '--tmp-pi-project--');
  const path = join(projectDir, '2026-07-20T10-00-00_session-native.jsonl');
  mkdirSync(projectDir, { recursive: true });
  const entries = [
    { type: 'session', version: 3, id: 'session-native', timestamp: '2026-07-20T10:00:00.000Z', cwd: '/tmp/pi-project' },
    { type: 'message', id: 'u1', parentId: null, timestamp: '2026-07-20T10:00:01.000Z', message: {
      role: 'user', content: [
        { type: 'text', text: firstUserText },
        { type: 'image', data: 'BASE64_SHOULD_NOT_BE_INDEXED', mimeType: 'image/png' },
      ], timestamp: 1784541601000,
    } },
    { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-07-20T10:00:02.000Z', message: {
      role: 'assistant', model: 'model-one', provider: 'test', api: 'messages',
      content: [
        { type: 'thinking', thinking: 'I should read it' },
        { type: 'toolCall', id: 'call-read', name: 'read', arguments: { path: '/tmp/pi-project/source.ts' } },
        { type: 'text', text: 'Read complete' },
      ],
      usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 3, totalTokens: 19 },
      stopReason: 'stop', timestamp: 1784541602000,
    } },
    { type: 'message', id: 'r1', parentId: 'a1', timestamp: '2026-07-20T10:00:03.000Z', message: {
      role: 'toolResult', toolCallId: 'call-read', toolName: 'read',
      content: [{ type: 'text', text: 'export const value = 1;' }, { type: 'image', data: 'RESULT_BASE64', mimeType: 'image/png' }],
      isError: true, timestamp: 1784541603000,
    } },
    { type: 'model_change', id: 'model2', parentId: 'r1', timestamp: '2026-07-20T10:00:04.000Z', provider: 'test', modelId: 'model-two' },
    { type: 'message', id: 'side-u', parentId: 'u1', timestamp: '2026-07-20T10:00:05.000Z', message: { role: 'user', content: 'abandoned branch' } },
    { type: 'message', id: 'side-a', parentId: 'side-u', timestamp: '2026-07-20T10:00:06.000Z', message: { role: 'assistant', model: 'side-model', content: [{ type: 'text', text: 'side answer' }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } },
    { type: 'branch_summary', id: 'branch-sum', parentId: 'side-a', timestamp: '2026-07-20T10:00:07.000Z', fromId: 'side-a', summary: 'The abandoned branch tried another approach.' },
    { type: 'compaction', id: 'compact', parentId: 'model2', timestamp: '2026-07-20T10:00:08.000Z', summary: 'Earlier active work was compacted.', firstKeptEntryId: 'r1', tokensBefore: 50000 },
    { type: 'custom_message', id: 'hidden-custom', parentId: 'compact', timestamp: '2026-07-20T10:00:09.000Z', customType: 'fixture-extension', content: [
      { type: 'text', text: 'extension-only context' },
      { type: 'image', data: 'CUSTOM_BASE64', mimeType: 'image/png' },
    ], display: false },
    { type: 'message', id: 'bash1', parentId: 'hidden-custom', timestamp: '2026-07-20T10:00:10.000Z', message: {
      role: 'bashExecution', command: 'pwd', output: '/tmp/pi-project', exitCode: 0, cancelled: false, truncated: false,
    } },
    { type: 'message', id: 'u2', parentId: 'bash1', timestamp: '2026-07-20T10:00:11.000Z', message: { role: 'user', content: 'Continue on the active branch' } },
    ...(explicitTitle ? [{ type: 'session_info', id: 'info1', parentId: 'u2', timestamp: '2026-07-20T10:00:12.000Z', name: 'Explicit Pi fixture title' }] : []),
  ];
  const complete = `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
  writeFileSync(path, torn ? `${complete}{"type":"message","id":"torn"` : complete);

  const nestedDir = join(projectDir, 'session-native', 'subagents', 'run-1');
  mkdirSync(nestedDir, { recursive: true });
  writeFileSync(join(nestedDir, 'session.jsonl'), `${JSON.stringify({
    type: 'session', version: 3, id: 'nested-run', timestamp: '2026-07-20T10:00:00.000Z', cwd: '/tmp/pi-project',
  })}\n`);
  return { root, path, entries };
}

test('Pi default session root follows documented environment and global-setting precedence', () => {
  const home = mkdtempSync(join(tmpdir(), 'obelisk-pi-home-'));
  const cwd = join(home, 'work');
  const agentDir = join(home, 'agent-home');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ sessionDir: '~/custom-pi-sessions' }));

  assert.equal(defaultPiSessionsRoot({
    env: { PI_CODING_AGENT_SESSION_DIR: './env-sessions', PI_CODING_AGENT_DIR: agentDir }, home, cwd,
  }), join(cwd, 'env-sessions'));
  assert.equal(defaultPiSessionsRoot({ env: { PI_CODING_AGENT_DIR: agentDir }, home, cwd }), join(home, 'custom-pi-sessions'));
  assert.equal(defaultPiSessionsRoot({ env: {}, home, cwd }), join(home, '.pi', 'agent', 'sessions'));
  assert.equal(createPiProvider({ rootDir: '/configured/pi/sessions' }).descriptor.defaultRoot, '/configured/pi/sessions');
});

test('Pi discovery includes only root session JSONL, honors changedPaths, and uses a stable numeric cursor', () => {
  const { root, path } = coreFixture();
  const provider = createPiProvider({ rootDir: root });
  const initial = provider.discover({ lastCursor: () => null });

  assert.equal(initial.length, 1, 'nested subagent run session.jsonl is excluded in v1');
  assert.equal(initial[0].key, path);
  assert.equal(initial[0].sessionId, 'pi:session-native');
  assert.equal(initial[0].project, '-tmp-pi-project');

  const observedMtime = statSync(path).mtimeMs;
  const storedCursorWithDifferentLineCount = `${observedMtime}:999999`;
  assert.deepEqual(provider.discover({ lastCursor: () => storedCursorWithDifferentLineCount }), [],
    'unchanged discovery compares mtime before reading or counting transcript lines');
  assert.deepEqual(provider.discover({
    lastCursor: () => storedCursorWithDifferentLineCount,
    changedPaths: [path],
  }).map((unit) => unit.key), [path], 'explicit changed paths force replay even when mtime matches');
  assert.deepEqual(provider.discover({
    lastCursor: () => null,
    changedPaths: [join(root, '--tmp-pi-project--', 'session-native', 'subagents', 'run-1', 'session.jsonl')],
  }), []);
  assert.deepEqual(provider.watchRoots('/configured/root'), ['/configured/root']);
});

test('Pi full replay emits canonical namespaced tree, block, model, usage, tool, summary, and metadata records', () => {
  const { root } = coreFixture({ torn: true });
  const provider = createPiProvider({ rootDir: root });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const { values, cursor } = drain(provider.parse(unit, '0:999'));
  const byKind = (kind) => values.filter((record) => record.kind === kind);

  assert.deepEqual(values[0], { kind: 'delete-session', sessionId: 'pi:session-native' });
  assert.equal(values.at(-1).kind, 'session');
  assert.match(cursor, /^\d+(?:\.\d+)?:\d+$/);
  assert.equal(cursor.split(':')[1], '14', 'cursor counts the ignored torn physical line');

  const session = byKind('session')[0];
  assert.deepEqual({
    id: session.id, title: session.title, project: session.project, version: session.version,
    git_branch: session.git_branch, source: session.source, countMode: session.countMode,
  }, {
    id: 'pi:session-native', title: 'Explicit Pi fixture title', project: '-tmp-pi-project',
    version: '3', git_branch: null, source: 'pi', countMode: 'total',
  });

  const messages = byKind('message');
  assert.ok(messages.every((message) => message.uuid.startsWith('pi:')));
  assert.equal(new Set(messages.map((message) => message.uuid)).size, messages.length);
  assert.deepEqual(
    messages.filter((message) => ['I should read it', null, 'Read complete'].includes(message.text))
      .map((message) => [message.content_type, message.text]),
    [['thinking', 'I should read it'], ['tool_use', null], ['text', 'Read complete']],
  );
  const assistantParts = messages.filter((message) => message.uuid.includes(':message:a1:'));
  assert.deepEqual(assistantParts.map((message) => [message.input_tokens, message.output_tokens]), [
    [null, null], [null, null], [15, 4],
  ]);
  assert.equal(messages.find((message) => message.text === 'Continue on the active branch').model, 'model-two');
  assert.equal(messages.find((message) => message.text === 'abandoned branch').is_sidechain, 1);
  assert.equal(messages.find((message) => message.text === 'side answer').is_sidechain, 1);
  assert.equal(messages.find((message) => message.text === 'Continue on the active branch').is_sidechain, 0);
  assert.equal(
    messages.find((message) => message.text === 'export const value = 1;').parent_uuid,
    'pi:session-native:message:a1:2',
    'entry parent maps to the final canonical message emitted by its ancestor',
  );
  const bash = messages.find((message) => message.type === 'bashExecution');
  assert.equal(bash.text, '$ pwd\n/tmp/pi-project');
  assert.equal(bash.parent_uuid, 'pi:session-native:message:hidden-custom:0');

  const hidden = messages.find((message) => message.text === 'extension-only context');
  assert.equal(hidden.is_meta, 1);
  assert.equal(hidden.visibility, 'hidden');
  assert.equal(JSON.stringify(messages).includes('BASE64'), false);

  assert.deepEqual(byKind('tool_call').map((record) => ({
    id: record.id, name: record.name, path: record.file_path,
  })), [{ id: 'pi:session-native:tool:call-read', name: 'read', path: '/tmp/pi-project/source.ts' }]);
  assert.deepEqual(byKind('tool_result').map((record) => ({
    id: record.tool_use_id, content: record.content, path: record.file_path, error: record.is_error,
  })), [{
    id: 'pi:session-native:tool:call-read', content: 'export const value = 1;',
    path: '/tmp/pi-project/source.ts', error: 1,
  }]);
  assert.deepEqual(byKind('summary').map((record) => [record.id, record.source, record.content]), [
    ['pi:session-native:summary:branch-sum:branch_summary', 'branch_summary', 'The abandoned branch tried another approach.'],
    ['pi:session-native:summary:compact:compaction', 'compaction', 'Earlier active work was compacted.'],
  ]);

  const detail = assembleSessionDetail(values);
  assert.equal(detail.session.id, 'pi:session-native');
  assert.equal(detail.messages.some((message) => message.text === 'extension-only context'), false);
  const toolMessage = detail.messages.find((message) => message.tool_calls?.length);
  assert.equal(toolMessage.tool_calls[0].result.content, 'export const value = 1;');
});

test('Pi title falls back to bounded first real user text and raw lookup projects no image data', () => {
  const firstUserText = 'Inspect the Pi fixture ' + 'x'.repeat(220);
  const { root, path } = coreFixture({ explicitTitle: false, firstUserText });
  const provider = createPiProvider({ rootDir: root });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const { values } = drain(provider.parse(unit, null));
  const session = values.find((record) => record.kind === 'session');
  const firstUser = values.find((record) => record.kind === 'message' && record.text === firstUserText);

  assert.equal(session.title, firstUserText.slice(0, 200));
  const raw = provider.raw({
    source: 'pi', messageUuid: firstUser.uuid, session: { jsonl_path: path }, agentId: null,
  });
  assert.equal(raw.messageText, firstUserText);
  assert.ok(raw.text.includes('BASE64_SHOULD_NOT_BE_INDEXED'), 'raw returns the original source line');
  assert.equal(raw.messageText.includes('BASE64'), false, 'projected expansion omits image payloads');
});

test('Pi full replay deletes stale persisted rows and round-trips through canonical session detail', () => {
  const { root, path, entries } = coreFixture();
  const provider = createPiProvider({ rootDir: root });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const firstRecords = drain(provider.parse(unit, null)).values;
  const direct = assembleSessionDetail(firstRecords);
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  persist(db, unit, provider.parse(unit, null));

  const persisted = assembleSessionDetail({
    session: db.prepare('SELECT * FROM sessions').get(),
    messages: db.prepare('SELECT * FROM messages ORDER BY timestamp, uuid').all(),
    toolCalls: db.prepare('SELECT * FROM tool_calls').all(),
    toolResults: db.prepare('SELECT * FROM tool_results').all(),
    summaries: db.prepare('SELECT * FROM summaries').all(),
  });
  assert.deepEqual(persisted, direct);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM messages WHERE text = 'side answer'").get().c, 1);
  const userUuid = firstRecords.find((record) => record.kind === 'message' && record.text === 'Inspect the Pi fixture').uuid;
  const boundedRaw = createQueryApi(db, {
    providerRegistry: createProviderRegistry([provider]),
  }).raw(userUuid, { offset: 0, limit: 40 });
  assert.equal(boundedRaw.text.length, 40);
  assert.equal(boundedRaw.hasMore, true);

  const retained = entries.filter((entry) => !['side-u', 'side-a', 'branch-sum'].includes(entry.id));
  writeFileSync(path, `${retained.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  persist(db, unit, provider.parse(unit, '1:1'));

  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM messages WHERE text = 'side answer'").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM summaries WHERE source = 'branch_summary'").get().c, 0);
  assert.equal(db.prepare('SELECT message_count FROM sessions WHERE id = ?').get('pi:session-native').message_count,
    retained.filter((entry) => entry.type === 'message' || entry.type === 'custom_message').reduce((count, entry) => {
      if (entry.type === 'custom_message') return count + 1;
      if (entry.message.role === 'assistant') return count + entry.message.content.length;
      return count + 1;
    }, 0));
  db.close();
});

test('Pi assistant errorMessage is always a stable trailing canonical part and supports raw expansion', () => {
  const { root, path } = coreFixture();
  const entries = readFileSync(path, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
  entries.push({
    type: 'message', id: 'assistant-error', parentId: 'info1', timestamp: '2026-07-20T10:00:13.000Z',
    message: {
      role: 'assistant', model: 'model-two',
      content: [
        { type: 'thinking', thinking: 'partial reasoning' },
        { type: 'text', text: 'partial answer' },
        { type: 'toolCall', id: 'call-before-error', name: 'read', arguments: { path: '/tmp/pi-project/missing.ts' } },
      ],
      errorMessage: 'provider failed after partial output',
      usage: { input: 7, output: 2 },
    },
  });
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);

  const provider = createPiProvider({ rootDir: root });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const { values } = drain(provider.parse(unit, null));
  const parts = values.filter((record) => record.kind === 'message' && record.uuid.includes(':message:assistant-error:'));
  assert.deepEqual(parts.map(({ uuid, content_type, text }) => ({ uuid, content_type, text })), [
    { uuid: 'pi:session-native:message:assistant-error:0', content_type: 'thinking', text: 'partial reasoning' },
    { uuid: 'pi:session-native:message:assistant-error:1', content_type: 'text', text: 'partial answer' },
    { uuid: 'pi:session-native:message:assistant-error:2', content_type: 'tool_use', text: null },
    { uuid: 'pi:session-native:message:assistant-error:3', content_type: 'text', text: 'provider failed after partial output' },
  ]);
  assert.deepEqual(parts.map(({ input_tokens, output_tokens }) => [input_tokens, output_tokens]), [
    [null, null], [null, null], [null, null], [7, 2],
  ]);

  const raw = provider.raw({
    source: 'pi', messageUuid: parts.at(-1).uuid, session: { jsonl_path: path }, agentId: null,
  });
  assert.equal(raw.messageText, 'provider failed after partial output');
  assert.equal(JSON.parse(raw.text).id, 'assistant-error');
});

test('Pi latest session_info explicitly sets or clears replay title', () => {
  const { root, path } = coreFixture({ explicitTitle: false });
  const base = readFileSync(path, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
  base.push(
    { type: 'session_info', id: 'old-info', parentId: 'u2', name: 'Older title' },
    { type: 'session_info', id: 'clear-info', parentId: 'old-info', name: '   \t ' },
  );
  writeFileSync(path, `${base.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  const provider = createPiProvider({ rootDir: root });
  const unit = provider.discover({ lastCursor: () => null })[0];
  let replay = drain(provider.parse(unit, null)).values;
  assert.equal(replay.find((record) => record.kind === 'session').title, null,
    'latest whitespace name clears both an older name and first-prompt fallback');

  base.push({ type: 'session_info', id: 'new-info', parentId: 'clear-info', name: '  Latest title  ' });
  writeFileSync(path, `${base.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  replay = drain(provider.parse(unit, null)).values;
  assert.equal(replay.find((record) => record.kind === 'session').title, 'Latest title');
});

test('Pi bash execution text preserves failure, cancellation, and truncation status without noisy success metadata', () => {
  const { root, path } = coreFixture();
  const entries = readFileSync(path, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
  entries.push(
    { type: 'message', id: 'bash-failed', parentId: 'info1', message: {
      role: 'bashExecution', command: 'false', output: '', exitCode: 17, cancelled: false, truncated: false,
    } },
    { type: 'message', id: 'bash-signals', parentId: 'bash-failed', message: {
      role: 'bashExecution', command: 'long-job', output: 'partial', exitCode: 130, cancelled: true, truncated: true,
    } },
  );
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  const provider = createPiProvider({ rootDir: root });
  const values = drain(provider.parse(provider.discover({ lastCursor: () => null })[0], null)).values;
  const bash = new Map(values.filter((record) => record.kind === 'message' && record.type === 'bashExecution')
    .map((record) => [record.uuid, record.text]));
  assert.equal(bash.get('pi:session-native:message:bash1:0'), '$ pwd\n/tmp/pi-project');
  assert.equal(bash.get('pi:session-native:message:bash-failed:0'), '$ false\n[exit code: 17]');
  assert.equal(bash.get('pi:session-native:message:bash-signals:0'),
    '$ long-job\npartial\n[exit code: 130]\n[cancelled]\n[output truncated]');
});

test('Pi parser rejects self and cyclic cwd ancestry before yielding delete-session', () => {
  for (const { label, entries } of [
    {
      label: 'self parent',
      entries: [{ type: 'message', id: 'self', parentId: 'self', message: { role: 'user', content: 'self' } }],
    },
    {
      label: 'two-entry cycle',
      entries: [
        { type: 'message', id: 'cycle-a', parentId: 'cycle-b', message: { role: 'user', content: 'a' } },
        { type: 'message', id: 'cycle-b', parentId: 'cycle-a', message: { role: 'assistant', content: [{ type: 'text', text: 'b' }] } },
      ],
    },
  ]) {
    const root = mkdtempSync(join(tmpdir(), 'obelisk-pi-cycle-'));
    const projectDir = join(root, 'project');
    const path = join(projectDir, 'cycle.jsonl');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(path, [
      { type: 'session', version: 3, id: `cycle-${label}`, cwd: '/tmp/pi-cycle' },
      ...entries,
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    const provider = createPiProvider({ rootDir: root });
    const generator = provider.parse(provider.discover({ lastCursor: () => null })[0], null);
    assert.throws(() => generator.next(), /Pi session: corrupted cwd ancestry cycle involving entry .*cycle\.jsonl/, label);
  }
});

test('Pi parser rejects malformed complete interior lines but ignores only a torn final line', () => {
  const { root, path } = coreFixture();
  writeFileSync(path, `${readFileSync(path, 'utf8')}{bad json}\n${JSON.stringify({
    type: 'message', id: 'after-bad', parentId: null, timestamp: '2026-07-20T11:00:00.000Z', message: { role: 'user', content: 'after' },
  })}\n`);
  const provider = createPiProvider({ rootDir: root });
  const unit = { key: path, sessionId: 'pi:session-native' };

  assert.throws(() => drain(provider.parse(unit, null)), /corrupted line/);
});
