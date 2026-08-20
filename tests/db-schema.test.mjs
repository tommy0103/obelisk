// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

import { extractContentType, extractMessageIsMeta } from '../packages/core/src/db.ts';
import { migrateCoreSchemaColumns } from '../packages/core/src/schema-migrations.ts';

async function readExecutableSchema() {
  return readFile(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');
}

async function readSchemaReference() {
  return readFile(new URL('../skill-doc/references/schema.md', import.meta.url), 'utf8');
}

async function readApiReference() {
  return readFile(new URL('../skill-doc/references/api-reference.md', import.meta.url), 'utf8');
}

async function readSkill() {
  return readFile(new URL('../skill-doc/SKILL.md', import.meta.url), 'utf8');
}

test('db module loads the executable schema from packages/core/src/schema.sql', async () => {
  const source = await readFile(new URL('../packages/core/src/db.ts', import.meta.url), 'utf8');

  assert.match(source, /schema\.sql/);
  assert.doesNotMatch(source, /CREATE TABLE IF NOT EXISTS sessions/);
});

test('memories schema indexes common recall filters', async () => {
  const source = await readExecutableSchema();

  assert.match(source, /CREATE INDEX IF NOT EXISTS idx_memories_project ON memories\(project\)/);
  assert.match(source, /CREATE INDEX IF NOT EXISTS idx_memories_session ON memories\(session_id\)/);
  assert.match(source, /CREATE INDEX IF NOT EXISTS idx_memories_created ON memories\(created_at\)/);
  assert.match(source, /CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5/);
  assert.match(source, /CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories/);
  assert.match(source, /CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE ON memories/);
  assert.match(source, /CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories/);
});

test('messages schema stores the raw content block type', async () => {
  const source = await readExecutableSchema();

  assert.match(source, /content_type TEXT/);
  assert.match(source, /is_meta INTEGER DEFAULT 0/);
  assert.match(source, /CREATE INDEX IF NOT EXISTS idx_messages_usage_day/);
  assert.match(source, /CREATE INDEX IF NOT EXISTS idx_messages_turn_duration/);
  assert.match(source, /CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages/);
  assert.match(source, /CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages/);
  assert.match(source, /CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages/);
});

test('usage indexes accept provider timestamps without normalizing them', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(await readExecutableSchema());
    db.prepare(`
      INSERT INTO messages (uuid, timestamp, input_tokens, source)
      VALUES (?, ?, ?, ?)
    `).run('raw-timestamp', 'now', 1, 'claude');

    assert.equal(
      db.prepare("SELECT timestamp FROM messages WHERE uuid='raw-timestamp'").get().timestamp,
      'now',
    );
  } finally {
    db.close();
  }
});

