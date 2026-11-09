<!-- Copyright (C) 2026 tommy0103 and contributors. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

<script setup>
import { updateState, updateBusy, updateLabel, notesOpen, checkUpdates, installUpdate } from '../updates.js';
</script>
<template>
  <div class="update-panel">
    <p class="update-status" role="status">{{ updateLabel }}</p>
    <div v-if="updateState.phase === 'downloading'" class="update-progress">
      <progress :value="updateState.progress ?? undefined" max="100" aria-label="Update download progress" />
      <span v-if="updateState.progress != null">{{ Math.round(updateState.progress) }}%</span>
    </div>
    <div class="update-actions">
      <button class="update-button" type="button" :disabled="updateBusy || updateState.phase === 'disabled' || updateState.phase === 'ready'" @click="checkUpdates">{{ updateState.phase === 'checking' ? 'Checking…' : 'Check for updates' }}</button>
      <button v-if="updateState.phase === 'ready'" class="update-button primary" type="button" @click="installUpdate">Update & restart</button>
      <button v-if="updateState.version" class="update-link" type="button" @click="notesOpen = true">View changes</button>
    </div>
    <p v-if="updateState.error" class="update-error" role="alert">{{ updateState.error }}</p>
    <p v-if="updateState.lastChecked" class="update-meta">Last checked {{ new Date(updateState.lastChecked).toLocaleString() }}</p>
  </div>
</template>
<style scoped>
.update-panel { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.update-status { color: var(--fg-2); font-size: var(--text-sm); padding-top: 6px; }
.update-meta { color: var(--muted); font-size: var(--text-xs); }

.update-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.update-button { display: inline-flex; align-items: center; justify-content: center; height: 28px; padding: 0 10px; border: 1px solid var(--hairline-strong); border-radius: 5px; background: var(--surface); color: var(--fg-2); font-size: var(--text-sm); font-weight: 500; cursor: pointer; transition: background .12s, color .12s; }
.update-button:hover { background: var(--surface-strong); color: var(--fg); }
.update-button.primary { background: var(--accent-soft); color: var(--accent-2); }
.update-button.subtle { background: transparent; border-color: transparent; color: var(--muted); }
.update-button:disabled { opacity: .4; cursor: default; }
.update-button:focus-visible, .update-link:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.update-link { font-size: var(--text-sm); color: var(--accent-2); cursor: pointer; text-align: left; }
.update-link:hover { text-decoration: underline; }
.update-error { color: var(--danger); font-size: var(--text-sm); line-height: 1.5; overflow-wrap: anywhere; }
.update-progress { display: flex; align-items: center; gap: 8px; font-family: var(--font-mono); font-size: var(--text-xs); color: var(--muted); }
.update-progress progress { width: 100%; height: 4px; accent-color: var(--accent); }
@media (prefers-reduced-motion: reduce) { .update-button { transition: none; } }
</style>
