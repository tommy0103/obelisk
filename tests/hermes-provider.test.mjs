// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
} from 'node:fs';
import { join, win32 } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { projectSlugFromPath } from '../packages/core/src/parsing.ts';
import { persist } from '../packages/core/src/persist.ts';
import {
  createProviderIndexPlan,
  indexProviderPlan,
  readProviderSessionProvenance,
  storedProviderCursor,
} from '../packages/core/src/provider-indexing.ts';
import { createHermesProvider, hermesSessionId, pathInside } from '../packages/core/src/providers/hermes.ts';
import { createQueryApi } from '../packages/core/src/query.ts';
import { createProviderRegistry } from '../packages/core/src/providers/registry.ts';
import { assembleSessionDetail } from '../packages/core/src/session-detail.ts';
import { makeTempDir } from './temp-dirs.mjs';

const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');

const openStore = path => new DatabaseSync(path, { readOnly: true });

const SUPPORTED_SCHEMA_VERSION = 30;
const DEFAULT_PROFILE = 'default';
const SESSION_ALPHA = '20260101_120000_aaaaaa';
const SESSION_BETA = '20260102_130000_bbbbbb';
const SESSION_PROFILE = '20260103_140000_cccccc';

function drain(generator) {
  const values = [];
  let step = generator.next();
  while (!step.done) {
    values.push(step.value);
    step = generator.next();
  }
  return { values, cursor: step.value };
}

function discover(provider, { cursors = new Map(), indexed = [], issues = [], changedPaths } = {}) {
  return provider.discover({
    lastCursor: key => cursors.get(key) ?? null,
    indexedSessions: () => indexed,
    reportIncompleteInventory: issue => issues.push(issue),
    ...(changedPaths === undefined ? {} : { changedPaths }),
  });
}

/**
 * A synthetic Hermes store. The table definitions are the ones Hermes ships — columns, types and
 * defaults copied from a real `state.db`, so the fixture rows have the shape the adapter has to
 * cope with: `messages.id` is an INTEGER PRIMARY KEY AUTOINCREMENT (no synthetic text ids) and
 * `codex_message_items` is where a final Responses reply can live. Fixture rows only.
 */
const STORE_DDL = `
  CREATE TABLE schema_version (version INTEGER NOT NULL);
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, user_id TEXT, model TEXT, model_config TEXT,
    system_prompt TEXT, parent_session_id TEXT, started_at REAL NOT NULL, ended_at REAL,
    end_reason TEXT, message_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0,
    input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0,
    cache_write_tokens INTEGER DEFAULT 0, reasoning_tokens INTEGER DEFAULT 0, billing_provider TEXT,
    billing_base_url TEXT, billing_mode TEXT, estimated_cost_usd REAL, actual_cost_usd REAL,
    cost_status TEXT, cost_source TEXT, pricing_version TEXT, title TEXT, api_call_count INTEGER DEFAULT 0,
    handoff_state TEXT, handoff_platform TEXT, handoff_error TEXT, cwd TEXT,
    rewind_count INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, session_key TEXT,
    chat_id TEXT, chat_type TEXT, thread_id TEXT, git_branch TEXT, git_repo_root TEXT,
    compression_failure_cooldown_until REAL, compression_failure_error TEXT, display_name TEXT,
    origin_json TEXT, expiry_finalized INTEGER DEFAULT 0, compression_fallback_streak INTEGER NOT NULL DEFAULT 0,
    profile_name TEXT, system_prompt_hash TEXT, title_source TEXT, last_activity_at REAL,
    last_activity_description TEXT, last_activity_provenance TEXT,
    compression_ineffective_count INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
    last_read_at REAL, git_metadata_generation INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0,
    compression_recovery_deadline REAL, tool_names TEXT,
    FOREIGN KEY (parent_session_id) REFERENCES sessions(id)
  );
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL, content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT,
    timestamp REAL NOT NULL, token_count INTEGER, finish_reason TEXT, reasoning TEXT,
    reasoning_content TEXT, reasoning_details TEXT, codex_reasoning_items TEXT, codex_message_items TEXT,
    platform_message_id TEXT, observed INTEGER DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
    compacted INTEGER NOT NULL DEFAULT 0, effect_disposition TEXT, api_content TEXT, display_kind TEXT,
    display_metadata TEXT, _compressed_summary INTEGER NOT NULL DEFAULT 0
  );
`;

function createStore(home, { profile = null, schemaVersion = SUPPORTED_SCHEMA_VERSION, wal = false } = {}) {
  const dir = profile === null ? home : join(home, 'profiles', profile);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'state.db');
  // The sessions table declares its parent FOREIGN KEY, like the real store, but the host does not
  // enforce it: orphan rows exist there, and the adapter has to cope with them.
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  if (wal) db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  db.exec(STORE_DDL);
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(schemaVersion);
  return { db, path };
}

const insertSession = db => db.prepare(`
  INSERT INTO sessions (id, source, model, title, parent_session_id, started_at, ended_at,
                        end_reason, message_count, tool_call_count, cwd, git_branch, profile_name)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

/**
 * Hermes assigns message ids itself, so the fixture lets SQLite do the same and returns the id it
 * picked — the tests assert against that instead of a synthetic text id.
 */
const insertMessage = db => db.prepare(`
  INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp,
                        reasoning, reasoning_content, active, compacted, display_kind,
                        codex_message_items, _compressed_summary)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function appendMessage(
  db,
  sessionId,
  role,
  {
    content = null,
    toolCallId = null,
    toolCalls = null,
    toolName = null,
    timestamp,
    reasoning = null,
    reasoningContent = null,
    active = 1,
    compacted = 0,
    displayKind = null,
    codexMessageItems = null,
    compressedSummary = 0,
  } = {},
) {
  return Number(
    insertMessage(db).run(
      sessionId, role, content, toolCallId, toolCalls, toolName, timestamp,
      reasoning, reasoningContent, active, compacted, displayKind, codexMessageItems,
      compressedSummary,
    ).lastInsertRowid,
  );
}

/** Open the fixture store for a write, run `write`, and close it again. */
function writeStore(path, write, options = {}) {
  const db = new DatabaseSync(path, options);
  try {
    write(db);
  } finally {
    db.close();
  }
}

/** Rows captured from a real Hermes store; see tests/fixtures/hermes/README.md. */
const CAPTURED_ROWS = JSON.parse(
  readFileSync(new URL('./fixtures/hermes/real-store-rows.json', import.meta.url), 'utf8'),
);

/** Rebuild the captured store, which uses a column subset of the same shipped tables. */
function seedCapturedStore(path) {
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  db.exec(STORE_DDL);
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SUPPORTED_SCHEMA_VERSION);
  for (const row of CAPTURED_ROWS.rows) {
    const columns = row.columns.map(column => `"${column}"`).join(', ');
    const placeholders = row.columns.map(() => '?').join(', ');
    db.prepare(`INSERT INTO ${row.table} (${columns}) VALUES (${placeholders})`).run(...row.values);
  }
  db.close();
}

function seedAlpha(db, cwd) {
  insertSession(db).run(
    SESSION_ALPHA, 'cli', 'deepseek-v4-flash', 'Alpha session', null,
    1767225600, 1767229200, 'cli_close', 6, 1, cwd, 'main', DEFAULT_PROFILE,
  );
  const ids = {};
  ids.user = appendMessage(db, SESSION_ALPHA, 'user', {
    content: 'Search the repository', timestamp: 1767225600,
  });
  ids.assistant = appendMessage(db, SESSION_ALPHA, 'assistant', {
    content: 'Reading the file',
    toolCalls: JSON.stringify([{
      id: 'call-1',
      call_id: 'call-1',
      type: 'function',
      function: { name: 'read_file', arguments: '{"path":"README.md"}' },
    }]),
    reasoningContent: 'Considering the repository layout',
    timestamp: 1767225660,
  });
  ids.tool = appendMessage(db, SESSION_ALPHA, 'tool', {
    content: 'file contents', toolCallId: 'call-1', toolName: 'read_file', timestamp: 1767225720,
  });
  ids.final = appendMessage(db, SESSION_ALPHA, 'assistant', {
    content: 'Here is the summary', timestamp: 1767225780,
  });
  // Superseded by a rewind: upstream attests it with active = 0.
  ids.rewound = appendMessage(db, SESSION_ALPHA, 'assistant', {
    content: 'Discarded draft', active: 0, timestamp: 1767225840,
  });
  // Rolled into a compaction: upstream marks both active = 0 and compacted = 1.
  ids.compacted = appendMessage(db, SESSION_ALPHA, 'assistant', {
    content: 'Compacted turn', active: 0, compacted: 1, timestamp: 1767225900,
  });
  // Display-suppressed by the host itself.
  ids.hidden = appendMessage(db, SESSION_ALPHA, 'assistant', {
    content: 'Runtime notice', displayKind: 'hidden', timestamp: 1767225960,
  });
  return ids;
}

function fixtureHome({ wal = false } = {}) {
  const base = makeTempDir('obelisk-hermes-');
  const alphaCwd = join(base, 'projects', 'alpha');
  const betaCwd = join(base, 'projects', 'beta');
  mkdirSync(alphaCwd, { recursive: true });
  mkdirSync(betaCwd, { recursive: true });

  const primary = createStore(base, { wal });
  const ids = seedAlpha(primary.db, alphaCwd);
  insertSession(primary.db).run(
    SESSION_BETA, 'cli', 'qwen3.5:9b', 'Beta session', null,
    1767312000, 1767315600, 'agent_close', 0, 0, betaCwd, null, DEFAULT_PROFILE,
  );
  primary.db.close();

  const profile = createStore(base, { profile: 'coder' });
  insertSession(profile.db).run(
    SESSION_PROFILE, 'cli', 'deepseek-v4-pro', 'Profile session', null,
    1767398400, 1767402000, 'cli_close', 0, 0, betaCwd, 'feature', 'coder',
  );
  profile.db.close();

  return { base, alphaCwd, betaCwd, primaryPath: primary.path, profilePath: profile.path, ids };
}

/**
 * Sessions of a discovery. A store also reports one gate unit carrying no records — the same
 * `__`-prefixed kind of row the provider markers use. It is not a session.
 */
const sessionUnits = units => units.filter(unit => unit.meta.storeGate !== true);

const indexedFrom = units => sessionUnits(units).map(unit => ({
  sessionId: unit.sessionId,
  // Encoded the way sourcePathFor() encodes it, so the fake is the adapter's own path.
  jsonlPath: `${unit.meta.dbPath}#session:${encodeURIComponent(unit.meta.rawSessionId)}`,
}));

/**
 * Drive the real indexer pipeline against a fixture: plan from the index database, persist every
 * unit's cursor, repeat. A store settles over two rounds — the first writes the session cursors,
 * the second certifies the store gate — so tests that assert what a later round schedules use
 * this rather than a hand-built cursor map.
 */
function indexFixture(provider) {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const registry = createProviderRegistry([provider]);
  const run = (options = {}) => {
    const plan = createProviderIndexPlan(db, registry, options);
    const result = indexProviderPlan({
      db,
      plan,
      runTransaction: (_label, work) => work(),
      onError: (error) => {
        throw error;
      },
    });
    return { plan, result };
  };
  return { db, run, close: () => db.close() };
}

/** The cursors the index database holds, which is what discovery is handed back. */
const storedCursors = db => new Map(
  db.prepare('SELECT jsonl_path, cursor FROM index_state').all()
    .map(row => [String(row.jsonl_path), typeof row.cursor === 'string' ? row.cursor : null]),
);

/** The index's own view of which sessions exist, which is what discovery is handed back. */
const indexedProvenance = db => readProviderSessionProvenance(db)
  .map(({ sessionId, jsonlPath }) => ({ sessionId, jsonlPath }));

/** Session ids a round scheduled, ignoring the store gate units that carry no records. */
const scheduledSessionIds = round => sessionUnits(round.plan.items.map(item => item.unit))
  .map(unit => unit.sessionId);

/** Run rounds until the store settles, bounded so a regression fails instead of hanging. */
function settle(index, limit = 6) {
  for (let round = 0; round < limit; round += 1) {
    const result = index.run();
    if (result.plan.items.length === 0) return result;
  }
  throw new Error('the index never settled');
}

/**
 * ADR-0007: one unit's detail assembled from the provider's own records and from the same records
 * after a SQLite round-trip. Both are built with the seam a consumer uses, so a shape the direct
 * path omits (a summary's token keys, say) shows up as a difference rather than a silent gap.
 */
function roundTripDetail(db, provider, unit) {
  const direct = assembleSessionDetail(drain(provider.parse(unit, null)).values);
  persist(db, unit, provider.parse(unit, null));
  const persisted = assembleSessionDetail({
    session: db.prepare('SELECT * FROM sessions WHERE id = ?').get(unit.sessionId),
    messages: db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp, uuid').all(unit.sessionId),
    // A message's calls are read back in the order the provider emitted them. `tool_calls` carries
    // an index on `(session_id, name)`, so a reader that leaves the order to the planner gets them
    // sorted by tool name instead, and the round trip diverges whenever a message's calls are not
    // already in name order (ADR-0007).
    toolCalls: db.prepare('SELECT * FROM tool_calls WHERE session_id = ? ORDER BY rowid').all(unit.sessionId),
    toolResults: db.prepare('SELECT * FROM tool_results WHERE session_id = ?').all(unit.sessionId),
    summaries: db.prepare('SELECT * FROM summaries WHERE session_id = ?').all(unit.sessionId),
  });
  return { direct, persisted };
}

