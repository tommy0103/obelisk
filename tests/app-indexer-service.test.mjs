// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from './temp-dirs.mjs';

const require = createRequire(import.meta.url);
import { createIndexerService } from '../app/src/main/indexer-service.ts';

function manualTimers() {
  // A mock clock: setTimeout records the fn with its due time; tick(ms)
  // advances the clock and fires due timers in due order. flush() fires
  // everything pending — fine for tests that do not care about ordering, but
  // meaningless for proving a ceiling, since it ignores delays entirely.
  let now = 0;
  const timers = new Map();
  const delays = [];
  return {
    delays,
    setTimeout(fn, ms = 0) {
      delays.push(ms);
      timers.set(fn, now + ms);
      return fn;
    },
    clearTimeout(fn) {
      timers.delete(fn);
    },
    tick(ms) {
      now += ms;
      for (const [fn, due] of [...timers.entries()].sort((a, b) => a[1] - b[1])) {
        if (due > now) continue;
        timers.delete(fn);
        fn();
      }
    },
    flush() {
      const pending = [...timers.keys()];
      timers.clear();
      for (const fn of pending) fn();
    },
  };
}

// Polls with real timers — subscribing a root is async (the adapter probes
// existence via fs.promises before subscribing), so tests cannot assert
// subscription state synchronously after start().
async function until(cond, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return cond();
}

test('indexer service debounces repeated build requests', async () => {
  const timers = manualTimers();
  const calls = [];
  const service = createIndexerService({
    buildIndex: async ({ reason }) => calls.push(reason),
    watchProjects: () => null,
    writeHeartbeat: () => {},
    timers,
    stabilityMs: 0,
  });

  service.scheduleBuild('first');
  service.scheduleBuild('second');
  service.scheduleBuild('third');
  timers.flush();
  await service.idle();

  assert.deepEqual(calls, ['third']);
});

test('indexer service runs one pending build after an in-flight build finishes', async () => {
  const timers = manualTimers();
  const calls = [];
  let finishFirst;
  const service = createIndexerService({
    buildIndex: async ({ reason }) => {
      calls.push(reason);
      if (reason === 'first') await new Promise(resolve => { finishFirst = resolve; });
    },
    watchProjects: () => null,
    writeHeartbeat: () => {},
    timers,
    stabilityMs: 0,
  });

  const first = service.runBuildNow('first');
  service.scheduleBuild('second');
  timers.flush();

  assert.deepEqual(calls, ['first']);
  finishFirst();
  await first;
  await service.idle();

  assert.deepEqual(calls, ['first', 'pending']);
});

test('indexer service reschedules a writer-lease deferral without publishing a heartbeat', async () => {
  const timers = manualTimers();
  const calls = [];
  let heartbeats = 0;
  const service = createIndexerService({
    buildIndex: async ({ reason, changedPaths }) => {
      calls.push({ reason, changedPaths });
      return calls.length === 1 ? { deferred: true, reason: 'writer_busy' } : { deferred: false };
    },
    watchProjects: () => null,
    writeHeartbeat: () => { heartbeats += 1; },
    timers,
    stabilityMs: 0,
  });

  await service.runBuildNow('watch', ['project/session.jsonl']);
  assert.equal(heartbeats, 0);
  assert.equal(calls.length, 1);

  timers.flush();
  await service.idle();
  assert.deepEqual(calls, [
    { reason: 'watch', changedPaths: ['project/session.jsonl'] },
    { reason: 'writer-lease', changedPaths: ['project/session.jsonl'] },
  ]);
  assert.equal(heartbeats, 1);
});

test('a deferred full-inventory build stays full when retried', async () => {
  const timers = manualTimers();
  const calls = [];
  const service = createIndexerService({
    buildIndex: async (args) => {
      calls.push(args);
      return calls.length === 1 ? { deferred: true } : { deferred: false };
    },
    watchProjects: () => null,
    writeHeartbeat: () => {},
    timers,
    stabilityMs: 0,
  });

  service.scheduleBuild('root-appeared');
  timers.flush();
  await service.idle();
  service.scheduleBuild('ordinary-change', '/tmp/later.jsonl');
  timers.flush();
  await service.idle();

  assert.deepEqual(calls, [
    { reason: 'root-appeared', changedPaths: undefined },
    { reason: 'ordinary-change', changedPaths: undefined },
  ]);
});

