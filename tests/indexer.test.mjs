// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { healWorkflowParentLinks, inferProjectPath, refreshSessionProjectPaths, shouldSkipBuild } from '../packages/core/src/indexer.ts';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

test('inferProjectPath preserves hyphens from observed cwd', () => {
  assert.equal(
    inferProjectPath('-Users-dev-Code-quiet-zero', ['/Users/dev/Code/quiet-zero']),
    '/Users/dev/Code/quiet-zero',
  );
  assert.equal(
    inferProjectPath('-Users-dev-Code-research-widget-svc', ['/Users/dev/Code/research/widget-svc']),
    '/Users/dev/Code/research/widget-svc',
  );
});

test('inferProjectPath falls back to legacy slug decoding without cwd evidence', () => {
  assert.equal(
    inferProjectPath('-Users-dev-Code-quiet-zero', []),
    '/Users/dev/Code/quiet/zero',
  );
});

test('refreshSessionProjectPaths repairs indexed sessions from message cwd', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, project TEXT, project_path TEXT
    );
    CREATE TABLE messages (
      uuid TEXT PRIMARY KEY, session_id TEXT, timestamp TEXT, cwd TEXT
    );
  `);
  db.prepare('INSERT INTO sessions (id, project, project_path) VALUES (?, ?, ?)').run(
    'sid-1',
    '-Users-dev-Code-quiet-zero',
    '/Users/dev/Code/quiet/zero',
  );
  db.prepare('INSERT INTO messages (uuid, session_id, timestamp, cwd) VALUES (?, ?, ?, ?)').run(
    'msg-1',
    'sid-1',
    '2026-06-10T10:00:00Z',
    '/Users/dev/Code/quiet-zero',
  );

  refreshSessionProjectPaths(db);

  assert.equal(
    db.prepare('SELECT project_path FROM sessions WHERE id=?').get('sid-1').project_path,
    '/Users/dev/Code/quiet-zero',
  );
  db.close();
});

test('shouldSkipBuild treats a fresh heartbeat alone as daemon write ownership', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE index_state (
      jsonl_path TEXT PRIMARY KEY, mtime REAL, lines_processed INTEGER
    );
  `);
  db.prepare('INSERT INTO index_state (jsonl_path, mtime, lines_processed) VALUES (?, ?, 0)').run(
    '__app_heartbeat__',
    100000,
  );

  assert.deepEqual(
    shouldSkipBuild(db, { now: 110000 }),
    { skip: true, reason: 'daemon_active' },
  );

  db.prepare('DELETE FROM index_state').run();

  db.prepare('INSERT INTO index_state (jsonl_path, mtime, lines_processed) VALUES (?, ?, 0)').run(
    '__app_last_successful_build__',
    100000,
  );

  assert.equal(shouldSkipBuild(db, { now: 110000 }).skip, false);
  assert.equal(shouldSkipBuild(db, { now: 200000 }).skip, false);
  db.close();
});

test('healWorkflowParentLinks links null-parent workflows by unique run id', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE tool_calls (
      id TEXT PRIMARY KEY, message_uuid TEXT, session_id TEXT,
      name TEXT, presentation TEXT, input_json TEXT, file_path TEXT
    );
    CREATE TABLE tool_results (
      tool_use_id TEXT PRIMARY KEY, message_uuid TEXT, session_id TEXT,
      content TEXT, file_path TEXT, is_error INTEGER DEFAULT 0
    );
    CREATE TABLE workflows (
      run_id TEXT PRIMARY KEY, session_id TEXT, parent_tool_use_id TEXT, task_id TEXT,
      script TEXT, result_json TEXT, timestamp TEXT, agent_count INTEGER DEFAULT 0,
      duration_ms INTEGER, total_tokens INTEGER, status TEXT, workflow_name TEXT
    );
  `);
  const addCall = db.prepare('INSERT INTO tool_calls (id, session_id, name) VALUES (?, ?, ?)');
  const addResult = db.prepare('INSERT INTO tool_results (tool_use_id, session_id, content) VALUES (?, ?, ?)');
  const addWorkflow = db.prepare('INSERT INTO workflows (run_id, session_id, parent_tool_use_id, workflow_name) VALUES (?, ?, ?, ?)');
  // Two same-name runs: only the unique run id may decide the parent.
  addCall.run('old-call', 'sid-1', 'Workflow');
  addResult.run('old-call', 'sid-1', 'Run ID: old-run\nSummary: same-name');
  addCall.run('new-call', 'sid-1', 'Workflow');
  addResult.run('new-call', 'sid-1', 'Run ID: new-run\nSummary: same-name');
  addWorkflow.run('old-run', 'sid-1', null, 'same-name');
  addWorkflow.run('new-run', 'sid-1', null, 'same-name');
  // Already-linked and unresolvable rows must be left alone.
  addWorkflow.run('linked-run', 'sid-1', 'existing-call', 'other');
  addWorkflow.run('orphan-run', 'sid-1', null, 'other');
  // A non-Workflow tool result mentioning the run id must not match.
  addCall.run('bash-call', 'sid-1', 'Bash');
  addResult.run('bash-call', 'sid-1', 'log line mentioning orphan-run');
  // Cross-session results must not leak into this session's workflows.
  addCall.run('alien-call', 'sid-2', 'Workflow');
  addResult.run('alien-call', 'sid-2', 'Run ID: orphan-run');

  healWorkflowParentLinks(db);

  const parentOf = runId => db.prepare('SELECT parent_tool_use_id FROM workflows WHERE run_id=?').get(runId).parent_tool_use_id;
  assert.equal(parentOf('old-run'), 'old-call');
  assert.equal(parentOf('new-run'), 'new-call');
  assert.equal(parentOf('linked-run'), 'existing-call');
  assert.equal(parentOf('orphan-run'), null);
  db.close();
});
