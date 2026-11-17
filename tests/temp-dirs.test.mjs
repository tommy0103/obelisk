// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// makeTempDir must return a path that code resolving symlinks agrees with, and
// ESLint must keep tests from building temp paths any other way.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ESLint } from 'eslint';
import { makeTempDir } from './temp-dirs.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const tempDirs = pathToFileURL(join(repoRoot, 'tests', 'temp-dirs.mjs')).href;

test('makeTempDir returns the realpath when TMPDIR is a symlink, and removes it on exit', () => {
  // macOS: $TMPDIR is under /var, a symlink to /private/var.
  const target = makeTempDir('obelisk-real-tmp-');
  const link = join(makeTempDir('obelisk-link-parent-'), 'tmp');
  symlinkSync(target, link, 'dir');
  const child = spawnSync(process.execPath, [
    '--input-type=module', '-e',
    `import { makeTempDir } from ${JSON.stringify(tempDirs)}; process.stdout.write(makeTempDir('probe-'));`,
  ], { env: { ...process.env, TMPDIR: link, TMP: link, TEMP: link }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const dir = child.stdout;
  assert.ok(dir.startsWith(join(target, 'probe-')), dir);
  assert.equal(dir, join(realpathSync(target), dir.slice(target.length + 1)));
  assert.equal(existsSync(dir), false);
});

const eslint = new ESLint({ cwd: repoRoot });
async function tmpdirReports(code, filePath = 'tests/tmpdir-probe.test.mjs') {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.filter(m => ['no-restricted-imports', 'no-restricted-properties'].includes(m.ruleId));
}

for (const [form, code] of Object.entries({
  'named node:os import': "import { tmpdir } from 'node:os';\nexport const dir = tmpdir();\n",
  'named os import': "import { tmpdir as t } from 'os';\nexport const dir = t();\n",
  'default import member': "import os from 'node:os';\nexport const dir = os.tmpdir();\n",
  'namespace import member': "import * as os from 'node:os';\nexport const dir = os.tmpdir();\n",
})) {
  test(`tests: ${form} of tmpdir is reported and names makeTempDir`, async () => {
    const reports = await tmpdirReports(code);
    assert.ok(reports.length > 0);
    for (const report of reports) assert.match(report.message, /makeTempDir\(\) from tests\/temp-dirs\.mjs/);
  });
}

test('tmpdir stays allowed in temp-dirs.mjs and outside tests', async () => {
  const code = "import { tmpdir } from 'node:os';\nexport const dir = tmpdir();\n";
  assert.deepEqual(await tmpdirReports(code, 'tests/temp-dirs.mjs'), []);
  assert.deepEqual(await tmpdirReports(code, 'scripts/tmpdir-probe.mjs'), []);
});
