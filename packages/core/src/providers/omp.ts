// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';

import {
  createPiFamilyProvider,
  type PiProvider,
  type PiRootResolution,
} from './pi.ts';

const SOURCE = 'omp';

export const OMP_CANONICAL_TRANSCRIPT_MARKER = '__omp_canonical_transcript_v1__';

function resolveOmpRoot(rootDir: string | undefined, homeDir: string): PiRootResolution {
  const fallbackRoot = join(homeDir, '.omp', 'agent', 'sessions');
  if (rootDir === undefined) {
    return { root: fallbackRoot, requiresExplicitRoot: false };
  }
  const trimmed = rootDir.trim();
  const expanded = trimmed === '~'
    ? homeDir
    : trimmed.startsWith('~/') || trimmed.startsWith('~\\')
      ? join(homeDir, trimmed.slice(2))
      : trimmed;
  if (isAbsolute(expanded)) {
    return { root: normalize(expanded), requiresExplicitRoot: false };
  }
  return {
    root: fallbackRoot,
    requiresExplicitRoot: true,
    reason: 'Obelisk OMP providerRoot must be absolute or start with ~',
  };
}

export function createOmpProvider({
  rootDir,
  homeDir = homedir(),
}: {
  rootDir?: string;
  homeDir?: string;
} = {}): PiProvider {
  return createPiFamilyProvider({
    rootResolution: resolveOmpRoot(rootDir, homeDir),
    config: {
      source: SOURCE,
      displayName: 'OMP',
      vendor: 'Oh My Pi',
      color: '#8b5cf6',
      indexVersionMarker: OMP_CANONICAL_TRANSCRIPT_MARKER,
      allowTitlePrelude: true,
    },
  });
}

export const ompProvider = createOmpProvider();
