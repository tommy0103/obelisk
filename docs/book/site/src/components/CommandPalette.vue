<script setup>
// ⌘K over the whole book — chapters, headings, body text, code and glossary.
// The index is built in the browser from the same block trees the pages render,
// so a hit always lands somewhere that actually exists.

import { computed, nextTick, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import { runSearch } from '@/book/searchIndex.js';

const props = defineProps({
  open: { type: Boolean, required: true },
});
const emit = defineEmits(['close']);

const router = useRouter();
const query = ref('');
const cursor = ref(0);
const input = ref(null);

const results = computed(() => (query.value ? runSearch(query.value) : []));

// Result-kind chips are English for the same reason the block badges are: they
// label the kind of thing, not its content.
const KIND_LABEL = { chapter: 'CH', heading: 'SEC', term: 'TERM', code: 'CODE', text: 'TEXT' };

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    query.value = '';
    cursor.value = 0;
    await nextTick();
    input.value?.focus();
  },
);

watch(results, () => (cursor.value = 0));

function go(hit) {
  if (!hit) return;
  router.push(hit.anchor ? `/ch/${hit.slug}#${hit.anchor}` : `/ch/${hit.slug}`);
  emit('close');
}

function onKey(event) {
  if (event.key === 'Escape') return emit('close');
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    cursor.value = Math.min(results.value.length - 1, cursor.value + 1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    cursor.value = Math.max(0, cursor.value - 1);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    go(results.value[cursor.value]);
  }
}
</script>

<template>
  <transition name="pal">
    <div v-if="open" class="scrim" @click.self="emit('close')">
      <div class="palette" role="dialog" aria-label="搜索全书">
        <input
          ref="input"
          v-model="query"
          class="q"
          type="text"
          placeholder="搜章节、标题、正文、代码、术语…"
          spellcheck="false"
          @keydown="onKey"
        />

        <ul v-if="results.length" class="hits">
          <li
            v-for="(hit, i) in results"
            :key="`${hit.slug}-${hit.anchor}-${i}`"
            :class="{ on: i === cursor }"
            @mouseenter="cursor = i"
            @click="go(hit)"
          >
            <span class="kind" :class="hit.kind">{{ KIND_LABEL[hit.kind] }}</span>
            <span class="body">
              <span class="label">{{ hit.label }}</span>
              <span class="detail">{{ hit.detail }}</span>
            </span>
          </li>
        </ul>

        <p v-else-if="query" class="empty">没有命中。试试「租约」「countMode」「幽灵行」。</p>
        <p v-else class="empty">
          全书 17 篇都在索引里。
          <span class="kbd">↑</span><span class="kbd">↓</span> 选择 ·
          <span class="kbd">↵</span> 跳转 · <span class="kbd">esc</span> 关闭
        </p>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  justify-content: center;
  padding: 8vh 1rem 2rem;
  background: rgba(4, 5, 10, 0.72);
  backdrop-filter: blur(4px);
}

.palette {
  display: flex;
  flex-direction: column;
  width: min(42rem, 100%);
  max-height: 74vh;
  border: 1px solid var(--edge-hi);
  border-radius: var(--radius);
  background: var(--bg-lift);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.55);
  overflow: hidden;
}

.q {
  padding: 0.95rem 1.1rem;
  border: 0;
  border-bottom: 1px solid var(--edge);
  background: none;
  font: 0.95rem/1.6 var(--sans);
  color: var(--fg);
  outline: none;
}

.q::placeholder {
  color: var(--dim);
}

.hits {
  margin: 0;
  padding: 0.35rem;
  list-style: none;
  overflow-y: auto;
}

.hits li {
  display: flex;
  gap: 0.6rem;
  padding: 0.42rem 0.6rem;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.hits li.on {
  background: var(--accent-soft);
}

.kind {
  flex: none;
  width: 2.8rem;
  padding: 0.05em 0;
  border: 1px solid var(--edge);
  border-radius: 4px;
  font: 600 0.6rem/1.8 var(--mono);
  letter-spacing: 0.1em;
  text-align: center;
  color: var(--faint);
  height: fit-content;
}

.kind.chapter,
.kind.heading {
  border-color: var(--accent-line);
  color: var(--accent);
}

.kind.term {
  border-color: rgba(110, 231, 183, 0.4);
  color: var(--green);
}

.body {
  min-width: 0;
}

.label {
  display: block;
  font-size: 0.82rem;
  line-height: 1.55;
  color: var(--fg-soft);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.detail {
  display: block;
  font: 0.66rem/1.6 var(--mono);
  color: var(--faint);
}

.empty {
  padding: 1.3rem 1.1rem;
  font-size: 0.83rem;
  line-height: 1.9;
  color: var(--faint);
}

.pal-enter-active,
.pal-leave-active {
  transition: opacity 0.14s var(--ease);
}

.pal-enter-from,
.pal-leave-to {
  opacity: 0;
}
</style>
