// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, normalize } from 'node:path';

import { runCli as runRuntime } from './cli-test-helpers.mjs';
import { makeTempDir } from './temp-dirs.mjs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

function tempHome() {
  const home = makeTempDir('obelisk-runtime-home-');
  mkdirSync(join(home, '.claude'), { recursive: true });
  return home;
}

test('runtime query scripts cannot call attune helpers', () => {
  const home = tempHome();
  const scriptPath = join(home, 'query.mjs');
  writeFileSync(scriptPath, 'return { rememberType: typeof remember, forgetType: typeof forget, overviewType: typeof overview };');

  const result = runRuntime(['--query', scriptPath], { home });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), {
    rememberType: 'undefined',
    forgetType: 'undefined',
    overviewType: 'function',
  });
});

test('malformed Obelisk settings skip refresh without disabling provider-backed queries', () => {
  const home = tempHome();
  const projectDir = join(home, '.claude', 'projects', '-tmp-settings-recovery');
  const transcriptPath = join(projectDir, 'settings-recovery.jsonl');
  const scriptPath = join(home, 'query.mjs');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(transcriptPath, `${JSON.stringify({
    uuid: 'settings-recovery-user',
    type: 'user',
    timestamp: '2026-08-04T10:00:00.000Z',
    cwd: '/tmp/settings-recovery',
    message: { role: 'user', content: 'settings recovery evidence' },
  })}\n`);
  writeFileSync(scriptPath, `
    const hit = search('settings recovery evidence', { limit: 1 })[0];
    return {
      uuid: hit?.message.uuid ?? null,
      raw: hit ? raw(hit.message.uuid)?.text ?? null : null
    };
  `);

  const indexed = runRuntime(['--query', scriptPath], { home });
  assert.equal(indexed.status, 0, indexed.stderr || indexed.stdout);
  assert.equal(JSON.parse(indexed.stdout).uuid, 'settings-recovery-user');

  writeFileSync(join(home, '.obelisk', 'settings.json'), '{broken');
  const recovered = runRuntime(['--query', scriptPath], { home });
  assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
  assert.match(recovered.stderr, /index refresh skipped/);
  assert.equal(JSON.parse(recovered.stdout).uuid, 'settings-recovery-user');
  assert.match(JSON.parse(recovered.stdout).raw, /settings recovery evidence/);

  const rebuild = runRuntime(['--build'], { home });
  assert.equal(rebuild.status, 1);
  assert.match(JSON.parse(rebuild.stdout).error, /settings_unavailable/);
  assert.match(JSON.parse(rebuild.stdout).error, /Unable to read Obelisk settings/);

  const memoryPath = join(home, 'settings-free-memory.md');
  const attunePath = join(home, 'attune.mjs');
  writeFileSync(memoryPath, '# Settings-free memory\n');
  writeFileSync(attunePath, `
    return remember({
      path: ${JSON.stringify(memoryPath)},
      project: 'runtime-test',
      summary: 'Decision: memory writes do not depend on provider settings.'
    });
  `);
  // Memory writes touch only the memories table, so they stay available even
  // while provider settings are unreadable.
  const attune = runRuntime(['--attune', attunePath], { home });
  assert.equal(attune.status, 0, attune.stderr || attune.stdout);
  assert.equal(JSON.parse(attune.stdout).project, 'runtime-test');
});

test('runtime attune scripts expose only memory mutation helpers', () => {
  const home = tempHome();
  const memoryPath = join(home, 'memory.md');
  const scriptPath = join(home, 'attune.mjs');
  writeFileSync(memoryPath, '# Memory\n');
  // Attune no longer builds the index itself; initialize it with a query first.
  const initPath = join(home, 'init.mjs');
  writeFileSync(initPath, "return 'init';");
  const init = runRuntime(['--query', initPath], { home });
  assert.equal(init.status, 0, init.stderr || init.stdout);
  writeFileSync(scriptPath, `
    return {
      rememberType: typeof remember,
      forgetType: typeof forget,
      searchType: typeof search,
      sqlType: typeof sql,
      overviewType: typeof overview,
      result: remember({
        path: ${JSON.stringify(memoryPath)},
        project: 'runtime-test',
        summary: 'Decision: runtime remember exposes only memory registration.'
      })
    };
  `);

  const result = runRuntime(['--attune', scriptPath], { home });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.rememberType, 'function');
  assert.equal(payload.forgetType, 'function');
  assert.equal(payload.searchType, 'undefined');
  assert.equal(payload.sqlType, 'undefined');
  assert.equal(payload.overviewType, 'undefined');
  assert.equal(payload.result.path, memoryPath);
});

