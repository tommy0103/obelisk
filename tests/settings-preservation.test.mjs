// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { preserveRejectedSettings } from '../app/src/main/settings-preservation.ts';
import { makeTempDir } from './temp-dirs.mjs';

const realOps = {
  rename: (from, to) => fsp.rename(from, to),
  copyFile: (from, to) => fsp.copyFile(from, to),
};

// A settings file the shared reader rejects sits in its own directory, so "was it preserved"
// is a plain directory listing rather than a guess.
function settingsFixture(text) {
  const dir = makeTempDir('obelisk-preserve-');
  const settingsPath = join(dir, 'settings.json');
  if (text !== undefined) writeFileSync(settingsPath, text);
  return { dir, settingsPath };
}

function backupsIn(dir) {
  return readdirSync(dir).filter(name => name.startsWith('settings.json.corrupt-'));
}

const STRUCTURALLY_INVALID = JSON.stringify({
  providerRoots: [],
  recapDir: '/valuable/recaps',
  editorScheme: 'cursor',
});

test('a file with malformed JSON is preserved byte-for-byte and the backup path is returned', async () => {
  // A Windows path written with a single backslash: the shape a hand edit produces.
  // JSON.stringify always escapes them, so only manual edits look like this. The backslash
  // is built from its char code because a literal one in source is easy to lose to escaping,
  // and a fixture that silently stays valid would make this test pass for the wrong reason.
  const backslash = String.fromCharCode(92);
  const corruptText = `{ "editorScheme": "C:${backslash}cursor" }`;
  assert.throws(() => JSON.parse(corruptText), 'the fixture must be unparseable');
  const { dir, settingsPath } = settingsFixture(corruptText);

  const backupPath = await preserveRejectedSettings(settingsPath, realOps);

  assert.notEqual(backupPath, null, 'the rejection is reported as preserveable');
  assert.equal(readFileSync(backupPath, 'utf8'), corruptText, 'the preserved bytes are unchanged');
  assert.equal(backupsIn(dir).length, 1, 'exactly one backup was written');
});

// The shared reader rejects more than malformed syntax, and everything it rejects is rebuilt
// from {} by the save path. A structural rejection must be preserved too, or #42 just moves
// to a different input.
test('a file the reader rejects for its structure is preserved even though it parses', async () => {
  assert.doesNotThrow(() => JSON.parse(STRUCTURALLY_INVALID), 'the fixture is valid JSON');
  const { dir, settingsPath } = settingsFixture(STRUCTURALLY_INVALID);

  const backupPath = await preserveRejectedSettings(settingsPath, realOps);

  assert.notEqual(backupPath, null, 'providerRoots: [] is a rejection, not a valid file');
  assert.equal(readFileSync(backupPath, 'utf8'), STRUCTURALLY_INVALID);
  assert.equal(backupsIn(dir).length, 1);
});

test('a top-level array is preserved: the reader rejects it, so the save path would empty it', async () => {
  const { settingsPath } = settingsFixture('[]');

  assert.notEqual(await preserveRejectedSettings(settingsPath, realOps), null);
});

test('a settings file the reader accepts is left alone', async () => {
  const validText = JSON.stringify({ providerRoots: { pi: '/custom/pi' }, editorScheme: 'cursor' });
  const { dir, settingsPath } = settingsFixture(validText);

  assert.equal(await preserveRejectedSettings(settingsPath, realOps), null);
  assert.deepEqual(backupsIn(dir), [], 'nothing was moved aside');
  assert.equal(readFileSync(settingsPath, 'utf8'), validText, 'the file is still in place');
});

test('a missing settings file is nothing to preserve', async () => {
  const { dir, settingsPath } = settingsFixture();

  assert.equal(await preserveRejectedSettings(settingsPath, realOps), null);
  assert.deepEqual(readdirSync(dir), [], 'no backup was written for a file that never existed');
});

// Windows refuses a rename while another handle holds the file. There is no builtin-module
// mocking available for node:test, so the ops are injected; the point being pinned is that a
// refused rename still leaves the bytes somewhere before the caller replaces the original.
test('a refused rename falls back to a copy instead of giving up on the backup', async () => {
  const corruptText = '{ not json';
  const { settingsPath } = settingsFixture(corruptText);
  const ops = {
    rename: async () => { throw new Error('injected rename fault'); },
    copyFile: realOps.copyFile,
  };

  const backupPath = await preserveRejectedSettings(settingsPath, ops);

  assert.notEqual(backupPath, null, 'the copy succeeded, so the caller may proceed');
  assert.equal(readFileSync(backupPath, 'utf8'), corruptText, 'the copied bytes are complete');
  assert.equal(readFileSync(settingsPath, 'utf8'), corruptText, 'the original is untouched');
});

// The gap the previous revision left open: it swallowed a failed backup and let the caller
// overwrite anyway, which is exactly the silent loss #42 describes.
test('when nothing can preserve the file the call throws and the original survives', async () => {
  const corruptText = '{ not json';
  const { dir, settingsPath } = settingsFixture(corruptText);
  const ops = {
    rename: async () => { throw new Error('injected rename fault'); },
    copyFile: async () => { throw new Error('injected copy fault'); },
  };

  await assert.rejects(
    () => preserveRejectedSettings(settingsPath, ops),
    /could not back up/,
    'the caller must be told to leave the file alone',
  );
  assert.equal(readFileSync(settingsPath, 'utf8'), corruptText, 'the only copy of the bytes survives');
  assert.deepEqual(backupsIn(dir), []);
});
