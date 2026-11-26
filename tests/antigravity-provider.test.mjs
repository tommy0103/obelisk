// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { antigravitySessionId, createAntigravityProvider } from '../packages/core/src/providers/antigravity.ts';
import { createBuiltinProviderRegistry } from '../packages/core/src/providers/builtins.ts';
import { projectSlugFromPath } from '../packages/core/src/parsing.ts';
import { createConfiguredBuiltinProviderRuntime } from '../packages/core/src/provider-settings.ts';
import { runWriteTransaction } from '../packages/core/src/tx.ts';
import { assembleSessionDetail } from '../packages/core/src/session-detail.ts';
import { createQueryApi } from '../packages/core/src/query.ts';
import { createProviderRegistry } from '../packages/core/src/providers/registry.ts';
import { createProviderIndexPlan, indexProviderPlan } from '../packages/core/src/provider-indexing.ts';
import { assertHarnessConformance } from './harness-conformance.mjs';
import { makeTempDir } from './temp-dirs.mjs';

// Captured Antigravity step logs with their text replaced; see fixtures/antigravity/README.md.
const fixture = name => readFileSync(new URL(`./fixtures/antigravity/${name}`, import.meta.url), 'utf8');
const CAPTURED = { a: fixture('conversation-a.jsonl'), b: fixture('conversation-b.jsonl'), c: fixture('conversation-c.jsonl') };
const SUMMARY_SCHEMA = fixture('conversation_summaries.sql');
const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');
const stepsOf = contents => contents.trimEnd().split('\n').map(line => JSON.parse(line));
const linesOf = contents => contents.trimEnd().split('\n');

const CONVERSATION = '0f0e0d0c-0b0a-4908-8706-050403020100';
const OTHER_CONVERSATION = '11111111-2222-4333-8444-555555555555';
const SESSION = antigravitySessionId(CONVERSATION);
const FIRST_REQUEST = 'Example request a1.';

function setup() {
  const root = makeTempDir('obelisk-antigravity-');
  return { root, provider: createAntigravityProvider({ rootDir: root }) };
}

function seedTranscript(root, { conversation = CONVERSATION, file = 'transcript_full.jsonl', contents = CAPTURED.a } = {}) {
  const dir = join(root, 'brain', conversation, '.system_generated', 'logs');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  writeFileSync(path, contents);
  return path;
}

