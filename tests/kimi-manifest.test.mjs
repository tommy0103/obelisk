// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { after, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';

import { makeTempDir } from './temp-dirs.mjs';

const REAL_STATE = fs.readFileSync(new URL('./fixtures/kimi/manifest-session/state.json', import.meta.url), 'utf8');
const REAL_WIRE = fs.readFileSync(new URL('./fixtures/kimi/manifest-session/agents/main/wire.jsonl', import.meta.url), 'utf8');
const REAL_METADATA_LINE = `${REAL_WIRE.split('\n')[0]}\n`;

let forbidSessionBodyReads = false;
let failingStatPath = null;
let failingStatCode = 'ENOENT';
let hiddenExistsPath = null;
let addMemberDuringStatSessionDir = null;
let addedMemberDuringStat = false;
let moveBeforeSessionReadFrom = null;
let moveBeforeSessionReadTo = null;
let addWireOnSecondInventory = null;
let inventoryReadCount = 0;
let mutateAfterReadPath = null;
let mutatedAfterRead = false;
const fsMock = mock.module('node:fs', {
  namedExports: {
    ...fs,
    readdirSync(path, ...args) {
      if (addWireOnSecondInventory !== null && String(path) === addWireOnSecondInventory.sessionsDir) {
        inventoryReadCount += 1;
        if (inventoryReadCount === 2) {
          const mainDir = join(addWireOnSecondInventory.sessionDir, 'agents', 'main');
          fs.mkdirSync(mainDir, { recursive: true });
          fs.writeFileSync(join(mainDir, 'wire.jsonl'), REAL_METADATA_LINE);
        }
      }
      if (moveBeforeSessionReadFrom !== null && String(path) === moveBeforeSessionReadFrom) {
        const target = moveBeforeSessionReadTo;
        moveBeforeSessionReadFrom = null;
        moveBeforeSessionReadTo = null;
        fs.renameSync(path, target);
      }
      return fs.readdirSync(path, ...args);
    },
    existsSync(path) {
      if (hiddenExistsPath !== null && String(path) === hiddenExistsPath) return false;
      return fs.existsSync(path);
    },
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
        fs.appendFileSync(path, REAL_METADATA_LINE);
      }
      return result;
    },
    statSync(path, ...args) {
      if (
        addMemberDuringStatSessionDir !== null
        && !addedMemberDuringStat
        && String(path).endsWith(join('agents', 'main', 'wire.jsonl'))
      ) {
        addedMemberDuringStat = true;
        const childDir = join(addMemberDuringStatSessionDir, 'agents', 'raced-child');
        fs.mkdirSync(childDir, { recursive: true });
        fs.writeFileSync(join(childDir, 'wire.jsonl'), REAL_METADATA_LINE);
      }
      if (failingStatPath !== null && String(path) === failingStatPath) {
        const error = new Error(`simulated disappearance: ${path}`);
        error.code = failingStatCode;
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

function writeSession(root, { workspace = 'workspace-1', session = 'session-1' } = {}) {
  const sessionDir = join(root, 'sessions', workspace, session);
  const mainDir = join(sessionDir, 'agents', 'main');
  fs.mkdirSync(mainDir, { recursive: true });
  fs.writeFileSync(join(sessionDir, 'state.json'), REAL_STATE);
  fs.writeFileSync(join(mainDir, 'wire.jsonl'), REAL_WIRE);
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
      indexedSessions: () => [],
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
  fs.writeFileSync(join(childDir, 'wire.jsonl'), REAL_METADATA_LINE);

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
    indexedSessions: () => [{
      sessionId: 'kimi:session-1',
      jsonlPath: join(sessionDir, 'agents', 'main', 'wire.jsonl'),
    }],
  });
  assert.equal(tombstone.key, sessionDir);
  assert.deepEqual(tombstone.meta.wireFiles, []);
  assert.equal(tombstone.meta.mode, 'tombstone');
  assert.deepEqual(tombstone.retractSessionIds, ['kimi:session-1']);

  const parsed = drain(provider.parse(tombstone, initial.meta.currentCursor));
  assert.deepEqual(parsed.values, []);
  assert.match(parsed.cursor, /^\d+:0:kimi-manifest-v1:[A-Za-z0-9_-]+$/);
});

