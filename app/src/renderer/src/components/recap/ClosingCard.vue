<!-- Copyright (C) 2026 tommy0103 and contributors. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

<script setup>
defineProps({
  headline: String,
  receipts: Array,
  stats: Array,
  mostSaidPhrase: String,
  signoff: String,
  idx: { type: Number, default: 5 },
  total: { type: Number, default: 5 },
});
</script>

<template>
  <article class="card card-closing">
    <div class="eyebrow">
      <span class="diamond"></span>
      <span>The week, carved.</span>
      <span class="eyebrow-spacer"></span>
      <span class="slot">{{ String(idx).padStart(2, '0') }} · {{ String(total).padStart(2, '0') }}</span>
    </div>

    <div class="closing-body">
      <div class="closing-headline">{{ headline }}</div>

      <div class="closing-stats" v-if="receipts || stats">
        <div v-for="(line, i) in (receipts || stats || [])" :key="i">{{ line }}</div>
      </div>

      <div class="closing-quote" v-if="mostSaidPhrase">
        <span>"{{ mostSaidPhrase }}"</span>
        <span class="verb">— most-said phrase</span>
      </div>

      <div class="closing-signoff">{{ signoff }}</div>
    </div>
  </article>
</template>

<style scoped>
@import './card-base.css';

.card-closing {
  background:
    radial-gradient(80% 70% at 50% 30%, var(--tg-soft) 0%, transparent 60%),
    radial-gradient(60% 50% at 50% 50%, var(--tg-mid) 0%, transparent 70%),
    linear-gradient(180deg, rgba(10,11,20,0.6) 0%, rgba(10,11,20,0.95) 100%);
  transition: background var(--theme-ease);
}
.closing-body {
  flex: 1; display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  text-align: center; padding: 0 40px; gap: 32px;
  position: relative; z-index: 1;
}
.closing-headline {
  font-family: var(--font-serif); font-size: 72px;
  line-height: 1; font-weight: 500; letter-spacing: -0.02em;
  color: var(--fg); text-shadow: 0 4px 24px var(--tg);
  transition: text-shadow var(--theme-ease);
}
.closing-stats {
  font-family: var(--font-mono); font-size: 13px; color: var(--muted);
  font-variant-numeric: tabular-nums;
  display: flex; flex-direction: column; gap: 4px;
}
.closing-quote {
  font-family: var(--font-serif); font-style: italic;
  font-size: 19px; color: var(--fg-2); line-height: 1.5; max-width: 360px;
}
.closing-quote .verb {
  font-family: var(--font-serif); font-style: italic;
  font-size: 13px; color: var(--muted); display: block; margin-top: 8px;
}
.closing-signoff {
  font-family: var(--font-serif); font-size: 15px;
  color: var(--muted); font-style: italic;
}
</style>
