// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { join } from 'node:path';

import { createClaudeProvider } from './claude.ts';
import { createCodexProvider } from './codex.ts';
import { createCodexHostAntigravityProvider } from './codexhost-antigravity.ts';
import { createCopilotProvider, type CopilotChronicleOpener } from './copilot.ts';
import { createDeepseekProvider } from './deepseek.ts';
import { createDevinProvider, type DevinDatabaseOpener } from './devin.ts';
import { createHermesProvider, type HermesStoreOpener } from './hermes.ts';
import { createKimiProvider } from './kimi.ts';
import { createKiroProvider, type KiroDatabaseOpener } from './kiro.ts';
import { createMinimaxProvider, type MinimaxDatabaseOpener } from './minimax.ts';
import { createOmpProvider } from './omp.ts';
import { createOpencodeProvider, type OpencodeDatabaseOpener } from './opencode.ts';
import { createPiProvider } from './pi.ts';
import { createZcodeProvider, type ZcodeDatabaseOpener } from './zcode.ts';
import { createProviderRegistry, type ProviderRegistry } from './registry.ts';

export type BuiltinProviderRoots = Readonly<Record<string, string | undefined>>;

export function createBuiltinProviderRegistry(
  roots: BuiltinProviderRoots = {},
  {
    homeDir,
    codexHomeDir = homeDir,
    cwd,
    copilotUserDataRoots,
    claudeSourceRoots,
    claudeDefaultRoot,
    codexRoots,
    openCopilotChronicle,
    openHermesStore,
    openZcodeDatabase,
    openKiroDatabase,
    openMinimaxDatabase,
    openOpencodeDatabase,
    openDevinDatabase,
  }: {
    homeDir?: string;
    codexHomeDir?: string;
    cwd?: string;
    copilotUserDataRoots?: readonly string[];
    claudeSourceRoots?: readonly string[];
    claudeDefaultRoot?: string;
    codexRoots?: readonly string[];
    openCopilotChronicle?: CopilotChronicleOpener;
    openHermesStore?: HermesStoreOpener;
    openZcodeDatabase?: ZcodeDatabaseOpener;
    openKiroDatabase?: KiroDatabaseOpener;
    openMinimaxDatabase?: MinimaxDatabaseOpener;
    openOpencodeDatabase?: OpencodeDatabaseOpener;
    openDevinDatabase?: DevinDatabaseOpener;
  } = {},
): ProviderRegistry {
  const fallbackClaudeDefault = homeDir ? join(homeDir, '.claude') : undefined;
  const claudeRootDir = claudeSourceRoots !== undefined
    ? (claudeDefaultRoot ?? fallbackClaudeDefault ?? roots['claude'])
    : (roots['claude'] ?? claudeDefaultRoot ?? fallbackClaudeDefault);
  return createProviderRegistry([
    createClaudeProvider({
      rootDir: claudeRootDir,
      sourceRoots: claudeSourceRoots,
    }),
    createCodexProvider({ rootDir: roots['codex'], roots: codexRoots, homeDir: codexHomeDir, cwd }),
    createCodexHostAntigravityProvider({ rootDir: roots['codexhost-antigravity'] }),
    createCopilotProvider({ rootDir: roots['copilot'], userDataRoots: copilotUserDataRoots, openChronicle: openCopilotChronicle }),
    createDeepseekProvider({ rootDir: roots['deepseek'] }),
    createDevinProvider({ rootDir: roots['devin'], homeDir, openDatabase: openDevinDatabase }),
    createHermesProvider({ rootDir: roots['hermes'], openStore: openHermesStore }),
    createKimiProvider({ rootDir: roots['kimi'] }),
    createKiroProvider({ rootDir: roots['kiro'], openDatabase: openKiroDatabase }),
    createMinimaxProvider({ rootDir: roots['minimax'], homeDir, openDatabase: openMinimaxDatabase }),
    createOmpProvider({ rootDir: roots['omp'] }),
    createOpencodeProvider({ rootDir: roots['opencode'], homeDir, openDatabase: openOpencodeDatabase }),
    createPiProvider({ rootDir: roots['pi'], cwd }),
    createZcodeProvider({ rootDir: roots['zcode'], openDatabase: openZcodeDatabase }),
  ]);
}
