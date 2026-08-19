// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// The default watchProjects implementation uses one recursive fs.watch per
// root (O(1) descriptors) instead of a per-path watcher. These tests exercise
// the real watcher: deep-file events must reach buildIndex with the resolved
// absolute path, non-transcript files must be filtered out, and the descriptor
// footprint must not scale with the number of files in the tree — the failure
// mode that motivated the change (EMFILE on a ~23k-path transcript tree).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';

import { createIndexerService } from '../app/src/main/indexer-service.ts';
import { makeTempDir } from './temp-dirs.mjs';

const fdCount = () => fs.readdirSync('/dev/fd').length;

async function waitFor(cond, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

test('default watcher reports deep new files with O(1) descriptors', async () => {
  const root = makeTempDir('obelisk-recwatch-');
  // A pre-existing populated tree: per-path watchers would need one fd each.
  for (let i = 0; i < 50; i++) {
    const d = join(root, `proj-${i}`);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(join(d, 'old.jsonl'), '{}\n');
  }

  const builds = [];
  const before = fdCount();
  const service = createIndexerService({
    watchDirs: [root],
    debounceMs: 10,
    stabilityMs: 0,
    buildIndex: ({ reason, changedPaths }) => { builds.push({ reason, changedPaths }); },
    writeHeartbeat: () => {},
    logger: { warn: () => {} },
  });
  service.start({ buildOnStart: false });
  const after = fdCount();
  assert.ok(after - before <= 5,
    `watching a 100-entry tree must not cost per-path descriptors (fd ${before} -> ${after})`);

  // A brand-new nested directory plus transcript — the worst case for
  // per-path watchers, which have no watcher on the new directory yet.
  const deep = join(root, 'proj-new', 'sess-id', 'subagents');
  fs.mkdirSync(deep, { recursive: true });
  const newFile = join(deep, 'agent-1.jsonl');
  fs.writeFileSync(newFile, '{"probe":1}\n');

  const sawIt = await waitFor(() =>
    builds.some((b) => (b.changedPaths ?? []).some((p) => p.endsWith('agent-1.jsonl'))));
  assert.ok(sawIt, 'the deep new transcript reached buildIndex as a changed path');
  const hit = builds.find((b) => (b.changedPaths ?? []).some((p) => p.endsWith('agent-1.jsonl')));
  assert.ok(hit.changedPaths.every((p) => p.startsWith(root)),
    'changed paths are resolved to absolute paths under the watched root');

  service.stop();
  await service.idle();
});

test('default watcher filters non-transcript files', async () => {
  const root = makeTempDir('obelisk-recwatch-filter-');
  const builds = [];
  const service = createIndexerService({
    watchDirs: [root],
    debounceMs: 10,
    stabilityMs: 0,
    buildIndex: (args) => { builds.push(args); },
    writeHeartbeat: () => {},
    logger: { warn: () => {} },
  });
  service.start({ buildOnStart: false });

  fs.writeFileSync(join(root, 'noise.txt'), 'not a transcript');
  // Give a wrong-positive time to surface, then send a real one as a control.
  await new Promise((r) => setTimeout(r, 700));
  const noiseBuilds = builds.length;
  fs.writeFileSync(join(root, 'real.json'), '{}');
  const sawReal = await waitFor(() =>
    builds.slice(noiseBuilds).some((b) => (b.changedPaths ?? []).some((p) => p.endsWith('real.json'))));

  assert.equal(noiseBuilds, 0, 'a .txt write alone must not schedule a build');
  assert.ok(sawReal, 'the .json control write does schedule a build');

  service.stop();
  await service.idle();
});
