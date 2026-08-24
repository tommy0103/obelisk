// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// #86 renderer-visible latency probe: boots the REAL app (out/main/index.js)
// against a synthetic HOME, appends to a live transcript every 200 ms, and
// measures append -> text visible in the real renderer DOM via CDP.
//
// Usage: node scripts/bench-renderer-latency.mjs
// Requires app/out (electron-vite build) and a free ~2 GiB of /tmp.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('../app', import.meta.url));
const electronBin = path.join(appRoot, 'node_modules', '.bin', 'electron');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'obelisk-gui-bench-')));
const home = tmp;
const projectsDir = path.join(home, '.claude', 'projects', '-bench');
fs.mkdirSync(projectsDir, { recursive: true });
fs.mkdirSync(path.join(home, '.obelisk'), { recursive: true });

const liveFile = path.join(projectsDir, 'live-session.jsonl');
const line = (i) => JSON.stringify({
  uuid: `gui-bench-${i}`,
  type: 'user',
  timestamp: new Date().toISOString(),
  message: { role: 'user', content: `gui append ${i}` },
});
fs.writeFileSync(liveFile, `${line(0)}\n`);

const CDP_PORT = 9333;
// The session shell may export ELECTRON_RUN_AS_NODE=1 (harness); the real app
// must run as Electron, not as Node — Chromium flags would be rejected.
const { ELECTRON_RUN_AS_NODE: _drop, ...inheritedEnv } = process.env;
const child = spawn(electronBin, [
  `--remote-debugging-port=${CDP_PORT}`,
  '--no-sandbox',
  path.join(appRoot, 'out', 'main', 'index.js'),
], {
  env: { ...inheritedEnv, HOME: home, USERPROFILE: home },
  stdio: ['pipe', 'pipe', 'inherit'],
});

const cleanup = () => {
  try { child.kill('SIGTERM'); } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
};
process.on('exit', cleanup);

async function cdpEvaluate(expression) {
  const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json`).then((r) => r.json());
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no CDP page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const id = Math.floor(Math.random() * 1e9);
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('cdp timeout')), 10000);
    ws.onopen = () => ws.send(JSON.stringify({
      id, method: 'Runtime.evaluate',
      params: { expression, returnByValue: true },
    }));
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== id) return;
      clearTimeout(timeout);
      ws.close();
      resolve(msg.result?.result?.value);
    };
    ws.onerror = (error) => { clearTimeout(timeout); reject(error); };
  });
  return result;
}

async function waitFor(cond, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await cond()) return;
    } catch { /* CDP not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

try {
  // Boot: window exists, session list shows the seeded session.
  await waitFor(async () => (await cdpEvaluate('document.readyState')) === 'complete', 'renderer boot', 30000);
  await waitFor(async () => (await cdpEvaluate('document.body.textContent.length')) > 0, 'renderer content', 30000);

  // Navigate to the session detail and confirm the seed line is visible.
  await cdpEvaluate(`window.location.hash = '#/sessions/live-session'`);
  await waitFor(async () => (await cdpEvaluate(
    `document.body.textContent.includes('gui append 0')`)), 'seed message visible', 30000);

  // Continuous appends; measure append -> renderer-visible for samples.
  const samples = [];
  const N = 8;
  for (let i = 1; i <= N; i++) {
    const appendStart = performance.now();
    fs.appendFileSync(liveFile, `${line(i)}\n`);
    // eslint-disable-next-line no-await-in-loop
    await waitFor(async () => (await cdpEvaluate(
      `document.body.textContent.includes(${JSON.stringify(`gui append ${i}`)})`)),
      `gui append ${i} visible`, 20000);
    samples.push(performance.now() - appendStart);
    console.log(`append ${i} -> renderer-visible: ${samples[samples.length - 1].toFixed(0)} ms`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`renderer-visible latency ms: p50=${percentile(samples, 50).toFixed(0)} p95=${percentile(samples, 95).toFixed(0)}`);
} finally {
  cleanup();
}
