import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createConfiguredBuiltinProviderRuntime,
  readPersistedProviderSettings,
} from '../packages/core/src/provider-settings.ts';
import { createProviderRegistry } from '../packages/core/src/providers/registry.ts';
import {
  buildSourceCatalog,
  resolveProviderRoots,
  setPersistedSetting,
} from '../app/src/main/provider-settings.ts';

function provider(id, defaultRoot, color, descriptor = {}) {
  return {
    name: id,
    descriptor: { id, name: `${id} name`, vendor: `${id} vendor`, defaultRoot, color, ...descriptor },
    watchRoots: () => [],
    discover: () => [],
    *parse() { yield* []; return null; },
    raw: () => null,
  };
}

test('provider roots and source settings are derived from the registry without source branches', () => {
  const registry = createProviderRegistry([
    provider('alpha', '/default/alpha', '#112233'),
    provider('beta', '/default/beta', '#445566'),
  ]);
  const persisted = {
    alphaDir: '/legacy/alpha',
    providerRoots: { beta: '/custom/beta' },
  };

  assert.deepEqual(resolveProviderRoots(registry, persisted), {
    alpha: '/legacy/alpha',
    beta: '/custom/beta',
  });

  const rootsChanged = setPersistedSetting(persisted, 'providerRoots.alpha', '/custom/alpha');
  assert.equal(rootsChanged, true);
  assert.deepEqual(persisted.providerRoots, {
    alpha: '/custom/alpha',
    beta: '/custom/beta',
  });

  const sources = buildSourceCatalog({
    registry,
    roots: resolveProviderRoots(registry, persisted),
    stats: new Map([
      ['alpha', { sessionCount: 2, lastIndexed: '2026-07-20T10:00:00.000Z' }],
      ['beta', { sessionCount: 0, lastIndexed: '' }],
    ]),
    pathExists: path => path === '/custom/alpha' || path === '/custom/beta',
  });

  assert.deepEqual(sources, [
    {
      id: 'alpha', name: 'alpha name', vendor: 'alpha vendor', color: '#112233',
      path: '/custom/alpha', settingKey: 'providerRoots.alpha', exists: true,
      sessionCount: 2, lastIndexed: '2026-07-20T10:00:00.000Z',
      status: 'ok', statusText: 'Connected',
    },
    {
      id: 'beta', name: 'beta name', vendor: 'beta vendor', color: '#445566',
      path: '/custom/beta', settingKey: 'providerRoots.beta', exists: true,
      sessionCount: 0, lastIndexed: '', status: 'warn', statusText: 'No sessions found',
    },
  ]);
});

test('removing a generic provider root restores its descriptor default', () => {
  const registry = createProviderRegistry([provider('gamma', '/default/gamma', '#778899')]);
  const persisted = { providerRoots: { gamma: '/custom/gamma' } };

  assert.equal(setPersistedSetting(persisted, 'providerRoots.gamma', null), true);
  assert.deepEqual(resolveProviderRoots(registry, persisted), { gamma: '/default/gamma' });
});

test('source catalog surfaces exact provider issues without hiding indexed sessions', () => {
  const registry = createProviderRegistry([
    provider('alpha', '/default/alpha', '#112233'),
  ]);

  assert.deepEqual(buildSourceCatalog({
    registry,
    roots: { alpha: '/custom/alpha' },
    stats: new Map([
      ['alpha', { sessionCount: 2, lastIndexed: '2026-07-20T10:00:00.000Z' }],
    ]),
    sourceIssues: [{
      provider: 'alpha',
      path: '/custom/alpha/locked',
      error: 'EACCES: permission denied',
    }],
    pathExists: () => true,
  }), [{
    id: 'alpha',
    name: 'alpha name',
    vendor: 'alpha vendor',
    color: '#112233',
    path: '/custom/alpha',
    settingKey: 'providerRoots.alpha',
    exists: true,
    sessionCount: 2,
    lastIndexed: '2026-07-20T10:00:00.000Z',
    status: 'warn',
    statusText: 'Index issue: /custom/alpha/locked — EACCES: permission denied',
  }]);
});

