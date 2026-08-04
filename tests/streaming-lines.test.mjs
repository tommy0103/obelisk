import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { iterateLineSegments, readLines } from '../packages/core/src/parsing.ts';

function fixture(content) {
  const dir = mkdtempSync(join(tmpdir(), 'obelisk-streaming-lines-'));
  const path = join(dir, 'fixture.jsonl');
  writeFileSync(path, content);
  return path;
}

function collect(path) {
  const lines = [];
  readLines(path, line => { lines.push(line); });
  return lines;
}

test('iterateLineSegments reconstructs long UTF-8 lines from bounded byte views', () => {
  const first = `${'a'.repeat(64 * 1024 - 1)}你${'b'.repeat(3 * 1024 * 1024)}`;
  const path = fixture(`${first}\nsecond\n`);
  const lines = [];
  let pieces = [];

  for (const segment of iterateLineSegments(path)) {
    pieces.push(Buffer.from(segment.bytes));
    assert.ok(segment.bytes.length <= 64 * 1024);
    if (segment.lineEnd) {
      lines.push(Buffer.concat(pieces).toString('utf8'));
      pieces = [];
    }
  }

  assert.deepEqual(lines, [first, 'second']);
});

test('readLines preserves empty-line, CRLF, and unterminated-tail behavior', () => {
  const path = fixture('\nfirst\r\n\nlast');
  assert.deepEqual(collect(path), ['first\r', 'last']);
});

test('readLines preserves UTF-8 split across its read buffer boundary', () => {
  const line = `${'a'.repeat(64 * 1024 - 1)}你`;
  const path = fixture(`${line}\n`);

  assert.deepEqual(collect(path), [line]);
});

test('readLines stops immediately when the callback returns false', () => {
  const path = fixture(`first\n${'x'.repeat(2 * 1024 * 1024)}\nthird\n`);
  const lines = [];

  readLines(path, line => {
    lines.push(line);
    return false;
  });

  assert.deepEqual(lines, ['first']);
});

test('iterateLineSegments snapshots the readable byte boundary at open', () => {
  const path = fixture('first\n');
  const source = statSync(path);
  const segments = iterateLineSegments(path, {
    maxBytes: source.size,
    expectedFile: { dev: source.dev, ino: source.ino, minBytes: source.size },
  });

  assert.equal(segments.next().value.bytes.toString('utf8'), 'first');
  appendFileSync(path, 'second\n');
  assert.deepEqual(segments.next(), { value: undefined, done: true });
});

test('iterateLineSegments rejects a different file identity between passes', () => {
  const path = fixture('first\n');
  const source = statSync(path);
  const segments = iterateLineSegments(path, {
    maxBytes: source.size,
    expectedFile: { dev: source.dev, ino: source.ino + 1, minBytes: source.size },
  });

  assert.throws(() => segments.next(), /JSONL source changed/);
});
