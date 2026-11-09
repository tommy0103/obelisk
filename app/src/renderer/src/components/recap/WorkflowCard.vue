<!-- Copyright (C) 2026 tommy0103 and contributors. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

<script setup>
defineProps({
  title: String,
  deck: String,
  summary: String,
  stats: String,
  items: Array,
  verdict: String,
  idx: { type: Number, default: 4 },
  total: { type: Number, default: 5 },
});
</script>

<template>
  <article class="card" data-themed>
    <div class="eyebrow">
      <span class="diamond"></span>
      <span>Workflows</span>
      <span class="eyebrow-spacer"></span>
      <span class="slot">{{ String(idx).padStart(2, '0') }} · {{ String(total).padStart(2, '0') }}</span>
    </div>
    <div class="card-title">{{ title }}</div>
    <div class="card-deck-text" v-if="deck || summary">{{ deck || summary }}</div>

    <div class="wf-content">
      <div class="wf-stats" v-if="stats">{{ stats }}</div>

      <div class="wf-list">
        <div v-for="(item, i) in items" :key="i" class="wf-item">
          <div class="wf-item-name">{{ item.name }}</div>
          <div class="wf-item-reaction">{{ item.reaction || item.outcome }}</div>
        </div>
      </div>

      <div class="wf-verdict" v-if="verdict">
        <div class="wf-verdict-label">Verdict —</div>
        <div class="wf-verdict-text">{{ verdict }}</div>
      </div>
    </div>
  </article>
</template>

<style scoped>
@import './card-base.css';

.wf-content {
  flex: 1; padding: 0 36px 32px;
  display: flex; flex-direction: column; gap: 18px;
  overflow-y: auto; position: relative; z-index: 1;
}
.wf-stats {
  font-family: var(--font-mono); font-size: 13px; color: var(--muted);
  font-variant-numeric: tabular-nums; display: flex; gap: 14px;
}
.wf-stats :deep(strong) { color: var(--fg); font-weight: 500; }
.wf-stats :deep(.sep) { color: var(--muted-3); }

.wf-list {
  display: flex; flex-direction: column; gap: 1px;
  background: var(--hairline); border: 1px solid var(--hairline);
  border-radius: 6px; overflow: hidden;
}
.wf-item {
  padding: 14px 16px; background: rgba(10,11,20,0.4);
  display: flex; flex-direction: column; gap: 6px;
}
.wf-item-name {
  font-family: var(--font-mono); font-size: 13px; font-weight: 500;
  color: var(--fg); letter-spacing: -0.005em;
}
.wf-item-reaction {
  font-family: var(--font-serif); font-style: italic;
  font-size: 16px; color: var(--fg-2); line-height: 1.4;
}
.wf-item-reaction::before { content: '\201C'; color: var(--muted-2); }
.wf-item-reaction::after { content: '\201D'; color: var(--muted-2); }

.wf-verdict {
  margin-top: auto; padding: 16px 18px;
  border: 1px solid var(--hairline-strong); border-radius: 6px;
  background: rgba(255,255,255,0.025);
  display: flex; flex-direction: column; gap: 6px;
  position: relative; overflow: hidden;
}
.wf-verdict::before {
  content: ''; position: absolute;
  left: 0; top: 0; bottom: 0; width: 2px;
  background: var(--tc); box-shadow: 0 0 8px var(--tg);
  transition: background var(--theme-ease), box-shadow var(--theme-ease);
}
.wf-verdict-label {
  font-family: var(--font-serif); font-style: italic;
  font-size: 13px; color: var(--muted);
}
.wf-verdict-text {
  font-family: var(--font-serif); font-size: 22px; font-weight: 500;
  color: var(--fg); letter-spacing: -0.01em;
}
</style>
