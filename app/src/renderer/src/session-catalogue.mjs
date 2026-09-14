// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

export const SESSION_PAGE_SIZE = 100;

// Persist list state across detail navigation, independently of the small global
// metadata cache and the active conversation's message snapshots.
export function createSessionCatalogueState() {
  return { rows: [], total: 0, limit: SESSION_PAGE_SIZE, key: null, loading: false, loaded: false, error: '', position: null, showNoise: false };
}

export function createSessionCatalogue({ state, query, capture = () => null, restore = async () => {}, timeoutMs = 15000 }) {
  let options = {};
  let generation = 0;
  let requested = false;
  let inFlight = null;
  let disposed = false;

  async function drain() {
    if (inFlight) return inFlight;
    if (disposed) return;
    const run = async () => {
      state.loading = true;
      try {
        while (requested && !disposed) {
          requested = false;
          const revision = generation;
          const anchor = capture();
          let result;
          let timer;
          try {
            result = await Promise.race([
              query({ ...options, limit: state.limit, anchorId: anchor?.id }),
              new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Session loading timed out')), timeoutMs); }),
            ]);
          } catch (error) {
            if (disposed || revision !== generation) continue;
            state.error = error?.message || 'Could not load sessions';
            break;
          } finally {
            clearTimeout(timer);
          }
          if (disposed || revision !== generation) continue;
          // Capture at commit time: a reader may have scrolled while IPC ran.
          const position = capture();
          if (position?.id && !result.sessions.some(row => row.id === position.id)
              && state.rows.some(row => row.id === position.id)
              && position.id !== anchor?.id) {
            requested = true;
            continue;
          }
          const existing = new Map(state.rows.map(row => [row.id, row]));
          state.rows = result.sessions.map(row => {
            const previous = existing.get(row.id);
            if (!previous) return row;
            Object.assign(previous, row);
            return previous;
          });
          state.total = result.total;
          state.limit = Math.max(state.limit, state.rows.length);
          state.loaded = true;
          state.error = '';
          await restore(position);
        }
      } catch (error) {
        if (!disposed) state.error = error?.message || 'Could not load sessions';
      } finally {
        if (!disposed) state.loading = false;
      }
    };
    inFlight = run();
    try { await inFlight; } finally { inFlight = null; }
  }

  return {
    configure(next) {
      const key = JSON.stringify(next);
      options = next;
      if (key !== state.key) {
        generation++;
        state.key = key;
        state.rows = [];
        state.total = 0;
        state.limit = SESSION_PAGE_SIZE;
        state.loaded = false;
        state.position = null;
      }
      requested = true;
      return drain();
    },
    refresh() { requested = true; return drain(); },
    more() {
      if (state.loading || state.rows.length >= state.total) return Promise.resolve();
      state.limit += SESSION_PAGE_SIZE;
      requested = true;
      return drain();
    },
    dispose() { disposed = true; generation++; state.loading = false; },
  };
}
