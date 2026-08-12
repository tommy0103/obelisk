// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// End-to-end regression test for the workflow parent-link race: a workflow run
// json can be indexed before its Workflow tool_result lands in the main
// transcript. The workflow unit is then never re-parsed (its file no longer
// changes), so the finalize-time SQL heal must fill parent_tool_use_id on a
// later refresh. This drives the real core buildIndex path (the CLI refresh
// path), which never passes changedPaths.
//
// HOME must point at the fixture root BEFORE any core module is imported: the
// core db path is derived from homedir() at module load time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from './temp-dirs.mjs';

const home = makeTempDir('obelisk-workflow-heal-');
process.env.HOME = home;
process.env.USERPROFILE = home;

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const { buildIndex } = await import('../packages/core/src/indexer.ts');
const { createClaudeProvider } = await import('../packages/core/src/providers/claude.ts');
const { createProviderRegistry } = await import('../packages/core/src/providers/registry.ts');

test('a workflow indexed before its tool_result heals its parent link on the next refresh', () => {
  const claudeDir = join(home, '.claude');
  const projectDir = join(claudeDir, 'projects', '-proj');
  const workflowDir = join(projectDir, 'sid-heal', 'workflows');
  mkdirSync(workflowDir, { recursive: true });
  const transcriptPath = join(projectDir, 'sid-heal.jsonl');
  writeFileSync(transcriptPath, [
    {
      uuid: 'msg-user', type: 'user', timestamp: '2026-06-10T10:00:00Z',
      message: { role: 'user', content: 'run the workflow' },
    },
    {
      uuid: 'msg-assistant', type: 'assistant', timestamp: '2026-06-10T10:00:05Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'wf-call', name: 'Workflow', input: {} }] },
    },
  ].map(line => JSON.stringify(line)).join('\n') + '\n');
  writeFileSync(join(workflowDir, 'run-1.json'), JSON.stringify({
    runId: 'run-1', workflowName: 'Review', status: 'running', workflowProgress: [],
  }));

  const registry = createProviderRegistry([createClaudeProvider({ rootDir: claudeDir })]);
  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');

  const first = buildIndex({ providerRegistry: registry });
  assert.equal(first.skip, false);
  const db = new DatabaseSync(dbPath);
  const parentOf = () => db.prepare('SELECT parent_tool_use_id FROM workflows WHERE run_id=?').get('run-1')?.parent_tool_use_id;
  // The tool_result has not reached the transcript yet: honest null.
  assert.equal(parentOf(), null);

  // The tool_result lands only now — the workflow run json does NOT change.
  appendFileSync(transcriptPath, `${JSON.stringify({
    uuid: 'msg-result', type: 'user', timestamp: '2026-06-10T10:01:00Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'wf-call', content: 'Run ID: run-1\nSummary: done' }] },
  })}\n`);

  const second = buildIndex({ providerRegistry: registry, ignoreRecentBuild: true });
  assert.equal(second.skip, false);
  assert.equal(parentOf(), 'wf-call');
  db.close();
});
