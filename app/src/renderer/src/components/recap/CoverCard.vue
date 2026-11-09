<!-- Copyright (C) 2026 tommy0103 and contributors. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

<script setup>
import { computed } from 'vue';
import { CORNER_SEALS } from './seals.js';

const props = defineProps({
  archKey: String,
  badge: String,
  title: String,
  claim: String,
  subtitle: String,
  activity: Array,
  footer: String,
  idx: { type: Number, default: 1 },
  total: { type: Number, default: 5 },
});

const sealSvg = computed(() => CORNER_SEALS[props.archKey] || '');
</script>

<template>
  <article class="card card-cover">
    <div class="cover-stars">
      <span></span><span></span><span></span><span></span><span></span>
    </div>
    <div class="eyebrow">
      <span class="diamond"></span>
      <span>{{ badge }}</span>
    </div>
    <div class="cover-seal-corner" v-html="sealSvg"></div>
    <div class="cover-body">
      <div class="cover-archetype">{{ title }}</div>
      <div class="cover-subtitle">{{ claim || subtitle }}</div>

      <div class="cover-activity">
        <div class="cover-activity-row">
          <div
            v-for="(val, i) in activity" :key="i"
            class="cover-activity-cell"
            :class="{ dim: val < 0.4 }"
          >
            <div v-if="val > 0" class="fill" :style="{ height: val * 100 + '%' }"></div>
          </div>
        </div>
        <div class="cover-activity-labels">
          <span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span><span>S</span>
        </div>
      </div>

      <div class="cover-footer" v-html="footer"></div>
    </div>
  </article>
</template>

<style scoped>
@import './card-base.css';

.card-cover {
  background:
    radial-gradient(120% 80% at 50% 100%, var(--tg) 0%, transparent 55%),
    radial-gradient(100% 70% at 50% 80%, var(--tg-mid) 0%, transparent 65%),
    radial-gradient(80% 50% at 50% 60%, var(--tg-soft) 0%, transparent 65%),
    linear-gradient(180deg, rgba(10,11,20,0.4) 0%, rgba(10,11,20,0.85) 70%);
  transition: background var(--theme-ease);
}
.cover-stars {
  position: absolute; inset: 0; pointer-events: none;
}
.cover-stars span {
  position: absolute;
  width: 1.5px; height: 1.5px;
  background: rgba(255,255,255,0.85);
  border-radius: 50%;
  box-shadow: 0 0 4px rgba(255,255,255,0.6);
}
.cover-stars span:nth-child(1) { top: 12%; left: 18%; }
.cover-stars span:nth-child(2) { top: 8%; left: 78%; width: 2px; height: 2px; }
.cover-stars span:nth-child(3) { top: 22%; left: 88%; opacity: 0.6; }
.cover-stars span:nth-child(4) { top: 32%; left: 8%; opacity: 0.5; }
.cover-stars span:nth-child(5) { top: 18%; left: 52%; width: 1px; height: 1px; opacity: 0.7; }

.cover-seal-corner {
  position: absolute;
  top: 22px; right: 24px;
  width: 60px; height: 60px; z-index: 3;
}
.cover-seal-corner :deep(svg) {
  width: 100%; height: 100%;
  filter: drop-shadow(0 0 12px var(--tg));
  transition: filter var(--theme-ease);
}

.cover-body {
  flex: 1; display: flex; flex-direction: column;
  padding: 0 36px; position: relative; z-index: 1;
}
.cover-archetype {
  margin-top: auto;
  font-family: var(--font-serif);
  font-size: 64px; line-height: 1.05; font-weight: 500;
  letter-spacing: -0.02em; color: var(--fg);
  margin-bottom: 18px;
  text-shadow: 0 2px 24px rgba(0,0,0,0.4);
}
.cover-subtitle {
  font-family: var(--font-serif); font-style: italic;
  font-size: 19px; line-height: 1.5; color: var(--fg-2);
  margin-bottom: 36px; max-width: 92%;
}
.cover-activity { margin-bottom: 28px; }
.cover-activity-row {
  display: grid; grid-template-columns: repeat(7, 1fr);
  gap: 6px; margin-bottom: 8px;
}
.cover-activity-cell {
  height: 32px; border-radius: 3px;
  background: rgba(255,255,255,0.04);
  border: 1px solid var(--hairline);
  position: relative; overflow: hidden;
}
.cover-activity-cell .fill {
  position: absolute; bottom: 0; left: 0; right: 0;
  background: linear-gradient(to top, var(--tc), var(--tc-2));
  box-shadow: 0 0 10px var(--tg);
  border-radius: 0 0 2px 2px;
  transition: background var(--theme-ease), box-shadow var(--theme-ease);
}
.cover-activity-cell.dim .fill {
  background: linear-gradient(to top, rgba(255,255,255,0.15), rgba(255,255,255,0.06));
  box-shadow: none;
}
.cover-activity-labels {
  display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px;
  font-family: var(--font-mono); font-size: 10.5px;
  color: var(--muted-2); text-align: center;
}
.cover-footer {
  padding-bottom: 28px;
  font-family: var(--font-mono); font-size: 13px; color: var(--muted);
  display: flex; gap: 14px; font-variant-numeric: tabular-nums;
}
.cover-footer :deep(strong) { color: var(--fg); font-weight: 500; }
.cover-footer :deep(.sep) { color: var(--muted-3); }
</style>
