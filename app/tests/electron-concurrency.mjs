// Real Electron/better-sqlite3 concurrency test (docs/adr/0006 Phase 2).
// Run: cd app && npx electron tests/electron-concurrency.mjs
//
// Exercises actual dual-connection contention against a WAL database using the
// Electron-ABI better-sqlite3 that the app uses in production.
import { app } from 'electron';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { buildIndex } from '../out/main/indexer.js';

let failures = 0;
const childScript = join(dirname(fileURLToPath(import.meta.url)), 'electron-concurrency-child.mjs');
function assert(condition, msg) {
  if (!condition) { console.error('FAIL:', msg); failures++; }
  else console.log('PASS:', msg);
}

function spawnChild(mode, payload) {
  return spawn(process.execPath, [childScript, mode, JSON.stringify(payload)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
}

function lineReader(child) {
  const lines = [];
  const waiters = [];
  createInterface({ input: child.stdout }).on('line', line => {
    lines.push(line);
    for (const waiter of [...waiters]) {
      if (!line.startsWith(waiter.prefix)) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(line);
    }
  });
  return {
    waitFor(prefix) {
      const existing = lines.find(line => line.startsWith(prefix));
      if (existing) return Promise.resolve(existing);
      return new Promise(resolve => waiters.push({ prefix, resolve }));
    },
  };
}

async function waitForSuccess(child) {
  let code = child.exitCode;
  if (code === null) [code] = await once(child, 'exit');
  assert(code === 0, `child exited successfully, code=${code}`);
}

async function run() {
  const home = mkdtempSync(join(tmpdir(), 'obelisk-electron-concurrency-'));
  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
  const projectsDir = join(home, '.claude', 'projects');
  const projDir = join(projectsDir, '-proj');
  mkdirSync(join(home, '.obelisk'), { recursive: true });
  mkdirSync(projDir, { recursive: true });

  function msg(uuid) {
    return JSON.stringify({
      uuid, type: 'user', timestamp: '2026-06-10T10:00:00Z', cwd: '/tmp',
      message: { role: 'user', content: `concurrent ${uuid}` },
    }) + '\n';
  }
  for (let i = 0; i < 20; i++) {
    writeFileSync(join(projDir, `s${i}.jsonl`), msg(`m${i}`));
  }

  console.log('--- Test 1: buildIndex with real better-sqlite3 ---');
  const result = buildIndex({
    force: true,
    claudeDir: join(home, '.claude'),
    codexDir: join(home, '.codex'),
    projectsDir,
    dbPath,
    DatabaseImpl: Database,
  });
  assert(result.files === 20, `indexed 20 files, got ${result.files}`);
  assert(result.skipped === 0, `no files skipped, got ${result.skipped}`);

  console.log('--- Test 2: concurrent reader during write ---');
  const reader = new Database(dbPath, { readonly: true });
  reader.pragma('journal_mode = WAL');
  const readStmt = reader.prepare('SELECT COUNT(*) AS c FROM sessions');
  const beforeCount = readStmt.get().c;
  assert(beforeCount === 20, `reader sees 20 sessions, got ${beforeCount}`);
  // Incremental build concurrent with open reader
  const result2 = buildIndex({
    force: false,
    claudeDir: join(home, '.claude'),
    codexDir: join(home, '.codex'),
    projectsDir,
    dbPath,
    DatabaseImpl: Database,
  });
  assert(result2.skipped === 0, `concurrent build no skips, got ${result2.skipped}`);
  const duringCount = readStmt.get().c;
  assert(duringCount === 20, `reader snapshot stable, got ${duringCount}`);
  reader.close();

  console.log('--- Test 3: a real concurrent writer releases within the lease budget ---');
  const lockPath = join(dirname(dbPath), 'writer.lock.sqlite');
  const buildOptions = {
    force: false,
    claudeDir: join(home, '.claude'),
    codexDir: join(home, '.codex'),
    projectsDir,
    dbPath,
    writerLeaseWaitMs: 1500,
  };
  const holder = spawnChild('holder', { lockPath });
  const holderLines = lineReader(holder);
  await holderLines.waitFor('READY');
  const contendedBuild = spawnChild('build', { options: buildOptions });
  const buildLines = lineReader(contendedBuild);
  await buildLines.waitFor('STARTING');
  const startedAt = Date.now();
  await delay(200);
  holder.stdin.write('release\n');
  const resultLine = await buildLines.waitFor('RESULT ');
  const result3 = JSON.parse(resultLine.slice('RESULT '.length));
  const waitedMs = Date.now() - startedAt;
  assert(result3.deferred === false, `contended build completed, reason=${result3.reason}`);
  assert(result3.skipped === 0, `contended build skipped no files, got ${result3.skipped}`);
  assert(waitedMs >= 150, `build overlapped the held lease for ${waitedMs}ms`);
  await Promise.all([waitForSuccess(holder), waitForSuccess(contendedBuild)]);

  console.log('--- Test 4: persistent writer contention is bounded ---');
  const persistentHolder = spawnChild('holder', { lockPath });
  const persistentHolderLines = lineReader(persistentHolder);
  await persistentHolderLines.waitFor('READY');
  const boundedBuild = spawnChild('build', { options: { ...buildOptions, writerLeaseWaitMs: 200 } });
  const boundedLines = lineReader(boundedBuild);
  await boundedLines.waitFor('STARTING');
  const boundedStartedAt = Date.now();
  const boundedResultLine = await boundedLines.waitFor('RESULT ');
  const boundedResult = JSON.parse(boundedResultLine.slice('RESULT '.length));
  const boundedMs = Date.now() - boundedStartedAt;
  assert(boundedResult.deferred === true, 'persistent contention returns deferred');
  assert(boundedResult.reason === 'writer_busy', `persistent contention reason=${boundedResult.reason}`);
  assert(boundedMs < 1000, `persistent contention returned within budget (${boundedMs}ms)`);
  persistentHolder.stdin.write('release\n');
  await Promise.all([waitForSuccess(persistentHolder), waitForSuccess(boundedBuild)]);

  console.log('--- Test 5: ZCode source opens through the Electron SQLite binding ---');
  const zcodeRoot = join(home, '.zcode', 'cli');
  mkdirSync(join(zcodeRoot, 'db'), { recursive: true });
  copyFileSync(new URL('../../tests/fixtures/zcode/zcode-real-aggregate.sqlite', import.meta.url),
    join(zcodeRoot, 'db', 'db.sqlite'));
  const zcodeIndexPath = join(home, 'zcode-index.sqlite');
  const zcodeResult = buildIndex({
    force: true,
    claudeDir: join(home, '.missing-claude'),
    codexDir: join(home, '.missing-codex'),
    projectsDir: join(home, '.missing-claude', 'projects'),
    providerRoots: { zcode: zcodeRoot },
    dbPath: zcodeIndexPath,
    DatabaseImpl: Database,
  });
  const zcodeIndex = new Database(zcodeIndexPath, { readonly: true });
  const zcodeSessions = zcodeIndex.prepare("SELECT COUNT(*) c FROM sessions WHERE source='zcode'").get().c;
  assert(zcodeResult.complete === true, 'the Electron ZCode inventory is complete');
  assert(zcodeSessions === 17, `the Electron binding indexes all 17 ZCode sessions, got ${zcodeSessions}`);
  zcodeIndex.close();

  rmSync(home, { recursive: true, force: true });
  console.log('---');
  console.log(failures ? `${failures} TEST(S) FAILED` : 'ALL TESTS PASSED');
  process.exitCode = failures ? 1 : 0;
}

app.whenReady().then(run).finally(() => app.quit());
