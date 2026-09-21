// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { createProviderRegistry } from '../packages/core/src/providers/registry.ts';
import { createBuiltinProviderRegistry } from '../packages/core/src/providers/builtins.ts';

function fakeProvider(id, root) {
  return {
    name: id,
    descriptor: {
      id,
      name: `${id} display`,
      vendor: `${id} vendor`,
      defaultRoot: root,
      color: '#123456',
    },
    watchTargets(configuredRoot) {
      return [
        { kind: 'tree', path: `${configuredRoot}/sessions` },
        { kind: 'file', path: `${configuredRoot}/session-index` },
      ];
    },
    discover() {
      return [];
    },
    *parse() {
      yield* [];
      return null;
    },
    raw(input) {
      return { text: `${id}:${input.messageUuid}` };
    },
  };
}

test('provider registry drives source catalog, watch roots, and raw lookup', () => {
  const registry = createProviderRegistry([
    fakeProvider('alpha', '/default/alpha'),
    fakeProvider('beta', '/default/beta'),
  ]);

  assert.deepEqual(registry.catalog(), [
    { id: 'alpha', name: 'alpha display', vendor: 'alpha vendor', defaultRoot: '/default/alpha', color: '#123456' },
    { id: 'beta', name: 'beta display', vendor: 'beta vendor', defaultRoot: '/default/beta', color: '#123456' },
  ]);
  assert.deepEqual(registry.watchTargets({ alpha: '/custom/alpha' }), [
    { kind: 'tree', path: '/custom/alpha/sessions' },
    { kind: 'file', path: '/custom/alpha/session-index' },
    { kind: 'tree', path: '/default/beta/sessions' },
    { kind: 'file', path: '/default/beta/session-index' },
  ]);
  assert.deepEqual(
    registry.raw({ source: 'beta', messageUuid: 'message-1', session: null, agentId: null }),
    { text: 'beta:message-1' },
  );
  assert.equal(
    registry.raw({ source: 'missing', messageUuid: 'message-1', session: null, agentId: null }),
    null,
  );
});

test('built-in provider registry exposes every source without caller-side branching', () => {
  const registry = createBuiltinProviderRegistry({
    claude: '/sources/claude',
    codex: '/sources/codex',
    copilot: '/sources/copilot',
    deepseek: '/sources/deepseek',
    kimi: '/sources/kimi',
    omp: '/sources/omp',
    pi: '/sources/pi',
  });

  assert.deepEqual(registry.catalog().map(({ id, name }) => ({ id, name })), [
    { id: 'claude', name: 'Claude Code' },
    { id: 'codex', name: 'Codex' },
    { id: 'copilot', name: 'GitHub Copilot' },
    { id: 'deepseek', name: 'DeepSeek Harness' },
    { id: 'kimi', name: 'Kimi Code' },
    { id: 'omp', name: 'OMP' },
    { id: 'pi', name: 'Pi' },
  ]);
  assert.deepEqual(registry.watchTargets(), [
    { kind: 'tree', path: join('/sources/claude', 'projects') },
    { kind: 'file', path: join('/sources/claude', 'history.jsonl') },
    { kind: 'tree', path: join('/sources/codex', 'sessions') },
    { kind: 'tree', path: join('/sources/codex', 'archived_sessions') },
    { kind: 'file', path: join('/sources/codex', 'session_index.jsonl') },
    { kind: 'file', path: join('/sources/copilot', 'globalStorage', 'github.copilot-chat', 'session-store.db') },
    { kind: 'file', path: join('/sources/copilot', 'globalStorage', 'github.copilot-chat', 'session-store.db-wal') },
    { kind: 'tree', path: join('/sources/copilot', 'workspaceStorage') },
    { kind: 'tree', path: '/sources/deepseek' },
    { kind: 'tree', path: join('/sources/kimi', 'sessions') },
    { kind: 'file', path: join('/sources/kimi', 'session_index.jsonl') },
    { kind: 'tree', path: join('/sources/omp') },
    { kind: 'tree', path: join('/sources/pi') },
  ]);
});
