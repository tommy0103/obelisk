// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import os from 'node:os';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import {
  createAdaptiveWatcher,
  type ParcelSubscribe,
  type WatchTarget,
} from '../../../packages/adaptive-watcher/src/index.ts';

const DEFAULT_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
// Bounded batching (#86): a short trailing debounce coalesces one filesystem
// burst; maxWait bounds how long sustained activity can postpone a build.
// Values from the PR #103 merge-gate benchmark on the real ~18.7k-transcript
// corpus: the ceiling releases builds correctly and the queue converges.
// Steady-state changed-path builds are ~60 ms warm; the remaining latency is
// the cold first-build finalize (refreshSessionProjectPaths does one
// unindexed per-session scan of the messages table — seconds on this corpus),
// tracked as issue #105.
const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_STABILITY_MS = 500;
const DEFAULT_MAX_WAIT_MS = 1500;
const DEFAULT_HEARTBEAT_MS = 30000;
const DEFAULT_WATCH_RETRY_MS = 5000;
const DEFAULT_DEFERRED_RETRY_MS = 250;
const DEFAULT_RECONCILE_MS = 5 * 60 * 1000;
const MAX_INVENTORY_RETRY_MS = 10 * 60 * 1000;

type TimerHandle = ReturnType<typeof setTimeout>;

