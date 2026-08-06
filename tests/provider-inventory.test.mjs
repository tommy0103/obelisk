import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClaudeProvider } from '../packages/core/src/providers/claude.ts';
import { createCodexProvider } from '../packages/core/src/providers/codex.ts';
import { createKimiProvider } from '../packages/core/src/providers/kimi.ts';

const providers = [
  ['claude', createClaudeProvider, 'projects'],
  ['codex', createCodexProvider, 'sessions'],
  ['kimi', createKimiProvider, 'sessions'],
];

for (const [name, createProvider, inventoryDir] of providers) {
  test(`${name} reports directory enumeration failures`, () => {
    const root = mkdtempSync(join(tmpdir(), `obelisk-${name}-inventory-`));
    const sourcePath = join(root, inventoryDir);
    writeFileSync(sourcePath, 'not a directory');
    let issue;
    try {
      const units = createProvider({ rootDir: root }).discover({
        lastCursor: () => null,
        reportIncompleteInventory(value) { issue = value; },
      });
      assert.deepEqual(units, []);
      assert.equal(issue.path, sourcePath);
      assert.match(issue.error, /ENOTDIR|not a directory/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`${name} treats a missing source as incomplete only when prior sessions exist`, () => {
    const root = join(mkdtempSync(join(tmpdir(), `obelisk-${name}-missing-`)), 'absent');
    const provider = createProvider({ rootDir: root });
    const issues = [];
    const context = {
      lastCursor: () => null,
      reportIncompleteInventory(value) { issues.push(value); },
    };

    assert.deepEqual(provider.discover(context), []);
    assert.deepEqual(issues, []);
    assert.deepEqual(provider.discover({
      ...context,
      indexedSessions: () => [{ sessionId: 'prior', jsonlPath: '/prior/source' }],
    }), []);
    assert.deepEqual(issues, [{
      path: join(root, inventoryDir),
      error: 'Source folder is unavailable',
    }]);
  });
}

test('Kimi recovers its session unit key from canonical wire provenance', () => {
  const root = join(tmpdir(), 'obelisk-kimi-unit-key');
  const sessionDir = join(root, 'sessions', 'workspace', 'session');
  const provider = createKimiProvider({ rootDir: root });

  assert.equal(provider.sessionUnitKey({
    sessionId: 'kimi:session',
    jsonlPath: join(sessionDir, 'agents', 'main', 'wire.jsonl'),
  }), sessionDir);
  assert.equal(provider.sessionUnitKey({
    sessionId: 'kimi:legacy',
    jsonlPath: join(sessionDir, 'wire.jsonl'),
  }), sessionDir);
});
