// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import type { UpdateBackend, UpdateEvent, UpdateState } from '../shared/update-types.ts';

function stableParts(version: unknown): number[] | null {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) return null;
  const parts = version.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}
export function isNewerStable(version: unknown, current: string): boolean {
  const next = stableParts(version), previous = stableParts(current);
  if (!next || !previous) return false;
  for (let i = 0; i < 3; i++) {
    if (next[i] !== previous[i]) return next[i] > previous[i];
  }
  return false;
}
export function createUpdateService({ enabled, version, createBackend, prepare, recover, publish,
  checkTimeoutMs = 30_000, downloadTimeoutMs = 300_000, pollMs = 1_800_000 }: {
  enabled: boolean;
  version: string;
  createBackend: (receive: (event: UpdateEvent) => void) => Promise<UpdateBackend>;
  prepare: () => Promise<void>;
  recover: () => Promise<void>;
  publish: (state: UpdateState) => void;
  checkTimeoutMs?: number;
  downloadTimeoutMs?: number;
  pollMs?: number;
}) {
  let state: UpdateState = { revision: 0, phase: enabled ? 'idle' : 'disabled', backend: null,
    currentVersion: version, version: null, releaseNotes: '', progress: null, error: null, lastChecked: null };
  let backend: UpdateBackend | null = null;
  let starting: Promise<void> | null = null;
  let installing: Promise<void> | null = null;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  function change(patch: Partial<UpdateState>) {
    state = { ...state, ...patch, revision: state.revision + 1 };
    publish({ ...state });
  }
  function fail(message: string) {
    clearTimeout(deadline);
    if (state.phase === 'preparing') return; // cleanup owns its failure/recovery
    if (state.phase === 'installing') {
      void recover().then(() => change({ phase: 'ready', error: message }), error => {
        change({ phase: 'ready', error: `${message}; ${String(error)}` });
      });
    } else change({ phase: state.phase === 'ready' ? 'ready' : 'error', error: message, progress: null });
  }
  function armTimeout(ms: number, message: string) {
    clearTimeout(deadline);
    deadline = setTimeout(() => fail(message), ms);
    deadline.unref?.();
  }
  function receive(event: UpdateEvent) {
    if (stopped) return;
    if (event.type === 'error') { fail((event.message || 'Update failed').slice(0, 1000)); return; }
    if (['preparing', 'installing', 'ready'].includes(state.phase)) return;
    if (event.type === 'checking') {
      if (state.phase === 'downloading') return;
      change({ phase: 'checking', error: null });
      armTimeout(checkTimeoutMs, 'Checking for updates timed out; try again');
    } else if (event.type === 'available' || event.type === 'downloaded') {
      if (!isNewerStable(event.version, version)) {
        fail('The update is not a newer stable version');
        return;
      }
      if (state.phase === 'downloading' && state.version !== event.version) return;
      change({ phase: event.type === 'downloaded' ? 'ready' : 'downloading',
        version: event.version!, releaseNotes: (event.releaseNotes || state.releaseNotes).slice(0, 65_536),
        progress: event.type === 'downloaded' ? 100 : null, error: null, lastChecked: new Date().toISOString() });
      if (event.type === 'downloaded') clearTimeout(deadline);
      else armTimeout(downloadTimeoutMs, 'Downloading the update stalled; try again');
    } else if (event.type === 'progress' && state.phase === 'downloading') {
      change({ progress: Number.isFinite(event.percent) ? Math.min(100, Math.max(0, event.percent!)) : null });
      armTimeout(downloadTimeoutMs, 'Downloading the update stalled; try again');
    } else if (event.type === 'current' && state.phase !== 'downloading') {
      clearTimeout(deadline);
      change({ phase: 'current', error: null, version: null, releaseNotes: '', progress: null, lastChecked: new Date().toISOString() });
    }
  }
  function start(): Promise<void> {
    if (!enabled || stopped) return Promise.resolve();
    if (starting) return starting;
    starting = (async () => {
      try {
        backend = await createBackend(receive);
        if (stopped) { backend.stop(); return; }
        change({ backend: backend.kind });
        // Sparkle schedules its own checks. Only the fallback needs a JS timer.
        if (backend.kind === 'electron-updater') {
          poll = setInterval(() => { void check(); }, pollMs);
          poll.unref?.();
        }
      } catch (error) {
        change({ phase: 'error', error: error instanceof Error ? error.message : String(error) });
        starting = null;
      }
    })();
    void starting.then(() => { if (!backend) starting = null; });
    return starting;
  }
  async function check() {
    if (!enabled || stopped) return { ...state };
    await start();
    if (!backend || ['checking', 'downloading', 'ready', 'preparing', 'installing'].includes(state.phase)) return { ...state };
    receive({ type: 'checking' });
    try { await backend.check(); } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    return { ...state };
  }
  function install(): Promise<void> {
    if (installing) return installing;
    if (state.phase !== 'ready' || !backend) return Promise.reject(new Error('No downloaded update is ready to install'));
    change({ phase: 'preparing', error: null });
    installing = (async () => {
      let prepared = false;
      try {
        await prepare();
        prepared = true;
        if (stopped) { await recover(); return; }
        change({ phase: 'installing' });
        await backend!.install();
      } catch (error) {
        if (prepared) await recover();
        change({ phase: 'ready', error: error instanceof Error ? error.message : String(error) });
      } finally { installing = null; }
    })();
    return installing;
  }
  function stop() {
    stopped = true;
    clearTimeout(deadline);
    clearInterval(poll);
    backend?.stop();
  }
  return { start, check, install, stop, getState: () => ({ ...state }) };
}
