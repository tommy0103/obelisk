// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// #86 merge-gate benchmark, two independent measurements:
//
//   1. Idle changed-path build cost on the REAL indexed corpus (~18.7k
//      transcripts), against a throwaway COPY of the index DB.
//   2. End-to-end scheduling latency under continuous writes on a SYNTHETIC
//      corpus (own root, own fresh DB), verifying the appended lines actually
//      land in the index — not just that builds fire.
//
// Both run the production worker (app/out/main/indexer-worker.js, built by
// electron-vite). The live database is never touched.
//
// Usage: node scripts/bench-scheduler.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const { createWorkerBuildIndex } = await import('../app/src/main/indexer-worker-client.ts');
const { createIndexerService } = await import('../app/src/main/indexer-service.ts');

const HOME = os.homedir();
const LIVE_DB = path.join(HOME, '.obelisk', 'obelisk.sqlite');
const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'obelisk-bench-')));

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

const worker = createWorkerBuildIndex({
  workerPath: new URL('../app/out/main/indexer-worker.js', import.meta.url).pathname,
});

// ---- metric 1: idle changed-path build time on the real corpus ----
const SKIP_CORPUS = process.env.BENCH_SKIP_CORPUS === '1';
if (SKIP_CORPUS) console.log('[metric 1 skipped: BENCH_SKIP_CORPUS=1]');
if (!SKIP_CORPUS) {

// The measured cost is filesystem discovery over the real transcript tree,
// not DB size — so a small clone carrying schema + index_state + sessions is
// enough (the full 1 GB messages/FTS content is irrelevant to the walk).
const corpusDb = path.join(tmp, 'corpus.sqlite');
const schema = fs.readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');
const clone = new DatabaseSync(corpusDb);
clone.exec(schema);
clone.exec(`ATTACH DATABASE '${LIVE_DB.replace(/'/g, "''")}' AS live`);
// The measured finalize cost scales with the messages tables (per-session
// cwd queries in refreshSessionProjectPaths); FTS content is not needed.
for (const table of ['index_state', 'sessions', 'messages', 'tool_calls', 'tool_results']) {
  clone.exec(`INSERT INTO ${table} SELECT * FROM live.${table}`);
}
clone.exec('DETACH DATABASE live');
clone.close();
const corpusArgs = {
  providerRoots: {},
  claudeDir: path.join(HOME, '.claude'),
  codexDir: path.join(HOME, '.codex'),
  projectsDir: CLAUDE_PROJECTS,
  dbPath: corpusDb,
};

{
  const markerCheck = new DatabaseSync(corpusDb, { readOnly: true });
  const ftsReady = markerCheck.prepare('SELECT COUNT(*) AS n FROM index_state WHERE jsonl_path = ?').get('__fts_triggers_ready__').n;
  markerCheck.close();
  const warmupStart = performance.now();
  await worker.buildIndex({ ...corpusArgs, reason: 'warmup' });
  console.log(`first build after open (cold, fts marker present: ${ftsReady > 0}): ${(performance.now() - warmupStart).toFixed(0)} ms`);
}
const project = fs.readdirSync(CLAUDE_PROJECTS)[0];
const changed = path.join(
  CLAUDE_PROJECTS,
  project,
  fs.readdirSync(path.join(CLAUDE_PROJECTS, project)).find((name) => name.endsWith('.jsonl')),
);
const idleTimes = [];
const staleness = new DatabaseSync(corpusDb);
for (let i = 0; i < 10; i++) {
  // Force the file stale by rolling back the CLONE's cursor (never touch the
  // real transcript's mtime — and never poke the running daemon's watcher).
  staleness.prepare('UPDATE index_state SET mtime = 0, cursor = NULL WHERE jsonl_path = ?').run(changed);
  const start = performance.now();
  await worker.buildIndex({ ...corpusArgs, reason: 'bench', changedPaths: [changed] });
  idleTimes.push(performance.now() - start);
}
staleness.close();
console.log('idle changed-path build (real corpus, ms):');
console.log(`  n=${idleTimes.length} p50=${percentile(idleTimes, 50).toFixed(0)} p95=${percentile(idleTimes, 95).toFixed(0)} mean=${(idleTimes.reduce((a, b) => a + b, 0) / idleTimes.length).toFixed(0)}`);
}

