// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  buildEditorUrl,
  fileReferenceCandidates,
  normalizeRoots,
  resolveFileReference,
} from '../app/src/main/file-reference.ts';
import { makeTempDir } from './temp-dirs.mjs';

function tempProject() {
  const root = makeTempDir('obelisk-file-ref-');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const a = 1;\n');
  return fs.realpathSync(root);
}

test('normalizeRoots keeps absolute paths and drops the rest', () => {
  assert.deepEqual(normalizeRoots(['/tmp/a', 'relative', '', null, undefined, '/tmp/a']), ['/tmp/a']);
});

test('candidates cover absolute, cwd-relative and project-relative shapes', () => {
  const candidates = fileReferenceCandidates({ rawPath: 'src/app.ts', cwd: '/tmp/proj' });
  assert.ok(candidates.includes(path.join('/tmp/proj', 'src/app.ts')));

  // A leading slash in transcripts usually means "project root", not filesystem root.
  const rooted = fileReferenceCandidates({ rawPath: '/src/app.ts', cwd: '/tmp/proj' });
  assert.ok(rooted.includes('/src/app.ts'));
  assert.ok(rooted.includes(path.join('/tmp/proj', 'src/app.ts')));
});

test('resolves a relative reference against the message cwd', () => {
  const root = tempProject();
  assert.equal(
    resolveFileReference({ rawPath: 'src/app.ts', cwd: root, roots: [] }),
    path.join(root, 'src', 'app.ts'),
  );
});

test('refuses paths outside the session roots', () => {
  const root = tempProject();
  const outside = makeTempDir('obelisk-outside-');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope\n');
  assert.equal(resolveFileReference({ rawPath: path.join(outside, 'secret.txt'), cwd: root }), null);
  assert.equal(resolveFileReference({ rawPath: '../../etc/hosts', cwd: root }), null);
});

test('refuses a symlink that escapes the session roots', () => {
  const root = tempProject();
  const outside = makeTempDir('obelisk-outside-');
  const secret = path.join(outside, 'secret.txt');
  fs.writeFileSync(secret, 'nope\n');
  fs.symlinkSync(secret, path.join(root, 'escape.txt'));
  assert.equal(resolveFileReference({ rawPath: 'escape.txt', cwd: root }), null);
});

test('refuses directories, missing files and rootless queries', () => {
  const root = tempProject();
  assert.equal(resolveFileReference({ rawPath: 'src', cwd: root }), null);
  assert.equal(resolveFileReference({ rawPath: 'src/nope.ts', cwd: root }), null);
  assert.equal(resolveFileReference({ rawPath: 'src/app.ts', cwd: null, roots: [] }), null);
});

test('builds editor URLs with line and column', () => {
  assert.equal(buildEditorUrl({ filePath: '/p/a.ts', line: 42 }), 'vscode://file/p/a.ts:42');
  assert.equal(buildEditorUrl({ filePath: '/p/a.ts', line: 42, column: 7 }), 'vscode://file/p/a.ts:42:7');
  assert.equal(buildEditorUrl({ filePath: '/p/a.ts' }), 'vscode://file/p/a.ts');
  assert.equal(buildEditorUrl({ scheme: 'cursor', filePath: '/p/a.ts', line: 3 }), 'cursor://file/p/a.ts:3');
});

test('falls back to the default scheme and encodes spaces', () => {
  assert.equal(buildEditorUrl({ scheme: 'evil:', filePath: '/p/a.ts' }), 'vscode://file/p/a.ts');
  assert.equal(buildEditorUrl({ filePath: '/p/a b.ts', line: 1 }), 'vscode://file/p/a%20b.ts:1');
});

test('ignores a zero or negative line number', () => {
  assert.equal(buildEditorUrl({ filePath: '/p/a.ts', line: 0 }), 'vscode://file/p/a.ts');
  assert.equal(buildEditorUrl({ filePath: '/p/a.ts', line: -3 }), 'vscode://file/p/a.ts');
});
