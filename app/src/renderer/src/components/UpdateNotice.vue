<!-- Copyright (C) 2026 tommy0103 and contributors. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

<script setup>
import { updateState, noticeVisible, updateLabel, notesOpen, dismissUpdate, installUpdate } from '../updates.js';
</script>
<template>
  <section v-if="noticeVisible" class="update-notice" aria-label="App update">
    <div class="update-title" role="status">{{ updateState.phase === 'downloading' ? 'Downloading update' : 'Update ready' }}</div>
    <p class="update-description">{{ updateLabel }}</p>
    <div v-if="updateState.phase === 'downloading'" class="update-progress">
      <progress :value="updateState.progress ?? undefined" max="100" aria-label="Update download progress" />
      <span v-if="updateState.progress != null">{{ Math.round(updateState.progress) }}%</span>
    </div>
    <p v-if="updateState.error" class="update-error" role="alert">{{ updateState.error }}</p>
    <button class="update-link" type="button" @click="notesOpen = true">View changes</button>
    <div class="update-actions">
      <button class="update-button subtle" type="button" :disabled="['preparing', 'installing'].includes(updateState.phase)" @click="dismissUpdate">Later</button>
      <button v-if="updateState.phase !== 'downloading'" class="update-button primary" type="button" :disabled="updateState.phase !== 'ready'" @click="installUpdate">
        {{ updateState.phase === 'preparing' ? 'Preparing…' : updateState.phase === 'installing' ? 'Restarting…' : 'Update & restart' }}
      </button>
    </div>
  </section>
</template>
<style scoped>
.update-notice { position: absolute; bottom: 56px; left: 10px; right: 10px; z-index: 20; display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--hairline-strong); border-radius: 8px; background: var(--bg-2); box-shadow: 0 8px 24px var(--bg); }
.update-title { color: var(--fg); font-size: var(--text-base); font-weight: 600; }
.update-description { color: var(--muted); font-size: var(--text-sm); line-height: 1.5; }
.update-actions { justify-content: flex-end; }

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
