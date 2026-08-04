<script setup>
// The rail minimap.
//
// Each chapter declares the modules it covers (src/book/manifest.js). The map
// lights those up while you are in the chapter, and keeps a dimmer mark on
// everything your read chapters have already covered — so by the last chapter
// the whole map has been lit once, and you can see which corners you skipped.

import { computed } from 'vue';

import { CHAPTERS } from '@/book/index.js';
import { NODES } from '@/book/modules.js';
import { progress } from '@/book/progress.js';

import SystemMap from '@/interactives/SystemMap.vue';

const props = defineProps({
  slug: { type: String, default: '' },
});

const chapter = computed(() => CHAPTERS.find((c) => c.slug === props.slug) || null);
const lit = computed(() => chapter.value?.covers || []);

const everCovered = computed(() => {
  const seen = new Set();
  for (const c of CHAPTERS) {
    if (progress.read[c.slug]) for (const id of c.covers) seen.add(id);
  }
  return seen;
});

const coverage = computed(() => `${everCovered.value.size} / ${NODES.length}`);
</script>

<template>
  <div class="mini">
    <SystemMap
      :lit="lit"
      compact
      :interactive="false"
      :show-legend="false"
      mode="flow"
    />
    <p class="cap">
      <span v-if="chapter">这一章覆盖 {{ lit.length }} 个部件</span>
      <span v-else>模块地图</span>
      <span class="cov">已点亮 {{ coverage }}</span>
    </p>
  </div>
</template>

<style scoped>
.mini {
  padding: 0.55rem 0.6rem 0.5rem;
  border: 1px solid var(--edge);
  border-radius: var(--radius-sm);
  background: var(--bg-sunk);
}

.cap {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.4rem;
  font: 0.63rem/1.6 var(--mono);
  color: var(--faint);
}

.cov {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}
</style>
