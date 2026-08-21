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
// - A bounded LRU hot set extends the poller to recently active transcripts
//   (promoted from native events via `shouldPromote`, seeded by
//   `initialHotFiles` or `promote()` from caller build hints). macOS only by
//   default; eviction degrades to the caller's periodic reconcile.
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
  /** Move a path into the bounded hot set (LRU-refreshed if already hot).
   * No-op when the hot overlay is disabled, the path is a pinned `file`
   * target, or the watcher is closed. */
  promote(path: string): void;
  close(): Promise<unknown>;
}

export type ParcelSubscribe = (
  root: string,
  callback: (err: Error | null, events: Array<{ type: string; path: string }>) => void,
) => Promise<{ unsubscribe(): Promise<void> }>;

export type FileSignature = { dev: number; ino: number; size: number; mtimeMs: number; isDirectory?: boolean };

/** Real fs.Stats exposes isDirectory() as a method; test fakes may use a
 * plain boolean. Both are accepted. */
export type StatProbeResult = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  isDirectory?: boolean | (() => boolean);
};

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
  /**
   * Enable the bounded hot-file overlay: promoted paths are polled like
   * pinned `file` targets. Closes the macOS gap where FSEvents delivers no
   * event for appends through a long-lived descriptor. Defaults to
   * `process.platform === 'darwin'` (ADR-0009 platform policy: macOS first,
   * other platforms only after their long-lived-writer matrix proves a need).
   */
  hotPolling?: boolean;
  /** Hard cap on hot (non-pinned) polled files. Default 64. */
  maxHotFiles?: number;
  /** Seeds the hot set at creation — covers transcripts already open before
   * the watcher started. */
  initialHotFiles?: string[];
  /** Decides whether a native tree event path enters the hot set (the
   * package has no domain knowledge — the caller knows its transcripts).
   * Promotion happens before the path invalidation is delivered. */
  shouldPromote?: (path: string) => boolean;
  /** Injection point for @parcel/watcher.subscribe (tests). */
  subscribe?: ParcelSubscribe;
  /** Injection point for the root existence probe (tests). */
  access?: (path: string) => Promise<unknown>;
  /** Injection point for the file metadata probe (tests). */
  stat?: (path: string) => Promise<StatProbeResult>;
  timers?: AdaptiveWatcherTimers;
  logger?: { warn?: (msg: string) => void };
}

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_RETRY_DELAY_MS = 5000;
const DEFAULT_MAX_HOT_FILES = 64;

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
  hotPolling,
  maxHotFiles = DEFAULT_MAX_HOT_FILES,
  initialHotFiles = [],
  shouldPromote,
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
  const pinnedFiles = new Set(fileTargets);
  const hotEnabled = hotPolling ?? process.platform === 'darwin';
  // Insertion-ordered LRU of hot (non-pinned) polled paths. Values unused.
  const hotFiles = new Map<string, null>();
  // Hot paths promoted by a native event baseline silently on first
  // observation — the event itself already delivered the change. Hint-seeded
  // paths (public promote) must report their first observation instead.
  const silentFirstBaseline = new Set<string>();

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
        if (paths.length) {
          // Promotion precedes delivery: the caller's catch-up build reads
          // content written before promotion, polling covers later appends.
          // Deletes never promote — a removed transcript would hold a hot
          // slot while permanently missing and evict live files.
          if (hotEnabled && shouldPromote) {
            for (const event of events ?? []) {
              if (event?.path && event.type !== 'delete' && shouldPromote(event.path)) {
                promoteHot(event.path, { silent: true });
              }
            }
          }
          onInvalidate({ type: 'paths', paths });
        }
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
      return {
        dev: stats.dev,
        ino: stats.ino,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        isDirectory: typeof stats.isDirectory === 'function'
          ? stats.isDirectory()
          : stats.isDirectory === true,
      };
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
      // Pinned first (never evicted), then hot files in LRU order.
      const observed: Array<readonly [string, boolean]> = [
        ...fileTargets.map((file) => [file, false] as const),
        ...[...hotFiles.keys()].map((file) => [file, true] as const),
      ];
      for (const [file, isHot] of observed) {
        const prev = baselines.get(file);
        const next = await statFile(file);
        // Evicted while its stat was in flight: stay evicted — do not
        // re-insert a baseline or report (the hard cap must hold).
        if (isHot && !hotFiles.has(file)) continue;
        // Unit keys are not always files (Kimi's key is the session
        // directory); polling a directory cannot see appends to the wire
        // file inside it, and the tree watch already covers it.
        if (isHot && next !== null && next.isDirectory) {
          hotFiles.delete(file);
          baselines.delete(file);
          silentFirstBaseline.delete(file);
          continue;
        }
        if (prev === undefined) {
          baselines.set(file, next);
          // Pinned targets and hint-promoted hot files report their first
          // observation of an existing file as an appearance (a redundant
          // incremental build beats a missed event); event-promoted hot
          // files baseline silently because the event already delivered
          // the change.
          const silent = isHot && silentFirstBaseline.delete(file);
          if (next !== null && !silent) changed.push(file);
          continue;
        }
        if (signatureChanged(prev ?? null, next)) {
          baselines.set(file, next);
          if (next !== null) lastWarned.delete(file);
          changed.push(file);
          if (isHot) {
            hotFiles.delete(file);
            hotFiles.set(file, null);
          }
        }
      }
      if (changed.length && !closed) onInvalidate({ type: 'paths', paths: changed });
    } finally {
      polling = false;
      if (!closed) pollTimer = timers.setTimeout(pollTick, pollIntervalMs);
    }
  };

  const promoteHot = (path: string, { silent }: { silent: boolean }) => {
    if (!hotEnabled || closed || pinnedFiles.has(path)) return;
    if (hotFiles.has(path)) {
      // LRU refresh; the baseline survives.
      hotFiles.delete(path);
      hotFiles.set(path, null);
      return;
    }
    while (hotFiles.size >= maxHotFiles) {
      const oldest = hotFiles.keys().next().value;
      if (oldest === undefined) break;
      hotFiles.delete(oldest);
      baselines.delete(oldest);
      silentFirstBaseline.delete(oldest);
    }
    hotFiles.set(path, null);
    baselines.set(path, undefined);
    if (silent) silentFirstBaseline.add(path);
  };

  // The build-hint channel: a hint means "the build saw this as recently
  // active", but appends after the build finished are covered by no
  // delivered signal — the first observation must report, never baseline
  // silently.
  const promote = (path: string) => promoteHot(path, { silent: false });

  // ------------------------------------------------------------- lifecycle

  refreshTrees();
  for (const file of initialHotFiles) promote(file);
  if (fileTargets.length || hotEnabled) {
    for (const file of fileTargets) baselines.set(file, undefined);
    pollTimer = timers.setTimeout(pollTick, pollIntervalMs);
  }

  return {
    promote,
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