test('indexer service does not log a build cancelled by a service stop', async () => {
  const timers = manualTimers();
  const warnings = [];
  let rejectBuild;
  const service = createIndexerService({
    buildIndex: () => new Promise((_resolve, reject) => { rejectBuild = reject; }),
    watchProjects: () => null,
    writeHeartbeat: () => {},
    timers,
    stabilityMs: 0,
    logger: { warn: (msg) => warnings.push(msg) },
  });

  const build = service.runBuildNow('startup');
  service.stop(); // manual rebuild path tears the worker down mid-build
  rejectBuild(new Error('Indexer worker stopped'));
  await build;

  assert.deepEqual(warnings, []);
});

test('indexer service logs a build that fails while running', async () => {
  const timers = manualTimers();
  const warnings = [];
  let rejectBuild;
  const service = createIndexerService({
    buildIndex: () => new Promise((_resolve, reject) => { rejectBuild = reject; }),
    watchProjects: () => null,
    writeHeartbeat: () => {},
    timers,
    stabilityMs: 0,
    logger: { warn: (msg) => warnings.push(msg) },
  });

  const build = service.runBuildNow('watch');
  rejectBuild(new Error('disk on fire'));
  await build;

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Obelisk index build failed: disk on fire/);
});

test('indexer service reports partial inventory paths on ordinary builds', async () => {
  const timers = manualTimers();
  const warnings = [];
  const service = createIndexerService({
    buildIndex: async () => ({
      deferred: false,
      complete: false,
      inventoryIssues: [{
        provider: 'pi',
        path: '/tmp/pi/locked',
        error: 'EACCES: permission denied',
      }],
    }),
    watchProjects: () => null,
    writeHeartbeat: () => {},
    logger: { warn: (msg) => warnings.push(msg) },
    timers,
    stabilityMs: 0,
  });

  await service.runBuildNow('startup');
  service.stop();

  assert.deepEqual(warnings, [
    'Obelisk indexed a partial pi inventory at /tmp/pi/locked: EACCES: permission denied',
  ]);
});

test('an incomplete inventory schedules a full retry', async () => {
  const timers = manualTimers();
  const calls = [];
  const service = createIndexerService({
    buildIndex: async (args) => {
      calls.push(args);
      return calls.length === 1
        ? {
            complete: false,
            inventoryIssues: [{
              provider: 'pi',
              path: '/tmp/pi/locked',
              error: 'EACCES: permission denied',
            }],
          }
        : { complete: true };
    },
    watchProjects: () => null,
    writeHeartbeat: () => {},
    logger: { warn() {} },
    timers,
    stabilityMs: 0,
  });

  await service.runBuildNow('watch', ['/tmp/pi/session.jsonl']);
  timers.flush();
  await service.idle();

  assert.deepEqual(calls, [
    { reason: 'watch', changedPaths: ['/tmp/pi/session.jsonl'] },
    { reason: 'incomplete-inventory', changedPaths: undefined },
  ]);
});

test('incomplete inventory retries back off to ten minutes and reset after recovery', async () => {
  const timers = manualTimers();
  let incomplete = true;
  const service = createIndexerService({
    buildIndex: async () => incomplete
      ? {
          complete: false,
          inventoryIssues: [{
            provider: 'pi',
            path: '/tmp/pi/locked',
            error: 'EACCES: permission denied',
          }],
        }
      : { complete: true, inventoryIssues: [] },
    watchProjects: () => null,
    writeHeartbeat: () => {},
    logger: { warn() {} },
    timers,
    heartbeatMs: 120_000,
    stabilityMs: 0,
  });

  await service.runBuildNow('startup');
  for (let attempt = 0; attempt < 4; attempt++) {
    timers.flush();
    await service.idle();
  }
  assert.deepEqual(timers.delays, [120_000, 240_000, 480_000, 600_000, 600_000]);

  incomplete = false;
  timers.flush();
  await service.idle();
  incomplete = true;
  await service.runBuildNow('manual');
  assert.equal(timers.delays.at(-1), 120_000);
  service.stop();
});

