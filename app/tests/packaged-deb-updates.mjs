// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Disposable copies of the actual .deb preserve the shipped main, preload,
// renderer, native modules and updater. Only version/bootstrap/feed identity
// changes; the real DebUpdater installs via dpkg and relaunches the app.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.platform, 'linux');
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'app/package.json'));
const asar = require('@electron/asar');
const original = path.resolve(process.argv[2]);
const targetVersion = process.env.APP_VERSION;
// The first disposable fixture can discover the exact shipped release version,
// including when a future release starts a new minor or major series.
const parts = targetVersion.split('.').map(Number);
assert.match(targetVersion, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
assert.ok(parts.every(Number.isSafeInteger) && parts.some(part => part > 0));
const previousVersion = parts[2] > 0 ? `${parts[0]}.${parts[1]}.${parts[2] - 1}`
  : parts[1] > 0 ? `${parts[0]}.${parts[1] - 1}.0` : `${parts[0] - 1}.0.0`;
const olderVersion = '0.0.0';
const work = await mkdtemp(path.join(tmpdir(), 'obelisk-deb-acceptance-'));
const evidence = path.join(work, 'evidence');
const home = path.join(work, 'home');
const launches = path.join(evidence, 'launches.jsonl');
await mkdir(evidence); await mkdir(home);
const requested = [];
const feed = new Map();
const server = createServer((req, res) => {
  const name = req.url.split('?')[0]; requested.push(name);
  const entry = feed.get(name);
  if (!entry) { res.writeHead(404); res.end(); return; }
  const bytes = typeof entry === 'function' ? Buffer.from(entry()) : entry;
  res.writeHead(200, { 'Content-Length': bytes.length }); res.end(bytes);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const feedBase = `http://127.0.0.1:${server.address().port}`;
const debugServer = createServer();
await new Promise(resolve => debugServer.listen(0, '127.0.0.1', resolve));
const port = debugServer.address().port;
await new Promise(resolve => debugServer.close(resolve));
function run(executable, args, options = {}) {
  return execFileSync(executable, args, { encoding: 'utf8', timeout: 120_000, ...options });
}
async function fixture(version) {
  const extracted = path.join(work, `package-${version}`);
  run('dpkg-deb', ['-R', original, extracted]);
  const appRoot = path.join(extracted, 'opt/Obelisk/resources');
  const appAsar = path.join(appRoot, 'app.asar');
  const contents = path.join(work, `asar-${version}`);
  asar.uncache(appAsar); asar.extractAll(appAsar, contents);
  const pkgFile = path.join(contents, 'package.json');
  const pkg = JSON.parse(await readFile(pkgFile, 'utf8')); pkg.version = version;
  await writeFile(pkgFile, JSON.stringify(pkg));
  await rename(path.join(contents, 'out/main/index.js'), path.join(contents, 'out/main/app-main.js'));
  await writeFile(path.join(contents, 'out/main/index.js'), `import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { app } from 'electron';
import fs from 'node:fs/promises';
os.homedir = () => ${JSON.stringify(home)}; syncBuiltinESMExports();
app.setPath('userData', ${JSON.stringify(path.join(home, 'user-data'))});
try { await import('./app-main.js'); } catch (error) {
  await fs.writeFile(${JSON.stringify(path.join(evidence, 'startup-error.txt'))}, error.stack || String(error));
  app.exit(1);
}
app.whenReady().then(() => fs.appendFile(${JSON.stringify(launches)}, JSON.stringify({
  version: app.getVersion(), arch: process.arch, pid: process.pid })+'\\n'));
`);
  await asar.createPackageWithOptions(contents, appAsar, { unpack: '**/*.node' });
  await writeFile(path.join(appRoot, 'app-update.yml'), JSON.stringify({ provider: 'generic', url: feedBase+'/', updaterCacheDirName: 'obelisk-deb-acceptance' }));
  const control = path.join(extracted, 'DEBIAN/control');
  await writeFile(control, (await readFile(control, 'utf8')).replace(/^Version: .*$/m, `Version: ${version}`));
  const deb = path.join(work, `Obelisk-${version}-linux-amd64.deb`);
  // Fast compression keeps disposable fixture creation bounded on small CI
  // runners. The original release's xz package is installed unchanged first.
  run('dpkg-deb', ['--build', '--root-owner-group', '-Zgzip', '-z1', extracted, deb]);
  await rm(extracted, { recursive: true, force: true });
  await rm(contents, { recursive: true, force: true });
  return deb;
}
let child, socket;
const pending = new Map(); let nextId = 0;
async function evaluate(expression) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP evaluation timed out')); }, 10_000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
}
async function until(task, label, ms = 30_000) {
  const deadline = Date.now() + ms; let last;
  while (Date.now() < deadline) {
    try { last = await task(); if (last) return last; } catch (error) { last = error.message; }
    await delay(100);
  }
  throw new Error(`Timed out: ${label}; last=${JSON.stringify(last)}`);
}
async function connect() {
  const page = await until(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1000) });
    return (await response.json()).find(tab => tab.type === 'page' && tab.url.includes('/out/renderer/index.html'));
  }, 'installed renderer started');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP connection timed out')), 5000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')); }, { once: true });
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data), task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    if (message.error || message.result?.exceptionDetails) task.reject(new Error(JSON.stringify(message.error || message.result.exceptionDetails)));
    else task.resolve(message.result.result.value);
  });
}
let releaseVersion = olderVersion, badHash = false;
try {
  const oldDeb = await fixture(previousVersion);
  const newDeb = await fixture(targetVersion);
  const bytes = await readFile(newDeb);
  const name = path.basename(newDeb);
  const hash = createHash('sha512').update(bytes).digest('base64');
  feed.set('/'+name, bytes);
  feed.set('/latest-linux.yml', () => JSON.stringify({ version: releaseVersion,
    files: [{ url: name, size: bytes.length, sha512: badHash ? Buffer.alloc(64).toString('base64') : hash }],
    path: name, sha512: badHash ? Buffer.alloc(64).toString('base64') : hash,
    releaseDate: new Date().toISOString(), releaseNotes: 'Debian acceptance changes' }));
  run('sudo', ['apt-get', 'install', '-y', '--allow-downgrades', '--no-install-recommends', oldDeb]);
  await mkdir(path.join(home, '.obelisk/recap'), { recursive: true });
  await writeFile(path.join(home, '.obelisk/recap/preserved.txt'), 'keep this recap');
  run('/opt/Obelisk/obelisk', ['-e', `const fs=require('node:fs'), p=require('node:path');
const root='/opt/Obelisk/resources/app.asar'; const DB=require(p.join(root,'node_modules/better-sqlite3'));
const db=new DB(p.join(process.env.HOME,'.obelisk/obelisk.sqlite'));
db.exec(fs.readFileSync(p.join(root,'out/main/schema.sql'),'utf8'));
db.prepare('INSERT INTO memories(id,path,summary,created_at) VALUES (?,?,?,?)').run('deb-preserved-memory','fixture.md','Preserve this memory','2026-10-01T00:00:00Z'); db.close();`],
  { env: { ...process.env, HOME: home, ELECTRON_RUN_AS_NODE: '1' } });
  // Simulate only the authorization dialog boundary. The successful attempt
  // executes the updater's actual dpkg/apt command through CI's real sudo.
  const bin = path.join(work, 'bin'); await mkdir(bin);
  const denied = path.join(work, 'deny-authorization'); await writeFile(denied, 'deny');
  await writeFile(path.join(bin, 'pkexec'), `#!/bin/sh
printf '%s\\n' "$*" >> '${evidence}/authorization.log'
if [ -f '${denied}' ]; then exit 126; fi
if [ "$1" = --disable-internal-agent ]; then shift; fi
exec /usr/bin/sudo -- "$@"
`, { mode: 0o755 });
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'), PATH: bin+':'+process.env.PATH };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn('/opt/Obelisk/obelisk', ['--no-sandbox', '--devtools', `--remote-debugging-port=${port}`], { env, stdio: ['ignore','pipe','pipe'] });
  let log = '';
  const record = data => { log += data; void writeFile(path.join(evidence, 'process.log'), log); };
  child.stdout.on('data', record); child.stderr.on('data', record);
  child.on('error', error => record(error.stack));
  await connect();
  const state = () => evaluate('window.obelisk.getUpdateState()');
  const current = await until(async () => { const s = await state(); return s.phase === 'current' ? s : false; }, 'older release ignored');
  assert.equal(current.backend, 'electron-updater');
  assert.ok(!requested.some(url => url.endsWith('.deb')));
  console.log('PASS: Debian updater ignores older versions without downloading');
  releaseVersion = targetVersion; badHash = true;
  await evaluate('window.obelisk.checkForUpdates()');
  const rejected = await until(async () => { const s = await state(); return s.phase === 'error' ? s : false; }, 'corrupt download rejected', 120_000);
  assert.match(rejected.error, /sha512|checksum|mismatch/i);
  assert.equal(rejected.backend, 'electron-updater');
  badHash = false; await evaluate('window.obelisk.checkForUpdates()');
  const ready = await until(async () => { const s = await state(); return s.phase === 'ready' ? s : false; }, 'Debian update staged', 120_000);
  assert.equal(ready.version, targetVersion);
  assert.equal(ready.releaseNotes, 'Debian acceptance changes');
  console.log('PASS: Debian SHA512 mismatch is rejected and a verified retry stages the update');
  await until(() => evaluate("!!document.querySelector('.update-notice .primary:not(:disabled)')"), 'ready action visible');
  await evaluate("document.querySelector('.update-notice .primary').click(); true");
  const cancelled = await until(async () => { const s = await state(); return s.phase === 'ready' && s.error ? s : false; }, 'authorization denial retains the staged update');
  assert.equal(cancelled.version, targetVersion);
  assert.equal(child.exitCode, null);
  assert.ok((await evaluate('window.obelisk.getMemories()')).some(m => m.id === 'deb-preserved-memory'));
  assert.equal(run('dpkg-query', ['-W', '-f=${Version}', 'obelisk']), previousVersion);
  console.log('PASS: authorization cancellation keeps the app open, preserves data and permits retry');
  await rm(denied);
  await evaluate("document.querySelector('.update-notice .primary').click(); true");
  const relaunched = await until(async () => {
    const records = (await readFile(launches, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    return records.find(record => record.version === targetVersion);
  }, 'replacement app relaunched', 120_000);
  assert.equal(relaunched.arch, 'x64');
  assert.equal(run('dpkg-query', ['-W', '-f=${Version}', 'obelisk']), targetVersion);
  socket.close(); await connect();
  const updated = await state();
  assert.equal(updated.currentVersion, targetVersion);
  assert.ok((await evaluate('window.obelisk.getMemories()')).some(m => m.id === 'deb-preserved-memory'));
  assert.equal(await readFile(path.join(home, '.obelisk/recap/preserved.txt'), 'utf8'), 'keep this recap');
  console.log('PASS: real DebUpdater replaces the installed Debian package, relaunches and preserves memory/recap data');
  await evaluate("setTimeout(() => document.querySelector('[aria-label=Close]').click(), 100); true");
  await until(() => { try { process.kill(relaunched.pid, 0); return false; } catch { return true; } }, 'replacement app quit cleanly');
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ pass: true, previousVersion, targetVersion, requested }, null, 2));
} finally {
  socket?.close();
  await new Promise(resolve => server.close(resolve));
  try {
    const records = (await readFile(launches, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    for (const record of records) { try { process.kill(record.pid, 'SIGKILL'); } catch {} }
  } catch {}
  child?.kill('SIGKILL');
  // Keep only bounded evidence for Actions; never persist disposable user data.
  for (const name of ['home','bin']) await rm(path.join(work, name), { recursive: true, force: true });
  console.log('Debian acceptance evidence:', evidence);
}
