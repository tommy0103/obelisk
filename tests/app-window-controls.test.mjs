// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";

const preloadUrl = new URL('../app/src/preload/index.ts', import.meta.url);
const preloadDir = fileURLToPath(new URL('.', preloadUrl));

function esmResolve(specifier) {
  return execFileSync(
    process.execPath,
    ['--input-type=module', '-e', `process.stdout.write(import.meta.resolve(${JSON.stringify(specifier)}))`],
    {cwd: preloadDir, encoding: 'utf8'}
  ).trim()
}

test('window controls go through one win:control channel with the action as payload', async () => {
  const invokes = [];
  let api;
  const electron = mock.module(esmResolve('electron'), {
    namedExports: {
      contextBridge: {
        exposeInMainWorld(_name, exposedApi) { api = exposedApi; },
      },
      ipcRenderer: {
        invoke(...args) { invokes.push(args); return Promise.resolve(null); },
        on() {},
        removeListener() {},
      },
    },
  });

  try {
    await import(`${preloadUrl.href}?window-controls=${Date.now()}`)

    await api.windowControl('minimize');
    assert.deepEqual(invokes.at(-1), ['win:control', 'minimize']);
    await api.windowControl('toggle-maximize');
    assert.deepEqual(invokes.at(-1), ['win:control', 'toggle-maximize']);
    await api.windowControl('close');
    assert.deepEqual(invokes.at(-1), ['win:control', 'close']);
  } finally {
    electron.restore();
    mock.reset();
  }
});

test('maximize state reaches the renderer through onWindowState and unsubscribes cleanly', async () => {
  const subscribed = [];
  const removed = [];
  let api;
  const electron = mock.module(esmResolve('electron'), {
    namedExports: {
      contextBridge: {
        exposeInMainWorld(_name, exposedApi) { api = exposedApi; },
      },
      ipcRenderer: {
        invoke() { return Promise.resolve(null); },
        on(channel, listener) { subscribed.push([channel, listener]); },
        removeListener(channel, listener) { removed.push([channel, listener]); }
      },
    },
  });

  try {
    await import(`${preloadUrl.href}?window-state=${Date.now()}`);
    const seen = [];
    const unsubscribe = api.onWindowState((payload) => seen.push(payload));

    assert.equal(subscribed.length, 1, 'the subscription uses one channel');
    const [channel, listener] = subscribed[0];
    assert.equal(channel, 'obelisk:window-state', 'the maximize state is pushed on obelisk:window-state');

    listener({}, { maximized: true });
    assert.deepEqual(seen, [{ maximized: true }], 'the callback receives the pushed payload');

    unsubscribe();
    assert.deepEqual(removed, [[channel, listener]], 'unsubscribing removes the same listener');
  } finally {
    electron.restore();
    mock.reset();
  }
});