test('a failed unit does not promote its changed-path build to a full retry', async () => {
  const timers = manualTimers();
  const calls = [];
  const service = createIndexerService({
    buildIndex: async (args) => {
      calls.push(args);
      return { complete: false, inventoryIssues: [] };
    },
    watchProjects: () => null,
    writeHeartbeat: () => {},
    timers,
    stabilityMs: 0,
  });

  await service.runBuildNow('watch', ['/tmp/pi/bad-session.jsonl']);
  timers.flush();
  await service.idle();

  assert.deepEqual(calls, [{
    reason: 'watch',
    changedPaths: ['/tmp/pi/bad-session.jsonl'],
  }]);
});

test('indexer service reports partial inventory paths before a deferred retry', async () => {
  const timers = manualTimers();
  const warnings = [];
  const service = createIndexerService({
    buildIndex: async () => ({
      deferred: true,
      complete: false,
      inventoryIssues: [{
        provider: 'pi',
        path: '/tmp/pi/locked',
        error: 'EACCES: permission denied',
      }],
    }),
    watchProjects: () => null,
    writeHeartbeat: () => {},
    logger: { warn: (msg) => warnings.push(msg) },
    timers,
    stabilityMs: 0,
  });

  await service.runBuildNow('startup');
  service.stop();

  assert.deepEqual(warnings, [
    'Obelisk indexed a partial pi inventory at /tmp/pi/locked: EACCES: permission denied',
  ]);
});

test('indexer service waits for a stability window before building', async () => {
  const timers = manualTimers();
  const calls = [];
  const service = createIndexerService({
    buildIndex: async ({ reason }) => calls.push(reason),
    watchProjects: () => null,
    writeHeartbeat: () => {},
    timers,
    stabilityMs: 500,
    // This test pins the trailing two-stage path; the manual timers flush
    // every delay together, which would fire the max-wait timer early.
    maxWaitMs: 0,
  });

  service.scheduleBuild('jsonl-change');
  timers.flush();
  await service.idle();
  assert.deepEqual(calls, []);

  timers.flush();
  await service.idle();
  assert.deepEqual(calls, ['jsonl-change']);
});

test('indexer service retries watcher setup when the projects directory is missing', () => {
  const timers = manualTimers();
  let attempts = 0;
  const service = createIndexerService({
    buildIndex: async () => {},
    watchProjects: () => {
      attempts++;
      return attempts === 1 ? null : { close() {} };
    },
    writeHeartbeat: () => {},
    timers,
    stabilityMs: 0,
  });

  service.start({ buildOnStart: false });
  assert.equal(attempts, 1);

  timers.flush();
  assert.equal(attempts, 2);

  timers.flush();
  assert.equal(attempts, 2);
});

test('indexer service publishes daemon ownership as soon as it starts', () => {
  const timers = manualTimers();
  let heartbeats = 0;
  const service = createIndexerService({
    buildIndex: async () => ({ deferred: false }),
    watchProjects: () => null,
    writeHeartbeat: () => { heartbeats += 1; },
    timers,
    stabilityMs: 0,
  });

  service.start({ buildOnStart: false });
  assert.equal(heartbeats, 1);
  service.stop();
});

test('indexer service watches Claude JSON files through a recursive @parcel/watcher subscription', async () => {
  const projectsDir = makeTempDir('obelisk-parcel-projects-');
  const timers = manualTimers();
  const calls = [];
  let watchArgs = null;
  let emit = null;
  const subscription = {
    unsubscribeCalled: false,
    unsubscribe() {
      subscription.unsubscribeCalled = true;
      return Promise.resolve();
    },
  };
  const subscribe = (root, callback) => {
    watchArgs = root;
    emit = callback;
    return Promise.resolve(subscription);
  };

  const service = createIndexerService({
    projectsDir,
    buildIndex: async ({ reason }) => calls.push(reason),
    subscribe,
    writeHeartbeat: () => {},
    timers,
    stabilityMs: 0,
    debounceMs: 0,
  });

  try {
    service.start({ buildOnStart: false });
    assert.ok(await until(() => watchArgs !== null), 'the root is subscribed');
    assert.equal(watchArgs, projectsDir);

    emit(null, [{ type: 'update', path: join(projectsDir, 'session.jsonl') }]);
    timers.flush();
    await service.idle();
    assert.deepEqual(calls, ['watch']);
  } finally {
    service.stop();
  }

  assert.ok(await until(() => subscription.unsubscribeCalled), 'the subscription is released on stop');
});

