// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export type ObeliskStorageLayout = 'custom' | 'legacy' | 'xdg';

export interface ObeliskPaths {
  readonly layout: ObeliskStorageLayout;
  readonly configDir: string;
  readonly dataDir: string;
  readonly settingsPath: string;
  readonly dbPath: string;
  readonly writerLockPath: string;
  readonly recapDir: string;
  readonly legacyDir: string;
  readonly legacyDbPath: string;
}

export interface ResolveObeliskPathsOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  pathExists?: (path: string) => boolean;
}

export const LEGACY_STORAGE_DOC_URL = 'https://github.com/tommy0103/obelisk#advanced-configuration';

function expandTilde(value: string, homeDir: string): string {
  if (value === '~') return homeDir;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return join(homeDir, value.slice(2));
  }
  return value;
}

function absoluteEnvPath(
  value: unknown,
  homeDir: string,
  name: string,
  { expandHome = false }: { expandHome?: boolean } = {},
): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const trimmed = value.trim();
  const expanded = expandHome ? expandTilde(trimmed, homeDir) : trimmed;
  if (!isAbsolute(expanded)) {
    if (name === 'OBELISK_HOME') {
      throw new Error('OBELISK_HOME must be an absolute path or begin with ~');
    }
    return null;
  }
  return resolve(expanded);
}

export function resolveObeliskPaths({
  env = process.env,
  homeDir = homedir(),
  pathExists = existsSync,
}: ResolveObeliskPathsOptions = {}): ObeliskPaths {
  const home = resolve(homeDir);
  const legacyDir = join(home, '.obelisk');
  const legacyDbPath = join(home, '.claude', 'obelisk.sqlite');
  const configuredHome = absoluteEnvPath(env['OBELISK_HOME'], home, 'OBELISK_HOME', {
    expandHome: true,
  });

  let layout: ObeliskStorageLayout;
  let configDir: string;
  let dataDir: string;
  if (configuredHome !== null) {
    layout = 'custom';
    configDir = configuredHome;
    dataDir = configuredHome;
  } else if (pathExists(legacyDir)) {
    layout = 'legacy';
    configDir = legacyDir;
    dataDir = legacyDir;
  } else if (env['OBELISK_USE_XDG'] === '1') {
    layout = 'xdg';
    configDir = join(
      absoluteEnvPath(env['XDG_CONFIG_HOME'], home, 'XDG_CONFIG_HOME') ?? join(home, '.config'),
      'obelisk',
    );
    dataDir = join(
      absoluteEnvPath(env['XDG_DATA_HOME'], home, 'XDG_DATA_HOME') ?? join(home, '.local', 'share'),
      'obelisk',
    );
  } else {
    layout = 'legacy';
    configDir = legacyDir;
    dataDir = legacyDir;
  }

  return {
    layout,
    configDir,
    dataDir,
    settingsPath: join(configDir, 'settings.json'),
    dbPath: join(dataDir, 'obelisk.sqlite'),
    writerLockPath: join(dataDir, 'writer.lock.sqlite'),
    recapDir: join(dataDir, 'recap'),
    legacyDir,
    legacyDbPath,
  };
}

export function warnLegacyStorageIgnored(
  paths: ObeliskPaths,
  {
    pathExists = existsSync,
    warn = (message: string) => console.warn(message),
  }: {
    pathExists?: (path: string) => boolean;
    warn?: (message: string) => void;
  } = {},
): string | null {
  if (paths.layout === 'legacy') return null;
  if (resolve(paths.legacyDbPath) === resolve(paths.dbPath)) return null;
  if (!pathExists(paths.legacyDbPath)) return null;
  warn(
    `Obelisk legacy database at ${paths.legacyDbPath} was not copied to the selected layout. `
    + `Move it manually if needed; see ${LEGACY_STORAGE_DOC_URL}`,
  );
  return paths.legacyDbPath;
}