test('discover() enumerates the default store and every named profile, keyed by profile', () => {
  const layout = fixtureHome();
  try {
    const provider = createHermesProvider({ rootDir: layout.base, openStore });
    const units = discover(provider);

    assert.equal(units.length, 3, 'one unit per session across the default store and the profile store');
    assert.equal(
      sessionUnits(units).length,
      3,
      'the gate unit is only written once a store read scheduled nothing',
    );
    const alpha = units.find(unit => unit.meta.rawSessionId === SESSION_ALPHA);
    const beta = units.find(unit => unit.meta.rawSessionId === SESSION_BETA);
    const profiled = units.find(unit => unit.meta.rawSessionId === SESSION_PROFILE);

    assert.equal(alpha.sessionId, hermesSessionId(SESSION_ALPHA, DEFAULT_PROFILE, layout.primaryPath));
    assert.equal(profiled.sessionId, hermesSessionId(SESSION_PROFILE, 'coder', layout.profilePath));
    assert.notEqual(
      alpha.sessionId,
      hermesSessionId(SESSION_ALPHA, 'coder', layout.primaryPath),
      'the same host id in another profile is a different session',
    );
    assert.equal(alpha.key, `hermes-unit:${alpha.sessionId}`);
    assert.equal(alpha.project, projectSlugFromPath(layout.alphaCwd));
    assert.equal(beta.project, projectSlugFromPath(layout.betaCwd));
    assert.equal(alpha.meta.dbPath, layout.primaryPath);
    assert.equal(profiled.meta.dbPath, layout.profilePath);
    assert.equal(alpha.meta.profile, DEFAULT_PROFILE);
    assert.equal(profiled.meta.profile, 'coder');
    assert.deepEqual(alpha.retractSessionIds, [alpha.sessionId], 'every live unit retracts before writing');
    assert.ok(alpha.meta.currentCursor.startsWith(`${alpha.meta.currentCursor.split(':')[0]}:0:hermes-snapshot-v2:`));
  } finally {
    rmSync(layout.base, { recursive: true, force: true });
  }
});

test(
  'discover() skips unchanged sessions, reports an unsupported schema, and retracts only a complete inventory',
  () => {
  const layout = fixtureHome();
  const index = indexFixture(createHermesProvider({ rootDir: layout.base, openStore }));
  try {
    const provider = createHermesProvider({ rootDir: layout.base, openStore });
    settle(index);
    const cursors = storedCursors(index.db);
    const indexed = indexedProvenance(index.db);

    assert.equal(index.run().plan.items.length, 0, 'an unchanged store produces no work');

    // A session that no longer exists anywhere is retracted, but only from a complete inventory.
    const missingId = hermesSessionId('20251231_000000_ffffff', DEFAULT_PROFILE, layout.primaryPath);
    const tombstones = discover(provider, {
      cursors,
      indexed: [
        ...indexed,
        { sessionId: missingId, jsonlPath: `${layout.primaryPath}#session:20251231_000000_ffffff` },
      ],
    }).filter(unit => unit.meta.tombstone === true);
    assert.equal(tombstones.length, 1);
    assert.equal(tombstones[0].sessionId, missingId);
    assert.equal(tombstones[0].meta.tombstone, true);
    assert.deepEqual(tombstones[0].retractSessionIds, [missingId]);
    assert.equal(drain(provider.parse(tombstones[0], null)).cursor, null, 'a tombstone advances no cursor');

    // An unreadable inventory (a newer schema) skips and records, and never mass-retracts.
    const newer = createStore(layout.base, { profile: 'future', schemaVersion: SUPPORTED_SCHEMA_VERSION + 5 });
    newer.db.close();
    const issues = [];
    const blocked = discover(provider, {
      cursors,
      issues,
      indexed: [
        ...indexed,
        { sessionId: missingId, jsonlPath: `${layout.primaryPath}#session:20251231_000000_ffffff` },
        {
          sessionId: hermesSessionId('20260104_150000_dddddd', 'future', newer.path),
          jsonlPath: `${newer.path}#session:20260104_150000_dddddd`,
        },
      ],
    });
    assert.equal(issues.length, 1);
    assert.match(issues[0].error, /Unsupported Hermes schema version 35/);
    assert.equal(
      blocked.some(unit => unit.sessionId === missingId),
      false,
      'an incomplete inventory proves no deletion',
    );
  } finally {
    index.close();
    rmSync(layout.base, { recursive: true, force: true });
  }
});

// A canonical-format change bumps the marker, so a database whose cursors still look current has to
// be replayed. The previous marker is a literal rather than the exported constant, which is what
// keeps this proving the bump for an index written before the fix.
test('an index written under the previous canonical marker is replayed after the marker bump', () => {
  const layout = fixtureHome();
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, jsonl_path TEXT, source TEXT);
    CREATE TABLE index_state (jsonl_path TEXT PRIMARY KEY, mtime INTEGER, lines_processed INTEGER, cursor TEXT);
  `);
  try {
    const provider = createHermesProvider({ rootDir: layout.base, openStore });
    const registry = createProviderRegistry([provider]);
    const unit = discover(provider).find(candidate => candidate.meta.rawSessionId === SESSION_ALPHA);
    db.prepare('INSERT INTO sessions (id, jsonl_path, source) VALUES (?, ?, ?)')
      .run(unit.sessionId, `${layout.primaryPath}#session:${SESSION_ALPHA}`, 'hermes');
    const writeMarker = db.prepare(
      'INSERT INTO index_state (jsonl_path, mtime, lines_processed, cursor) VALUES (?, 0, 0, ?)',
    );
    writeMarker.run('__hermes_canonical_transcript_v6__', '0:0:hermes-snapshot-v2:stale');

    const stale = createProviderIndexPlan(db, registry);
    assert.equal(stale.pendingMarkers.get('hermes'), '__hermes_canonical_transcript_v7__');
    assert.deepEqual(stale.replayKeys.get('hermes'), [unit.key], 'the previously indexed unit replays');
    assert.equal(
      stale.items.find(item => item.unit.key === unit.key).cursor,
      null,
      'a replay re-reads the whole unit instead of trusting its stored cursor',
    );

    // Once the current marker is present the index has converged: no marker, no replay.
    writeMarker.run('__hermes_canonical_transcript_v7__', '0:0:hermes-snapshot-v2:current');
    const settled = createProviderIndexPlan(db, registry);
    assert.equal(settled.pendingMarkers.get('hermes'), undefined);
    assert.equal(settled.replayKeys.get('hermes'), undefined);
  } finally {
    db.close();
    rmSync(layout.base, { recursive: true, force: true });
  }
});

test('parse() projects Hermes messages, thinking, tool calls and results into the canonical transcript', () => {
  const layout = fixtureHome();
  try {
    const provider = createHermesProvider({ rootDir: layout.base, openStore });
    const unit = discover(provider).find(candidate => candidate.meta.rawSessionId === SESSION_ALPHA);
    const { values, cursor } = drain(provider.parse(unit, null));

    const byKind = kind => values.filter(record => record.kind === kind);
    const messages = byKind('message');
    const calls = byKind('tool_call');
    const results = byKind('tool_result');
    const [session] = byKind('session');

    assert.equal(calls.length, 1);
    assert.equal(results.length, 1);
    assert.equal(calls[0].id, `${unit.sessionId}:tool:call-1`);
    assert.equal(calls[0].name, 'read_file');
    assert.equal(calls[0].input_json, '{"path":"README.md"}');
    assert.equal(results[0].tool_use_id, calls[0].id, 'call and result pair on the same canonical id');
    assert.equal(results[0].content, 'file contents');

    const thinking = messages.find(message => message.content_type === 'thinking');
    assert.equal(thinking.text, 'Considering the repository layout');
    assert.equal(thinking.uuid, `${unit.sessionId}:thinking:${layout.ids.assistant}`);

    const assistant = messages.find(message => message.uuid === `${unit.sessionId}:message:${layout.ids.assistant}`);
    assert.equal(assistant.text, 'Reading the file');
    assert.equal(assistant.role, 'assistant');
    assert.equal(assistant.model, 'deepseek-v4-flash');
    assert.equal(assistant.cwd, layout.alphaCwd);
    assert.equal(assistant.parent_uuid, thinking.uuid, 'records form one chain per session');
    assert.equal(calls[0].message_uuid, assistant.uuid, 'the call belongs to the message that requested it');
    assert.equal(results[0].message_uuid, assistant.uuid);
    assert.equal(messages.find(message => message.role === 'user').parent_uuid, null);

    assert.equal(session.id, unit.sessionId);
    assert.equal(session.title, 'Alpha session');
    assert.equal(session.git_branch, 'main');
    assert.equal(session.version, `hermes-v${SUPPORTED_SCHEMA_VERSION}`);
    assert.equal(session.countMode, 'total');
    assert.equal(session.jsonl_path, `${layout.primaryPath}#session:${SESSION_ALPHA}`);
    assert.equal(session.started_at, new Date(1767225600 * 1000).toISOString());
    assert.equal(session.ended_at, new Date(1767225960 * 1000).toISOString());
    assert.equal(session.message_count, 3, 'only visible non-thinking messages count');
    // Discovery cannot know the digest of rows it did not read, so parse() completes the cursor
    // it was handed with the exact digest it computed while streaming those rows. Everything the
    // next discovery compares — the store gate and the session fingerprint — comes from discovery.
    assert.equal(
      cursor.split(':').slice(0, 5).join(':'),
      unit.meta.currentCursor,
      'parse() extends the cursor discovery computed',
    );
    assert.equal(cursor.split(':').length, 6, 'and persists the exact digest as its last field');
    assert.match(cursor.split(':')[5], /^[0-9a-f]{64}$/);
  } finally {
    rmSync(layout.base, { recursive: true, force: true });
  }
});

test('parse() marks superseded and hidden rows instead of dropping them', () => {
  const layout = fixtureHome();
  try {
    const provider = createHermesProvider({ rootDir: layout.base, openStore });
    const unit = discover(provider).find(candidate => candidate.meta.rawSessionId === SESSION_ALPHA);
    const messages = drain(provider.parse(unit, null)).values.filter(record => record.kind === 'message');
    const visibility = rawId => messages
      .filter(message => message.uuid.split(':').pop() === String(rawId))
      .filter(message => message.content_type !== 'thinking');

    assert.deepEqual(visibility(layout.ids.rewound).map(message => message.visibility), ['inactive']);
    assert.deepEqual(visibility(layout.ids.compacted).map(message => message.visibility), ['inactive']);
    assert.deepEqual(visibility(layout.ids.hidden).map(message => message.visibility), ['hidden']);
    assert.deepEqual(visibility(layout.ids.final).map(message => message.visibility), ['visible']);
    assert.equal(messages.length, 7, 'rewound, compacted and hidden rows stay in the transcript as records');
  } finally {
    rmSync(layout.base, { recursive: true, force: true });
  }
});

// #198 P2-4: a record with no text is not a text record. Hermes writes rows whose only content is
// a call, and rows with neither, so the canonical type has to say which it is instead of claiming
// text that is not there.
test('a textless row is tool_use when it carries calls and unknown when it does not', () => {
  const layout = fixtureHome();
  try {
    let callless = 0;
    let caller = 0;
    writeStore(layout.primaryPath, db => {
      callless = appendMessage(db, SESSION_ALPHA, 'assistant', { content: null, timestamp: 1767226100 });
      caller = appendMessage(db, SESSION_ALPHA, 'assistant', {
        content: null,
        toolCalls: JSON.stringify([{
          id: 'call-empty',
          call_id: 'call-empty',
          type: 'function',
          function: { name: 'read_file', arguments: '{}' },
        }]),
        timestamp: 1767226160,
      });
    });
    const provider = createHermesProvider({ rootDir: layout.base, openStore });
    const unit = discover(provider).find(candidate => candidate.meta.rawSessionId === SESSION_ALPHA);
    const messages = drain(provider.parse(unit, null)).values
      .filter(record => record.kind === 'message' && record.content_type !== 'thinking');
    // A thinking row shares the raw id with the reply it precedes, so the content type is what
    // tells them apart.
    const typed = rawId => messages
      .filter(message => message.uuid.split(':').pop() === String(rawId))
      .map(message => [message.text, message.content_type]);

    assert.deepEqual(typed(callless), [[null, 'unknown']], 'no text and no calls');
    assert.deepEqual(typed(caller), [[null, 'tool_use']], 'no text, but a call to name');
    assert.deepEqual(typed(layout.ids.user), [['Search the repository', 'text']]);
    assert.deepEqual(typed(layout.ids.assistant), [['Reading the file', 'text']]);
  } finally {
    rmSync(layout.base, { recursive: true, force: true });
  }
});

test('parse() refuses a store that changed after discovery', () => {
  const layout = fixtureHome();
  try {
    const provider = createHermesProvider({ rootDir: layout.base, openStore });
    const unit = discover(provider).find(candidate => candidate.meta.rawSessionId === SESSION_ALPHA);
    const altered = { ...unit, meta: { ...unit.meta, fingerprint: 'stale' } };

    assert.throws(
      () => drain(provider.parse(altered, null)),
      /Hermes session changed after discovery/,
    );
  } finally {
    rmSync(layout.base, { recursive: true, force: true });
  }
});

// Regression: Hermes stores messages.id as an INTEGER PRIMARY KEY, and a string-only reader used
// to resolve none of these lookups.
test('raw() returns the exact Hermes row as evidence, and null when it cannot be resolved', () => {
  const layout = fixtureHome();
  try {
    const provider = createHermesProvider({ rootDir: layout.base, openStore });
    const unit = discover(provider).find(candidate => candidate.meta.rawSessionId === SESSION_ALPHA);
    const session = { jsonl_path: `${layout.primaryPath}#session:${SESSION_ALPHA}` };

    const message = provider.raw({
      source: 'hermes',
      messageUuid: `${unit.sessionId}:message:${layout.ids.assistant}`,
      session,
      agentId: null,
    });
    assert.ok(message, 'a message with an INTEGER primary key resolves');
    assert.match(message.text, new RegExp(`"id":\\s*${layout.ids.assistant}\\b`));
    assert.match(message.text, /read_file/);

    const thinking = provider.raw({
      source: 'hermes',
      messageUuid: `${unit.sessionId}:thinking:${layout.ids.assistant}`,
      session,
      agentId: null,
    });
    assert.ok(thinking, 'a thinking record resolves through the row that carries it');

    const tool = provider.raw({
      source: 'hermes',
      messageUuid: `${unit.sessionId}:tool:call-1`,
      session,
      agentId: null,
    });
    assert.ok(tool, 'a tool call resolves through its containing row');
    assert.match(tool.text, new RegExp(`"id":\\s*${layout.ids.assistant}\\b`));

    assert.equal(provider.raw({
      source: 'hermes',
      messageUuid: `${unit.sessionId}:message:999999`,
      session,
      agentId: null,
    }), null);
    assert.equal(provider.raw({
      source: 'hermes',
      messageUuid: `${unit.sessionId}:message:${layout.ids.assistant}`,
      session: { jsonl_path: join(layout.base, 'gone.db') },
      agentId: null,
    }), null, 'an unreadable store is evidence-less, never an exception');
  } finally {
    rmSync(layout.base, { recursive: true, force: true });
  }
});

