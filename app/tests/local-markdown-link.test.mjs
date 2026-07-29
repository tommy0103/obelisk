import assert from 'node:assert/strict';
import test from 'node:test';
import { localMarkdownLinkCandidates } from '../src/main/local-markdown-link.mjs';

test('parses local paths and strips Codex line suffixes', () => {
  assert.deepEqual(localMarkdownLinkCandidates('/tmp/a%20file.ts:42:7'), ['/tmp/a file.ts:42:7', '/tmp/a file.ts']);
  assert.deepEqual(localMarkdownLinkCandidates('file:///tmp/a%20file.ts:42'), ['/tmp/a file.ts:42', '/tmp/a file.ts']);
});

test('rejects non-local Markdown links', () => {
  assert.deepEqual(localMarkdownLinkCandidates('https://example.com/a.ts'), []);
  assert.deepEqual(localMarkdownLinkCandidates('./a.ts'), []);
});
