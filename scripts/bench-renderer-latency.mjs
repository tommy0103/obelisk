// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// #86 renderer-visible latency probe: boots the REAL app (out/main/index.js)
// against a synthetic HOME and measures append -> text-visible in the real
// renderer DOM over CDP, under two workloads:
//
//   A. Isolated bursts (quiet-tail): one append at a time, waiting for each
//      to become visible before the next — measures the trailing path.
//   B. Continuous writes: a strict 200 ms append schedule independent of
//      visibility, with visibility sampled asynchronously — measures the
//      max-wait ceiling path (the trailing timer never settles).
//
// Usage: node scripts/bench-renderer-latency.mjs
// Requires app/out (electron-vite build).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

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

// Random CDP port in a private range; verified against the app's own window
// below (a fixed port could collide with another debugger on this machine).
const CDP_PORT = 9200 + Math.floor(Math.random() * 600);

// The session shell may export ELECTRON_RUN_AS_NODE (harness: makes Electron
// run as Node and reject Chromium flags) and ELECTRON_RENDERER_URL /
// OBELISK_DEV_SERVER_URL (would load a dev server instead of the built
// renderer). All three must be stripped for a faithful production boot.
const {
  ELECTRON_RUN_AS_NODE: _drop1,
  ELECTRON_RENDERER_URL: _drop2,
  OBELISK_DEV_SERVER_URL: _drop3,
  ...inheritedEnv
} = process.env;

const child = spawn(electronBin, [
  `--remote-debugging-port=${CDP_PORT}`,
  '--no-sandbox',
  path.join(appRoot, 'out', 'main', 'index.js'),
], {
  env: { ...inheritedEnv, HOME: home, USERPROFILE: home },
  stdio: ['pipe', 'pipe', 'inherit'],
});

let ws;
let writer;
let cursorProbe;
const cleanup = () => {
  if (writer) clearInterval(writer);
  if (cursorProbe) clearInterval(cursorProbe);
  try { ws?.close(); } catch {}
  try { child.kill('SIGTERM'); } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
};
process.on('exit', cleanup);

let cdpId = 0;
const cdpPending = new Map();

async function cdpConnect() {
  const targets = await fetch(
    `http://127.0.0.1:${CDP_PORT}/json`,
    { signal: AbortSignal.timeout(5000) },
  ).then((r) => r.json());
  // Verify the target is THIS app's window (built renderer), not some other
  // debugger page that happens to share the port.
  const page = targets.find((t) => t.type === 'page'
    && typeof t.url === 'string'
    && (t.url.includes('out/renderer/index.html') || t.url === 'about:blank'));
  if (!page) throw new Error(`no matching CDP page target (got ${targets.map((t) => t.url).join(', ')})`);
  ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const pending = cdpPending.get(msg.id);
    if (!pending) return;
    cdpPending.delete(msg.id);
    // Stored as an object and invoked through a typed method so dynamic-call
    // analyzers (CodeQL) see a constrained call, not a map value invoked blindly.
    if (typeof pending.resolve === 'function') pending.resolve(msg.result?.result?.value);
  };
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('cdp websocket open timeout')), 5000);
    ws.onopen = () => { clearTimeout(timeout); resolve(); };
    ws.onerror = (error) => { clearTimeout(timeout); reject(error); };
  });
}

function cdpEvaluate(expression) {
  cdpId += 1;
  const id = cdpId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cdpPending.delete(id);
      reject(new Error('cdp evaluate timeout'));
    }, 10000);
    cdpPending.set(id, {
      resolve: (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
    });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  });
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

const visibleNow = (text) => cdpEvaluate(`document.body.textContent.includes(${JSON.stringify(text)})`);

