<script setup>
// "Does this change break a rule?" — one case at a time, answer, get the
// consequence. Data comes from src/book/quizzes.js so the same component serves
// 第 2 章 (依赖规则), 第 6 章 (契约禁止什么) and 第 15 章 (六个坑).
//
// The cases that are FINE matter as much as the violations: a rule you can only
// apply by refusing everything is not a rule.

import { computed, ref } from 'vue';

import { QUIZ_SETS } from '@/book/quizzes.js';

const props = defineProps({
  set: { type: String, required: true },
});

const data = computed(() => QUIZ_SETS[props.set]);
const index = ref(0);
const picked = ref(null);
const score = ref({ right: 0, wrong: 0 });

const item = computed(() => data.value.cases[index.value]);
const total = computed(() => data.value.cases.length);
const settled = computed(() => picked.value !== null);
const correct = computed(() => settled.value && picked.value === item.value.verdict);
const finished = computed(() => index.value >= total.value - 1 && settled.value);

const verdictLabel = (id) => data.value.verdicts.find((v) => v.id === id)?.text || id;

function answer(id) {
  if (settled.value) return;
  picked.value = id;
  if (id === item.value.verdict) score.value.right += 1;
  else score.value.wrong += 1;
}

function next() {
  if (index.value < total.value - 1) {
    index.value += 1;
    picked.value = null;
  }
}

function restart() {
  index.value = 0;
  picked.value = null;
  score.value = { right: 0, wrong: 0 };
}
</script>

<template>
  <div class="quiz">
    <header>
      <p class="prompt">{{ data.prompt }}</p>
      <span class="count">{{ index + 1 }} / {{ total }}</span>
    </header>

    <pre class="code-face case"><code>{{ item.code }}</code></pre>

    <div class="verdicts">
      <button
        v-for="v in data.verdicts"
        :key="v.id"
        type="button"
        :disabled="settled"
        :class="{
          picked: picked === v.id,
          right: settled && v.id === item.verdict,
          wrong: settled && picked === v.id && v.id !== item.verdict,
        }"
        @click="answer(v.id)"
      >
        <span class="v-label">{{ v.label }}</span>
        <span class="v-text">{{ v.text }}</span>
      </button>
    </div>

    <transition name="slide">
      <div v-if="settled" class="why" :class="correct ? 'ok' : 'no'">
        <p class="verdict">
          {{ correct ? '对了' : '不对' }} —— {{ verdictLabel(item.verdict) }}
        </p>
        <p class="body">{{ item.why }}</p>
      </div>
    </transition>

    <footer>
      <span class="score">
        答对 <b>{{ score.right }}</b> · 答错 <b class="bad">{{ score.wrong }}</b>
      </span>
      <button v-if="finished" type="button" class="btn again" @click="restart">再来一遍</button>
      <button v-else type="button" class="btn primary next" :disabled="!settled" @click="next">
        下一题 →
      </button>
    </footer>
  </div>
</template>

<style scoped>
header {
  display: flex;
  align-items: baseline;
  gap: 1rem;
  margin-bottom: 0.85rem;
}

.prompt {
  flex: 1;
  font-size: 0.9rem;
  line-height: 1.6;
  color: var(--fg);
}

.count {
  font: 0.72rem/1.6 var(--mono);
  color: var(--dim);
  font-variant-numeric: tabular-nums;
}

.case {
  margin: 0 0 1rem;
  padding: 0.85rem 1rem;
  border: 1px solid var(--edge);
  border-radius: var(--radius-sm);
  background: var(--bg-sunk);
  overflow-x: auto;
}

.case code {
  font: inherit;
  color: var(--fg-soft);
  white-space: pre;
}

.verdicts {
  display: grid;
  gap: 0.45rem;
  grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
}

.verdicts button {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  padding: 0.55rem 0.75rem;
  border: 1px solid var(--edge);
  border-radius: var(--radius-sm);
  text-align: left;
  transition: all 0.15s var(--ease);
}

.verdicts button:hover:not(:disabled) {
  border-color: var(--accent-line);
  background: var(--accent-soft);
}

.v-label {
  font: 600 0.78rem/1.5 var(--mono);
  color: var(--fg);
}

.v-text {
  font-size: 0.74rem;
  line-height: 1.5;
  color: var(--faint);
}

.verdicts button.right {
  border-color: var(--green);
  background: var(--green-soft);
}

.verdicts button.right .v-label {
  color: var(--green);
}

.verdicts button.wrong {
  border-color: var(--red);
  background: var(--red-soft);
}

.verdicts button.wrong .v-label {
  color: var(--red);
}

.verdicts button:disabled {
  opacity: 1;
}

.verdicts button:disabled:not(.right):not(.wrong) {
  opacity: 0.4;
}

.why {
  margin-top: 0.9rem;
  padding: 0.8rem 1rem;
  border-radius: var(--radius-sm);
  border-left: 2px solid var(--edge-hi);
  background: rgba(255, 255, 255, 0.02);
}

.why.ok {
  border-left-color: var(--green);
}

.why.no {
  border-left-color: var(--red);
}

.verdict {
  font: 600 0.8rem/1.6 var(--mono);
  color: var(--fg);
}

.why.ok .verdict {
  color: var(--green);
}

.why.no .verdict {
  color: var(--red);
}

.body {
  margin-top: 0.35rem;
  font-size: 0.86rem;
  line-height: 1.75;
  color: var(--fg-soft);
}

footer {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-top: 1rem;
  padding-top: 0.85rem;
  border-top: 1px solid var(--edge);
}

.score {
  font: 0.75rem/1.6 var(--mono);
  color: var(--faint);
}

.score b {
  color: var(--green);
}

.score b.bad {
  color: var(--red);
}

.next,
.again {
  margin-left: auto;
}

.slide-enter-active {
  transition: opacity 0.2s var(--ease), transform 0.2s var(--ease);
}

.slide-enter-from {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
