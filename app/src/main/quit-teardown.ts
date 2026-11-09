// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Deferred quit (#187). Electron does not wait for async before-quit
// handlers, but the watchers' close() must finish before the JS environment
// is torn down: a @parcel/watcher callback firing during CleanupHandles
// throws with no JS frame to catch it, and napi_throw fatals the process.
// The first quit request is prevented and re-issued once the stop settles.
// The wait is bounded so a wedged stop can never make the app unquittable.

interface DeferredQuitOptions {
  quit: () => void;
  stop: () => Promise<unknown> | unknown;
  /** Maximum time to wait for stop() before quitting anyway. */
  boundMs?: number;
}

function createDeferredQuit({ quit, stop, boundMs = 5000 }: DeferredQuitOptions) {
  let quitting = false;
  return (event: { preventDefault(): void }) => {
    // The re-entrant quit we issue below must pass through untouched.
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    const stopped = Promise.resolve(stop()).catch(() => {});
    const bounded = Promise.race([stopped, new Promise(resolve => setTimeout(resolve, boundMs))]);
    void bounded.finally(() => quit());
  };
}

export { createDeferredQuit };
