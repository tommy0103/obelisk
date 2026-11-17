// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Recap file IPC reads the recap directory without blocking the main thread; a missing
// directory or unreadable file still answers the way the renderer expects.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerRecapHandlers } from '../app/src/main/recap-handlers.ts';
import { makeTempDir } from './temp-dirs.mjs';

function recapHandlers(recapDir) {
  const handlers = new Map();
  registerRecapHandlers({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    BrowserWindow: {},
    clipboard: {},
    dialog: {},
    recapDir,
    preloadPath: '',
    rendererIndexPath: '',
  });
  // async, like ipcRenderer.invoke: a handler that throws reaches the caller as a rejection.
  return async (channel, ...args) => handlers.get(channel)(null, ...args);
}

test('recap:list is empty before any recap exists, then lists recap files newest first', async () => {
  const root = makeTempDir(`obelisk-recap-${Date.now()}`);
  const recapDir = join(root, 'recap');
  const invoke = recapHandlers(recapDir);
  try {
    assert.deepEqual(await invoke('recap:list'), []);
    mkdirSync(recapDir);
    writeFileSync(join(recapDir, '2026-w01.json'), '{}');
    writeFileSync(join(recapDir, '2026-w02.json'), '{}');
    writeFileSync(join(recapDir, 'notes.txt'), '');
    assert.deepEqual(await invoke('recap:list'), ['2026-w02.json', '2026-w01.json']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recap:list still fails when the recap path is not a directory', async () => {
  const root = makeTempDir(`obelisk-recap-file-${Date.now()}`);
  const recapDir = join(root, 'recap');
  writeFileSync(recapDir, '');
  try {
    await assert.rejects(() => recapHandlers(recapDir)('recap:list'), { code: 'ENOTDIR' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recap:read parses a recap, stays inside the recap directory, and answers null otherwise', async () => {
  const root = makeTempDir(`obelisk-recap-read-${Date.now()}`);
  const recapDir = join(root, 'recap');
  mkdirSync(recapDir);
  writeFileSync(join(recapDir, 'week.json'), JSON.stringify({ title: 'Week' }));
  writeFileSync(join(recapDir, 'broken.json'), '{');
  writeFileSync(join(root, 'outside.json'), JSON.stringify({ title: 'Outside' }));
  const invoke = recapHandlers(recapDir);
  try {
    assert.deepEqual(await invoke('recap:read', 'week.json'), { title: 'Week' });
    assert.equal(await invoke('recap:read', 'missing.json'), null);
    assert.equal(await invoke('recap:read', 'broken.json'), null);
    assert.equal(await invoke('recap:read', '../outside.json'), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
