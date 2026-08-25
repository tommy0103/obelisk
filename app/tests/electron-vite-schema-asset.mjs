// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { coreSchemaAssetPlugin } from '../electron-vite.schema-plugin.mjs';

const appDir = fileURLToPath(new URL('..', import.meta.url));
const electronViteCli = fileURLToPath(
  new URL('../node_modules/electron-vite/bin/electron-vite.js', import.meta.url),
);

test('electron-vite builds emit the executable Core schema beside the main modules', async () => {
  execFileSync(process.execPath, [electronViteCli, 'build'], {
    cwd: appDir,
    encoding: 'utf8',
  });

  const expected = await readFile(new URL('../../packages/core/src/schema.sql', import.meta.url), 'utf8');
  const emitted = await readFile(new URL('../out/main/schema.sql', import.meta.url), 'utf8');
  assert.equal(emitted, expected);
});

test('the Core schema asset participates in electron-vite dev rebuilds', async () => {
  const watched = [];
  const emitted = [];
  const plugin = coreSchemaAssetPlugin();
  const context = {
    addWatchFile(path) { watched.push(path); },
    emitFile(asset) { emitted.push(asset); },
  };

  plugin.buildStart.call(context);
  await plugin.generateBundle.call(context);

  assert.equal(watched.length, 1);
  assert.equal(emitted[0]?.fileName, 'schema.sql');
});