test('raw() finds an indexed tool call after malformed or non-object tool_calls', () => {
  const layout = fixtureHome();
  writeStore(layout.primaryPath, db => {
    const insert = db.prepare(`
      INSERT INTO messages (id, session_id, role, tool_calls, timestamp)
      VALUES (?, ?, 'assistant', ?, ?)
    `);
    insert.run(-2, SESSION_ALPHA, '{"entry":{"call_id":"call-1"}}', 1767225499);
    insert.run(-1, SESSION_ALPHA, '{broken', 1767225500);
    insert.run(0, SESSION_ALPHA, '["not-an-object"]', 1767225501);
  });
  const provider = createHermesProvider({ rootDir: layout.base, openStore });
  const index = indexFixture(provider);
  try {
    settle(index);
    const sessionId = hermesSessionId(SESSION_ALPHA, DEFAULT_PROFILE, layout.primaryPath);
    const toolId = `${sessionId}:tool:call-1`;
    assert.ok(
      index.db.prepare('SELECT id FROM tool_calls WHERE id = ?').get(toolId),
      'normal projection skips malformed entries and indexes the later valid call',
    );

    const raw = provider.raw({
      source: 'hermes',
      messageUuid: toolId,
      session: { jsonl_path: `${layout.primaryPath}#session:${SESSION_ALPHA}` },
      agentId: null,
    });
    assert.ok(raw, 'the same valid call remains available through raw lookup');
    assert.match(raw.text, /read_file/);
  } finally {
    index.close();
    rmSync(layout.base, { recursive: true, force: true });
  }
});

