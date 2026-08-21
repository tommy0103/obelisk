// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Adaptive watcher (ADR-0009): explicit watch-target semantics instead of a
// chokidar-compatible "watch this string" contract.
//
// - `tree` targets get one recursive @parcel/watcher subscription per root
//   (FSEvents on macOS, inotify on Linux, ReadDirectoryChangesW on Windows):
//   resource use is O(roots), not O(paths). Tree events are best-effort.
// - `file` targets are exact files tracked by a small async metadata poller
//   (stat comparison). They are never passed to a recursive directory
//   backend, which would reject them (ENOTDIR from the FSEvents backend) or
//   mis-cover them. Exact files are also the only way to reliably observe a
//   writer that appends through a long-lived file descriptor: FSEvents
//   delivers no event for such appends until the descriptor closes.
// - Reliability lives inside the package: async existence probes, error
//   classification (ENOENT/ENOTDIR is a quiet steady state, everything else
//   warns once per root-and-failure), and a self-rescheduling retry loop.
//   A tree root that establishes after the initial pass emits `rescan` —
//   the caller must treat it as "anything under this root may have changed".
// - No synchronous filesystem calls, so the package is safe on the Electron
//   main thread. Timers are chained setTimeout only and are all cleared by
//   close().
// - Final consistency is the caller's job (e.g. a periodic full reconcile),
//   matching Apple's guidance that FSEvents is advisory.

import fs from 'node:fs';
import parcelWatcher from '@parcel/watcher';

export type WatchTarget = { kind: 'tree' | 'file'; path: string };

export type WatchInvalidation =
  | { type: 'paths'; paths: string[] }
  | { type: 'rescan'; roots: string[]; reason: string };

export interface AdaptiveWatcher {
  close(): Promise<unknown>;
}

export type ParcelSubscribe = (
  root: string,
  callback: (err: Error | null, events: Array<{ type: string; path: string }>) => void,
) => Promise<{ unsubscribe(): Promise<void> }>;

export type FileSignature = { dev: number; ino: number; size: number; mtimeMs: number };

export interface AdaptiveWatcherTimers {
  // `any` handles: whatever the injected setTimeout returns is only ever
  // handed back to the injected clearTimeout.
  setTimeout: (fn: () => void, ms?: number) => any;
  clearTimeout: (handle: any) => void;
}

export interface AdaptiveWatcherOptions {
  targets: WatchTarget[];
  onInvalidate: (invalidation: WatchInvalidation) => void;
  /** Poll interval for `file` targets. Default 1000 ms. */
  pollIntervalMs?: number;
  /** Delay before re-probing a missing or lost tree root. Default 5000 ms. */
  retryDelayMs?: number;
  /** Injection point for @parcel/watcher.subscribe (tests). */
  subscribe?: ParcelSubscribe;
  /** Injection point for the root existence probe (tests). */
  access?: (path: string) => Promise<unknown>;
  /** Injection point for the file metadata probe (tests). */
  stat?: (path: string) => Promise<FileSignature>;
  timers?: AdaptiveWatcherTimers;
  logger?: { warn?: (msg: string) => void };
}

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_RETRY_DELAY_MS = 5000;

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

function errorMessage(error: unknown): string {
  return (error as Error)?.message ?? String(error);
}

