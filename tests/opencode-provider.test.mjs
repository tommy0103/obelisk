// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join, normalize } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { persist } from '../packages/core/src/persist.ts';
import {
  createProviderIndexPlan,
  indexProviderPlan,
  readRecentTranscriptHints,
} from '../packages/core/src/provider-indexing.ts';
import { runWriteTransaction } from '../packages/core/src/tx.ts';
import {
  createOpencodeProvider,
  defaultOpencodeDataRoot,
  isValidChannelDbName,
  opencodeSessionId,
  opencodeStoreHash,
  opencodeUnitKey,
} from '../packages/core/src/providers/opencode.ts';
import { openOpencodeDatabaseWithNodeSqlite } from '../packages/core/src/providers/opencode-node.ts';
import { createProviderRegistry } from '../packages/core/src/providers/registry.ts';
import { assembleSessionDetail } from '../packages/core/src/session-detail.ts';
import { makeTempDir } from './temp-dirs.mjs';
import { createConfiguredBuiltinProviderRuntime } from '../packages/core/src/provider-settings.ts';
import { createQueryApi } from '../packages/core/src/query.ts';
import { upstreamStore, upstreamSession, upstreamMessage } from './opencode-test-helpers.mjs';

const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');

const OPENCODE_DDL = `
CREATE TABLE IF NOT EXISTS session (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  workspace_id text,
  parent_id text,
  slug text DEFAULT '' NOT NULL,
  directory text NOT NULL,
  path text,
  title text DEFAULT '' NOT NULL,
  version text NOT NULL,
  share_url text,
  summary_additions integer,
  summary_deletions integer,
  summary_files integer,
  summary_diffs text,
  metadata text,
  cost real DEFAULT 0 NOT NULL,
  tokens_input integer DEFAULT 0 NOT NULL,
  tokens_output integer DEFAULT 0 NOT NULL,
  tokens_reasoning integer DEFAULT 0 NOT NULL,
  tokens_cache_read integer DEFAULT 0 NOT NULL,
  tokens_cache_write integer DEFAULT 0 NOT NULL,
  revert text,
  permission text,
  agent text,
  model text,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  time_compacting integer,
  time_archived integer
);

CREATE TABLE IF NOT EXISTS message (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  data text NOT NULL
);

CREATE TABLE IF NOT EXISTS part (
  id text PRIMARY KEY,
  message_id text NOT NULL,
  session_id text NOT NULL,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  data text NOT NULL
);

CREATE TABLE IF NOT EXISTS session_v2 (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  workspace_id text,
  parent_id text,
  fork_session_id text,
  fork_boundary text,
  slug text DEFAULT '' NOT NULL,
  directory text NOT NULL,
  path text,
  title text,
  version text NOT NULL,
  share_url text,
  summary_additions integer,
  summary_deletions integer,
  summary_files integer,
  summary_diffs text,
  metadata text,
  cost real DEFAULT 0 NOT NULL,
  tokens_input integer DEFAULT 0 NOT NULL,
  tokens_output integer DEFAULT 0 NOT NULL,
  tokens_reasoning integer DEFAULT 0 NOT NULL,
  tokens_cache_read integer DEFAULT 0 NOT NULL,
  tokens_cache_write integer DEFAULT 0 NOT NULL,
  revert text,
  permission text,
  agent text,
  model text,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  time_compacting integer,
  time_archived integer,
  time_suspended integer,
  resume_attempts integer DEFAULT 0 NOT NULL,
  time_idle integer,
  time_viewed integer,
  idle_outcome text
);

CREATE TABLE IF NOT EXISTS session_message (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  type text NOT NULL,
  seq integer NOT NULL,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  data text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS session_message_session_seq_idx ON session_message (session_id, seq);
CREATE INDEX IF NOT EXISTS session_message_session_time_created_id_idx ON session_message (session_id, time_created, id);
CREATE INDEX IF NOT EXISTS message_session_time_created_id_idx ON message (session_id, time_created, id);
CREATE INDEX IF NOT EXISTS part_message_id_id_idx ON part (message_id, id);
CREATE INDEX IF NOT EXISTS part_session_idx ON part (session_id);
`;

function openDb(path) {
  return openOpencodeDatabaseWithNodeSqlite(path);
}

function initTestStore(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(OPENCODE_DDL);
  db.close();
}

function drain(generator) {
  const values = [];
  let step = generator.next();
  while (!step.done) {
    values.push(step.value);
    step = generator.next();
  }
  return { values, cursor: step.value };
}

// Projection/root tests count transcript units, separately from recordless source
// observations. Lifecycle and cost tests below exercise the complete real plan.
const transcriptUnits = units => units.filter(unit => unit.sessionId !== '');
const transcriptItems = items => items.filter(item => item.unit.sessionId !== '');
function discover(provider, { cursors = new Map(), indexed = [], issues = [], changedPaths, includeControl = false } = {}) {
  const units = provider.discover({
    lastCursor: key => cursors.get(key) ?? null,
    indexedSessions: () => indexed,
    reportIncompleteInventory: issue => issues.push(issue),
    ...(changedPaths === undefined ? {} : { changedPaths }),
  });
  return includeControl ? units : transcriptUnits(units);
}

function createMemoryIndex() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}

test('discover() respects default XDG data root, custom root, and OPENCODE_DB', () => {
  const home = makeTempDir('opencode-discover-root-');
  const customXdg = join(home, 'xdg-data');
  const prevXdg = process.env.XDG_DATA_HOME;
  const prevOpencodeDb = process.env.OPENCODE_DB;

  try {
    delete process.env.XDG_DATA_HOME;
    delete process.env.OPENCODE_DB;

    // 1. Default directory
    const defaultRoot = defaultOpencodeDataRoot(home);
    assert.equal(defaultRoot, join(home, '.local', 'share', 'opencode'));

    // 2. XDG_DATA_HOME
    process.env.XDG_DATA_HOME = customXdg;
    assert.equal(defaultOpencodeDataRoot(home), join(customXdg, 'opencode'));

    // 3. OPENCODE_DB=:memory: produces explicit diagnostic
    process.env.OPENCODE_DB = ':memory:';
    const provider = createOpencodeProvider({ homeDir: home, openDatabase: openDb });
    const issues = [];
    const units = discover(provider, { issues });
    assert.deepEqual(units, []);
    assert.equal(issues.length, 1);
    assert.match(issues[0].error, /:memory:/i);

    // 4. OPENCODE_DB relative path
    const storeDir = join(customXdg, 'opencode');
    mkdirSync(storeDir, { recursive: true });
    const relDbPath = join(storeDir, 'custom.db');
    initTestStore(relDbPath);
    process.env.OPENCODE_DB = 'custom.db';
    const relProvider = createOpencodeProvider({ homeDir: home, openDatabase: openDb });
    const relUnits = discover(relProvider);
    assert.equal(relUnits.length, 0); // Empty tables, valid census

    // 5. Explicit rootDir overrides OPENCODE_DB
    const explicitDir = join(home, 'explicit-root');
    mkdirSync(explicitDir, { recursive: true });
    const explicitDb = join(explicitDir, 'opencode.db');
    initTestStore(explicitDb);
    const expProvider = createOpencodeProvider({ rootDir: explicitDir, homeDir: home, openDatabase: openDb });
    const expUnits = discover(expProvider);
    assert.equal(expUnits.length, 0);
  } finally {
    if (prevXdg !== undefined) process.env.XDG_DATA_HOME = prevXdg; else delete process.env.XDG_DATA_HOME;
    if (prevOpencodeDb !== undefined) process.env.OPENCODE_DB = prevOpencodeDb; else delete process.env.OPENCODE_DB;
  }
});

test('channel DB discovery strictly matches upstream channel naming rule', () => {
  assert.equal(isValidChannelDbName('opencode.db'), false);
  assert.equal(isValidChannelDbName('opencode-dev.db'), true);
  assert.equal(isValidChannelDbName('opencode-next.db'), true);
  assert.equal(isValidChannelDbName('opencode-pr_123.db'), true);
  assert.equal(isValidChannelDbName('opencode-invalid/name.db'), false);
  assert.equal(isValidChannelDbName('arbitrary.db'), false);
  assert.equal(isValidChannelDbName('opencode.sqlite'), false);
});

