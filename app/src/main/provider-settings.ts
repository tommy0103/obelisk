// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ProviderRegistry } from '../../../packages/core/src/providers/registry.ts';
export { resolveProviderRoots } from '../../../packages/core/src/provider-settings.ts';

type PersistedSettings = Record<string, unknown> & {
  providerRoots?: Record<string, unknown>;
};

interface SourceStats {
  sessionCount: number;
  lastIndexed: string;
}

export interface ProviderSourceIssue {
  readonly provider: string;
  readonly path: string;
  readonly error: string;
}

interface BuildSourceCatalogOptions {
  registry: ProviderRegistry;
  roots: Readonly<Record<string, string>>;
  stats?: ReadonlyMap<string, SourceStats>;
  sourceIssues?: readonly ProviderSourceIssue[];
  pathExists?: (path: string) => boolean;
}

export function setPersistedSetting(
  persisted: PersistedSettings,
  key: string,
  value: unknown,
): boolean {
  const providerMatch = /^providerRoots\.(.+)$/.exec(key);
  if (providerMatch === null) {
    if (value === null) delete persisted[key];
    else persisted[key] = value;
    return false;
  }

  const providerId = providerMatch[1]!;
  const roots = persisted.providerRoots
    && typeof persisted.providerRoots === 'object'
    && !Array.isArray(persisted.providerRoots)
    ? persisted.providerRoots
    : {};
  if (value === null) delete roots[providerId];
  else roots[providerId] = value;
  if (Object.keys(roots).length === 0) delete persisted.providerRoots;
  else persisted.providerRoots = roots;
  return true;
}

export function buildSourceCatalog({
  registry,
  roots,
  stats = new Map(),
  sourceIssues = [],
  pathExists = () => false,
}: BuildSourceCatalogOptions) {
  return registry.catalog().map((descriptor) => {
    const path = roots[descriptor.id] ?? descriptor.defaultRoot;
    const exists = pathExists(path);
    const needsRoot = descriptor.requiresExplicitRoot === true;
    const sourceStats = stats.get(descriptor.id) ?? { sessionCount: 0, lastIndexed: '' };
    const issue = sourceIssues.find((candidate) => candidate.provider === descriptor.id);
    const status = needsRoot || !exists
      ? 'error'
      : issue !== undefined || sourceStats.sessionCount === 0
        ? 'warn'
        : 'ok';
    const partialStatus = issue === undefined
      ? null
      : `Index issue: ${issue.path} — ${issue.error}`;
    return {
      id: descriptor.id,
      name: descriptor.name,
      vendor: descriptor.vendor,
      color: descriptor.color,
      path,
      settingKey: `providerRoots.${descriptor.id}`,
      exists,
      sessionCount: sourceStats.sessionCount,
      lastIndexed: sourceStats.lastIndexed,
      status,
      statusText: needsRoot
        ? descriptor.rootResolutionReason ?? 'Select a session folder'
        : !exists
        ? 'Folder not found'
        : partialStatus ?? (sourceStats.sessionCount > 0 ? 'Connected' : 'No sessions found'),
    };
  });
}
