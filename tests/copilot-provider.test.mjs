// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { persist } from '../packages/core/src/persist.ts';
import { createConfiguredBuiltinProviderRuntime } from '../packages/core/src/provider-settings.ts';
import { assembleSessionDetail } from '../packages/core/src/session-detail.ts';
import {
  copilotSessionId,
  createCopilotProvider,
  defaultCopilotUserDataRoots,
} from '../packages/core/src/providers/copilot.ts';
import { makeTempDir } from './temp-dirs.mjs';

const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');
const TRANSCRIPT_V1 = readFileSync(
  new URL('./fixtures/copilot/transcript-v1.jsonl', import.meta.url),
  'utf8',
);
const TRANSCRIPT_UNKNOWN = readFileSync(
  new URL('./fixtures/copilot/transcript-unknown-version.jsonl', import.meta.url),
  'utf8',
);
const TRANSCRIPT_EMPTY = readFileSync(
  new URL('./fixtures/copilot/transcript-empty-v1.jsonl', import.meta.url),
  'utf8',
);
const TRANSCRIPT_UNKNOWN_EVENT = readFileSync(
  new URL('./fixtures/copilot/transcript-unknown-event-v1.jsonl', import.meta.url),
  'utf8',
);
const CHRONICLE = JSON.parse(readFileSync(
  new URL('./fixtures/copilot/chronicle-v3.json', import.meta.url),
  'utf8',
));

const SHARED_ID = '11111111-1111-4111-8111-111111111111';
const CHRONICLE_ONLY_ID = '22222222-2222-4222-8222-222222222222';
const UNKNOWN_ID = '33333333-3333-4333-8333-333333333333';
const TRANSCRIPT_ONLY_ID = '44444444-4444-4444-8444-444444444444';
const EMPTY_ID = '66666666-6666-4666-8666-666666666666';
const UNKNOWN_EVENT_ID = '77777777-7777-4777-8777-777777777777';

const openChronicle = path => new DatabaseSync(path, { readOnly: true });

function drain(generator) {
  const values = [];
  let step = generator.next();
  while (!step.done) {
    values.push(step.value);
    step = generator.next();
  }
  return { values, cursor: step.value };
}

function chroniclePath(root) {
  return join(root, 'globalStorage', 'github.copilot-chat', 'session-store.db');
}