// conversation_summaries.db as Antigravity defines it, with the columns a row needs.
function seedSummaries(root, rows, { schema = SUMMARY_SCHEMA } = {}) {
  const path = join(root, 'conversation_summaries.db');
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  db.exec(schema);
  const columns = new Set(db.prepare('PRAGMA table_info(conversation_summaries)').all().map(column => column.name));
  for (const row of rows) {
    const values = { title: '', workspace_uris: '', last_modified_time: '2026-01-02 03:04:05+00:00', last_user_input_time: '2026-01-02 03:04:05+00:00', ...row };
    const names = Object.keys(values).filter(name => columns.has(name));
    db.prepare(`INSERT INTO conversation_summaries (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
      .run(...names.map(name => values[name]));
  }
  db.close();
  return path;
}

// Antigravity records Windows workspaces with a lowercase drive letter.
function antigravityWorkspaceUri(path) {
  return pathToFileURL(path).href.replace(/^file:\/\/\/([A-Z]):/, (_, drive) => `file:///${drive.toLowerCase()}:`);
}

function drain(generator) {
  const records = [];
  let step = generator.next();
  while (!step.done) { records.push(step.value); step = generator.next(); }
  return { records, cursor: step.value };
}

function discover(provider, { cursors = new Map(), indexed = [], issues = [], changedPaths } = {}) {
  return provider.discover({ lastCursor: key => cursors.get(key) ?? null,
    indexedSessions: () => indexed, reportIncompleteInventory: issue => issues.push(issue),
    ...(changedPaths === undefined ? {} : { changedPaths }) });
}

function parseOnly(provider, options) {
  const units = discover(provider, options);
  assert.equal(units.length, 1);
  return { unit: units[0], ...drain(provider.parse(units[0], null)) };
}

function parseCaptured(contents) {
  const { root, provider } = setup();
  seedTranscript(root, { contents });
  return parseOnly(provider).records;
}

const local = (uuid, session = SESSION) => uuid.slice(session.length + 1);
const messagesOf = records => records.filter(row => row.kind === 'message');

function indexAll(db, registry) {
  const plan = createProviderIndexPlan(db, registry);
  indexProviderPlan({ db, plan, runTransaction: (_label, work) => runWriteTransaction(db, work), onError: error => { throw error; } });
  return plan;
}

test('Antigravity projects requests, replies, tool rounds and harness steps from a captured transcript', () => {
  const { root, provider } = setup();
  const path = seedTranscript(root);
  const issues = [];
  const { unit, records, cursor } = parseOnly(provider, { issues });
  assert.deepEqual(issues, []);
  assert.equal(unit.key, path);
  assert.equal(unit.sessionId, SESSION);
  assert.deepEqual(unit.retractSessionIds, [SESSION]);
  assert.match(cursor, /^[\d.]+:0:antigravity-snapshot-v1:[\d.]+:\d+:\d+:[\w-]{16}$/);
  assertHarnessConformance(records);

  const messages = messagesOf(records);
  assert.deepEqual(messages.map(row => [local(row.uuid), row.role, row.content_type, row.harness_kind, row.is_meta]), [
    ['L000001', 'user', 'text', null, 0],
    ['L000003:reminder', 'system', 'text', 'reminder', 1],
    ['L000005:1-thinking', 'assistant', 'thinking', null, 0],
    ['L000005:3-tools', 'assistant', 'tool_use', null, 0],
    ['L000009:1-thinking', 'assistant', 'thinking', null, 0],
    ['L000009:3-tools', 'assistant', 'tool_use', null, 0],
    ['L000011:reminder', 'system', 'text', 'reminder', 1],
    ['L000012:compaction', 'system', 'text', 'compaction', 1],
    ['L000013:1-thinking', 'assistant', 'thinking', null, 0],
    ['L000013:3-tools', 'assistant', 'tool_use', null, 0],
    ['L000020:1-thinking', 'assistant', 'thinking', null, 0],
    ['L000020:3-tools', 'assistant', 'tool_use', null, 0],
    ['L000023:1-thinking', 'assistant', 'thinking', null, 0],
    ['L000023:3-tools', 'assistant', 'tool_use', null, 0],
    ['L000028:1-thinking', 'assistant', 'thinking', null, 0],
    ['L000028:2-text', 'assistant', 'text', null, 0],
    ['L000028:3-tools', 'assistant', 'tool_use', null, 0],
    ['L000031:error', 'system', 'text', 'error', 1],
    ['L000032:3-tools', 'assistant', 'tool_use', null, 0],
    ['L000035:1-thinking', 'assistant', 'thinking', null, 0],
    ['L000035:2-text', 'assistant', 'text', null, 0],
    ['L000036', 'user', 'text', null, 0],
    ['L000037:1-thinking', 'assistant', 'thinking', null, 0],
    ['L000037:3-tools', 'assistant', 'tool_use', null, 0],
  ]);
  // The first request is logged three times under step index 0 and counts once.
  const steps = stepsOf(CAPTURED.a);
  assert.deepEqual(steps.filter(step => step.type === 'USER_INPUT').map(step => step.step_index), [0, 0, 0, 1748]);
  assert.deepEqual(messages.filter(row => row.role === 'user').map(row => row.text), [FIRST_REQUEST, 'Example request a57. ']);
  assert.deepEqual(messages.map(row => row.parent_uuid), [null, ...messages.slice(0, -1).map(row => row.uuid)]);
  assert.ok(messages.every(row => row.source === 'antigravity' && row.visibility === 'visible' && row.cwd === null && row.model === null));
  assert.equal(messages[0].timestamp, '2026-01-02T03:04:05.000Z');

  // Input tokens include the cached prefix Antigravity reports separately, once per model call.
  const usage = Object.fromEntries(messages.filter(row => row.input_tokens !== null).map(row => [local(row.uuid), [row.input_tokens, row.output_tokens]]));
  assert.deepEqual(usage['L000009:1-thinking'], [3285 + 97555, 398]);
  assert.deepEqual(usage['L000012:compaction'], [7442 + 527335, 6355]);
  assert.deepEqual(usage['L000032:3-tools'], [4916 + 457004, 203]);
  const callsWithUsage = steps.filter(step => step.type !== 'USER_INPUT' && typeof step.input_tokens === 'number');
  assert.equal(Object.keys(usage).length, callsWithUsage.length);
  assert.equal(messages.reduce((sum, row) => sum + (row.output_tokens ?? 0), 0),
    callsWithUsage.reduce((sum, step) => sum + step.output_tokens, 0));

  // Every call gets the output that follows its response, in order.
  const calls = records.filter(row => row.kind === 'tool_call');
  const results = records.filter(row => row.kind === 'tool_result');
  assert.equal(calls.length, 21);
  assert.deepEqual(results.map(row => row.tool_use_id), calls.map(row => row.id));
  assert.ok(results.every(row => row.message_uuid === calls.find(call => call.id === row.tool_use_id).message_uuid));
  const byCall = Object.fromEntries(results.map(row => [local(row.tool_use_id), row]));
  // A failed tool keeps its output and is marked as an error.
  assert.deepEqual([byCall['L000020:3-tools:c001'].content, byCall['L000020:3-tools:c001'].is_error], [steps[20].content, 1]);
  // A command still running when the log was written keeps the output so far.
  assert.equal(steps[9].status, 'RUNNING');
  assert.deepEqual([byCall['L000009:3-tools:c001'].content, byCall['L000009:3-tools:c001'].is_error], [steps[9].content, 0]);
  assert.equal(results.filter(row => row.is_error).length, 1);

  // Arguments are stored as decoded JSON, and the file a call reads is named.
  const firstRound = calls.filter(row => row.message_uuid === `${SESSION}:L000005:3-tools`);
  assert.deepEqual(firstRound.map(row => [row.name, row.file_path]), [
    ['read_file', '/workspace/example/file-1.txt'], ['swarm', null], ['run_command', null],
  ]);
  assert.deepEqual(JSON.parse(firstRound[1].input_json), { action: 'Example value a10.', all: true });
  assert.equal(JSON.parse(firstRound[2].input_json).WaitMsBeforeAsync, 5000);

  assert.deepEqual(records.at(-1), {
    kind: 'session', id: SESSION, title: FIRST_REQUEST, project: null,
    started_at: '2026-01-02T03:04:05.000Z', ended_at: '2026-01-02T03:08:24.000Z', git_branch: null,
    version: null, message_count: 24, countMode: 'total', jsonl_path: path, source: 'antigravity', started_by: null,
  });
});

test('Antigravity keeps an output without a pending call as a harness result, and responses logged without usage carry none', () => {
  const extra = parseCaptured(CAPTURED.b);
  assertHarnessConformance(extra);
  assert.deepEqual(messagesOf(extra).map(row => [local(row.uuid), row.role, row.harness_kind, row.text, row.input_tokens]), [
    ['L000001', 'user', null, 'Example request b1.', null],
    ['L000002:3-tools', 'assistant', null, null, 18763 + 19865],
    ['L000005:output', 'system', 'result', stepsOf(CAPTURED.b)[4].content, null],
  ]);
  assert.equal(extra.filter(row => row.kind === 'tool_result').length, 2);

  const unmetered = parseCaptured(CAPTURED.c);
  assertHarnessConformance(unmetered);
  assert.ok(stepsOf(CAPTURED.c).every(step => step.input_tokens === undefined));
  assert.deepEqual(messagesOf(unmetered).map(row => [local(row.uuid), row.input_tokens, row.output_tokens]), [
    ['L000001', null, null], ['L000002:3-tools', null, null], ['L000004:3-tools', null, null],
  ]);
  assert.deepEqual(unmetered.filter(row => row.kind === 'tool_call').map(row => row.file_path),
    ['/workspace/example/file-1.txt', '/workspace/example/file-2.txt']);
});

test('Antigravity still emits a row for a step without text, and tolerates unknown or malformed lines', () => {
  // Edits of captured lines: a request that is only an attachment, a response
  // that left nothing but usage, a step type this adapter does not know, and a torn line.
  const [request, response] = stepsOf(CAPTURED.a).filter(step => step.step_index === 1748 || step.step_index === 1749);
  const attachmentOnly = { ...request, content: '<USER_REQUEST>\n\n</USER_REQUEST>' };
  const { thinking: _thinking, tool_calls: _calls, ...usageOnly } = response;
  const future = { step_index: 1751, source: 'SYSTEM', type: 'FUTURE_STEP', status: 'DONE', created_at: '2026-01-02T03:09:00Z' };
  const contents = [attachmentOnly, usageOnly, future].map(step => JSON.stringify(step)).join('\n') + '\n{"step_index": 1752, "type"\n';
  const { root, provider } = setup();
  seedTranscript(root, { contents });
  const issues = [];
  const { records } = parseOnly(provider, { issues });
  assert.deepEqual(issues, []);
  assertHarnessConformance(records);
  assert.deepEqual(messagesOf(records).map(row => [local(row.uuid), row.role, row.text, row.content_type, row.harness_kind, row.input_tokens, row.output_tokens]), [
    ['L000001', 'user', null, 'unknown', null, null, null],
    ['L000002:empty', 'assistant', null, 'unknown', null, 342780, 527],
    ['L000003:other', 'system', null, 'unknown', 'other', null, null],
  ]);
  assert.equal(records.at(-1).message_count, 3);
  // A request with no text and no attachment is not a submission.
  const blank = parseCaptured(`${JSON.stringify({ ...attachmentOnly, media: undefined })}\n`);
  assert.deepEqual(blank.map(row => row.kind), ['session']);
});

test('Antigravity reads titles, workspaces and sub-agent origin read-only from conversation_summaries.db', () => {
  const { root } = setup();
  seedTranscript(root);
  seedTranscript(root, { conversation: OTHER_CONVERSATION, contents: CAPTURED.b });
  const workspace = join(root, 'workspace', 'example');
  const dbPath = seedSummaries(root, [
    { conversation_id: CONVERSATION, title: '  Example conversation title  ',
      workspace_uris: JSON.stringify(['vscode-remote://example/host', antigravityWorkspaceUri(workspace)]) },
    // A conversation a sub-agent started records its parent.
    { conversation_id: OTHER_CONVERSATION, agent_name: 'example-agent', parent_conversation_id: CONVERSATION, nesting_depth: 1 },
  ]);
  const before = { bytes: readFileSync(dbPath), mtimeMs: statSync(dbPath).mtimeMs };
  const opened = [];
  const provider = createAntigravityProvider({ rootDir: root, openDatabase: path => {
    opened.push(path);
    return new DatabaseSync(path, { readOnly: true });
  } });
  const units = discover(provider);
  assert.deepEqual(opened, [dbPath]);
  assert.deepEqual(readFileSync(dbPath), before.bytes);
  assert.equal(statSync(dbPath).mtimeMs, before.mtimeMs);

  const [main, child] = units.map(unit => drain(provider.parse(unit, null)).records);
  // The workspace path matches what other providers observe, including an uppercase drive letter.
  const expectedCwd = resolve(workspace);
  assert.equal(units[0].project, projectSlugFromPath(expectedCwd));
  assert.deepEqual([main.at(-1).title, main.at(-1).project, main.at(-1).started_by], ['Example conversation title', projectSlugFromPath(expectedCwd), null]);
  assert.ok(messagesOf(main).every(row => row.cwd === expectedCwd));
  if (process.platform === 'win32') assert.match(main[0].cwd, /^[A-Z]:\\/);
  // Its requests are the parent agent's tasks, so the session says an agent started it.
  assert.deepEqual([child.at(-1).started_by, child.at(-1).title, child.at(-1).project], ['agent', 'Example request b1.', null]);
  assertHarnessConformance(child);

  // nesting_depth alone also marks a sub-agent conversation.
  seedSummaries(root, [{ conversation_id: OTHER_CONVERSATION, nesting_depth: 2 }]);
  const [, nested] = discover(provider);
  assert.equal(drain(provider.parse(nested, null)).records.at(-1).started_by, 'agent');
});

test('Antigravity falls back to the first request when summary metadata is missing, blank or unreadable', () => {
  const [first] = stepsOf(CAPTURED.a);
  const longRequest = `<USER_REQUEST>\n${'Example   request\nwith wrapped lines. '.repeat(6)}\n</USER_REQUEST>`;
  const contents = `${JSON.stringify({ ...first, content: longRequest })}\n`;
  const collapsed = 'Example request with wrapped lines. '.repeat(6).trim().slice(0, 80);
  const olderSchema = 'CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text, workspace_uris text);';
  const cases = {
    none: () => {},
    // Antigravity's own defaults for a conversation it has not titled yet.
    'blank-row': root => seedSummaries(root, [{ conversation_id: CONVERSATION }]),
    'malformed-workspaces': root => seedSummaries(root, [{ conversation_id: CONVERSATION, workspace_uris: '{not json' }]),
    'other-row': root => seedSummaries(root, [{ conversation_id: OTHER_CONVERSATION, title: 'Other' }]),
    'no-id-column': root => seedSummaries(root, [], { schema: 'CREATE TABLE conversation_summaries (id text, title text);' }),
    'not-sqlite': root => writeFileSync(join(root, 'conversation_summaries.db'), 'not a database'),
  };
  for (const [name, seed] of Object.entries(cases)) {
    const { root, provider } = setup();
    seedTranscript(root, { contents });
    seed(root);
    const issues = [];
    const { unit, records } = parseOnly(provider, { issues });
    assert.deepEqual(issues, [], `${name}: metadata problems never mark the inventory incomplete`);
    assert.equal(unit.project, undefined, name);
    assert.equal(records.at(-1).title, collapsed, name);
    assert.equal(records.at(-1).project, null, name);
    assert.ok(messagesOf(records).every(row => row.cwd === null), name);
  }

  // A schema without the sub-agent columns still provides titles and workspaces.
  const { root, provider } = setup();
  seedTranscript(root, { contents });
  seedSummaries(root, [{ conversation_id: CONVERSATION, title: 'Older schema title', workspace_uris: '[]' }], { schema: olderSchema });
  const session = parseOnly(provider).records.at(-1);
  assert.deepEqual([session.title, session.started_by], ['Older schema title', null]);
});

test('Antigravity keeps a workspace-only session for a conversation without projected messages', () => {
  const { root, provider } = setup();
  const output = stepsOf(CAPTURED.a)[5];
  const contents = `\n${JSON.stringify({ ...output, content: '' })}\n`;
  seedTranscript(root, { contents });
  const workspace = join(root, 'workspace');
  seedSummaries(root, [{ conversation_id: CONVERSATION, workspace_uris: JSON.stringify([antigravityWorkspaceUri(workspace)]) }]);
  const { records } = parseOnly(provider);
  assertHarnessConformance(records);
  assert.deepEqual(records.map(row => [row.kind, row.uuid ?? row.id, row.visibility, row.cwd]), [
    ['message', `${SESSION}:workspace`, 'hidden', resolve(workspace)],
    ['session', SESSION, undefined, undefined],
  ]);
  assert.equal(records[1].message_count, 0);
  assert.equal(records[1].title, null);
  assert.equal(records[1].started_at, new Date(output.created_at).toISOString());

  // Without a workspace there is nothing to pin, so only the session remains.
  rmSync(join(root, 'conversation_summaries.db'));
  assert.deepEqual(parseOnly(provider).records.map(row => row.kind), ['session']);
});

test('Antigravity reads only complete lines and picks up a finished line on the next refresh', () => {
  const { root, provider } = setup();
  const path = seedTranscript(root);
  const request = stepsOf(CAPTURED.a)[35];
  const tail = JSON.stringify({ ...request, step_index: 1751, created_at: '2026-01-02T03:09:00Z', content: '<USER_REQUEST>\nExample follow-up.\n</USER_REQUEST>' });
  appendFileSync(path, tail.slice(0, 40));
  const indexed = [{ sessionId: SESSION, jsonlPath: path }];
  const users = rows => messagesOf(rows).filter(row => row.role === 'user').map(row => row.text);

  const first = parseOnly(provider);
  assert.deepEqual(users(first.records), [FIRST_REQUEST, 'Example request a57. ']);
  assert.equal(first.records.at(-1).ended_at, '2026-01-02T03:08:24.000Z');
  const cursors = new Map([[first.unit.key, first.cursor]]);
  assert.deepEqual(discover(provider, { cursors, indexed }), []);

  appendFileSync(path, `${tail.slice(40)}\n`);
  const second = parseOnly(provider, { cursors, indexed });
  assert.deepEqual(users(second.records), [FIRST_REQUEST, 'Example request a57. ', 'Example follow-up.']);
  assert.equal(second.records.at(-1).message_count, 25);
  assert.notEqual(second.cursor, first.cursor);

  // A file with no newline at all has no complete line yet.
  const { root: emptyRoot, provider: emptyProvider } = setup();
  seedTranscript(emptyRoot, { contents: tail });
  assert.deepEqual(parseOnly(emptyProvider).records.map(row => [row.kind, row.message_count]), [['session', 0]]);
});

test('Antigravity prefers transcript_full.jsonl, falls back to transcript.jsonl and ignores foreign folders', () => {
  const { root, provider } = setup();
  const full = seedTranscript(root);
  seedTranscript(root, { file: 'transcript.jsonl' });
  const cut = seedTranscript(root, { conversation: OTHER_CONVERSATION, file: 'transcript.jsonl', contents: CAPTURED.b });
  seedTranscript(root, { conversation: 'not-a-conversation' });
  mkdirSync(join(root, 'brain', '22222222-3333-4444-8555-666666666666'), { recursive: true });
  writeFileSync(join(root, 'brain', '33333333-4444-4555-8666-777777777777'), 'a file, not a conversation folder');

  const issues = [];
  const units = discover(provider, { issues });
  assert.deepEqual(issues, []);
  assert.deepEqual(units.map(unit => [unit.sessionId, unit.key]), [
    [SESSION, full],
    [antigravitySessionId(OTHER_CONVERSATION), cut],
  ]);
  assert.deepEqual(provider.watchTargets(root), [
    { kind: 'tree', path: join(root, 'brain'), fileNames: ['transcript_full.jsonl', 'transcript.jsonl'] },
    { kind: 'file', path: join(root, 'conversation_summaries.db') },
    { kind: 'file', path: join(root, 'conversation_summaries.db-wal') },
  ]);
});

test('Antigravity skips unchanged transcripts until the file, a changed-path hint or its summary changes', () => {
  const { root, provider } = setup();
  const path = seedTranscript(root);
  // Whole milliseconds, so a replacement can carry exactly the same mtime.
  const fixedTime = new Date('2026-01-02T03:10:00.000Z');
  utimesSync(path, fixedTime, fixedTime);
  const { unit, cursor } = parseOnly(provider);
  const indexed = [{ sessionId: SESSION, jsonlPath: path }];
  const cursors = new Map([[unit.key, cursor]]);
  assert.deepEqual(discover(provider, { cursors, indexed }), []);
  assert.deepEqual(discover(provider, { cursors, indexed, changedPaths: [join(root, 'brain', 'elsewhere.jsonl')] }), []);
  assert.equal(discover(provider, { cursors, indexed, changedPaths: [path] }).length, 1);

  seedSummaries(root, [{ conversation_id: CONVERSATION, title: 'Renamed in Antigravity' }]);
  const [renamed] = discover(provider, { cursors, indexed, changedPaths: [join(root, 'conversation_summaries.db')] });
  assert.equal(renamed.meta.title, 'Renamed in Antigravity');
  const reparsed = drain(provider.parse(renamed, cursor));
  assert.equal(reparsed.records.at(-1).title, 'Renamed in Antigravity');

  // A same-size replacement that keeps the old mtime is still a change.
  const settled = new Map([[unit.key, reparsed.cursor]]);
  assert.deepEqual(discover(provider, { cursors: settled, indexed }), []);
  const before = statSync(path);
  const replacement = `${path}.next`;
  writeFileSync(replacement, CAPTURED.a.replace(FIRST_REQUEST, 'Example request z1.'));
  utimesSync(replacement, fixedTime, fixedTime);
  renameSync(replacement, path);
  assert.deepEqual([statSync(path).size, statSync(path).mtimeMs], [before.size, before.mtimeMs]);
  const [rewritten] = discover(provider, { cursors: settled, indexed });
  assert.equal(drain(provider.parse(rewritten, null)).records[0].text, 'Example request z1.');
});

test('Antigravity tombstones a vanished transcript only after a complete scan of its own root', () => {
  const { root, provider } = setup();
  const path = seedTranscript(root);
  const kept = seedTranscript(root, { conversation: OTHER_CONVERSATION, contents: CAPTURED.b });
  const units = discover(provider);
  const cursors = new Map(units.map(unit => [unit.key, drain(provider.parse(unit, null)).cursor]));
  // A session indexed from a root that is no longer selected is not this scan's to retire.
  const elsewhere = { sessionId: antigravitySessionId('44444444-5555-4666-8777-888888888888'),
    jsonlPath: join(makeTempDir('obelisk-antigravity-old-root-'), 'brain', 'gone', 'transcript_full.jsonl') };
  const indexed = [{ sessionId: SESSION, jsonlPath: path }, { sessionId: antigravitySessionId(OTHER_CONVERSATION), jsonlPath: kept }, elsewhere];

  rmSync(join(root, 'brain', CONVERSATION), { recursive: true });
  const [tombstone, ...rest] = discover(provider, { cursors, indexed });
  assert.deepEqual(rest, []);
  assert.deepEqual([tombstone.key, tombstone.sessionId, tombstone.retractSessionIds], [path, SESSION, [SESSION]]);
  const removed = drain(provider.parse(tombstone, cursors.get(path)));
  assert.deepEqual(removed.records, []);
  assert.equal(removed.cursor, '0:0:antigravity-snapshot-v1:tombstone');

  // An unreadable inventory never retracts what was indexed before.
  rmSync(join(root, 'brain'), { recursive: true });
  const issues = [];
  assert.deepEqual(discover(provider, { cursors, indexed, issues }), []);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].path, join(root, 'brain'));
  // A root that never existed is simply an empty source, even with other roots' sessions indexed.
  const quiet = [];
  assert.deepEqual(discover(provider, { indexed: [elsewhere], issues: quiet }), []);
  assert.deepEqual(quiet, []);
});

