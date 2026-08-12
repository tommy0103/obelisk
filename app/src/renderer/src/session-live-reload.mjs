// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

export function createSessionLiveReloadCoordinator({ isScrolling, load, commit }) {
  let pending = false;
  let loadedSnapshot = null;
  let inFlight = null;
  let stopped = false;

  async function drain() {
    while (!stopped && (pending || loadedSnapshot)) {
      let snapshot = loadedSnapshot;
      loadedSnapshot = null;

      if (pending) {
        pending = false;
        snapshot = await load();
      }
      if (stopped) return;

      // Scrolling may start while IPC is loading the snapshot. Keep the loaded
      // value, but do not patch the visible timeline until scrolling settles.
      if (isScrolling()) {
        loadedSnapshot = snapshot;
        return;
      }

      // A newer update arrived while this snapshot loaded. Skip the stale
      // intermediate commit and loop once more for the latest snapshot.
      if (pending) continue;
      if (snapshot !== null && snapshot !== undefined) await commit(snapshot);
    }
  }

  async function processPending() {
    if (stopped || (!pending && !loadedSnapshot)) return inFlight;
    // Do not start more IPC/deserialization work during an active wheel
    // gesture. Coalesce notifications and fetch the latest state once.
    if (isScrolling()) return inFlight;
    if (inFlight) return inFlight;
    inFlight = drain();
    try {
      await inFlight;
    } finally {
      inFlight = null;
    }
    if (pending || (loadedSnapshot && !isScrolling())) return processPending();
    return undefined;
  }

  function flush() {
    if (stopped || isScrolling()) return inFlight;
    return processPending();
  }

  return {
    request() {
      if (stopped) return Promise.resolve();
      pending = true;
      return processPending();
    },
    flush,
    stop() {
      stopped = true;
      pending = false;
      loadedSnapshot = null;
    },
  };
}
