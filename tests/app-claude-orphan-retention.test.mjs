// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildIndex } from '../app/src/main/indexer.ts';
import { createClaudeProvider, CLAUDE_CANONICAL_TRANSCRIPT_MARKER } from '../packages/core/src/providers/claude.ts';
import { createProviderRegistry } from '../packages/core/src/providers/registry.ts';
import { runCli } from './cli-test-helpers.mjs';
import { makeTempDir } from './temp-dirs.mjs';

const requireApp = createRequire(new URL('../app/package.json', import.meta.url));
const Database = requireApp('better-sqlite3');
const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');
const line = (uuid, text, timestamp = '2026-06-10T10:00:00Z') => JSON.stringify({
  uuid, type: 'user', timestamp, cwd: '/work/project', message: { role: 'user', content: text },
}) + '\n';

for (const runtime of ['built CLI', 'App SQLite']) {
  test(`${runtime}: metadata-only children preserve cached main counts across refresh and rebuild`, () => {
    const home = makeTempDir('obelisk-metadata-orphan-history-');
    const claudeDir = join(home, '.claude');
    const project = join(claudeDir, 'projects', '-project');
    const children = join(project, 'session', 'subagents');
    mkdirSync(children, { recursive: true });
    const main = join(project, 'session.jsonl');
    writeFileSync(main, line('cached-main', 'retainedonlyneedle'));
    const captured = readFileSync(new URL('./fixtures/claude/custom-title-session.jsonl', import.meta.url), 'utf8')
      .trim().split('\n').map(JSON.parse).find(record => record.type === 'agent-name');
    assert.ok(captured, 'use actual captured metadata-only Claude input');
    writeFileSync(join(children, 'agent-a.jsonl'), JSON.stringify(captured) + '\n');
    const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
    const registry = createProviderRegistry([createClaudeProvider({ rootDir: claudeDir })]);
    const query = join(home, 'query.mjs');
    writeFileSync(query, 'return sql("SELECT COUNT(*) n FROM messages");');
    const build = force => {
      if (runtime === 'built CLI') {
        const result = runCli(force ? ['--build'] : ['--query', query], { home });
        assert.equal(result.status, 0, result.stdout + result.stderr);
      } else {
        const result = buildIndex({ claudeDir, dbPath, providerRegistry: registry, DatabaseImpl: Database, force });
        assert.equal(result.complete, true, JSON.stringify(result));
      }
    };
    const inspect = fn => { const db = new DatabaseSync(dbPath); try { fn(db); } finally { db.close(); } };
    build(false);
    unlinkSync(main);
    for (const mode of ['refresh', 'force', 'marker replay']) {
      inspect(db => {
        db.exec("DELETE FROM index_state WHERE jsonl_path='__last_build__'");
        if (mode === 'marker replay') db.prepare('DELETE FROM index_state WHERE jsonl_path=?').run(CLAUDE_CANONICAL_TRANSCRIPT_MARKER);
      });
      build(mode === 'force');
      inspect(db => {
        assert.equal(db.prepare('SELECT COUNT(*) n FROM messages').get().n, 1, mode);
        assert.equal(db.prepare('SELECT message_count FROM sessions WHERE id=?').get('session').message_count, 1, mode);
        assert.equal(db.prepare("SELECT uuid FROM messages_fts WHERE messages_fts MATCH 'retainedonlyneedle'").get().uuid, 'cached-main');
      });
    }
  });
  test(`${runtime}: missing main history survives refresh, force and marker replay while readable children advance`, () => {
    const home = makeTempDir('obelisk-orphan-history-');
    const claudeDir = join(home, '.claude');
    const project = join(claudeDir, 'projects', '-project');
    const children = join(project, 'session', 'subagents');
    mkdirSync(children, { recursive: true });
    const main = join(project, 'session.jsonl');
    const first = join(children, 'agent-a.jsonl');
    const second = join(children, 'agent-b.jsonl');
    writeFileSync(main, JSON.stringify({ type: 'custom-title', customTitle: 'Named Session' }) + '\n'
      + line('cached-main', 'retainedonlyneedle', '2026-06-10T09:00:00Z')
      + JSON.stringify({ uuid: 'cached-call', type: 'assistant', timestamp: '2026-06-10T09:00:01Z',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'cached-tool', name: 'Read', input: { file_path: '/work/project/file' } }] } }) + '\n'
      + JSON.stringify({ uuid: 'cached-result', type: 'user', timestamp: '2026-06-10T09:00:02Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'cached-tool', content: 'cached tool evidence' }] } }) + '\n'
      + JSON.stringify({ type: 'system', subtype: 'away_summary', uuid: 'cached-summary', timestamp: '2026-06-10T09:00:03Z', content: 'cached summary' }) + '\n');
    writeFileSync(first, line('a1', 'first child'));
    writeFileSync(second, line('b1', 'second child'));
    let dbPath = join(home, '.obelisk', 'obelisk.sqlite');
    const providerRegistry = createProviderRegistry([createClaudeProvider({ rootDir: claudeDir })]);
    const query = join(home, 'query.mjs');
    writeFileSync(query, 'return sql("SELECT COUNT(*) n FROM messages");');
    const build = (force = false, preserveDbPath) => {
      if (runtime === 'built CLI') {
        const result = runCli(force ? ['--build'] : ['--query', query], { home });
        assert.equal(result.status, 0, result.stdout + result.stderr);
      } else {
        const result = buildIndex({ claudeDir, dbPath, providerRegistry, DatabaseImpl: Database, force, preserveDbPath });
        assert.equal(result.complete, true, JSON.stringify(result));
        assert.equal(result.skipped, 0);
      }
    };
    const inspect = fn => {
      const db = new DatabaseSync(dbPath);
      try { return fn(db); } finally { db.close(); }
    };
    const clearDebounce = () => inspect(db => db.exec("DELETE FROM index_state WHERE jsonl_path='__last_build__'"));
    const expectHistory = count => inspect(db => {
      assert.equal(db.prepare('SELECT COUNT(*) n FROM messages').get().n, count);
      const session = db.prepare('SELECT * FROM sessions WHERE id=?').get('session');
      assert.equal(session.message_count, count, 'orphan count includes cached main and child rows');
      assert.equal(session.title, 'Named Session');
      assert.equal(session.started_at, '2026-06-10T09:00:00.000Z');
      assert.equal(db.prepare('SELECT text FROM messages WHERE uuid=?').get('cached-main').text, 'retainedonlyneedle');
      assert.equal(db.prepare("SELECT uuid FROM messages_fts WHERE messages_fts MATCH 'retainedonlyneedle'").get().uuid, 'cached-main');
      assert.equal(db.prepare('SELECT input_json FROM tool_calls WHERE id=?').get('cached-tool').input_json, '{"file_path":"/work/project/file"}');
      assert.equal(db.prepare('SELECT content FROM tool_results WHERE tool_use_id=?').get('cached-tool').content, 'cached tool evidence');
      assert.equal(db.prepare('SELECT content FROM summaries WHERE id=?').get('cached-summary').content, 'cached summary');
      assert.ok(db.prepare('SELECT uuid FROM messages WHERE uuid=?').get('b1'), 'a removed child file also retains indexed evidence');
    });
    build();
    unlinkSync(main);
    appendFileSync(first, line('a2', 'new child after main removal'));
    clearDebounce(); build(); expectHistory(6);
    clearDebounce(); build(); expectHistory(6);
    unlinkSync(second);
    appendFileSync(first, line('a3', 'new child during force rebuild'));
    build(true); expectHistory(7);
    build(true); expectHistory(7);
    inspect(db => db.prepare('DELETE FROM index_state WHERE jsonl_path=?').run(CLAUDE_CANONICAL_TRANSCRIPT_MARKER));
    appendFileSync(first, line('a4', 'new child during marker replay'));
    clearDebounce(); build(); expectHistory(8);
    if (runtime === 'App SQLite') {
      const previous = dbPath;
      dbPath = join(home, 'replacement.sqlite');
      appendFileSync(first, line('a5', 'new child during desktop database replacement'));
      build(true, previous); expectHistory(9);
    }
  });

  test(`${runtime}: force repair keeps legacy orphan messages without a session row`, () => {
    const home = makeTempDir('obelisk-legacy-orphan-history-');
    const claudeDir = join(home, '.claude');
    const children = join(claudeDir, 'projects', '-project', 'session', 'subagents');
    mkdirSync(children, { recursive: true });
    writeFileSync(join(children, 'agent-a.jsonl'), line('a1', 'current child'));
    const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
    mkdirSync(join(home, '.obelisk'));
    let db = new DatabaseSync(dbPath);
    db.exec(SCHEMA);
    // Before this PR, orphan child messages were persisted while the provider
    // suppressed their session record. Their source can disappear before upgrade.
    db.prepare(`INSERT INTO messages(uuid,session_id,type,role,text,agent_id,source)
      VALUES('legacy-child','session','user','user','cached child','agent-b','claude')`).run();
    db.close();
    const registry = createProviderRegistry([createClaudeProvider({ rootDir: claudeDir })]);
    if (runtime === 'built CLI') {
      const result = runCli(['--build'], { home });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    } else {
      const result = buildIndex({ claudeDir, dbPath, providerRegistry: registry, DatabaseImpl: Database, force: true });
      assert.equal(result.complete, true, JSON.stringify(result));
    }
    db = new DatabaseSync(dbPath);
    try {
      assert.deepEqual(db.prepare('SELECT uuid FROM messages ORDER BY uuid').all().map(row => row.uuid), ['a1', 'legacy-child']);
      assert.equal(db.prepare('SELECT message_count FROM sessions WHERE id=?').get('session').message_count, 2);
      const checkpoint = db.prepare('SELECT jsonl_path, replay_required FROM index_state WHERE jsonl_path=?').get(children);
      assert.ok(checkpoint);
      assert.equal(checkpoint.replay_required, 0, 'the successfully refreshed family acknowledges its replay');
      assert.deepEqual(registry.list()[0].discover({ lastCursor: key => {
        const row = db.prepare('SELECT cursor FROM index_state WHERE jsonl_path=?').get(key);
        return row?.cursor ?? null;
      } }), [], 'unchanged readable family converges after force repair');
    } finally { db.close(); }
  });
}
