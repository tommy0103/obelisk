<!-- Copyright (C) 2026 tommy0103 and contributors. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import CoverCard from '../components/recap/CoverCard.vue';
import PathCard from '../components/recap/PathCard.vue';
import VibeCard from '../components/recap/VibeCard.vue';
import WorkflowCard from '../components/recap/WorkflowCard.vue';
import ClosingCard from '../components/recap/ClosingCard.vue';
import { PALETTES, ARCH_KEYS } from '../components/recap/archetypes.js';
import mockJson from '../mock/recap-2026-W24.json';

defineOptions({ name: 'RecapDetail' });

const route = useRoute();
const recapData = ref(mockJson);
const currentArch = ref(mockJson.persona.archetype);
const currentIdx = ref(0);
const recapFilename = computed(() => String(route.params.id || ''));

const palette = computed(() => PALETTES[currentArch.value] || PALETTES.architect);
const CARD_LABELS = ['Cover', 'Path', 'Vibe', 'Workflow', 'Closing'];
const TOTAL = computed(() => recapData.value.cards.length);

const cover = computed(() => recapData.value.cards[0]);
const path = computed(() => recapData.value.cards[1]);
const vibe = computed(() => recapData.value.cards[2]);
const workflow = computed(() => recapData.value.cards[3]);
const closing = computed(() => recapData.value.cards[4]);

const cssVars = computed(() => ({
  '--tc': palette.value.tc,
  '--tc-2': palette.value.tc2,
  '--tg': palette.value.glow,
  '--tg-mid': palette.value.mid,
  '--tg-soft': palette.value.soft,
  '--tg-edge': palette.value.soft,
}));

async function loadRecap(filename) {
  if (!filename || !window.obelisk?.recapRead) return;
  const data = await window.obelisk.recapRead(filename);
  if (data?.cards?.length) {
    recapData.value = data;
    currentArch.value = data.persona?.archetype || 'architect';
    currentIdx.value = 0;
  }
}

let unsubRecap;
onMounted(async () => {
  const filename = route.params.id;
  if (filename) await loadRecap(filename);
  if (window.obelisk?.onRecapUpdated) {
    unsubRecap = window.obelisk.onRecapUpdated((fp) => {
      if (fp.endsWith(route.params.id)) loadRecap(route.params.id);
    });
  }
});
onUnmounted(() => { unsubRecap?.(); });
watch(() => route.params.id, (id) => { if (id) loadRecap(id); });

async function exportImage() {
  await window.obelisk.captureExport({
    cardIdx: currentIdx.value,
    archetype: currentArch.value,
    filename: recapFilename.value,
  });
}
async function copyImage() {
  await window.obelisk.copyImage({
    cardIdx: currentIdx.value,
    archetype: currentArch.value,
    filename: recapFilename.value,
  });
}

function goTo(idx) {
  if (idx >= 0 && idx < TOTAL.value) currentIdx.value = idx;
}
function onKeydown(e) {
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); goTo(currentIdx.value - 1); }
  else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); goTo(currentIdx.value + 1); }
  else if (e.key === 'Home') { e.preventDefault(); goTo(0); }
  else if (e.key === 'End') { e.preventDefault(); goTo(TOTAL.value - 1); }
  else if (e.key === 'p') {
    const i = ARCH_KEYS.indexOf(currentArch.value);
    currentArch.value = ARCH_KEYS[(i + 1) % ARCH_KEYS.length];
  }
}
</script>

