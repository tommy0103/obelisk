<script setup>
// A real tab bar, for switching between mutually exclusive views.
//
// This replaces the rows of rounded pills that several widgets used to have.
// Pills read as badges — a badge labels something, it does not switch
// something — and a row of them gives no indication of which is selected
// beyond colour. Tabs say "these are alternative views of one thing", handle
// long labels without cramping, and come with the keyboard behaviour people
// already expect.

import { computed, ref } from 'vue';

const props = defineProps({
  // [{ id, label, sub? }]
  tabs: { type: Array, required: true },
  modelValue: { type: [String, Number], required: true },
  label: { type: String, default: '' },
});

const emit = defineEmits(['update:modelValue']);

const buttons = ref([]);
const index = computed(() => props.tabs.findIndex((t) => t.id === props.modelValue));

function select(id) {
  if (id !== props.modelValue) emit('update:modelValue', id);
}

// Roving focus: arrows move between tabs, Home/End jump to the ends. Selection
// follows focus, which is the expected behaviour when switching a tab is cheap.
function onKey(event) {
  const last = props.tabs.length - 1;
  let next = null;
  if (event.key === 'ArrowRight') next = index.value >= last ? 0 : index.value + 1;
  else if (event.key === 'ArrowLeft') next = index.value <= 0 ? last : index.value - 1;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = last;
  if (next === null) return;
  event.preventDefault();
  select(props.tabs[next].id);
  buttons.value[next]?.focus();
}
</script>

<template>
  <div class="tabbar" role="tablist" :aria-label="label" @keydown="onKey">
    <button
      v-for="(t, i) in tabs"
      :key="t.id"
      ref="buttons"
      type="button"
      role="tab"
      class="tab"
      :class="{ on: t.id === modelValue }"
      :aria-selected="t.id === modelValue"
      :tabindex="t.id === modelValue ? 0 : -1"
      @click="select(t.id)"
    >
      <span class="lb">{{ t.label }}</span>
      <span v-if="t.sub" class="sb">{{ t.sub }}</span>
    </button>
  </div>
</template>

<style scoped>
.tabbar {
  display: flex;
  gap: 1.35rem;
  border-bottom: 1px solid var(--edge);
  overflow-x: auto;
  scrollbar-width: none;
}

.tabbar::-webkit-scrollbar {
  display: none;
}

.tab {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  padding: 0 0 0.55rem;
  margin-bottom: -1px;
  border-bottom: 2px solid transparent;
  text-align: left;
  white-space: nowrap;
  transition: color 0.15s var(--ease), border-color 0.15s var(--ease);
}

.lb {
  font: 0.82rem/1.55 var(--sans);
  color: var(--faint);
  transition: color 0.15s var(--ease);
}

.sb {
  font: 0.66rem/1.5 var(--mono);
  color: var(--dim);
  transition: color 0.15s var(--ease);
}

.tab:hover .lb {
  color: var(--fg-soft);
}

.tab.on {
  border-bottom-color: var(--accent);
}

.tab.on .lb {
  color: var(--fg);
  font-weight: 600;
}

.tab.on .sb {
  color: var(--faint);
}

.tab:focus-visible {
  outline: none;
  border-bottom-color: var(--accent);
}

.tab:focus-visible .lb {
  color: var(--fg);
  text-decoration: underline;
  text-underline-offset: 3px;
}
</style>
