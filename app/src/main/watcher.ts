// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Thin adapter over @parcel/watcher: one recursive native subscription per
// root (FSEvents on macOS, inotify on Linux, ReadDirectoryChangesW on
// Windows), O(1) descriptors regardless of tree size. This replaces the
// chokidar 4 default, which — having dropped fsevents — opened one fd per
// file and one FSEventStream per directory and flooded EMFILE on real
// transcript trees (~23k paths), leaving ~20% of files unwatched.
//
// Robustness model:
// - All filesystem probes are async (fs.promises) — no synchronous IO in the
//   Electron main process (CONTRIBUTING.md). A stat on a network mount must
//   not freeze the UI.
// - A missing root is a normal steady state (e.g. no ~/.codex), not an
//   error: the existence check stays quiet and only drives the retry loop
//   through onRootLost. Only a genuine subscribe failure logs a warning.
// - A subscription that errors after establishing is dropped from the
//   watched set and re-attached through the same retry loop — a dead stream
//   never lingers as "watched".
// - onChange (no path, i.e. full inventory) fires exactly when coverage
//   increases — a subscription establishes — except during the initial
//   establishment pass, which the caller's startup build already covers.
// - Missed events with no error signal are bounded by the service's
//   periodic full-inventory reconcile, not by this module.

import fs from 'node:fs';
import parcelWatcher from '@parcel/watcher';

export type ParcelEvent = { type: string; path: string };
export type ParcelSubscribe = (
  root: string,
  callback: (err: Error | null, events: ParcelEvent[]) => void,
) => Promise<{ unsubscribe(): Promise<void> }>;

export interface RecursiveWatcher {
  close(): Promise<unknown>;
  /** Start attaching any configured roots that are not yet watched. Returns
   * true when every root is established or attaching. Attaching is async;
   * a root that turns out to be missing or lost is reported through
   * onRootLost — wire the caller's retry loop to it. */
  refreshMissingRoots(): boolean;
}

interface RecursiveWatcherOptions {
  roots: string[];
  filter: (path: string) => boolean;
  onChange: (changedPath?: string) => void;
  subscribe?: ParcelSubscribe;
  logger?: { warn?: (msg: string) => void };
  /** Called when a root needs a later retry: it does not exist yet, its
   * subscribe attempt failed, or its subscription errored. This callback is
   * what keeps late-appearing and recovered roots moving. */
  onRootLost?: (root: string) => void;
}

function createRecursiveWatcher({
  roots,
  filter,
  onChange,
  subscribe = parcelWatcher.subscribe as ParcelSubscribe,
  logger = console,
  onRootLost,
}: RecursiveWatcherOptions): RecursiveWatcher | null {
  if (!roots.length) return null;
  const subscriptions = new Map<string, { unsubscribe(): Promise<void> }>();
  const pending = new Set<string>();
  let closed = false;
  // The first wave of establishments is quiet — the startup build already
  // covers roots present at creation. Once the initial pass settles, every
  // further establishment is a genuine coverage increase worth a build.
  let initialPassDone = false;

  const noteSettled = () => {
    if (!initialPassDone && pending.size === 0) initialPassDone = true;
  };

  const dropRoot = (root: string) => {
    const sub = subscriptions.get(root);
    subscriptions.delete(root);
    pending.delete(root);
    noteSettled();
    if (sub) void sub.unsubscribe().catch(() => {});
    if (!closed) onRootLost?.(root);
  };

  const subscribeRoot = (root: string) => {
    let result: ReturnType<ParcelSubscribe>;
    try {
      result = subscribe(root, (err, events) => {
        if (err) {
          logger.warn?.(`Obelisk watcher failed for ${root}: ${(err as Error).message ?? err}`);
          dropRoot(root);
          return;
        }
        for (const event of events ?? []) {
          if (event?.path && filter(event.path)) onChange(event.path);
        }
      });
    } catch (error) {
      pending.delete(root);
      noteSettled();
      logger.warn?.(`Obelisk watcher failed to subscribe ${root}: ${(error as Error).message}`);
      if (!closed) onRootLost?.(root);
      return;
    }
    Promise.resolve(result).then((sub) => {
      const wasPending = pending.delete(root);
      const duringInitialPass = !initialPassDone;
      noteSettled();
      if (closed || !wasPending) {
        // The watcher was closed, or the subscription errored while it was
        // still being established (dropRoot already ran) — don't leak it.
        void sub.unsubscribe().catch(() => {});
        return;
      }
      subscriptions.set(root, sub);
      // The initial establishment pass is quiet — the startup build already
      // covers those roots. Later establishments are genuine coverage
      // increases and warrant a full-inventory build.
      if (!duringInitialPass) onChange();
    }, (error) => {
      pending.delete(root);
      noteSettled();
      logger.warn?.(`Obelisk watcher failed to subscribe ${root}: ${(error as Error).message ?? error}`);
      if (!closed) onRootLost?.(root);
    });
  };

  const addRoot = (root: string): boolean => {
    if (closed || subscriptions.has(root) || pending.has(root)) return false;
    pending.add(root);
    fs.promises.access(root).then(() => {
      if (closed || !pending.has(root)) return;
      subscribeRoot(root);
    }, () => {
      // The root does not exist (yet) — a normal steady state, not an error.
      pending.delete(root);
      noteSettled();
      if (!closed) onRootLost?.(root);
    });
    return true;
  };

  const refresh = (): boolean => {
    for (const root of roots) addRoot(root);
    return roots.every((root) => subscriptions.has(root) || pending.has(root));
  };

  // Start attaching the roots that already exist; late-appearing roots are
  // picked up by the caller's onRootLost-driven retry loop.
  refresh();

  return {
    close() {
      closed = true;
      const subs = [...subscriptions.values()];
      subscriptions.clear();
      return Promise.all(subs.map((sub) => sub.unsubscribe().catch(() => {})));
    },
    refreshMissingRoots() {
      return refresh();
    },
  };
}

export { createRecursiveWatcher };