test('Kimi discovery ignores an empty session that was never indexed', async () => {
  const root = makeTempDir('obelisk-kimi-manifest-new-empty-');
  const sessionDir = join(root, 'sessions', 'workspace-1', 'empty-session');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(join(sessionDir, 'state.json'), REAL_STATE);
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
  assert.deepEqual(tombstone.retractSessionIds, ['kimi:session-1']);
  assert.deepEqual(
    drain(createKimiProvider({ rootDir: root }).parse(tombstone, null)).values,
    [],
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

test('Kimi discovery never treats an inaccessible member as deleted', async () => {
  const root = makeTempDir('obelisk-kimi-manifest-permission-');
  const sessionDir = writeSession(root);
  const wirePath = join(sessionDir, 'agents', 'main', 'wire.jsonl');
  const { createKimiProvider } = await loadKimiProvider('permission');
  const provider = createKimiProvider({ rootDir: root });
  const initial = provider.discover({ lastCursor: () => null })[0];
  const issues = [];
  hiddenExistsPath = wirePath;
  failingStatPath = wirePath;
  failingStatCode = 'EACCES';
  try {
    assert.deepEqual(provider.discover({
      lastCursor: () => initial.meta.currentCursor,
      reportIncompleteInventory: issue => issues.push(issue),
    }), []);
  } finally {
    hiddenExistsPath = null;
    failingStatPath = null;
    failingStatCode = 'ENOENT';
  }
  assert.equal(issues.length, 1);
  assert.equal(issues[0].path, sessionDir);
  assert.match(issues[0].error, /EACCES|simulated disappearance/);
});

test('Kimi discovery rejects a member added while its snapshot is being captured', async () => {
  const root = makeTempDir('obelisk-kimi-manifest-member-race-');
  const sessionDir = writeSession(root);
  const { createKimiProvider } = await loadKimiProvider('member-race');
  const provider = createKimiProvider({ rootDir: root });
  const initial = provider.discover({ lastCursor: () => null })[0];
  const issues = [];
  addMemberDuringStatSessionDir = sessionDir;
  addedMemberDuringStat = false;
  try {
    assert.deepEqual(provider.discover({
      lastCursor: () => initial.meta.currentCursor,
      reportIncompleteInventory: issue => issues.push(issue),
    }), []);
  } finally {
    addMemberDuringStatSessionDir = null;
    addedMemberDuringStat = false;
  }
  assert.equal(issues.length, 1);
  assert.equal(issues[0].path, sessionDir);
  assert.match(issues[0].error, /changed while snapshotting/);
});

test('Kimi discovery rejects a directory move during the identity census', async () => {
  const root = makeTempDir('obelisk-kimi-manifest-directory-race-');
  const sessionDir = writeSession(root);
  const mainWire = join(sessionDir, 'agents', 'main', 'wire.jsonl');
  const movedSessionDir = join(root, 'sessions', 'workspace-2', 'session-1');
  fs.mkdirSync(join(root, 'sessions', 'workspace-2'), { recursive: true });
  const { createKimiProvider } = await loadKimiProvider('directory-race');
  const provider = createKimiProvider({ rootDir: root });
  const initial = provider.discover({ lastCursor: () => null })[0];
  const issues = [];

  moveBeforeSessionReadFrom = sessionDir;
  moveBeforeSessionReadTo = movedSessionDir;
  try {
    assert.deepEqual(provider.discover({
      lastCursor: key => key === sessionDir ? initial.meta.currentCursor : null,
      indexedSessions: () => [{ sessionId: 'kimi:session-1', jsonlPath: mainWire }],
      reportIncompleteInventory: issue => issues.push(issue),
    }), []);
  } finally {
    moveBeforeSessionReadFrom = null;
    moveBeforeSessionReadTo = null;
  }
  assert.equal(issues.length, 1);
  assert.match(issues[0].error, /inventory changed during discovery/);
});

test('Kimi discovery emits a tombstone when an indexed session directory is deleted', async () => {
  const root = makeTempDir('obelisk-kimi-manifest-session-delete-');
  const sessionDir = writeSession(root);
  const mainWire = join(sessionDir, 'agents', 'main', 'wire.jsonl');
  const { createKimiProvider } = await loadKimiProvider('session-delete');
  const provider = createKimiProvider({ rootDir: root });
  const initial = provider.discover({ lastCursor: () => null })[0];
  fs.rmSync(sessionDir, { recursive: true });

  const [tombstone] = provider.discover({
    lastCursor: key => key === sessionDir ? initial.meta.currentCursor : null,
    indexedSessions: () => [{ sessionId: 'kimi:session-1', jsonlPath: mainWire }],
  });
  assert.equal(tombstone.key, sessionDir);
  assert.equal(tombstone.meta.mode, 'tombstone');
  assert.deepEqual(tombstone.retractSessionIds, ['kimi:session-1']);
  assert.deepEqual(drain(provider.parse(tombstone, initial.meta.currentCursor)).values, []);
});

test('Kimi discovery fails closed when two directories share one session identity', async () => {
  const root = makeTempDir('obelisk-kimi-manifest-duplicate-identity-');
  const sessionDir = writeSession(root);
  const mainWire = join(sessionDir, 'agents', 'main', 'wire.jsonl');
  const duplicateDir = join(root, 'sessions', 'workspace-2', 'session-1');
  fs.cpSync(sessionDir, duplicateDir, { recursive: true });
  const { createKimiProvider } = await loadKimiProvider('duplicate-identity');
  const issues = [];

  const units = createKimiProvider({ rootDir: root }).discover({
    lastCursor: () => null,
    indexedSessions: () => [{ sessionId: 'kimi:session-1', jsonlPath: mainWire }],
    reportIncompleteInventory: issue => issues.push(issue),
  });
  assert.deepEqual(units, []);
  assert.equal(issues.length, 1);
  assert.match(issues[0].error, /share identity kimi:session-1/);
});

test('Kimi discovery ignores a stale empty duplicate when one live identity remains', async () => {
  const root = makeTempDir('obelisk-kimi-manifest-stale-empty-identity-');
  const indexedSessionDir = writeSession(root);
  const indexedWire = join(indexedSessionDir, 'agents', 'main', 'wire.jsonl');
  const liveSessionDir = join(root, 'sessions', 'workspace-2', 'session-1');
  fs.mkdirSync(join(root, 'sessions', 'workspace-2'), { recursive: true });
  fs.renameSync(indexedSessionDir, liveSessionDir);
  fs.mkdirSync(indexedSessionDir, { recursive: true });
  const { createKimiProvider } = await loadKimiProvider('stale-empty-identity');
  const issues = [];

  const [replay] = createKimiProvider({ rootDir: root }).discover({
    lastCursor: () => null,
    indexedSessions: () => [{ sessionId: 'kimi:session-1', jsonlPath: indexedWire }],
    reportIncompleteInventory: issue => issues.push(issue),
  });
  assert.equal(replay.key, liveSessionDir);
  assert.equal(replay.meta.mode, 'replay');
  assert.deepEqual(issues, []);
});

test('Kimi discovery retracts an old identity replaced at the same path', async () => {
  const root = makeTempDir('obelisk-kimi-manifest-identity-replacement-');
  const sessionDir = writeSession(root);
  const mainWire = join(sessionDir, 'agents', 'main', 'wire.jsonl');
  const { createKimiProvider } = await loadKimiProvider('identity-replacement');
  const issues = [];

  const [replay] = createKimiProvider({ rootDir: root }).discover({
    lastCursor: () => null,
    indexedSessions: () => [{ sessionId: 'kimi:replaced-session', jsonlPath: mainWire }],
    reportIncompleteInventory: issue => issues.push(issue),
  });
  assert.equal(replay.sessionId, 'kimi:session-1');
  assert.deepEqual(replay.retractSessionIds, ['kimi:replaced-session']);
  assert.deepEqual(issues, []);
});

test('Kimi changed-path replacement preserves the old identity live at another path', async () => {
  const root = makeTempDir('obelisk-kimi-manifest-move-replacement-');
  const oldIdentityDir = writeSession(root, { workspace: 'workspace-2', session: 'old-session' });
  const replacementDir = writeSession(root, { workspace: 'workspace-1', session: 'new-session' });
  const replacementWire = join(replacementDir, 'agents', 'main', 'wire.jsonl');
  const { createKimiProvider } = await loadKimiProvider('move-replacement');

  const units = createKimiProvider({ rootDir: root }).discover({
    lastCursor: () => null,
    changedPaths: [replacementDir],
    indexedSessions: () => [{ sessionId: 'kimi:old-session', jsonlPath: replacementWire }],
  });
  assert.deepEqual(
    units.map(unit => ({ key: unit.key, sessionId: unit.sessionId, retract: unit.retractSessionIds ?? [] })),
    [
      { key: replacementDir, sessionId: 'kimi:new-session', retract: [] },
      { key: oldIdentityDir, sessionId: 'kimi:old-session', retract: [] },
    ],
  );
});

test('Kimi tombstones revalidate an empty identity directory before publication', async () => {
  const root = makeTempDir('obelisk-kimi-manifest-late-wire-');
  const sessionsDir = join(root, 'sessions');
  const emptySessionDir = join(sessionsDir, 'workspace-2', 'session-1');
  const oldSessionDir = join(sessionsDir, 'workspace-1', 'session-1');
  fs.mkdirSync(emptySessionDir, { recursive: true });
  fs.writeFileSync(join(emptySessionDir, 'state.json'), REAL_STATE);
  const { createKimiProvider } = await loadKimiProvider('late-wire');
  const issues = [];

  addWireOnSecondInventory = { sessionsDir, sessionDir: emptySessionDir };
  inventoryReadCount = 0;
  try {
    assert.deepEqual(createKimiProvider({ rootDir: root }).discover({
      lastCursor: () => null,
      indexedSessions: () => [{
        sessionId: 'kimi:session-1',
        jsonlPath: join(oldSessionDir, 'agents', 'main', 'wire.jsonl'),
      }],
      reportIncompleteInventory: issue => issues.push(issue),
    }), []);
  } finally {
    addWireOnSecondInventory = null;
    inventoryReadCount = 0;
  }
  assert.equal(issues.length, 1);
  assert.match(issues[0].error, /changed during discovery/);
});

test('Kimi tombstone parse rejects an identity that becomes live after discovery', async () => {
  const root = makeTempDir('obelisk-kimi-manifest-post-discovery-tombstone-');
  const emptySessionDir = join(root, 'sessions', 'workspace-2', 'session-1');
  const oldSessionDir = join(root, 'sessions', 'workspace-1', 'session-1');
  fs.mkdirSync(emptySessionDir, { recursive: true });
  fs.writeFileSync(join(emptySessionDir, 'state.json'), REAL_STATE);
  const { createKimiProvider } = await loadKimiProvider('post-discovery-tombstone');
  const provider = createKimiProvider({ rootDir: root });
  const [tombstone] = provider.discover({
    lastCursor: () => null,
    indexedSessions: () => [{
      sessionId: 'kimi:session-1',
      jsonlPath: join(oldSessionDir, 'agents', 'main', 'wire.jsonl'),
    }],
  });

  const mainDir = join(emptySessionDir, 'agents', 'main');
  fs.mkdirSync(mainDir, { recursive: true });
  fs.writeFileSync(join(mainDir, 'wire.jsonl'), REAL_METADATA_LINE);
  assert.throws(
    () => drain(provider.parse(tombstone, null)),
    /identity changed while indexing/,
  );
});

test('Kimi moved replay rejects a duplicate that becomes live after discovery', async () => {
  const root = makeTempDir('obelisk-kimi-manifest-post-discovery-move-');
  const indexedSessionDir = writeSession(root);
  const indexedWire = join(indexedSessionDir, 'agents', 'main', 'wire.jsonl');
  const liveSessionDir = join(root, 'sessions', 'workspace-2', 'session-1');
  fs.mkdirSync(join(root, 'sessions', 'workspace-2'), { recursive: true });
  fs.renameSync(indexedSessionDir, liveSessionDir);
  fs.mkdirSync(indexedSessionDir, { recursive: true });
  const { createKimiProvider } = await loadKimiProvider('post-discovery-move');
  const provider = createKimiProvider({ rootDir: root });
  const [replay] = provider.discover({
    lastCursor: () => null,
    indexedSessions: () => [{ sessionId: 'kimi:session-1', jsonlPath: indexedWire }],
  });

  const mainDir = join(indexedSessionDir, 'agents', 'main');
  fs.mkdirSync(mainDir, { recursive: true });
  fs.writeFileSync(join(mainDir, 'wire.jsonl'), REAL_METADATA_LINE);
  assert.throws(
    () => drain(provider.parse(replay, null)),
    /identity changed while indexing/,
  );
});

test('Kimi discovery detects an append even when mtime is restored', async () => {
  const root = makeTempDir('obelisk-kimi-manifest-same-mtime-append-');
  const sessionDir = writeSession(root);
  const wirePath = join(sessionDir, 'agents', 'main', 'wire.jsonl');
  const { createKimiProvider } = await loadKimiProvider('same-mtime-append');
  const provider = createKimiProvider({ rootDir: root });
  const initial = provider.discover({ lastCursor: () => null })[0];
  const before = fs.statSync(wirePath);

  fs.appendFileSync(wirePath, REAL_METADATA_LINE);
  fs.utimesSync(wirePath, before.atime, before.mtime);

  assert.deepEqual(provider.discover({
    lastCursor: () => initial.meta.currentCursor,
  }).map(unit => unit.key), [sessionDir]);
});

test('Kimi discovery detects a same-size rewrite with restored mtime', async () => {
  const root = makeTempDir('obelisk-kimi-manifest-same-size-rewrite-');
  const sessionDir = writeSession(root);
  const wirePath = join(sessionDir, 'agents', 'main', 'wire.jsonl');
  const { createKimiProvider } = await loadKimiProvider('same-size-rewrite');
  const provider = createKimiProvider({ rootDir: root });
  const initial = provider.discover({ lastCursor: () => null })[0];
  const before = fs.statSync(wirePath);
  const original = fs.readFileSync(wirePath, 'utf8');
  const rewritten = original.replace('"runtimeId":"local"', '"runtimeId":"focal"');
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
  fs.writeFileSync(join(childDir, 'wire.jsonl'), REAL_METADATA_LINE);
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
