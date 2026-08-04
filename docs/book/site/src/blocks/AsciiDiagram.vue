<script setup>
// ASCII diagrams (```text fences). The book leans on them heavily and most of
// them are better as monospace than as vector art — but a 20-line diagram is
// hard to read all at once, so hovering a line dims the rest.
//
// The eight structural diagrams that carry real architecture (module map,
// dependency direction, the two orthogonal axes, …) are replaced by their own
// SVG interactives at the chapter level; this component renders the rest.

import { computed, ref } from 'vue';

const props = defineProps({
  raw: { type: String, required: true },
});

const lines = computed(() => props.raw.split('\n'));
const active = ref(-1);
const copied = ref(false);

async function copy() {
  try {
    await navigator.clipboard.writeText(props.raw);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1400);
  } catch {
    // No clipboard available; the text is still selectable.
  }
}
</script>

<template>
  <figure class="code-face diagram" :class="{ focusing: active !== -1 }" @mouseleave="active = -1">
    <pre><span
      v-for="(line, i) in lines"
      :key="i"
      class="row"
      :class="{ on: active === i, blank: !line.trim() }"
      @mouseenter="active = i"
    >{{ line || ' ' }}</span></pre>
    <button class="copy" :class="{ done: copied }" type="button" @click="copy">
      {{ copied ? '已复制' : '复制' }}
    </button>
  </figure>
</template>

<style scoped>
.diagram {
  position: relative;
  margin: 1.7rem 0;
  padding: 1.05rem 0.4rem 1.15rem;
  border: 1px solid var(--edge);
  border-radius: var(--radius);
  background:
    linear-gradient(var(--bg-sunk), var(--bg-sunk)) padding-box,
    linear-gradient(160deg, var(--accent-line), transparent 45%) border-box;
  border-color: transparent;
  overflow: hidden;
}

pre {
  margin: 0;
  overflow-x: auto;
  font: inherit;
  color: var(--fg-soft);
}

.row {
  display: block;
  padding: 0 1.05rem;
  white-space: pre;
  transition: opacity 0.14s var(--ease), background-color 0.14s var(--ease);
}

.focusing .row {
  opacity: 0.34;
}

.focusing .row.on {
  opacity: 1;
  background: var(--accent-soft);
}

/* Blank spacer lines should not become hover targets that fight the eye. */
.row.blank {
  pointer-events: none;
}

.focusing .row.blank {
  opacity: 0.34;
}

.copy {
  position: absolute;
  top: 0.5rem;
  right: 0.6rem;
  padding: 0.16rem 0.55rem;
  border-radius: 5px;
  font: 0.66rem/1.6 var(--mono);
  color: var(--faint);
  background: var(--bg-sunk);
  opacity: 0;
  transition: opacity 0.15s var(--ease), color 0.15s var(--ease);
}

.diagram:hover .copy,
.copy:focus-visible {
  opacity: 1;
}

.copy:hover {
  color: var(--fg);
}

.copy.done {
  opacity: 1;
  color: var(--green);
}
</style>
