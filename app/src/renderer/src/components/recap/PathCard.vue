<!-- Copyright (C) 2026 tommy0103 and contributors. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

<script setup>
defineProps({
  title: String,
  items: Array,
  idx: { type: Number, default: 2 },
  total: { type: Number, default: 5 },
});
</script>

<template>
  <article class="card" data-themed>
    <div class="eyebrow">
      <span class="diamond"></span>
      <span>Your thinking path</span>
      <span class="eyebrow-spacer"></span>
      <span class="slot">{{ String(idx).padStart(2, '0') }} · {{ String(total).padStart(2, '0') }}</span>
    </div>
    <div class="card-title">{{ title }}</div>

    <div class="timeline-wrap">
      <div class="timeline">
        <div v-for="(item, i) in items" :key="i" class="tl-item">
          <div class="tl-node"></div>
          <div class="tl-day">{{ item.day }}</div>
          <div class="tl-prompt">{{ item.prompt }}</div>
          <div class="tl-outcome">
            <span>{{ item.turn || item.outcome }}</span>
          </div>
        </div>
      </div>
    </div>
  </article>
</template>

<style scoped>
@import './card-base.css';

.timeline-wrap {
  flex: 1; padding: 0 36px 24px 36px;
  overflow-y: auto; position: relative; z-index: 1;
}
.timeline { position: relative; padding-left: 28px; }
.timeline::before {
  content: ''; position: absolute;
  left: 6px; top: 14px; bottom: 14px; width: 1px;
  background: linear-gradient(to bottom,
    var(--tg) 0%, var(--tg-mid) 30%,
    rgba(255,255,255,0.12) 70%, rgba(255,255,255,0.06) 100%);
  transition: background var(--theme-ease);
}
.tl-item { position: relative; padding: 8px 0 10px; }
.tl-item:first-child { padding-top: 4px; }
.tl-item:last-child { padding-bottom: 0; }

.tl-node {
  position: absolute; left: -28px; top: 16px;
  width: 13px; height: 13px;
}
.tl-item:first-child .tl-node { top: 12px; }
.tl-node::before {
  content: ''; position: absolute;
  left: 50%; top: 50%;
  width: 7px; height: 7px;
  background: var(--tc);
  transform: translate(-50%, -50%) rotate(45deg);
  box-shadow: 0 0 8px var(--tg), 0 0 0 3px rgba(10,11,20,1);
  transition: background var(--theme-ease), box-shadow var(--theme-ease);
}

.tl-day {
  display: inline-block;
  font-family: var(--font-mono); font-size: 12px; font-weight: 600;
  color: var(--tc-2); margin-bottom: 4px; letter-spacing: 0.01em;
  transition: color var(--theme-ease);
}
.tl-prompt {
  font-family: var(--font-serif); font-style: italic;
  font-size: 16px; line-height: 1.35; color: var(--fg); margin-bottom: 6px;
}
.tl-prompt::before { content: '\201C'; color: var(--muted-2); margin-right: 1px; }
.tl-prompt::after { content: '\201D'; color: var(--muted-2); margin-left: 1px; }

.tl-outcome {
  display: inline-flex; align-items: baseline; gap: 8px;
  font-family: var(--font-mono); font-size: 12px; color: var(--fg-2);
  padding: 4px 10px;
  border-radius: 4px;
  background: rgba(255,255,255,0.025);
  border: 1px solid var(--hairline);
  border-left: 2px solid var(--tc);
  box-shadow: -2px 0 8px -2px var(--tg-mid);
  transition: border-left-color var(--theme-ease), box-shadow var(--theme-ease);
}
</style>