test('summaries preserve usage from provider-owned summary model calls', async () => {
  const source = await readExecutableSchema();

  assert.match(source, /summaries \([\s\S]*visibility TEXT DEFAULT 'visible'[\s\S]*input_tokens INTEGER, output_tokens INTEGER/);
  assert.match(source, /index_state \([\s\S]*cursor TEXT/);
});

test('additive migrations preserve old index state and summary rows while adding canonical fields', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE index_state (
        jsonl_path TEXT PRIMARY KEY, mtime REAL, lines_processed INTEGER
      );
      CREATE TABLE summaries (
        id TEXT PRIMARY KEY, session_id TEXT, timestamp TEXT,
        source TEXT, content TEXT
      );
      INSERT INTO index_state VALUES ('unit', 12, 3);
      INSERT INTO summaries VALUES ('summary', 'session', NULL, 'legacy', 'kept');
    `);

    migrateCoreSchemaColumns(db);
    assert.equal(
      db.prepare("SELECT cursor FROM index_state WHERE jsonl_path='unit'").get().cursor,
      null,
    );
    assert.deepEqual(
      { ...db.prepare("SELECT content,visibility FROM summaries WHERE id='summary'").get() },
      { content: 'kept', visibility: 'visible' },
    );
  } finally {
    db.close();
  }
});

test('tool results schema indexes live session patch lookups', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(await readExecutableSchema());
    const plan = db.prepare(
      'EXPLAIN QUERY PLAN SELECT * FROM tool_results WHERE session_id = ?',
    ).all('session-1');

    assert.ok(
      plan.some(row => /USING INDEX idx_tr_session/.test(String(row.detail))),
      `expected idx_tr_session lookup, got: ${plan.map(row => row.detail).join('; ')}`,
    );
  } finally {
    db.close();
  }
});

test('session detail queries use the visible main timeline index', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(await readExecutableSchema());
    const messagePlan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT m.uuid FROM messages m
      WHERE m.session_id = ? AND m.agent_id IS NULL
        AND COALESCE(m.visibility, 'visible') = 'visible'
      ORDER BY m.timestamp, m.uuid
    `).all('session-1');
    const toolCallPlan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT tc.* FROM messages m
      CROSS JOIN tool_calls tc ON tc.message_uuid = m.uuid
      WHERE m.session_id = ? AND m.agent_id IS NULL
        AND COALESCE(m.visibility, 'visible') = 'visible'
        AND tc.session_id = ?
    `).all('session-1', 'session-1');
    const toolResultPlan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT tr.* FROM messages m
      CROSS JOIN tool_results tr ON tr.message_uuid = m.uuid
      WHERE m.session_id = ? AND m.agent_id IS NULL
        AND COALESCE(m.visibility, 'visible') = 'visible'
        AND tr.session_id = ?
    `).all('session-1', 'session-1');

    const details = plan => plan.map(row => String(row.detail));
    assert.ok(
      details(messagePlan).some(detail => /USING INDEX idx_messages_main_timeline/.test(detail)),
      `expected main timeline index, got: ${details(messagePlan).join('; ')}`,
    );
    assert.ok(
      /USING INDEX idx_messages_main_timeline/.test(details(toolCallPlan)[0])
        && details(toolCallPlan).some(detail => /USING INDEX idx_tc_message/.test(detail)),
      `expected main-timeline-first tool call lookup, got: ${details(toolCallPlan).join('; ')}`,
    );
    assert.ok(
      /USING INDEX idx_messages_main_timeline/.test(details(toolResultPlan)[0])
        && details(toolResultPlan).some(detail => /USING INDEX idx_tr_message/.test(detail)),
      `expected main-timeline-first tool result lookup, got: ${details(toolResultPlan).join('; ')}`,
    );
  } finally {
    db.close();
  }
});

test('tool payload schema indexes subagent joins and guardian retractions', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(await readExecutableSchema());
    const toolCallJoinPlan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT tc.* FROM tool_calls tc
      JOIN messages m ON m.uuid = tc.message_uuid
      WHERE m.agent_id = ?
    `).all('agent-1');
    const toolResultJoinPlan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT tr.* FROM tool_results tr
      JOIN messages m ON m.uuid = tr.message_uuid
      WHERE m.agent_id = ?
    `).all('agent-1');
    const toolCallRetractionPlan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT rowid FROM tool_calls
      WHERE session_id = ? OR message_uuid IN (
        SELECT uuid FROM messages WHERE session_id = ? OR agent_id = ?
      )
    `).all('session-1', 'session-1', 'session-1');
    const toolResultRetractionPlan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT rowid FROM tool_results
      WHERE session_id = ? OR message_uuid IN (
        SELECT uuid FROM messages WHERE session_id = ? OR agent_id = ?
      )
    `).all('session-1', 'session-1', 'session-1');

    const details = plans => plans.map(row => String(row.detail));
    assert.ok(
      details(toolCallJoinPlan).some(detail => /USING INDEX idx_tc_message/.test(detail)),
      `expected indexed tool call join, got: ${details(toolCallJoinPlan).join('; ')}`,
    );
    assert.ok(
      details(toolResultJoinPlan).some(detail => /USING INDEX idx_tr_message/.test(detail)),
      `expected indexed tool result join, got: ${details(toolResultJoinPlan).join('; ')}`,
    );
    assert.ok(
      details(toolCallRetractionPlan).some(detail => /USING INDEX idx_tc_message/.test(detail)),
      `expected indexed tool call retraction, got: ${details(toolCallRetractionPlan).join('; ')}`,
    );
    assert.ok(
      details(toolResultRetractionPlan).some(detail => /USING INDEX idx_tr_message/.test(detail)),
      `expected indexed tool result retraction, got: ${details(toolResultRetractionPlan).join('; ')}`,
    );
  } finally {
    db.close();
  }
});

