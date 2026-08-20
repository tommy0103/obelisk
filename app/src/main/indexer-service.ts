// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import os from 'node:os';
import path from 'node:path';
import { createRecursiveWatcher, type ParcelSubscribe } from './watcher.ts';

const DEFAULT_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const DEFAULT_DEBOUNCE_MS = 2000;
const DEFAULT_STABILITY_MS = 500;
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
  refreshMissingRoots?(): boolean;
}

interface IndexerBuildResult {
  deferred?: boolean;
  complete?: boolean;
  inventoryIssues?: Array<{
    provider: string;
    path: string;
    error: string;
  }>;
}

type IndexerBuild = (args: {
  reason?: string;
  changedPaths?: string[];
}) => IndexerBuildResult | void | Promise<IndexerBuildResult | void>;

interface IndexerServiceOptions {
  projectsDir?: string;
  watchDirs?: string | string[];
  debounceMs?: number;
  stabilityMs?: number;
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
  timers?: Timers;
  logger?: { warn?: (msg: string) => void };
}

function createIndexerService({
  projectsDir = DEFAULT_PROJECTS_DIR,
  watchDirs = [projectsDir],
  debounceMs = DEFAULT_DEBOUNCE_MS,
  stabilityMs = DEFAULT_STABILITY_MS,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  watchRetryMs = DEFAULT_WATCH_RETRY_MS,
  deferredRetryMs = DEFAULT_DEFERRED_RETRY_MS,
  reconcileMs = DEFAULT_RECONCILE_MS,
  buildIndex,
  writeHeartbeat = () => {},
  watchProjects,
  subscribe,
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
    const roots = [...new Set((Array.isArray(watchDirs) ? watchDirs : [watchDirs]).filter(Boolean))];
    return createRecursiveWatcher({
      roots,
      filter: (targetPath) => targetPath.endsWith('.jsonl') || targetPath.endsWith('.json'),
      subscribe,
      logger,
      onChange,
      // A subscription that died (async error) is re-attached through the
      // same retry loop that picks up late-appearing roots.
      onRootLost: () => scheduleWatchRetry(),
    });
  });

  let buildTimer: TimerHandle | null = null;
  let stabilityTimer: TimerHandle | null = null;
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

  const takeChangedPaths = () => {
    if (fullInventoryPending) {
      fullInventoryPending = false;
      changedPaths.clear();
      return undefined;
    }
    if (!changedPaths.size) return undefined;
    const paths = [...changedPaths];
    changedPaths = new Set();
    return paths;
  };

  const publishHeartbeat = () => {
    try {
      return writeHeartbeat();
    } catch (error) {
      logger.warn?.(`Obelisk heartbeat failed: ${(error as Error).message}`);
      return false;
    }
  };

  const runBuildNow = (reason = "manual", paths: string[] | undefined = undefined) => {
    addChangedPath(paths);
    if (stopped) return idlePromise;
    if (running) {
      pending = true;
      return idlePromise;
    }
    running = true;
    pending = false;
    const buildChangedPaths = takeChangedPaths();
    idlePromise = (async () => {
      const result = await buildIndex({ reason, changedPaths: buildChangedPaths });
      if (result?.complete === false) {
        for (const issue of result.inventoryIssues ?? []) {
          logger.warn?.(
            `Obelisk indexed a partial ${issue.provider} inventory at ${issue.path}: ${issue.error}`,
          );
        }
      }
      const incompleteInventory = (result?.inventoryIssues?.length ?? 0) > 0;
      if (!result?.deferred && !incompleteInventory && buildChangedPaths === undefined) {
        nextInventoryRetryMs = heartbeatMs;
      }
      if (result?.deferred || incompleteInventory) {
        if (incompleteInventory || buildChangedPaths === undefined) requestFullInventory();
        else addChangedPath(buildChangedPaths);
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
          runBuildNow('pending');
        }
      });
    return idlePromise;
  };

  const scheduleBuild = (reason = "change", changedPath: string | undefined = undefined) => {
    if (stopped) return;
    if (changedPath === undefined) requestFullInventory();
    else addChangedPath(changedPath);
    lastReason = reason;
    if (running) pending = true;
    if (retryTimer) timers.clearTimeout(retryTimer);
    retryTimer = null;
    if (buildTimer) timers.clearTimeout(buildTimer);
    if (stabilityTimer) timers.clearTimeout(stabilityTimer);
    buildTimer = timers.setTimeout(() => {
      buildTimer = null;
      if (stabilityMs <= 0) {
        runBuildNow(lastReason || reason);
        return;
      }
      stabilityTimer = timers.setTimeout(() => {
        stabilityTimer = null;
        runBuildNow(lastReason || reason);
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
    if (buildTimer) timers.clearTimeout(buildTimer);
    buildTimer = null;
    if (stabilityTimer) timers.clearTimeout(stabilityTimer);
    stabilityTimer = null;
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
    idle: () => idlePromise,
  };
}

export { createIndexerService };