interface Timers {
  setTimeout: (fn: () => void, ms?: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
  setInterval?: (fn: () => void, ms?: number) => TimerHandle;
  clearInterval?: (handle: TimerHandle) => void;
}

interface Watcher {
  close(): unknown;
  promote?(path: string): void;
  refreshMissingRoots?(): boolean;
}

interface IndexerBuildResult {
  deferred?: boolean;
  complete?: boolean;
  affectedSessionIds?: string[];
  /** Recently written transcripts, most recent first — seeded into the
   * watcher's hot set (ADR-0009). */
  watchHints?: string[];
  inventoryIssues?: Array<{
    provider: string;
    path: string;
    error: string;
  }>;
}

type IndexerBuild = (args: {
  reason?: string;
  changedPaths?: string[];
  retrySessionIds?: string[];
}) => IndexerBuildResult | void | Promise<IndexerBuildResult | void>;

interface IndexerServiceOptions {
  projectsDir?: string;
  /** Typed watch targets (ADR-0009); defaults to the Claude projects tree. */
  watchTargets?: WatchTarget[];
  debounceMs?: number;
  stabilityMs?: number;
  /** Maximum delay from the first event of an idle burst to a build, no
   * matter how sustained the event stream is (#86). <= 0 disables the cap
   * (legacy unbounded trailing debounce). */
  maxWaitMs?: number;
  heartbeatMs?: number;
  watchRetryMs?: number;
  deferredRetryMs?: number;
  /** Interval for a periodic full-inventory reconcile build; bounds worst-case
   * staleness from events the watcher silently drops. 0 disables it. */
  reconcileMs?: number;
  buildIndex?: IndexerBuild;
  writeHeartbeat?: () => unknown;
  watchProjects?: (onChange: (changedPath?: string) => void) => Watcher | null;
  /** Injection point for the default watcher's @parcel/watcher subscribe (tests). */
  subscribe?: ParcelSubscribe;
  /** Hot-overlay gate passthrough (tests); defaults to macOS-only. */
  hotPolling?: boolean;
  /** Poll interval passthrough for the watcher's file poller (tests). */
  watchPollMs?: number;
  timers?: Timers;
  logger?: { warn?: (msg: string) => void };
}

const TRANSCRIPT_SUFFIXES = ['.jsonl.zstd', '.jsonl', '.json'] as const;

function isTranscriptPath(targetPath: string): boolean {
  return TRANSCRIPT_SUFFIXES.some((suffix) => targetPath.endsWith(suffix));
}

function createIndexerService({
  projectsDir = DEFAULT_PROJECTS_DIR,
  watchTargets,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  stabilityMs = DEFAULT_STABILITY_MS,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  watchRetryMs = DEFAULT_WATCH_RETRY_MS,
  deferredRetryMs = DEFAULT_DEFERRED_RETRY_MS,
  reconcileMs = DEFAULT_RECONCILE_MS,
  buildIndex,
  writeHeartbeat = () => {},
  watchProjects,
  subscribe,
  hotPolling,
  watchPollMs,
  timers = {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  },
  logger = console,
}: IndexerServiceOptions = {}) {
  if (typeof buildIndex !== 'function') throw new Error('createIndexerService() requires buildIndex');
  const watch = watchProjects || ((onChange) => {
    const targets = watchTargets ?? [{ kind: 'tree' as const, path: projectsDir }];
    if (!targets.length) return null;
    return createAdaptiveWatcher({
      targets,
      subscribe,
      logger,
      timers,
      retryDelayMs: watchRetryMs,
      hotPolling,
      pollIntervalMs: watchPollMs,
      // The caller knows its transcripts; the package does not. Native events
      // for transcripts promote the path into the hot set before delivery.
      shouldPromote: (targetPath) => isTranscriptPath(targetPath),
      onInvalidate: (invalidation) => {
        // A rescan means anything under the root may have changed — full
        // inventory. Path invalidations filter to transcripts here, at the
        // caller, per the package's no-domain-knowledge boundary.
        if (invalidation.type === 'rescan') {
          onChange();
          return;
        }
        for (const changedPath of invalidation.paths) {
          // Transcripts forward immediately. Anything else may be a directory
          // event (a rename arrives as the bare path; the old side no longer
          // exists) — resolve it ASYNC (no sync IO in the main process,
          // CONTRIBUTING): existing non-directories (stray files) are dropped,
          // directories and missing paths are forwarded for the providers to
          // route or reconcile.
          if (isTranscriptPath(changedPath)) {
            onChange(changedPath);
            continue;
          }
          void stat(changedPath)
            .then((st) => { if (st.isDirectory()) onChange(changedPath); })
            .catch(() => onChange(changedPath));
        }
      },
    });
  });

  let buildTimer: TimerHandle | null = null;
  let stabilityTimer: TimerHandle | null = null;
  let maxWaitTimer: TimerHandle | null = null;
  let heartbeatTimer: TimerHandle | null = null;
  let reconcileTimer: TimerHandle | null = null;
  let watchRetryTimer: TimerHandle | null = null;
  let retryTimer: TimerHandle | null = null;
  let watcher: Watcher | null = null;
  let stopped = false;
  let running = false;
  let pending = false;
  let lastReason: string | null = null;
  let changedPaths = new Set<string>();
  const deferredSessionIds = new Set<string>();
  let fullInventoryPending = false;
  let nextInventoryRetryMs = heartbeatMs;
  let idlePromise = Promise.resolve();

  const requestFullInventory = () => {
    fullInventoryPending = true;
    changedPaths.clear();
  };

  const addChangedPath = (changedPath?: string | string[]) => {
    if (Array.isArray(changedPath)) {
      for (const p of changedPath) addChangedPath(p);
      return;
    }
    const name = changedPath ? String(changedPath) : '';
    if (name && !fullInventoryPending) changedPaths.add(name);
  };

  // Typed batches (#86): a full-inventory request and "no work" are NOT the
  // same value, so a stale burst callback no-ops instead of accidentally
  // launching a full scan (the root cause of the old ghost-build bug).
  type BuildBatch = { kind: 'full' } | { kind: 'paths'; paths: string[] };

  const takeBatch = (): BuildBatch | null => {
    if (fullInventoryPending) {
      fullInventoryPending = false;
      changedPaths.clear();
      return { kind: 'full' };
    }
    if (!changedPaths.size) return null;
    const paths = [...changedPaths];
    changedPaths = new Set();
    return { kind: 'paths', paths };
  };

  const publishHeartbeat = () => {
    try {
      return writeHeartbeat();
    } catch (error) {
      logger.warn?.(`Obelisk heartbeat failed: ${(error as Error).message}`);
      return false;
    }
  };

  const promoteWatchHints = (hints: string[] | undefined) => {
    // Seed the watcher's hot set with the transcripts a build just saw as
    // recently active (ADR-0009 hot-set closure, startup/reconcile leg).
    // Hints arrive newest-first; promote oldest-first so the Map's insertion
    // order leaves the NEWEST hint as the most-recently-used — otherwise the
    // next promotion would evict the freshest transcript.
    for (const hint of [...(hints ?? [])].reverse()) watcher?.promote?.(hint);
  };

  const clearBurstTimers = () => {
    if (buildTimer) timers.clearTimeout(buildTimer);
    if (stabilityTimer) timers.clearTimeout(stabilityTimer);
    if (maxWaitTimer) timers.clearTimeout(maxWaitTimer);
    buildTimer = null;
    stabilityTimer = null;
    maxWaitTimer = null;
  };

  const startBuild = (reason: string, batch: BuildBatch) => {
    if (stopped) return idlePromise;
    // Invariant: consuming a batch leaves no armed burst timers.
    clearBurstTimers();
    running = true;
    pending = false;
    const buildChangedPaths = batch.kind === 'full' ? undefined : batch.paths;
    idlePromise = (async () => {
      const retrySessionIds = [...deferredSessionIds];
      const result = await buildIndex({
        reason,
        changedPaths: buildChangedPaths,
        ...(retrySessionIds.length ? { retrySessionIds } : {}),
      });
      promoteWatchHints(result?.watchHints);
      if (result?.deferred) {
        for (const sessionId of result.affectedSessionIds ?? []) {
          deferredSessionIds.add(sessionId);
        }
      } else {
        deferredSessionIds.clear();
      }
      if (result?.complete === false) {
        for (const issue of result.inventoryIssues ?? []) {
          logger.warn?.(
            `Obelisk indexed a partial ${issue.provider} inventory at ${issue.path}: ${issue.error}`,
          );
        }
      }
      const incompleteInventory = (result?.inventoryIssues?.length ?? 0) > 0;
      if (!result?.deferred && !incompleteInventory && batch.kind === 'full') {
        nextInventoryRetryMs = heartbeatMs;
      }
      if (result?.deferred || incompleteInventory) {
        if (incompleteInventory || batch.kind === 'full') requestFullInventory();
        else addChangedPath(batch.paths);
        if (!stopped && !retryTimer) {
          const retryReason = result?.deferred ? 'writer-lease' : 'incomplete-inventory';
          const retryMs = result?.deferred ? deferredRetryMs : nextInventoryRetryMs;
          retryTimer = timers.setTimeout(() => {
            retryTimer = null;
            runBuildNow(retryReason);
          }, retryMs);
          if (!result?.deferred) {
            nextInventoryRetryMs = Math.min(nextInventoryRetryMs * 2, Math.max(
              heartbeatMs,
              MAX_INVENTORY_RETRY_MS,
            ));
          }
        }
        if (result?.deferred) return;
      }
      publishHeartbeat();
    })()
      .catch((error) => {
        // A build in flight when the service is stopped (e.g. a manual rebuild
        // tears down the worker) is a deliberate cancellation, not a failure.
        if (!stopped) logger.warn?.(`Obelisk index build failed: ${(error as Error).message}`);
      })
      .finally(() => {
        running = false;
        if (pending && !stopped) {
          pending = false;
          // The follow-up consumes the batch accumulated during the previous
          // build — immediately, with build duration as the throttle. A null
          // batch means there is nothing to do (no ghost full inventory).
          const followUp = takeBatch();
          if (followUp) startBuild('pending', followUp);
        }
      });
    return idlePromise;
  };

  const runBuildNow = (reason = "manual", paths: string[] | undefined = undefined) => {
    addChangedPath(paths);
    if (stopped) return idlePromise;
    if (running) {
      pending = true;
      return idlePromise;
    }
    // An explicit call with no accumulated work is a full build (startup,
    // manual rebuild, reconcile) — unchanged from the legacy contract.
    return startBuild(reason, takeBatch() ?? { kind: 'full' });
  };

  const fireBurst = () => {
    // Take the batch first: a stale burst callback must never launch work.
    const batch = takeBatch();
    clearBurstTimers();
    if (!batch) return;
    startBuild(lastReason || 'watch', batch);
  };

  const scheduleBuild = (reason = "change", changedPath: string | undefined = undefined) => {
    if (stopped) return;
    if (changedPath === undefined) requestFullInventory();
    else addChangedPath(changedPath);
    lastReason = reason;
    if (retryTimer) timers.clearTimeout(retryTimer);
    retryTimer = null;
    if (running) {
      // Single-flight: only aggregate. The in-flight build's follow-up
      // consumes this batch — burst timers are never armed while running,
      // which is what makes ghost builds structurally impossible.
      pending = true;
      return;
    }
    // Trailing timers reset on every event; the max-wait ceiling arms once
    // per burst and never resets, so sustained activity cannot postpone the
    // build past maxWaitMs (#86).
    if (buildTimer) timers.clearTimeout(buildTimer);
    if (stabilityTimer) timers.clearTimeout(stabilityTimer);
    buildTimer = null;
    stabilityTimer = null;
    if (maxWaitMs > 0 && !maxWaitTimer) {
      maxWaitTimer = timers.setTimeout(fireBurst, maxWaitMs);
    }
    buildTimer = timers.setTimeout(() => {
      buildTimer = null;
      if (stabilityMs <= 0) {
        fireBurst();
        return;
      }
      stabilityTimer = timers.setTimeout(() => {
        stabilityTimer = null;
        fireBurst();
      }, stabilityMs);
    }, debounceMs);
  };

  const scheduleWatchRetry = () => {
    if (stopped || watchRetryTimer) return;
    watchRetryTimer = timers.setTimeout(() => {
      watchRetryTimer = null;
      if (!watcher) {
        startWatching();
        return;
      }
      if (watcher.refreshMissingRoots?.() === false) scheduleWatchRetry();
    }, watchRetryMs);
  };

  const startWatching = () => {
    if (stopped || watcher) return;
    watcher = watch((changedPath) => scheduleBuild('watch', changedPath));
    if (!watcher) {
      scheduleWatchRetry();
    } else if (watcher.refreshMissingRoots?.() === false) {
      scheduleWatchRetry();
    }
  };

  const start = ({ buildOnStart = true } = {}) => {
    stopped = false;
    publishHeartbeat();
    if (buildOnStart) scheduleBuild('startup');
    startWatching();
    if (typeof timers.setInterval === 'function') {
      heartbeatTimer = timers.setInterval(() => {
        publishHeartbeat();
      }, heartbeatMs);
      // Periodic full-inventory reconcile: bounds worst-case staleness from
      // events the watcher silently drops (no error signal) to one interval.
      if (reconcileMs > 0) {
        reconcileTimer = timers.setInterval(() => {
          scheduleBuild('reconcile');
        }, reconcileMs);
      }
    }
  };

  const stop = () => {
    stopped = true;
    pending = false;
    clearBurstTimers();
    if (watchRetryTimer) timers.clearTimeout(watchRetryTimer);
    watchRetryTimer = null;
    if (retryTimer) timers.clearTimeout(retryTimer);
    retryTimer = null;
    nextInventoryRetryMs = heartbeatMs;
    if (typeof timers.clearInterval === 'function') {
      if (heartbeatTimer) timers.clearInterval(heartbeatTimer);
      if (reconcileTimer) timers.clearInterval(reconcileTimer);
    }
    heartbeatTimer = null;
    reconcileTimer = null;
    if (watcher?.close) watcher.close();
    watcher = null;
  };

  return {
    start,
    stop,
    scheduleBuild,
    runBuildNow,
    promoteWatchHints,
    idle: () => idlePromise,
  };
}

export { createIndexerService };
