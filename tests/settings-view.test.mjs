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
