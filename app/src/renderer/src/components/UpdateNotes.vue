<!-- Copyright (C) 2026 tommy0103 and contributors. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

<script setup>
import { computed, ref, watch, nextTick, onBeforeUnmount } from 'vue';
import { updateState, notesOpen } from '../updates.js';
import { renderUpdateNotes } from '../update-notes.js';
const dialog = ref(null);
const html = computed(() => renderUpdateNotes(updateState.releaseNotes));
let previousFocus = null;
watch(notesOpen, async open => {
  if (open) {
    previousFocus = document.activeElement;
    await nextTick();
    if (notesOpen.value && dialog.value && !dialog.value.open) dialog.value.showModal();
  } else {
    dialog.value?.close();
    if (previousFocus?.isConnected) previousFocus.focus();
  }
});
onBeforeUnmount(() => { notesOpen.value = false; });
function handleBackdropClick(event) {
  if (event.target !== dialog.value) return;
  const bounds = dialog.value.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) notesOpen.value = false;
}
function handleNotesClick(event) {
  const link = event.target.closest('a');
  if (!link) return;
  event.preventDefault();
  if (link.href.startsWith('https://')) window.open(link.href, '_blank', 'noopener,noreferrer');
}
</script>
<template>
  <dialog ref="dialog" class="update-dialog" aria-labelledby="update-notes-title" @cancel.prevent="notesOpen = false" @close="notesOpen = false" @click="handleBackdropClick">
    <header>
      <div><h2 id="update-notes-title">What’s new</h2><p>Obelisk {{ updateState.version }}</p></div>
      <button class="update-button subtle" type="button" aria-label="Close release notes" @click="notesOpen = false">Close</button>
    </header>
    <div v-if="html" class="update-notes-content" @click="handleNotesClick" v-html="html"></div>
    <p v-else class="update-empty">Release notes aren’t available for this update.</p>
    <footer><button class="update-button" type="button" @click="notesOpen = false">Done</button></footer>
  </dialog>
</template>
<style scoped>
.update-dialog { margin: auto; width: min(560px, calc(100vw - 48px)); max-height: min(640px, calc(100vh - 64px)); border: 1px solid var(--hairline-strong); border-radius: 8px; padding: 24px; background: var(--bg-2); color: var(--fg); }
.update-dialog::backdrop { background: var(--bg); opacity: .75; }
header { display: flex; align-items: start; justify-content: space-between; gap: 16px; padding-bottom: 16px; border-bottom: 1px solid var(--hairline); }
h2 { font-size: var(--text-md); font-weight: 600; }
header p { margin-top: 4px; color: var(--muted); font-family: var(--font-mono); font-size: var(--text-sm); }
.update-notes-content { padding: 20px 0; max-height: calc(100vh - 260px); overflow-y: auto; font-size: var(--text-base); line-height: 1.7; overflow-wrap: anywhere; }
.update-notes-content :deep(p), .update-notes-content :deep(ul), .update-notes-content :deep(ol), .update-notes-content :deep(pre) { margin-bottom: 12px; }
.update-notes-content :deep(ul), .update-notes-content :deep(ol) { padding-left: 20px; }
.update-notes-content :deep(h1), .update-notes-content :deep(h2), .update-notes-content :deep(h3) { font-size: var(--text-md); margin: 12px 0 8px; }
.update-notes-content :deep(code) { font-family: var(--font-mono); font-size: var(--text-sm); background: var(--surface); }
.update-notes-content :deep(pre) { white-space: pre-wrap; padding: 10px; background: var(--surface); border-radius: 5px; }
.update-notes-content :deep(a) { color: var(--fg-2); }
.update-empty { color: var(--muted); padding: 24px 0; font-size: var(--text-sm); }
footer { display: flex; justify-content: flex-end; padding-top: 12px; border-top: 1px solid var(--hairline); }

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