test('an ambiguous provider default stays omitted until the user selects a root', () => {
  const registry = createProviderRegistry([
    provider('relative', '/fallback/relative', '#999999', {
      requiresExplicitRoot: true,
      rootResolutionReason: 'Relative runtime setting needs an explicit folder',
    }),
  ]);

  assert.deepEqual(resolveProviderRoots(registry), {});
  assert.deepEqual(resolveProviderRoots(registry, {
    providerRoots: { relative: '/fallback/relative' },
  }), {
    relative: '/fallback/relative',
  });
  assert.deepEqual(buildSourceCatalog({
    registry,
    roots: {},
    pathExists: () => true,
  }), [{
    id: 'relative',
    name: 'relative name',
    vendor: 'relative vendor',
    color: '#999999',
    path: '/fallback/relative',
    settingKey: 'providerRoots.relative',
    exists: true,
    sessionCount: 0,
    lastIndexed: '',
    status: 'error',
    statusText: 'Relative runtime setting needs an explicit folder',
  }]);
});

test('provider roots expand a persisted home-relative path before registry construction', () => {
  const registry = createProviderRegistry([
    provider('alpha', '/default/alpha', '#112233'),
  ]);

  assert.deepEqual(resolveProviderRoots(
    registry,
    { providerRoots: { alpha: '~/custom/sessions' } },
    { homeDir: '/home/probe' },
  ), {
    alpha: '/home/probe/custom/sessions',
  });
});

test('relative provider roots never depend on the Obelisk process cwd', () => {
  const registry = createProviderRegistry([
    provider('alpha', '/default/alpha', '#112233'),
    provider('explicit', '/fallback/explicit', '#445566', { requiresExplicitRoot: true }),
  ]);

  assert.deepEqual(resolveProviderRoots(registry, {
    providerRoots: { alpha: './alpha', explicit: '../explicit' },
  }), {});
});

test('an invalid persisted root disables that provider instead of selecting its default', () => {
  const rawDir = mkdtempSync(join(tmpdir(), 'obelisk-disabled-provider-'));
  const rawPath = join(rawDir, 'session.jsonl');
  writeFileSync(rawPath, '{"uuid":"raw-message","message":{"content":"preserved"}}\n');
  const runtime = createConfiguredBuiltinProviderRuntime({
    providerRoots: { claude: './relative-claude' },
  }, {
    homeDir: '/home/probe',
    baseRoots: { claude: '/default/claude' },
  });
  const claude = runtime.registry.get('claude');

  assert.equal(runtime.roots.claude, undefined);
  assert.equal(claude.descriptor.requiresExplicitRoot, true);
  assert.deepEqual(claude.watchRoots('/default/claude'), []);
  let issue;
  assert.deepEqual(claude.discover({
    lastCursor: () => null,
    indexedSessions: () => [],
  }), []);
  assert.deepEqual(claude.discover({
    lastCursor: () => null,
    indexedSessions: () => [{ sessionId: 'claude:preserved', jsonlPath: rawPath }],
    reportIncompleteInventory(value) { issue = value; },
  }), []);
  assert.deepEqual(issue, {
    path: rawPath,
    error: 'Configured claude root must be absolute or start with ~',
  });
  assert.match(claude.raw({
    source: 'claude',
    messageUuid: 'raw-message',
    session: { id: 'claude:preserved', jsonl_path: rawPath },
    agentId: null,
    cursor: null,
    subagent: null,
    workflowAgent: null,
  }).text, /preserved/);
  rmSync(rawDir, { recursive: true, force: true });
});

test('malformed provider root containers cannot select defaults and are repairable', () => {
  const registry = createProviderRegistry([
    provider('alpha', '/default/alpha', '#112233'),
  ]);

  assert.deepEqual(resolveProviderRoots(registry, { providerRoots: [] }), {});
  assert.deepEqual(resolveProviderRoots(registry, { providerRoots: 'invalid' }), {});

  const persisted = { providerRoots: [] };
  assert.equal(setPersistedSetting(persisted, 'providerRoots.alpha', '/custom/alpha'), true);
  assert.deepEqual(persisted.providerRoots, { alpha: '/custom/alpha' });
});

test('settings reader rejects malformed provider root containers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'obelisk-provider-settings-'));
  const settingsPath = join(directory, 'settings.json');
  try {
    for (const providerRoots of [[], 'invalid']) {
      writeFileSync(settingsPath, JSON.stringify({ providerRoots }));
      const result = readPersistedProviderSettings(settingsPath);
      assert.equal(result.ok, false);
      assert.deepEqual(result.settings, {});
      assert.match(result.error, /providerRoots are not an object/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