test('Antigravity raw returns the native step line only for its own transcript', () => {
  const { root, provider } = setup();
  const path = seedTranscript(root);
  const { records } = parseOnly(provider);
  const session = records.at(-1);
  const lines = linesOf(CAPTURED.a);
  const lookup = (messageUuid, overrides = {}) => provider.raw({ source: 'antigravity', messageUuid, session: { ...session, ...overrides }, agentId: null });

  assert.deepEqual(lookup(`${SESSION}:L000001`), {
    text: lines[0], totalLength: lines[0].length, offset: 0, limit: lines[0].length, hasMore: false, messageText: FIRST_REQUEST,
  });
  assert.equal(lookup(`${SESSION}:L000028:1-thinking`).messageText, stepsOf(CAPTURED.a)[27].content);
  assert.equal(lookup(`${SESSION}:L000012:compaction`).text, lines[11]);
  assert.equal(lookup(`${SESSION}:L000099`), null);
  assert.equal(lookup(`${SESSION}:workspace`), null);
  assert.equal(lookup(`${antigravitySessionId(OTHER_CONVERSATION)}:L000001`), null);
  const outside = join(makeTempDir('obelisk-antigravity-outside-'), 'transcript_full.jsonl');
  writeFileSync(outside, CAPTURED.a);
  assert.equal(lookup(`${SESSION}:L000001`, { jsonl_path: outside }), null);
  assert.equal(lookup(`${SESSION}:L000001`, { jsonl_path: null }), null);
  assert.equal(path, session.jsonl_path);
});

