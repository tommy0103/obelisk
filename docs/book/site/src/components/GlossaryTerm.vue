<script setup>
// A term the book uses as if you already know it. The reader who jumped
// straight to 第 13 章 does not, so the first occurrence in each chapter gets a
// hover card and a pointer back to the chapter that introduces it.

import { ref } from 'vue';
import { RouterLink } from 'vue-router';

import { CHAPTERS } from '@/book/index.js';

const props = defineProps({
  entry: { type: Object, required: true },
  text: { type: String, required: true },
});

const open = ref(false);
const home = CHAPTERS.find((c) => c.slug === props.entry.chapter);
</script>

<template>
  <span
    class="term"
    tabindex="0"
    @mouseenter="open = true"
    @mouseleave="open = false"
    @focus="open = true"
    @blur="open = false"
  >
    {{ text }}
    <transition name="pop">
      <span v-if="open" class="card" role="tooltip">
        <span class="head">
          <b>{{ entry.term }}</b>
          <i>{{ entry.short }}</i>
        </span>
        <span class="def">{{ entry.def }}</span>
        <RouterLink v-if="home" class="go" :to="`/ch/${home.slug}`">
          {{ home.num ? `第 ${home.num} 章` : home.shortTitle }} 讲这个 →
        </RouterLink>
      </span>
    </transition>
  </span>
</template>

<style scoped>
.term {
  position: relative;
  border-bottom: 1px dotted var(--accent-line);
  cursor: help;
  outline: none;
}

.term:hover,
.term:focus-visible {
  border-bottom-style: solid;
  border-bottom-color: var(--accent);
}

.card {
  position: absolute;
  bottom: calc(100% + 0.5rem);
  left: 0;
  z-index: 30;
  display: block;
  width: min(23rem, 76vw);
  padding: 0.7rem 0.85rem 0.75rem;
  border: 1px solid var(--edge-hi);
  border-radius: var(--radius-sm);
  background: var(--bg-lift);
  box-shadow: 0 14px 44px rgba(0, 0, 0, 0.5);
  cursor: auto;
}

.head {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  margin-bottom: 0.3rem;
}

.head b {
  font: 600 0.78rem/1.5 var(--mono);
  color: var(--accent);
}

.head i {
  font: normal 0.7rem/1.5 var(--sans);
  color: var(--dim);
}

.def {
  display: block;
  font: 0.8rem/1.75 var(--sans);
  color: var(--fg-soft);
}

.def :deep(code) {
  font-family: var(--mono);
}

.go {
  display: inline-block;
  margin-top: 0.45rem;
  border: 0;
  font: 0.7rem/1.6 var(--mono);
  color: var(--accent);
}

.go:hover {
  text-decoration: underline;
}

.pop-enter-active {
  transition: opacity 0.12s var(--ease), transform 0.12s var(--ease);
}

.pop-enter-from {
  opacity: 0;
  transform: translateY(3px);
}
</style>
