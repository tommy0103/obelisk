<script setup>
// The 「当时」 sidebars: real session records answering "why isn't this written
// more simply". The book itself calls them footnotes, not the main line — so
// they collapse by default and never interrupt a first read.
//
// The badge is English because it is chrome, not prose; the Chinese term stays
// in the line next to it so the reader can tie it back to what the book calls
// this block.

import { ref } from 'vue';

defineProps({
  source: { type: String, default: '' },
});

const open = ref(false);
</script>

<template>
  <aside class="note" :class="{ open }">
    <button class="head" type="button" :aria-expanded="open" @click="open = !open">
      <span class="badge">THEN</span>
      <span class="what">「当时」· 一段真实的会话记录</span>
      <span class="chev" aria-hidden="true">{{ open ? '收起' : '展开' }}</span>
    </button>
    <div v-show="open" class="body">
      <slot />
    </div>
  </aside>
</template>

<style scoped>
.note {
  margin: 2rem 0;
  border: 1px solid var(--edge);
  border-left: 2px solid var(--amber);
  border-radius: 0 var(--radius) var(--radius) 0;
  background: linear-gradient(90deg, var(--amber-soft), transparent 62%);
  overflow: hidden;
}

.head {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  width: 100%;
  padding: 0.72rem 1rem;
  text-align: left;
}

.badge {
  padding: 0.1em 0.34em 0.1em 0.5em;
  border-radius: 4px;
  background: rgba(245, 158, 11, 0.16);
  font: 700 0.66rem/1.7 var(--mono);
  letter-spacing: 0.16em;
  color: var(--amber);
}

.what {
  flex: 1;
  font-size: 0.84rem;
  color: var(--muted);
}

.chev {
  font: 0.7rem/1.6 var(--mono);
  color: var(--faint);
}

.head:hover .chev {
  color: var(--amber);
}

.body {
  padding: 0.2rem 1.15rem 1rem;
  font-size: 0.945rem;
}

/* Quoted lines inside a sidebar are the actual transcript — give them more
   presence than a generic pull-quote, since they are the evidence. */
.body :deep(blockquote) {
  border-left-color: var(--amber);
  color: var(--fg);
  font-style: italic;
}
</style>