test('indexer service passes changed JSONL paths to the build worker', async () => {
  const projectsDir = makeTempDir('obelisk-changed-paths-');
  const timers = manualTimers();
  const calls = [];
  let emit = null;
  const subscribe = (_root, callback) => {
    emit = callback;
    return Promise.resolve({ unsubscribe: () => Promise.resolve() });
  };

  const service = createIndexerService({
    projectsDir,
    buildIndex: async (args) => calls.push(args),
    subscribe,
    writeHeartbeat: () => {},
    timers,
    stabilityMs: 0,
    debounceMs: 0,
  });

  service.start({ buildOnStart: false });
  assert.ok(await until(() => emit !== null), 'the root is subscribed');
  emit(null, [{ type: 'update', path: join(projectsDir, 'project-a/session-1.jsonl') }]);
  emit(null, [{ type: 'create', path: join(projectsDir, 'project-a/session-2.json') }]);
  timers.flush();
  await service.idle();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].reason, 'watch');
  assert.deepEqual(calls[0].changedPaths, [
    join(projectsDir, 'project-a/session-1.jsonl'),
    join(projectsDir, 'project-a/session-2.json'),
  ]);
});

test('indexer service watches Claude projects and Codex sessions for app-side indexing', async () => {
  const claudeProjectsDir = makeTempDir('obelisk-watch-claude-');
  const codexSessionsDir = makeTempDir('obelisk-watch-codex-sessions-');
  const timers = manualTimers();
  const calls = [];
  const emitters = [];
  const watchArgs = [];
  const subscribe = (root, callback) => {
    watchArgs.push(root);
    emitters.push(callback);
    return Promise.resolve({ unsubscribe: () => Promise.resolve() });
  };

  const service = createIndexerService({
    projectsDir: claudeProjectsDir,
    watchTargets: [{ kind: 'tree', path: claudeProjectsDir }, { kind: 'tree', path: codexSessionsDir }],
    buildIndex: async (args) => calls.push(args),
    subscribe,
    writeHeartbeat: () => {},
    timers,
    stabilityMs: 0,
    debounceMs: 0,
  });

  service.start({ buildOnStart: false });
  assert.ok(await until(() => watchArgs.length === 2), 'both roots are subscribed');
  // Subscription order is nondeterministic — the async existence probes
  // complete in threadpool order. The requirement is coverage, not order.
  assert.deepEqual([...watchArgs].sort(), [claudeProjectsDir, codexSessionsDir].sort());

  emitters[1](null, [{
    type: 'update',
    path: join(codexSessionsDir, '2026/06/15/rollout-2026-06-15T00-00-00-codex.jsonl'),
  }]);
  timers.flush();
  await service.idle();

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].changedPaths, [
    join(codexSessionsDir, '2026/06/15/rollout-2026-06-15T00-00-00-codex.jsonl'),
  ]);
});