function createChronicle(root, projectAlpha, projectBeta, { wal = false } = {}) {
  const path = chroniclePath(root);
  mkdirSync(join(path, '..'), { recursive: true });
  const db = new DatabaseSync(path);
  if (wal) {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  }
  db.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version VALUES (3);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, host_type TEXT, branch TEXT,
      summary TEXT, agent_name TEXT, agent_description TEXT,
      created_at TEXT, updated_at TEXT
    );
    CREATE TABLE turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      turn_index INTEGER NOT NULL,
      user_message TEXT,
      assistant_response TEXT,
      timestamp TEXT,
      UNIQUE(session_id, turn_index)
    );
  `);
  const insertSession = db.prepare(`
    INSERT INTO sessions (
      id, cwd, repository, host_type, branch, summary, agent_name,
      agent_description, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const fixture of CHRONICLE.sessions) {
    const cwd = fixture.cwd === '__PROJECT_ALPHA__' ? projectAlpha : projectBeta;
    insertSession.run(
      fixture.id, cwd, fixture.repository, fixture.host_type, fixture.branch,
      fixture.summary, fixture.agent_name, fixture.agent_description,
      fixture.created_at, fixture.updated_at,
    );
  }
  const insertTurn = db.prepare(`
    INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const fixture of CHRONICLE.turns) {
    insertTurn.run(
      fixture.session_id, fixture.turn_index, fixture.user_message,
      fixture.assistant_response, fixture.timestamp,
    );
  }
  return { db, path };
}

function writeWorkspaceTranscript(root, workspaceId, project, rawSessionId, content = TRANSCRIPT_V1) {
  const workspaceDir = join(root, 'workspaceStorage', workspaceId);
  const transcriptDir = join(workspaceDir, 'GitHub.copilot-chat', 'transcripts');
  mkdirSync(transcriptDir, { recursive: true });
  writeFileSync(join(workspaceDir, 'workspace.json'), JSON.stringify({
    folder: pathToFileURL(project).href,
  }));
  const sourceId = JSON.parse(content.split(/\r?\n/, 1)[0]).data.sessionId;
  const path = join(transcriptDir, `${rawSessionId}.jsonl`);
  writeFileSync(path, content.replaceAll(sourceId, rawSessionId));
  return path;
}

function discover(provider, { cursors = new Map(), indexed = [], issues = [], changedPaths } = {}) {
  return provider.discover({
    lastCursor: key => cursors.get(key) ?? null,
    indexedSessions: () => indexed,
    reportIncompleteInventory: issue => issues.push(issue),
    ...(changedPaths === undefined ? {} : { changedPaths }),
  });
}

function fixtureLayout({ includeUnknown = false } = {}) {
  const base = makeTempDir('obelisk-copilot-');
  const root = join(base, 'Code', 'User');
  const projectAlpha = join(base, 'projects', 'alpha');
  const projectBeta = join(base, 'projects', 'beta');
  mkdirSync(projectAlpha, { recursive: true });
  mkdirSync(projectBeta, { recursive: true });
  const chronicle = createChronicle(root, projectAlpha, projectBeta);
  chronicle.db.close();
  const sharedPath = writeWorkspaceTranscript(root, 'workspace-alpha', projectAlpha, SHARED_ID);
  const transcriptOnlyPath = writeWorkspaceTranscript(
    root,
    'workspace-alpha',
    projectAlpha,
    TRANSCRIPT_ONLY_ID,
  );
  if (includeUnknown) {
    writeWorkspaceTranscript(root, 'workspace-alpha', projectAlpha, UNKNOWN_ID, TRANSCRIPT_UNKNOWN);
  }
  return { base, root, projectAlpha, projectBeta, sharedPath, transcriptOnlyPath };
}

test('discover() reconciles Chronicle and transcripts into one unit per logical Copilot session', () => {
  const layout = fixtureLayout();
  try {
    const provider = createCopilotProvider({ userDataRoots: [layout.root], openChronicle });
    const issues = [];
    const units = discover(provider, { issues });

    assert.deepEqual(issues, []);
    assert.equal(units.length, 3);
    assert.equal(units.filter(unit => unit.meta.rawSessionId === SHARED_ID).length, 1);
    assert.equal(units.some(unit => unit.meta.rawSessionId === CHRONICLE_ONLY_ID), true);
    assert.equal(units.some(unit => unit.meta.rawSessionId === TRANSCRIPT_ONLY_ID), true);

    const shared = units.find(unit => unit.meta.rawSessionId === SHARED_ID);
    assert.equal(shared.sessionId, copilotSessionId(SHARED_ID, `path:${layout.projectAlpha}`));
    assert.deepEqual(shared.retractSessionIds, [shared.sessionId]);
    assert.equal(shared.meta.transcript.path, layout.sharedPath);
    assert.equal(shared.meta.chronicle.dbPath, chroniclePath(layout.root));

    const records = drain(provider.parse(shared, null)).values;
    const messages = records.filter(record => record.kind === 'message');
    assert.equal(messages.some(message => message.text === 'Complete transcript answer'), true);
    assert.equal(messages.some(message => message.text === 'Truncated Chronicle answer'), false);
    assert.equal(records.filter(record => record.kind === 'tool_call').length, 5);
    assert.deepEqual(
      records.filter(record => record.kind === 'tool_result').map(record => record.is_error),
      [0, 0, 0, 1],
    );
    assert.equal(records.filter(record => record.kind === 'session').length, 1);
    assert.equal(records.find(record => record.kind === 'session').title, null);
    assert.equal(
      records.find(record => record.kind === 'summary').content,
      'Sanitized shared session',
    );
  } finally {
    rmSync(layout.base, { recursive: true, force: true });
  }
});

test('parse() handles transcript-only and Chronicle-only sessions without duplicate canonical messages', () => {
  const layout = fixtureLayout({ includeUnknown: false });
  try {
    const provider = createCopilotProvider({ userDataRoots: [layout.root], openChronicle });
    const units = discover(provider);
    const transcriptOnly = units.find(unit => unit.meta.rawSessionId === TRANSCRIPT_ONLY_ID);
    const chronicleOnly = units.find(unit => unit.meta.rawSessionId === CHRONICLE_ONLY_ID);
    const transcriptRecords = drain(provider.parse(transcriptOnly, null)).values;
    const chronicleRecords = drain(provider.parse(chronicleOnly, null)).values;

    assert.equal(transcriptRecords.some(record => record.kind === 'message'), true);
    assert.equal(transcriptRecords.find(record => record.kind === 'session').jsonl_path, layout.transcriptOnlyPath);
    assert.deepEqual(
      chronicleRecords.filter(record => record.kind === 'message').map(record => record.text),
      ['Sanitized Chronicle-only request', 'Sanitized Chronicle-only answer'],
    );
    assert.match(chronicleRecords.find(record => record.kind === 'session').jsonl_path, /session-store\.db#session:/);

    const shared = units.find(unit => unit.meta.rawSessionId === SHARED_ID);
    const sharedRecords = drain(provider.parse(shared, null)).values;
    assert.equal(
      sharedRecords.filter(record => record.kind === 'message' && record.text === 'Sanitized fixture request').length,
      1,
    );
  } finally {
    rmSync(layout.base, { recursive: true, force: true });
  }
});

test('raw() returns exact transcript JSONL and Chronicle fallback evidence', () => {
  const layout = fixtureLayout({ includeUnknown: false });
  try {
    const provider = createCopilotProvider({ userDataRoots: [layout.root], openChronicle });
    const units = discover(provider);
    const shared = units.find(unit => unit.meta.rawSessionId === SHARED_ID);
    const sharedRecords = drain(provider.parse(shared, null)).values;
    const sharedSession = sharedRecords.find(record => record.kind === 'session');
    const assistant = sharedRecords.find(
      record => record.kind === 'message' && record.text === 'Complete transcript answer',
    );
    const transcriptRaw = provider.raw({
      source: 'copilot',
      messageUuid: assistant.uuid,
      session: { ...sharedSession },
      agentId: null,
    });
    assert.match(transcriptRaw.text, /"type":"assistant\.message"/);
    assert.equal(transcriptRaw.messageText, 'Complete transcript answer');

    const fallback = units.find(unit => unit.meta.rawSessionId === CHRONICLE_ONLY_ID);
    const fallbackRecords = drain(provider.parse(fallback, null)).values;
    const fallbackSession = fallbackRecords.find(record => record.kind === 'session');
    const fallbackMessage = fallbackRecords.find(
      record => record.kind === 'message' && record.role === 'assistant',
    );
    const chronicleRaw = provider.raw({
      source: 'copilot',
      messageUuid: fallbackMessage.uuid,
      session: { ...fallbackSession },
      agentId: null,
    });
    assert.equal(chronicleRaw.messageText, 'Sanitized Chronicle-only answer');
    assert.match(chronicleRaw.text, /assistant_response/);
  } finally {
    rmSync(layout.base, { recursive: true, force: true });
  }
});

test('unknown transcript versions are reported and skipped without advancing a cursor', () => {
  const layout = fixtureLayout({ includeUnknown: true });
  try {
    const provider = createCopilotProvider({ userDataRoots: [layout.root], openChronicle });
    const issues = [];
    const units = discover(provider, { issues });
    assert.equal(units.some(candidate => candidate.meta.rawSessionId === UNKNOWN_ID), false);
    assert.equal(issues.length, 1);
    assert.match(issues[0].error, /Unsupported Copilot transcript format version 99/);
  } finally {
    rmSync(layout.base, { recursive: true, force: true });
  }
});

test('known v1 to unknown version preserves the last-good transcript and retries discovery', () => {
  const base = makeTempDir('obelisk-copilot-version-transition-');
  const root = join(base, 'Code', 'User');
  const project = join(base, 'project');
  mkdirSync(project, { recursive: true });
  const path = writeWorkspaceTranscript(root, 'workspace', project, SHARED_ID);
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  try {
    const provider = createCopilotProvider({ userDataRoots: [root], openChronicle });
    const initial = discover(provider)[0];
    const initialCursor = persist(db, initial, provider.parse(initial, null));
    assert.equal(db.prepare("SELECT count(*) count FROM messages WHERE text='Complete transcript answer'").get().count, 1);

    writeFileSync(path, TRANSCRIPT_UNKNOWN.replaceAll(UNKNOWN_ID, SHARED_ID));
    const cursors = new Map([[initial.key, initialCursor]]);
    for (let attempt = 0; attempt < 2; attempt++) {
      const issues = [];
      const units = discover(provider, { cursors, issues });
      assert.equal(units.some(unit => unit.sessionId === initial.sessionId), false);
      assert.equal(issues.length, 1);
      assert.match(issues[0].error, /Unsupported Copilot transcript format version 99/);
      assert.equal(db.prepare("SELECT count(*) count FROM messages WHERE text='Complete transcript answer'").get().count, 1);
      assert.equal(
        db.prepare('SELECT cursor FROM index_state WHERE jsonl_path = ?').get(initial.key).cursor,
        initialCursor,
      );
    }
  } finally {
    db.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('an unknown transcript version uses Chronicle fallback while reporting incomplete inventory', () => {
  const layout = fixtureLayout();
  try {
    writeFileSync(layout.sharedPath, TRANSCRIPT_UNKNOWN.replaceAll(UNKNOWN_ID, SHARED_ID));
    const provider = createCopilotProvider({ userDataRoots: [layout.root], openChronicle });
    const issues = [];
    const unit = discover(provider, { issues }).find(candidate => candidate.meta.rawSessionId === SHARED_ID);
    const records = drain(provider.parse(unit, null)).values;
    assert.equal(issues.length, 1);
    assert.deepEqual(unit.retractSessionIds, [unit.sessionId]);
    assert.equal(records.some(record => record.kind === 'message' && record.text === 'Truncated Chronicle answer'), true);
    assert.equal(records.some(record => record.kind === 'message' && record.text === 'Complete transcript answer'), false);
  } finally {
    rmSync(layout.base, { recursive: true, force: true });
  }
});

test('real resumed transcript evidence preserves text-less assistant and tool-only rounds', () => {
  const base = makeTempDir('obelisk-copilot-empty-');
  const root = join(base, 'Code', 'User');
  const project = join(base, 'project');
  mkdirSync(project, { recursive: true });
  try {
    writeWorkspaceTranscript(root, 'workspace', project, EMPTY_ID, TRANSCRIPT_EMPTY);
    const provider = createCopilotProvider({ userDataRoots: [root], openChronicle });
    const unit = discover(provider)[0];
    const records = drain(provider.parse(unit, null)).values;
    assert.equal(records.filter(record => record.kind === 'message' && record.text === null).length, 5);
    assert.equal(records.filter(record => record.kind === 'tool_call').length, 7);
    assert.equal(records.filter(record => record.kind === 'tool_result').length, 6);
    assert.equal(records.some(record => record.kind === 'message' && record.role === 'user'), false);
    assert.equal(records.some(record => record.kind === 'session'), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('unknown event types are ignored without poisoning a supported transcript', () => {
  const base = makeTempDir('obelisk-copilot-unknown-event-');
  const root = join(base, 'Code', 'User');
  const project = join(base, 'project');
  mkdirSync(project, { recursive: true });
  try {
    writeWorkspaceTranscript(root, 'workspace', project, UNKNOWN_EVENT_ID, TRANSCRIPT_UNKNOWN_EVENT);
    const provider = createCopilotProvider({ userDataRoots: [root], openChronicle });
    const issues = [];
    const records = drain(provider.parse(discover(provider, { issues })[0], null)).values;
    assert.deepEqual(issues, []);
    assert.deepEqual(records.map(record => record.kind), ['session']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('identity uses workspace project context and keeps the same raw id distinct across projects', () => {
  const base = makeTempDir('obelisk-copilot-identity-');
  const root = join(base, 'Code', 'User');
  const projectA = join(base, 'project-a');
  const projectB = join(base, 'project-b');
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });
  try {
    writeWorkspaceTranscript(root, 'workspace-a', projectA, SHARED_ID);
    writeWorkspaceTranscript(root, 'workspace-b', projectB, SHARED_ID);
    const units = discover(createCopilotProvider({ userDataRoots: [root], openChronicle }));
    assert.equal(units.length, 2);
    assert.equal(new Set(units.map(unit => unit.sessionId)).size, 2);
    assert.deepEqual(
      new Set(units.map(unit => unit.meta.cwd)),
      new Set([projectA, projectB]),
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('Stable and Insiders roots share one parsing implementation and both contribute sessions', () => {
  const base = makeTempDir('obelisk-copilot-editions-');
  const stable = join(base, 'Code', 'User');
  const insiders = join(base, 'Code - Insiders', 'User');
  const project = join(base, 'project');
  mkdirSync(project, { recursive: true });
  try {
    writeWorkspaceTranscript(stable, 'stable-workspace', project, SHARED_ID);
    writeWorkspaceTranscript(insiders, 'insiders-workspace', project, TRANSCRIPT_ONLY_ID);
    const provider = createCopilotProvider({ userDataRoots: [stable, insiders], openChronicle });
    assert.deepEqual(
      new Set(discover(provider).map(unit => unit.meta.rawSessionId)),
      new Set([SHARED_ID, TRANSCRIPT_ONLY_ID]),
    );
    assert.deepEqual(provider.watchTargets(stable), [
      { kind: 'file', path: chroniclePath(stable) },
      { kind: 'file', path: `${chroniclePath(stable)}-wal` },
      { kind: 'tree', path: join(stable, 'workspaceStorage') },
      { kind: 'file', path: chroniclePath(insiders) },
      { kind: 'file', path: `${chroniclePath(insiders)}-wal` },
      { kind: 'tree', path: join(insiders, 'workspaceStorage') },
    ]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('automatic configuration watches Stable and Insiders while an explicit root is exact', () => {
  const defaults = defaultCopilotUserDataRoots();
  const automatic = createConfiguredBuiltinProviderRuntime({}, { openCopilotChronicle: openChronicle });
  const automaticProvider = automatic.registry.get('copilot');
  assert.equal(automatic.roots.copilot, defaults[0]);
  assert.deepEqual(automaticProvider.watchTargets(automatic.roots.copilot), defaults.flatMap(root => [
    { kind: 'file', path: chroniclePath(root) },
    { kind: 'file', path: `${chroniclePath(root)}-wal` },
    { kind: 'tree', path: join(root, 'workspaceStorage') },
  ]));

  const explicitRoot = defaults[1];
  const explicit = createConfiguredBuiltinProviderRuntime({
    providerRoots: { copilot: explicitRoot },
  }, { openCopilotChronicle: openChronicle });
  const explicitProvider = explicit.registry.get('copilot');
  assert.equal(explicit.roots.copilot, explicitRoot);
  assert.equal(explicitProvider.descriptor.defaultRoot, explicitRoot);
  assert.deepEqual(explicitProvider.watchTargets(explicitRoot), [
    { kind: 'file', path: chroniclePath(explicitRoot) },
    { kind: 'file', path: `${chroniclePath(explicitRoot)}-wal` },
    { kind: 'tree', path: join(explicitRoot, 'workspaceStorage') },
  ]);
});

test('cursor detects same-mtime transcript rewrites and full snapshot replacement retracts atomically', () => {
  const layout = fixtureLayout({ includeUnknown: false });
  try {
    const provider = createCopilotProvider({ userDataRoots: [layout.root], openChronicle });
    const first = discover(provider).find(unit => unit.meta.rawSessionId === SHARED_ID);
    const firstParse = drain(provider.parse(first, null));
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA);
    persist(db, first, provider.parse(first, null));
    assert.equal(db.prepare("SELECT count(*) count FROM messages WHERE text='Complete transcript answer'").get().count, 1);
    const cursors = new Map([[first.key, firstParse.cursor]]);
    assert.equal(discover(provider, { cursors }).some(unit => unit.sessionId === first.sessionId), false);

    const originalStat = statSync(layout.sharedPath);
    const original = readFileSync(layout.sharedPath, 'utf8');
    writeFileSync(layout.sharedPath, original.replace('Complete transcript answer', 'Xomplete transcript answer'));
    utimesSync(layout.sharedPath, originalStat.atime, originalStat.mtime);
    const replacement = discover(provider, { cursors }).find(unit => unit.sessionId === first.sessionId);
    assert.ok(replacement);
    assert.deepEqual(replacement.retractSessionIds, [first.sessionId]);
    assert.notEqual(replacement.meta.currentCursor, firstParse.cursor);
    persist(db, replacement, provider.parse(replacement, firstParse.cursor));
    assert.equal(db.prepare("SELECT count(*) count FROM messages WHERE text='Complete transcript answer'").get().count, 0);
    assert.equal(db.prepare("SELECT count(*) count FROM messages WHERE text='Xomplete transcript answer'").get().count, 1);
    db.close();
  } finally {
    rmSync(layout.base, { recursive: true, force: true });
  }
});

test('complete union inventory retracts only sessions missing from both sources', () => {
  const base = makeTempDir('obelisk-copilot-delete-');
  const root = join(base, 'Code', 'User');
  mkdirSync(root, { recursive: true });
  const missing = copilotSessionId('missing', `path:${join(base, 'project')}`);
  try {
    const provider = createCopilotProvider({ userDataRoots: [root], openChronicle });
    const [unit] = discover(provider, {
      indexed: [{ sessionId: missing, jsonlPath: join(root, 'workspaceStorage', 'old.jsonl') }],
    });
    assert.deepEqual(unit.retractSessionIds, [missing]);
    assert.equal(drain(provider.parse(unit, null)).cursor, null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('an unreadable Chronicle marks inventory incomplete and withholds deletion', () => {
  const base = makeTempDir('obelisk-copilot-incomplete-');
  const root = join(base, 'Code', 'User');
  const dbPath = chroniclePath(root);
  mkdirSync(join(dbPath, '..'), { recursive: true });
  writeFileSync(dbPath, 'not opened by the injected failure');
  const issues = [];
  try {
    const provider = createCopilotProvider({
      userDataRoots: [root],
      openChronicle: () => { throw new Error('SQLITE_BUSY: database is locked'); },
    });
    const units = discover(provider, {
      indexed: [{ sessionId: 'copilot:preserved', jsonlPath: `${dbPath}#session:preserved` }],
      issues,
    });
    assert.equal(issues.length, 1);
    assert.match(issues[0].error, /SQLITE_BUSY/);
    assert.equal(units.some(unit => unit.retractSessionIds?.includes('copilot:preserved')), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('read-only Chronicle discovery observes newly committed WAL rows without SQLITE_BUSY', () => {
  const base = makeTempDir('obelisk-copilot-wal-');
  const root = join(base, 'Code', 'User');
  const projectA = join(base, 'project-a');
  const projectB = join(base, 'project-b');
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });
  const { db: writer, path } = createChronicle(root, projectA, projectB, { wal: true });
  try {
    const provider = createCopilotProvider({ userDataRoots: [root], openChronicle });
    const first = discover(provider);
    assert.equal(first.length, 2);
    assert.equal(existsSync(`${path}-wal`), true);

    writer.exec('BEGIN');
    writer.prepare(`
      INSERT INTO sessions (id, cwd, summary, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      '55555555-5555-4555-8555-555555555555', projectA, 'Committed in WAL',
      '2026-09-16T10:00:00.000Z', '2026-09-16T10:00:01.000Z',
    );
    writer.prepare(`
      INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp)
      VALUES (?, 0, ?, ?, ?)
    `).run(
      '55555555-5555-4555-8555-555555555555', 'WAL request', 'WAL response',
      '2026-09-16T10:00:00.000Z',
    );
    writer.exec('COMMIT');

    const second = discover(provider);
    assert.equal(second.some(unit => unit.meta.rawSessionId === '55555555-5555-4555-8555-555555555555'), true);
  } finally {
    writer.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('direct canonical assembly equals SQLite round-trip assembly', () => {
  const layout = fixtureLayout({ includeUnknown: false });
  try {
    const provider = createCopilotProvider({ userDataRoots: [layout.root], openChronicle });
    const unit = discover(provider).find(candidate => candidate.meta.rawSessionId === SHARED_ID);
    const directRecords = drain(provider.parse(unit, null)).values;
    const direct = assembleSessionDetail(directRecords);

    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA);
    persist(db, unit, provider.parse(unit, null));
    const persisted = assembleSessionDetail({
      session: db.prepare('SELECT * FROM sessions WHERE id = ?').get(unit.sessionId),
      messages: db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp, uuid').all(unit.sessionId),
      toolCalls: db.prepare('SELECT * FROM tool_calls WHERE session_id = ?').all(unit.sessionId),
      toolResults: db.prepare('SELECT * FROM tool_results WHERE session_id = ?').all(unit.sessionId),
      summaries: db.prepare('SELECT * FROM summaries WHERE session_id = ?').all(unit.sessionId),
    });
    db.close();
    assert.deepEqual(persisted, direct);
  } finally {
    rmSync(layout.base, { recursive: true, force: true });
  }
});
