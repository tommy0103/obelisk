// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// #86 merge-gate benchmark: measures the app daemon's real build latency on
// the real indexed corpus, and the bounded scheduler's behavior under
// continuous transcript writes. Runs the production worker
// (app/out/main/indexer-worker.js, built by electron-vite) against a throwaway
// COPY of the index database — the live database is never touched.
//
// Usage: node tmp/bench-scheduler.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createWorkerBuildIndex } = await import('../app/src/main/indexer-worker-client.ts');
const { createIndexerService } = await import('../app/src/main/indexer-service.ts');

const HOME = os.homedir();
const LIVE_DB = path.join(HOME, '.obelisk', 'obelisk.sqlite');
const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obelisk-bench-'));
const dbPath = path.join(tmp, 'bench.sqlite');
fs.copyFileSync(LIVE_DB, dbPath);

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

// ---- metric 1: idle changed-path build time on the real corpus ----

const worker = createWorkerBuildIndex({
  workerPath: new URL('../app/out/main/indexer-worker.js', import.meta.url).pathname,
});
const benchClaudeDir = path.join(HOME, '.claude');

// Pick a real transcript to feed as a changed path.
function pickTranscript() {
  const project = fs.readdirSync(CLAUDE_PROJECTS)[0];
  const file = fs.readdirSync(path.join(CLAUDE_PROJECTS, project))
    .find((name) => name.endsWith('.jsonl'));
  return path.join(CLAUDE_PROJECTS, project, file);
}

const idleArgs = {
  providerRoots: {},
  claudeDir: benchClaudeDir,
  codexDir: path.join(HOME, '.codex'),
  projectsDir: CLAUDE_PROJECTS,
  dbPath,
};

// Warm-up (opens db, migrates, loads plan caches).
await worker.buildIndex({ ...idleArgs, reason: 'warmup' });
const changed = pickTranscript();
const idleTimes = [];
for (let i = 0; i < 10; i++) {
  const start = performance.now();
  await worker.buildIndex({ ...idleArgs, reason: 'bench', changedPaths: [changed] });
  idleTimes.push(performance.now() - start);
}
console.log('idle changed-path build (real corpus, ms):');
console.log(`  n=${idleTimes.length} p50=${percentile(idleTimes, 50).toFixed(0)} p95=${percentile(idleTimes, 95).toFixed(0)} mean=${(idleTimes.reduce((a, b) => a + b, 0) / idleTimes.length).toFixed(0)}`);

// ---- metric 2+3: bounded scheduler under continuous writes ----

const liveRoot = path.join(tmp, 'projects', '-bench');
fs.mkdirSync(liveRoot, { recursive: true });
const liveFile = path.join(liveRoot, 'live-session.jsonl');
const claudeLine = (i) => JSON.stringify({
  uuid: `bench-${i}`,
  type: 'user',
  timestamp: new Date().toISOString(),
  message: { role: 'user', content: `append ${i}` },
});
fs.writeFileSync(liveFile, `${claudeLine(0)}\n`);

const builds = [];
const service = createIndexerService({
  watchTargets: [{ kind: 'tree', path: path.join(tmp, 'projects') }],
  hotPolling: false,
  buildIndex: async (args) => {
    const start = performance.now();
    builds.push({ reason: args.reason, paths: args.changedPaths?.length, start });
    await worker.buildIndex({ ...idleArgs, reason: args.reason, changedPaths: args.changedPaths });
    builds[builds.length - 1].end = performance.now();
  },
  writeHeartbeat: () => {},
  logger: { warn: () => {} },
});

service.start({ buildOnStart: false });
await service.runBuildNow('startup');

const DURATION_MS = 20000;
const APPEND_INTERVAL_MS = 200;
let appends = 1;
const appendTimer = setInterval(() => {
  fs.appendFileSync(liveFile, `${claudeLine(appends++)}\n`);
}, APPEND_INTERVAL_MS);
await new Promise((resolve) => setTimeout(resolve, DURATION_MS));
clearInterval(appendTimer);
await new Promise((resolve) => setTimeout(resolve, 3000));
service.stop();
await service.idle();

const watchBuilds = builds.filter((b) => b.reason === 'watch' || b.reason === 'pending');
const firstWatchTs = watchBuilds[0]?.start;
const rate = watchBuilds.length / (DURATION_MS / 1000);
const gaps = watchBuilds.slice(1).map((b, i) => b.start - watchBuilds[i].start);
const durations = watchBuilds.map((b) => (b.end ?? b.start) - b.start);
console.log('continuous writes (200 ms append interval, 20 s window):');
console.log(`  appends=${appends - 1} builds=${watchBuilds.length} (${rate.toFixed(2)}/s)`);
console.log(`  build duration ms: p50=${percentile(durations, 50).toFixed(0)} p95=${percentile(durations, 95).toFixed(0)}`);
console.log(`  inter-build gap ms: p50=${percentile(gaps, 50).toFixed(0)} p95=${percentile(gaps, 95).toFixed(0)} max=${Math.max(...gaps).toFixed(0)}`);
console.log(`  first-change-to-first-build ms: ${firstWatchTs === undefined ? 'n/a' : (firstWatchTs - builds[0].end).toFixed(0)}`);

worker.stop();
fs.rmSync(tmp, { recursive: true, force: true });
