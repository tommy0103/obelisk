<!-- Copyright (C) 2026 tommy0103 and contributors. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

<script setup>
defineProps({
  title: String,
  voiceLines: Array,
  observations: Array,
  meter: Object,
  quote: Object,
  idx: { type: Number, default: 3 },
  total: { type: Number, default: 5 },
});
</script>

<template>
  <article class="card" data-themed>
    <div class="eyebrow">
      <span class="diamond"></span>
      <span>Your vibe this week</span>
      <span class="eyebrow-spacer"></span>
      <span class="slot">{{ String(idx).padStart(2, '0') }} · {{ String(total).padStart(2, '0') }}</span>
    </div>
    <div class="card-title">{{ title }}</div>

    <div class="vibe-content">
      <div class="vibe-section">
        <div class="section-label">Things you kept saying</div>
        <div class="vibe-observations">
          <div v-for="(obs, i) in (voiceLines || observations || [])" :key="i" class="vibe-obs">
            <div class="vibe-obs-text">{{ obs.text }}</div>
            <div class="vibe-obs-meta">
              <template v-if="obs.count">×{{ obs.count }} · </template>
              {{ obs.label }}
              <template v-if="obs.time"> · {{ obs.time }}</template>
            </div>
          </div>
        </div>
      </div>

      <div class="vibe-section" v-if="meter">
        <div class="vibe-meter">
          <div class="vibe-meter-track">
            <div class="vibe-meter-fill" :style="{ width: meter.value * 100 + '%' }"></div>
          </div>
          <div class="vibe-meter-row">
            <span class="vibe-meter-label">{{ meter.label }}</span>
            <span class="vibe-meter-caption">{{ meter.caption }}</span>
          </div>
        </div>
      </div>

      <div class="vibe-quote" v-if="quote">
        <div class="vibe-quote-text">{{ quote.text }}</div>
        <div class="vibe-quote-caption" v-if="quote.caption">— {{ quote.caption }}</div>
      </div>
    </div>
  </article>
</template>

<style scoped>
@import './card-base.css';

.vibe-content {
  flex: 1; padding: 0 36px 32px;
  display: flex; flex-direction: column; gap: 22px;
  overflow-y: auto; position: relative; z-index: 1;
}
.vibe-section { display: flex; flex-direction: column; gap: 12px; }
.vibe-observations { display: flex; flex-direction: column; gap: 10px; }
.vibe-obs {
  display: flex; align-items: baseline; gap: 12px;
  padding: 10px 14px;
  background: rgba(255,255,255,0.025);
  border: 1px solid var(--hairline);
  border-left: 2px solid var(--tg-mid);
  border-radius: 4px;
  transition: border-left-color var(--theme-ease);
}
.vibe-obs-text {
  font-family: var(--font-serif); font-style: italic;
  font-size: 18px; line-height: 1.4; color: var(--fg); flex: 1;
}
.vibe-obs-text::before { content: '\201C'; color: var(--muted-2); }
.vibe-obs-text::after { content: '\201D'; color: var(--muted-2); }
.vibe-obs-meta {
  font-family: var(--font-mono); font-size: 12px; color: var(--muted);
  white-space: nowrap; flex-shrink: 0; font-variant-numeric: tabular-nums;
}

.vibe-correction {
  font-family: var(--font-serif); font-size: 14.5px;
  line-height: 1.6; color: var(--fg-2);
}
.vibe-correction :deep(strong) { color: var(--fg); font-weight: 600; font-variant-numeric: tabular-nums; }
.vibe-correction :deep(.vs) { color: var(--muted); font-style: italic; margin: 0 6px; }

.vibe-meter { display: flex; flex-direction: column; gap: 8px; }
.vibe-meter-track {
  position: relative; height: 10px;
  background: rgba(255,255,255,0.04);
  border: 1px solid var(--hairline); border-radius: 2px; overflow: hidden;
}
.vibe-meter-fill {
  position: absolute; top: 0; left: 0; bottom: 0;
  background: linear-gradient(to right, var(--tc), var(--tc-2));
  box-shadow: 0 0 12px var(--tg); border-radius: 1px;
  transition: background var(--theme-ease), box-shadow var(--theme-ease);
}
.vibe-meter-row {
  display: flex; align-items: baseline; justify-content: space-between;
  font-family: var(--font-mono); font-size: 11.5px;
}
.vibe-meter-label {
  color: var(--muted); font-style: italic;
  font-family: var(--font-serif); font-size: 14px;
}
.vibe-meter-caption {
  color: var(--tc-2); font-weight: 600;
  transition: color var(--theme-ease);
}

.vibe-quote {
  margin-top: auto; padding: 18px 0 0;
  border-top: 1px solid var(--hairline);
}
.vibe-quote-text {
  font-family: var(--font-serif); font-size: 22px;
  line-height: 1.4; color: var(--fg); font-weight: 500;
  letter-spacing: -0.01em; margin-bottom: 8px;
}
.vibe-quote-caption {
  font-family: var(--font-serif); font-style: italic;
  font-size: 13px; color: var(--muted);
}
</style>