test('schema reference stays focused on raw SQL structure', async () => {
  const ref = await readSchemaReference();

  assert.ok(ref.split('\n').length < 420, 'schema.md should remain a quick SQL reference');
  assert.match(ref, /Raw SQL Quick Reference/i);
  assert.match(ref, /Claude Code, Codex, DeepSeek Harness, Kimi Code, OMP, and Pi/);
  assert.equal(
    ref.match(/Provider ID: `claude`, `codex`, `deepseek`, `kimi`, `omp`, or `pi`/g)?.length,
    2,
    'session and message source fields should document every provider',
  );
  assert.match(ref, /references\/api-reference\.md/);
  assert.match(ref, /sessions\.id\s+<--\s+messages\.session_id/);
  assert.match(ref, /tool_calls.*does not have timestamps/i);
  assert.match(ref, /COALESCE\(m\.is_meta, 0\) = 0/);
  assert.match(ref, /provider-attested superseded history/);
  assert.match(ref, /Exact opaque provider cursor/);
  assert.doesNotMatch(ref, /#### `summaries\(opts\?\)`/);
  assert.doesNotMatch(ref, /#### `raw\(uuid, opts\?\)`/);
});

test('api reference documents query helpers and current return fields', async () => {
  const ref = await readApiReference();

  assert.match(ref, /## Query API Reference/);
  assert.match(ref, /'claude' \| 'codex' \| 'deepseek' \| 'kimi' \| 'omp' \| 'pi'/);
  assert.doesNotMatch(ref, /"claude", "codex", or omitted/);
  assert.match(ref, /#### `summaries\(opts\?\)`/);
  assert.match(ref, /summary rows/i);
  assert.match(ref, /Inactive summaries describe work that was tried and[\s\S]*then superseded/);
  assert.match(ref, /session_title/);
  assert.match(ref, /opts\.branch/);
  assert.match(ref, /#### `raw\(uuid, opts\?\)`/);
  assert.match(ref, /original JSONL line/i);
  assert.match(ref, /opts\.offset/);
  assert.match(ref, /totalLength/);
  assert.match(ref, /hasMore/);
  assert.match(ref, /messageCount/);
  assert.doesNotMatch(ref, /a\.messages\.length/);
  assert.doesNotMatch(ref, /Rebuilt on each index pass/);
});

test('skill routes agents to the right reference document', async () => {
  const skill = await readSkill();

  assert.match(skill, /Claude Code, Codex, Kimi Code, OMP, and Pi/);
  assert.match(skill, /'claude'.*'codex'.*'deepseek'.*'kimi'.*'omp'.*'pi'/s);
  assert.match(skill, /Reference Map/);
  assert.match(skill, /references\/schema\.md.*raw SQL/i);
  assert.match(skill, /references\/api-reference\.md.*helper/i);
  assert.match(skill, /references\/query-patterns\.md.*synthesis/i);
  assert.match(skill, /references\/pitfalls\.md.*error/i);
});

test('extractContentType maps Claude content blocks to the message evidence type', () => {
  assert.equal(extractContentType('hello'), 'text');
  assert.equal(extractContentType([{ type: 'text', text: 'hello' }]), 'text');
  assert.equal(extractContentType([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'text');
  assert.equal(extractContentType([{ type: 'thinking', thinking: 'hidden reasoning' }]), 'thinking');
  assert.equal(extractContentType([{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }]), 'tool_use');
  assert.equal(extractContentType([{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }]), 'tool_result');
  assert.equal(extractContentType([{ type: 'text', text: 'reply' }, { type: 'thinking', thinking: 'hmm' }]), 'unknown');
  assert.equal(extractContentType([{ type: 'text', text: 'reply' }, { type: 'tool_result', content: 'ok' }]), 'unknown');
  assert.equal(extractContentType(null), 'unknown');
});

test('extractMessageIsMeta marks injected and command-envelope messages', () => {
  assert.equal(extractMessageIsMeta({ isMeta: true, message: { content: 'caveat' } }, 'caveat'), 1);
  assert.equal(extractMessageIsMeta({ message: { isMeta: true, content: 'caveat' } }, 'caveat'), 1);
  assert.equal(extractMessageIsMeta(
    { message: { content: [{ type: 'text', text: '<command-name>/exit</command-name>' }] } },
    '<command-name>/exit</command-name>',
  ), 1);
  assert.equal(extractMessageIsMeta(
    { message: { content: [{ type: 'text', text: '<system-reminder>Keep answers concise</system-reminder>' }] } },
    '<system-reminder>Keep answers concise</system-reminder>',
  ), 1);
  assert.equal(extractMessageIsMeta(
    { message: { content: [{ type: 'text', text: '<local-command>git status</local-command>' }] } },
    '<local-command>git status</local-command>',
  ), 1);
  assert.equal(extractMessageIsMeta(
    { message: { content: [{ type: 'text', text: 'quoted <command-name>/exit</command-name>' }] } },
    'quoted <command-name>/exit</command-name>',
  ), 0);
  assert.equal(extractMessageIsMeta({ message: { content: 'normal user request' } }, 'normal user request'), 0);
});