test('indexer service starts watching a configured root that appears after startup', async () => {
  const existingRoot = makeTempDir('obelisk-watch-existing-');
  const parent = makeTempDir('obelisk-watch-late-parent-');
  const lateRoot = join(parent, 'nested', 'sessions');
  const timers = manualTimers();
  const calls = [];
  const watchArgs = [];
  const subscribe = (root) => {
    watchArgs.push(root);
    return Promise.resolve({ unsubscribe: () => Promise.resolve() });
  };
  const service = createIndexerService({
    watchTargets: [{ kind: 'tree', path: existingRoot }, { kind: 'tree', path: lateRoot }],
    buildIndex: async (args) => calls.push(args),
    subscribe,
    writeHeartbeat: () => {},
    timers,
    stabilityMs: 0,
    debounceMs: 0,
    watchRetryMs: 0,
  });

  try {
    service.start({ buildOnStart: false });
    assert.ok(await until(() => watchArgs.length === 1), 'the existing root is subscribed');
    assert.deepEqual(watchArgs, [existingRoot]);

    mkdirSync(lateRoot, { recursive: true });
    writeFileSync(join(lateRoot, 'pre-existing.jsonl'), '{}\n');
    timers.flush();
    assert.ok(await until(() => watchArgs.length === 2), 'the late root is picked up by the retry');
    assert.deepEqual(watchArgs, [existingRoot, lateRoot]);

    timers.flush();
    await service.idle();
    assert.deepEqual(calls, [{
      reason: 'watch',
      changedPaths: undefined,
    }]);
  } finally {
    service.stop();
  }
});


// ---- bounded scheduling (#86) ----

test('sustained events cannot postpone a build past the max-wait ceiling', async () => {
  const timers = manualTimers();
  const calls = [];
  const service = createIndexerService({
    buildIndex: async (args) => calls.push(args),
    watchProjects: () => null,
    writeHeartbeat: () => {},
    timers,
    stabilityMs: 0,
    // Trailing is set far beyond the ceiling so the ceiling is the only
    // timer that can fire inside the test window.
    debounceMs: 5000,
    maxWaitMs: 1500,
  });

  // t=0: first event arms trailing (250 ms) and the ceiling (1500 ms).
  service.scheduleBuild('watch', 'a.jsonl');
  timers.tick(1499);
  assert.deepEqual(calls, [], 'neither timer is due yet');

  // t=1499: another event resets ONLY the trailing timer. If the ceiling
  // were (incorrectly) reset too, it would not be due for another 1500 ms.
  service.scheduleBuild('watch', 'b.jsonl');
  timers.tick(1);
  await service.idle();

  assert.equal(calls.length, 1, 'the ceiling fires at t=1500 despite the fresh event');
  assert.deepEqual(calls[0].changedPaths, ['a.jsonl', 'b.jsonl']);
  assert.equal(calls[0].reason, 'watch');

  timers.flush();
  await service.idle();
  assert.equal(calls.length, 1, 'no second build fires from a cleared or stale timer');
});

test('the final write is indexed by the trailing build after the source goes quiet', async () => {
  const timers = manualTimers();
  const calls = [];
  const service = createIndexerService({
    buildIndex: async (args) => calls.push(args),
    watchProjects: () => null,
    writeHeartbeat: () => {},
    timers,
    stabilityMs: 500,
    debounceMs: 250,
    maxWaitMs: 1500,
  });

  service.scheduleBuild('watch', 'a.jsonl');
  service.scheduleBuild('watch', 'b.jsonl');
  timers.tick(1500);
  await service.idle();
  assert.equal(calls.length, 1, 'the burst builds once');

  // The last write: only the trailing path may release this build.
  service.scheduleBuild('watch', 'c.jsonl');
  timers.tick(249);
  await service.idle();
  assert.equal(calls.length, 1, 'still inside the trailing debounce');
  timers.tick(1); // t=250: debounce elapses, stability starts
  timers.tick(499);
  await service.idle();
  assert.equal(calls.length, 1, 'still inside the stability window');
  timers.tick(1); // t=500: stability elapses
  await service.idle();
  assert.equal(calls.length, 2, 'the trailing build runs after the source goes quiet');
  assert.deepEqual(calls[1].changedPaths, ['c.jsonl'], 'the final write is indexed');
});

