// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const cliEntry = join(repoRoot, 'packages', 'cli', 'dist', 'cli', 'src', 'obelisk.js');

export function runCli(args, { home, env = {}, cwd = repoRoot } = {}) {
  // The deepseek provider resolves `$DSH_HOME/sessions` with higher precedence
  // than `~/.dsh/sessions`; a harness shell exporting DSH_HOME would point CLI
  // tests at the real session store instead of the temp HOME.
  const childEnv = { ...process.env };
  delete childEnv.DSH_HOME;
  if (home) { childEnv.HOME = home; childEnv.USERPROFILE = home; }
  Object.assign(childEnv, env);
  return spawnSync(process.execPath, [
    '--disable-warning=ExperimentalWarning',
    cliEntry,
    ...args,
  ], {
    cwd,
    env: childEnv,
    encoding: 'utf8',
  });
}