test('raw() resolves an indexed Hermes store when its configured home contains #', () => {
  const layout = fixtureHome();
  const home = `${layout.base}#custom`;
  renameSync(layout.base, home);
  const dbPath = join(home, 'state.db');
  const provider = createHermesProvider({ rootDir: home, openStore });
  const index = indexFixture(provider);
  try {
    settle(index);
    const sessionId = hermesSessionId(SESSION_ALPHA, DEFAULT_PROFILE, dbPath);
    const uuid = `${sessionId}:message:${layout.ids.assistant}`;
    const api = createQueryApi(index.db, { providerRegistry: createProviderRegistry([provider]) });
    const raw = api.raw(uuid);
    assert.ok(raw, 'the indexed message retains its raw source');
    assert.match(raw.text, /Reading the file/);
    assert.equal(provider.raw({
      source: 'hermes', messageUuid: uuid,
      session: { jsonl_path: `${dbPath}#session:${SESSION_ALPHA}` }, agentId: null,
    })?.messageText, 'Reading the file', 'the App can expand its full text');
  } finally {
    index.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a long Hermes message remains available through raw() windows and full-text expansion', () => {
  const layout = fixtureHome();
  const longText = `${'complete response '.repeat(800)}END`;
  writeStore(layout.primaryPath, db => {
    db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(longText, layout.ids.assistant);
  });
  const provider = createHermesProvider({ rootDir: layout.base, openStore });
  const index = indexFixture(provider);
  try {
    settle(index);
    const sessionId = hermesSessionId(SESSION_ALPHA, DEFAULT_PROFILE, layout.primaryPath);
    const uuid = `${sessionId}:message:${layout.ids.assistant}`;
    const raw = provider.raw({
      source: 'hermes', messageUuid: uuid,
      session: { jsonl_path: `${layout.primaryPath}#session:${SESSION_ALPHA}` }, agentId: null,
    });
    assert.equal(raw.messageText, longText, 'the App receives the full source message');
    assert.ok(raw.text.length > 10000);
    assert.equal(raw.totalLength, raw.text.length);

    const api = createQueryApi(index.db, { providerRegistry: createProviderRegistry([provider]) });
    const first = api.raw(uuid, { offset: 0, limit: 10000 });
    const second = api.raw(uuid, { offset: 10000, limit: 10000 });
    assert.equal(first.text + second.text, raw.text, 'CLI windows reach the entire raw row');
    assert.equal(first.hasMore, true);
    assert.equal(second.hasMore, false);
  } finally {
    index.close();
    rmSync(layout.base, { recursive: true, force: true });
  }
});

test('persist() writes a Hermes session and a changed store replays it instead of duplicating rows', () => {
  const layout = fixtureHome();
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  try {
    const provider = createHermesProvider({ rootDir: layout.base, openStore });
    const all = discover(provider);
    const unit = all.find(candidate => candidate.meta.rawSessionId === SESSION_ALPHA);
    const firstParse = drain(provider.parse(unit, null));
    const cursor = persist(db, unit, provider.parse(unit, null));

    assert.equal(
      db.prepare('SELECT count(*) count FROM sessions WHERE source = ?').get('hermes').count, 1,
    );
    assert.equal(
      db.prepare("SELECT count(*) count FROM messages WHERE text = 'Reading the file'").get().count, 1,
    );
    assert.equal(
      db.prepare('SELECT count(*) count FROM tool_calls WHERE id = ?').get(`${unit.sessionId}:tool:call-1`).count, 1,
    );
    assert.equal(
      db.prepare('SELECT visibility FROM messages WHERE uuid = ?')
        .get(`${unit.sessionId}:message:${layout.ids.rewound}`).visibility,
      'inactive',
    );
    assert.equal(
      db.prepare('SELECT cursor FROM index_state WHERE jsonl_path = ?').get(unit.key).cursor, cursor,
    );
    assert.equal(firstParse.cursor, cursor);

    const cursors = new Map(all.map(candidate => [candidate.key, candidate.meta.currentCursor]));
    const indexed = indexedFrom(all);
    const idle = discover(provider, { cursors, indexed });
    assert.deepEqual(sessionUnits(idle), [], 'nothing to do while the store is unchanged');
    assert.equal(
      idle.every(unit => unit.meta.storeGate === true),
      true,
      'the only unit left is the store gate the cold pass could not write yet',
    );

    // A new message in the same session makes it a new snapshot, which retracts and rewrites it.
    const store = new DatabaseSync(layout.primaryPath);
    try {
      appendMessage(store, SESSION_ALPHA, 'assistant', { content: 'Follow-up answer', timestamp: 1767226020 });
    } finally {
      store.close();
    }

    const changed = discover(provider, { cursors, indexed })
      .find(candidate => candidate.sessionId === unit.sessionId);
    assert.ok(changed, 'a grown session needs reindexing');
    assert.deepEqual(changed.retractSessionIds, [unit.sessionId]);
    assert.notEqual(changed.meta.currentCursor, cursor, 'the snapshot cursor moves with the content');
    persist(db, changed, provider.parse(changed, cursor));
    assert.equal(
      db.prepare("SELECT count(*) count FROM messages WHERE text = 'Follow-up answer'").get().count, 1,
    );
    assert.equal(
      db.prepare('SELECT count(*) count FROM sessions WHERE source = ?').get('hermes').count, 1,
      'the retraction keeps one session row, not two',
    );
    assert.equal(
      db.prepare("SELECT count(*) count FROM messages WHERE text = 'Reading the file'").get().count, 1,
      'unchanged rows survive the replay',
    );
  } finally {
    db.close();
    rmSync(layout.base, { recursive: true, force: true });
  }
});

// Owner's third review: a write to `profiles/<name>/state.db` is a `.db` file under the tree
// target, and the caller's transcript filter drops those, so the store only became a hint at the
// next full reconcile. Each existing profile store is now named exactly, like the default store.
test('watchTargets() names the default store and declares profile database files on the tree', () => {
  const layout = fixtureHome({ wal: true });
  const profilesDir = join(layout.base, 'profiles');
  try {
    const provider = createHermesProvider({ rootDir: layout.base, openStore });
    assert.deepEqual(provider.watchTargets(layout.base), [
      { kind: 'file', path: join(layout.base, 'state.db') },
      { kind: 'file', path: join(layout.base, 'state.db-wal') },
      { kind: 'tree', path: profilesDir, fileNames: ['state.db', 'state.db-wal'] },
    ]);
    assert.deepEqual(provider.watchTargets('').map(target => target.path), [
      join(layout.base, 'state.db'),
      join(layout.base, 'state.db-wal'),
      profilesDir,
    ], 'an empty configured root falls back to the descriptor default');
    assert.equal(provider.descriptor.requiresExplicitRoot, undefined);
  } finally {
    rmSync(layout.base, { recursive: true, force: true });
  }
});

test('watchTargets() stays stable as profiles appear and never names the shared-memory sidecar', () => {
  const home = makeTempDir('obelisk-hermes-targets-');
  const profilesDir = join(home, 'profiles');
  try {
    const provider = createHermesProvider({ rootDir: home, openStore });
    assert.deepEqual(provider.watchTargets(home), [
      { kind: 'file', path: join(home, 'state.db') },
      { kind: 'file', path: join(home, 'state.db-wal') },
      { kind: 'tree', path: profilesDir, fileNames: ['state.db', 'state.db-wal'] },
    ], 'a home without a profiles directory still reports the default store and the tree');

    // Discovery enumerates profiles off the main thread; watch targets stay stable.
    for (const name of ['zeta', 'alpha']) mkdirSync(join(profilesDir, name), { recursive: true });
    assert.deepEqual(provider.watchTargets(home), [
      { kind: 'file', path: join(home, 'state.db') },
      { kind: 'file', path: join(home, 'state.db-wal') },
      { kind: 'tree', path: profilesDir, fileNames: ['state.db', 'state.db-wal'] },
    ]);

    // SQLite rewrites the shared-memory sidecar on every read, so it would only ever report
    // events that carry no new rows.
    assert.equal(
      provider.watchTargets(home).some(target => target.path.endsWith('-shm')),
      false,
      'the shared-memory sidecar is never a target',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('watchTargets() does not need to read an inaccessible profiles directory', (t) => {
  const layout = fixtureHome();
  const profilesDir = join(layout.base, 'profiles');
  try {
    const provider = createHermesProvider({ rootDir: layout.base, openStore });
    chmodSync(profilesDir, 0o000);
    if (!throwsWhen(() => readdirSync(profilesDir))) {
      t.skip('chmod does not restrict this user, so the unreadable case cannot be staged');
      return;
    }
    assert.deepEqual(provider.watchTargets(layout.base), [
      { kind: 'file', path: join(layout.base, 'state.db') },
      { kind: 'file', path: join(layout.base, 'state.db-wal') },
      { kind: 'tree', path: profilesDir, fileNames: ['state.db', 'state.db-wal'] },
    ], 'an unreadable profiles directory still has the same watch target');
  } finally {
    chmodSync(profilesDir, 0o700);
    rmSync(layout.base, { recursive: true, force: true });
  }
});

/** True when this user really cannot read the path, so a chmod-staged failure can be skipped. */
function throwsWhen(read) {
  try {
    read();
    return false;
  } catch {
    return true;
  }
}

// Regression: an unreadable profiles directory used to look like "these sessions were deleted",
// which retracted profile sessions from a source that was merely unreachable.
test('an unreadable profiles directory reports an incomplete inventory instead of retracting sessions', (t) => {
  const layout = fixtureHome();
  try {
    const provider = createHermesProvider({ rootDir: layout.base, openStore });
    const first = discover(provider);
    const cursors = new Map(first.map(unit => [unit.key, unit.meta.currentCursor]));
    const indexed = indexedFrom(first);
    assert.equal(first.length, 3, 'the fixture starts with every session reachable');

    const profilesDir = join(layout.base, 'profiles');
    chmodSync(profilesDir, 0o000);
    if (!throwsWhen(() => readdirSync(profilesDir))) {
      t.skip('chmod does not restrict this user, so the unreadable case cannot be staged');
      return;
    }

    const issues = [];
    const blocked = discover(provider, { cursors, indexed, issues });
    assert.equal(
      blocked.filter(unit => unit.meta.tombstone === true).length,
      0,
      'an unreachable source is not evidence that its sessions were deleted',
    );
    assert.ok(issues.length >= 1, 'the incomplete inventory is reported');
    assert.equal(issues[0].path, profilesDir);

    chmodSync(profilesDir, 0o755);
    const recovered = discover(provider, { cursors, indexed });
    assert.equal(
      recovered.filter(unit => unit.meta.tombstone === true).length,
      0,
      'the sessions are live again once the directory is readable',
    );
  } finally {
    try {
      chmodSync(join(layout.base, 'profiles'), 0o755);
    } catch {
      /* the temporary home is removed below regardless */
    }
    rmSync(layout.base, { recursive: true, force: true });
  }
});

// Regression: a profile entry that stat() cannot describe (a directory without the execute bit, an
// unmounted share) was silently skipped, which looked like a deletion.
test('an unreadable profile entry reports an incomplete inventory instead of retracting sessions', (t) => {
  const layout = fixtureHome();
  try {
    const provider = createHermesProvider({ rootDir: layout.base, openStore });
    const first = discover(provider);
    const cursors = new Map(first.map(unit => [unit.key, unit.meta.currentCursor]));
    const indexed = indexedFrom(first);

    const profilesDir = join(layout.base, 'profiles');
    chmodSync(profilesDir, 0o444);
    if (!throwsWhen(() => statSync(join(profilesDir, 'coder')))) {
      t.skip('chmod does not restrict this user, so the unreadable entry cannot be staged');
      return;
    }

    const issues = [];
    const blocked = discover(provider, { cursors, indexed, issues });
    assert.equal(
      blocked.filter(unit => unit.meta.tombstone === true).length,
      0,
      'an entry that cannot be described is not evidence of a deletion',
    );
    assert.ok(issues.length >= 1, 'the incomplete inventory is reported');
    assert.equal(
      issues.some(issue => issue.path === join(profilesDir, 'coder')),
      true,
      'the unreadable entry is named',
    );

    chmodSync(profilesDir, 0o755);
    assert.equal(
      discover(provider).some(unit => unit.meta.rawSessionId === SESSION_PROFILE),
      true,
      'the profile session is enumerable again once the entry is readable',
    );
    const recovered = discover(provider, { cursors, indexed });
    assert.equal(
      recovered.filter(unit => unit.meta.tombstone === true).length,
      0,
      'nothing is retracted once the entry is readable again',
    );
  } finally {
    try {
      chmodSync(join(layout.base, 'profiles'), 0o755);
    } catch {
      /* the temporary home is removed below regardless */
    }
    rmSync(layout.base, { recursive: true, force: true });
  }
});

// The Windows branch of the containment check cannot be reached on this host through
// process.platform (node:path picks its implementation at load), so the check takes its path
// operations as an argument and these tests hand it win32's.
const win32PathOps = {
  caseInsensitive: true,
  normalize: win32.normalize,
  relative: win32.relative,
  isAbsolute: win32.isAbsolute,
};

// Regression: containment compared against a literal "/", so on Windows an indexed
// `C:\...\state.db#session:...` was not recognized as being inside its home.
test('pathInside() recognizes an indexed store under a Windows Hermes home', () => {
  const home = 'C:\\Users\\dev\\AppData\\Local\\hermes';
  const store = `${home}\\state.db`;

  assert.equal(pathInside(home, store, win32PathOps), true, 'the default store');
  assert.equal(
    pathInside(home, `${store}#session:20260101_120000_aaaaaa`, win32PathOps),
    true,
    'an indexed session source path',
  );
  assert.equal(
    pathInside(home, `${home}\\profiles\\coder\\state.db#session:x`, win32PathOps),
    true,
    'a named profile store',
  );
  assert.equal(
    pathInside(home, 'c:\\users\\dev\\appdata\\local\\hermes\\state.db', win32PathOps),
    true,
    'case-insensitively, like the platform',
  );
  assert.equal(pathInside(home, home, win32PathOps), true, 'the home itself');

  assert.equal(
    pathInside(home, 'C:\\Users\\dev\\AppData\\Local\\hermes-other\\state.db', win32PathOps),
    false,
    'a sibling whose name merely starts with the home is not inside it',
  );
  assert.equal(pathInside(home, 'C:\\Users\\dev\\other\\state.db#session:x', win32PathOps), false);
});

test('pathInside() keeps its POSIX result for the native path operations', () => {
  const home = '/home/dev/.hermes';
  assert.equal(pathInside(home, `${home}/state.db#session:x`), true);
  assert.equal(pathInside(home, `${home}-other/state.db`), false);
});

// Regression: a home that is no longer there used to be treated as "all of its sessions were
// deleted" whenever the containment check missed the indexed source paths (which it did on Windows,
// where the check compared a literal "/" against C:\...\state.db#session:...).
test('an indexed home that is unavailable reports an incomplete inventory instead of retracting sessions', () => {
  const layout = fixtureHome();
  const moved = `${layout.base}-moved`;
  try {
    const provider = createHermesProvider({ rootDir: layout.base, openStore });
    const first = discover(provider);
    const cursors = new Map(first.map(unit => [unit.key, unit.meta.currentCursor]));
    const indexed = indexedFrom(first);
    assert.equal(first.length, 3);
    assert.equal(indexed.every(session => session.jsonlPath.startsWith(layout.base)), true);

    renameSync(layout.base, moved);
    const issues = [];
    const blocked = discover(provider, { cursors, indexed, issues });
    assert.equal(
      blocked.filter(unit => unit.meta.tombstone === true).length,
      0,
      'an unreachable home is not evidence that its sessions were deleted',
    );
    assert.ok(issues.length >= 1, 'the incomplete inventory is reported');
    assert.equal(issues[0].path, layout.base);
  } finally {
    try {
      renameSync(moved, layout.base);
    } catch {
      /* already back, or never moved */
    }
    rmSync(layout.base, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
  }
});

test('parse() projects a final Responses reply that Hermes stored only in codex_message_items', () => {
  const base = makeTempDir('obelisk-hermes-codex-items-');
  try {
    const store = createStore(base);
    const sessionId = '20260301_090000_codex';
    insertSession(store.db).run(sessionId, 'cli', 'gpt-5.1-codex', 'Codex session', null,
      1772000000, 1772000600, 'cli_close', 2, 0, '/tmp/proj', null, DEFAULT_PROFILE);
    // The documented shape: a Responses message item whose parts carry the text. Only assistant
    // `message` items with `output_text` / `text` parts project, which is what upstream replays.
    const withItems = appendMessage(store.db, sessionId, 'assistant', {
      timestamp: 1772000100,
      codexMessageItems: JSON.stringify([
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'not a reply' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'not a reply' }] },
        {
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'output_text', text: 'Final answer from items' },
            { type: 'input_text', text: 'not a reply' },
            { type: 'text', text: 'and a second part' },
          ],
        },
      ]),
    });
    const empty = appendMessage(store.db, sessionId, 'assistant', {
      timestamp: 1772000200,
      codexMessageItems: JSON.stringify([{ type: 'message', role: 'assistant', content: [] }]),
    });
    store.db.close();

    const provider = createHermesProvider({ rootDir: base, openStore });
    const unit = discover(provider).find(candidate => candidate.meta.rawSessionId === sessionId);
    const messages = drain(provider.parse(unit, null)).values.filter(record => record.kind === 'message');

    const projected = messages.find(message => message.uuid === `${unit.sessionId}:message:${withItems}`);
    assert.equal(projected.text, 'Final answer from items\nand a second part');
    assert.equal(projected.content_type, 'text');
    assert.equal(projected.role, 'assistant');
    assert.equal(
      messages.find(message => message.uuid === `${unit.sessionId}:message:${empty}`).text,
      null,
      'nothing projectable still yields a textless row',
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('tool calls pair on call_id when Hermes mints one that differs from the response item id', () => {
  const base = makeTempDir('obelisk-hermes-call-id-');
  try {
    const store = createStore(base);
    const sessionId = '20260302_090000_codexcall';
    insertSession(store.db).run(sessionId, 'cli', 'gpt-5.1-codex', 'Caller session', null,
      1772080000, 1772080600, 'cli_close', 2, 1, '/tmp/proj', null, DEFAULT_PROFILE);
    const assistant = appendMessage(store.db, sessionId, 'assistant', {
      timestamp: 1772080100,
      toolCalls: JSON.stringify([{
        id: 'fc_item_1',
        call_id: 'call_abc123',
        type: 'function',
        function: { name: 'shell', arguments: '{"cmd":"ls"}' },
      }]),
    });
    appendMessage(store.db, sessionId, 'tool', {
      content: 'a.txt', toolCallId: 'call_abc123', toolName: 'shell', timestamp: 1772080200,
    });
    store.db.close();

    const provider = createHermesProvider({ rootDir: base, openStore });
    const unit = discover(provider).find(candidate => candidate.meta.rawSessionId === sessionId);
    const records = drain(provider.parse(unit, null)).values;
    const call = records.find(record => record.kind === 'tool_call');
    const result = records.find(record => record.kind === 'tool_result');

    assert.equal(call.id, `${unit.sessionId}:tool:call_abc123`, 'the call_id, not the response item id');
    assert.equal(call.message_uuid, `${unit.sessionId}:message:${assistant}`);
    assert.equal(result.tool_use_id, call.id, 'the result pairs with the call the host referenced');

    const raw = provider.raw({
      source: 'hermes',
      messageUuid: call.id,
      session: { jsonl_path: `${join(base, 'state.db')}#session:${sessionId}` },
      agentId: null,
    });
    assert.ok(raw, 'raw() resolves a tool call by call_id');
    assert.match(raw.text, /call_abc123/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('an in-place edit of an existing row moves the cursor, and an idle store does not', () => {
  const layout = fixtureHome();
  const index = indexFixture(createHermesProvider({ rootDir: layout.base, openStore }));
  try {
    const alphaId = hermesSessionId(SESSION_ALPHA, DEFAULT_PROFILE, layout.primaryPath);
    const alphaKey = `hermes-unit:${alphaId}`;
    // Pin the store's mtime to a whole second before taking the baseline, so the same value can be
    // restored exactly after the edit. A cursor that watched mtime alone would then see no change.
    const pinned = new Date(1767225600000);
    utimesSync(layout.primaryPath, pinned, pinned);
    settle(index);
    const before = storedProviderCursor(index.db, alphaKey);

    // Rewrite a row that already exists: same row count, same maxima, same message id, and a
    // same-length replacement. The watermark aggregates cannot see it and neither can the file
    // mtime, so the store gate has to notice the ctime and the exact digest has to name the
    // session — which is why this stays one scheduled unit and not a whole-store replay.
    const store = new DatabaseSync(layout.primaryPath);
    try {
      store.prepare('UPDATE messages SET content = ? WHERE id = ?')
        .run('Xeading the file', layout.ids.assistant);
    } finally {
      store.close();
    }
    utimesSync(layout.primaryPath, pinned, pinned);

    const round = index.run();
    assert.deepEqual(scheduledSessionIds(round), [alphaId], 'an in-place edit is not skipped');
    assert.notEqual(storedProviderCursor(index.db, alphaKey), before, 'the cursor moves with the row');
    assert.equal(
      index.db.prepare('SELECT text FROM messages WHERE uuid = ?')
        .get(`${alphaId}:message:${layout.ids.assistant}`).text,
      'Xeading the file',
      'the re-parse carries the edited text',
    );

    settle(index);
    assert.equal(index.run().plan.items.length, 0, 'the next pass is idle again');
  } finally {
    index.close();
    rmSync(layout.base, { recursive: true, force: true });
  }
});

test('a reasoning rewrite with delimiter characters still changes the exact digest', () => {
  const layout = fixtureHome();
  writeStore(layout.primaryPath, db => {
    db.prepare('UPDATE messages SET reasoning = ?, reasoning_content = ? WHERE id = ?')
      .run('a\u0001b', 'c', layout.ids.assistant);
  });
  const provider = createHermesProvider({ rootDir: layout.base, openStore });
  const index = indexFixture(provider);
  try {
    const alphaId = hermesSessionId(SESSION_ALPHA, DEFAULT_PROFILE, layout.primaryPath);
    const thinkingUuid = `${alphaId}:thinking:${layout.ids.assistant}`;
    const baselineMtime = new Date(1767225600000);
    utimesSync(layout.primaryPath, baselineMtime, baselineMtime);
    settle(index);
    assert.equal(index.db.prepare('SELECT text FROM messages WHERE uuid = ?').get(thinkingUuid).text, 'c');

    // Both states have the same watermark and the old delimiter encoding produced identical
    // digest bytes: "a\u0001b\u0001c". The changed mtime forces an exact digest comparison.
    writeStore(layout.primaryPath, db => {
      db.prepare('UPDATE messages SET reasoning = ?, reasoning_content = ? WHERE id = ?')
        .run('a', 'b\u0001c', layout.ids.assistant);
    });
    const changedMtime = new Date(1767225601000);
    utimesSync(layout.primaryPath, changedMtime, changedMtime);

    const round = index.run();
    assert.deepEqual(scheduledSessionIds(round), [alphaId], 'the changed session is reindexed');
    assert.equal(
      index.db.prepare('SELECT text FROM messages WHERE uuid = ?').get(thinkingUuid).text,
      'b\u0001c',
      'the index holds the new projected thinking text',
    );
  } finally {
    index.close();
    rmSync(layout.base, { recursive: true, force: true });
  }
});

test('a child session token-only update refreshes its indexed subagent total', () => {
  const layout = fixtureHome();
  writeStore(layout.primaryPath, db => {
    db.prepare(`UPDATE sessions SET source = 'subagent', parent_session_id = ?,
      input_tokens = 1, output_tokens = 2 WHERE id = ?`).run(SESSION_ALPHA, SESSION_BETA);
  });
  const provider = createHermesProvider({ rootDir: layout.base, openStore });
  const index = indexFixture(provider);
  try {
    const childId = hermesSessionId(SESSION_BETA, DEFAULT_PROFILE, layout.primaryPath);
    settle(index);
    const total = () => index.db.prepare('SELECT total_tokens FROM subagents WHERE agent_id = ?').get(childId)?.total_tokens;
    assert.equal(total(), 3);

    writeStore(layout.primaryPath, db => {
      db.prepare('UPDATE sessions SET input_tokens = 10, output_tokens = 20 WHERE id = ?').run(SESSION_BETA);
    });
    const changed = index.run();
    assert.deepEqual(scheduledSessionIds(changed), [childId], 'only the child needs a replay');
    assert.equal(total(), 30, 'the persisted subagent usage follows the session columns');
    settle(index);
    assert.equal(index.run().plan.items.length, 0);
  } finally {
    index.close();
    rmSync(layout.base, { recursive: true, force: true });
  }
});

test('a schema version-only update refreshes the indexed session version', () => {
  const layout = fixtureHome();
  const provider = createHermesProvider({ rootDir: layout.base, openStore });
  const index = indexFixture(provider);
  try {
    const sessionId = hermesSessionId(SESSION_ALPHA, DEFAULT_PROFILE, layout.primaryPath);
    settle(index);
    writeStore(layout.primaryPath, db => {
      db.prepare('UPDATE schema_version SET version = 29').run();
    });
    const changed = index.run();
    assert.ok(scheduledSessionIds(changed).includes(sessionId));
    assert.equal(index.db.prepare('SELECT version FROM sessions WHERE id = ?').get(sessionId).version, 'hermes-v29');
  } finally {
    index.close();
    rmSync(layout.base, { recursive: true, force: true });
  }
});

// ADR-0007: canonical assembly from the provider's own records must equal assembly from what the
// same records look like after a SQLite round-trip.
test('direct canonical assembly equals SQLite round-trip assembly', () => {
  const layout = fixtureHome();
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  try {
    const provider = createHermesProvider({ rootDir: layout.base, openStore });
    const unit = discover(provider).find(candidate => candidate.meta.rawSessionId === SESSION_ALPHA);
    const { direct, persisted } = roundTripDetail(db, provider, unit);
    assert.equal(direct.summaries.length, 0, 'this fixture session carries no summary');
    assert.deepEqual(persisted, direct);
  } finally {
    db.close();
    rmSync(layout.base, { recursive: true, force: true });
  }
});

// ADR-0007 is about the store as much as about the assembly: the record has to survive being
// written and read back. A cut at the truncation limit used to land between the halves of a
// surrogate pair, and no UTF-8 store can keep a lone half (SQLite rewrites it as U+FFFD), so
// exactly the rows long enough to be cut failed the round trip.
test('a row cut at the truncation limit still round-trips', () => {
  const layout = fixtureHome();
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  try {
    // The limit is 10000 code units, so the boundary lands on the high half of the emoji.
    writeStore(layout.primaryPath, store => {
      appendMessage(store, SESSION_ALPHA, 'user', {
        content: `${'a'.repeat(9999)}😀`,
        timestamp: 1767226200,
      });
    });
    const provider = createHermesProvider({ rootDir: layout.base, openStore });
    const unit = discover(provider).find(candidate => candidate.meta.rawSessionId === SESSION_ALPHA);
    const { direct, persisted } = roundTripDetail(db, provider, unit);
    // The cut steps back over the pair rather than leaving half of it in the record.
    assert.equal(direct.messages.at(-1).text.length, 9999);
    assert.deepEqual(persisted, direct);
  } finally {
    db.close();
    rmSync(layout.base, { recursive: true, force: true });
  }
});

// ADR-0007 for the rows a real store writes. `session-detail.ts` materializes a summary's
// `input_tokens`/`output_tokens` (as null) on the persisted row path, so a session that carries a
// compaction handoff failed the round trip while a session without one passed: the same gap Nox
// reproduced on the real store at 20260528_160922_74c5d3 and 20260914_160026_63b914.
test('direct canonical assembly equals SQLite round-trip assembly for sessions with compaction summaries', () => {
  const base = makeTempDir('obelisk-hermes-summaries-');
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  try {
    const path = join(base, 'state.db');
    seedCapturedStore(path);
    const provider = createHermesProvider({ rootDir: base, openStore });
    const summarised = [];
    for (const unit of sessionUnits(discover(provider))) {
      const records = drain(provider.parse(unit, null)).values;
      const summaries = records.filter(record => record.kind === 'summary');
      if (summaries.length > 0) {
        // A handoff is only visible in the snapshot when its row is active; the capture holds a
        // session whose handoffs are both (20260914_160026_63b914) and one that is visible.
        assert.ok(
          summaries.some(record => record.visibility === 'visible'),
          `${unit.meta.rawSessionId} has a summary the detail view reaches`,
        );
        summarised.push(unit.meta.rawSessionId);
      }
      const { direct, persisted } = roundTripDetail(db, provider, unit);
      assert.deepEqual(persisted, direct, `${unit.meta.rawSessionId} round-trips`);
    }
    assert.ok(
      summarised.length >= 2,
      'the capture holds the sessions with compaction handoffs the round trip has to cover',
    );
  } finally {
    db.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('parse() records a delegated session as a subagent link without suppressing it', () => {
  const base = makeTempDir('obelisk-hermes-subagent-');
  try {
    const parentId = '20260201_090000_parent';
    const splitId = '20260201_100000_split';
    const childId = '20260201_110000_child';
    const store = createStore(base);
    insertSession(store.db).run(parentId, 'cli', 'model-a', 'Parent session', null,
      1769926800, 1769930400, 'cli_close', 2, 0, '/tmp/proj', 'main', DEFAULT_PROFILE);
    // A compression-triggered split also carries a parent, but it is not delegated work.
    insertSession(store.db).run(splitId, 'cli', 'model-a', 'Split session', parentId,
      1769927400, 1769930400, 'cli_close', 1, 0, '/tmp/proj', 'main', DEFAULT_PROFILE);
    insertSession(store.db).run(childId, 'subagent', 'model-b', 'Delegated audit', parentId,
      1769927700, 1769930100, 'cli_close', 2, 0, '/tmp/proj', 'main', DEFAULT_PROFILE);
    appendMessage(store.db, childId, 'user', { content: 'audit this', timestamp: 1769927700 });
    appendMessage(store.db, childId, 'assistant', { content: 'audited', timestamp: 1769930050 });
    // A parent that is not in this store cannot be named exactly, so nothing is linked.
    insertSession(store.db).run('20260201_120000_orphan', 'subagent', 'model-b', 'Orphan child', 'missing-parent',
      1769928000, 1769930000, 'cli_close', 1, 0, '/tmp/proj', 'main', DEFAULT_PROFILE);
    // A clock that regresses between the first and last message yields no duration.
    insertSession(store.db).run('20260201_130000_regress', 'subagent', 'model-b', 'Regressing child', parentId,
      1769929000, 1769931000, 'cli_close', 2, 0, '/tmp/proj', 'main', DEFAULT_PROFILE);
    appendMessage(store.db, '20260201_130000_regress', 'user', { content: 'first', timestamp: 1769929500 });
    appendMessage(store.db, '20260201_130000_regress', 'assistant', { content: 'backwards', timestamp: 1769928900 });
    // The cache and reasoning columns are populated too, because Hermes keeps them apart from the
    // prompt/completion counters: only input + output are an accounting of the session.
    store.db.prepare(`
      UPDATE sessions SET input_tokens = 900, output_tokens = 100, cache_read_tokens = 5000,
                          cache_write_tokens = 4000, reasoning_tokens = 300 WHERE id = ?
    `).run(childId);
    store.db.close();

    const provider = createHermesProvider({ rootDir: base, openStore });
    const units = discover(provider);
    const records = id => drain(provider.parse(
      units.find(unit => unit.meta.rawSessionId === id), '0:0:x',
    )).values;

    const childRecords = records(childId);
    const link = childRecords.find(record => record.kind === 'subagent');
    assert.ok(link, 'a delegated session records its lineage');
    assert.equal(link.agent_id, hermesSessionId(childId, DEFAULT_PROFILE, join(base, 'state.db')));
    assert.equal(link.session_id, hermesSessionId(parentId, DEFAULT_PROFILE, join(base, 'state.db')));
    assert.equal(link.parent_tool_use_id, null, 'upstream does not record the spawning call id');
    assert.equal(link.agent_type, 'subagent');
    assert.equal(link.description, 'Delegated audit');
    assert.equal(link.duration_ms, (1769930050 - 1769927700) * 1000, 'bounded by the first and last message');
    assert.equal(
      link.total_tokens,
      1000,
      'session-level tokens are input + output, with the cache and reasoning columns left out',
    );
    assert.equal(
      childRecords.filter(record => record.kind === 'message').every(record => record.is_sidechain === 0),
      true,
      'the child stays a first-class session rather than a suppressed sidechain',
    );
    assert.equal(records(splitId).some(record => record.kind === 'subagent'), false,
      'a compression-triggered split is not a subagent');
    assert.equal(records(parentId).some(record => record.kind === 'subagent'), false);
    assert.equal(
      records('20260201_120000_orphan').some(record => record.kind === 'subagent'),
      false,
      'a parent outside this store is not linked with a fabricated id',
    );
    assert.equal(
      records('20260201_130000_regress').find(record => record.kind === 'subagent').duration_ms,
      null,
      'a regressing clock yields no duration',
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// Regression: a session's profile is `profile_name` when the row declares one and the store's
// own profile otherwise, so two rows of one store can resolve differently. The parent link has to
// name the parent the way discovery names it; resolving it against the child's profile instead
// pointed the link at a session id that does not exist.
test('a subagent link names its parent by the parent row, not by the child profile', () => {
  const base = makeTempDir('obelisk-hermes-parent-');
  try {
    const parentId = '20260301_090000_parent';
    const childId = '20260301_100000_child';
    const store = createStore(base, { profile: 'coder' });
    // The parent row declares nothing, so it takes the store's profile; the child declares one.
    store.db.prepare(`
      INSERT INTO sessions (id, source, model, title, parent_session_id, started_at, ended_at,
                            end_reason, message_count, tool_call_count, cwd, git_branch, profile_name)
      VALUES (?, 'cli', 'model-a', 'Parent session', NULL, 1770000000, 1770003600, 'cli_close', 1, 0,
              '/tmp/proj', 'main', NULL)
    `).run(parentId);
    insertSession(store.db).run(childId, 'subagent', 'model-b', 'Delegated audit', parentId,
      1770000600, 1770001800, 'cli_close', 1, 0, '/tmp/proj', 'main', DEFAULT_PROFILE);
    appendMessage(store.db, childId, 'assistant', { content: 'audited', timestamp: 1770001800 });
    store.db.close();

    const provider = createHermesProvider({ rootDir: base, openStore });
    const units = discover(provider);
    const parentUnit = units.find(unit => unit.meta.rawSessionId === parentId);
    const childUnit = units.find(unit => unit.meta.rawSessionId === childId);
    assert.equal(
      parentUnit.meta.sessionId,
      hermesSessionId(parentId, 'coder', join(base, 'profiles', 'coder', 'state.db')),
      'the parent resolves to the store profile',
    );
    const childRecords = drain(provider.parse(childUnit, '0:0:x')).values;
    const link = childRecords.find(record => record.kind === 'subagent');
    assert.ok(link, 'the delegated child records its lineage');
    assert.equal(
      link.session_id,
      parentUnit.meta.sessionId,
      'and the link names the parent the way discovery does',
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// #198, ZCode's parent-liveness P1: a child's own row does not move when its parent is deleted or
// restored, so a child skipped on its cursor alone never replays the link its parent's return
// should rebuild. The parent pair enters the child's fingerprint instead, and both transitions run
// through the real persist path rather than asserting on hand-written products.
test('deleting a parent session drops the subagent link and restoring it rebuilds the link', () => {
  const base = makeTempDir('obelisk-hermes-parent-liveness-');
  const parentId = '20260401_090000_parent';
  const childId = '20260401_100000_child';
  const store = createStore(base);
  insertSession(store.db).run(
    parentId, 'cli', 'model-a', 'Parent session', null,
    1775000000, 1775003600, 'cli_close', 0, 0, '/tmp/proj', 'main', DEFAULT_PROFILE,
  );
  insertSession(store.db).run(
    childId, 'subagent', 'model-b', 'Delegated audit', parentId,
    1775000600, 1775001800, 'cli_close', 1, 0, '/tmp/proj', 'main', DEFAULT_PROFILE,
  );
  appendMessage(store.db, childId, 'assistant', { content: 'audited', timestamp: 1775001800 });
  store.db.close();

  const index = indexFixture(createHermesProvider({ rootDir: base, openStore }));
  const childSessionId = hermesSessionId(childId, DEFAULT_PROFILE, join(base, 'state.db'));
  const links = () => index.db.prepare('SELECT agent_id, session_id FROM subagents').all();
  const holdsChild = () => index.db
    .prepare('SELECT id FROM sessions WHERE id = ?').get(childSessionId) !== undefined;
  try {
    settle(index);
    assert.deepEqual(links().map(row => String(row.agent_id)), [childSessionId]);

    writeStore(join(base, 'state.db'), db => {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(parentId);
    }, { enableForeignKeyConstraints: false });
    settle(index);
    assert.deepEqual(links(), [], 'the link goes with the parent it names');
    assert.equal(holdsChild(), true, 'while the child itself is still indexed');

    writeStore(join(base, 'state.db'), db => {
      insertSession(db).run(
        parentId, 'cli', 'model-a', 'Parent session', null,
        1775000000, 1775003600, 'cli_close', 0, 0, '/tmp/proj', 'main', DEFAULT_PROFILE,
      );
    }, { enableForeignKeyConstraints: false });
    settle(index, 4);
    assert.deepEqual(links().map(row => String(row.agent_id)), [childSessionId],
      'restoring the parent replays the child and rebuilds the link');
  } finally {
    index.close();
    rmSync(base, { recursive: true, force: true });
  }
});

// #198 P1-2: a delegated child is a first-class session rather than a suppressed sidechain, so its
// detail carries its own messages — straight from the provider and from the rows a consumer reads
// back. An empty detail would be the same defect the reviewer raised against ZCode.
test("a delegated child's detail carries its messages directly and after a round trip", () => {
  const base = makeTempDir('obelisk-hermes-child-detail-');
  const parentId = '20260402_090000_parent';
  const childId = '20260402_100000_child';
  const store = createStore(base);
  insertSession(store.db).run(
    parentId, 'cli', 'model-a', 'Parent session', null,
    1775100000, 1775103600, 'cli_close', 1, 0, '/tmp/proj', 'main', DEFAULT_PROFILE,
  );
  insertSession(store.db).run(
    childId, 'subagent', 'model-b', 'Delegated audit', parentId,
    1775100600, 1775101800, 'cli_close', 2, 0, '/tmp/proj', 'main', DEFAULT_PROFILE,
  );
  appendMessage(store.db, childId, 'user', { content: 'audit this', timestamp: 1775100600 });
  appendMessage(store.db, childId, 'assistant', { content: 'audited', timestamp: 1775101800 });
  store.db.close();

  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  try {
    const provider = createHermesProvider({ rootDir: base, openStore });
    const unit = discover(provider).find(candidate => candidate.meta.rawSessionId === childId);
    const { direct, persisted } = roundTripDetail(db, provider, unit);
    assert.deepEqual(direct.messages.map(message => message.text), ['audit this', 'audited']);
    assert.deepEqual(persisted, direct, 'and the persisted rows carry the same detail');
  } finally {
    db.close();
    rmSync(base, { recursive: true, force: true });
  }
});

// Regression (owner's second review): every session cursor embedded the whole store's signature,
// so one write to any session invalidated every other session in the store and replayed the
// database. Changing one session has to leave the rest of the store's units unscheduled.
test('a write to one session leaves the other sessions of the store unscheduled', () => {
  const layout = fixtureHome();
  const index = indexFixture(createHermesProvider({ rootDir: layout.base, openStore }));
  try {
    settle(index);
    const alphaId = hermesSessionId(SESSION_ALPHA, DEFAULT_PROFILE, layout.primaryPath);
    const betaKey = `hermes-unit:${hermesSessionId(SESSION_BETA, DEFAULT_PROFILE, layout.primaryPath)}`;
    const betaCursor = storedProviderCursor(index.db, betaKey);
    assert.ok(betaCursor, 'the settled store holds a cursor for the untouched session');

    writeStore(layout.primaryPath, db => {
      appendMessage(db, SESSION_ALPHA, 'assistant', { content: 'One more line', timestamp: 1767226020 });
    });

    const round = index.run();
    assert.equal(round.plan.items.length, 1, 'one appended row is one unit, not the whole store');
    assert.deepEqual(scheduledSessionIds(round), [alphaId], 'only the session that changed is scheduled');
    assert.equal(round.result.committed.length, 1);
    assert.equal(
      storedProviderCursor(index.db, betaKey),
      betaCursor,
      "the untouched session's cursor is not consumed by another session's write",
    );

    settle(index);
    assert.equal(index.run().plan.items.length, 0, 'and the store is idle again afterwards');
  } finally {
    index.close();
    rmSync(layout.base, { recursive: true, force: true });
  }
});

// Regression: the exact-digest fallback used to run only in a round that scheduled nothing else,
// so a session rewritten in place with a same-length value stayed stale for as long as any other
// session kept being written. The aggregates cannot attribute such a rewrite, so the digest pass
// has to run on the same scan that already has work.
test('a same-length in-place rewrite is scheduled beside another session of the store', () => {
  const layout = fixtureHome();
  const index = indexFixture(createHermesProvider({ rootDir: layout.base, openStore }));
  try {
    settle(index);
    const alphaId = hermesSessionId(SESSION_ALPHA, DEFAULT_PROFILE, layout.primaryPath);
    const betaId = hermesSessionId(SESSION_BETA, DEFAULT_PROFILE, layout.primaryPath);
    writeStore(layout.primaryPath, db => {
      appendMessage(db, SESSION_BETA, 'assistant', { content: 'Beta baseline row', timestamp: 1767312060 });
    });
    settle(index);

    // One commit: an appended row in Alpha, and a same-length rewrite of Beta's first row, which
    // moves no watermark aggregate and is only visible to the exact digest.
    writeStore(layout.primaryPath, db => {
      appendMessage(db, SESSION_ALPHA, 'assistant', { content: 'Appended once', timestamp: 1767226020 });
      const row = db.prepare('SELECT id, content FROM messages WHERE session_id = ? ORDER BY rowid LIMIT 1')
        .get(SESSION_BETA);
      // A one-character edit keeps every watermark aggregate identical.
      db.prepare('UPDATE messages SET content = ? WHERE id = ?')
        .run(row.content.replace(/^./, char => (char === 'Z' ? 'Y' : 'Z')), row.id);
    });

    const round = index.run();
    assert.deepEqual(
      scheduledSessionIds(round).sort(),
      [alphaId, betaId].sort(),
      'the appended session and the rewritten one are both scheduled',
    );
  } finally {
    index.close();
    rmSync(layout.base, { recursive: true, force: true });
  }
});

// Regression: the digest pass is the only second read a scan makes of a store, and it used to run
// in a try/finally with no catch. A transient failure there threw out of discover() — aborting the
// whole provider scan instead of reporting an unreadable store — and, once caught, still left the
// store looking certified at a gate whose sessions were never examined. It is an incomplete
// inventory instead: nothing scheduled, nothing retracted, gate row withheld, pass retried.
test('a failed exact-digest read reports an incomplete inventory and does not certify the store', () => {
  const layout = fixtureHome();
  let opens = 0;
  let failDigestRead = false;
  const provider = createHermesProvider({
    rootDir: layout.base,
    openStore: path => {
      opens += 1;
      // The first open of a store is the session read; the second is the digest pass.
      if (failDigestRead && opens > 1) throw new Error('simulated EACCES on the digest read');
      return openStore(path);
    },
  });
  const index = indexFixture(provider);
  try {
    settle(index);
    // A write the projection ignores: it moves the store gate without moving any session
    // watermark, so a candidate exists and only the digest pass can settle it.
    writeStore(layout.primaryPath, db => {
      db.prepare('UPDATE messages SET api_content = ? WHERE session_id = ?')
        .run('[response interrupted]', SESSION_ALPHA);
    });

    opens = 0;
    failDigestRead = true;
    const round = index.run();
    assert.equal(round.plan.items.length, 0, 'a failed pass schedules nothing, not even a gate row');
    assert.ok(
      round.plan.inventoryIssues.some(issue => issue.error.includes('simulated EACCES')),
      'the failure is reported as an incomplete inventory instead of throwing out of discover()',
    );

    failDigestRead = false;
    opens = 0;
    const retry = index.run();
    assert.equal(opens, 2, 'the store was not certified, so the next scan reads it again');
    assert.equal(scheduledSessionIds(retry).length, 0, 'and the pass finds the rows unchanged');
    assert.equal(index.run().plan.items.length, 0, 'then the store certifies and goes idle');
  } finally {
    index.close();
    rmSync(layout.base, { recursive: true, force: true });
  }
});

// Regression: a session is skipped on its cursor alone, and that cursor outlives the retraction
// caused by its store disappearing. A store that goes away and comes back reserves the same id and
// the same rows, so the fingerprint and the digest still match and the session is never written
// again — the index holds a store it no longer knows about.
test('a session whose store disappeared and came back is indexed again', () => {
  const layout = fixtureHome();
  const index = indexFixture(createHermesProvider({ rootDir: layout.base, openStore }));
  const profileDir = join(layout.base, 'profiles', 'coder');
  const profileId = hermesSessionId(SESSION_PROFILE, 'coder', layout.profilePath);
  const holdsProfileSession = () => index.db
    .prepare('SELECT id FROM sessions WHERE id = ?').get(profileId) !== undefined;
  try {
    settle(index);
    assert.ok(holdsProfileSession(), 'the profile session is indexed to start');

    renameSync(profileDir, `${profileDir}.away`);
    settle(index);
    assert.equal(holdsProfileSession(), false, 'the store going away retracts its session');

    renameSync(`${profileDir}.away`, profileDir);
    settle(index);
    assert.ok(holdsProfileSession(), 'and the session is indexed again when the store comes back');
  } finally {
    index.close();
    rmSync(layout.base, { recursive: true, force: true });
  }
});

// Issue #196: a missing store is an incomplete inventory, even after repeated scans. Hermes may
// quarantine and replace `state.db`; elapsed scans cannot prove its sessions were deleted.
test('a missing store reports incomplete inventory and never retracts indexed sessions', () => {
  const layout = fixtureHome();
  const index = indexFixture(createHermesProvider({ rootDir: layout.base, openStore }));
  const alphaId = hermesSessionId(SESSION_ALPHA, DEFAULT_PROFILE, layout.primaryPath);
  const holdsAlpha = () => index.db
    .prepare('SELECT id FROM sessions WHERE id = ?').get(alphaId) !== undefined;
  try {
    settle(index);
    assert.ok(holdsAlpha(), 'the session is indexed to start');
    const before = index.db.prepare('SELECT id FROM sessions WHERE source = ? ORDER BY id')
      .all('hermes').map(row => String(row.id));

    rmSync(layout.primaryPath, { force: true });
    for (let scan = 0; scan < 3; scan += 1) {
      const round = index.run();
      assert.ok(holdsAlpha(), `scan ${scan + 1} keeps the last indexed session`);
      assert.equal(scheduledSessionIds(round).length, 0, 'unreadable evidence schedules no session');
      assert.ok(
        round.plan.inventoryIssues.some(issue => issue.path === layout.primaryPath),
        'the missing store is reported as an incomplete inventory',
      );
      assert.equal(
        round.plan.items.some(item => item.unit.meta.tombstone === true),
        false,
        'no provider session is retracted',
      );
    }
    assert.deepEqual(
      index.db.prepare('SELECT id FROM sessions WHERE source = ? ORDER BY id')
        .all('hermes').map(row => String(row.id)),
      before,
      'the indexed snapshot stays available while the store is missing',
    );
    assert.ok(
      index.db.prepare('SELECT uuid FROM messages WHERE session_id = ? LIMIT 1').get(alphaId),
      'previously indexed message text is still available',
    );
  } finally {
    index.close();
    rmSync(layout.base, { recursive: true, force: true });
  }
});

// A store path is part of session identity. When the old profile directory remains but its
// state.db moves elsewhere, the old inventory is incomplete; preserving its last snapshot can
// temporarily display both identities. Removing the old directory is the explicit retraction.
test('a profile store moved while its old directory remains keeps the old snapshot', () => {
  const layout = fixtureHome();
  const index = indexFixture(createHermesProvider({ rootDir: layout.base, openStore }));
  const otherDir = join(layout.base, 'profiles', 'other');
  const otherPath = join(otherDir, 'state.db');
  const oldId = hermesSessionId(SESSION_PROFILE, 'coder', layout.profilePath);
  // The row declares `profile_name = coder`, which names the session over the directory it moved
  // into; the store it now lives in still scopes the id.
  const newId = hermesSessionId(SESSION_PROFILE, 'coder', otherPath);
  const hermesIds = () => index.db
    .prepare('SELECT id FROM sessions WHERE source = ? ORDER BY id').all('hermes')
    .map(row => String(row.id));
  try {
    settle(index);
    assert.equal(hermesIds().includes(oldId), true, 'the session is indexed under its old store');

    mkdirSync(otherDir, { recursive: true });
    renameSync(layout.profilePath, otherPath);

    const missing = index.run();
    assert.ok(
      missing.plan.inventoryIssues.some(issue => issue.path === layout.profilePath),
      'the old path is reported as an incomplete inventory',
    );
    settle(index, 8);
    assert.equal(hermesIds().includes(oldId), true, 'the old indexed identity is preserved');
    assert.equal(hermesIds().includes(newId), true, 'the new identity is indexed');
    assert.equal(hermesIds().length, 4, 'the two path-scoped identities can coexist');

    rmSync(join(layout.base, 'profiles', 'coder'), { recursive: true, force: true });
    settle(index, 8);
    assert.equal(hermesIds().includes(oldId), false, 'removing the old profile retracts its identity');
    assert.equal(hermesIds().length, 3, 'the remaining store has one profile session');
    assert.equal(index.run().plan.items.length, 0, 'the index settles after the profile removal');
  } finally {
    index.close();
    rmSync(layout.base, { recursive: true, force: true });
  }
});

// Once the store can be read again its complete inventory is authoritative: sessions actually
// removed from the restored image can now be retracted, while the remaining session stays live.
test('a restored store reconciles a deleted session after missing scans kept the old index', () => {
  const layout = fixtureHome();
  const away = `${layout.primaryPath}.away`;
  const index = indexFixture(createHermesProvider({ rootDir: layout.base, openStore }));
  const alphaId = hermesSessionId(SESSION_ALPHA, DEFAULT_PROFILE, layout.primaryPath);
  const betaId = hermesSessionId(SESSION_BETA, DEFAULT_PROFILE, layout.primaryPath);
  const holdsAlpha = () => index.db
    .prepare('SELECT id FROM sessions WHERE id = ?').get(alphaId) !== undefined;
  try {
    settle(index);

    renameSync(layout.primaryPath, away);
    index.run();
    index.run();
    assert.ok(holdsAlpha(), 'repeated missing scans preserve the last indexed snapshot');

    writeStore(away, db => {
      db.prepare('DELETE FROM messages WHERE session_id = ?').run(SESSION_ALPHA);
      db.prepare('DELETE FROM sessions WHERE id = ?').run(SESSION_ALPHA);
    });
    renameSync(away, layout.primaryPath);
    settle(index, 8);

    assert.equal(holdsAlpha(), false, 'the restored store proves the session was deleted');
    assert.ok(index.db.prepare('SELECT id FROM sessions WHERE id = ?').get(betaId));
    assert.equal(index.run().plan.items.length, 0, 'the restored inventory settles');
  } finally {
    rmSync(away, { recursive: true, force: true });
    index.close();
    rmSync(layout.base, { recursive: true, force: true });
  }
});

// Blocker ③'s other half: a store that is present but cannot be described (EACCES on the way in)
// is an incomplete inventory, never a deletion. `existsSync` folds that error into "absent", which
// is the trap this path exists to avoid: read as missing, it would fall through to the tombstone
// loop and retract the store's sessions, so this asserts both scans of the state.
test('a store that cannot be described reports an incomplete inventory instead of retracting', (t) => {
  const layout = fixtureHome();
  const provider = createHermesProvider({ rootDir: layout.base, openStore });
  const profileDir = join(layout.base, 'profiles', 'coder');
  try {
    const first = discover(provider);
    const cursors = new Map(first.map(unit => [unit.key, unit.meta.currentCursor]));
    const indexed = indexedFrom(first);

    // The profile's own mode is what denies `stat()` the store inside it: the entry is still
    // listed, so discovery reaches it, and a store that is merely unreadable must not be read as
    // gone.
    chmodSync(profileDir, 0o000);
    try {
      if (!throwsWhen(() => statSync(layout.profilePath))) {
        t.skip('this platform does not deny the store to the calling user');
        return;
      }
      const issues = [];
      const blocked = discover(provider, { cursors, indexed, issues });
      assert.equal(
        issues.some(issue => issue.path === layout.profilePath),
        true,
        'the store is named as an incomplete inventory',
      );
      assert.deepEqual(
        blocked.filter(unit => unit.meta.tombstone === true).map(unit => unit.sessionId),
        [],
        'and its sessions are not retracted',
      );
    } finally {
      chmodSync(profileDir, 0o755);
    }
  } finally {
    rmSync(layout.base, { recursive: true, force: true });
  }
});

// The store gate unit is the only unit whose sessionId is empty — it carries a `__`-prefixed
// index_state pseudo key, not a session. The query layer reads sessions and messages by id, so it
// has to see the fixture's sessions and nothing else: no ghost row, no throw.
test('the store gate unit leaves no ghost session in the query layer', () => {
  const layout = fixtureHome();
  const index = indexFixture(createHermesProvider({ rootDir: layout.base, openStore }));
  try {
    settle(index);
    assert.ok(
      index.db.prepare("SELECT jsonl_path FROM index_state WHERE jsonl_path LIKE '\\_\\_%' ESCAPE '\\'").get(),
      'the gate row is persisted under its pseudo key',
    );
    const api = createQueryApi(index.db);
    const expected = [
      hermesSessionId(SESSION_ALPHA, DEFAULT_PROFILE, layout.primaryPath),
      hermesSessionId(SESSION_BETA, DEFAULT_PROFILE, layout.primaryPath),
      hermesSessionId(SESSION_PROFILE, 'coder', layout.profilePath),
    ].sort();
    const sessions = api.sessions({ limit: 50 });
    assert.deepEqual(sessions.map(row => row.id).sort(), expected, 'only real sessions are listed');
    assert.equal(
      sessions.some(row => String(row.id ?? '').length === 0),
      false,
      "no session carries the gate unit's empty id",
    );
    assert.deepEqual(
      api.sessions({ source: 'hermes', limit: 50 }).map(row => row.id).sort(),
      expected,
      'the provider filter agrees',
    );
    const hits = api.search('Search the repository');
    assert.ok(hits.length > 0, 'the fixture text is searchable');
    assert.equal(
      hits.every(hit => expected.includes(hit.session.id)),
      true,
      'every hit belongs to a real session',
    );
    assert.equal(typeof api.overview({ limit: 5 }), 'object', 'overview() answers without throwing');
  } finally {
    index.close();
    rmSync(layout.base, { recursive: true, force: true });
  }
});

// The property the per-session cursor scheme owes: a sequence of writes that exercises every
// branch of the invalidation logic has to land exactly the records a from-scratch build of the
// final store produces, rather than a set that only looks the same.
test('an incrementally updated index matches a from-scratch build of the same store', () => {
  const layout = fixtureHome();
  const incremental = indexFixture(createHermesProvider({ rootDir: layout.base, openStore }));
  const rebuild = indexFixture(createHermesProvider({ rootDir: layout.base, openStore }));
  try {
    settle(incremental);
    // A new session's first row, then an appended row plus a same-length rewrite (visible only to
    // the exact digest), then a write to a column the projection ignores plus a rewind, then a
    // deletion that has to retract.
    writeStore(layout.primaryPath, db => {
      appendMessage(db, SESSION_BETA, 'assistant', { content: 'Beta first row', timestamp: 1767312060 });
    });
    settle(incremental);
    writeStore(layout.primaryPath, db => {
      appendMessage(db, SESSION_ALPHA, 'assistant', { content: 'Appended later', timestamp: 1767226020 });
      const row = db.prepare('SELECT id, content FROM messages WHERE session_id = ? ORDER BY rowid LIMIT 1')
        .get(SESSION_BETA);
      db.prepare('UPDATE messages SET content = ? WHERE id = ?')
        .run(row.content.replace(/^./, char => (char === 'Z' ? 'Y' : 'Z')), row.id);
    });
    settle(incremental);
    writeStore(layout.primaryPath, db => {
      db.prepare(
        "UPDATE messages SET api_content = 'ignored by the projection' WHERE id = (SELECT MIN(id) FROM messages)",
      ).run();
      db.prepare('UPDATE messages SET active = 0 WHERE session_id = ?').run(SESSION_ALPHA);
    });
    settle(incremental);
    writeStore(layout.primaryPath, db => {
      db.prepare('DELETE FROM messages WHERE session_id = ?').run(SESSION_BETA);
      db.prepare('DELETE FROM sessions WHERE id = ?').run(SESSION_BETA);
    });
    settle(incremental);
    settle(rebuild);

    assert.equal(
      incremental.db.prepare('SELECT COUNT(*) n FROM sessions').get().n,
      2,
      'the incrementally built index retracted the deleted session',
    );
    const rows = (db, sql) => db.prepare(sql).all();
    for (const sql of [
      'SELECT * FROM sessions ORDER BY id',
      'SELECT * FROM messages ORDER BY uuid',
      'SELECT * FROM tool_calls ORDER BY id',
      'SELECT * FROM tool_results ORDER BY tool_use_id',
      'SELECT * FROM summaries ORDER BY id',
      'SELECT * FROM subagents ORDER BY agent_id',
    ]) {
      assert.deepEqual(
        rows(incremental.db, sql),
        rows(rebuild.db, sql),
        `the incremental index agrees with a full rebuild: ${sql}`,
      );
    }
  } finally {
    incremental.close();
    rebuild.close();
    rmSync(layout.base, { recursive: true, force: true });
  }
});

test('a changed-path hint never schedules the whole store', () => {
  const layout = fixtureHome();
  const index = indexFixture(createHermesProvider({ rootDir: layout.base, openStore }));
  try {
    settle(index);
    const alphaId = hermesSessionId(SESSION_ALPHA, DEFAULT_PROFILE, layout.primaryPath);
    const betaId = hermesSessionId(SESSION_BETA, DEFAULT_PROFILE, layout.primaryPath);

    // A hint naming the store file only forces the store to be read: which sessions are scheduled
    // still follows the per-session cursors.
    writeStore(layout.primaryPath, db => {
      appendMessage(db, SESSION_ALPHA, 'assistant', { content: 'Hinted append', timestamp: 1767226020 });
    });
    const hinted = index.run({ changedPaths: [layout.primaryPath] });
    assert.deepEqual(scheduledSessionIds(hinted), [alphaId]);
    settle(index);

    // A hint naming one session's own source path schedules exactly that session, and nothing
    // else, even when that session did not change.
    const forced = index.run({ changedPaths: [`${layout.primaryPath}#session:${SESSION_BETA}`] });
    assert.deepEqual(scheduledSessionIds(forced), [betaId], 'the named session is the only one scheduled');
  } finally {
    index.close();
    rmSync(layout.base, { recursive: true, force: true });
  }
});

test('a certified store is skipped without opening its database', () => {
  const layout = fixtureHome();
  let opens = 0;
  const index = indexFixture(createHermesProvider({
    rootDir: layout.base,
    openStore: path => {
      opens += 1;
      return openStore(path);
    },
  }));
  try {
    settle(index);
    opens = 0;
    assert.equal(index.run().plan.items.length, 0, 'an idle store produces no work');
    assert.equal(opens, 0, 'and is not opened at all');
  } finally {
    index.close();
    rmSync(layout.base, { recursive: true, force: true });
  }
});

// Regression: readdir lists a profile name, then stat() reports ENOENT. That is an
// enumeration/stat race (a dangling symlink here), not evidence that the profile was deleted.
test('a profile entry readdir lists but stat cannot describe reports an incomplete inventory', (t) => {
  const layout = fixtureHome();
  const provider = createHermesProvider({ rootDir: layout.base, openStore });
  try {
    const first = discover(provider);
    const cursors = new Map(first.map(unit => [unit.key, unit.meta.currentCursor]));
    const indexed = indexedFrom(first);

    try {
      symlinkSync(join(layout.base, 'no-such-profile'), join(layout.base, 'profiles', 'dangling'));
    } catch {
      t.skip('this platform does not allow creating the symlink the race needs');
      return;
    }

    const issues = [];
    const blocked = discover(provider, { cursors, indexed, issues });
    assert.ok(issues.length >= 1, 'the entry is reported as an incomplete inventory');
    assert.equal(
      issues.some(issue => issue.path === join(layout.base, 'profiles', 'dangling')),
      true,
      'the entry is named',
    );
    assert.equal(
      blocked.filter(unit => unit.meta.tombstone === true).length,
      0,
      'an entry that cannot be described is not evidence of a deletion',
    );

    // A profile that is really gone is confirmed by the next stable scan: readdir no longer lists
    // it, so its sessions follow the normal retraction path.
    rmSync(join(layout.base, 'profiles', 'dangling'));
    rmSync(join(layout.base, 'profiles', 'coder'), { recursive: true, force: true });
    const settled = discover(provider, { cursors, indexed }).filter(unit => unit.meta.tombstone === true);
    assert.deepEqual(
      settled.map(unit => unit.sessionId),
      [hermesSessionId(SESSION_PROFILE, 'coder', layout.profilePath)],
      'a removed profile retracts through the ordinary path',
    );
  } finally {
    rmSync(layout.base, { recursive: true, force: true });
  }
});

/**
 * Wrap a store opener so a write lands at a chosen point of the read. `neutralizeTransaction`
 * removes BEGIN, which is how a binding that cannot hold a read snapshot behaves; it is armed
 * only once discovery has finished, so the discovery read itself still uses a real transaction.
 */
function injectingOpener(inject, { neutralizeTransaction = false } = {}) {
  let armed = !neutralizeTransaction;
  return {
    openStore: path => {
      const db = openStore(path);
      return new Proxy(db, {
        get(target, property) {
          if (property === 'exec' && neutralizeTransaction && armed) {
            return (sql) => {
              const statement = String(sql).trim().toUpperCase();
              if (statement.startsWith('BEGIN') || statement.startsWith('COMMIT')) return undefined;
              return target.exec(sql);
            };
          }
          if (property === 'prepare') {
            return (sql) => {
              if (/FROM messages WHERE session_id = \? ORDER BY rowid/.test(sql)) inject();
              return target.prepare(sql);
            };
          }
          const value = target[property];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    arm: () => {
      armed = true;
    },
  };
}

// The post-read fingerprint check is the second line of defence for a torn read. A store whose
// transaction cannot hold a snapshot still has to refuse "old session row + new messages".
test('parse() refuses a store that changed while it was read', () => {
  const layout = fixtureHome();
  try {
    let injected = false;
    const opener = injectingOpener(() => {
      if (injected) return;
      injected = true;
      writeStore(layout.primaryPath, db => {
        appendMessage(db, SESSION_ALPHA, 'assistant', { content: 'Arrived mid-read', timestamp: 1767226100 });
      });
    }, { neutralizeTransaction: true });
    const provider = createHermesProvider({ rootDir: layout.base, openStore: opener.openStore });
    const unit = discover(provider).find(candidate => candidate.meta.rawSessionId === SESSION_ALPHA);

    // Discovery read the store through a real transaction; parse() is the reader denied one, which
    // is the binding this test is about.
    opener.arm();
    assert.throws(() => drain(provider.parse(unit, null)), /Hermes session changed while it was read/);
    assert.equal(injected, true, 'the write really landed between the two reads');
  } finally {
    rmSync(layout.base, { recursive: true, force: true });
  }
});

// ADR-0001: discovery and parse each read their state in one snapshot, so a writer committing
// between two statements cannot be observed as one torn store image.
test('parse() reads the session row and its messages from one snapshot', () => {
  const layout = fixtureHome({ wal: true });
  try {
    let injected = false;
    const opener = injectingOpener(() => {
      if (injected) return;
      injected = true;
      // A WAL writer can commit while the reader holds its read transaction.
      writeStore(layout.primaryPath, db => {
        appendMessage(db, SESSION_ALPHA, 'assistant', { content: 'Arrived mid-read', timestamp: 1767226100 });
      });
    });
    const provider = createHermesProvider({ rootDir: layout.base, openStore: opener.openStore });
    const unit = discover(provider).find(candidate => candidate.meta.rawSessionId === SESSION_ALPHA);
    const { values } = drain(provider.parse(unit, null));
    assert.equal(injected, true, 'the write really landed between the two reads');
    assert.equal(
      values.some(record => record.kind === 'message' && record.text === 'Arrived mid-read'),
      false,
      'the message that arrived mid-read is not mixed into the snapshot',
    );

    // The change is not lost either: the next scan schedules the session again.
    const next = discover(provider).find(candidate => candidate.sessionId === unit.sessionId);
    assert.ok(next, 'a write that landed mid-read is scheduled by the next scan');
    assert.equal(
      drain(provider.parse(next, null)).values
        .some(record => record.kind === 'message' && record.text === 'Arrived mid-read'),
      true,
    );
  } finally {
    rmSync(layout.base, { recursive: true, force: true });
  }
});

test('discovery reads the schema, the sessions and the watermarks in one transaction', () => {
  const layout = fixtureHome();
  try {
    const statements = [];
    const provider = createHermesProvider({
      rootDir: layout.base,
      openStore: path => {
        const db = openStore(path);
        return new Proxy(db, {
          get(target, property) {
            if (property === 'exec') {
              return (sql) => {
                statements.push(String(sql).trim().toUpperCase());
                return target.exec(sql);
              };
            }
            if (property === 'prepare') {
              return (sql) => {
                statements.push(String(sql).trim());
                return target.prepare(sql);
              };
            }
            const value = target[property];
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    });
    discover(provider);

    const begin = statements.indexOf('BEGIN');
    const commit = statements.indexOf('COMMIT');
    assert.ok(begin >= 0, 'discovery opens a read transaction');
    assert.ok(commit > begin, 'and closes it');
    for (const statement of ['FROM sessions', 'GROUP BY session_id']) {
      const at = statements.findIndex(entry => entry.includes(statement));
      assert.ok(at > begin && at < commit, `${statement} is read inside the transaction`);
    }
  } finally {
    rmSync(layout.base, { recursive: true, force: true });
  }
});

// Upstream's context compressor writes its summary as a row of its own. Reading it as a message
// invents user/assistant speech and inflates message_count; it is a summary, like kimi.ts's
// context.apply_compaction.
test('a compaction summary is recorded as a summary instead of an invented turn', () => {
  const layout = fixtureHome();
  try {
    let summaryId = 0;
    writeStore(layout.primaryPath, db => {
      summaryId = appendMessage(db, SESSION_ALPHA, 'assistant', {
        content: 'Context compacted: earlier turns summarised',
        timestamp: 1767226080,
        compressedSummary: 1,
      });
    });
    const provider = createHermesProvider({ rootDir: layout.base, openStore });
    const unit = discover(provider).find(candidate => candidate.meta.rawSessionId === SESSION_ALPHA);
    const records = drain(provider.parse(unit, null)).values;
    const summaries = records.filter(record => record.kind === 'summary');
    const session = records.find(record => record.kind === 'session');

    assert.equal(summaries.length, 1, 'the compressed row becomes a summary');
    assert.equal(summaries[0].source, 'compaction');
    assert.equal(summaries[0].content, 'Context compacted: earlier turns summarised');
    assert.equal(summaries[0].id, `${unit.sessionId}:summary:${summaryId}`);
    assert.equal(summaries[0].session_id, unit.sessionId);
    assert.equal(
      records.some(record => record.kind === 'message' && record.uuid === `${unit.sessionId}:message:${summaryId}`),
      false,
      'and never also as a message',
    );
    assert.equal(session.message_count, 3, 'a summary is not a turn of the conversation');
    assert.ok(
      provider.raw({
        source: 'hermes',
        messageUuid: summaries[0].id,
        session: { jsonl_path: `${layout.primaryPath}#session:${SESSION_ALPHA}` },
        agentId: null,
      }),
      'the exact row is still available as evidence',
    );
  } finally {
    rmSync(layout.base, { recursive: true, force: true });
  }
});

// Upstream also recognizes a handoff by content (ContextCompressor.classify_summary_content), for
// rows an older build wrote before the private `_compressed_summary` flag existed. The real store
// has one such user row, and one tool row that merely quotes the marker.
test('an unmarked compaction handoff is a summary, but a row that quotes it is not', () => {
  const layout = fixtureHome();
  try {
    let handoffId = 0;
    let quotingId = 0;
    let flaggedToolId = 0;
    writeStore(layout.primaryPath, db => {
      handoffId = appendMessage(db, SESSION_ALPHA, 'user', {
        content: '[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below.',
        timestamp: 1767226080,
      });
      quotingId = appendMessage(db, SESSION_ALPHA, 'tool', {
        content: 'matches: [CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted',
        toolCallId: 'call-1',
        toolName: 'read_file',
        timestamp: 1767226090,
      });
      // Even carrying the private flag, a tool row is a tool result: upstream never replays a
      // handoff in place of one.
      flaggedToolId = appendMessage(db, SESSION_ALPHA, 'tool', {
        content: 'matches: [CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted',
        toolCallId: 'call-1',
        toolName: 'read_file',
        timestamp: 1767226100,
        compressedSummary: 1,
      });
    });
    const provider = createHermesProvider({ rootDir: layout.base, openStore });
    const unit = discover(provider).find(candidate => candidate.meta.rawSessionId === SESSION_ALPHA);
    const records = drain(provider.parse(unit, null)).values;
    const summaries = records.filter(record => record.kind === 'summary');

    assert.equal(summaries.length, 1, 'the content-classified handoff is a summary');
    assert.equal(summaries[0].id, `${unit.sessionId}:summary:${handoffId}`);
    assert.equal(summaries[0].source, 'compaction');
    assert.equal(
      records.some(record => record.kind === 'message' && record.uuid === `${unit.sessionId}:message:${handoffId}`),
      false,
      'and never also as an invented user turn',
    );
    assert.equal(
      summaries.some(summary => summary.id === `${unit.sessionId}:summary:${quotingId}`),
      false,
      'a marker inside a tool payload does not turn the row into a summary',
    );
    assert.equal(
      summaries.some(summary => summary.id === `${unit.sessionId}:summary:${flaggedToolId}`),
      false,
      'nor does the private flag on a tool row',
    );
    assert.ok(
      records.some(record => record.kind === 'tool_result' && record.content.startsWith('matches:')),
      'the tool row stays the tool result it was',
    );
  } finally {
    rmSync(layout.base, { recursive: true, force: true });
  }
});

// A merged carrier is the other handoff shape: preserved real text, then the delimiter, then the
// handoff. Upstream keeps the preserved tail as a normal message and strips the handoff only for
// display, so the row must stay a turn even though it carries the private flag.
test('a merged compaction carrier keeps its preserved turn instead of becoming a summary', () => {
  const layout = fixtureHome();
  try {
    let carrierId = 0;
    const preserved = 'The user asked for the migration plan and the agent answered.';
    writeStore(layout.primaryPath, db => {
      carrierId = appendMessage(db, SESSION_ALPHA, 'assistant', {
        content: [
          '[PRIOR CONTEXT — for reference only; not a new message]',
          preserved,
          '',
          '[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]',
          '[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below.',
        ].join('\n'),
        compressedSummary: 1,
        timestamp: 1767226080,
      });
    });
    const provider = createHermesProvider({ rootDir: layout.base, openStore });
    const unit = discover(provider).find(candidate => candidate.meta.rawSessionId === SESSION_ALPHA);
    const records = drain(provider.parse(unit, null)).values;
    const message = records.find(
      record => record.kind === 'message' && record.uuid === `${unit.sessionId}:message:${carrierId}`,
    );

    assert.ok(message, 'the preserved turn is still a message');
    assert.equal(message.role, 'assistant');
    assert.match(message.text, /migration plan/, 'with the text upstream keeps');
    assert.equal(
      records.some(record => record.kind === 'summary' && record.id.endsWith(`:summary:${carrierId}`)),
      false,
      'and it is not also flattened into a summary',
    );
  } finally {
    rmSync(layout.base, { recursive: true, force: true });
  }
});

// Only `display_kind='hidden'` is display-suppressed upstream; the other kinds are timeline
// markers, and the real store's `async_delegation_complete` rows carry the delegation result back
// into the session as user text. Those stay visible and non-meta, the way codex.ts treats a
// hidden row as meta but a marker as ordinary traffic. A superseded turn was still a turn.
test('a display-suppressed row is meta and a timeline marker is not', () => {
  const layout = fixtureHome();
  try {
    let markerId = 0;
    writeStore(layout.primaryPath, db => {
      markerId = appendMessage(db, SESSION_ALPHA, 'user', {
        content: '[ASYNC DELEGATION BATCH COMPLETE — deleg_5bc38fe4] A background fan-out unit finished.',
        displayKind: 'async_delegation_complete',
        timestamp: 1767226000,
      });
    });
    const provider = createHermesProvider({ rootDir: layout.base, openStore });
    const unit = discover(provider).find(candidate => candidate.meta.rawSessionId === SESSION_ALPHA);
    const messages = drain(provider.parse(unit, null)).values
      .filter(record => record.kind === 'message' && record.content_type !== 'thinking');
    const byId = rawId => messages.find(message => message.uuid === `${unit.sessionId}:message:${rawId}`);

    assert.equal(byId(layout.ids.hidden).is_meta, 1);
    assert.equal(byId(layout.ids.hidden).visibility, 'hidden');
    assert.equal(byId(markerId).is_meta, 0, 'a timeline marker is not bookkeeping to suppress');
    assert.equal(byId(markerId).visibility, 'visible', 'and it stays in the conversation');
    assert.equal(byId(layout.ids.final).is_meta, 0);
    assert.equal(byId(layout.ids.rewound).is_meta, 0, 'a rewound turn was still a turn');
    assert.equal(
      messages.filter(message => message.is_meta === 1).length,
      1,
      'only the display-suppressed row is meta',
    );
  } finally {
    rmSync(layout.base, { recursive: true, force: true });
  }
});

// CONTRIBUTING: fixtures are real provider output, not hand-written approximations. This drives the
// adapter over the captured rows in tests/fixtures/hermes/ so the shapes a synthetic fixture
// smooths over — SQLite INTEGER message ids, `tool_calls` JSON whose call ids repeat across
// sessions, both `display_kind` values, both compaction-handoff shapes, empty content — are read
// from something the host actually wrote.
test('parses the rows captured from a real Hermes store', () => {
  const base = makeTempDir('obelisk-hermes-captured-');
  try {
    const path = join(base, 'state.db');
    seedCapturedStore(path);
    const provider = createHermesProvider({ rootDir: base, openStore });
    // The home has no `profiles/` directory, which is the normal case: it is not an inventory gap.
    const issues = [];
    const units = sessionUnits(discover(provider, { issues }));
    assert.deepEqual(issues, [], 'a home without a profiles directory reports nothing');
    const records = [];
    for (const unit of units) records.push(...drain(provider.parse(unit, null)).values);

    const store = new DatabaseSync(path, { readOnly: true });
    try {
      const count = sql => Number(store.prepare(sql).get().n);
      assert.equal(units.length, count('SELECT COUNT(*) AS n FROM sessions'), 'every captured session is enumerated');
      assert.ok(records.some(record => record.kind === 'session'));

      // Hermes mints INTEGER message ids, so the canonical uuid has to carry a JS number.
      const numeric = store.prepare('SELECT id FROM messages ORDER BY id LIMIT 1').get();
      assert.equal(typeof numeric.id, 'number');
      assert.ok(
        records.some(record => record.kind === 'message' && record.uuid.endsWith(`:message:${numeric.id}`)),
        'the integer message id reaches the uuid',
      );

      // Two captured sessions reuse the same call ids, so the canonical id is the session's.
      const callIds = records.filter(record => record.kind === 'tool_call').map(record => record.id);
      assert.ok(callIds.length > 0);
      assert.equal(new Set(callIds).size, callIds.length, 'a repeated call id stays one id per session');
      // The capture is a row subset, so a tool row's owning call can fall outside it; in the real
      // store it never does (every tool row's call id is registered earlier in its own session).
      // The fallback keeps such a row: it attaches to the preceding message of its own session,
      // never to another session's, and same-session pairing is covered by the tool-id test above.
      const result = records.find(record => record.kind === 'tool_result');
      assert.ok(result, 'a captured tool row is not dropped');
      const owner = records.find(record => record.kind === 'message' && record.uuid === result.message_uuid);
      assert.ok(owner, 'the result attaches to a message');
      assert.equal(owner.session_id, result.session_id, 'and never to another session');
      assert.ok(result.tool_use_id.startsWith(`${result.session_id}:tool:`), 'its id is namespaced to its session');

      // A handoff written before the private flag existed, and a tool payload that quotes it.
      const unmarked = store.prepare(
        "SELECT id FROM messages WHERE _compressed_summary = 0 AND content LIKE '[CONTEXT COMPACTION%'",
      ).get();
      assert.ok(records.some(record => record.kind === 'summary' && record.id.endsWith(`:summary:${unmarked.id}`)));
      const quoting = store.prepare(
        "SELECT id FROM messages WHERE role = 'tool' AND content LIKE '%CONTEXT COMPACTION%'",
      ).get();
      assert.equal(
        records.some(record => record.kind === 'summary' && record.id.endsWith(`:summary:${quoting.id}`)),
        false,
        'a marker inside a tool payload is not a handoff',
      );

      // A merged carrier preserves a real turn, so it stays a message even though it is flagged.
      const merged = store.prepare(
        "SELECT id FROM messages WHERE _compressed_summary = 1 AND content LIKE '[PRIOR CONTEXT%'",
      ).all();
      assert.ok(merged.length > 0);
      for (const row of merged) {
        assert.equal(
          records.some(record => record.kind === 'summary' && record.id.endsWith(`:summary:${row.id}`)),
          false,
          'a merged carrier is not flattened into a summary',
        );
        assert.ok(
          records.some(record => record.kind === 'message' && record.uuid.endsWith(`:message:${row.id}`)),
          'its preserved turn is still a message',
        );
      }

      // `hidden` is the one kind upstream suppresses; the delegation notices stay conversation.
      const hidden = store.prepare("SELECT id FROM messages WHERE display_kind = 'hidden'").get();
      const notice = store.prepare(
        "SELECT id FROM messages WHERE display_kind = 'async_delegation_complete'",
      ).get();
      const messageOf = id => records.find(
        record => typeof record.uuid === 'string' && record.uuid.endsWith(`:message:${id}`),
      );
      assert.equal(messageOf(hidden.id).is_meta, 1);
      assert.equal(messageOf(hidden.id).visibility, 'hidden');
      assert.equal(messageOf(notice.id).is_meta, 0);
      assert.notEqual(messageOf(notice.id).visibility, 'hidden');

      // CONTRIBUTING: a record with no text is still a record.
      const blank = store.prepare(
        "SELECT id FROM messages WHERE content = '' AND role <> 'tool'",
      ).get();
      assert.equal(messageOf(blank.id).text, null);
      // `api_content` is the model-visible byte sidecar upstream may drop, so it is deliberately
      // not projected: a row whose text lives only there stays a textless record.
      const sidecar = store.prepare(
        "SELECT id FROM messages WHERE content = '' AND api_content IS NOT NULL",
      ).get();
      assert.ok(sidecar, 'the capture holds a row whose text is only in api_content');
      assert.equal(messageOf(sidecar.id).text, null, 'and that sidecar is not projected as text');
    } finally {
      store.close();
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// #198 P2-5: the compaction summary has to be reachable through a public retrieval path and not
// only present in the table. The host writes a superseded handoff inactive, so the default view
// hides it; a caller that wants it asks for inactive rows explicitly. The projection stays as it
// is — this pins how the record is reached, not a change to it.
test('a compaction summary is retrievable through the query API with includeInactive', () => {
  const base = makeTempDir('obelisk-hermes-summary-query-');
  const index = indexFixture(createHermesProvider({ rootDir: base, openStore }));
  try {
    seedCapturedStore(join(base, 'state.db'));
    settle(index);
    const api = createQueryApi(index.db);
    const byDefault = api.summaries();
    const includingInactive = api.summaries({ includeInactive: true });
    const compaction = row => String(row.content ?? '').startsWith('[CONTEXT COMPACTION');

    assert.ok(includingInactive.some(compaction), 'the compaction handoff is retrievable');
    assert.ok(byDefault.some(compaction), 'an active handoff is in the default view');
    assert.ok(
      includingInactive.length > byDefault.length,
      'the inclusive view reaches rows the default one legitimately hides',
    );

    const hidden = includingInactive.filter(row => String(row.visibility) === 'inactive');
    assert.equal(hidden.length, 1, 'the superseded handoff is the inactive row');
    assert.equal(compaction(hidden[0]), true, 'and it is a compaction summary the reader has to reach');
    assert.equal(
      byDefault.some(row => row.id === hidden[0].id),
      false,
      'which the default view does not offer',
    );
    assert.match(String(hidden[0].session_id), /^hermes:/, 'it belongs to a Hermes session');
  } finally {
    index.close();
    rmSync(base, { recursive: true, force: true });
  }
});