test('runtime rejects removed remember mode', () => {
  const home = tempHome();
  const scriptPath = join(home, 'remember.mjs');
  writeFileSync(scriptPath, 'return { ok: true };');

  const result = runRuntime(['--remember', scriptPath], { home });

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /--attune <file\.js>/);
});

test('runtime migrates old memories schema before recall', () => {
  const home = tempHome();
  const dbPath = join(home, '.claude', 'obelisk.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY, session_id TEXT, project TEXT,
      message_start TEXT, message_end TEXT,
      path TEXT, summary TEXT, created_at TEXT
    );
    INSERT INTO memories (id, project, path, summary, created_at)
    VALUES ('mem-old', 'legacy-project', '/tmp/old.md', 'Decision: keep legacy memory rows readable.', '2026-06-10T12:00:00Z');
  `);
  db.close();
  const scriptPath = join(home, 'query.mjs');
  writeFileSync(scriptPath, `
    return memories({ project: "%legacy-project%", query: "legacy memory", limit: 5 })
      .map(m => ({ id: m.id, rankType: typeof m.rank }));
  `);

  const result = runRuntime(['--query', scriptPath], { home });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), [{ id: 'mem-old', rankType: 'number' }]);
});

test('runtime migrates a recently built legacy schema before honoring the skip window', () => {
  const home = tempHome();
  const obeliskDir = join(home, '.obelisk');
  const dbPath = join(obeliskDir, 'obelisk.sqlite');
  mkdirSync(obeliskDir, { recursive: true });
  const schema = readFileSync(
    new URL('../packages/core/src/schema.sql', import.meta.url),
    'utf8',
  )
    .replace(', cursor TEXT);', ');')
    .replace(
      ", visibility TEXT DEFAULT 'visible',\n  input_tokens INTEGER, output_tokens INTEGER);",
      ');',
    );
  const db = new DatabaseSync(dbPath);
  db.exec(schema);
  db.prepare(`
    INSERT INTO sessions (id,title,jsonl_path,source)
    VALUES (?,?,?,?)
  `).run('legacy-session', 'Legacy session', '/missing/session.jsonl', 'claude');
  db.prepare(`
    INSERT INTO messages (
      uuid,session_id,type,role,text,content_type,visibility,source
    ) VALUES (?,?,?,?,?,?,?,?)
  `).run('legacy-message', 'legacy-session', 'user', 'user', 'legacy evidence', 'text', 'visible', 'claude');
  db.prepare(`
    INSERT INTO index_state (jsonl_path,mtime,lines_processed)
    VALUES ('__last_build__',?,0)
  `).run(Date.now());
  db.close();

  const scriptPath = join(home, 'legacy-query.mjs');
  writeFileSync(scriptPath, `
    return thread('legacy-session').map(message => message.uuid);
  `);
  const result = runRuntime(['--query', scriptPath], { home });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), ['legacy-message']);
  const migrated = new DatabaseSync(dbPath, { readOnly: true });
  assert.ok(migrated.prepare('PRAGMA table_info(index_state)').all().some(row => row.name === 'cursor'));
  assert.ok(migrated.prepare('PRAGMA table_info(summaries)').all().some(row => row.name === 'visibility'));
  migrated.close();
});

test('malformed settings still allow a legacy query schema to migrate', () => {
  const home = tempHome();
  const obeliskDir = join(home, '.obelisk');
  const dbPath = join(obeliskDir, 'obelisk.sqlite');
  mkdirSync(obeliskDir, { recursive: true });
  const schema = readFileSync(
    new URL('../packages/core/src/schema.sql', import.meta.url),
    'utf8',
  )
    .replace(', cursor TEXT);', ');')
    .replace(
      ", visibility TEXT DEFAULT 'visible',\n  input_tokens INTEGER, output_tokens INTEGER);",
      ');',
    );
  const db = new DatabaseSync(dbPath);
  db.exec(schema);
  db.prepare(`
    INSERT INTO sessions (id,title,jsonl_path,source)
    VALUES (?,?,?,?)
  `).run('legacy-recovery', 'Legacy recovery', '/missing/session.jsonl', 'claude');
  db.prepare(`
    INSERT INTO messages (
      uuid,session_id,type,role,text,content_type,visibility,source
    ) VALUES (?,?,?,?,?,?,?,?)
  `).run('legacy-recovery-message', 'legacy-recovery', 'user', 'user', 'legacy recovery', 'text', 'visible', 'claude');
  db.prepare(`
    INSERT INTO summaries (id,session_id,timestamp,source,content)
    VALUES (?,?,?,?,?)
  `).run('legacy-summary', 'legacy-recovery', '2026-08-05T00:00:00Z', 'compaction', 'summary');
  db.prepare(`
    INSERT INTO index_state (jsonl_path,mtime,lines_processed)
    VALUES ('__last_build__',?,0)
  `).run(Date.now());
  db.close();
  writeFileSync(join(obeliskDir, 'settings.json'), '{broken');

  const scriptPath = join(home, 'legacy-recovery-query.mjs');
  writeFileSync(scriptPath, `
    return {
      summaries: summaries('legacy-recovery').map(summary => summary.id),
      raw: raw('legacy-recovery-message')
    };
  `);
  const result = runRuntime(['--query', scriptPath], { home });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /index refresh skipped/);
  assert.deepEqual(JSON.parse(result.stdout), {
    summaries: ['legacy-summary'],
    raw: null,
  });
  const migrated = new DatabaseSync(dbPath, { readOnly: true });
  assert.ok(migrated.prepare('PRAGMA table_info(index_state)').all().some(row => row.name === 'cursor'));
  assert.ok(migrated.prepare('PRAGMA table_info(summaries)').all().some(row => row.name === 'visibility'));
  migrated.close();
});

test('runtime indexes Codex root sessions into the shared query helpers', () => {
  const home = tempHome();
  const codexSessionDir = join(home, '.codex', 'sessions', '2026', '06', '15');
  mkdirSync(codexSessionDir, { recursive: true });

  const codexId = '019ec6ee-cebd-7431-9c93-ceec89a98a5f';
  writeFileSync(join(codexSessionDir, `rollout-2026-06-15T00-19-59-${codexId}.jsonl`), [
    JSON.stringify({
      timestamp: '2026-06-14T16:19:59.842Z',
      type: 'session_meta',
      payload: {
        id: codexId,
        timestamp: '2026-06-14T16:19:59.842Z',
        cwd: '/tmp/obelisk-runtime',
        cli_version: '0.135.0-alpha.1',
        source: 'vscode',
        git: { branch: 'feat/codex' },
      },
    }),
    JSON.stringify({
      timestamp: '2026-06-14T16:20:00.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'codex user asks for runtime indexing', images: [], local_images: [], text_elements: [] },
    }),
    JSON.stringify({
      timestamp: '2026-06-14T16:20:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'developer replay should stay out of visible search' }],
      },
    }),
    JSON.stringify({
      timestamp: '2026-06-14T16:20:02.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', phase: 'final_answer', message: 'codex assistant replies from runtime' },
    }),
    JSON.stringify({
      timestamp: '2026-06-14T16:20:03.000Z',
      type: 'response_item',
      payload: { type: 'function_call', call_id: 'call_codex_1', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
    }),
    JSON.stringify({
      timestamp: '2026-06-14T16:20:04.000Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call_codex_1', output: '/tmp/obelisk-runtime' },
    }),
    '',
  ].join('\n'));

  const scriptPath = join(home, 'query.mjs');
  writeFileSync(scriptPath, `
    const sid = ${JSON.stringify(`codex:${codexId}`)};
    return {
      sessions: sessions({ source: 'codex', limit: 5 }).map(s => ({
        id: s.id,
        source: s.source,
        project: s.project,
        project_path: s.project_path,
        git_branch: s.git_branch,
        version: s.version,
        message_count: s.message_count
      })),
      messages: thread(sid).map(m => ({ role: m.role, text: m.text, source: m.source, content_type: m.content_type })),
      search: search('runtime indexing', { source: 'codex', limit: 5 }).map(h => ({
        uuid: h.message.uuid,
        message_source: h.message.source,
        session_source: h.session.source
      })),
      developerReplay: search('developer replay', { source: 'codex', limit: 5 }).length,
      rawHasEventLine: raw(${JSON.stringify(`codex:${codexId}:000002`)}, { limit: 1000 })?.text.includes('codex user asks for runtime indexing') || false,
      tool: sql('SELECT id, message_uuid, session_id, name FROM tool_calls WHERE id=?', ${JSON.stringify(`codex:${codexId}:call_codex_1`)})[0],
      toolResult: sql('SELECT tool_use_id, message_uuid, session_id, content FROM tool_results WHERE tool_use_id=?', ${JSON.stringify(`codex:${codexId}:call_codex_1`)})[0],
      overviewSources: overview({ limit: 5 }).totals.sources
    };
  `);

  const result = runRuntime(['--query', scriptPath], { home });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.sessions, [{
    id: `codex:${codexId}`,
    source: 'codex',
    project: '-tmp-obelisk-runtime',
    project_path: normalize('/tmp/obelisk-runtime'),
    git_branch: 'feat/codex',
    version: '0.135.0-alpha.1',
    message_count: 3,
  }]);
  assert.deepEqual(payload.messages.map(m => [m.role, m.text, m.source, m.content_type]), [
    ['user', 'codex user asks for runtime indexing', 'codex', 'text'],
    ['assistant', 'codex assistant replies from runtime', 'codex', 'text'],
    ['assistant', null, 'codex', 'tool_use'],
  ]);
  assert.equal(payload.search[0].message_source, 'codex');
  assert.equal(payload.search[0].session_source, 'codex');
  assert.equal(payload.developerReplay, 0);
  assert.equal(payload.rawHasEventLine, true);
  assert.equal(payload.tool.session_id, `codex:${codexId}`);
  assert.equal(payload.tool.message_uuid, `codex:${codexId}:000005`);
  assert.equal(payload.toolResult.message_uuid, `codex:${codexId}:000005`);
  assert.equal(payload.toolResult.content, '/tmp/obelisk-runtime');
  assert.ok(payload.overviewSources.some(s => s.source === 'codex' && s.session_count === 1));
});

test('runtime indexes Codex archived sessions into the shared query helpers', () => {
  const home = tempHome();
  const archiveDir = join(home, '.codex', 'archived_sessions');
  mkdirSync(archiveDir, { recursive: true });

  const codexId = '019ec6ee-cebd-7431-9c93-ceec89a98a5e';
  writeFileSync(join(archiveDir, `rollout-2026-06-15T00-19-59-${codexId}.jsonl`), [
    JSON.stringify({
      timestamp: '2026-06-14T16:19:59.842Z',
      type: 'session_meta',
      payload: {
        id: codexId,
        timestamp: '2026-06-14T16:19:59.842Z',
        cwd: '/tmp/obelisk-archive-runtime',
        source: 'cli',
      },
    }),
    JSON.stringify({
      timestamp: '2026-06-14T16:20:00.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'archived runtime indexing sentinel' },
    }),
    '',
  ].join('\n'));

  const scriptPath = join(home, 'query.mjs');
  writeFileSync(scriptPath, `
    const sid = ${JSON.stringify(`codex:${codexId}`)};
    return {
      session: sessions({ source: 'codex', limit: 5 })
        .filter(session => session.id === sid)
        .map(({ id, project, project_path, message_count, source }) => ({ id, project, project_path, message_count, source }))[0],
      message: thread(sid)[0]?.text,
      rawHasMessage: raw(${JSON.stringify(`codex:${codexId}:000002`)}, { limit: 1000 })?.text.includes('archived runtime indexing sentinel') || false,
    };
  `);

  const result = runRuntime(['--query', scriptPath], { home });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), {
    session: {
      id: `codex:${codexId}`,
      project: '-tmp-obelisk-archive-runtime',
      project_path: normalize('/tmp/obelisk-archive-runtime'),
      message_count: 1,
      source: 'codex',
    },
    message: 'archived runtime indexing sentinel',
    rawHasMessage: true,
  });
});

test('runtime raw lookup uses the configured Codex root for child sessions', () => {
  const home = tempHome();
  const codexDir = join(home, 'custom-codex');
  const codexSessionDir = join(codexDir, 'sessions', '2026', '08', '04');
  const parentId = '019ec6ee-cebd-7431-9c93-ceec89a98a5f';
  const childId = '019ec739-9f75-7a02-ba2a-371986e23823';
  mkdirSync(codexSessionDir, { recursive: true });
  mkdirSync(join(home, '.obelisk'), { recursive: true });
  writeFileSync(join(home, '.obelisk', 'settings.json'), JSON.stringify({
    providerRoots: { codex: codexDir },
  }));
  writeFileSync(join(codexSessionDir, `a-parent-${parentId}.jsonl`), [
    JSON.stringify({
      timestamp: '2026-08-04T10:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: parentId,
        timestamp: '2026-08-04T10:00:00.000Z',
        cwd: '/tmp/custom-codex-runtime',
        source: 'cli',
      },
    }),
    '',
  ].join('\n'));
  writeFileSync(join(codexSessionDir, `b-child-${childId}.jsonl`), [
    JSON.stringify({
      timestamp: '2026-08-04T10:00:01.000Z',
      type: 'session_meta',
      payload: {
        id: childId,
        timestamp: '2026-08-04T10:00:01.000Z',
        cwd: '/tmp/custom-codex-runtime',
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: parentId,
              agent_nickname: 'Plato',
              agent_role: 'worker',
            },
          },
        },
      },
    }),
    JSON.stringify({
      timestamp: '2026-08-04T10:00:02.000Z',
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: 'custom Codex child raw sentinel',
        images: [],
        local_images: [],
        text_elements: [],
      },
    }),
    '',
  ].join('\n'));
  const scriptPath = join(home, 'query.mjs');
  writeFileSync(
    scriptPath,
    `return raw(${JSON.stringify(`codex:${childId}:000002`)}, { limit: 1000 });`,
  );

  const result = runRuntime(['--query', scriptPath], { home });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const raw = JSON.parse(result.stdout);
  assert.match(raw.text, /custom Codex child raw sentinel/);
  assert.equal(raw.visibility, 'visible');
});

test('runtime skips Codex guardian review threads', () => {
  const home = tempHome();
  const codexSessionDir = join(home, '.codex', 'sessions', '2026', '06', '15');
  mkdirSync(codexSessionDir, { recursive: true });

  const guardianId = '019ed5c4-8d52-7bc0-91f3-447a15e987d1';
  writeFileSync(join(codexSessionDir, `rollout-2026-06-15T02-12-00-${guardianId}.jsonl`), [
    JSON.stringify({
      timestamp: '2026-06-14T18:12:00.000Z',
      type: 'session_meta',
      payload: {
        id: guardianId,
        timestamp: '2026-06-14T18:12:00.000Z',
        cwd: '/tmp/obelisk-runtime',
        cli_version: '0.135.0-alpha.1',
        thread_source: 'subagent',
        source: { subagent: { other: 'guardian' } },
      },
    }),
    JSON.stringify({
      timestamp: '2026-06-14T18:12:01.000Z',
      type: 'turn_context',
      payload: { cwd: '/tmp/obelisk-runtime', model: 'codex-auto-review' },
    }),
    JSON.stringify({
      timestamp: '2026-06-14T18:12:02.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'approval guardian prompt', images: [], local_images: [], text_elements: [] },
    }),
    JSON.stringify({
      timestamp: '2026-06-14T18:12:03.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', phase: 'final_answer', message: '{"outcome":"allow"}' },
    }),
    '',
  ].join('\n'));

  const scriptPath = join(home, 'query.mjs');
  writeFileSync(scriptPath, `
    const sid = ${JSON.stringify(`codex:${guardianId}`)};
    return {
      sessions: sessions({ source: 'codex', limit: 5 }).map(s => s.id),
      searchCount: search('approval', { source: 'codex', limit: 5 }).length,
      sessionRows: sql('SELECT COUNT(*) AS c FROM sessions WHERE id=?', sid)[0].c,
      messageRows: sql('SELECT COUNT(*) AS c FROM messages WHERE session_id=?', sid)[0].c,
      subagentRows: sql('SELECT COUNT(*) AS c FROM subagents WHERE agent_id=?', sid)[0].c
    };
  `);

  const result = runRuntime(['--query', scriptPath], { home });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), {
    sessions: [],
    searchCount: 0,
    sessionRows: 0,
    messageRows: 0,
    subagentRows: 0,
  });
});

test('runtime removes stale Codex guardian rows when the JSONL was already indexed', () => {
  const home = tempHome();
  const codexSessionDir = join(home, '.codex', 'sessions', '2026', '06', '15');
  mkdirSync(codexSessionDir, { recursive: true });

  const initScriptPath = join(home, 'init.mjs');
  writeFileSync(initScriptPath, 'return sessions({ source: "codex", limit: 5 }).length;');
  assert.equal(runRuntime(['--query', initScriptPath], { home }).status, 0);

  const guardianId = '019ed5c4-8d52-7bc0-91f3-447a15e987d1';
  const guardianSessionId = `codex:${guardianId}`;
  const jsonlPath = join(codexSessionDir, `rollout-2026-06-15T02-12-00-${guardianId}.jsonl`);
  writeFileSync(jsonlPath, [
    JSON.stringify({
      timestamp: '2026-06-14T18:12:00.000Z',
      type: 'session_meta',
      payload: {
        id: guardianId,
        timestamp: '2026-06-14T18:12:00.000Z',
        cwd: '/tmp/obelisk-runtime',
        cli_version: '0.135.0-alpha.1',
        thread_source: 'subagent',
        source: { subagent: { other: 'guardian' } },
      },
    }),
    JSON.stringify({
      timestamp: '2026-06-14T18:12:01.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'stale approval guardian prompt', images: [], local_images: [], text_elements: [] },
    }),
    '',
  ].join('\n'));

  const db = new DatabaseSync(join(home, '.obelisk', 'obelisk.sqlite'));
  db.prepare('INSERT INTO sessions (id,jsonl_path,source,message_count) VALUES (?,?,?,?)').run(guardianSessionId, jsonlPath, 'codex', 1);
  db.prepare('INSERT INTO messages (uuid,session_id,type,timestamp,role,text,content_type,source) VALUES (?,?,?,?,?,?,?,?)')
    .run(`${guardianSessionId}:000002`, guardianSessionId, 'user', '2026-06-14T18:12:01.000Z', 'user', 'stale approval guardian prompt', 'text', 'codex');
  db.prepare('INSERT INTO tool_calls (id,message_uuid,session_id,name,input_json,file_path) VALUES (?,?,?,?,?,?)')
    .run('codex:call_guardian', `${guardianSessionId}:000002`, guardianSessionId, 'exec_command', '{}', null);
  db.prepare('INSERT INTO tool_results (tool_use_id,message_uuid,session_id,content,file_path,is_error) VALUES (?,?,?,?,?,?)')
    .run('codex:call_guardian', `${guardianSessionId}:000002`, guardianSessionId, 'ok', null, 0);
  db.prepare('INSERT INTO subagents (agent_id,session_id) VALUES (?,?)').run(guardianSessionId, guardianSessionId);
  db.prepare('INSERT OR REPLACE INTO index_state (jsonl_path,mtime,lines_processed) VALUES (?,?,?)')
    .run(jsonlPath, statSync(jsonlPath).mtimeMs, 2);
  db.prepare("UPDATE index_state SET mtime=? WHERE jsonl_path='__last_build__'").run(Date.now() - 31000);
  db.close();

  const scriptPath = join(home, 'query.mjs');
  writeFileSync(scriptPath, `
    const sid = ${JSON.stringify(guardianSessionId)};
    return {
      sessions: sessions({ source: 'codex', limit: 5 }).map(s => s.id),
      searchCount: search('stale', { source: 'codex', limit: 5 }).length,
      sessionRows: sql('SELECT COUNT(*) AS c FROM sessions WHERE id=?', sid)[0].c,
      messageRows: sql('SELECT COUNT(*) AS c FROM messages WHERE session_id=?', sid)[0].c,
      toolRows: sql('SELECT COUNT(*) AS c FROM tool_calls WHERE session_id=?', sid)[0].c,
      resultRows: sql('SELECT COUNT(*) AS c FROM tool_results WHERE session_id=?', sid)[0].c,
      subagentRows: sql('SELECT COUNT(*) AS c FROM subagents WHERE agent_id=?', sid)[0].c
    };
  `);

  const result = runRuntime(['--query', scriptPath], { home });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), {
    sessions: [],
    searchCount: 0,
    sessionRows: 0,
    messageRows: 0,
    toolRows: 0,
    resultRows: 0,
    subagentRows: 0,
  });
});

test('runtime maps Codex child threads onto subagents', () => {
  const home = tempHome();
  const codexSessionDir = join(home, '.codex', 'sessions', '2026', '06', '15');
  mkdirSync(codexSessionDir, { recursive: true });

  const parentId = '019ec6ee-cebd-7431-9c93-ceec89a98a5f';
  const childId = '019ec739-9f75-7a02-ba2a-371986e23823';
  writeFileSync(join(codexSessionDir, `rollout-2026-06-15T00-19-59-${parentId}.jsonl`), [
    JSON.stringify({
      timestamp: '2026-06-14T16:19:59.842Z',
      type: 'session_meta',
      payload: {
        id: parentId,
        timestamp: '2026-06-14T16:19:59.842Z',
        cwd: '/tmp/obelisk-runtime',
        cli_version: '0.135.0-alpha.1',
        source: 'vscode',
      },
    }),
    JSON.stringify({
      timestamp: '2026-06-14T16:20:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'collab_agent_spawn_end',
        call_id: 'call_spawn_1',
        sender_thread_id: parentId,
        new_thread_id: childId,
        new_agent_nickname: 'Plato',
        new_agent_role: 'worker',
        prompt: 'inspect skill-side codex indexing',
      },
    }),
    '',
  ].join('\n'));
  writeFileSync(join(codexSessionDir, `rollout-2026-06-15T01-41-42-${childId}.jsonl`), [
    JSON.stringify({
      timestamp: '2026-06-14T17:41:42.924Z',
      type: 'session_meta',
      payload: {
        id: childId,
        timestamp: '2026-06-14T17:41:42.924Z',
        cwd: '/tmp/obelisk-runtime',
        cli_version: '0.135.0-alpha.1',
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: parentId,
              agent_nickname: 'Plato',
              agent_role: 'worker',
            },
          },
        },
        agent_nickname: 'Plato',
        agent_role: 'worker',
      },
    }),
    JSON.stringify({
      timestamp: '2026-06-14T17:41:43.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'subagent prompt', images: [], local_images: [], text_elements: [] },
    }),
    JSON.stringify({
      timestamp: '2026-06-14T17:41:44.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', phase: 'final_answer', message: 'subagent answer' },
    }),
    '',
  ].join('\n'));

  const scriptPath = join(home, 'query.mjs');
  writeFileSync(scriptPath, `
    return {
      parentSessions: sessions({ source: 'codex', limit: 5 }).map(s => s.id),
      subagents: subagents({ source: 'codex', limit: 5 }).map(sa => ({
        agent_id: sa.agent_id,
        session_id: sa.session_id,
        parent_tool_use_id: sa.parent_tool_use_id,
        agent_type: sa.agent_type,
        description: sa.description,
        messageCount: sa.messageCount
      })),
      childMessages: sql(
        'SELECT session_id, agent_id, is_sidechain, source, text FROM messages WHERE agent_id=? ORDER BY timestamp, uuid',
        ${JSON.stringify(`codex:${childId}`)}
      )
    };
  `);

  const result = runRuntime(['--query', scriptPath], { home });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.parentSessions, [`codex:${parentId}`]);
  assert.deepEqual(payload.subagents, [{
    agent_id: `codex:${childId}`,
    session_id: `codex:${parentId}`,
    parent_tool_use_id: `codex:${parentId}:call_spawn_1`,
    agent_type: 'worker',
    description: 'Plato',
    messageCount: 2,
  }]);
  assert.deepEqual(payload.childMessages.map(m => [m.session_id, m.agent_id, m.is_sidechain, m.source, m.text]), [
    [`codex:${parentId}`, `codex:${childId}`, 1, 'codex', 'subagent prompt'],
    [`codex:${parentId}`, `codex:${childId}`, 1, 'codex', 'subagent answer'],
  ]);
});
