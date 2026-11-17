// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// eslint.config.js: a catch may swallow an error only with a comment saying why.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const eslint = new ESLint({ cwd: repoRoot });

const paths = [
  'packages/core/src/empty-catch-probe.ts',
  'app/src/main/empty-catch-probe.ts',
  'app/src/renderer/src/empty-catch-probe.js',
  'tests/empty-catch-probe.test.mjs',
  'scripts/empty-catch-probe.mjs',
];

async function emptyBlockReports(body, filePath) {
  const [result] = await eslint.lintText(`export function probe(read) {\n${body}\n}\n`, { filePath });
  return result.messages.filter(message => message.ruleId === 'no-empty');
}

for (const filePath of paths) {
  test(`${filePath}: a bare empty catch is reported`, async () => {
    assert.equal((await emptyBlockReports('try { read(); } catch {}', filePath)).length, 1);
    assert.equal((await emptyBlockReports('try { read(); } catch (error) {\n}', filePath)).length, 1);
  });
  test(`${filePath}: a catch that explains itself passes`, async () => {
    assert.deepEqual(await emptyBlockReports('try { read(); } catch { /* not JSON: fall back to text */ }', filePath), []);
    assert.deepEqual(await emptyBlockReports('try { read(); } catch {\n  // missing file: try the next one\n}', filePath), []);
  });
}