// ---- metric 2: end-to-end latency under continuous writes (synthetic corpus) ----

const benchClaudeDir = path.join(tmp, 'bench-claude');
const benchProjects = path.join(benchClaudeDir, 'projects');
const liveDir = path.join(benchProjects, '-bench');
fs.mkdirSync(liveDir, { recursive: true });
const liveFile = path.join(liveDir, 'live-session.jsonl');
const benchDb = path.join(tmp, 'bench.sqlite');
const benchArgs = {
  providerRoots: {},
  claudeDir: benchClaudeDir,
  codexDir: path.join(tmp, 'bench-codex'),
  projectsDir: benchProjects,
  dbPath: benchDb,
};

const claudeLine = (i) => JSON.stringify({
  uuid: `bench-${i}`,
  type: 'user',
  timestamp: new Date().toISOString(),
  message: { role: 'user', content: `append ${i}` },
});
fs.writeFileSync(liveFile, `${claudeLine(0)}\n`);

const builds = [];
const MAX_WAIT = Number(process.env.BENCH_MAX_WAIT_MS ?? 1500);
console.log(`[metric 2 variant] maxWaitMs=${MAX_WAIT}`);
const service = createIndexerService({
  watchTargets: [{ kind: 'tree', path: benchProjects }],
  hotPolling: false,
  maxWaitMs: MAX_WAIT,
  buildIndex: async (args) => {
    const start = performance.now();
    builds.push({ reason: args.reason, paths: args.changedPaths, start });
    await worker.buildIndex({ ...benchArgs, reason: args.reason, changedPaths: args.changedPaths });
    builds[builds.length - 1].end = performance.now();
  },
  writeHeartbeat: () => {},
  logger: { warn: () => {} },
});

service.start({ buildOnStart: false });
await service.runBuildNow('startup');

const DURATION_MS = 20000;
const APPEND_INTERVAL_MS = 200;
const appendTimes = [];
let appends = 1;
const appendTimer = setInterval(() => {
  fs.appendFileSync(liveFile, `${claudeLine(appends++)}\n`);
  appendTimes.push(performance.now());
}, APPEND_INTERVAL_MS);
await new Promise((resolve) => setTimeout(resolve, DURATION_MS));
clearInterval(appendTimer);
await new Promise((resolve) => setTimeout(resolve, 4000));
service.stop();
await service.idle();

// End-to-end proof: every appended line must be in the index.
const check = new DatabaseSync(benchDb, { readOnly: true });
const indexed = check.prepare(
  "SELECT COUNT(*) AS n FROM messages WHERE uuid LIKE 'bench-%'",
).get().n;
check.close();

const watchBuilds = builds.filter((b) => b.reason === 'watch' || b.reason === 'pending');
const firstWatchBuild = watchBuilds[0];
const lastBuild = watchBuilds[watchBuilds.length - 1];
const durations = watchBuilds.map((b) => (b.end ?? b.start) - b.start);
const lastAppendTs = appendTimes[appendTimes.length - 1];

console.log('continuous writes (200 ms append interval, 20 s window, synthetic corpus):');
console.log(`  lines=${appends} indexed=${indexed} (${indexed === appends ? 'ALL — end-to-end confirmed' : 'MISSING LINES!'})`);
console.log(`  builds=${watchBuilds.length} (${(watchBuilds.length / (DURATION_MS / 1000)).toFixed(2)}/s), duration p50=${percentile(durations, 50).toFixed(0)} ms`);
if (firstWatchBuild) {
  console.log(`  first-append -> first build indexing it: ${(firstWatchBuild.end - appendTimes[0]).toFixed(0)} ms (append->indexed; renderer-visible latency needs a GUI probe)`);
console.log('  trigger attribution: run again with BENCH_MAX_WAIT_MS=0 — identical first-build timing means the trailing path fired, an earlier build means the ceiling fired.');
}
if (lastBuild) {
  console.log(`  last-append -> last build completing it: ${(lastBuild.end - lastAppendTs).toFixed(0)} ms (bounded; legacy trailing debounce would still be pending)`);
}

worker.stop();
fs.rmSync(tmp, { recursive: true, force: true });
