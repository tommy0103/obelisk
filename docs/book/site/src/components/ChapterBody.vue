<script setup>
// Lays a chapter out: prose from markdown, interactives spliced in at the
// headings their chapter component quoted, and the book's own 「你应该带走的」
// recap lifted into a card at the end.
//
// An anchor that quotes a heading which no longer exists fails `npm run build`
// (plugins/anchor-check.mjs). Here in the browser it also warns loudly, so a
// widget can never silently vanish during `npm run dev`.

import { computed, provide, watchEffect } from 'vue';

import { GLOSSARY_CTX } from '@/blocks/InlineSpans.js';
import BlockList from '@/blocks/BlockList.vue';
import InteractiveFrame from '@/components/InteractiveFrame.vue';

const props = defineProps({
  chapter: { type: Object, required: true },
  // [{ afterHeading, widget, props?, position?: 'start' | 'end' }]
  anchors: { type: Array, default: () => [] },
});

// One glossary pass per chapter: `seen` is cleared whenever the chapter
// changes, so every chapter annotates each term exactly once, on its first
// occurrence, and never in the chapter that owns the term.
const glossaryCtx = { slug: props.chapter.slug, seen: new Set() };
provide(GLOSSARY_CTX, glossaryCtx);
watchEffect(() => {
  glossaryCtx.slug = props.chapter.slug;
  glossaryCtx.seen.clear();
});

const bodyBlocks = computed(() =>
  props.chapter.recapAt == null
    ? props.chapter.blocks
    : props.chapter.blocks.slice(0, props.chapter.recapAt),
);

const recapBlocks = computed(() =>
  props.chapter.recapAt == null ? null : props.chapter.blocks.slice(props.chapter.recapAt + 1),
);

const recapTitle = computed(() =>
  props.chapter.recapAt == null ? '' : props.chapter.blocks[props.chapter.recapAt].text,
);

// Where a widget lands: by default at the end of the section its heading opens,
// so the reader gets the argument first and the toy second.
function insertionIndex(blocks, anchor) {
  const at = blocks.findIndex((b) => b.t === 'h' && b.text === anchor.afterHeading);
  if (at === -1) return -1;
  if (anchor.position === 'start') return at + 1;
  const level = blocks[at].level;
  let j = at + 1;
  while (j < blocks.length && !(blocks[j].t === 'h' && blocks[j].level <= level)) j++;
  return j;
}

const segments = computed(() => {
  const blocks = bodyBlocks.value;
  const at = new Map();

  for (const anchor of props.anchors) {
    const idx = insertionIndex(blocks, anchor);
    if (idx === -1) {
      console.error(
        `[book] ${props.chapter.file}: afterHeading '${anchor.afterHeading}' matches no heading — widget not rendered`,
      );
      continue;
    }
    if (!at.has(idx)) at.set(idx, []);
    at.get(idx).push(anchor);
  }

  const out = [];
  let cursor = 0;
  for (const idx of [...at.keys()].sort((a, b) => a - b)) {
    if (idx > cursor) out.push({ kind: 'prose', blocks: blocks.slice(cursor, idx) });
    for (const anchor of at.get(idx)) out.push({ kind: 'widget', anchor });
    cursor = idx;
  }
  if (cursor < blocks.length) out.push({ kind: 'prose', blocks: blocks.slice(cursor) });
  return out;
});
</script>

<template>
  <div class="body">
    <template v-for="(seg, i) in segments" :key="i">
      <div v-if="seg.kind === 'prose'" class="prose">
        <BlockList :blocks="seg.blocks" />
      </div>
      <component :is="seg.anchor.widget" v-else-if="!seg.anchor.title" v-bind="seg.anchor.props || {}" />
      <InteractiveFrame
        v-else
        :title="seg.anchor.title"
        :hint="seg.anchor.hint || ''"
        v-bind="seg.anchor.tag ? { tag: seg.anchor.tag } : {}"
      >
        <component :is="seg.anchor.widget" v-bind="seg.anchor.props || {}" />
      </InteractiveFrame>
    </template>

    <section v-if="recapBlocks" class="recap prose">
      <h2 class="recap-title">{{ recapTitle }}</h2>
      <BlockList :blocks="recapBlocks" />
    </section>
  </div>
</template>

<style scoped>
.body {
  display: flow-root;
}

.recap {
  margin-top: 3.4rem;
  padding: 1.4rem 1.6rem 1.6rem;
  border: 1px solid var(--accent-line);
  border-radius: var(--radius);
  background:
    radial-gradient(120% 120% at 100% 0%, rgba(167, 139, 250, 0.09), transparent 58%),
    var(--bg-lift);
}

.recap-title {
  margin-top: 0;
  font-size: 1.05rem;
  color: var(--accent);
}

.recap-title::after {
  display: none;
}

.recap :deep(li) {
  margin: 0.62rem 0;
}
</style>
