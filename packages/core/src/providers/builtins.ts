// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { createClaudeProvider } from './claude.ts';
import { createCodexProvider } from './codex.ts';
import { createKimiProvider } from './kimi.ts';
import { createPiProvider } from './pi.ts';
import { createProviderRegistry, type ProviderRegistry } from './registry.ts';

export type BuiltinProviderRoots = Readonly<Record<string, string | undefined>>;

export function createBuiltinProviderRegistry(
  roots: BuiltinProviderRoots = {},
  { cwd }: { cwd?: string } = {},
): ProviderRegistry {
  return createProviderRegistry([
    createClaudeProvider({ rootDir: roots['claude'] }),
    createCodexProvider({ rootDir: roots['codex'] }),
    createKimiProvider({ rootDir: roots['kimi'] }),
    createPiProvider({ rootDir: roots['pi'], cwd }),
  ]);
}
