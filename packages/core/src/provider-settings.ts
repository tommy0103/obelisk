import { existsSync, readFileSync } from 'node:fs';
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

export type PersistedProviderSettings = Record<string, unknown> & {
  providerRoots?: Record<string, unknown>;
};

export interface ProviderSettingsReadResult {
  readonly ok: boolean;
  readonly settings: PersistedProviderSettings;
  readonly error?: string;
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
  if (!existsSync(settingsPath)) return { ok: true, settings: {} };
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
  }: {
    homeDir?: string;
    cwd?: string;
    baseRoots?: BuiltinProviderRoots;
  } = {},
): { roots: Record<string, string>; registry: ProviderRegistry } {
  const defaults = createBuiltinProviderRegistry(baseRoots, { cwd });
  const roots = resolveProviderRoots(defaults, persisted, { homeDir });
  const configured = createBuiltinProviderRegistry({ ...baseRoots, ...roots }, { cwd });
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
        watchRoots: () => [],
        discover: (ctx) => {
          ctx.reportIncompleteInventory?.({
            path: provider.descriptor.defaultRoot,
            error: reason,
          });
          return [];
        },
        raw: () => null,
      };
    })),
  };
}
