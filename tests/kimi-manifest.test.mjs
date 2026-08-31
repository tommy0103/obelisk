// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { after, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';

import { makeTempDir } from './temp-dirs.mjs';

let forbidSessionBodyReads = false;
let failingStatPath = null;
let mutateAfterReadPath = null;
let mutatedAfterRead = false;
const fsMock = mock.module('node:fs', {
  namedExports: {
    ...fs,
    readFileSync(path, ...args) {
      if (forbidSessionBodyReads && (
        String(path).endsWith('state.json') || String(path).endsWith('wire.jsonl')
      )) {
        throw new Error(`unchanged discovery read a session body: ${path}`);
      }
      const result = fs.readFileSync(path, ...args);
      if (
        mutateAfterReadPath !== null
        && String(path) === mutateAfterReadPath
        && !mutatedAfterRead
      ) {
        mutatedAfterRead = true;
        fs.appendFileSync(path, '{"type":"metadata","created_at":3}\n');
      }
      return result;
    },
    statSync(path, ...args) {
      if (failingStatPath !== null && String(path) === failingStatPath) {
        const error = new Error(`simulated disappearance: ${path}`);
        error.code = 'ENOENT';
        throw error;
      }
      return fs.statSync(path, ...args);
    },
  },
});

after(() => {
  fsMock.restore();
  mock.reset();
});

function writeSession(root) {
  const sessionDir = join(root, 'sessions', 'workspace-1', 'session-1');
  const mainDir = join(sessionDir, 'agents', 'main');
  fs.mkdirSync(mainDir, { recursive: true });
  fs.writeFileSync(join(sessionDir, 'state.json'), JSON.stringify({
    title: 'Manifest fixture',
    workDir: '/tmp/kimi-manifest',
  }));
  fs.writeFileSync(join(mainDir, 'wire.jsonl'), [
    JSON.stringify({ type: 'metadata', protocol_version: '1.5', created_at: 1 }),
    JSON.stringify({
      type: 'context.append_message',
      time: 2,
      message: { role: 'user', content: 'hello', toolCalls: [], origin: { kind: 'user' } },
    }),
    '',
  ].join('\n'));
  return sessionDir;
}

function drain(generator) {
  const values = [];
  let step = generator.next();
  while (!step.done) {
    values.push(step.value);
    step = generator.next();
  }
  return { values, cursor: step.value };
}

async function loadKimiProvider(label) {
  const moduleUrl = new URL('../packages/core/src/providers/kimi.ts', import.meta.url);
  return import(`${moduleUrl.href}?manifest-test=${label}-${Date.now()}`);
}

test('Kimi unchanged discovery never reads state or wire bodies', async () => {
  const root = makeTempDir('obelisk-kimi-manifest-no-body-read-');
  const sessionDir = writeSession(root);
  try {
    const { createKimiProvider } = await loadKimiProvider('no-body-read');
    const provider = createKimiProvider({ rootDir: root });
    const initial = provider.discover({ lastCursor: () => null });
    assert.equal(initial.length, 1);
    assert.equal(initial[0].key, sessionDir);
    assert.equal(initial[0].meta.mode, 'replay');

    forbidSessionBodyReads = true;
    assert.deepEqual(provider.discover({
      lastCursor: () => initial[0].meta.currentCursor,
    }), []);
  } finally {
    forbidSessionBodyReads = false;
  }
});

test('Kimi parse rejects a member added after discovery', async () => {
  const root = makeTempDir('obelisk-kimi-manifest-added-member-');
  const sessionDir = writeSession(root);
  const { createKimiProvider } = await loadKimiProvider('added-member');
  const provider = createKimiProvider({ rootDir: root });
  const unit = provider.discover({ lastCursor: () => null })[0];

  const childDir = join(sessionDir, 'agents', 'child-1');
  fs.mkdirSync(childDir, { recursive: true });
  fs.writeFileSync(join(childDir, 'wire.jsonl'), '{"type":"metadata"}\n');

  assert.throws(
    () => drain(provider.parse(unit, null)),
    /Kimi session changed while indexing/,
  );
});

test('Kimi discovery retracts an indexed session that loses its last wire', async () => {
  const root = makeTempDir('obelisk-kimi-manifest-last-wire-');
  const sessionDir = writeSession(root);
  const { createKimiProvider } = await loadKimiProvider('last-wire');
  const provider = createKimiProvider({ rootDir: root });
  const initial = provider.discover({ lastCursor: () => null })[0];
  fs.rmSync(join(sessionDir, 'agents', 'main', 'wire.jsonl'));

  const [tombstone] = provider.discover({
    lastCursor: () => initial.meta.currentCursor,
  });
  assert.equal(tombstone.key, sessionDir);
  assert.deepEqual(tombstone.meta.wireFiles, []);
  assert.equal(tombstone.meta.mode, 'tombstone');

  const parsed = drain(provider.parse(tombstone, initial.meta.currentCursor));
  assert.deepEqual(parsed.values, [{ kind: 'delete-session', sessionId: 'kimi:session-1' }]);
  assert.match(parsed.cursor, /^\d+:0:kimi-manifest-v1:[A-Za-z0-9_-]+$/);
});

test('Kimi discovery ignores an empty session that was never indexed', async () => {
  const root = makeTempDir('obelisk-kimi-manifest-new-empty-');
  const sessionDir = join(root, 'sessions', 'workspace-1', 'empty-session');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(join(sessionDir, 'state.json'), '{"title":"New Session"}\n');
  const { createKimiProvider } = await loadKimiProvider('new-empty');

  assert.deepEqual(createKimiProvider({ rootDir: root }).discover({
    lastCursor: () => null,
  }), []);
});

