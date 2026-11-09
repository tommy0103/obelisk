// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Run after apt installs the release package, under Xvfb. Exercise the installed
// executable and sandboxed preload/renderer, rather than the unpacked build.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const executable = '/opt/Obelisk/obelisk';
const runtime = spawnSync(executable, ['-e', `
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const resources = '/opt/Obelisk/resources';
  const asar = path.join(resources, 'app.asar');
  const pkg = JSON.parse(fs.readFileSync(path.join(asar, 'package.json')));
  const lock = JSON.parse(fs.readFileSync('app/package-lock.json'));
  assert.equal(pkg.version, process.env.APP_VERSION);
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'x64');
  assert.equal(process.versions.electron, lock.packages['node_modules/electron'].version);
  for (const asset of ['out/main/index.js', 'out/main/indexer-worker.js',
    'out/preload/index.js', 'out/renderer/index.html']) {
    assert.ok(fs.existsSync(path.join(asar, asset)), 'Missing packaged asset: ' + asset);
  }
  const schema = fs.readFileSync('packages/core/src/schema.sql', 'utf8');
  assert.equal(fs.readFileSync(path.join(asar, 'out/main/schema.sql'), 'utf8'), schema);
  assert.equal(fs.readFileSync(path.join(resources, 'scripts/schema.sql'), 'utf8'), schema);
  const Database = require(path.join(asar, 'node_modules/better-sqlite3'));
  const db = new Database(':memory:');
  db.exec(schema);
  db.close();
  const watcher = require(path.join(asar, 'node_modules/@parcel/watcher'));
  (async () => {
    const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'obelisk-watch-'));
    let subscription;
    try {
      await new Promise(async (resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('Packaged watcher missed a real file write')), 5000);
        try {
          subscription = await watcher.subscribe(root, (error, events) => {
            if (error) { clearTimeout(deadline); reject(error); }
            if (events.some(event => event.path === path.join(root, 'probe'))) {
              clearTimeout(deadline); resolve();
            }
          });
          fs.writeFileSync(path.join(root, 'probe'), 'installed runtime');
        } catch (error) { clearTimeout(deadline); reject(error); }
      });
    } finally {
      await subscription?.unsubscribe();
      fs.rmSync(root, { recursive: true, force: true });
    }
    console.log(JSON.stringify({ version: pkg.version, electron: process.versions.electron,
      node: process.versions.node, abi: process.versions.modules, arch: process.arch }));
  })().catch(error => { console.error(error); process.exitCode = 1; });
`], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 15_000 });
assert.equal(runtime.status, 0, runtime.error?.message || runtime.stderr);
console.log(runtime.stdout.trim());

const home = await mkdtemp(path.join(tmpdir(), 'obelisk-deb-home-'));
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const environment = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local/share') };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, ['--no-sandbox', '--devtools', `--remote-debugging-port=${port}`], {
  env: environment, stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', data => { output = (output + data).slice(-16_000); });
child.stderr.on('data', data => { output = (output + data).slice(-16_000); });
let spawnError;
child.on('error', error => { spawnError = error; });
let socket;
let nextId = 0;
function command(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); socket.removeEventListener('message', receive); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`CDP ${method} timed out`)); }, 10_000);
    const receive = event => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      cleanup();
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    };
    socket.addEventListener('message', receive);
    socket.send(JSON.stringify({ id, method, params }));
  });
}
try {
  const deadline = Date.now() + 30_000;
  let target;
  while (Date.now() < deadline && !target) {
    if (spawnError) throw spawnError;
    assert.equal(child.exitCode, null, output);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1000) });
      target = (await response.json()).find(item => item.type === 'page' && item.url.includes('/out/renderer/index.html'));
    } catch {}
    if (!target) await delay(100);
  }
  assert.ok(target, `Installed renderer did not start: ${output}`);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP connection timed out')), 5000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')); }, { once: true });
  });
  const result = await command('Runtime.evaluate', {
    expression: `(async () => {
      const deadline = Date.now() + 10000;
      while (!window.obelisk?.getSettings || !document.querySelector('.titlebar-controls') || !(await window.obelisk.getUpdateState()).backend) {
        if (Date.now() > deadline) throw new Error('Installed UI/preload did not initialize');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const settings = await window.obelisk.getSettings();
      const sessions = await window.obelisk.getSessions();
      const update = await window.obelisk.getUpdateState();
      return { platform: window.obelisk.platform, version: settings.version,
        sessions: Array.isArray(sessions), updateBackend: update.backend,
        nodeHidden: typeof window.require === 'undefined' && typeof window.process === 'undefined',
        controls: [...document.querySelectorAll('.titlebar-controls button')].map(button => button.getAttribute('aria-label')) };
    })()`,
    awaitPromise: true, returnByValue: true,
  });
  assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
  const state = result.result.value;
  assert.equal(state.platform, 'linux');
  assert.equal(state.version, process.env.APP_VERSION);
  assert.equal(state.sessions, true);
  assert.equal(state.nodeHidden, true);
  assert.equal(state.updateBackend, 'electron-updater');
  assert.deepEqual(state.controls, ['Minimize', 'Maximize or restore', 'Close']);
  await command('Runtime.evaluate', { expression: "setTimeout(() => document.querySelector('[aria-label=Close]').click(), 100); true" });
  const quitDeadline = Date.now() + 10_000;
  while (child.exitCode === null && Date.now() < quitDeadline) await delay(50);
  assert.equal(child.exitCode, 0, `Installed app did not quit cleanly: ${output}`);
  console.log('PASS: apt-installed app, native database/watcher, isolated preload, Linux controls and clean quit');
} finally {
  socket?.close();
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
  }
  await rm(home, { recursive: true, force: true });
}