test('Antigravity persists, searches and retracts through the configured provider runtime', () => {
  const root = makeTempDir('obelisk-antigravity-index-');
  const path = seedTranscript(root);
  const workspace = join(root, 'workspace');
  seedSummaries(root, [{ conversation_id: CONVERSATION, title: 'Example conversation title', workspace_uris: JSON.stringify([antigravityWorkspaceUri(workspace)]) }]);
  // The app injects its own SQLite binding; the configured runtime must hand it to the provider.
  const opened = [];
  const runtime = createConfiguredBuiltinProviderRuntime({ providerRoots: { antigravity: root } }, {
    openAntigravityDatabase: dbPath => { opened.push(dbPath); return new DatabaseSync(dbPath, { readOnly: true }); },
  });
  assert.equal(runtime.roots.antigravity, root);
  const provider = runtime.registry.get('antigravity');
  const registry = createProviderRegistry([provider]);
  const dbPath = join(root, 'index.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);

  const plan = indexAll(db, registry);
  assert.deepEqual(opened, [join(root, 'conversation_summaries.db')]);
  assert.equal(plan.pendingMarkers.get('antigravity'), '__antigravity_canonical_transcript_v1__');
  const row = db.prepare('SELECT id, source, title, message_count, project, jsonl_path, started_by FROM sessions').get();
  assert.deepEqual({ ...row }, {
    id: SESSION, source: 'antigravity', title: 'Example conversation title', message_count: 24,
    project: projectSlugFromPath(resolve(workspace)), jsonl_path: path, started_by: null,
  });
  assert.deepEqual(db.prepare('SELECT DISTINCT cwd FROM messages WHERE session_id = ?').all(SESSION).map(found => found.cwd), [resolve(workspace)]);
  assert.deepEqual(db.prepare("SELECT harness_kind, COUNT(*) n FROM messages WHERE session_id = ? AND harness_kind IS NOT NULL GROUP BY harness_kind ORDER BY harness_kind").all(SESSION)
    .map(found => [found.harness_kind, found.n]), [['compaction', 1], ['error', 1], ['reminder', 2]]);

  // ADR-0007: assembling from the adapter equals assembling after the SQLite round trip.
  const [unit] = discover(provider);
  const { records } = drain(provider.parse(unit, null));
  const tableRows = (table, order = 'rowid') => db.prepare(`SELECT * FROM ${table} WHERE session_id = ? ORDER BY ${order}`).all(SESSION);
  assert.deepEqual(assembleSessionDetail({
    session: db.prepare('SELECT * FROM sessions WHERE id = ?').get(SESSION),
    messages: tableRows('messages', 'timestamp, uuid'), toolCalls: tableRows('tool_calls'),
    toolResults: tableRows('tool_results'), subagents: tableRows('subagents'), summaries: tableRows('summaries'),
  }), assembleSessionDetail(records));
  assert.equal(createProviderIndexPlan(db, registry).items.length, 0);

  // The query API locks its connection read-only, so it gets its own.
  const reader = new DatabaseSync(dbPath, { readOnly: true });
  const api = createQueryApi(reader, { providerRegistry: registry });
  assert.equal(api.sessions({ source: 'antigravity' }).length, 1);
  assert.deepEqual(api.sessions({ sessionId: CONVERSATION }).map(found => found.id), [SESSION]);
  const [hit] = api.search('request a57', { source: 'antigravity' }).filter(found => found.message.role === 'user');
  assert.equal(hit.message.uuid, `${SESSION}:L000036`);
  assert.equal(api.raw(hit.message.uuid).text, linesOf(CAPTURED.a)[35]);
  reader.close();

  rmSync(join(root, 'brain', CONVERSATION), { recursive: true });
  indexAll(db, registry);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE source = 'antigravity'").get().n, 0);
  db.close();
});

test('Antigravity defaults to ~/.gemini/antigravity under the runtime home directory', () => {
  const home = makeTempDir('obelisk-antigravity-home-');
  const descriptor = createAntigravityProvider({ homeDir: home }).descriptor;
  assert.deepEqual({ id: descriptor.id, name: descriptor.name, vendor: descriptor.vendor, defaultRoot: descriptor.defaultRoot },
    { id: 'antigravity', name: 'Antigravity', vendor: 'Google', defaultRoot: join(home, '.gemini', 'antigravity') });
  const builtin = createBuiltinProviderRegistry({}, { homeDir: home }).get('antigravity');
  assert.equal(builtin.descriptor.defaultRoot, join(home, '.gemini', 'antigravity'));

  // Discovery under that default finds a conversation in the native layout.
  seedTranscript(join(home, '.gemini', 'antigravity'));
  assert.deepEqual(discover(builtin).map(unit => unit.sessionId), [SESSION]);
});

test('Antigravity pairs an output with its call by step index even when the output is logged before the response', () => {
  // Antigravity logs output k of the response at step n as step n + k, and
  // sometimes writes that output line before the response line itself.
  const [request, response, first, second, unrelated] = stepsOf(CAPTURED.b);
  assert.deepEqual([response.step_index, response.tool_calls.length, first.step_index, second.step_index], [7, 2, 8, 9]);
  const records = parseCaptured([request, first, response, second, unrelated].map(step => JSON.stringify(step)).join('\n') + '\n');
  assertHarnessConformance(records);
  const tools = `${SESSION}:L000003:3-tools`;
  assert.deepEqual(records.filter(row => row.kind === 'tool_result').map(row => [row.tool_use_id, row.content]), [
    [`${tools}:c001`, first.content],
    [`${tools}:c002`, second.content],
  ]);
  // Step 11 belongs to a response at step 10, which this excerpt does not contain.
  assert.deepEqual(messagesOf(records).filter(row => row.harness_kind === 'result').map(row => row.text), [unrelated.content]);
});

test('Antigravity counts a resent request once even when another request was logged in between', () => {
  const steps = stepsOf(CAPTURED.a);
  const [first] = steps;
  const later = steps[35];
  const records = parseCaptured([first, later, first].map(step => JSON.stringify(step)).join('\n') + '\n');
  assert.deepEqual(messagesOf(records).map(row => [local(row.uuid), row.text]), [
    ['L000001', FIRST_REQUEST], ['L000002', 'Example request a57. '],
  ]);
});

test('Antigravity pairs outputs with the nearest response when a resent request restarts step numbers', () => {
  // Edits of captured lines: after a resent request Antigravity numbers steps
  // from the original index again, so two responses share step 1.
  const [request, response, firstOutput, secondOutput] = stepsOf(CAPTURED.b);
  const a = { ...response, step_index: 1 };
  const b = { ...response, step_index: 1, tool_calls: response.tool_calls.slice(0, 1) };
  const lines = [
    { ...request, step_index: 0 }, a, { ...firstOutput, step_index: 2 }, { ...secondOutput, step_index: 3 },
    { ...request, step_index: 0 }, b, { ...firstOutput, step_index: 2, content: 'Example output for the second response.' },
  ];
  const records = parseCaptured(lines.map(step => JSON.stringify(step)).join('\n') + '\n');
  assertHarnessConformance(records);
  assert.deepEqual(records.filter(row => row.kind === 'tool_result').map(row => [local(row.tool_use_id), row.content]), [
    ['L000002:3-tools:c001', firstOutput.content],
    ['L000002:3-tools:c002', secondOutput.content],
    ['L000006:3-tools:c001', 'Example output for the second response.'],
  ]);
  assert.deepEqual(messagesOf(records).filter(row => row.harness_kind === 'result'), []);
});

test('Antigravity reports an unreadable transcript instead of retiring its session', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const { root, provider } = setup();
  const path = seedTranscript(root);
  const logs = join(root, 'brain', CONVERSATION, '.system_generated', 'logs');
  chmodSync(logs, 0o000);
  try {
    const issues = [];
    assert.deepEqual(discover(provider, { indexed: [{ sessionId: SESSION, jsonlPath: path }], issues }), []);
    assert.equal(issues.length >= 1, true);
  } finally {
    chmodSync(logs, 0o755);
  }
});
