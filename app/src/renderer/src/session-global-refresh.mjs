// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Keeps global catalogue snapshots out of the active SessionDetail view.
 * SessionDetail receives its own incremental stream; the catalogue is an
 * eventually-consistent projection that can catch up after the route exits.
 */
export function createGlobalDataRefreshCoordinator({ isDeferred, load, commit }) {
  let dirty = false;
  let inFlight = null;
  let fetchedSnapshot = null;
  let hasFetchedSnapshot = false;

  async function commitOrRetain(snapshot) {
    try {
      await commit(snapshot);
    } catch (error) {
      fetchedSnapshot = snapshot;
      hasFetchedSnapshot = true;
      throw error;
    }
  }

  async function process({ allowDeferred = false } = {}) {
    let mayCommitWhileDeferred = allowDeferred;
    while (dirty || hasFetchedSnapshot) {
      if (!mayCommitWhileDeferred && isDeferred()) return;

      let snapshot;
      if (dirty) {
        dirty = false;
        fetchedSnapshot = null;
        hasFetchedSnapshot = false;
        try {
          snapshot = await load();
        } catch (error) {
          dirty = true;
          throw error;
        }

        if (mayCommitWhileDeferred) {
          await commitOrRetain(snapshot);
          mayCommitWhileDeferred = false;
          continue;
        }

        // A newer invalidation supersedes the snapshot that just loaded.
        if (dirty) continue;
        if (isDeferred()) {
          fetchedSnapshot = snapshot;
          hasFetchedSnapshot = true;
          return;
        }
      } else {
        snapshot = fetchedSnapshot;
        fetchedSnapshot = null;
        hasFetchedSnapshot = false;
      }

      await commitOrRetain(snapshot);
    }
  }

  function drain(options) {
    if (inFlight) return inFlight;
    if (!options?.allowDeferred && isDeferred()) return Promise.resolve();
    if (!dirty && !hasFetchedSnapshot) return Promise.resolve();
    const operation = process(options);
    inFlight = operation;
    return operation.finally(() => {
      if (inFlight === operation) inFlight = null;
    });
  }

  return {
    invalidate() {
      dirty = true;
      return drain();
    },
    flush() {
      return drain();
    },
    initialize() {
      dirty = true;
      return drain({ allowDeferred: true });
    },
  };
}
