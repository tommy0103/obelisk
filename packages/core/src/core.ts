// Obelisk Core package (see docs/adr/0003-core-typescript-esm-precompiled.md).
//
// The single shared implementation behind every transport. The CLI and later
// the MCP server are thin shells over these four functions;
// none of them re-implement retrieval or own the DB lifecycle.
//
// Authored in TypeScript with erasable-only syntax so Node can run it directly
// via type stripping in development, while the CLI package ships readable,
// non-bundled tsc output. Core source lives in the @obelisk/core workspace.

import { createContext, runInNewContext } from 'node:vm';

import { DB_PATH, openDb, openReadDb, openWriterLeaseDb } from './db.ts';
import { buildIndex, ensureReadableSchema, shouldSkipBuild } from './indexer.ts';
import {
  createConfiguredBuiltinProviderRuntime,
  readPersistedProviderSettings,
} from './provider-settings.ts';
import type { ProviderRegistry } from './providers/registry.ts';
import { createQueryApi, createAttuneApi } from './query.ts';
import { acquireWriterLease, writerLockPathFor } from './writer-lease.ts';

export { buildIndex, DB_PATH };

type SandboxApi = Record<string, unknown>;

interface InventoryIssue {
  provider?: unknown;
  path?: unknown;
  error?: unknown;
}

function reportIncompleteInventory(build: unknown): void {
  if (build === null || typeof build !== 'object' || !('inventoryIssues' in build)) return;
  const issues = (build as { inventoryIssues?: unknown }).inventoryIssues;
  if (!Array.isArray(issues)) return;
  for (const value of issues) {
    const issue = value as InventoryIssue | null;
    if (
      issue !== null
      && typeof issue.provider === 'string'
      && typeof issue.path === 'string'
      && typeof issue.error === 'string'
    ) {
      process.stderr.write(
        `Warning: incomplete ${issue.provider} source inventory at ${issue.path}: ${issue.error}\n`,
      );
    }
  }
}

function refreshQueryIndex(): ProviderRegistry {
  const settings = readPersistedProviderSettings();
  const providerRegistry = createConfiguredBuiltinProviderRuntime(settings.settings).registry;
  if (!settings.ok) {
    const schema = ensureReadableSchema();
    if (!schema.ready) {
      throw new Error(`Obelisk index schema upgrade is blocked by ${schema.reason ?? 'an unknown writer'}`);
    }
    process.stderr.write(`Warning: ${settings.error}; index refresh skipped\n`);
    return providerRegistry;
  }
  reportIncompleteInventory(buildIndex({ providerRegistry }));
  return providerRegistry;
}

function rethrowUnlessSchemaBlocked(error: unknown): never {
  const schema = ensureReadableSchema();
  if (!schema.ready) {
    throw new Error(`Obelisk index schema upgrade is blocked by ${schema.reason ?? 'an unknown writer'}`);
  }
  throw error;
}

// Run a user-supplied CodeAct script inside the query/attune sandbox. The script
// body runs as an async IIFE with a 30s timeout; its `return` value is resolved.
function runInSandbox(api: SandboxApi, scriptContent: string): Promise<unknown> {
  const sandbox = {
    ...api, JSON, Math, Array, Object, Set, Map, Date, RegExp,
    parseInt, parseFloat, String, Number, Boolean, Error, Promise, console, setTimeout,
  };
  const ctx = createContext(sandbox);
  return runInNewContext(`(async()=>{${scriptContent}})()`, ctx, { timeout: 30000 });
}

// FTS search over indexed message text. Refreshes the index, then queries.
export function searchText(text: string, opts?: Record<string, unknown>): unknown {
  const providerRegistry = refreshQueryIndex();
  const db = openReadDb();
  try {
    try {
      return createQueryApi(db, { providerRegistry }).search(text, opts);
    } catch (error) {
      return rethrowUnlessSchemaBlocked(error);
    }
  } finally {
    db.close();
  }
}

// Execute a read-only CodeAct query script and resolve its returned value.
export async function executeQuery(scriptContent: string): Promise<unknown> {
  const providerRegistry = refreshQueryIndex();
  const db = openReadDb();
  try {
    try {
      return await runInSandbox(createQueryApi(db, { providerRegistry }), scriptContent);
    } catch (error) {
      return rethrowUnlessSchemaBlocked(error);
    }
  } finally {
    db.close();
  }
}

// Execute a memory-mutation CodeAct script (remember/forget only).
export async function executeAttune(scriptContent: string): Promise<unknown> {
  const settings = readPersistedProviderSettings();
  if (!settings.ok) throw new Error(`${settings.error}; attune was not applied`);
  const providerRegistry = createConfiguredBuiltinProviderRuntime(settings.settings).registry;
  const build = buildIndex({ providerRegistry }) as { reason?: string } | undefined;
  reportIncompleteInventory(build);
  if (build?.reason === 'daemon_active') {
    throw new Error('Obelisk daemon owns index writes; attune is read-only until the daemon stops');
  }
  if (build?.reason === 'writer_busy' || build?.reason === 'database_busy') {
    throw new Error('Obelisk index writer is busy; attune was not applied');
  }
  const lease = acquireWriterLease({
    lockPath: writerLockPathFor(DB_PATH),
    openDb: openWriterLeaseDb,
    waitMs: 1000,
  });
  if (!lease) throw new Error('Obelisk index writer is busy; attune was not applied');
  try {
    // Close the heartbeat TOCTOU window after acquiring the hard lease.
    const ownershipDb = openReadDb();
    try {
      const ownership = shouldSkipBuild(ownershipDb, { ignoreRecentBuild: true });
      if (ownership.reason === 'daemon_active') {
        throw new Error('Obelisk daemon owns index writes; attune is read-only until the daemon stops');
      }
    } finally {
      ownershipDb.close();
    }
    const db = openDb();
    try {
      return await runInSandbox(createAttuneApi(db), scriptContent);
    } finally {
      db.close();
    }
  } finally {
    lease.release();
  }
}