<template>
  <div class="recap-app" :style="cssVars" @keydown="onKeydown" tabindex="0">

    <!-- Stage -->
    <div class="stage">
      <div class="deck">
        <div class="card-slot" :class="{ active: currentIdx === 0, prev: currentIdx > 0 }">
          <CoverCard
            :arch-key="currentArch"
            :badge="cover.badge"
            :title="cover.title"
            :claim="cover.claim || cover.subtitle"
            :subtitle="cover.subtitle"
            :activity="cover.activity"
            :footer="cover.footer"
            :idx="1" :total="TOTAL"
          />
        </div>
        <div class="card-slot" :class="{ active: currentIdx === 1, prev: currentIdx > 1 }">
          <PathCard
            :title="path.title"
            :items="path.items"
            :idx="2" :total="TOTAL"
          />
        </div>
        <div class="card-slot" :class="{ active: currentIdx === 2, prev: currentIdx > 2 }">
          <VibeCard
            :title="vibe.title"
            :voice-lines="vibe.voice_lines || vibe.observations"
            :observations="vibe.observations"
            :meter="vibe.meter"
            :quote="vibe.quote"
            :idx="3" :total="TOTAL"
          />
        </div>
        <div class="card-slot" :class="{ active: currentIdx === 3, prev: currentIdx > 3 }">
          <WorkflowCard
            :title="workflow.title"
            :deck="workflow.deck || workflow.summary"
            :summary="workflow.summary"
            :stats="workflow.stats"
            :items="workflow.items"
            :verdict="workflow.verdict"
            :idx="4" :total="TOTAL"
          />
        </div>
        <div class="card-slot" :class="{ active: currentIdx === 4, prev: currentIdx > 4 }">
          <ClosingCard
            :headline="closing.headline"
            :receipts="closing.receipts || closing.stats"
            :stats="closing.stats"
            :most-said-phrase="closing.most_said_phrase"
            :signoff="closing.signoff"
            :idx="5" :total="TOTAL"
          />
        </div>
      </div>
    </div>

    <!-- Nav -->
    <div class="nav">
      <button class="nav-arrow" :disabled="currentIdx === 0" @click="goTo(currentIdx - 1)">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10 4l-4 4 4 4"/>
        </svg>
      </button>

      <div class="nav-dots">
        <button
          v-for="(label, i) in CARD_LABELS" :key="i"
          class="nav-dot" :class="{ active: i === currentIdx }"
          @click="goTo(i)"
        >
          <div class="nav-dot-glyph"></div>
          <div class="nav-dot-label">{{ label }}</div>
        </button>
      </div>

      <button class="nav-arrow" :disabled="currentIdx === TOTAL - 1" @click="goTo(currentIdx + 1)">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 4l4 4-4 4"/>
        </svg>
      </button>

      <div class="nav-actions">
        <button class="nav-action" title="Copy image" @click="copyImage">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="5" y="5" width="9" height="9" rx="1.5"/>
            <path d="M5 11H3.5A1.5 1.5 0 0 1 2 9.5v-7A1.5 1.5 0 0 1 3.5 1h7A1.5 1.5 0 0 1 12 2.5V5"/>
          </svg>
        </button>
        <button class="nav-action" title="Export PNG" @click="exportImage">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8 2v8M5 7l3 3 3-3"/>
            <path d="M3 12v1.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V12"/>
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.recap-app {
  --bg: #0a0b14;
  --bg-2: #11131f;
  --surface: rgba(255,255,255,0.03);
  --surface-strong: rgba(255,255,255,0.06);
  --surface-hi: rgba(255,255,255,0.09);
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

  height: 100%;
  display: grid;
  grid-template-rows: 1fr 64px;
  color: var(--fg);
  font: 13px/1.45 var(--font-sans);
  -webkit-font-smoothing: antialiased;
  background-color: var(--bg);
  background-image:
    radial-gradient(80% 60% at 100% 0%, rgba(236, 72, 153, 0.10), transparent 55%),
    radial-gradient(60% 50% at 50% 40%, rgba(167, 139, 250, 0.08), transparent 60%),
    radial-gradient(70% 60% at 0% 100%, rgba(99, 102, 241, 0.10), transparent 60%),
    linear-gradient(to bottom, var(--bg) 0%, var(--bg-2) 100%);
  position: relative;
  outline: none;
}
.recap-app::before {
  content: '';
  position: absolute; inset: 0;
  pointer-events: none; z-index: 0;
  opacity: 0.3;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.05 0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>");
  mix-blend-mode: overlay;
}

/* Stage */
.stage {
  position: relative; overflow: hidden;
  display: flex; align-items: center; justify-content: center;
  padding: 32px 24px; z-index: 1;
}
.deck {
  position: relative; width: 100%; max-width: 540px;
  height: 100%; perspective: 2000px;
}
.card-slot {
  position: absolute; inset: 0;
  opacity: 0; transform: translateY(24px) scale(0.97);
  pointer-events: none;
  transition: opacity var(--transition), transform var(--transition);
}
.card-slot.active {
  opacity: 1; transform: translateY(0) scale(1);
  pointer-events: auto; z-index: 2;
}
.card-slot.prev {
  opacity: 0; transform: translateY(-12px) scale(1.02);
}

/* Nav */
.nav {
  display: flex; align-items: center; justify-content: center; gap: 16px;
  padding: 0 22px;
  border-top: 1px solid var(--hairline);
  background: rgba(0,0,0,0.18);
  backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
  position: relative; z-index: 1;
}
.nav-arrow {
  width: 36px; height: 36px; border-radius: 50%;
  border: 1px solid var(--hairline-strong); background: var(--surface);
  color: var(--fg-2); display: grid; place-items: center;
  cursor: pointer; transition: all var(--transition-fast);
}
.nav-arrow:hover:not(:disabled) { background: var(--surface-strong); color: var(--fg); border-color: var(--hairline-vivid); }
.nav-arrow:disabled { cursor: default; opacity: 0.3; }
.nav-arrow svg { width: 14px; height: 14px; }

.nav-dots { display: flex; gap: 8px; padding: 0 4px; }
.nav-dot {
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  cursor: pointer; padding: 4px 8px; border-radius: 4px;
  background: none; border: none; color: inherit;
  transition: background var(--transition-fast);
}
.nav-dot:hover { background: var(--surface); }
.nav-dot-glyph {
  width: 24px; height: 3px; border-radius: 2px;
  background: var(--muted-3); transition: all var(--transition);
}
.nav-dot.active .nav-dot-glyph {
  background: var(--tc); box-shadow: 0 0 8px var(--tg); width: 28px;
  transition: background var(--theme-ease), box-shadow var(--theme-ease), width var(--transition);
}
.nav-dot-label {
  font-family: var(--font-serif); font-style: italic;
  font-size: 11px; color: var(--muted-2);
}
.nav-dot.active .nav-dot-label { color: var(--fg-2); }

.nav-actions {
  position: absolute; right: 60px;
  display: flex; gap: 6px; align-items: center;
}
.nav-action {
  width: 32px; height: 32px; border-radius: 6px;
  border: 1px solid var(--hairline-strong); background: var(--surface);
  color: var(--fg-2); display: grid; place-items: center;
  cursor: pointer; transition: all var(--transition-fast);
}
.nav-action:hover { background: var(--surface-strong); color: var(--fg); border-color: var(--hairline-vivid); }
.nav-action svg { width: 14px; height: 14px; }
</style>