export function createAdaptiveWatcher({
  targets,
  onInvalidate,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  subscribe = parcelWatcher.subscribe as ParcelSubscribe,
  access = fs.promises.access,
  stat = fs.promises.stat,
  timers = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  },
  logger = console,
}: AdaptiveWatcherOptions): AdaptiveWatcher {
  const treeRoots = [...new Set(targets.filter((t) => t.kind === 'tree').map((t) => t.path))];
  // A file covered by a tree target stays in the poller: polling is not
  // there to extend directory coverage but to close the update-latency gap.
  const fileTargets = [...new Set(targets.filter((t) => t.kind === 'file').map((t) => t.path))];

  let closed = false;

  // Warn once per (subject, failure) pair: permanent problems (a bad
  // configured path, permissions) would otherwise log on every retry/poll
  // tick. Cleared when the subject recovers, so a recurrence reports again.
  const lastWarned = new Map<string, string>();
  const warnOnce = (subject: string, error: unknown, message: string) => {
    const key = `${errorCode(error) ?? ''}:${message}`;
    if (lastWarned.get(subject) === key) return;
    lastWarned.set(subject, key);
    logger.warn?.(message);
  };

  // ---------------------------------------------------------------- trees

  const subscriptions = new Map<string, { unsubscribe(): Promise<void> }>();
  const pending = new Set<string>();
  const inflightSubscribes = new Set<Promise<unknown>>();
  // Unsubscribes of dropped subscriptions (stream errors) — fire-and-forget
  // per tick, but tracked so close() waits for them too.
  const pendingUnsubscribes = new Set<Promise<unknown>>();
  let retryTimer: unknown = null;
  // The first wave of establishments is quiet — the caller's startup build
  // already covers roots present at creation. Once the initial pass settles,
  // every further establishment is a coverage increase and emits `rescan`.
  let initialPassDone = false;

  const noteSettled = () => {
    if (!initialPassDone && pending.size === 0) initialPassDone = true;
  };

  const scheduleRetry = () => {
    if (closed || retryTimer !== null) return;
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      refreshTrees();
    }, retryDelayMs);
  };

  const dropRoot = (root: string) => {
    const sub = subscriptions.get(root);
    subscriptions.delete(root);
    pending.delete(root);
    noteSettled();
    if (sub) {
      const release = sub.unsubscribe().catch(() => {});
      pendingUnsubscribes.add(release);
      void release.then(() => pendingUnsubscribes.delete(release));
    }
    if (!closed) scheduleRetry();
  };

  const subscribeRoot = (root: string) => {
    let result: ReturnType<ParcelSubscribe>;
    try {
      result = subscribe(root, (err, events) => {
        if (closed) return;
        if (err) {
          warnOnce(root, err, `Obelisk watcher failed for ${root}: ${errorMessage(err)}`);
          dropRoot(root);
          return;
        }
        const paths = (events ?? []).map((event) => event?.path).filter(Boolean);
        if (paths.length) onInvalidate({ type: 'paths', paths });
      });
    } catch (error) {
      pending.delete(root);
      noteSettled();
      warnOnce(root, error, `Obelisk watcher failed to subscribe ${root}: ${errorMessage(error)}`);
      if (!closed) scheduleRetry();
      return;
    }
    // Tracked so close() can wait for in-flight subscribes: on settle after
    // close they unsubscribe here, and `tracked` only completes afterwards.
    const tracked = Promise.resolve(result).then((sub) => {
      inflightSubscribes.delete(tracked);
      const wasPending = pending.delete(root);
      const duringInitialPass = !initialPassDone;
      noteSettled();
      if (closed || !wasPending) {
        // The watcher was closed, or the subscription errored while it was
        // still being established (dropRoot already ran) — don't leak it.
        return sub.unsubscribe().catch(() => {});
      }
      subscriptions.set(root, sub);
      lastWarned.delete(root);
      if (!duringInitialPass) {
        onInvalidate({ type: 'rescan', roots: [root], reason: 'root-established' });
      }
      return undefined;
    }, (error) => {
      inflightSubscribes.delete(tracked);
      pending.delete(root);
      noteSettled();
      warnOnce(root, error, `Obelisk watcher failed to subscribe ${root}: ${errorMessage(error)}`);
      if (!closed) scheduleRetry();
    });
    inflightSubscribes.add(tracked);
  };

  const addRoot = (root: string) => {
    if (closed || subscriptions.has(root) || pending.has(root)) return;
    pending.add(root);
    Promise.resolve(access(root)).then(() => {
      if (closed || !pending.has(root)) return;
      subscribeRoot(root);
    }, (error) => {
      pending.delete(root);
      noteSettled();
      const code = errorCode(error);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        warnOnce(root, error, `Obelisk watcher cannot access ${root}: ${errorMessage(error)}`);
      }
      if (!closed) scheduleRetry();
    });
  };

  const refreshTrees = () => {
    for (const root of treeRoots) addRoot(root);
  };

  // ---------------------------------------------------------- file poller

  // undefined = never observed. The first observation of an EXISTING file
  // emits an appearance invalidation on purpose: a redundant incremental
  // build at startup is cheap (the cursor is already there), while a
  // silently baselined appearance is a missed event. Only missing-at-first-
  // observation is quiet.
  const baselines = new Map<string, FileSignature | null | undefined>();
  let pollTimer: unknown = null;
  let polling = false;

  const statFile = async (file: string): Promise<FileSignature | null> => {
    try {
      const stats = await stat(file);
      return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs };
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      warnOnce(file, error, `Obelisk watcher cannot stat ${file}: ${errorMessage(error)}`);
      return baselines.get(file) ?? null;
    }
  };

  const signatureChanged = (prev: FileSignature | null, next: FileSignature | null): boolean => {
    if (prev === null || next === null) return prev !== next;
    return prev.dev !== next.dev || prev.ino !== next.ino
      || prev.size !== next.size || prev.mtimeMs !== next.mtimeMs;
  };

  const pollTick = async () => {
    if (polling || closed) return;
    polling = true;
    try {
      const changed: string[] = [];
      for (const file of fileTargets) {
        const prev = baselines.get(file);
        const next = await statFile(file);
        if (prev === undefined) {
          baselines.set(file, next);
          if (next !== null) changed.push(file);
          continue;
        }
        if (signatureChanged(prev ?? null, next)) {
          baselines.set(file, next);
          if (next !== null) lastWarned.delete(file);
          changed.push(file);
        }
      }
      if (changed.length && !closed) onInvalidate({ type: 'paths', paths: changed });
    } finally {
      polling = false;
      if (!closed) pollTimer = timers.setTimeout(pollTick, pollIntervalMs);
    }
  };

  // ------------------------------------------------------------- lifecycle

  refreshTrees();
  if (fileTargets.length) {
    for (const file of fileTargets) baselines.set(file, undefined);
    pollTimer = timers.setTimeout(pollTick, pollIntervalMs);
  }

  return {
    close() {
      closed = true;
      if (retryTimer !== null) timers.clearTimeout(retryTimer);
      retryTimer = null;
      if (pollTimer !== null) timers.clearTimeout(pollTimer);
      pollTimer = null;
      const subs = [...subscriptions.values()];
      subscriptions.clear();
      // In-flight subscribes unsubscribe themselves when they settle (they
      // observe closed); awaiting their tracked promises means close() does
      // not complete while a subscription can still outlive it.
      return Promise.all([
        ...subs.map((sub) => sub.unsubscribe().catch(() => {})),
        ...inflightSubscribes,
        ...pendingUnsubscribes,
      ]);
    },
  };
}
