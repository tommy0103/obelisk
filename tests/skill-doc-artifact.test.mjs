// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const artifact = join(repoRoot, 'dist', 'obelisk-skill');

test('build:skill produces a docs-only skill that delegates execution to the CLI', () => {
  execFileSync(npmCommand, ['run', 'build:skill'], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: 'pipe',
  });

  assert.equal(existsSync(join(artifact, 'SKILL.md')), true);
  assert.equal(existsSync(join(artifact, 'references', 'api-reference.md')), true);
  assert.equal(existsSync(join(artifact, 'package.json')), true);
  assert.equal(existsSync(join(artifact, 'scripts')), false, 'skill must not ship a second runtime');

  const skill = readFileSync(join(artifact, 'SKILL.md'), 'utf8');
  const schema = readFileSync(join(artifact, 'references', 'schema.md'), 'utf8');
  assert.match(skill, /Bash\(obelisk:\*\)/);
  assert.match(skill, /obelisk --query "\$qfile"/);
  assert.match(skill, /obelisk --attune \/tmp\/register-memory\.mjs/);
  assert.match(skill, /sandbox_permissions: "require_escalated"/);
  assert.match(skill, /Never\s+degrade to a stale, read-only index/);
  assert.doesNotMatch(skill, /\$SKILL_DIR\/scripts\/runtime\.js/);
  assert.doesNotMatch(`${skill}\n${schema}`, /scripts\//);
});