test('events during a build produce exactly one follow-up and no ghost build', async () => {
  const timers = manualTimers();
  const calls = [];
  let finishFirst;
  const service = createIndexerService({
    buildIndex: async (args) => {
      calls.push(args);
      if (args.reason === 'first') await new Promise((resolve) => { finishFirst = resolve; });
    },
    watchProjects: () => null,
    writeHeartbeat: () => {},
    timers,
    stabilityMs: 0,
    debounceMs: 0,
  });

  const first = service.runBuildNow('first');
  service.scheduleBuild('watch', 'a.jsonl');
  service.scheduleBuild('watch', 'b.jsonl');
  timers.flush();
  assert.deepEqual(calls.map((c) => c.reason), ['first'],
    'burst timers are not armed while a build is running');

  finishFirst();
  await first;
  await service.idle();
  assert.deepEqual(calls.map((c) => c.reason), ['first', 'pending'],
    'exactly one follow-up build runs');
  assert.deepEqual(calls[1].changedPaths, ['a.jsonl', 'b.jsonl'],
    'the follow-up carries the accumulated batch — not an accidental full inventory');

  timers.flush();
  await service.idle();
  assert.equal(calls.length, 2, 'no ghost build fires afterwards');
});

test('each burst re-arms the max-wait ceiling after the previous build', async () => {
  const timers = manualTimers();
  const calls = [];
  const service = createIndexerService({
    buildIndex: async (args) => calls.push(args),
    watchProjects: () => null,
    writeHeartbeat: () => {},
    timers,
    stabilityMs: 0,
    debounceMs: 5000,
    maxWaitMs: 1500,
  });

  service.scheduleBuild('watch', 'a.jsonl');
  timers.tick(1499);
  assert.deepEqual(calls, []);
  timers.tick(1);
  await service.idle();
  assert.equal(calls.length, 1, 'the first burst builds at its ceiling');

  service.scheduleBuild('watch', 'b.jsonl');
  timers.tick(1499);
  await service.idle();
  assert.equal(calls.length, 1, 'the second burst is still inside its own ceiling');
  timers.tick(1);
  await service.idle();
  assert.equal(calls.length, 2, 'the second burst builds at its own ceiling');
  assert.deepEqual(calls[1].changedPaths, ['b.jsonl']);
});

test('sustained activity converges to periodic builds instead of postponing forever', async () => {
  const timers = manualTimers();
  const calls = [];
  const service = createIndexerService({
    buildIndex: async (args) => calls.push(args),
    watchProjects: () => null,
    writeHeartbeat: () => {},
    timers,
    stabilityMs: 0,
    debounceMs: 5000,
    maxWaitMs: 1500,
  });

  // One event every 300 ms for 4.5 s — far beyond the legacy 2 s trailing
  // window, which would never fire at all. The ceiling must release builds
  // periodically and cover every event.
  for (let t = 0; t < 15; t++) {
    service.scheduleBuild('watch', `session-${t}.jsonl`);
    timers.tick(300);
    await service.idle();
  }
  timers.tick(600);
  await service.idle();

  assert.equal(calls.length, 3, 'periodic builds at the 1.5 s ceiling');
  const covered = [...new Set(calls.flatMap((c) => c.changedPaths ?? []))];
  assert.deepEqual(
    covered,
    Array.from({ length: 15 }, (_, i) => `session-${i}.jsonl`),
    'every event is batched into a build — nothing is dropped or deferred forever',
  );
});

test('maxWaitMs 0 keeps the legacy unbounded trailing debounce', async () => {
  const timers = manualTimers();
  const calls = [];
  const service = createIndexerService({
    buildIndex: async (args) => calls.push(args),
    watchProjects: () => null,
    writeHeartbeat: () => {},
    timers,
    stabilityMs: 0,
    debounceMs: 250,
    maxWaitMs: 0,
  });

  // Events every 100 ms for 1.8 s — faster than the 250 ms trailing
  // debounce, and past the would-be 1500 ms ceiling. With the cap disabled
  // there must be NO build while events keep coming...
  for (let t = 0; t < 18; t++) {
    service.scheduleBuild('watch', `session-${t}.jsonl`);
    timers.tick(100);
    await service.idle();
  }
  assert.deepEqual(calls, [], 'no ceiling fires while disabled, even past 1500 ms');

  // ...and once the source goes quiet, the trailing path coalesces them all.
  timers.tick(250);
  await service.idle();
  assert.equal(calls.length, 1, 'the trailing path alone coalesces the burst');
  assert.deepEqual(
    [...new Set(calls[0].changedPaths)],
    Array.from({ length: 18 }, (_, i) => `session-${i}.jsonl`),
  );
});
