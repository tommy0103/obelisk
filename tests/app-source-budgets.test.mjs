// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Budgets for patterns CONTRIBUTING forbids but existing code still uses.
// A change may lower a budget; it may not raise one. When you remove a use,
// lower the number here in the same change.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const mainDir = join(repoRoot, 'app', 'src', 'main');
const rendererDir = join(repoRoot, 'app', 'src', 'renderer');

function count(path, pattern) {
  return readFileSync(path, 'utf8').match(pattern)?.length ?? 0;
}

function filesUnder(dir, extension) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path, extension);
    return entry.name.endsWith(extension) ? [path] : [];
  });
}

// "No synchronous IO in the main process": a network mount or UNC path
// freezes the whole UI. indexer-worker.ts only runs in the worker thread.
// indexer.ts gets a budget, not an exemption: index.ts imports writeHeartbeat
// from it, which runs on the main thread.
const syncIoBudget = {
  'index.ts': 11,
  'rebuild-db-files.ts': 6,
  'file-reference.ts': 2,
  'indexer.ts': 8,
};
const workerModules = new Set(['indexer-worker.ts']);

test('main-process modules do not add synchronous IO calls', () => {
  const over = [];
  const under = [];
  for (const name of readdirSync(mainDir).filter(file => file.endsWith('.ts') && !workerModules.has(file))) {
    const used = count(join(mainDir, name), /\b\w+Sync\(/g);
    const budget = syncIoBudget[name] ?? 0;
    if (used > budget) over.push(`${name}: ${used} *Sync( calls, budget ${budget}; use fs.promises`);
    if (used < budget) under.push(`${name}: ${used} *Sync( calls; lower its budget in this test to ${used}`);
  }
  assert.deepEqual(over, []);
  assert.deepEqual(under, []);
});

// Transcript content is attacker-controlled. vue/no-v-html makes each v-html
// name why it is safe; this budget keeps new ones from being waved through.
const vHtmlBudget = 30;

test('renderer templates do not add v-html sinks', () => {
  const perFile = filesUnder(rendererDir, '.vue')
    .map(path => [relative(repoRoot, path), count(path, /\sv-html="/g)])
    .filter(([, used]) => used > 0);
  const used = perFile.reduce((sum, [, n]) => sum + n, 0);
  assert.ok(used <= vHtmlBudget, `${used} v-html uses, budget ${vHtmlBudget}; render through renderMarkdown()/escapeHTML(): ${JSON.stringify(perFile)}`);
  assert.equal(used, vHtmlBudget, `v-html uses fell to ${used}; lower vHtmlBudget in this test to ${used}`);
});
