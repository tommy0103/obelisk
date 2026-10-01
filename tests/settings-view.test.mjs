// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('../app/src/renderer/src/views/Settings.vue', import.meta.url),
  'utf8',
);

test('Settings reads the displayed version from the settings payload', () => {
  assert.doesNotMatch(source, /const version = ref\(['"]0\.1\.0['"]\)/);
  assert.match(source, /version\.value = s\.version/);
});

test('Editor selector uses the themed Settings control vocabulary', () => {
  assert.doesNotMatch(source, /<select\b/);
  assert.match(source, /<button[^>]*class="editor-picker-trigger"/);
  assert.match(source, /class="editor-picker-menu"/);
  assert.match(source, /\.editor-picker\s*\{[^}]*width:\s*180px/s);
  assert.match(source, /aria-haspopup="listbox"/);
  assert.match(source, /role="option"/);
});

test('background index updates preserve an in-progress Recap path edit', () => {
  assert.match(source, /loadSettings\(\{\s*preserveRecapPath:\s*true\s*\}\)/);
  assert.match(source, /if\s*\(!preserveRecapPath\)\s*recapPath\.value\s*=/);
});

test('rebuild failures are caught and surfaced in Settings', () => {
  assert.match(source, /catch\s*\(error\)\s*\{[\s\S]*rebuildError\.value\s*=/);
  assert.match(source, /v-if="rebuildError"/);
  assert.match(source, /\{\{\s*rebuildError\s*\}\}/);
});

// The editor picker, the recap directory and the auto-refresh toggle all save through
// saveSetting without reloading settings afterwards. A notice the main process reported only
// through settings:get would therefore never reach the page on those paths, which is why the
// save response carries it too. The Electron suite drives the interaction itself; this pins
// the wiring where CI can see it.
test('a completed save refreshes the recovery notice from the save response', () => {
  assert.match(source, /const result = await window\.obelisk\.setSetting\(key, value\)/);
  assert.match(source, /settingsRecovery\.value = result\?\.settingsRecovery \|\| ''/);
});

// A save is refused when the settings file could not be preserved first. Surfacing that is
// the point of refusing: the file is untouched, and silence would read as a successful save.
test('a refused save is caught and surfaced in Settings', () => {
  assert.match(source, /saveError\.value = error instanceof Error \? error\.message : String\(error\)/);
  assert.match(source, /v-if="saveError"/);
  assert.match(source, /\{\{\s*saveError\s*\}\}/);
});
