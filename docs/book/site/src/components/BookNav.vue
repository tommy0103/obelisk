<script setup>
// The rail: where you are, what is left, and one click to anywhere.

import { computed } from 'vue';
import { useRoute, RouterLink } from 'vue-router';

import { CHAPTERS, SECTIONS, TOTAL_MINUTES } from '@/book/index.js';
import { progress } from '@/book/progress.js';

import MiniMap from './MiniMap.vue';

defineProps({
  open: { type: Boolean, default: false },
});

const emit = defineEmits(['close', 'palette']);

const route = useRoute();
const slug = computed(() => (route.name === 'chapter' ? route.params.slug : ''));

const readCount = computed(() => CHAPTERS.filter((c) => progress.read[c.slug]).length);
const pct = computed(() => Math.round((readCount.value / CHAPTERS.length) * 100));

const current = computed(() => CHAPTERS.find((c) => c.slug === slug.value) || null);
</script>

<template>
  <nav class="rail" :class="{ open }">
    <div class="brand">
      <RouterLink to="/" class="mark" @click="emit('close')">
        <span class="glyph" aria-hidden="true">▮</span>
        <span class="names">
          <b>Obelisk 架构解读</b>
          <i>给 coding agent 造一层可查询的记忆</i>
        </span>
      </RouterLink>
    </div>

    <button class="search" type="button" @click="emit('palette')">
      <span>搜索全书</span>
      <span class="keys"><span class="kbd">⌘</span><span class="kbd">K</span></span>
    </button>

    <div class="progress">
      <div class="track"><div class="fill" :style="{ width: `${pct}%` }" /></div>
      <span>{{ readCount }} / {{ CHAPTERS.length }} 章 · 全书约 {{ TOTAL_MINUTES }} 分钟</span>
    </div>

    <MiniMap :slug="slug" />

    <div class="toc">
      <section v-for="sec in SECTIONS" :key="sec.key">
        <h6>{{ sec.label }}</h6>
        <RouterLink
          v-for="c in sec.chapters"
          :key="c.slug"
          class="item"
          :class="{ on: c.slug === slug, read: progress.read[c.slug] }"
          :to="`/ch/${c.slug}`"
          @click="emit('close')"
        >
          <span class="num">{{ c.num || (c.kind === 'front' ? '·' : 'A') }}</span>
          <span class="title">{{ c.shortTitle }}</span>
          <span v-if="progress.read[c.slug]" class="tick" aria-label="已读">✓</span>
        </RouterLink>
      </section>

      <RouterLink class="item map-link" to="/map" :class="{ on: route.name === 'map' }" @click="emit('close')">
        <span class="num">◎</span>
        <span class="title">完整模块地图</span>
      </RouterLink>
    </div>

    <div v-if="current" class="here">
      <span class="here-label">当前</span>
      <p>{{ current.hook }}</p>
    </div>
  </nav>
</template>

<style scoped>
.rail {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  width: var(--rail);
  height: 100vh;
  padding: 1.1rem 0.85rem 1.4rem 1.1rem;
  border-right: 1px solid var(--edge);
  background: rgba(10, 11, 20, 0.72);
  backdrop-filter: blur(14px);
  overflow-y: auto;
  overscroll-behavior: contain;
}

.mark {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  border: 0;
}

.glyph {
  margin-top: 0.15rem;
  font-size: 0.9rem;
  color: var(--accent);
}

.names b {
  display: block;
  font: 600 0.9rem/1.4 var(--serif);
  color: var(--fg);
  letter-spacing: 0.01em;
}

.names i {
  display: block;
  margin-top: 0.1rem;
  font: normal 0.7rem/1.5 var(--sans);
  color: var(--faint);
}

.search {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.36rem 0.5rem 0.36rem 0.65rem;
  border: 1px solid var(--edge);
  border-radius: var(--radius-sm);
  font: 0.76rem/1.6 var(--sans);
  color: var(--faint);
  transition: all 0.15s var(--ease);
}

.search:hover {
  border-color: var(--edge-hi);
  color: var(--fg);
}

.keys {
  display: flex;
  gap: 0.15rem;
  margin-left: auto;
}

.progress .track {
  height: 2px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.07);
  overflow: hidden;
}

.progress .fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent-deep), var(--pink));
  transition: width 0.4s var(--ease);
}

.progress span {
  display: block;
  margin-top: 0.35rem;
  font: 0.65rem/1.6 var(--mono);
  color: var(--faint);
}

.toc section {
  margin-bottom: 0.8rem;
}

h6 {
  padding: 0 0 0.3rem 0.15rem;
  font: 600 0.62rem/1.7 var(--mono);
  letter-spacing: 0.14em;
  color: var(--faint);
}

.item {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  padding: 0.26rem 0.4rem 0.26rem 0.3rem;
  border: 0;
  border-radius: 5px;
  color: var(--muted);
  transition: all 0.13s var(--ease);
}

.item:hover {
  background: rgba(255, 255, 255, 0.035);
  color: var(--fg);
}

.item.on {
  background: var(--accent-soft);
  color: var(--accent);
}

.num {
  flex: none;
  width: 1.1rem;
  text-align: right;
  font: 0.66rem/1.6 var(--mono);
  color: var(--faint);
  font-variant-numeric: tabular-nums;
}

.item.on .num {
  color: var(--accent);
}

.title {
  flex: 1;
  font-size: 0.79rem;
  line-height: 1.5;
}

.item.read .title {
  color: inherit;
}

.tick {
  font-size: 0.62rem;
  color: var(--green);
}

.map-link {
  margin-top: 0.2rem;
  border-top: 1px solid var(--edge);
  padding-top: 0.5rem;
  border-radius: 0;
}

.here {
  margin-top: auto;
  padding: 0.6rem 0.7rem;
  border-left: 2px solid var(--accent-line);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  background: rgba(167, 139, 250, 0.05);
}

.here-label {
  font: 600 0.6rem/1.7 var(--mono);
  letter-spacing: 0.14em;
  color: var(--faint);
}

.here p {
  margin-top: 0.15rem;
  font-size: 0.75rem;
  line-height: 1.65;
  color: var(--muted);
}

@media (max-width: 1080px) {
  .rail {
    position: fixed;
    inset: 0 auto 0 0;
    z-index: 40;
    transform: translateX(-100%);
    transition: transform 0.22s var(--ease);
    box-shadow: 0 0 60px rgba(0, 0, 0, 0.5);
    background: var(--bg);
  }

  .rail.open {
    transform: none;
  }
}
</style>