try {
  await waitFor(async () => {
    await cdpConnect();
    return (await cdpEvaluate('document.readyState')) === 'complete';
  }, 'renderer boot', 30000);
  await cdpEvaluate(`window.location.hash = '#/sessions/live-session'`);
  await waitFor(async () => visibleNow('gui append 0'), 'seed message visible', 30000);

  // ---- Workload A: isolated bursts (quiet-tail) ----
  const isolated = [];
  for (let i = 1; i <= 5; i++) {
    const text = `gui append ${i}`;
    const start = performance.now();
    fs.appendFileSync(liveFile, `${line(i)}\n`);
    // eslint-disable-next-line no-await-in-loop
    await waitFor(async () => visibleNow(text), `${text} visible`, 20000);
    isolated.push(performance.now() - start);
    console.log(`A append ${i} -> visible: ${isolated[isolated.length - 1].toFixed(0)} ms`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`A isolated-burst latency ms: p50=${percentile(isolated, 50).toFixed(0)} p95=${percentile(isolated, 95).toFixed(0)}`);

  // ---- Workload B: continuous writes on a strict 200 ms schedule ----
  // The trailing timer never settles, so builds must come from the ceiling.
  // The writer runs exactly 10 s, then a drain window polls until EVERY line
  // is both indexed and renderer-visible — the cohort must be complete, and
  // missing lines fail the probe rather than being disguised as samples.
  const appended = [];
  const cursorLog = [];
  const indexedAt = new Map();
  const visibleAt = new Map();
  const t0 = performance.now();
  const cursorDb = new DatabaseSync(path.join(home, '.obelisk', 'obelisk.sqlite'), { readOnly: true });
  cursorProbe = setInterval(() => {
    try {
      const row = cursorDb
        .prepare('SELECT mtime, lines_processed FROM index_state WHERE jsonl_path = ?').get(liveFile);
      if (row && (cursorLog.length === 0 || cursorLog[cursorLog.length - 1].lines !== row.lines_processed)) {
        const now = performance.now();
        cursorLog.push({ t: now, lines: row.lines_processed });
        console.log(`  [build] lines_processed -> ${row.lines_processed} at t≈${(now - t0).toFixed(0)} ms`);
      }
    } catch { /* db not created yet */ }
  }, 400);
  writer = setInterval(() => {
    const i = appended.length === 0 ? 100 : appended[appended.length - 1].i + 1;
    fs.appendFileSync(liveFile, `${line(i)}\n`);
    appended.push({ i, text: `gui append ${i}`, at: performance.now() });
  }, 200);

  // Poll db + DOM concurrently with the writer, from t0 — first-seen times
  // are the real latency; a poll that starts after the window would invent
  // latency for everything indexed before it began.
  const WRITE_MS = 10000;
  const DRAIN_MS = 15000;
  const drainDeadline = t0 + WRITE_MS + DRAIN_MS;
  setTimeout(() => clearInterval(writer), WRITE_MS);
  while (performance.now() < drainDeadline
    && (appended.length === 0
      || performance.now() < t0 + WRITE_MS
      || visibleAt.size < appended.length
      || indexedAt.size < appended.length)) {
    const missing = appended.filter((a) => !visibleAt.has(a.i) || !indexedAt.has(a.i));
    for (const a of missing) {
      if (!indexedAt.has(a.i)
        && cursorDb.prepare('SELECT 1 FROM messages WHERE uuid = ?').get(`gui-bench-${a.i}`)) {
        indexedAt.set(a.i, performance.now());
      }
    }
    // eslint-disable-next-line no-await-in-loop
    const hits = await Promise.all(missing.map(async (a) => ((await visibleNow(a.text)) ? a.i : null)));
    for (const hit of hits) if (hit !== null) visibleAt.set(hit, performance.now());
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 100));
  }
  clearInterval(cursorProbe);

  const toStats = (map) => {
    const seen = appended.filter((a) => map.has(a.i)).map((a) => map.get(a.i) - a.at);
    return `p50=${percentile(seen, 50).toFixed(0)} p95=${percentile(seen, 95).toFixed(0)} max=${seen.length ? Math.max(...seen).toFixed(0) : 'n/a'} (${map.size}/${appended.length})`;
  };
  console.log(`B append -> indexed: ${toStats(indexedAt)}`);
  console.log(`B append -> renderer-visible: ${toStats(visibleAt)}`);
  const missingIndexed = appended.filter((a) => !indexedAt.has(a.i)).map((a) => a.i);
  const missingVisible = appended.filter((a) => !visibleAt.has(a.i)).map((a) => a.i);
  if (missingIndexed.length || missingVisible.length) {
    console.error(`FAIL: incomplete cohort after writer stop + drain — missing indexed: [${missingIndexed}], missing visible: [${missingVisible}]`);
    process.exitCode = 1;
  } else {
    console.log('B cohort complete: every appended line indexed and renderer-visible after writer stop');
  }
  cursorDb.close();
} finally {
  cleanup();
}
