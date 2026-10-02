// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { computed, reactive, ref } from 'vue';

export const updateState = reactive({ revision: -1, phase: 'disabled', version: null,
  currentVersion: '', progress: null, error: null, releaseNotes: '', lastChecked: null });
export const notesOpen = ref(false);
const dismissedVersion = ref(null);
export const updateBusy = computed(() => ['checking', 'downloading', 'preparing', 'installing'].includes(updateState.phase));
export const noticeVisible = computed(() => ['downloading', 'ready', 'preparing', 'installing'].includes(updateState.phase)
  && updateState.version !== dismissedVersion.value);
export const updateLabel = computed(() => {
  switch (updateState.phase) {
    case 'disabled': return 'Updates are available in the installed macOS app.';
    case 'checking': return 'Checking for updates…';
    case 'current': return 'You’re up to date.';
    case 'downloading': return `Downloading Obelisk ${updateState.version}…`;
    case 'ready': return `Obelisk ${updateState.version} is ready to install.`;
    case 'preparing': return 'Finishing index writes before restarting…';
    case 'installing': return 'Installing update and restarting…';
    case 'error': return 'Could not check or download the update.';
    default: return 'Check for a newer version of Obelisk.';
  }
});
function applyState(value) {
  if (value && Number.isInteger(value.revision) && value.revision >= updateState.revision) Object.assign(updateState, value);
}
// Every IPC probe has a deadline. Subscribe before fetching the snapshot, and
// use revisions so a late response cannot overwrite a newer push event.
async function request(work) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('The update request timed out; try again')), 35_000);
    })]);
  } finally { clearTimeout(timer); }
}
export function connectUpdates() {
  if (!window.obelisk?.getUpdateState) return () => {};
  let active = true;
  const unsubscribe = window.obelisk.onUpdateState(value => { if (active) applyState(value); });
  void request(() => window.obelisk.getUpdateState()).then(value => { if (active) applyState(value); }, error => {
    if (active && updateState.revision < 0) Object.assign(updateState, { phase: 'error', error: error.message });
  });
  return () => { active = false; unsubscribe(); };
}
export async function checkUpdates() {
  dismissedVersion.value = null;
  try { applyState(await request(() => window.obelisk.checkForUpdates())); }
  catch (error) { updateState.error = error.message; }
}
export async function installUpdate() {
  if (updateState.phase !== 'ready') return;
  dismissedVersion.value = null;
  try { await request(() => window.obelisk.installUpdate()); }
  catch (error) { updateState.error = error.message; }
}
export function dismissUpdate() { dismissedVersion.value = updateState.version; }
