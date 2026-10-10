// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';

import {
  createBuiltinProviderRegistry,
  type BuiltinProviderRoots,
} from './providers/builtins.ts';
import {
  createProviderRegistry,
  type ProviderRegistry,
} from './providers/registry.ts';
import type { CopilotChronicleOpener } from './providers/copilot.ts';
import { defaultCopilotUserDataRoots } from './providers/copilot.ts';
import type { HermesStoreOpener } from './providers/hermes.ts';
import type { ZcodeDatabaseOpener } from './providers/zcode.ts';
import type { KiroDatabaseOpener } from './providers/kiro.ts';

export type PersistedProviderSettings = Record<string, unknown> & {
  providerRoots?: Record<string, unknown>;
  copilotEditions?: Record<string, unknown>;
};

export function getCopilotEditions(persisted: PersistedProviderSettings) {
  const [stable, insiders] = defaultCopilotUserDataRoots();
  const settings = persisted.copilotEditions;
  return [
    { id: 'stable', name: 'VS Code', path: stable!, enabled: settings?.stable !== false },
    { id: 'insiders', name: 'VS Code Insiders', path: insiders!, enabled: settings?.insiders !== false },
  ];
}

export interface ProviderSettingsReadResult {
  readonly ok: boolean;
  readonly settings: PersistedProviderSettings;
  readonly error?: string;
}

export function hasExplicitProviderRoot(
  persisted: PersistedProviderSettings,
  providerId: string,
): boolean {
  const configured = (
    persisted.providerRoots !== null
    && typeof persisted.providerRoots === 'object'
    && !Array.isArray(persisted.providerRoots)
  ) ? persisted.providerRoots : {};
  return (
    Object.prototype.hasOwnProperty.call(configured, providerId)
    && configured[providerId] !== null
  ) || (
    Object.prototype.hasOwnProperty.call(persisted, `${providerId}Dir`)
    && persisted[`${providerId}Dir`] !== null
  );
}

function configuredPath(value: unknown, homeDir: string): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const trimmed = value.trim();
  const expanded = trimmed === '~'
    ? homeDir
    : trimmed.startsWith('~/') || trimmed.startsWith('~\\')
      ? join(homeDir, trimmed.slice(2))
      : trimmed;
  return isAbsolute(expanded) ? normalize(expanded) : null;
}

export function resolveProviderRoots(
  registry: ProviderRegistry,
  persisted: PersistedProviderSettings = {},
  { homeDir = homedir() }: { homeDir?: string } = {},
): Record<string, string> {
  if (
    persisted.providerRoots !== undefined
    && persisted.providerRoots !== null
    && (typeof persisted.providerRoots !== 'object' || Array.isArray(persisted.providerRoots))
  ) return {};
  const configured = (
    persisted.providerRoots !== null
    && typeof persisted.providerRoots === 'object'
    && !Array.isArray(persisted.providerRoots)
  ) ? persisted.providerRoots : {};
  return Object.fromEntries(registry.catalog().flatMap((descriptor) => {
    const modernKey = descriptor.id;
    const legacyKey = `${descriptor.id}Dir`;
    const hasModern = Object.prototype.hasOwnProperty.call(configured, modernKey)
      && configured[modernKey] !== null;
    const hasLegacy = Object.prototype.hasOwnProperty.call(persisted, legacyKey)
      && persisted[legacyKey] !== null;
    if (hasModern || hasLegacy) {
      const explicit = configuredPath(
        hasModern ? configured[modernKey] : persisted[legacyKey],
        homeDir,
      );
      return explicit === null ? [] : [[descriptor.id, explicit]];
    }
    return descriptor.requiresExplicitRoot ? [] : [[descriptor.id, descriptor.defaultRoot]];
  }));
}

export function readPersistedProviderSettings(
  settingsPath = join(homedir(), '.obelisk', 'settings.json'),
): ProviderSettingsReadResult {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, settings: {}, error: `Obelisk settings are not an object: ${settingsPath}` };
    }
    const roots = (parsed as PersistedProviderSettings).providerRoots;
    if (
      roots !== undefined
      && roots !== null
      && (typeof roots !== 'object' || Array.isArray(roots))
    ) {
      return { ok: false, settings: {}, error: `Obelisk providerRoots are not an object: ${settingsPath}` };
    }
    return { ok: true, settings: parsed as PersistedProviderSettings };
  } catch (error) {
    // existsSync also returns false for denied/uninspectable paths. Only an
    // actual missing-file read can safely select the no-settings defaults.
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      return { ok: true, settings: {} };
    }
    return {
      ok: false,
      settings: {},
      error: `Unable to read Obelisk settings at ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function createConfiguredBuiltinProviderRuntime(
  persisted: PersistedProviderSettings = {},
  {
    homeDir = homedir(),
    cwd = process.cwd(),
    baseRoots = {},
    openCopilotChronicle,
    openHermesStore,
    openZcodeDatabase,
    openKiroDatabase,
  }: {
    homeDir?: string;
    cwd?: string;
    baseRoots?: BuiltinProviderRoots;
    openCopilotChronicle?: CopilotChronicleOpener;
    openHermesStore?: HermesStoreOpener;
    openZcodeDatabase?: ZcodeDatabaseOpener;
    openKiroDatabase?: KiroDatabaseOpener;
  } = {},
): { roots: Record<string, string>; registry: ProviderRegistry } {
  const defaults = createBuiltinProviderRegistry(baseRoots, { cwd, openCopilotChronicle, openHermesStore, openZcodeDatabase, openKiroDatabase });
  const roots = resolveProviderRoots(defaults, persisted, { homeDir });
  const copilotUsesAutomaticRoots = baseRoots.copilot === undefined
    && !hasExplicitProviderRoot(persisted, 'copilot');
  const copilotUserDataRoots = copilotUsesAutomaticRoots
    ? getCopilotEditions(persisted).filter((edition) => edition.enabled).map((edition) => edition.path)
    : undefined;
  if (copilotUserDataRoots?.[0]) roots.copilot = copilotUserDataRoots[0];
  const configured = createBuiltinProviderRegistry(
    {
      ...baseRoots,
      ...roots,
      ...(copilotUsesAutomaticRoots ? { copilot: undefined } : {}),
    },
    {
      cwd, openCopilotChronicle, openHermesStore, openZcodeDatabase, openKiroDatabase,
      copilotUserDataRoots,
    },
  );
  return {
    roots,
    registry: createProviderRegistry(configured.list().map((provider) => {
      if (roots[provider.name] !== undefined) return provider;
      const reason = provider.descriptor.rootResolutionReason
        ?? `Configured ${provider.name} root must be absolute or start with ~`;
      return {
        ...provider,
        descriptor: {
          ...provider.descriptor,
          requiresExplicitRoot: true,
          rootResolutionReason: reason,
        },
        watchTargets: () => [],
        discover: (ctx) => {
          const indexed = ctx.indexedSessions?.()[0];
          if (indexed) {
            ctx.reportIncompleteInventory?.({
              path: indexed.jsonlPath,
              error: reason,
            });
          }
          return [];
        },
      };
    })),
  };
}
