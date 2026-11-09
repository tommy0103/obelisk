<!-- Copyright (C) 2026 tommy0103 and contributors. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import CoverCard from '../components/recap/CoverCard.vue';
import PathCard from '../components/recap/PathCard.vue';
import VibeCard from '../components/recap/VibeCard.vue';
import WorkflowCard from '../components/recap/WorkflowCard.vue';
import ClosingCard from '../components/recap/ClosingCard.vue';
import { PALETTES, ARCH_KEYS } from '../components/recap/archetypes.js';
import recapJson from '../mock/recap-2026-W24.json';

const route = useRoute();
const recapData = ref(recapJson);
window.__OBELISK_RECAP_EXPORT_READY__ = false;
const cardIdx = computed(() => parseInt(route.query.card) || 0);
const exportFilename = computed(() => typeof route.query.file === 'string' ? route.query.file : '');
const archKey = computed(() => route.query.arch || recapData.value.persona?.archetype || recapJson.persona.archetype);
const palette = computed(() => PALETTES[archKey.value] || PALETTES.architect);
const total = computed(() => recapData.value.cards?.length || 5);

const cover = computed(() => recapData.value.cards?.[0] || recapJson.cards[0]);
const path = computed(() => recapData.value.cards?.[1] || recapJson.cards[1]);
const vibe = computed(() => recapData.value.cards?.[2] || recapJson.cards[2]);
const workflow = computed(() => recapData.value.cards?.[3] || recapJson.cards[3]);
const closing = computed(() => recapData.value.cards?.[4] || recapJson.cards[4]);

const cssVars = computed(() => ({
  '--tc': palette.value.tc,
  '--tc-2': palette.value.tc2,
  '--tg': palette.value.glow,
  '--tg-mid': palette.value.mid,
  '--tg-soft': palette.value.soft,
  '--tg-edge': palette.value.soft,
}));

function setExportReady(value) {
  window.__OBELISK_RECAP_EXPORT_READY__ = value;
}

async function markExportReady() {
  await nextTick();
  await new Promise(resolve => requestAnimationFrame(() => resolve()));
  setExportReady(true);
}

let loadSeq = 0;
async function loadExportRecap(filename) {
  const seq = ++loadSeq;
  setExportReady(false);
  try {
    if (filename && window.obelisk?.recapRead) {
      const data = await window.obelisk.recapRead(filename);
      if (seq === loadSeq && data?.cards?.length) {
        recapData.value = data;
      } else if (seq === loadSeq) {
        recapData.value = recapJson;
      }
    } else if (seq === loadSeq) {
      recapData.value = recapJson;
    }
  } finally {
    if (seq === loadSeq) await markExportReady();
  }
}

onMounted(() => loadExportRecap(exportFilename.value));
watch(exportFilename, (filename) => loadExportRecap(filename));
</script>

<template>
  <div class="export-wrap" :style="cssVars">
    <CoverCard v-if="cardIdx === 0"
      :arch-key="archKey" :badge="cover.badge" :title="cover.title"
      :claim="cover.claim || cover.subtitle"
      :subtitle="cover.subtitle" :activity="cover.activity" :footer="cover.footer"
      :idx="1" :total="total"
    />
    <PathCard v-else-if="cardIdx === 1"
      :title="path.title" :items="path.items"
      :idx="2" :total="total"
    />
    <VibeCard v-else-if="cardIdx === 2"
      :title="vibe.title" :voice-lines="vibe.voice_lines || vibe.observations"
      :observations="vibe.observations"
      :meter="vibe.meter" :quote="vibe.quote"
      :idx="3" :total="total"
    />
    <WorkflowCard v-else-if="cardIdx === 3"
      :title="workflow.title" :deck="workflow.deck || workflow.summary"
      :summary="workflow.summary"
      :stats="workflow.stats" :items="workflow.items" :verdict="workflow.verdict"
      :idx="4" :total="total"
    />
    <ClosingCard v-else-if="cardIdx === 4"
      :headline="closing.headline" :receipts="closing.receipts || closing.stats"
      :stats="closing.stats"
      :most-said-phrase="closing.most_said_phrase" :signoff="closing.signoff"
      :idx="5" :total="total"
    />
  </div>
</template>

<style scoped>
.export-wrap {
  --bg: #0a0b14;
  --bg-2: #11131f;
  --surface: rgba(255,255,255,0.03);
  --surface-strong: rgba(255,255,255,0.06);
  --fg: rgba(255,255,255,0.94);
  --fg-2: rgba(255,255,255,0.74);
  --fg-3: rgba(255,255,255,0.55);
  --muted: rgba(255,255,255,0.48);
  --muted-2: rgba(255,255,255,0.28);
  --muted-3: rgba(255,255,255,0.16);
  --hairline: rgba(255,255,255,0.05);
  --hairline-strong: rgba(255,255,255,0.10);
  --hairline-vivid: rgba(255,255,255,0.16);
  --font-sans: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', system-ui, sans-serif;
  --font-mono: ui-monospace, 'JetBrains Mono', 'IBM Plex Mono', 'SF Mono', Menlo, monospace;
  --font-serif: 'Iowan Old Style', 'Charter', 'Source Serif Pro', Georgia, serif;
  --transition: 220ms cubic-bezier(0.22, 1, 0.36, 1);
  --transition-fast: 120ms ease;
  --theme-ease: 380ms cubic-bezier(0.22, 1, 0.36, 1);

  width: 540px;
  height: 675px;
  position: relative;
  background: var(--bg);
  color: var(--fg);
  font: 13px/1.45 var(--font-sans);
  -webkit-font-smoothing: antialiased;
  overflow: hidden;
}
</style>
