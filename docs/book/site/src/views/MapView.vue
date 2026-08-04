<script setup>
// The map as a page of its own: the three dependency rules, each one shown as
// a highlight on the same graph. Clicking a rule marks who must obey it and
// what they are forbidden to touch.

import { computed, ref } from 'vue';
import { RouterLink } from 'vue-router';

import { RULES } from '@/book/modules.js';

import SystemMap from '@/interactives/SystemMap.vue';

const active = ref(null);
const rule = computed(() => RULES.find((r) => r.id === active.value) || null);
</script>

<template>
  <div class="page">
    <header>
      <span class="eyebrow">模块地图</span>
      <h1>它由什么组成</h1>
      <p>
        两种读法：<b>数据流向</b>是一条记录实际走过的路，<b>依赖方向</b>是谁 import 谁。
        后者所有箭头单向、没有回边——出现回边就是在破坏下面这三条规则。
      </p>
    </header>

    <SystemMap
      :lit="rule?.highlight || []"
      :forbid="rule?.forbid || []"
      :mode="rule ? 'deps' : 'flow'"
    />

    <section class="rules">
      <h2>三条依赖规则</h2>
      <div class="grid">
        <button
          v-for="r in RULES"
          :key="r.id"
          type="button"
          class="rule"
          :class="{ on: active === r.id }"
          @click="active = active === r.id ? null : r.id"
        >
          <span class="idx">{{ r.id.toUpperCase() }}</span>
          <b>{{ r.title }}</b>
          <span class="detail">{{ r.detail }}</span>
        </button>
      </div>
      <p class="legend-note">
        点一条规则：<span class="lit">紫色</span>是必须遵守它的部件，<span class="forbid">红色虚线</span>是它们不许碰的东西。
      </p>
    </section>

    <RouterLink class="btn primary cta" to="/ch/02-module-map">
      去读第 2 章，把这三条规则拿去判题 →
    </RouterLink>
  </div>
</template>

<style scoped>
.page {
  max-width: 62rem;
  margin: 0 auto;
  padding: 4.5rem 3rem 7rem;
}

header {
  margin-bottom: 2.2rem;
}

.eyebrow {
  font: 600 0.68rem/1.7 var(--mono);
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--accent);
}

h1 {
  margin-top: 0.5rem;
  font: 600 2rem/1.3 var(--serif);
  color: var(--fg);
}

header p {
  max-width: 42rem;
  margin-top: 0.7rem;
  font-size: 0.95rem;
  line-height: 1.8;
  color: var(--muted);
}

header b {
  color: var(--fg);
}

.rules {
  margin-top: 3rem;
}

h2 {
  margin-bottom: 0.9rem;
  font: 600 1.2rem/1.4 var(--serif);
  color: var(--fg);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
  gap: 0.55rem;
}

.rule {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  padding: 0.8rem 0.95rem;
  border: 1px solid var(--edge);
  border-radius: var(--radius-sm);
  text-align: left;
  transition: all 0.16s var(--ease);
}

.rule:hover {
  border-color: var(--edge-hi);
}

.rule.on {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.idx {
  font: 600 0.62rem/1.7 var(--mono);
  letter-spacing: 0.16em;
  color: var(--dim);
}

.rule.on .idx {
  color: var(--accent);
}

.rule b {
  font: 600 0.9rem/1.5 var(--sans);
  color: var(--fg);
}

.detail {
  font-size: 0.78rem;
  line-height: 1.7;
  color: var(--faint);
}

.legend-note {
  margin-top: 0.8rem;
  font: 0.74rem/1.8 var(--mono);
  color: var(--dim);
}

.lit {
  color: var(--accent);
}

.forbid {
  color: var(--red);
}

.cta {
  margin-top: 2.4rem;
  padding: 0.5rem 1rem;
}

@media (max-width: 1080px) {
  .page {
    padding: 4rem 1.2rem 5rem;
  }
}
</style>
