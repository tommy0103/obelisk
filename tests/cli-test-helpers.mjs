// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const cliEntry = join(repoRoot, 'packages', 'cli', 'dist', 'cli', 'src', 'obelisk.js');

export function runCli(args, { home, env = {}, cwd = repoRoot } = {}) {
  const childEnv = {
    ...process.env,
    ...(home ? {
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, 'AppData', 'Roaming'),
      XDG_CONFIG_HOME: join(home, '.config'),
    } : {}),
    ...env,
  };
  // The codex provider resolves `$CODEX_HOME` with higher precedence than
  // `~/.codex`; a harness-exported CODEX_HOME would point CLI tests at the
  // real sessions root instead of the temp HOME.
  if (!Object.hasOwn(env, 'CODEX_HOME')) delete childEnv.CODEX_HOME;
  // The deepseek provider resolves `$DSH_HOME/sessions` with higher precedence
  // than `~/.dsh/sessions`; a harness-exported DSH_HOME would point CLI tests
  // at the real sessions root instead of the temp HOME.
  if (!Object.hasOwn(env, 'DSH_HOME')) delete childEnv.DSH_HOME;
  // The hermes provider resolves $HERMES_HOME/state.db with higher precedence than
  // ~/.hermes/state.db; a harness-exported HERMES_HOME would point CLI tests at the
  // real store instead of the temp HOME.
  if (!Object.hasOwn(env, 'HERMES_HOME')) delete childEnv.HERMES_HOME;
  // Keep an inherited Devin data root from pointing CLI tests at the real store.
  if (!Object.hasOwn(env, 'XDG_DATA_HOME')) delete childEnv.XDG_DATA_HOME;
  // Keep inherited MiniMax data root overrides from pointing CLI tests at a real store.
  if (!Object.hasOwn(env, 'MINIMAX_DATA_DIR')) delete childEnv.MINIMAX_DATA_DIR;
  if (!Object.hasOwn(env, 'MAVIS_DATA_DIR')) delete childEnv.MAVIS_DATA_DIR;
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
