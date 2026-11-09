// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hrefToPath,
  mayContainFileReference,
  isInlineCodeReference,
  isLocalHref,
  parseFileReference,
} from '../app/src/renderer/src/file-references.mjs';

test('splits the Codex line and column suffix', () => {
  assert.deepEqual(parseFileReference('/Users/me/proj/a.ts:162'), {
    path: '/Users/me/proj/a.ts', line: 162, column: null, endLine: null,
  });
  assert.deepEqual(parseFileReference('/Users/me/proj/a.ts:42:7'), {
    path: '/Users/me/proj/a.ts', line: 42, column: 7, endLine: null,
  });
});

test('splits a line range', () => {
  assert.deepEqual(parseFileReference('taskTree.ts:182-185'), {
    path: 'taskTree.ts', line: 182, column: null, endLine: 185,
  });
});

test('keeps a reference without a suffix intact', () => {
  assert.deepEqual(parseFileReference('/Users/me/proj/README.md'), {
    path: '/Users/me/proj/README.md', line: null, column: null, endLine: null,
  });
});

test('rejects empty input', () => {
  assert.equal(parseFileReference(''), null);
  assert.equal(parseFileReference(null), null);
});

test('recognises local hrefs only', () => {
  assert.ok(isLocalHref('/Users/me/a.ts'));
  assert.ok(isLocalHref('file:///Users/me/a.ts'));
  assert.ok(isLocalHref('C:/proj/a.ts'));
  assert.ok(!isLocalHref('https://example.com/a.ts'));
  assert.ok(!isLocalHref('#anchor'));
  assert.ok(!isLocalHref('mailto:x@y.z'));
});

test('inline code becomes a reference only with an extension and a line', () => {
  assert.ok(isInlineCodeReference('src/hooks/hook.ts:40'));
  assert.ok(isInlineCodeReference('packages/kernel/src/router.ts:32'));
  assert.ok(isInlineCodeReference('taskTree.ts:182-185'));
  assert.ok(isInlineCodeReference('/src/tools/openai-categories.ts:198-201'));
});

test('ordinary inline code is never turned into a link', () => {
  assert.ok(!isInlineCodeReference('package.json'));
  assert.ok(!isInlineCodeReference('useState'));
  assert.ok(!isInlineCodeReference('npm run build'));
  assert.ok(!isInlineCodeReference('a.ts'));
  assert.ok(!isInlineCodeReference('12:30'));
  assert.ok(!isInlineCodeReference('const x = obj.a[0]:1'));
});

test('decodes file:// URLs but leaves plain paths byte-for-byte', () => {
  assert.equal(hrefToPath('file:///Users/me/a%20file.ts'), '/Users/me/a file.ts');
  // A literal percent in a filename must survive: decoding every href would corrupt it.
  assert.equal(hrefToPath('/Users/me/100%.md'), '/Users/me/100%.md');
  assert.equal(hrefToPath('/Users/me/a%20b.md'), '/Users/me/a%20b.md');
});

test('returns empty string for a malformed file URL', () => {
  assert.equal(hrefToPath('file://%E0%A4%A'), '');
});

test('pre-filter skips markup that cannot hold a reference', () => {
  assert.ok(!mayContainFileReference('<p>plain prose with no markup</p>'));
  assert.ok(!mayContainFileReference(''));
  assert.ok(!mayContainFileReference(null));
});

test('pre-filter admits anything with a link or inline code', () => {
  assert.ok(mayContainFileReference('<p><a href="/a.ts:1">x</a></p>'));
  assert.ok(mayContainFileReference('<p><code>src/a.ts:1</code></p>'));
  assert.ok(mayContainFileReference('<pre><code class="language-ts">x</code></pre>'));
});
