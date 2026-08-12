// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  ProviderAdapter,
  ProviderDescriptor,
  RawLookup,
  RawRecord,
} from './types.ts';

export interface ProviderRegistry {
  catalog(): ProviderDescriptor[];
  get(source: string): ProviderAdapter | undefined;
  list(): ProviderAdapter[];
  watchRoots(configuredRoots?: Readonly<Record<string, string>>): string[];
  raw(input: RawLookup): RawRecord | null;
}

export function createProviderRegistry(providers: readonly ProviderAdapter[]): ProviderRegistry {
  const byId = new Map<string, ProviderAdapter>();
  for (const provider of providers) {
    const id = provider.descriptor.id;
    if (provider.name !== id) {
      throw new Error(`Provider name "${provider.name}" must match descriptor id "${id}"`);
    }
    if (byId.has(id)) throw new Error(`Duplicate provider id: ${id}`);
    byId.set(id, provider);
  }

  const list = (): ProviderAdapter[] => [...byId.values()];
  return {
    catalog: () => list().map((provider) => ({ ...provider.descriptor })),
    get: (source) => byId.get(source),
    list,
    watchRoots: (configuredRoots = {}) => [
      ...new Set(
        list().flatMap((provider) =>
          provider.watchRoots(configuredRoots[provider.name] ?? provider.descriptor.defaultRoot),
        ),
      ),
    ],
    raw: (input) => byId.get(input.source)?.raw(input) ?? null,
  };
}
