// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const cliEntry = join(repoRoot, 'packages', 'cli', 'dist', 'cli', 'src', 'obelisk.js');

export function runCli(args, { home, env = {}, cwd = repoRoot } = {}) {
  return spawnSync(process.execPath, [
    '--disable-warning=ExperimentalWarning',
    cliEntry,
    ...args,
  ], {
    cwd,
    env: {
      ...process.env,
      ...(home ? { HOME: home, USERPROFILE: home } : {}),
      ...env,
    },
    encoding: 'utf8',
  });
}
