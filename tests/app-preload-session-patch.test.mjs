// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { execFileSync } from 'node:child_process';
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const preloadUrl = new URL('../app/src/preload/index.ts', import.meta.url);
let loadSequence = 0;

async function loadPatchBridge(t) {
  const calls = [];
  let api;
  const electronUrl = execFileSync(process.execPath, [
    '--input-type=module', '-e', "process.stdout.write(import.meta.resolve('electron'))",
  ], { cwd: fileURLToPath(new URL('.', preloadUrl)), encoding: 'utf8' }).trim();
  const electron = mock.module(electronUrl, {
    namedExports: {
      contextBridge: { exposeInMainWorld: (_name, exposed) => { api = exposed; } },
      ipcRenderer: { invoke: async (...args) => { calls.push(args); return null; } },
    },
  });
  t.after(() => { electron.restore(); mock.reset(); });
  await import(`${preloadUrl.href}?patch-bridge=${++loadSequence}`);
  return { api, calls };
}

test('patch bridge decodes the primitive cursor and retains object callers', async t => {
  const { api, calls } = await loadPatchBridge(t);
  const cursor = { messages: { 'message-1': '0@fingerprint' } };
  await api.getSessionPatch('session-1', JSON.stringify(cursor));
  await api.getSessionPatch('session-1', cursor);
  assert.deepEqual(calls, [
    ['db:getSessionPatch', 'session-1', cursor],
    ['db:getSessionPatch', 'session-1', cursor],
  ]);
});

test('malformed serialized patch cursors reject before reaching main IPC', async t => {
  const { api, calls } = await loadPatchBridge(t);
  await assert.rejects(api.getSessionPatch('session-1', '{broken'), SyntaxError);
  assert.equal(calls.length, 0);
});
