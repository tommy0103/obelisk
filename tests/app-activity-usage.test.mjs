// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const preloadUrl = new URL('../app/src/preload/index.ts', import.meta.url);
const preloadDir = fileURLToPath(new URL('.', preloadUrl));

function esmResolve(specifier) {
  return execFileSync(
    process.execPath,
    ['--input-type=module', '-e', `process.stdout.write(import.meta.resolve(${JSON.stringify(specifier)}))`],
    { cwd: preloadDir, encoding: 'utf8' },
  ).trim();
}

test('Activity requests usage across all indexed providers', () => {
  const source = readFileSync(new URL('../app/src/renderer/src/views/Activity.vue', import.meta.url), 'utf8');
  assert.match(source, /getUsageStats\(\{\s*source:\s*['"]all['"]\s*\}\)/);
  assert.match(source, /onIndexUpdated\?\.\(\(\)\s*=>\s*\{?\s*(?:void\s+)?loadUsageStats\(\)/s);
  assert.match(source, /Array\.from\(\{\s*length:\s*loadedMonths\.value\s*\}/);
  assert.doesNotMatch(source, /monthBlocks\s*=\s*ref\(/);
});

test('preload forwards usage source options to the main process', async () => {
  const calls = [];
  let api;
  const electron = mock.module(esmResolve('electron'), {
    namedExports: {
      contextBridge: {
        exposeInMainWorld(_name, exposedApi) {
          api = exposedApi;
        },
      },
      ipcRenderer: {
        invoke(...args) {
          calls.push(args);
          return Promise.resolve(null);
        },
        on() {},
        removeListener() {},
      },
    },
  });

  try {
    await import(`${preloadUrl.href}?activity-usage=${Date.now()}`);
    await api.getUsageStats({ source: 'all' });
    assert.deepEqual(calls.at(-1), ['db:getUsageStats', { source: 'all' }]);
  } finally {
    electron.restore();
    mock.reset();
  }
});