test('discover() census handles V1-only, V2-only, mixed overlap, and migration', () => {
  const home = makeTempDir('opencode-census-');
  const dir = join(home, '.local', 'share', 'opencode');
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'opencode.db');
  initTestStore(dbPath);

  const db = new DatabaseSync(dbPath);
  // V1 only session: ses_v1_only
  db.prepare(`
    INSERT INTO session (id, project_id, directory, title, version, time_created, time_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('ses_v1_only', 'proj1', '/work/proj1', 'V1 Session', '1.19.3', 1000, 1000);
  db.prepare(`
    INSERT INTO message (id, session_id, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?)
  `).run('msg_v1_1', 'ses_v1_only', 1000, 1000, JSON.stringify({ role: 'user', text: 'hello' }));

  // V2 only session: ses_v2_only
  db.prepare(`
    INSERT INTO session_v2 (id, project_id, directory, title, version, time_created, time_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('ses_v2_only', 'proj1', '/work/proj1', 'V2 Session', '2.0.32', 2000, 2000);
  db.prepare(`
    INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('msg_v2_1', 'ses_v2_only', 'user', 1, 2000, 2000, JSON.stringify({ text: 'hello v2' }));

  // Overlapping session in both tables: ses_overlap (V2 must be preferred)
  db.prepare(`
    INSERT INTO session (id, project_id, directory, title, version, time_created, time_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('ses_overlap', 'proj1', '/work/proj1', 'Overlap Old V1', '1.19.3', 3000, 3000);
  db.prepare(`
    INSERT INTO session_v2 (id, project_id, directory, title, version, time_created, time_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('ses_overlap', 'proj1', '/work/proj1', 'Overlap Fresh V2', '2.0.32', 3000, 3500);
  db.prepare(`
    INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('msg_v2_overlap_1', 'ses_overlap', 'user', 1, 3500, 3500, JSON.stringify({ text: 'v2 overlap msg' }));
  db.close();

  const provider = createOpencodeProvider({ rootDir: dir, homeDir: home, openDatabase: openDb });
  const units = discover(provider);

  assert.equal(units.length, 3);
  const v1Unit = units.find(u => u.sessionId.includes('ses_v1_only'));
  const v2Unit = units.find(u => u.sessionId.includes('ses_v2_only'));
  const overlapUnit = units.find(u => u.sessionId.includes('ses_overlap'));

  assert.ok(v1Unit && v1Unit.meta.format === 'v1');
  assert.ok(v2Unit && v2Unit.meta.format === 'v2');
  assert.ok(overlapUnit && overlapUnit.meta.format === 'v2', 'overlapping session prefers V2');

  // Parse overlapUnit and check it emitted V2 records
  const { values } = drain(provider.parse(overlapUnit, null));
  const sessionRecord = values.find(r => r.kind === 'session');
  assert.equal(sessionRecord.title, 'Overlap Fresh V2');
  assert.equal(sessionRecord.version, '2.0.32');
});

test('composite session ID prevents cross-store collision with identical native IDs', () => {
  const home = makeTempDir('opencode-multistore-');
  const storeA = join(home, 'storeA.db');
  const storeB = join(home, 'storeB.db');
  initTestStore(storeA);
  initTestStore(storeB);

  const nativeId = 'ses_same_id_123';
  const idA = opencodeSessionId(nativeId, storeA);
  const idB = opencodeSessionId(nativeId, storeB);

  assert.notEqual(idA, idB, 'different store paths yield distinct composite session IDs');
  assert.equal(idA.startsWith('opencode:ses_same_id_123:'), true);
  assert.equal(idB.startsWith('opencode:ses_same_id_123:'), true);
  assert.equal(idA.slice(-64), opencodeStoreHash(storeA));
  assert.equal(idB.slice(-64), opencodeStoreHash(storeB));
});

test('parse() projects V2 fork sessions reading own rows without ancestor recursion', () => {
  const home = makeTempDir('opencode-fork-');
  const dir = join(home, 'data');
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'opencode.db');
  initTestStore(dbPath);

  const db = new DatabaseSync(dbPath);
  db.prepare(`
    INSERT INTO session_v2 (id, project_id, fork_session_id, directory, title, version, time_created, time_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('ses_forked', 'proj1', 'ses_root_ancestor', '/work/proj1', 'Forked Session', '2.0.32', 5000, 5000);

  // Forked session has its own materialized messages
  db.prepare(`
    INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('msg_f1', 'ses_forked', 'user', 1, 5000, 5000, JSON.stringify({ text: 'materialized in fork' }));
  db.close();

  const provider = createOpencodeProvider({ rootDir: dir, homeDir: home, openDatabase: openDb });
  const units = discover(provider);
  assert.equal(units.length, 1);

  const { values } = drain(provider.parse(units[0], null));
  const msgs = values.filter(r => r.kind === 'message');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].text, 'materialized in fork');
});

test('parse() recovers subagent parent relationships and does not guess toolcallID', () => {
  const home = makeTempDir('opencode-subagent-');
  const dir = join(home, 'data');
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'opencode.db');
  initTestStore(dbPath);

  const db = new DatabaseSync(dbPath);
  db.prepare(`
    INSERT INTO session_v2 (id, project_id, parent_id, directory, title, version, time_created, time_updated, agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('ses_parent', 'proj1', null, '/work/proj1', 'Parent Session', '2.0.32', 1000, 1000, null);
  db.prepare(`
    INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('msg_p1', 'ses_parent', 'user', 1, 1000, 1000, JSON.stringify({ text: 'spawn agent' }));

  db.prepare(`
    INSERT INTO session_v2 (id, project_id, parent_id, directory, title, version, time_created, time_updated, agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('ses_child', 'proj1', 'ses_parent', '/work/proj1', 'Explore Subagent', '2.0.32', 1050, 1050, 'explore');
  db.prepare(`
    INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('msg_c1', 'ses_child', 'user', 1, 1050, 1050, JSON.stringify({ text: 'subagent prompt' }));
  db.close();

  const provider = createOpencodeProvider({ rootDir: dir, homeDir: home, openDatabase: openDb });
  const units = discover(provider);

  const parentUnit = units.find(u => u.sessionId.includes('ses_parent'));
  const childUnit = units.find(u => u.sessionId.includes('ses_child'));

  assert.equal(parentUnit.isSubagent, false);
  assert.equal(childUnit.isSubagent, true);
  assert.equal(childUnit.agentId, childUnit.sessionId);

  const { values } = drain(provider.parse(childUnit, null));
  const subagentRecord = values.find(r => r.kind === 'subagent');
  assert.ok(subagentRecord, 'child emits SubagentRecord');
  assert.equal(subagentRecord.agent_id, childUnit.sessionId);
  assert.equal(subagentRecord.session_id, parentUnit.sessionId);
  assert.equal(subagentRecord.parent_tool_use_id, null, 'does not guess toolcallID');
  assert.equal(subagentRecord.agent_type, 'explore');

  const childMsg = values.find(r => r.kind === 'message');
  assert.equal(childMsg.is_sidechain, 1);
  assert.equal(childMsg.agent_id, childUnit.sessionId);
});

test('parse() handles tool lifecycle (running, completed, error, file_path) and block order', () => {
  const home = makeTempDir('opencode-tools-');
  const dir = join(home, 'data');
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'opencode.db');
  initTestStore(dbPath);

  const db = new DatabaseSync(dbPath);
  db.prepare(`
    INSERT INTO session_v2 (id, project_id, directory, title, version, time_created, time_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('ses_tools', 'proj1', '/work/proj1', 'Tool Session', '2.0.32', 1000, 1000);

  // Assistant message with reasoning, completed tool, running tool, error tool, and text
  db.prepare(`
    INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('msg_asst_tools', 'ses_tools', 'assistant', 1, 1000, 1000, JSON.stringify({
    content: [
      { type: 'reasoning', text: 'Step 1: thinking' },
      {
        type: 'tool',
        id: 'call_edit_1',
        name: 'edit',
        state: {
          status: 'completed',
          input: { path: 'packages/core/src/index.ts', oldString: 'a', newString: 'b' },
          content: 'Applied patch'
        }
      },
      {
        type: 'tool',
        id: 'call_bash_running',
        name: 'bash',
        state: {
          status: 'running',
          input: { command: 'cargo build' }
        }
      },
      {
        type: 'tool',
        id: 'call_read_error',
        name: 'read',
        state: {
          status: 'error',
          input: { path: 'nonexistent.txt' },
          error: 'File not found'
        }
      },
      { type: 'text', text: 'All operations finished.' }
    ]
  }));
  db.close();

  const provider = createOpencodeProvider({ rootDir: dir, homeDir: home, openDatabase: openDb });
  const units = discover(provider);
  const { values } = drain(provider.parse(units[0], null));

  const calls = values.filter(r => r.kind === 'tool_call');
  const results = values.filter(r => r.kind === 'tool_result');

  assert.equal(calls.length, 3);
  assert.equal(results.length, 2, 'running tool does not fake a result');

  const editCall = calls.find(c => c.name === 'edit');
  const editResult = results.find(r => r.tool_use_id === editCall.id);
  assert.equal(editCall.file_path, 'packages/core/src/index.ts');
  assert.equal(editResult.is_error, 0);
  assert.equal(editResult.content, 'Applied patch');

  const errorCall = calls.find(c => c.name === 'read');
  const errorResult = results.find(r => r.tool_use_id === errorCall.id);
  assert.equal(errorCall.file_path, 'nonexistent.txt');
  assert.equal(errorResult.is_error, 1);
  assert.equal(errorResult.content, 'File not found');

  // Verify multi-block sequence and parent chaining
  const msgs = values.filter(r => r.kind === 'message');
  assert.equal(msgs[0].content_type, 'thinking');
  assert.equal(msgs[1].content_type, 'tool_use');
  assert.equal(msgs[2].content_type, 'tool_use');
  assert.equal(msgs[3].content_type, 'tool_use');
  assert.equal(msgs[4].content_type, 'text');

  assert.equal(msgs[0].parent_uuid, null);
  assert.equal(msgs[1].parent_uuid, msgs[0].uuid);
  assert.equal(msgs[2].parent_uuid, msgs[1].uuid);
  assert.equal(msgs[3].parent_uuid, msgs[2].uuid);
  assert.equal(msgs[4].parent_uuid, msgs[3].uuid);
});

test('canonical token accounting: V2 input+cache, output+reasoning; V1 step-finish priority and partial-step', () => {
  const home = makeTempDir('opencode-tokens-');
  const dir = join(home, 'data');
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'opencode.db');
  initTestStore(dbPath);

  const db = new DatabaseSync(dbPath);
  // V2 session with cache read/write and reasoning tokens
  db.prepare(`
    INSERT INTO session_v2 (id, project_id, directory, title, version, time_created, time_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('ses_v2_tokens', 'proj1', '/work/proj1', 'V2 Tokens', '2.0.32', 1000, 1000);
  db.prepare(`
    INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('msg_v2_asst', 'ses_v2_tokens', 'assistant', 1, 1000, 1000, JSON.stringify({
    content: [{ type: 'text', text: 'response' }],
    tokens: {
      input: 100,
      output: 50,
      reasoning: 25,
      cache: { read: 300, write: 40 }
    }
  }));

  // V1 session with multiple step-finish parts
  db.prepare(`
    INSERT INTO session (id, project_id, directory, title, version, time_created, time_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('ses_v1_tokens', 'proj1', '/work/proj1', 'V1 Tokens', '1.19.3', 2000, 2000);
  db.prepare(`
    INSERT INTO message (id, session_id, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?)
  `).run('msg_v1_asst', 'ses_v1_tokens', 2000, 2000, JSON.stringify({
    role: 'assistant',
    tokens: { input: 9999, output: 9999 } // Cumulative, must NOT be duplicated when step-finish exists
  }));
  db.prepare(`
    INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('p_s1_1_start', 'msg_v1_asst', 'ses_v1_tokens', 2000, 2000, JSON.stringify({ type: 'step-start' }));
  db.prepare(`
    INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('p_s1_2_text', 'msg_v1_asst', 'ses_v1_tokens', 2001, 2001, JSON.stringify({ type: 'text', text: 'step 1' }));
  db.prepare(`
    INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('p_s1_3_finish', 'msg_v1_asst', 'ses_v1_tokens', 2002, 2002, JSON.stringify({
    type: 'step-finish',
    tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }
  }));
  db.prepare(`
    INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('p_s2_1_start', 'msg_v1_asst', 'ses_v1_tokens', 2003, 2003, JSON.stringify({ type: 'step-start' }));
  db.prepare(`
    INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('p_s2_2_text', 'msg_v1_asst', 'ses_v1_tokens', 2004, 2004, JSON.stringify({ type: 'text', text: 'step 2' }));
  db.prepare(`
    INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('p_s2_3_finish', 'msg_v1_asst', 'ses_v1_tokens', 2005, 2005, JSON.stringify({
    type: 'step-finish',
    tokens: { input: 20, output: 8, reasoning: 2, cache: { read: 50, write: 5 } }
  }));
  db.close();

  const provider = createOpencodeProvider({ rootDir: dir, homeDir: home, openDatabase: openDb });
  const units = discover(provider);

  const uV2 = units.find(u => u.sessionId.includes('ses_v2_tokens'));
  const { values: v2Vals } = drain(provider.parse(uV2, null));
  const v2Msg = v2Vals.find(r => r.kind === 'message');
  assert.equal(v2Msg.input_tokens, 100 + 300 + 40, 'input + cache.read + cache.write');
  assert.equal(v2Msg.output_tokens, 50 + 25, 'output + reasoning');

  const uV1 = units.find(u => u.sessionId.includes('ses_v1_tokens'));
  const { values: v1Vals } = drain(provider.parse(uV1, null));
  const v1Msgs = v1Vals.filter(r => r.kind === 'message');
  assert.equal(v1Msgs.length, 2);
  assert.equal(v1Msgs[0].input_tokens, 10);
  assert.equal(v1Msgs[0].output_tokens, 5);
  assert.equal(v1Msgs[1].input_tokens, 20 + 50 + 5);
  assert.equal(v1Msgs[1].output_tokens, 8 + 2);
});

test('parse() handles V1 revert boundary and part-level undo', () => {
  const home = makeTempDir('opencode-revert-');
  const dir = join(home, 'data');
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'opencode.db');
  initTestStore(dbPath);

  const db = new DatabaseSync(dbPath);
  db.prepare(`
    INSERT INTO session (id, project_id, directory, title, version, time_created, time_updated, revert)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('ses_revert', 'proj1', '/work/proj1', 'Revert Session', '1.19.3', 1000, 1000, JSON.stringify({
    messageID: 'msg_2',
    partID: 'part_2_2_cut'
  }));

  db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`).run(
    'msg_1', 'ses_revert', 1000, 1000, JSON.stringify({ role: 'user', text: 'turn 1' }),
  );
  db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`).run(
    'msg_2', 'ses_revert', 1010, 1010, JSON.stringify({ role: 'assistant' }),
  );
  db.prepare(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`).run(
    'part_2_1_kept', 'msg_2', 'ses_revert', 1010, 1010, JSON.stringify({ type: 'text', text: 'part kept' }),
  );
  db.prepare(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`).run(
    'part_2_2_cut', 'msg_2', 'ses_revert', 1011, 1011, JSON.stringify({ type: 'text', text: 'part cut' }),
  );
  db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`).run(
    'msg_3', 'ses_revert', 1020, 1020, JSON.stringify({ role: 'user', text: 'turn 3' }),
  );
  db.close();

  const provider = createOpencodeProvider({ rootDir: dir, homeDir: home, openDatabase: openDb });
  const units = discover(provider);
  const { values } = drain(provider.parse(units[0], null));

  const msgs = values.filter(r => r.kind === 'message');
  assert.equal(msgs[0].visibility, 'visible'); // msg_1
  assert.equal(msgs[1].visibility, 'visible'); // part_2_kept
  assert.equal(msgs[2].visibility, 'inactive'); // part_2_cut
  assert.equal(msgs[3].visibility, 'inactive'); // msg_3
});

test('parse() emits textless message records with unknown or tool_use content_type', () => {
  const home = makeTempDir('opencode-textless-');
  const dir = join(home, 'data');
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'opencode.db');
  initTestStore(dbPath);

  const db = new DatabaseSync(dbPath);
  db.prepare(`
    INSERT INTO session_v2 (id, project_id, directory, title, version, time_created, time_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('ses_textless', 'proj1', '/work/proj1', 'Textless', '2.0.32', 1000, 1000);
  db.prepare(`
    INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('msg_tl', 'ses_textless', 'assistant', 1, 1000, 1000, JSON.stringify({
    content: [],
    tokens: { input: 50, output: 0 }
  }));
  db.close();

  const provider = createOpencodeProvider({ rootDir: dir, homeDir: home, openDatabase: openDb });
  const units = discover(provider);
  const { values } = drain(provider.parse(units[0], null));

  const msg = values.find(r => r.kind === 'message');
  assert.ok(msg);
  assert.equal(msg.text, null);
  assert.equal(msg.content_type, 'unknown');
  assert.equal(msg.input_tokens, 50);
});

test('raw() validates store identity, prevents cross-session leaks, and supports messageText', () => {
  const home = makeTempDir('opencode-raw-');
  const dir = join(home, 'data');
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'opencode.db');
  initTestStore(dbPath);

  const db = new DatabaseSync(dbPath);
  db.prepare(`
    INSERT INTO session_v2 (id, project_id, directory, title, version, time_created, time_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('ses_target', 'proj1', '/work/proj1', 'Target', '2.0.32', 1000, 1000);
  db.prepare(`
    INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('msg_target_1', 'ses_target', 'user', 1, 1000, 1000, JSON.stringify({ text: 'Secret target message' }));

  db.prepare(`
    INSERT INTO session_v2 (id, project_id, directory, title, version, time_created, time_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('ses_other', 'proj1', '/work/proj1', 'Other', '2.0.32', 2000, 2000);
  db.close();

  const provider = createOpencodeProvider({ rootDir: dir, homeDir: home, openDatabase: openDb });
  const sessionId = opencodeSessionId('ses_target', dbPath);
  const jsonlPath = opencodeUnitKey(dbPath, 'ses_target');
  const uuid = `${sessionId}:m:000001:msg_target_1:msg`;

  // 1. Valid lookup
  const rawOk = provider.raw({
    source: 'opencode',
    messageUuid: uuid,
    session: { id: sessionId, jsonl_path: jsonlPath },
    agentId: null,
  });
  assert.ok(rawOk);
  assert.equal(rawOk.messageText, 'Secret target message');
  assert.ok(rawOk.text.includes('Secret target message'));

  // 2. Spoofed store identity
  const fakeSessionId = 'opencode:ses_target:0000000000000000000000000000000000000000000000000000000000000000';
  const rawSpoof = provider.raw({
    source: 'opencode',
    messageUuid: uuid,
    session: { id: fakeSessionId, jsonl_path: jsonlPath },
    agentId: null,
  });
  assert.equal(rawSpoof, null, 'rejects mismatched store identity');

  // 3. Cross-session lookup attempt (requesting target message from session_other)
  const otherSessionId = opencodeSessionId('ses_other', dbPath);
  const otherJsonlPath = opencodeUnitKey(dbPath, 'ses_other');
  const rawCross = provider.raw({
    source: 'opencode',
    messageUuid: uuid,
    session: { id: otherSessionId, jsonl_path: otherJsonlPath },
    agentId: null,
  });
  assert.equal(rawCross, null, 'cannot leak messages across sessions');

  // 4. Cursor mismatch: valid session/message but stale/invalid cursor passed
  const rawCursorMismatch = provider.raw({
    source: 'opencode',
    messageUuid: uuid,
    session: { id: sessionId, jsonl_path: jsonlPath },
    cursor: '999999:0:v1:000000000000000000000000',
    agentId: null,
  });
  assert.equal(rawCursorMismatch, null, 'raw returns null when cursor mismatches source database state');
});

test('ADR-0007 canonical transcript round-trip equals SQLite persistence assembly', () => {
  const home = makeTempDir('opencode-adr0007-');
  const dir = join(home, 'data');
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'opencode.db');
  initTestStore(dbPath);

  const db = new DatabaseSync(dbPath);
  db.prepare(`
    INSERT INTO session_v2 (id, project_id, directory, title, version, time_created, time_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('ses_roundtrip', 'proj1', '/work/proj1', 'Roundtrip Session', '2.0.32', 1000, 1000);
  db.prepare(`
    INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('m1', 'ses_roundtrip', 'user', 1, 1000, 1000, JSON.stringify({ text: 'prompt' }));
  db.prepare(`
    INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('m2', 'ses_roundtrip', 'assistant', 2, 1005, 1005, JSON.stringify({
    content: [
      { type: 'reasoning', text: 'thinking' },
      { type: 'tool', id: 'c1', name: 'read', state: { status: 'completed', input: { path: 'file.txt' }, content: 'hello' } },
      { type: 'text', text: 'response' }
    ],
    tokens: { input: 10, output: 5 }
  }));
  db.close();

  const provider = createOpencodeProvider({ rootDir: dir, homeDir: home, openDatabase: openDb });
  const units = discover(provider);
  const { values: canonicalRecords } = drain(provider.parse(units[0], null));

  // Assemble directly from canonical generator stream
  const directDetail = assembleSessionDetail(canonicalRecords);

  // Round-trip through SQLite persist layer
  const memDb = createMemoryIndex();
  persist(memDb, units[0], provider.parse(units[0], null));

  const roundTripRows = memDb.prepare(`
    SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp, rowid
  `).all(units[0].sessionId);
  const sessionRow = memDb.prepare('SELECT * FROM sessions WHERE id = ?').get(units[0].sessionId);
  const toolCalls = memDb.prepare('SELECT * FROM tool_calls WHERE session_id = ?').all(units[0].sessionId);
  const toolResults = memDb.prepare('SELECT * FROM tool_results WHERE session_id = ?').all(units[0].sessionId);

  const reassembledDetail = assembleSessionDetail({
    session: sessionRow,
    messages: roundTripRows,
    toolCalls,
    toolResults,
  });

  assert.deepEqual(directDetail, reassembledDetail);
  assert.equal(directDetail.session.title, reassembledDetail.session.title);
  assert.equal(directDetail.session.message_count, reassembledDetail.session.message_count);
});

function indexFixture(provider) {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const registry = createProviderRegistry([provider]);
  const run = (options = {}) => {
    const plan = createProviderIndexPlan(db, registry, options);
    const result = indexProviderPlan({
      db,
      plan,
      runTransaction: (_label, work) => runWriteTransaction(db, work),
      onError: (error) => {
        throw error;
      },
    });
    return { plan, result };
  };
  return { db, run, close: () => db.close() };
}

test('incremental index update matches fresh build from scratch (delta = fresh)', () => {
  const home = makeTempDir('opencode-delta-fresh-');
  const dir = join(home, 'data');
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'opencode.db');
  initTestStore(dbPath);

  const db = new DatabaseSync(dbPath);
  db.prepare(`
    INSERT INTO session_v2 (id, project_id, directory, title, version, time_created, time_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('ses_1', 'proj1', '/work/proj1', 'Session 1', '2.0.32', 1000, 1000);
  db.prepare(`
    INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('m1_1', 'ses_1', 'user', 1, 1000, 1000, JSON.stringify({ text: 'msg 1' }));
  db.close();

  const provider = createOpencodeProvider({ rootDir: dir, homeDir: home, openDatabase: openDb });

  // Initial index build
  const idx = indexFixture(provider);
  idx.run({ force: false });

  // Now update session 1 in source database
  const dbUpdate = new DatabaseSync(dbPath);
  dbUpdate.prepare(`
    UPDATE session_v2 SET time_updated = 2000, title = 'Session 1 Updated' WHERE id = 'ses_1'
  `).run();
  dbUpdate.prepare(`
    INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('m1_2', 'ses_1', 'user', 2, 2000, 2000, JSON.stringify({ text: 'msg 2' }));
  dbUpdate.close();

  // Incremental build
  const incRun = idx.run({ force: false });
  assert.equal(transcriptItems(incRun.plan.items).length, 1, 'only changed session scheduled');

  // Fresh build in separate index
  const freshIdx = indexFixture(provider);
  freshIdx.run({ force: true });

  const incSessions = idx.db.prepare('SELECT id, title, message_count FROM sessions ORDER BY id').all();
  const freshSessions = freshIdx.db.prepare('SELECT id, title, message_count FROM sessions ORDER BY id').all();
  assert.deepEqual(incSessions, freshSessions);

  const incMessages = idx.db.prepare('SELECT uuid, text FROM messages ORDER BY uuid').all();
  const freshMessages = freshIdx.db.prepare('SELECT uuid, text FROM messages ORDER BY uuid').all();
  assert.deepEqual(incMessages, freshMessages);

  idx.close();
  freshIdx.close();
});

test('fault tolerance: corrupt or busy database does not tombstone prior sessions', () => {
  const home = makeTempDir('opencode-faults-');
  const dir = join(home, 'data');
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'opencode.db');

  // 1. Corrupt / non-sqlite file
  writeFileSync(dbPath, 'garbage non-sqlite content');

  const provider = createOpencodeProvider({ rootDir: dir, homeDir: home, openDatabase: openDb });
  const issues = [];
  const indexed = [{
    sessionId: opencodeSessionId('prior_session', dbPath),
    jsonlPath: opencodeUnitKey(dbPath, 'prior_session'),
  }];

  const units = discover(provider, { indexed, issues });
  assert.deepEqual(units, [], 'corrupt file does not emit tombstones');
  assert.equal(issues.length, 1);
  assert.match(issues[0].error, /tables|busy|unreadable/i);

  // 2. Real SQLITE_BUSY thrown by opener
  const busyProvider = createOpencodeProvider({
    rootDir: dir,
    homeDir: home,
    openDatabase: () => {
      throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    },
  });
  const busyIssues = [];
  const busyUnits = discover(busyProvider, { indexed, issues: busyIssues });
  assert.deepEqual(busyUnits, [], 'busy database does not emit tombstones');
  assert.equal(busyIssues.length, 1);
  assert.match(busyIssues[0].error, /busy|locked|unreadable/i);
});

test('watchTargets() includes db, wal and channel db fileNames without shm', () => {
  const home = makeTempDir('opencode-watch-');
  const dir = join(home, 'data');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'opencode.db'), '');
  writeFileSync(join(dir, 'opencode-dev.db'), '');
  writeFileSync(join(dir, 'opencode.db-shm'), ''); // Must not be watched

  const provider = createOpencodeProvider({ rootDir: dir, homeDir: home, openDatabase: openDb });
  const targets = provider.watchTargets(dir);

  const fileTargets = targets.filter(t => t.kind === 'file');
  const treeTargets = targets.filter(t => t.kind === 'tree');

  assert.equal(fileTargets.some(t => t.path.endsWith('opencode.db-shm')), false);
  assert.ok(treeTargets.length > 0);
  assert.ok(treeTargets[0].fileNames.includes('opencode.db'));
  assert.ok(treeTargets[0].matches('opencode-dev.db'));
  assert.ok(treeTargets[0].matches('opencode-dev.db-wal'));
  assert.equal(treeTargets[0].matches('opencode.db-shm'), false);
});

test('parses real captured OpenCode V1 and V2 store rows from fixtures', () => {
  const fixturePath = new URL('./fixtures/opencode/real-store-rows.json', import.meta.url);
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

  const home = makeTempDir('opencode-fixtures-real-');
  const dir = join(home, 'data');
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'opencode.db');
  initTestStore(dbPath);

  const db = new DatabaseSync(dbPath);
  // Insert V1 rows
  for (const s of fixture.v1.sessions) {
    db.prepare(`
      INSERT INTO session (id, project_id, directory, title, version, time_created, time_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(s.id, s.project_id || 'proj', s.directory, s.title, s.version, s.time_created, s.time_updated);
  }
  for (const m of fixture.v1.messages) {
    db.prepare(`
      INSERT INTO message (id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?)
    `).run(m.id, m.session_id, m.time_created, m.time_updated, m.data);
  }
  for (const p of fixture.v1.parts) {
    db.prepare(`
      INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(p.id, p.message_id, p.session_id, p.time_created, p.time_updated, p.data);
  }

  // Insert V2 rows
  for (const s of fixture.v2.sessions) {
    db.prepare(`
      INSERT INTO session_v2 (id, project_id, parent_id, directory, title, version, time_created, time_updated, agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(s.id, s.project_id || 'proj', s.parent_id || null, s.directory, s.title, s.version, s.time_created, s.time_updated, s.agent || null);
  }
  for (const m of fixture.v2.messages) {
    db.prepare(`
      INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(m.id, m.session_id, m.type, m.seq, m.time_created, m.time_updated, m.data);
  }
  db.close();

  const provider = createOpencodeProvider({ rootDir: dir, homeDir: home, openDatabase: openDb });
  const units = discover(provider);

  assert.equal(units.length, fixture.v1.sessions.length + fixture.v2.sessions.length);

  for (const unit of units) {
    const { values, cursor } = drain(provider.parse(unit, null));
    assert.ok(cursor, 'parse returned valid cursor');
    assert.ok(values.length > 0, 'emitted canonical records');

    const sessionRecord = values.find(r => r.kind === 'session');
    assert.ok(sessionRecord, 'session record emitted');
    assert.equal(sessionRecord.source, 'opencode');

    // Canonical assembly roundtrip
    const detail = assembleSessionDetail(values);
    assert.ok(detail.session);
    assert.equal(detail.session.id, unit.sessionId);

    // ADR-0007 full assembled object deepEqual after SQLite round-trip
    const memDb = new DatabaseSync(':memory:');
    memDb.exec(SCHEMA);
    persist(memDb, unit, provider.parse(unit, null));
    const roundTripRows = memDb.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp, rowid').all(unit.sessionId);
    const sessionRow = memDb.prepare('SELECT * FROM sessions WHERE id = ?').get(unit.sessionId);
    const toolCalls = memDb.prepare('SELECT * FROM tool_calls WHERE session_id = ?').all(unit.sessionId);
    const toolResults = memDb.prepare('SELECT * FROM tool_results WHERE session_id = ?').all(unit.sessionId);
    const summaries = memDb.prepare('SELECT * FROM summaries WHERE session_id = ?').all(unit.sessionId);
    const reassembled = assembleSessionDetail({
      session: sessionRow,
      messages: roundTripRows,
      toolCalls,
      toolResults,
      summaries,
    });
    assert.deepEqual(detail, reassembled, `assembled session detail deepEqual for ${unit.sessionId}`);
    memDb.close();
  }
});

test('census and parse fallback to V1 when V2 session disappears (V2消失V1仍存要回退)', () => {
  const home = makeTempDir('opencode-fallback-v1-');
  const dir = join(home, 'data');
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'opencode.db');
  initTestStore(dbPath);

  const db = new DatabaseSync(dbPath);
  // Session exists in both V1 and V2 initially
  db.prepare(`
    INSERT INTO session (id, project_id, directory, title, version, time_created, time_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('ses_migrate_back', 'proj1', '/work/proj1', 'V1 Original', '1.19.3', 1000, 1000);
  db.prepare(`
    INSERT INTO message (id, session_id, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?)
  `).run('m_v1_1', 'ses_migrate_back', 1000, 1000, JSON.stringify({ role: 'user', text: 'v1 original text' }));

  db.prepare(`
    INSERT INTO session_v2 (id, project_id, directory, title, version, time_created, time_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('ses_migrate_back', 'proj1', '/work/proj1', 'V2 Modern', '2.0.32', 2000, 2000);
  db.prepare(`
    INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('m_v2_1', 'ses_migrate_back', 'user', 1, 2000, 2000, JSON.stringify({ text: 'v2 modern text' }));
  db.close();

  const provider = createOpencodeProvider({ rootDir: dir, homeDir: home, openDatabase: openDb });
  const idx = indexFixture(provider);

  // Initial index: V2 is selected
  const run1 = idx.run({ force: false });
  assert.equal(transcriptItems(run1.plan.items).length, 1);
  const sRow1 = idx.db.prepare('SELECT id, title, version FROM sessions WHERE source = ?').get('opencode');
  assert.equal(sRow1.title, 'V2 Modern');
  assert.equal(sRow1.version, '2.0.32');

  // Now V2 session disappears (deleted from session_v2 and session_message), but V1 survives
  const dbDel = new DatabaseSync(dbPath);
  dbDel.prepare('DELETE FROM session_message WHERE session_id = ?').run('ses_migrate_back');
  dbDel.prepare('DELETE FROM session_v2 WHERE id = ?').run('ses_migrate_back');
  dbDel.close();

  // Re-indexing: provider detects V2 is gone and falls back to V1
  const run2 = idx.run({ force: false });
  assert.equal(transcriptItems(run2.plan.items).length, 1, 'session is rescheduled after V2 removal');
  assert.equal(transcriptItems(run2.plan.items)[0].unit.meta.format, 'v1');

  const sRow2 = idx.db.prepare('SELECT id, title, version FROM sessions WHERE source = ?').get('opencode');
  assert.equal(sRow2.title, 'V1 Original', 'reverts to surviving V1 metadata');
  assert.equal(sRow2.version, '1.19.3');

  const mRows2 = idx.db.prepare('SELECT uuid, text FROM messages WHERE session_id = ?').all(sRow2.id);
  assert.equal(mRows2.length, 1);
  assert.equal(mRows2[0].text, 'v1 original text');

  idx.close();
});

test('provider-settings runtime preserves explicit vs automatic root across OPENCODE_DB conflict, deletion, restart, and invalid root', async () => {
  const home = makeTempDir('opencode-settings-conflict-');
  const customExplicitDir = join(home, 'custom-opencode');
  mkdirSync(customExplicitDir, { recursive: true });
  const customDbPath = join(customExplicitDir, 'opencode.db');
  initTestStore(customDbPath);
  const dbCustom = new DatabaseSync(customDbPath);
  dbCustom.prepare(`
    INSERT INTO session_v2 (id, project_id, directory, title, version, time_created, time_updated, slug)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('ses_custom', 'proj1', '/work/custom', 'Custom Session', '2.0.32', 1000, 1000, 'slug_custom');
  dbCustom.close();

  const envDir = join(home, 'env-opencode');
  mkdirSync(envDir, { recursive: true });
  const envDbPath = join(envDir, 'opencode.db');
  initTestStore(envDbPath);
  const dbEnv = new DatabaseSync(envDbPath);
  dbEnv.prepare(`
    INSERT INTO session_v2 (id, project_id, directory, title, version, time_created, time_updated, slug)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('ses_env', 'proj2', '/work/env', 'Env Session', '2.0.32', 2000, 2000, 'slug_env');
  dbEnv.close();

  const prevEnv = process.env.OPENCODE_DB;
  try {
    process.env.OPENCODE_DB = envDbPath;

    // 1. Explicit setting in providerRoots takes precedence over OPENCODE_DB
    const { createConfiguredBuiltinProviderRuntime } = await import('../packages/core/src/provider-settings.ts');
    const settingsExplicit = {
      providerRoots: {
        opencode: customExplicitDir,
      },
    };
    const runtime1 = createConfiguredBuiltinProviderRuntime(settingsExplicit, {
      homeDir: home,
      openOpencodeDatabase: openDb,
    });
    const opencode1 = runtime1.registry.get('opencode');
    assert.equal(opencode1.descriptor.defaultRoot, customExplicitDir);
    // Discovers store in customExplicitDir, NOT envDir
    const units1 = discover(opencode1);
    assert.equal(units1.length, 1);
    assert.ok(units1[0].key.startsWith(customExplicitDir));
    assert.equal(units1[0].sessionId, opencodeSessionId('ses_custom', customDbPath));

    // 2. Deleting settings restores automatic environment (OPENCODE_DB)
    const settingsRestored = {
      providerRoots: {},
    };
    const runtime2 = createConfiguredBuiltinProviderRuntime(settingsRestored, {
      homeDir: home,
      openOpencodeDatabase: openDb,
    });
    const opencode2 = runtime2.registry.get('opencode');
    assert.equal(opencode2.descriptor.defaultRoot, join(home, '.local', 'share', 'opencode'));
    // Discovers store in envDir via OPENCODE_DB
    const units2 = discover(opencode2);
    assert.equal(units2.length, 1);
    assert.ok(units2[0].key.startsWith(envDir));
    assert.equal(units2[0].sessionId, opencodeSessionId('ses_env', envDbPath));

    // 3. Restart with empty settings object also preserves automatic environment
    const runtimeRestart = createConfiguredBuiltinProviderRuntime({}, {
      homeDir: home,
      openOpencodeDatabase: openDb,
    });
    const opencodeRestart = runtimeRestart.registry.get('opencode');
    assert.equal(opencodeRestart.descriptor.defaultRoot, join(home, '.local', 'share', 'opencode'));

    // 4. Invalid root (relative path like './relative') disables provider rather than selecting default
    const settingsInvalid = {
      providerRoots: {
        opencode: './invalid-relative-path',
      },
    };
    const runtimeInvalid = createConfiguredBuiltinProviderRuntime(settingsInvalid, {
      homeDir: home,
      openOpencodeDatabase: openDb,
    });
    const opencodeInvalid = runtimeInvalid.registry.get('opencode');
    assert.equal(opencodeInvalid.descriptor.requiresExplicitRoot, true);
    assert.deepEqual(opencodeInvalid.watchTargets(opencodeInvalid.descriptor.defaultRoot), []);
    assert.deepEqual(discover(opencodeInvalid), []);
  } finally {
    if (prevEnv !== undefined) process.env.OPENCODE_DB = prevEnv; else delete process.env.OPENCODE_DB;
  }
});

test('P1-1: tombstone verification throws on missing/busy source DB and rolls back transaction preserving last-good state', () => {
  const home = makeTempDir('opencode-tomb-p11-');
  const dir = join(home, 'data');
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'opencode.db');
  initTestStore(dbPath);

  const dbSrc = new DatabaseSync(dbPath);
  dbSrc.prepare(`
    INSERT INTO session_v2 (id, project_id, directory, title, version, time_created, time_updated, slug)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('ses_tomb_1', 'p1', '/work/p1', 'Active Session', '2.0.32', 1000, 1000, 'slug_1');
  dbSrc.prepare(`
    INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('m1', 'ses_tomb_1', 'user', 1, 1000, 1000, JSON.stringify({ text: 'important data' }));
  dbSrc.close();

  let openerShouldFail = false;
  const customOpener = (path) => {
    if (openerShouldFail) {
      throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    }
    return openDb(path);
  };

  const provider = createOpencodeProvider({ rootDir: dir, homeDir: home, openDatabase: customOpener });
  const idx = indexFixture(provider);

  // 1. Initial successful index
  const run1 = idx.run();
  assert.equal(transcriptItems(run1.result.committed).length, 1);
  const sRowBefore = idx.db.prepare('SELECT id, title FROM sessions WHERE id = ?').get(transcriptItems(run1.result.committed)[0].unit.sessionId);
  assert.ok(sRowBefore);
  const msgBefore = idx.db.prepare('SELECT * FROM messages WHERE session_id = ?').all(sRowBefore.id);
  assert.equal(msgBefore.length, 1);
  const cursorBefore = idx.db.prepare('SELECT cursor FROM index_state WHERE jsonl_path = ?').get(transcriptItems(run1.result.committed)[0].unit.key);
  assert.ok(cursorBefore);

  // 2. Delete session from source DB while keeping DB accessible -> discover returns tombstone unit
  const dbDel = new DatabaseSync(dbPath);
  dbDel.prepare('DELETE FROM session_message WHERE session_id = ?').run('ses_tomb_1');
  dbDel.prepare('DELETE FROM session_v2 WHERE id = ?').run('ses_tomb_1');
  dbDel.close();

  // Run discovery to capture the tombstone plan
  const plan = createProviderIndexPlan(idx.db, createProviderRegistry([provider]));
  assert.equal(transcriptItems(plan.items).length, 1);
  const tombUnit = transcriptItems(plan.items)[0].unit;
  assert.equal(tombUnit.meta.kind, 'opencode-tombstone');
  assert.equal(tombUnit.meta.rawSessionId, 'ses_tomb_1');

  // 3a. Case A: source DB renamed offline before parse executes
  renameSync(dbPath, join(dir, 'opencode.offline.db'));

  let caughtA = null;
  try {
    indexProviderPlan({
      db: idx.db,
      plan,
      runTransaction: (_label, work) => runWriteTransaction(idx.db, work),
      onError: (err) => {
        caughtA = err;
        return 'stop';
      },
    });
  } finally {
    renameSync(join(dir, 'opencode.offline.db'), dbPath);
  }

  assert.ok(caughtA);
  assert.match(caughtA.message, /busy or unreadable/i);
  // Assert rollback preserved session, messages, and old cursor
  const sRowAfterA = idx.db.prepare('SELECT id, title FROM sessions WHERE id = ?').get(sRowBefore.id);
  assert.ok(sRowAfterA, 'session preserved after failed tombstone parse (missing DB)');
  const msgAfterA = idx.db.prepare('SELECT * FROM messages WHERE session_id = ?').all(sRowBefore.id);
  assert.equal(msgAfterA.length, 1, 'messages preserved after failed tombstone parse');
  const cursorAfterA = idx.db.prepare('SELECT cursor FROM index_state WHERE jsonl_path = ?').get(tombUnit.key);
  assert.equal(cursorAfterA.cursor, cursorBefore.cursor, 'old cursor preserved');

  // 3b. Case B: opener throws SQLITE_BUSY
  openerShouldFail = true;
  let caughtB = null;
  indexProviderPlan({
    db: idx.db,
    plan,
    runTransaction: (_label, work) => runWriteTransaction(idx.db, work),
    onError: (err) => {
      caughtB = err;
      return 'stop';
    },
  });

  assert.ok(caughtB);
  assert.match(caughtB.message, /busy or unreadable/i);
  const sRowAfterB = idx.db.prepare('SELECT id, title FROM sessions WHERE id = ?').get(sRowBefore.id);
  assert.ok(sRowAfterB, 'session preserved after failed tombstone parse (BUSY DB)');
  const cursorAfterB = idx.db.prepare('SELECT cursor FROM index_state WHERE jsonl_path = ?').get(tombUnit.key);
  assert.equal(cursorAfterB.cursor, cursorBefore.cursor, 'old cursor preserved');

  // 4. Case C: Replan after the physical rename/restore. A source observation
  // sampled before that change cannot satisfy a new unit's cursor prerequisite.
  openerShouldFail = false;
  const resultOk = indexProviderPlan({
    db: idx.db,
    plan: createProviderIndexPlan(idx.db, createProviderRegistry([provider])),
    runTransaction: (_label, work) => runWriteTransaction(idx.db, work),
    onError: (err) => { throw err; },
  });
  assert.equal(transcriptItems(resultOk.committed).length, 1);
  const sRowFinal = idx.db.prepare('SELECT id FROM sessions WHERE id = ?').get(sRowBefore.id);
  assert.equal(sRowFinal, undefined, 'session cleanly retracted only after verified deletion');

  idx.close();
});

test('P1-2: multi-channel census: unavailable store blocks destructive force build, preserves old snapshot', () => {
  const home = makeTempDir('opencode-p12-');
  const dir = join(home, 'data');
  mkdirSync(dir, { recursive: true });
  const standardDb = join(dir, 'opencode.db');
  const devDb = join(dir, 'opencode-dev.db');
  initTestStore(standardDb);
  initTestStore(devDb);

  const dbStd = new DatabaseSync(standardDb);
  dbStd.prepare(`INSERT INTO session_v2 (id, project_id, directory, title, version, time_created, time_updated, slug) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('ses_std', 'p1', '/work/p1', 'Standard Session', '2.0.32', 1000, 1000, 'slug_std');
  dbStd.close();

  const dbDev = new DatabaseSync(devDb);
  dbDev.prepare(`INSERT INTO session_v2 (id, project_id, directory, title, version, time_created, time_updated, slug) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('ses_dev', 'p1', '/work/p1', 'Dev Session', '2.0.32', 2000, 2000, 'slug_dev');
  dbDev.close();

  const provider = createOpencodeProvider({ rootDir: dir, homeDir: home, openDatabase: openDb });
  const idx = indexFixture(provider);

  // 1. Initial build: both stores discovered and indexed
  const run1 = idx.run({ force: true });
  assert.equal(transcriptItems(run1.result.committed).length, 2);
  const allSessions1 = idx.db.prepare('SELECT id FROM sessions').all();
  assert.equal(allSessions1.length, 2);

  // 2. devDb goes offline (renamed)
  renameSync(devDb, join(dir, 'opencode-dev.offline'));

  // 3. Discovery reports incomplete inventory for unavailable store
  const issues = [];
  provider.discover({
    lastCursor: () => null,
    indexedSessions: () => idx.db.prepare('SELECT id as sessionId, jsonl_path as jsonlPath, source FROM sessions').all(),
    reportIncompleteInventory: (issue) => issues.push(issue),
  });

  assert.equal(issues.length, 1);
  assert.equal(issues[0].path, normalize(devDb));
  assert.match(issues[0].error, /unavailable/i);

  // 4. Force build plan sets incompleteProviders = ['opencode']
  const registry = createProviderRegistry([provider]);
  const plan = createProviderIndexPlan(idx.db, registry, { force: true });
  assert.ok(plan.incompleteProviders.has('opencode'), 'force plan marks opencode incomplete when store is unavailable');

  // 5. Restore devDb
  renameSync(join(dir, 'opencode-dev.offline'), devDb);

  const issuesRecovered = [];
  const unitsRecovered = provider.discover({
    lastCursor: () => null,
    indexedSessions: () => idx.db.prepare('SELECT id as sessionId, jsonl_path as jsonlPath, source FROM sessions').all(),
    reportIncompleteInventory: (issue) => issuesRecovered.push(issue),
  });
  assert.equal(issuesRecovered.length, 0);
  assert.equal(transcriptUnits(unitsRecovered).length, 2);

  idx.close();
});

test('P2-3: strict raw lookup verification rejects forged session prefixes, seqs, and block indices', () => {
  const home = makeTempDir('opencode-raw-strict-');
  const dir = join(home, 'data');
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'opencode.db');
  initTestStore(dbPath);

  const db = new DatabaseSync(dbPath);
  db.prepare(`INSERT INTO session_v2 (id, project_id, directory, title, version, time_created, time_updated, slug) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('ses_legit', 'p1', '/work/p1', 'Title', '2.0.32', 1000, 1000, 'slug_1');
  db.prepare(`INSERT INTO session_v2 (id, project_id, directory, title, version, time_created, time_updated, slug) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('ses_other', 'p1', '/work/p1', 'Other', '2.0.32', 1000, 1000, 'slug_2');
  db.prepare(`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('msg_1', 'ses_legit', 'assistant', 1, 1000, 1000, JSON.stringify({
    content: [{ type: 'text', text: 'AAA' }],
  }));
  db.close();

  const provider = createOpencodeProvider({ rootDir: dir, homeDir: home, openDatabase: openDb });
  const sessionId = opencodeSessionId('ses_legit', dbPath);
  const otherSessionId = opencodeSessionId('ses_other', dbPath);
  const jsonlPath = opencodeUnitKey(dbPath, 'ses_legit');

  const validUuid = `${sessionId}:m:000001:msg_1:c:0000:text`;

  // 1. Valid lookup succeeds
  const ok = provider.raw({ source: 'opencode', messageUuid: validUuid, session: { id: sessionId, jsonl_path: jsonlPath } });
  assert.ok(ok);
  assert.equal(ok.messageText, 'AAA');

  // 2. Forged UUID prefix (different session in same store)
  const fakePrefixUuid = `${otherSessionId}:m:000001:msg_1:c:0000:text`;
  assert.equal(provider.raw({ source: 'opencode', messageUuid: fakePrefixUuid, session: { id: sessionId, jsonl_path: jsonlPath } }), null);

  // 3. Forged seq 999999
  const fakeSeqUuid = `${sessionId}:m:999999:msg_1:c:0000:text`;
  assert.equal(provider.raw({ source: 'opencode', messageUuid: fakeSeqUuid, session: { id: sessionId, jsonl_path: jsonlPath } }), null);

  // 4. Forged block 9999
  const fakeBlockUuid = `${sessionId}:m:000001:msg_1:c:9999:text`;
  assert.equal(provider.raw({ source: 'opencode', messageUuid: fakeBlockUuid, session: { id: sessionId, jsonl_path: jsonlPath } }), null);

  // 5. session.id and jsonl_path contradiction
  assert.equal(provider.raw({ source: 'opencode', messageUuid: validUuid, session: { id: otherSessionId, jsonl_path: jsonlPath } }), null);

  // 6. Block kind mismatch (asking for :tool when block 0 is text)
  const wrongKindUuid = `${sessionId}:m:000001:msg_1:c:0000:tool`;
  assert.equal(provider.raw({ source: 'opencode', messageUuid: wrongKindUuid, session: { id: sessionId, jsonl_path: jsonlPath } }), null);
});

test('P2-4: raw lookup queries run in a single snapshot read transaction (WAL concurrent write isolation)', () => {
  const home = makeTempDir('opencode-raw-race-');
  const dir = join(home, 'data');
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'opencode.db');
  initTestStore(dbPath);

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.prepare(`INSERT INTO session_v2 (id, project_id, directory, title, version, time_created, time_updated, slug) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('ses_race', 'p1', '/work/p1', 'Race', '2.0.32', 1000, 1000, 'slug_race');
  db.prepare(`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('m1', 'ses_race', 'user', 1, 1000, 1000, JSON.stringify({ text: 'OLD' }));
  db.close();

  const provider = createOpencodeProvider({ rootDir: dir, homeDir: home, openDatabase: openDb });
  const units = discover(provider);
  const records = drain(provider.parse(units[0], null));
  const validCursor = records.cursor; // cursor for 'OLD'

  const sessionId = opencodeSessionId('ses_race', dbPath);
  const jsonlPath = opencodeUnitKey(dbPath, 'ses_race');
  const uuid = `${sessionId}:m:000001:m1:msg`;

  // Connection B commits an update OLD -> NEW
  const dbB = new DatabaseSync(dbPath);
  dbB.prepare('UPDATE session_message SET data = ? WHERE id = ?').run(JSON.stringify({ text: 'NEW' }), 'm1');
  dbB.close();

  // Looking up with OLD cursor should fail because the snapshot fingerprint changed (returns null, never NEW with old cursor)
  const resultOldCursor = provider.raw({
    source: 'opencode',
    messageUuid: uuid,
    cursor: validCursor,
    session: { id: sessionId, jsonl_path: jsonlPath },
  });
  assert.equal(resultOldCursor, null, 'old cursor rejects updated database content');
});

test('P2-5: token accounting: textless step-finish tokens, empty step anchor, and V2 failed compaction tokens', () => {
  const home = makeTempDir('opencode-tokens-p25-');
  const dir = join(home, 'data');
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'opencode.db');
  initTestStore(dbPath);

  const db = new DatabaseSync(dbPath);
  // V1 assistant with textless step-finish with tokens 10/2 and message fallback 10/2
  db.prepare(`INSERT INTO session (id, project_id, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('ses_v1_textless', 'p1', '/work/p1', 'Textless Step', '1.19.3', 1000, 1000);
  db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`).run('msg_v1', 'ses_v1_textless', 1000, 1000, JSON.stringify({
    role: 'assistant',
    tokens: { input: 10, output: 2 },
  }));
  db.prepare(`INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)`).run('p_01_step', 'msg_v1', 'ses_v1_textless', 1000, 1000, JSON.stringify({
    type: 'step-finish',
    tokens: { input: 10, output: 2 },
  }));

  // V2 failed compaction with tokens
  db.prepare(`INSERT INTO session_v2 (id, project_id, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('ses_v2_comp', 'p1', '/work/p1', 'Failed Comp', '2.0.32', 2000, 2000);
  db.prepare(`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('m_comp_fail', 'ses_v2_comp', 'compaction', 1, 2000, 2000, JSON.stringify({
    status: 'failed',
    summary: null,
    tokens: { input: 50, output: 15 },
  }));
  db.close();

  const provider = createOpencodeProvider({ rootDir: dir, homeDir: home, openDatabase: openDb });
  const units = discover(provider);

  const uV1 = units.find(u => u.sessionId.includes('ses_v1_textless'));
  const v1Records = [...provider.parse(uV1, null)].filter(r => r.kind === 'message');
  assert.equal(v1Records.length, 1);
  assert.equal(v1Records[0].input_tokens, 10);
  assert.equal(v1Records[0].output_tokens, 2);

  const uV2 = units.find(u => u.sessionId.includes('ses_v2_comp'));
  const v2Records = [...provider.parse(uV2, null)].filter(r => r.kind === 'message');
  assert.equal(v2Records.length, 1, 'failed compaction with tokens emits accounting record');
  assert.equal(v2Records[0].input_tokens, 50);
  assert.equal(v2Records[0].output_tokens, 15);
  assert.equal(v2Records[0].visibility, 'hidden');
});

test('P2-6: authentic Model.Ref object resolution for V2 assistant, switch card, and V1 modelID', () => {
  const home = makeTempDir('opencode-models-p26-');
  const dir = join(home, 'data');
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'opencode.db');
  initTestStore(dbPath);

  const db = new DatabaseSync(dbPath);
  // V2 session with session.model JSON and per-message model object
  db.prepare(`INSERT INTO session_v2 (id, project_id, directory, title, version, time_created, time_updated, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'ses_v2_model', 'p1', '/work/p1', 'Model Test', '2.0.32', 1000, 1000, JSON.stringify({ id: 'session-default-model', providerID: 'test' }),
  );
  db.prepare(`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    'm1_asst', 'ses_v2_model', 'assistant', 1, 1000, 1000, JSON.stringify({
      model: { id: 'actual-per-message-model', providerID: 'custom-p' },
      content: [{ type: 'text', text: 'hello' }],
    }),
  );
  db.prepare(`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    'm2_switch', 'ses_v2_model', 'model-switched', 2, 1001, 1001, JSON.stringify({
      model: { id: 'target-model', providerID: 'custom-p' },
      previous: { id: 'source-model', providerID: 'custom-p' },
    }),
  );

  // V1 session with modelID
  db.prepare(`INSERT INTO session (id, project_id, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('ses_v1_model', 'p1', '/work/p1', 'V1 Model', '1.19.3', 2000, 2000);
  db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`).run('m1_v1', 'ses_v1_model', 2000, 2000, JSON.stringify({
    role: 'assistant',
    modelID: 'v1-native-model',
  }));
  db.prepare(`INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)`).run('p1', 'm1_v1', 'ses_v1_model', 2000, 2000, JSON.stringify({ type: 'text', text: 'v1 resp' }));
  db.close();

  const provider = createOpencodeProvider({ rootDir: dir, homeDir: home, openDatabase: openDb });
  const units = discover(provider);

  const uV2 = units.find(u => u.sessionId.includes('ses_v2_model'));
  const v2Msgs = [...provider.parse(uV2, null)].filter(r => r.kind === 'message');
  assert.equal(v2Msgs[0].model, 'actual-per-message-model', 'V2 assistant parses model.id');
  assert.equal(v2Msgs[1].text, 'model source-model → target-model', 'V2 switch card resolves objects');
  assert.equal(v2Msgs[1].model, 'target-model');

  const uV1 = units.find(u => u.sessionId.includes('ses_v1_model'));
  const v1Msgs = [...provider.parse(uV1, null)].filter(r => r.kind === 'message');
  assert.equal(v1Msgs[0].model, 'v1-native-model', 'V1 assistant parses modelID');
});

test('P2-7: V1 user multi-part revert partitions into visible and inactive parts', () => {
  const home = makeTempDir('opencode-revert-user-');
  const dir = join(home, 'data');
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'opencode.db');
  initTestStore(dbPath);

  const db = new DatabaseSync(dbPath);
  db.prepare(`INSERT INTO session (id, project_id, directory, title, version, time_created, time_updated, revert) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'ses_rev_user', 'p1', '/work/p1', 'User Revert', '1.19.3', 1000, 1000, JSON.stringify({
      messageID: 'msg_u1',
      partID: 'prt_000002_cut',
    }),
  );
  db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`).run(
    'msg_u1', 'ses_rev_user', 1000, 1000, JSON.stringify({ role: 'user' }),
  );
  db.prepare(`INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)`).run('prt_000001_keep', 'msg_u1', 'ses_rev_user', 1000, 1000, JSON.stringify({ type: 'text', text: 'keep' }));
  db.prepare(`INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)`).run('prt_000002_cut', 'msg_u1', 'ses_rev_user', 1001, 1001, JSON.stringify({ type: 'text', text: 'cut' }));
  db.close();

  const provider = createOpencodeProvider({ rootDir: dir, homeDir: home, openDatabase: openDb });
  const units = discover(provider);
  const records = [...provider.parse(units[0], null)];

  const msgs = records.filter(r => r.kind === 'message');
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].text, 'keep');
  assert.equal(msgs[0].visibility, 'visible');
  assert.equal(msgs[1].text, 'cut');
  assert.equal(msgs[1].visibility, 'inactive');

  const sessRecord = records.find(r => r.kind === 'session');
  assert.equal(sessRecord.message_count, 1, 'message_count only includes visible parts');
});

test('P2-8: V2 skill and shell project to canonical records, and unknown types are preserved without dropping history', () => {
  const home = makeTempDir('opencode-types-p28-');
  const dir = join(home, 'data');
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'opencode.db');
  initTestStore(dbPath);

  const db = new DatabaseSync(dbPath);
  db.prepare(`INSERT INTO session_v2 (id, project_id, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('ses_types', 'p1', '/work/p1', 'Types Test', '2.0.32', 1000, 1000);
  db.prepare(`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    'm1_skill', 'ses_types', 'skill', 1, 1000, 1000, JSON.stringify({ name: 'code-review', instructions: 'perform thorough review' }),
  );
  db.prepare(`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    'm2_shell', 'ses_types', 'shell', 2, 1001, 1001, JSON.stringify({ command: 'git status', status: 'completed', output: 'clean' }),
  );
  db.prepare(`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    'm3_future', 'ses_types', 'future-agent-action', 3, 1002, 1002, JSON.stringify({ text: 'future content' }),
  );
  db.close();

  const provider = createOpencodeProvider({ rootDir: dir, homeDir: home, openDatabase: openDb });
  const units = discover(provider);
  const records = [...provider.parse(units[0], null)];

  const msgs = records.filter(r => r.kind === 'message');
  assert.equal(msgs.length, 3, 'all 3 non-standard messages emitted canonical records');

  // skill
  assert.equal(msgs[0].content_type, 'skill_instructions');
  assert.equal(msgs[0].text, 'perform thorough review');
  assert.equal(msgs[0].skill, 'code-review');

  // shell
  assert.equal(msgs[1].content_type, 'tool_use');
  const toolCall = records.find(r => r.kind === 'tool_call');
  assert.ok(toolCall);
  assert.equal(toolCall.name, 'bash');
  assert.ok(toolCall.input_json.includes('git status'));
  const toolRes = records.find(r => r.kind === 'tool_result');
  assert.ok(toolRes);
  assert.equal(toolRes.content, 'clean');

  // future type
  assert.equal(msgs[2].text, 'future content');
  assert.equal(msgs[2].is_meta, 1);
});

test('P2-9: OPENCODE_DB absolute path configures symmetric watchTargets, and new channel promotes in watcher filter without readdirSync', async () => {
  const home = makeTempDir('opencode-watch-p29-');
  const dir = join(home, 'data');
  mkdirSync(dir, { recursive: true });
  const customDbPath = join(home, 'isolated-other.db');
  writeFileSync(customDbPath, '');

  const prevEnv = process.env.OPENCODE_DB;
  try {
    process.env.OPENCODE_DB = customDbPath;
    const provider = createOpencodeProvider({ homeDir: home, openDatabase: openDb });
    const targets = provider.watchTargets(provider.descriptor.defaultRoot);

    // Watch targets point to customDbPath and customDbPath-wal, not home dir
    const filePaths = targets.filter(t => t.kind === 'file').map(t => t.path);
    assert.ok(filePaths.includes(customDbPath), 'watches custom OPENCODE_DB file');
    assert.ok(filePaths.includes(`${customDbPath}-wal`), 'watches custom OPENCODE_DB WAL');

    // Test caller filter matches newly created channel db
    delete process.env.OPENCODE_DB;
    const standardProvider = createOpencodeProvider({ rootDir: dir, homeDir: home, openDatabase: openDb });
    const dirTargets = standardProvider.watchTargets(dir);
    const treeTarget = dirTargets.find(t => t.kind === 'tree');
    assert.ok(treeTarget);
    assert.ok(typeof treeTarget.matches === 'function');
    assert.equal(treeTarget.matches('opencode-dev.db'), true);
    assert.equal(treeTarget.matches('opencode-dev.db-wal'), true);
    assert.equal(treeTarget.matches('opencode-dev.db-shm'), false);
    assert.equal(treeTarget.matches('random.txt'), false);
  } finally {
    if (prevEnv !== undefined) process.env.OPENCODE_DB = prevEnv; else delete process.env.OPENCODE_DB;
  }
});

test('P2-10: parent classification consistency: rechecked within snapshot, and orphan parent matches between parse and raw', () => {
  const home = makeTempDir('opencode-parent-p210-');
  const dir = join(home, 'data');
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'opencode.db');
  initTestStore(dbPath);

  const db = new DatabaseSync(dbPath);
  // Orphan session: parent_id refers to non-existent parent 'missing_parent_id'
  db.prepare(`INSERT INTO session_v2 (id, project_id, directory, title, version, time_created, time_updated, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'ses_orphan', 'p1', '/work/p1', 'Orphan Session', '2.0.32', 1000, 1000, 'missing_parent_id',
  );
  db.prepare(`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    'm1', 'ses_orphan', 'user', 1, 1000, 1000, JSON.stringify({ text: 'orphan text' }),
  );
  db.close();

  const provider = createOpencodeProvider({ rootDir: dir, homeDir: home, openDatabase: openDb });
  const units = discover(provider);
  assert.equal(units[0].isSubagent, false, 'orphan session is not subagent because parent does not exist');

  const { cursor } = drain(provider.parse(units[0], null));
  assert.ok(cursor);

  // Raw lookup with freshly parsed cursor must succeed and not fail fingerprint
  const sessionId = opencodeSessionId('ses_orphan', dbPath);
  const jsonlPath = opencodeUnitKey(dbPath, 'ses_orphan');
  const uuid = `${sessionId}:m:000001:m1:msg`;

  const rawResult = provider.raw({
    source: 'opencode',
    messageUuid: uuid,
    cursor,
    session: { id: sessionId, jsonl_path: jsonlPath },
  });
  assert.ok(rawResult, 'raw succeeds and authenticates cursor for orphan session');
  assert.equal(rawResult.messageText, 'orphan text');
});

test('P2-11: deterministic V1 part ordering by upstream ID regardless of insertion order', () => {
  const home = makeTempDir('opencode-order-p211-');
  const dir = join(home, 'data');
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'opencode.db');
  initTestStore(dbPath);

  const db = new DatabaseSync(dbPath);
  db.prepare(`INSERT INTO session (id, project_id, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('ses_v1_order', 'p1', '/work/p1', 'Order', '1.19.3', 1000, 1000);
  db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`).run('msg_1', 'ses_v1_order', 1000, 1000, JSON.stringify({ role: 'assistant' }));

  // Reverse physical insertion: prt_000002 inserted before prt_000001 with SAME timestamp
  db.prepare(`INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)`).run('prt_000002', 'msg_1', 'ses_v1_order', 1000, 1000, JSON.stringify({ type: 'text', text: 'second' }));
  db.prepare(`INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)`).run('prt_000001', 'msg_1', 'ses_v1_order', 1000, 1000, JSON.stringify({ type: 'text', text: 'first' }));
  db.close();

  const provider = createOpencodeProvider({ rootDir: dir, homeDir: home, openDatabase: openDb });
  const units = discover(provider);
  const msgs = [...provider.parse(units[0], null)].filter(r => r.kind === 'message');

  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].text, 'first', 'first part emitted first');
  assert.equal(msgs[1].text, 'second', 'second part emitted second');
  assert.equal(msgs[1].parent_uuid, msgs[0].uuid, 'parent chain flows from first to second');
});

test('review regression: v1.19.3 modern writer and legacy history coexist through query, raw, updates and schema rename', () => {
  const { db, provider, path } = upstreamStore();
  upstreamSession(db, 'modern');
  upstreamSession(db, 'child', 'session', 'modern');
  upstreamSession(db, 'legacy');
  upstreamMessage(db, 'modern', 'msg_user', 'user', 1, { text: 'modern prompt' });
  upstreamMessage(db, 'modern', 'msg_answer', 'assistant', 2, {
    content: [{ type: 'text', text: 'modern answer' }],
    tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 0 } },
  });
  upstreamMessage(db, 'child', 'msg_child', 'user', 1, { text: 'child prompt' });
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
    .run('msg_legacy', 'legacy', 1000, 1000, JSON.stringify({ role: 'user' }));
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')
    .run('part_legacy', 'msg_legacy', 'legacy', 1000, 1000, JSON.stringify({ type: 'text', text: 'legacy prompt' }));
  const idx = indexFixture(provider);
  try {
    idx.run();
    const id = opencodeSessionId('modern', path);
    const query = createQueryApi(idx.db, { providerRegistry: createProviderRegistry([provider]) });
    const modern = query.messages({ sessionId: id });
    assert.equal(modern.messages.length, 2, 'the actual modern writer retains both messages');
    assert.equal(query.sessions({ source: 'opencode' }).length, 3);
    assert.equal(idx.db.prepare('SELECT input_tokens FROM messages WHERE text=?').get('modern answer').input_tokens, 13);
    assert.equal(idx.db.prepare('SELECT output_tokens FROM messages WHERE text=?').get('modern answer').output_tokens, 7);
    const user = idx.db.prepare('SELECT uuid FROM messages WHERE text=?').get('modern prompt');
    assert.match(query.raw(user.uuid).text, /modern prompt/);
    assert.equal(idx.db.prepare('SELECT session_id FROM subagents').get().session_id, id);
    assert.ok(idx.db.prepare('SELECT uuid FROM messages WHERE text=?').get('legacy prompt'));
    const unit = discover(provider).find(u => u.sessionId === id);
    const direct = assembleSessionDetail([...provider.parse(unit, null)]);
    assert.deepEqual(direct, assembleSessionDetail({
      session: idx.db.prepare('SELECT * FROM sessions WHERE id=?').get(id),
      messages: idx.db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY timestamp,rowid').all(id),
      toolCalls: [], toolResults: [],
    }));
    db.prepare('UPDATE session_message SET data=? WHERE id=?').run(JSON.stringify({ text: 'same-ms update' }), 'msg_user');
    idx.run();
    assert.ok(idx.db.prepare('SELECT uuid FROM messages WHERE text=?').get('same-ms update'));
    assert.match(query.raw(user.uuid).text, /same-ms update/);
    // The official pre-split V2 migration renames the metadata table in place.
    db.prepare('DELETE FROM session WHERE id=?').run('legacy');
    db.exec('ALTER TABLE session RENAME TO session_v2');
    idx.run();
    assert.ok(query.sessions({ source: 'opencode' }).some(s => s.id === id));
    assert.match(query.raw(user.uuid).text, /same-ms update/);
    db.prepare('DELETE FROM session_message WHERE id=?').run('msg_answer');
    idx.run();
    assert.equal(query.messages({ sessionId: id }).messages.length, 1);
  } finally { db.close(); idx.close(); }
});

test('review regression: malformed payloads retain the last complete snapshot and cursor, then recover', () => {
  for (const [table, badData, messageType = 'user'] of [
    ['session_message', '{'], ['session_message', 'null'],
    ['session_message', JSON.stringify({ text: 42 })],
    ['session_message', JSON.stringify({ content: 'invalid' }), 'assistant'],
    ['session_message', JSON.stringify({ content: [{ type: 'text', text: 42 }] }), 'assistant'],
    ['session_message', JSON.stringify({ content: [{ type: 'tool', id: 'call', name: 42, state: { status: 'running' } }] }), 'assistant'],
    ['message', '{'], ['part', '{'], ['part', JSON.stringify({ type: 'text', text: 42 })],
  ]) {
    const { db, provider } = upstreamStore(table === 'session_message' ? 'v2.0.32' : 'v1.19.3');
    upstreamSession(db, 's', table === 'session_message' ? 'session_v2' : 'session');
    if (table === 'session_message') upstreamMessage(db, 's', 'm', messageType, 1,
      messageType === 'assistant' ? { content: [{ type: 'text', text: 'last-good' }] } : { text: 'last-good' });
    else {
      db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
        .run('m', 's', 1000, 1000, JSON.stringify({ role: 'user' }));
      db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')
        .run('p', 'm', 's', 1000, 1000, JSON.stringify({ type: 'text', text: 'last-good' }));
    }
    const idx = indexFixture(provider);
    try {
      idx.run();
      const before = idx.db.prepare('SELECT * FROM messages').all();
      assert.equal(before[0]?.text, 'last-good');
      const cursors = idx.db.prepare("SELECT * FROM index_state WHERE jsonl_path NOT LIKE '__opencode_observation%' ORDER BY jsonl_path").all();
      const goodData = db.prepare(`SELECT data FROM ${table}`).get().data;
      db.prepare(`UPDATE ${table} SET data=?`).run(badData);
      const errors = [];
      const result = indexProviderPlan({
        db: idx.db, plan: createProviderIndexPlan(idx.db, createProviderRegistry([provider])),
        runTransaction: (_label, work) => runWriteTransaction(idx.db, work),
        onError: error => { errors.push(error); return 'skip'; },
      });
      assert.equal(result.complete, false, `${table}: damage cannot publish a complete snapshot`);
      assert.match(errors[0].message, /invalid.*(JSON|payload)/i);
      assert.deepEqual(idx.db.prepare('SELECT * FROM messages').all(), before);
      assert.deepEqual(idx.db.prepare("SELECT * FROM index_state WHERE jsonl_path NOT LIKE '__opencode_observation%' ORDER BY jsonl_path").all(), cursors);
      db.prepare(`UPDATE ${table} SET data=?`).run(goodData);
      assert.equal(idx.run().result.complete, true);
    } finally { db.close(); idx.close(); }
  }
});

test('review regression: native shell exit, timeout and killed results remain queryable failures', () => {
  const { db, provider } = upstreamStore('v2.0.32');
  upstreamSession(db, 'shells', 'session_v2');
  const cases = [
    { status: 'exited', exit: 0, output: 'success' },
    { status: 'exited', exit: 1, output: 'failed' },
    { status: 'timeout', output: '' }, { status: 'killed', output: 'terminated' },
    { status: 'running' },
  ];
  cases.forEach((c, i) => upstreamMessage(db, 'shells', `m${i}`, 'shell', i, {
    shellID: `sh_${i}`, command: 'synthetic-command', status: c.status, exit: c.exit,
    ...(c.output === undefined ? {} : { output: { output: c.output, cursor: c.output.length, size: c.output.length, truncated: false } }),
    time: { created: 1000, ...(c.status === 'running' ? {} : { completed: 1001 }) },
  }));
  const idx = indexFixture(provider);
  try {
    idx.run();
    const results = idx.db.prepare('SELECT content,is_error FROM tool_results ORDER BY rowid').all();
    assert.deepEqual(results.map(r => [r.content, r.is_error]), [['success', 0], ['failed', 1], ['', 1], ['terminated', 1]]);
    assert.equal(createQueryApi(idx.db).failures({ source: 'opencode' }).length, 3);
    assert.equal(idx.db.prepare('SELECT COUNT(*) AS n FROM tool_calls').get().n, 5);
  } finally { db.close(); idx.close(); }
});

test('review regression: pre-split modern shell rows without status preserve running and empty completed output', () => {
  const { db, provider } = upstreamStore();
  upstreamSession(db, 'shells');
  upstreamMessage(db, 'shells', 'running', 'shell', 1, {
    callID: 'call_running', command: 'synthetic-command', output: '', time: { created: 1000 },
  });
  upstreamMessage(db, 'shells', 'completed', 'shell', 2, {
    callID: 'call_completed', command: 'synthetic-command', output: 'shell output', time: { created: 1001, completed: 1002 },
  });
  upstreamMessage(db, 'shells', 'empty', 'shell', 3, {
    callID: 'call_empty', command: 'synthetic-command', output: '', time: { created: 1003, completed: 1004 },
  });
  const idx = indexFixture(provider);
  try {
    idx.run();
    assert.equal(idx.db.prepare('SELECT COUNT(*) AS n FROM tool_calls').get().n, 3);
    assert.deepEqual(idx.db.prepare('SELECT content,is_error FROM tool_results ORDER BY rowid').all().map(r => [r.content, r.is_error]), [['shell output', 0], ['', 0]]);
    const api = createQueryApi(idx.db, { providerRegistry: createProviderRegistry([provider]) });
    const uuid = idx.db.prepare("SELECT uuid FROM messages WHERE uuid LIKE '%:completed:msg'").get().uuid;
    assert.match(api.raw(uuid).text, /call_completed/);
    assert.equal(api.failures({ source: 'opencode' }).length, 0, 'this writer did not record exit status; do not invent a failure');
  } finally { db.close(); idx.close(); }
});

test('review regression: explicit default root overrides OPENCODE_DB for discovery and watcher together', () => {
  const home = makeTempDir('opencode-explicit-default-');
  const oldXdg = process.env.XDG_DATA_HOME;
  const oldDb = process.env.OPENCODE_DB;
  try {
    delete process.env.XDG_DATA_HOME;
    const root = defaultOpencodeDataRoot(home);
    mkdirSync(root, { recursive: true });
    const { db } = upstreamStore('v2.0.32', 'opencode.db', root);
    upstreamSession(db, 'explicit', 'session_v2'); db.close();
    process.env.OPENCODE_DB = join(home, 'other', 'custom.db');
    const runtime = createConfiguredBuiltinProviderRuntime({ providerRoots: { opencode: root } }, { homeDir: home, openOpencodeDatabase: openDb });
    const provider = runtime.registry.get('opencode');
    assert.equal(discover(provider).length, 1);
    const targets = provider.watchTargets(runtime.roots.opencode);
    assert.ok(targets.some(t => t.path === join(root, 'opencode.db')));
    assert.ok(targets.some(t => t.path === join(root, 'opencode.db-wal')));
    assert.ok(!targets.some(t => t.path === process.env.OPENCODE_DB));
    const automatic = createConfiguredBuiltinProviderRuntime({}, { homeDir: home, openOpencodeDatabase: openDb });
    assert.deepEqual(automatic.registry.get('opencode').watchTargets(automatic.roots.opencode), [
      { kind: 'file', path: process.env.OPENCODE_DB }, { kind: 'file', path: `${process.env.OPENCODE_DB}-wal` },
    ]);
  } finally {
    if (oldXdg === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = oldXdg;
    if (oldDb === undefined) delete process.env.OPENCODE_DB; else process.env.OPENCODE_DB = oldDb;
  }
});

test('review regression: marker upgrade repairs existing canonical rows atomically and retries after damaged input', () => {
  const { db, provider, path } = upstreamStore();
  upstreamSession(db, 's');
  upstreamMessage(db, 's', 'm', 'user', 1, { text: 'native modern prompt' });
  const id = opencodeSessionId('s', path);
  const key = opencodeUnitKey(path, 's');
  const idx = indexFixture(provider);
  try {
    // Literal old marker/cursor: this must model an installation of the PR's
    // previous version, not another copy of the new constants.
    idx.db.prepare('INSERT INTO sessions (id,source,jsonl_path,message_count) VALUES (?,?,?,?)')
      .run(id, 'opencode', key, 0);
    idx.db.prepare('INSERT INTO messages (uuid,session_id,type,role,text,content_type,source) VALUES (?,?,?,?,?,?,?)')
      .run('stale-projection', id, 'user', 'user', 'old projection', 'text', 'opencode');
    idx.db.prepare('INSERT INTO index_state (jsonl_path,mtime,lines_processed,cursor) VALUES (?,?,?,?)')
      .run('__opencode_canonical_transcript_v1__', 1000, 0, null);
    idx.db.prepare('INSERT INTO index_state (jsonl_path,mtime,lines_processed,cursor) VALUES (?,?,?,?)')
      .run(key, 1000, 0, '1000:0:v1:old-empty-fingerprint');
    const before = idx.db.prepare('SELECT * FROM messages').all();
    db.prepare('UPDATE session_message SET data=?').run('{');
    assert.throws(() => idx.run(), /invalid JSON payload/);
    assert.deepEqual(idx.db.prepare('SELECT * FROM messages').all(), before);
    assert.equal(idx.db.prepare('SELECT cursor FROM index_state WHERE jsonl_path=?').get(key).cursor, '1000:0:v1:old-empty-fingerprint');
    assert.equal(idx.db.prepare('SELECT 1 FROM index_state WHERE jsonl_path=?').get('__opencode_canonical_transcript_v3__'), undefined);
    db.prepare('UPDATE session_message SET data=?').run(JSON.stringify({ text: 'native modern prompt' }));
    const replay = idx.run();
    assert.equal(replay.result.complete, true);
    assert.ok(replay.plan.replayKeys.has('opencode'));
    assert.equal(idx.db.prepare('SELECT text FROM messages').get().text, 'native modern prompt');
    assert.equal(idx.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
    assert.ok(idx.db.prepare('SELECT 1 FROM index_state WHERE jsonl_path=?').get('__opencode_canonical_transcript_v3__'));
    assert.equal(idx.run().plan.items.length, 0, 'the upgrade converges rather than replaying forever');
  } finally { db.close(); idx.close(); }
});

test('review regression: hot hints are bounded, deduplicated and scoped to selected OpenCode stores', () => {
  const { db, provider, path, dir } = upstreamStore('v2.0.32', 'opencode-feature.db');
  upstreamSession(db, 's', 'session_v2');
  upstreamSession(db, 's2', 'session_v2');
  const idx = indexFixture(provider);
  const registry = createProviderRegistry([provider]);
  try {
    idx.run();
    assert.deepEqual(readRecentTranscriptHints(idx.db, 64, registry), [path, `${path}-wal`]);
    assert.deepEqual(readRecentTranscriptHints(idx.db, 1, registry), [path]);
    assert.deepEqual(provider.watchHints(opencodeUnitKey(join(dir, 'excluded', 'opencode.db'), 's')), []);
    const disabled = createConfiguredBuiltinProviderRuntime({ providerRoots: { opencode: '' } }, { openOpencodeDatabase: openDb });
    assert.deepEqual(readRecentTranscriptHints(idx.db, 64, disabled.registry), []);
    const changedRoot = createProviderRegistry([createOpencodeProvider({ rootDir: join(dir, 'new-root'), openDatabase: openDb })]);
    assert.deepEqual(readRecentTranscriptHints(idx.db, 64, changedRoot), []);
  } finally { db.close(); idx.close(); }
});

test('review regression: hundreds of newer sessions in one channel do not hide another channel from startup polling', () => {
  const first = upstreamStore('v2.0.32', 'opencode-channel-a.db');
  const second = upstreamStore('v2.0.32', 'opencode-channel-b.db', first.dir);
  for (let i = 0; i < 257; i++) upstreamSession(first.db, `s${i}`, 'session_v2');
  first.db.exec('UPDATE session_v2 SET time_updated=2000');
  upstreamSession(second.db, 'b', 'session_v2');
  const idx = indexFixture(first.provider);
  try {
    idx.run();
    const registry = createProviderRegistry([first.provider]);
    const hints = readRecentTranscriptHints(idx.db, 64, registry);
    assert.deepEqual(hints, [first.path, `${first.path}-wal`, second.path, `${second.path}-wal`]);
    // Breaking out of a real SQLite iterator must release its statement so
    // the writer can immediately begin another transaction on this binding.
    assert.equal(readRecentTranscriptHints(idx.db, 1, registry).length, 1);
    idx.db.exec('BEGIN IMMEDIATE; ROLLBACK');
    assert.equal(idx.run().result.complete, true);
  } finally { first.db.close(); second.db.close(); idx.close(); }
});

test('delimiter-bearing paths authenticate raw lookup and reject restored tombstones', {
  skip: process.platform === 'win32' ? 'Windows filenames cannot contain a colon; virtual-path raw authentication is covered separately' : false,
}, () => {
  const dir = join(makeTempDir('opencode-identity-'), 'data#ses:archive');
  mkdirSync(dir);
  const source = upstreamStore('v2.0.32', 'opencode.db', dir);
  const insert = () => {
    upstreamSession(source.db, 's:#ses:%', 'session_v2');
    upstreamMessage(source.db, 's:#ses:%', 'm', 'user', 1, { text: 'last-good' });
  };
  insert();
  const idx = indexFixture(source.provider);
  try {
    idx.run();
    const session = idx.db.prepare('SELECT * FROM sessions').get();
    const message = idx.db.prepare('SELECT uuid FROM messages').get();
    assert.equal(source.provider.raw({ source: 'opencode', session, messageUuid: message.uuid }).messageText, 'last-good');
    source.db.prepare('DELETE FROM session_v2').run();
    const plan = createProviderIndexPlan(idx.db, createProviderRegistry([source.provider]));
    assert.equal(transcriptItems(plan.items).length, 1);
    insert();
    const result = indexProviderPlan({ db: idx.db, plan,
      runTransaction: (_label, work) => runWriteTransaction(idx.db, work), onError: () => 'skip' });
    assert.equal(result.complete, false);
    assert.equal(idx.db.prepare('SELECT count(*) n FROM messages').get().n, 1);
    assert.deepEqual(source.provider.watchHints(session.jsonl_path), [source.path, `${source.path}-wal`]);
  } finally { source.db.close(); idx.close(); }
});

test('raw authenticates delimiter-bearing virtual store identities on every platform', () => {
  const source = upstreamStore('v2.0.32');
  const nativeId = 's:#ses:%';
  upstreamSession(source.db, nativeId, 'session_v2');
  upstreamMessage(source.db, nativeId, 'm', 'user', 1, { text: 'synthetic identity' });
  try {
    const unit = discover(source.provider)[0];
    const message = [...source.provider.parse(unit, null)].find(record => record.kind === 'message');
    const virtualPath = join(source.dir, 'data#ses:archive', 'opencode.db');
    const session = { id: opencodeSessionId(nativeId, virtualPath), jsonl_path: opencodeUnitKey(virtualPath, nativeId) };
    const messageUuid = session.id + message.uuid.slice(unit.sessionId.length);
    let opens = 0;
    const provider = createOpencodeProvider({ rootDir: source.dir, openDatabase: path => {
      assert.equal(path, virtualPath);
      opens++;
      return openDb(source.path);
    } });
    assert.equal(provider.raw({ source: 'opencode', session, messageUuid }).messageText, 'synthetic identity');
    assert.equal(opens, 1);
    assert.equal(provider.raw({ source: 'opencode', session: { ...session, id: unit.sessionId }, messageUuid }), null);
    assert.equal(provider.raw({ source: 'opencode', session, messageUuid: message.uuid }), null);
    assert.equal(opens, 1, 'mismatched store identities must be rejected before opening a database');
  } finally { source.db.close(); }
});

test('damaged required legacy tool fields preserve last-good tools and cursor until recovery', () => {
  for (const field of ['callID', 'tool', 'state']) {
    const source = upstreamStore();
    upstreamSession(source.db, 's');
    source.db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run('m', 's', 1000, 1000, JSON.stringify({ role: 'assistant' }));
    const tool = { type: 'tool', callID: 'call', tool: 'read', state: {
      status: 'completed', input: {}, output: 'last-good', title: 'synthetic', metadata: {}, time: { start: 1000, end: 1001 },
    } };
    source.db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('p', 'm', 's', 1000, 1000, JSON.stringify(tool));
    const idx = indexFixture(source.provider);
    try {
      idx.run();
      const cursors = idx.db.prepare("SELECT * FROM index_state WHERE jsonl_path NOT LIKE '__opencode_observation%' ORDER BY jsonl_path").all();
      const damaged = { ...tool }; delete damaged[field];
      source.db.prepare('UPDATE part SET data=?').run(JSON.stringify(damaged));
      const result = indexProviderPlan({ db: idx.db,
        plan: createProviderIndexPlan(idx.db, createProviderRegistry([source.provider])),
        runTransaction: (_label, work) => runWriteTransaction(idx.db, work), onError: () => 'skip' });
      assert.equal(result.complete, false, field);
      assert.equal(idx.db.prepare('SELECT count(*) n FROM tool_calls').get().n, 1);
      assert.deepEqual(idx.db.prepare("SELECT * FROM index_state WHERE jsonl_path NOT LIKE '__opencode_observation%' ORDER BY jsonl_path").all(), cursors);
      source.db.prepare('UPDATE part SET data=?').run(JSON.stringify(tool));
      assert.equal(idx.run().result.complete, true);
    } finally { source.db.close(); idx.close(); }
  }
});

test('pre-split completed compaction is a summary in direct, SQLite and raw projections', () => {
  const source = upstreamStore();
  upstreamSession(source.db, 's');
  upstreamMessage(source.db, 's', 'm', 'compaction', 1, {
    reason: 'auto', summary: 'completed summary', recent: 'synthetic tail', time: { created: 1000 },
  });
  const idx = indexFixture(source.provider);
  try {
    const unit = discover(source.provider)[0];
    const records = [...source.provider.parse(unit, null)];
    assert.equal(records.find(r => r.kind === 'summary')?.content, 'completed summary');
    idx.run();
    const summary = idx.db.prepare('SELECT * FROM summaries').get();
    assert.equal(summary.content, 'completed summary');
    assert.equal(source.provider.raw({ source: 'opencode', session: { id: unit.sessionId, jsonl_path: unit.key }, messageUuid: summary.id }).messageText, 'completed summary');
  } finally { source.db.close(); idx.close(); }
});

function instrumentedProvider(source) {
  const reads = { payloadRows: 0, payloadBytes: 0, metadataRows: 0, payloadSessions: new Set() };
  const provider = createOpencodeProvider({ rootDir: source.dir, openDatabase: path => {
    const db = openDb(path);
    return { exec: sql => db.exec(sql), close: () => db.close(), prepare: sql => {
      const stmt = db.prepare(sql);
      const count = (rows, args) => {
        for (const row of rows) {
          if (typeof row.data === 'string') {
            reads.payloadRows++; reads.payloadBytes += Buffer.byteLength(row.data);
            reads.payloadSessions.add(row.session_id ?? args[0]);
          } else reads.metadataRows++;
        }
        return rows;
      };
      return { run: (...args) => stmt.run(...args),
        all: (...args) => count(stmt.all(...args), args),
        get: (...args) => { const row = stmt.get(...args); count(row ? [row] : [], args); return row; } };
    } };
  } });
  const reset = () => { reads.payloadRows = reads.payloadBytes = reads.metadataRows = 0; reads.payloadSessions.clear(); };
  return { provider, reads, reset };
}

test('unchanged census reads zero payload; modern writes in mixed stores replay only affected history', () => {
  for (const historySize of [10, 100]) {
    const source = upstreamStore();
    source.db.exec('BEGIN');
    for (let i = 0; i < 20; i++) {
      upstreamSession(source.db, `s${i}`);
      source.db.prepare('INSERT INTO event_sequence VALUES (?,?,?)').run(`s${i}`, 1, 'owner');
      for (let j = 0; j < (i === 0 ? 5 : historySize); j++) {
        upstreamMessage(source.db, `s${i}`, `m${i}_${j}`, 'user', j, { text: 'synthetic '.repeat(50) });
      }
    }
    upstreamSession(source.db, 'legacy');
    source.db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run('lm', 'legacy', 1000, 1000, JSON.stringify({ role: 'user' }));
    for (let j = 0; j < historySize; j++) source.db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)')
      .run(`lp${j}`, 'lm', 'legacy', 1000, 1000, JSON.stringify({ type: 'text', text: 'legacy '.repeat(100) }));
    source.db.exec('COMMIT');
    const { provider, reads, reset } = instrumentedProvider(source);
    const cursors = new Map();
    const apply = () => {
      const units = discover(provider, { cursors, includeControl: true });
      for (const unit of units) cursors.set(unit.key, drain(provider.parse(unit, cursors.get(unit.key) ?? null)).cursor);
      return units;
    };
    try {
      apply(); reset();
      assert.equal(apply().length, 0);
      assert.equal(reads.payloadRows, 0, 'unchanged history must not be read to prove it unchanged');
      for (let update = 0; update < 3; update++) {
        // Exact durable writer contract: head and projector commit together;
        // timestamps and insertion seq intentionally stay at the same millisecond.
        source.db.exec('BEGIN IMMEDIATE');
        source.db.prepare('UPDATE session_message SET data=? WHERE id=?').run(JSON.stringify({ text: `update ${update}` }), 'm0_0');
        source.db.prepare('UPDATE event_sequence SET seq=seq+1 WHERE aggregate_id=?').run('s0');
        source.db.exec('COMMIT'); reset();
        const units = apply();
        assert.equal(transcriptUnits(units).length, 1);
        assert.equal(transcriptUnits(units)[0].sessionId, opencodeSessionId('s0', source.path));
        assert.deepEqual([...reads.payloadSessions], ['s0']);
        assert.equal(reads.payloadRows, 5, '10x unrelated history cannot increase changed-session payload reads');
        reset(); assert.equal(apply().length, 0); assert.equal(reads.payloadRows, 0);
      }
      // New provider instance simulates worker/CLI restart: no connection-local cache.
      const restarted = instrumentedProvider(source);
      assert.equal(discover(restarted.provider, { cursors }).length, 0);
      assert.equal(restarted.reads.payloadRows, 0);
    } finally { source.db.close(); }
  }
});

test('legacy import prefix discovers remaining parts without a header or head update', () => {
  const source = upstreamStore(); upstreamSession(source.db, 's');
  source.db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run('m', 's', 1000, 1000, JSON.stringify({ role: 'user' }));
  source.db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('p1', 'm', 's', 1000, 1000, JSON.stringify({ type: 'text', text: 'prefix' }));
  const { provider, reads, reset } = instrumentedProvider(source);
  const idx = indexFixture(provider);
  try {
    idx.run(); const header = source.db.prepare('SELECT * FROM session').get(); reset();
    assert.equal(idx.run().plan.items.length, 0); assert.equal(reads.payloadRows, 0);
    source.db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('p2', 'm', 's', 1000, 1000, JSON.stringify({ type: 'text', text: 'remaining' }));
    assert.deepEqual(source.db.prepare('SELECT * FROM session').get(), header);
    assert.equal(idx.run().result.complete, true);
    assert.deepEqual(idx.db.prepare('SELECT text FROM messages ORDER BY rowid').all().map(r => r.text), ['prefix', 'remaining']);
    reset(); assert.equal(idx.run().plan.items.length, 0); assert.equal(reads.payloadRows, 0);
  } finally { source.db.close(); idx.close(); }
});

test('unexplained-write reconciliation retries failed sessions independently after sibling commits and restart', () => {
  const source = upstreamStore('v2.0.32');
  for (const id of ['a', 'b', 'c']) {
    upstreamSession(source.db, id, 'session_v2');
    upstreamMessage(source.db, id, `m${id}`, 'user', 0, { text: `last-good ${id}` });
    source.db.prepare('INSERT INTO event_sequence VALUES (?,?,?)').run(id, 1, 'owner');
  }
  const idx = indexFixture(source.provider);
  const run = provider => indexProviderPlan({ db: idx.db,
    plan: createProviderIndexPlan(idx.db, createProviderRegistry([provider])),
    runTransaction: (_label, work) => runWriteTransaction(idx.db, work), onError: () => 'skip' });
  try {
    idx.run();
    const key = opencodeUnitKey(source.path, 'b');
    const oldCursor = idx.db.prepare('SELECT cursor FROM index_state WHERE jsonl_path=?').get(key).cursor;
    source.db.prepare('UPDATE session_message SET data=? WHERE id=?').run('{', 'mb');
    const first = run(source.provider);
    assert.equal(transcriptItems(first.committed).length, 2); assert.equal(first.failedItems.length, 1);
    const restarted = createOpencodeProvider({ rootDir: source.dir, openDatabase: openDb });
    assert.equal(run(restarted).failedItems.length, 1, 'a sibling cursor must not acknowledge the failed payload');
    // An ordinary event-writer update must not erase outstanding recovery work.
    source.db.exec('BEGIN IMMEDIATE');
    source.db.prepare('UPDATE session_message SET data=? WHERE id=?').run(JSON.stringify({ text: 'updated c' }), 'mc');
    source.db.prepare('UPDATE event_sequence SET seq=seq+1 WHERE aggregate_id=?').run('c'); source.db.exec('COMMIT');
    assert.equal(run(restarted).failedItems.length, 1);
    assert.equal(idx.db.prepare('SELECT cursor FROM index_state WHERE jsonl_path=?').get(key).cursor, oldCursor);
    assert.ok(idx.db.prepare('SELECT 1 FROM messages WHERE text=?').get('last-good b'));
    source.db.prepare('UPDATE session_message SET data=? WHERE id=?').run(JSON.stringify({ text: 'recovered b' }), 'mb');
    assert.equal(run(restarted).complete, true);
    assert.ok(idx.db.prepare('SELECT 1 FROM messages WHERE text=?').get('recovered b'));
    assert.equal(run(restarted).committed.length, 0);
  } finally { source.db.close(); idx.close(); }
});

test('WAL checkpoint reconciles once without retracting equal canonical records and old cursors replay once', () => {
  const source = upstreamStore('v2.0.32'); source.db.exec('PRAGMA journal_mode=WAL');
  upstreamSession(source.db, 's', 'session_v2'); upstreamMessage(source.db, 's', 'm', 'user', 0, { text: 'stable' });
  source.db.prepare('INSERT INTO event_sequence VALUES (?,?,?)').run('s', 1, 'owner');
  const idx = indexFixture(source.provider);
  try {
    idx.run(); const before = idx.db.prepare('SELECT * FROM messages').all();
    source.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const checkpoint = idx.run();
    assert.equal(checkpoint.result.complete, true);
    assert.equal(transcriptItems(checkpoint.plan.items)[0].unit.meta.reason, 'unexplained-write');
    assert.deepEqual(idx.db.prepare('SELECT * FROM messages').all(), before);
    assert.equal(idx.run().plan.items.length, 0, 'checkpoint must not cause perpetual full scans');
    const key = opencodeUnitKey(source.path, 's');
    for (const old of ['1000:1:v1:old-fingerprint', '1000:1:future-manifest:opaque']) {
      idx.db.prepare('UPDATE index_state SET cursor=? WHERE jsonl_path=?').run(old, key);
      assert.equal(transcriptItems(idx.run().plan.items).length, 1);
      assert.equal(idx.run().plan.items.length, 0);
      assert.deepEqual(idx.db.prepare('SELECT * FROM messages').all(), before);
    }
  } finally { source.db.close(); idx.close(); }
});

test('a source update between discovery and parse rolls back the unit and retries a fresh observation', () => {
  const source = upstreamStore('v2.0.32'); upstreamSession(source.db, 's', 'session_v2');
  upstreamMessage(source.db, 's', 'm', 'user', 0, { text: 'last-good' });
  const idx = indexFixture(source.provider);
  try {
    idx.run(); const before = idx.db.prepare("SELECT * FROM index_state WHERE jsonl_path NOT LIKE '__opencode_observation%' ORDER BY jsonl_path").all();
    source.db.prepare('UPDATE session_message SET data=?').run(JSON.stringify({ text: 'intermediate' }));
    const plan = createProviderIndexPlan(idx.db, createProviderRegistry([source.provider]));
    source.db.prepare('UPDATE session_message SET data=?').run(JSON.stringify({ text: 'fresh' }));
    const errors = [];
    const result = indexProviderPlan({ db: idx.db, plan,
      runTransaction: (_label, work) => runWriteTransaction(idx.db, work), onError: e => { errors.push(e); return 'skip'; } });
    assert.equal(result.complete, false);
    assert.equal(errors[0].name, 'RetryableSourceReadError'); assert.equal(errors[0].sourcePath, source.path);
    assert.deepEqual(idx.db.prepare("SELECT * FROM index_state WHERE jsonl_path NOT LIKE '__opencode_observation%' ORDER BY jsonl_path").all(), before);
    assert.equal(idx.db.prepare('SELECT text FROM messages').get().text, 'last-good');
    assert.equal(idx.run().result.complete, true);
    assert.equal(idx.db.prepare('SELECT text FROM messages').get().text, 'fresh');
  } finally { source.db.close(); idx.close(); }
});

test('a failed known head change cannot hide a later separate body-only sibling rewrite', () => {
  const source = upstreamStore('v2.0.32');
  for (const id of ['a', 'b']) {
    upstreamSession(source.db, id, 'session_v2'); upstreamMessage(source.db, id, `m${id}`, 'user', 0, { text: `old ${id}` });
    source.db.prepare('INSERT INTO event_sequence VALUES (?,?,?)').run(id, 1, 'owner');
  }
  const idx = indexFixture(source.provider);
  const run = () => indexProviderPlan({ db: idx.db,
    plan: createProviderIndexPlan(idx.db, createProviderRegistry([source.provider])),
    runTransaction: (_label, work) => runWriteTransaction(idx.db, work), onError: () => 'skip' });
  try {
    idx.run(); source.db.exec('BEGIN IMMEDIATE');
    source.db.prepare('UPDATE session_message SET data=? WHERE id=?').run('{', 'ma');
    source.db.prepare('UPDATE event_sequence SET seq=seq+1 WHERE aggregate_id=?').run('a'); source.db.exec('COMMIT');
    assert.equal(run().failedItems.length, 1);
    source.db.prepare('UPDATE session_message SET data=? WHERE id=?').run(JSON.stringify({ text: 'new b' }), 'mb');
    assert.equal(run().failedItems.length, 1);
    assert.deepEqual(idx.db.prepare('SELECT text FROM messages ORDER BY text').all().map(r => r.text), ['new b', 'old a']);
    assert.equal(run().failedItems.length, 1, 'failed A still retries after B commits');
  } finally { source.db.close(); idx.close(); }
});

test('pending child and grandchild replays survive destination failure, observation failure and restart', () => {
  const source = upstreamStore('v2.0.32');
  for (const [id, parent] of [['parent', null], ['child', 'parent'], ['grandchild', 'child']]) {
    upstreamSession(source.db, id, 'session_v2', parent); upstreamMessage(source.db, id, `m${id}`, 'user', 0, { text: id });
    source.db.prepare('INSERT INTO event_sequence VALUES (?,?,?)').run(id, 1, 'owner');
  }
  const idx = indexFixture(source.provider);
  const run = (provider, fail = () => false) => indexProviderPlan({ db: idx.db,
    plan: createProviderIndexPlan(idx.db, createProviderRegistry([provider])),
    runTransaction: (_label, work) => runWriteTransaction(idx.db, work),
    onPersisted: item => { if (fail(item.unit)) throw new Error('synthetic destination failure'); }, onError: () => 'skip' });
  try {
    idx.run(); const before = idx.db.prepare("SELECT * FROM index_state WHERE jsonl_path NOT LIKE '__opencode_observation%' ORDER BY jsonl_path").all();
    source.db.exec('BEGIN IMMEDIATE');
    source.db.prepare('UPDATE session_message SET data=? WHERE session_id=?').run(JSON.stringify({ text: 'updated parent' }), 'parent');
    source.db.prepare('UPDATE event_sequence SET seq=seq+1 WHERE aggregate_id=?').run('parent'); source.db.exec('COMMIT');
    const observationFailed = run(source.provider, unit => unit.meta.kind === 'opencode-observation');
    assert.equal(observationFailed.complete, false);
    assert.equal(transcriptItems(observationFailed.committed).length, 0, 'uncommitted schedule cannot permit destructive dependents');
    assert.equal(idx.db.prepare('SELECT count(*) n FROM subagents').get().n, 2);
    assert.deepEqual(idx.db.prepare("SELECT * FROM index_state WHERE jsonl_path NOT LIKE '__opencode_observation%' ORDER BY jsonl_path").all(), before);
    const partial = run(source.provider, unit => unit.meta.rawSessionId === 'child');
    assert.equal(partial.failedItems.length, 1);
    assert.equal(idx.db.prepare('SELECT count(*) n FROM subagents').get().n, 1, 'child link needs retry while grandchild safely commits');
    const restarted = createOpencodeProvider({ rootDir: source.dir, openDatabase: openDb });
    assert.equal(run(restarted).complete, true);
    assert.equal(idx.db.prepare('SELECT count(*) n FROM subagents').get().n, 2);
    assert.equal(run(restarted).committed.length, 0);
  } finally { source.db.close(); idx.close(); }
});

test('missing or unknown observation cursors rebuild pending revisions above successful session revisions', () => {
  for (const missing of [false, true]) {
    const source = upstreamStore('v2.0.32');
    for (const [id, parent] of [['parent', null], ['child', 'parent']]) {
      upstreamSession(source.db, id, 'session_v2', parent); upstreamMessage(source.db, id, `m${id}`, 'user', 0, { text: id });
      source.db.prepare('INSERT INTO event_sequence VALUES (?,?,?)').run(id, 1, 'owner');
    }
    const idx = indexFixture(source.provider);
    const update = text => {
      source.db.exec('BEGIN IMMEDIATE'); source.db.prepare('UPDATE session_message SET data=? WHERE session_id=?').run(JSON.stringify({ text }), 'parent');
      source.db.prepare('UPDATE event_sequence SET seq=seq+1 WHERE aggregate_id=?').run('parent'); source.db.exec('COMMIT');
    };
    const run = failChild => indexProviderPlan({ db: idx.db,
      plan: createProviderIndexPlan(idx.db, createProviderRegistry([source.provider])),
      runTransaction: (_label, work) => runWriteTransaction(idx.db, work),
      onPersisted: item => { if (failChild && item.unit.meta.rawSessionId === 'child') throw new Error('synthetic child failure'); }, onError: () => 'skip' });
    try {
      idx.run(); update('warmup'); idx.run();
      if (missing) idx.db.prepare("DELETE FROM index_state WHERE jsonl_path LIKE '__opencode_observation_v1__:%'").run();
      else idx.db.prepare("UPDATE index_state SET cursor='0:0:future-observation:opaque' WHERE jsonl_path LIKE '__opencode_observation_v1__:%'").run();
      update('next parent'); assert.equal(run(true).failedItems.length, 1);
      assert.equal(idx.db.prepare('SELECT count(*) n FROM subagents').get().n, 0);
      assert.equal(run(false).complete, true);
      assert.equal(idx.db.prepare('SELECT count(*) n FROM subagents').get().n, 1);
      assert.equal(run(false).committed.length, 0);
    } finally { source.db.close(); idx.close(); }
  }
});

test('large replay batches read the pending observation once and use bounded cursor prerequisites per session', () => {
  const source = upstreamStore('v2.0.32');
  const sessions = 1000;
  source.db.exec('BEGIN');
  for (let i = 0; i < sessions; i++) upstreamSession(source.db, `s${i}`, 'session_v2');
  source.db.exec('COMMIT');
  const raw = createMemoryIndex();
  let pendingReads = 0; let controlBytes = 0;
  const db = { exec: sql => raw.exec(sql), close: () => raw.close(), prepare: sql => {
    const stmt = raw.prepare(sql);
    return { all: (...args) => stmt.all(...args), run: (...args) => stmt.run(...args), get: (...args) => {
      const row = stmt.get(...args);
      if (typeof args[0] === 'string' && args[0].startsWith('__opencode_observation') && typeof row?.cursor === 'string') {
        controlBytes += Buffer.byteLength(row.cursor);
        if (args[0].startsWith('__opencode_observation_v1__')) pendingReads++;
      }
      return row;
    } };
  } };
  try {
    const result = indexProviderPlan({ db, plan: createProviderIndexPlan(db, createProviderRegistry([source.provider])),
      runTransaction: (_label, work) => runWriteTransaction(raw, work), onError: error => { throw error; } });
    assert.equal(result.complete, true);
    assert.equal(raw.prepare('SELECT count(*) n FROM sessions').get().n, sessions);
    assert.equal(raw.prepare("SELECT count(*) n FROM sessions WHERE id='' ").get().n, 0, 'control state never becomes canonical history');
    assert.equal(pendingReads, 1, 'full pending list is verified once, not once per session');
    assert.ok(controlBytes < sessions * 512, `bounded control bytes per session: ${controlBytes}`);
  } finally { source.db.close(); db.close(); }
});
