<script setup>
// N × M versus N + M.
//
// The claim in 第 4 章 is arithmetic, so let the reader move the numbers. Drag
// the two sliders: without a common language every consumer has to understand
// every source; with one, each side only has to understand the middle.

import { computed, ref } from 'vue';

const sources = ref(3);
const consumers = ref(2);

const withoutPivot = computed(() => sources.value * consumers.value);
const withPivot = computed(() => sources.value + consumers.value);
const saved = computed(() => withoutPivot.value - withPivot.value);

const SOURCE_NAMES = ['claude', 'codex', 'kimi', 'pi', 'foo', 'bar', 'baz', 'qux'];
const CONSUMER_NAMES = ['persist', 'session-detail', 'query', 'export', 'mcp', 'trajectory'];

const grid = computed(() =>
  Array.from({ length: consumers.value }, (_, c) =>
    Array.from({ length: sources.value }, (_, s) => ({ s, c })),
  ),
);
</script>

<template>
  <div class="axes">
    <div class="dials">
      <label>
        <span>来源 N</span>
        <input v-model.number="sources" type="range" min="1" max="8" />
        <b>{{ sources }}</b>
      </label>
      <label>
        <span>消费者 M</span>
        <input v-model.number="consumers" type="range" min="1" max="6" />
        <b>{{ consumers }}</b>
      </label>
    </div>

    <div class="compare">
      <section class="side bad">
        <header>
          <h5>没有中间语言</h5>
          <span class="cost">{{ withoutPivot }} 处理解</span>
        </header>
        <p class="sub">每个消费者都得懂每一种格式。</p>
        <div class="mesh">
          <div v-for="(row, ci) in grid" :key="ci" class="mesh-row">
            <span class="rlabel">{{ CONSUMER_NAMES[ci] }}</span>
            <span v-for="cell in row" :key="`${cell.c}-${cell.s}`" class="cell">
              {{ SOURCE_NAMES[cell.s] }}
            </span>
          </div>
        </div>
      </section>

      <section class="side good">
        <header>
          <h5>压在一个点的两侧</h5>
          <span class="cost">{{ withPivot }} 处理解</span>
        </header>
        <p class="sub">适配器只懂自己的格式，消费者只懂共同语言。</p>
        <div class="pivot">
          <div class="row up">
            <span v-for="i in sources" :key="i" class="cell">{{ SOURCE_NAMES[i - 1] }}</span>
          </div>
          <div class="hub">TranscriptRecord</div>
          <div class="row down">
            <span v-for="i in consumers" :key="i" class="cell">{{ CONSUMER_NAMES[i - 1] }}</span>
          </div>
        </div>
      </section>
    </div>

    <p class="verdict">
      <b>N + M，不是 N × M。</b>
      当前配置省下 {{ saved }} 处理解。加一个来源不影响任何消费者，加一个消费者不影响任何适配器——
      前提是这个中间语言<b>没有人可以绕过</b>，也就是第 2 章那三条依赖规则。
    </p>
  </div>
</template>

<style scoped>
.dials {
  display: flex;
  gap: 1.6rem;
  flex-wrap: wrap;
  margin-bottom: 1.1rem;
}

label {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font: 0.76rem/1.6 var(--mono);
  color: var(--muted);
}

input[type='range'] {
  width: 8rem;
  accent-color: var(--accent-deep);
}

label b {
  min-width: 1.2rem;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.compare {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.8rem;
}

.side {
  padding: 0.85rem 0.95rem 1rem;
  border: 1px solid var(--edge);
  border-radius: var(--radius-sm);
  background: var(--bg-sunk);
}

.side.bad {
  border-color: rgba(248, 113, 113, 0.28);
}

.side.good {
  border-color: var(--accent-line);
}

header {
  display: flex;
  align-items: baseline;
  gap: 0.7rem;
}

h5 {
  font: 600 0.85rem/1.5 var(--sans);
  color: var(--fg);
}

.cost {
  margin-left: auto;
  font: 700 0.8rem/1.5 var(--mono);
  font-variant-numeric: tabular-nums;
}

.bad .cost {
  color: var(--red);
}

.good .cost {
  color: var(--green);
}

.sub {
  margin: 0.2rem 0 0.75rem;
  font-size: 0.76rem;
  line-height: 1.6;
  color: var(--faint);
}

.mesh-row {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  margin-bottom: 0.25rem;
  flex-wrap: wrap;
}

.rlabel {
  width: 6.4rem;
  flex: none;
  font: 0.66rem/1.6 var(--mono);
  color: var(--muted);
  text-align: right;
  padding-right: 0.35rem;
}

.cell {
  padding: 0.1rem 0.35rem;
  border: 1px solid var(--edge);
  border-radius: 3px;
  font: 0.63rem/1.6 var(--mono);
  color: var(--faint);
}

.bad .cell {
  border-color: rgba(248, 113, 113, 0.28);
  background: rgba(248, 113, 113, 0.06);
}

.pivot {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.45rem;
}

.row {
  display: flex;
  gap: 0.25rem;
  flex-wrap: wrap;
  justify-content: center;
}

.hub {
  padding: 0.3rem 0.8rem;
  border: 1px solid var(--accent);
  border-radius: 6px;
  background: var(--accent-soft);
  font: 600 0.72rem/1.6 var(--mono);
  color: var(--accent);
}

.good .cell {
  border-color: var(--accent-line);
  background: rgba(167, 139, 250, 0.06);
}

.verdict {
  margin-top: 1rem;
  font-size: 0.86rem;
  line-height: 1.8;
  color: var(--fg-soft);
}

.verdict b {
  color: var(--fg);
}

@media (max-width: 760px) {
  .compare {
    grid-template-columns: 1fr;
  }
}
</style>
