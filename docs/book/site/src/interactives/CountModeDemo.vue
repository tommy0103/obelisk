<script setup>
// delta vs total, run twice.
//
// The field exists so persist never has to guess — which would mean knowing the
// source, which would break rule two. Pick the wrong mode and the message count
// drifts on every pass; the counter below is the whole argument.

import { computed, ref } from 'vue';

import TabBar from '@/components/TabBar.vue';

const MODES = [
  {
    id: 'delta',
    label: "countMode: 'delta'",
    sub: 'Claude —— 行增量，persist 累加',
  },
  {
    id: 'total',
    label: "countMode: 'total'",
    sub: 'Codex / Kimi —— 全量重解析，persist 替换',
  },
];

const passes = ref([]);
const mode = ref('delta');

const BATCHES = [
  { label: '首次索引', produced: 84, fromEmptyCursor: true },
  { label: '会话又追加了 21 条', produced: 21, fromEmptyCursor: false },
  { label: '又追加了 12 条', produced: 12, fromEmptyCursor: false },
];

const stored = computed(() =>
  passes.value.reduce((n, p) => (p.mode === 'delta' ? n + p.produced : p.produced), 0),
);

const truth = computed(() =>
  BATCHES.slice(0, passes.value.length).reduce((n, b) => n + b.produced, 0),
);

const drifted = computed(() => passes.value.length > 0 && stored.value !== truth.value);
const next = computed(() => BATCHES[passes.value.length] || null);

function run() {
  const batch = next.value;
  if (!batch) return;
  // Claude computes this per call: skip > 0 ? 'delta' : 'total'. From an empty
  // cursor the two are equivalent, which is why the first pass never drifts.
  const effective = batch.fromEmptyCursor && mode.value === 'delta' ? 'delta' : mode.value;
  passes.value.push({ ...batch, mode: effective });
}

const reset = () => (passes.value = []);

function chooseMode(next) {
  mode.value = next;
  reset();
}
</script>

<template>
  <div class="cm">
    <TabBar :model-value="mode" :tabs="MODES" label="增量策略" @update:model-value="chooseMode" />

    <div class="btn-row runner">
      <button class="btn primary" type="button" :disabled="!next" @click="run">
        {{ next ? `跑一轮：${next.label}` : '没有更多批次了' }}
      </button>
      <button class="btn quiet" type="button" :disabled="!passes.length" @click="reset">重置</button>
    </div>

    <ol class="passes">
      <li v-for="(p, i) in passes" :key="i">
        <span class="idx">{{ i + 1 }}</span>
        <span class="lbl">{{ p.label }}</span>
        <code>message_count = {{ p.produced }}</code>
        <span class="mode" :class="p.mode">{{ p.mode }}</span>
        <span class="op">{{ p.mode === 'delta' ? '累加' : '替换' }}</span>
      </li>
    </ol>

    <div class="scores">
      <div class="score">
        <span>sessions.message_count</span>
        <b :class="{ bad: drifted }">{{ stored }}</b>
      </div>
      <div class="score">
        <span>真实条数</span>
        <b>{{ truth }}</b>
      </div>
    </div>

    <p class="verdict" :class="{ bad: drifted }">
      {{
        drifted
          ? '对不上了。全量重解析报 delta，persist 就把「整份」累加到已有的值上——每跑一轮数字翻一次。'
          : passes.length
            ? '对得上。适配器不假设 persist 记得什么，它每次都明说自己这一批是什么性质。'
            : '注意第一轮：从空游标开始的 delta 等价于 total，所以首次索引时两者自然对齐——差异要跑到第二轮才显出来。'
      }}
    </p>
  </div>
</template>

<style scoped>
.runner {
  margin: 1rem 0 0.9rem;
}

.passes {
  margin: 0 0 0.9rem;
  padding: 0;
  list-style: none;
}

.passes li {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  flex-wrap: wrap;
  padding: 0.35rem 0.6rem;
  margin-bottom: 0.25rem;
  border: 1px solid var(--edge);
  border-radius: var(--radius-sm);
  background: var(--bg-sunk);
}

.idx {
  width: 1.15rem;
  height: 1.15rem;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.06);
  font: 0.64rem/1 var(--mono);
  color: var(--faint);
}

.lbl {
  font-size: 0.79rem;
  color: var(--fg-soft);
}

.passes code {
  font: 0.71rem/1.6 var(--mono);
  color: var(--muted);
}

.mode {
  margin-left: auto;
  padding: 0.05em 0.42em;
  border-radius: 4px;
  font: 0.65rem/1.7 var(--mono);
}

.mode.delta {
  background: rgba(167, 139, 250, 0.14);
  color: var(--accent);
}

.mode.total {
  background: rgba(236, 72, 153, 0.14);
  color: #f0a5c8;
}

.op {
  font: 0.68rem/1.6 var(--mono);
  color: var(--dim);
}

.scores {
  display: flex;
  gap: 0.6rem;
}

.score {
  flex: 1;
  padding: 0.6rem 0.8rem;
  border: 1px solid var(--edge);
  border-radius: var(--radius-sm);
  background: var(--bg-sunk);
}

.score span {
  display: block;
  font: 0.66rem/1.7 var(--mono);
  color: var(--faint);
}

.score b {
  font: 700 1.3rem/1.3 var(--mono);
  color: var(--fg);
  font-variant-numeric: tabular-nums;
}

.score b.bad {
  color: var(--red);
}

.verdict {
  margin-top: 0.9rem;
  font-size: 0.85rem;
  line-height: 1.8;
  color: var(--fg-soft);
}

.verdict.bad {
  color: var(--red);
}
</style>
