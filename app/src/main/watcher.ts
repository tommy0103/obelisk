// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Thin adapter over @parcel/watcher: one recursive native subscription per
// root (FSEvents on macOS, inotify on Linux, ReadDirectoryChangesW on
// Windows), O(1) descriptors regardless of tree size. This replaces the
// chokidar 4 default, which — having dropped fsevents — opened one fd per
// file and one FSEventStream per directory and flooded EMFILE on real
// transcript trees (~23k paths), leaving ~20% of files unwatched.
//
// Robustness model: a subscription that fails at creation time or errors
// later is dropped from the watched set and reported through onRootLost, so
// the caller's retry loop re-attaches it — a dead stream never lingers as
// "watched". Missed events with no error signal are bounded by the service's
// periodic full-inventory reconcile, not by this module.

import fs from 'node:fs';
import parcelWatcher from '@parcel/watcher';

export type ParcelEvent = { type: string; path: string };
export type ParcelSubscribe = (
  root: string,
  callback: (err: Error | null, events: ParcelEvent[]) => void,
) => Promise<{ unsubscribe(): Promise<void> }>;

export interface RecursiveWatcher {
  close(): Promise<unknown>;
  /** Attach any configured roots that are not yet watched. Returns true when
   * every root is established or subscribing; false means the caller should
   * retry later. */
  refreshMissingRoots(notify?: boolean): boolean;
}

interface RecursiveWatcherOptions {
  roots: string[];
  filter: (path: string) => boolean;
  onChange: (changedPath?: string) => void;
  subscribe?: ParcelSubscribe;
  logger?: { warn?: (msg: string) => void };
  /** Called when a previously watched (or subscribing) root is lost, e.g. its
   * subscription errored. The caller should schedule a refreshMissingRoots
   * retry. */
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

  const dropRoot = (root: string) => {
    const sub = subscriptions.get(root);
    subscriptions.delete(root);
    pending.delete(root);
    if (sub) void sub.unsubscribe().catch(() => {});
    onRootLost?.(root);
  };

  const addRoot = (root: string): boolean => {
    if (closed || subscriptions.has(root) || pending.has(root)) return false;
    if (!fs.existsSync(root)) return false;
    pending.add(root);
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
      logger.warn?.(`Obelisk watcher failed to subscribe ${root}: ${(error as Error).message}`);
      onRootLost?.(root);
      return false;
    }
    Promise.resolve(result).then((sub) => {
      const wasPending = pending.delete(root);
      if (closed || !wasPending) {
        // The watcher was closed, or the subscription errored while it was
        // still being established (dropRoot already ran) — don't leak it.
        void sub.unsubscribe().catch(() => {});
        return;
      }
      subscriptions.set(root, sub);
    }, (error) => {
      pending.delete(root);
      logger.warn?.(`Obelisk watcher failed to subscribe ${root}: ${(error as Error).message ?? error}`);
      onRootLost?.(root);
    });
    return true;
  };

  const refresh = (notify: boolean): boolean => {
    let added = false;
    for (const root of roots) {
      if (addRoot(root)) added = true;
    }
    if (added && notify) onChange();
    return roots.every((root) => subscriptions.has(root) || pending.has(root));
  };

  // Establish the roots that already exist; late-appearing roots are picked
  // up by the caller's refreshMissingRoots retry loop.
  refresh(false);

  return {
    close() {
      closed = true;
      const subs = [...subscriptions.values()];
      subscriptions.clear();
      return Promise.all(subs.map((sub) => sub.unsubscribe().catch(() => {})));
    },
    refreshMissingRoots(notify = true) {
      return refresh(notify);
    },
  };
}

export { createRecursiveWatcher };
