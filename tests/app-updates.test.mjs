// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createUpdateService, isNewerStable } from '../app/src/main/update-service.ts';
import { createUpdateLifecycle } from '../app/src/main/update-lifecycle.ts';

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function harness(options = {}) {
  let receive;
  let checks = 0, installs = 0, selections = 0;
  const snapshots = [];
  const service = createUpdateService({ enabled: true, version: '0.2.3',
    prepare: async () => {}, recover: async () => {}, publish: state => snapshots.push(state),
    createBackend: async handler => {
      receive = handler; selections++;
      return { kind: 'sparkle', check: () => { checks++; }, install: () => { installs++; }, stop() {} };
    }, ...options });
  return { service, send: event => receive(event), counts: () => ({ checks, installs, selections }), snapshots };
}
test('only a newer stable version is offered, including across digit boundaries', () => {
  for (const version of ['0.2.2', '0.2.3', '0.2.4-rc.1', 'v0.2.4', '00.2.4', '9007199254740992.0.0']) assert.equal(isNewerStable(version, '0.2.3'), false, version);
  assert.equal(isNewerStable('0.10.0', '0.9.9'), true);
  assert.equal(isNewerStable('1.0.0', '0.9.9'), true);
});
test('development builds never load, check, download or install an updater', async () => {
  const h = harness({ enabled: false });
  await h.service.check();
  await assert.rejects(h.service.install(), /No downloaded update/);
  assert.equal(h.service.getState().phase, 'disabled');
  assert.deepEqual(h.counts(), { checks: 0, installs: 0, selections: 0 });
});
test('repeated checks are single-flight and signature errors never select a second backend', async t => {
  const h = harness(); t.after(h.service.stop);
  await Promise.all([h.service.check(), h.service.check()]);
  assert.equal(h.counts().checks, 1);
  h.send({ type: 'available', version: '0.2.4', releaseNotes: 'Changes' });
  h.send({ type: 'progress', percent: 150 });
  assert.equal(h.service.getState().progress, 100);
  h.send({ type: 'error', message: 'Signature rejected' });
  assert.equal(h.service.getState().error, 'Signature rejected');
  await assert.rejects(h.service.install(), /No downloaded/);
  await h.service.check();
  assert.equal(h.counts().selections, 1);
});
test('a downloaded update survives later check events and network failures', async t => {
  const h = harness(); t.after(h.service.stop); await h.service.check();
  h.send({ type: 'downloaded', version: '0.2.4', releaseNotes: 'Changes' });
  h.send({ type: 'current' }); h.send({ type: 'checking' }); h.send({ type: 'error', message: 'Offline' });
  assert.equal(h.service.getState().phase, 'ready');
  assert.equal(h.service.getState().version, '0.2.4');
  assert.equal(h.service.getState().releaseNotes, 'Changes');
});
test('manual installation waits for cleanup and rapid clicks install only once', async t => {
  const cleanup = deferred();
  const h = harness({ prepare: () => cleanup.promise }); t.after(h.service.stop);
  await h.service.check(); h.send({ type: 'downloaded', version: '0.2.4' });
  const first = h.service.install(), second = h.service.install();
  assert.equal(first, second);
  assert.equal(h.service.getState().phase, 'preparing');
  assert.equal(h.counts().installs, 0);
  cleanup.resolve(); await first;
  assert.equal(h.counts().installs, 1);
});
test('cleanup failure keeps the app running and the downloaded update retryable', async t => {
  let attempts = 0;
  const h = harness({ prepare: async () => { if (++attempts === 1) throw new Error('Watcher close failed'); } });
  t.after(h.service.stop); await h.service.check(); h.send({ type: 'downloaded', version: '0.2.4' });
  await h.service.install();
  assert.equal(h.service.getState().phase, 'ready');
  assert.equal(h.service.getState().error, 'Watcher close failed');
  assert.equal(h.counts().installs, 0);
  await h.service.install(); assert.equal(h.counts().installs, 1);
});
test('timed-out cleanup never installs later and resumes only after resources finish closing', async () => {
  const closed = deferred(); let resumed = 0;
  const gate = createUpdateLifecycle({ stop: () => closed.promise, resume: () => { resumed++; }, timeoutMs: 15 });
  await assert.rejects(gate.prepare(), /took too long/);
  assert.equal(gate.isBlocked(), true);
  assert.throws(gate.assertWritable, /preparing an update/);
  closed.resolve(); await gate.recover();
  assert.equal(resumed, 1); assert.equal(gate.isPrepared(), false); assert.equal(gate.isBlocked(), false);
});
test('an active manual rebuild completes before update teardown and new writes are blocked', async () => {
  const rebuild = deferred(); const order = [];
  const gate = createUpdateLifecycle({ stop: async () => { order.push('stop'); }, resume() {} });
  const writing = gate.mutate(async () => { await rebuild.promise; order.push('write completed'); });
  const preparing = gate.prepare();
  await delay(5); assert.deepEqual(order, []);
  assert.throws(() => gate.mutate(async () => {}), /preparing an update/);
  rebuild.resolve(); await writing; await preparing;
  assert.deepEqual(order, ['write completed', 'stop']);
  assert.equal(gate.isPrepared(), true);
});
test('checking and stalled downloads have deadlines and fallback checks repeat', async t => {
  let receive, checks = 0;
  const h = harness({ checkTimeoutMs: 10, downloadTimeoutMs: 10, pollMs: 25,
    createBackend: async handler => { receive = handler; return { kind: 'electron-updater', check() { checks++; }, install() {}, stop() {} }; } });
  t.after(h.service.stop); await h.service.check(); await delay(18);
  assert.match(h.service.getState().error, /timed out/);
  await delay(15); assert.ok(checks >= 2, 'periodic fallback check actually ran');
  receive({ type: 'available', version: '0.2.4' }); await delay(18);
  assert.ok(h.snapshots.some(state => state.error?.includes('stalled')), 'stalled download error was published');
});
test('asynchronous installer errors reopen resources and preserve the staged update', async t => {
  let resumed = 0;
  const h = harness({ recover: async () => { resumed++; } }); t.after(h.service.stop);
  await h.service.check(); h.send({ type: 'downloaded', version: '0.2.4' }); await h.service.install();
  h.send({ type: 'error', message: 'Installer failed' }); await delay(0);
  assert.equal(h.service.getState().phase, 'ready'); assert.equal(resumed, 1);
});
