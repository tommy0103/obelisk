<script setup>
// Step-through player for the book's flows (三条路径 / 一次 build / 一条记忆的一生).
//
// The map beside the steps lights up the modules each step touches, so the
// static figure in the chapter becomes something you watch move. Data lives in
// src/book/flows.js — this component holds no chapter knowledge.

import { computed, onBeforeUnmount, ref, watch } from 'vue';

import TabBar from '@/components/TabBar.vue';

import SystemMap from './SystemMap.vue';

const props = defineProps({
  flow: { type: Object, required: true },
  initialTrack: { type: String, default: '' },
  autoplayMs: { type: Number, default: 2200 },
});

const trackId = ref(props.initialTrack || props.flow.tracks[0].id);
const step = ref(0);
const playing = ref(false);
let timer = null;

const track = computed(
  () => props.flow.tracks.find((t) => t.id === trackId.value) || props.flow.tracks[0],
);
const steps = computed(() => track.value.steps);
const current = computed(() => steps.value[step.value] || steps.value[0]);
const atEnd = computed(() => step.value >= steps.value.length - 1);

// Everything visited so far stays lit, so the map fills in as you advance
// rather than blinking one node at a time.
const lit = computed(() => {
  const out = new Set();
  for (let i = 0; i <= step.value; i += 1) {
    for (const id of steps.value[i]?.lit || []) out.add(id);
  }
  return [...out];
});

function stop() {
  playing.value = false;
  clearInterval(timer);
  timer = null;
}

function play() {
  if (playing.value) return stop();
  if (atEnd.value) step.value = 0;
  playing.value = true;
  timer = setInterval(() => {
    if (atEnd.value) return stop();
    step.value += 1;
  }, props.autoplayMs);
}

const go = (i) => {
  stop();
  step.value = Math.max(0, Math.min(steps.value.length - 1, i));
};

watch(trackId, () => {
  stop();
  step.value = 0;
});

onBeforeUnmount(stop);
</script>

<template>
  <div class="flow">
    <p v-if="flow.intro" class="intro">{{ flow.intro }}</p>

    <TabBar
      v-if="flow.tracks.length > 1"
      v-model="trackId"
      :tabs="flow.tracks"
      label="流程"
      class="tracks"
    />

    <div class="stage">
      <ol class="steps">
        <li
          v-for="(s, i) in steps"
          :key="i"
          :class="{ on: i === step, past: i < step, done: s.done }"
        >
          <button type="button" @click="go(i)">
            <span class="n">{{ i + 1 }}</span>
            <span class="t">{{ s.title }}</span>
          </button>
        </li>
      </ol>

      <div class="panel">
        <div class="map-slot">
          <SystemMap :lit="lit" :interactive="false" :show-legend="false" mode="flow" />
        </div>

        <div class="say">
          <h5>{{ current.title }}</h5>
          <p>{{ current.detail }}</p>
          <pre v-if="current.code" class="code-face"><code>{{ current.code }}</code></pre>
          <p v-if="current.note" class="note">{{ current.note }}</p>
          <p v-if="current.approval" class="approval">
            <span class="mark">批准点</span>{{ current.approval }}
          </p>
        </div>
      </div>
    </div>

    <div class="controls">
      <button class="btn" type="button" :disabled="step === 0" @click="go(step - 1)">← 上一步</button>
      <button class="btn primary" type="button" @click="play">
        {{ playing ? '暂停' : atEnd ? '重放' : '播放' }}
      </button>
      <button class="btn" type="button" :disabled="atEnd" @click="go(step + 1)">下一步 →</button>
      <span class="counter">{{ step + 1 }} / {{ steps.length }}</span>
    </div>
  </div>
</template>

<style scoped>
.intro {
  margin-bottom: 1rem;
  font-size: 0.87rem;
  line-height: 1.7;
  color: var(--muted);
}

.tracks {
  margin-bottom: 1.1rem;
}

.stage {
  display: grid;
  grid-template-columns: 13.5rem 1fr;
  gap: 1.1rem;
  align-items: start;
}

.steps {
  margin: 0;
  padding: 0;
  list-style: none;
  border-left: 1px solid var(--edge);
}

.steps li button {
  display: flex;
  align-items: baseline;
  gap: 0.55rem;
  width: 100%;
  padding: 0.4rem 0 0.4rem 0.75rem;
  margin-left: -1px;
  border-left: 2px solid transparent;
  text-align: left;
  transition: all 0.15s var(--ease);
}

.steps .n {
  flex: none;
  width: 1.2rem;
  font: 0.68rem/1.6 var(--mono);
  color: var(--dim);
}

.steps .t {
  font-size: 0.83rem;
  line-height: 1.5;
  color: var(--muted);
}

.steps li.past .t {
  color: var(--faint);
}

.steps li.past button {
  border-left-color: var(--accent-line);
}

.steps li.on button {
  border-left-color: var(--accent);
}

.steps li.on .t {
  color: var(--fg);
  font-weight: 600;
}

.steps li.on .n {
  color: var(--accent);
}

.steps li.done.on .t {
  color: var(--green);
}

.panel {
  min-width: 0;
}

.map-slot {
  padding: 0.6rem;
  border: 1px solid var(--edge);
  border-radius: var(--radius-sm);
  background: var(--bg-sunk);
}

.say {
  margin-top: 0.9rem;
}

.say h5 {
  font: 600 0.95rem/1.5 var(--sans);
  color: var(--fg);
}

.say p {
  margin-top: 0.4rem;
  font-size: 0.87rem;
  line-height: 1.75;
  color: var(--fg-soft);
}

.say pre {
  margin-top: 0.7rem;
  padding: 0.6rem 0.8rem;
  border: 1px solid var(--edge);
  border-radius: var(--radius-sm);
  background: var(--bg-sunk);
  overflow-x: auto;
}

.say pre code {
  font: inherit;
  color: var(--accent);
}

.note {
  padding-left: 0.8rem;
  border-left: 2px solid var(--accent-line);
  color: var(--muted) !important;
  font-size: 0.83rem !important;
}

.approval {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  font-size: 0.83rem !important;
  color: var(--amber) !important;
}

.approval .mark {
  padding: 0.05em 0.45em;
  border: 1px solid rgba(245, 158, 11, 0.4);
  border-radius: 4px;
  font: 700 0.64rem/1.7 var(--mono);
  letter-spacing: 0.1em;
}

.controls {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 1.1rem;
  padding-top: 0.9rem;
  border-top: 1px solid var(--edge);
}

.counter {
  margin-left: auto;
  font: 0.72rem/1.6 var(--mono);
  color: var(--dim);
  font-variant-numeric: tabular-nums;
}

@media (max-width: 780px) {
  .stage {
    grid-template-columns: 1fr;
  }

  .steps {
    display: flex;
    overflow-x: auto;
    border-left: 0;
    border-bottom: 1px solid var(--edge);
  }

  .steps li button {
    flex-direction: column;
    gap: 0.1rem;
    width: max-content;
    padding: 0.4rem 0.7rem;
    border-left: 0;
    border-bottom: 2px solid transparent;
    margin: 0 0 -1px;
  }

  .steps li.on button,
  .steps li.past button {
    border-bottom-color: var(--accent);
  }

  .steps .t {
    white-space: nowrap;
  }
}
</style>