test('Kimi full replay retracts an indexed session after its last wire disappears', async () => {
  const root = makeTempDir('obelisk-kimi-manifest-full-replay-tombstone-');
  const sessionDir = writeSession(root);
  const mainWire = join(sessionDir, 'agents', 'main', 'wire.jsonl');
  fs.rmSync(mainWire);
  const { createKimiProvider } = await loadKimiProvider('full-replay-tombstone');

  const [tombstone] = createKimiProvider({ rootDir: root }).discover({
    lastCursor: () => null,
    indexedSessions: () => [{ sessionId: 'kimi:session-1', jsonlPath: mainWire }],
  });
  assert.equal(tombstone.key, sessionDir);
  assert.deepEqual(
    drain(createKimiProvider({ rootDir: root }).parse(tombstone, null)).values,
    [{ kind: 'delete-session', sessionId: 'kimi:session-1' }],
  );
});

test('Kimi discovery reports a member that disappears during snapshotting', async () => {
  const root = makeTempDir('obelisk-kimi-manifest-stat-race-');
  const sessionDir = writeSession(root);
  const wirePath = join(sessionDir, 'agents', 'main', 'wire.jsonl');
  const { createKimiProvider } = await loadKimiProvider('stat-race');
  const issues = [];
  failingStatPath = wirePath;
  try {
    assert.deepEqual(createKimiProvider({ rootDir: root }).discover({
      lastCursor: () => null,
      reportIncompleteInventory: issue => issues.push(issue),
    }), []);
  } finally {
    failingStatPath = null;
  }
  assert.equal(issues.length, 1);
  assert.equal(issues[0].path, sessionDir);
  assert.match(issues[0].error, /ENOENT|simulated disappearance/);
});

test('Kimi discovery detects an append even when mtime is restored', async () => {
  const root = makeTempDir('obelisk-kimi-manifest-same-mtime-append-');
  const sessionDir = writeSession(root);
  const wirePath = join(sessionDir, 'agents', 'main', 'wire.jsonl');
  const { createKimiProvider } = await loadKimiProvider('same-mtime-append');
  const provider = createKimiProvider({ rootDir: root });
  const initial = provider.discover({ lastCursor: () => null })[0];
  const before = fs.statSync(wirePath);

  fs.appendFileSync(wirePath, '{"type":"metadata","created_at":3}\n');
  fs.utimesSync(wirePath, before.atime, before.mtime);

  assert.deepEqual(provider.discover({
    lastCursor: () => initial.meta.currentCursor,
  }).map(unit => unit.key), [sessionDir]);
});

test('Kimi discovery detects a same-size rewrite with restored mtime', {
  skip: process.platform === 'win32' && 'Windows ctime is creation time',
}, async () => {
  const root = makeTempDir('obelisk-kimi-manifest-same-size-rewrite-');
  const sessionDir = writeSession(root);
  const wirePath = join(sessionDir, 'agents', 'main', 'wire.jsonl');
  const { createKimiProvider } = await loadKimiProvider('same-size-rewrite');
  const provider = createKimiProvider({ rootDir: root });
  const initial = provider.discover({ lastCursor: () => null })[0];
  const before = fs.statSync(wirePath);
  const original = fs.readFileSync(wirePath, 'utf8');
  const rewritten = original.replace('hello', 'hullo');
  assert.equal(Buffer.byteLength(rewritten), Buffer.byteLength(original));

  fs.writeFileSync(wirePath, rewritten);
  fs.utimesSync(wirePath, before.atime, before.mtime);

  assert.deepEqual(provider.discover({
    lastCursor: () => initial.meta.currentCursor,
  }).map(unit => unit.key), [sessionDir]);
});

test('Kimi discovery detects removal of one member from a multi-wire session', async () => {
  const root = makeTempDir('obelisk-kimi-manifest-member-removal-');
  const sessionDir = writeSession(root);
  const childDir = join(sessionDir, 'agents', 'child-1');
  fs.mkdirSync(childDir, { recursive: true });
  fs.writeFileSync(join(childDir, 'wire.jsonl'), '{"type":"metadata"}\n');
  const { createKimiProvider } = await loadKimiProvider('member-removal');
  const provider = createKimiProvider({ rootDir: root });
  const initial = provider.discover({ lastCursor: () => null })[0];

  fs.rmSync(childDir, { recursive: true });

  assert.deepEqual(provider.discover({
    lastCursor: () => initial.meta.currentCursor,
  }).map(unit => unit.key), [sessionDir]);
});

test('Kimi parse rejects a wire append that races projection', async () => {
  const root = makeTempDir('obelisk-kimi-manifest-parse-race-');
  const sessionDir = writeSession(root);
  const wirePath = join(sessionDir, 'agents', 'main', 'wire.jsonl');
  const { createKimiProvider } = await loadKimiProvider('parse-race');
  const provider = createKimiProvider({ rootDir: root });
  const unit = provider.discover({ lastCursor: () => null })[0];
  mutateAfterReadPath = wirePath;
  mutatedAfterRead = false;
  try {
    assert.throws(
      () => drain(provider.parse(unit, null)),
      /Kimi session changed while indexing/,
    );
  } finally {
    mutateAfterReadPath = null;
    mutatedAfterRead = false;
  }
});
