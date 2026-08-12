<!-- Copyright (C) 2026 tommy0103 and contributors. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

<script setup>
import { computed } from 'vue';
import { formatProjectLabel } from '../utils.js';
import { activitySessionMetaParts } from '../activity-ledger.mjs';
import { state } from '../store.js';

const props = defineProps({
  session: { type: Object, required: true },
  mixedSources: { type: Boolean, default: false },
  includeProject: { type: Boolean, default: true },
  tone: { type: String, default: 'started' },
  noise: { type: Boolean, default: false },
});

const emit = defineEmits(['open']);

const metaParts = computed(() => activitySessionMetaParts(props.session, {
  mixedSources: props.mixedSources,
  projectLabel: formatProjectLabel(props.session.project) || '',
  includeProject: props.includeProject,
  sourceCatalog: state.sources,
}));
</script>

<template>
  <button
    class="ledger-item"
    :class="[tone, { noise }]"
    type="button"
    @click="emit('open', session.id)"
  >
    <span class="ledger-item-title">{{ session.title || '(untitled)' }}</span>
    <span class="ledger-item-meta">
      <template v-for="(part, index) in metaParts" :key="`${part.kind}-${index}`">
        <span v-if="index" class="meta-separator">·</span>
        <span :class="`meta-${part.kind}`">{{ part.text }}</span>
      </template>
    </span>
  </button>
</template>

<style scoped>
.ledger-item {
  width: 100%;
  display: block;
  margin-left: -10px;
  padding: 6px 10px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background .14s cubic-bezier(.22, 1, .36, 1);
}

.ledger-item:hover { background: var(--surface-strong); }

.ledger-item-title {
  display: block;
  overflow: hidden;
  color: var(--accent-2);
  font-size: var(--text-base);
  font-weight: 500;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ledger-item.continued .ledger-item-title { color: var(--fg-2); }
.ledger-item:hover .ledger-item-title { text-decoration: underline; text-underline-offset: 2px; }

.ledger-item-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 15px;
  margin-top: 4px;
  color: var(--muted-2);
  font: var(--text-xs)/1.35 var(--font-mono);
  white-space: nowrap;
}

.meta-source {
  color: var(--fg-2);
  font-weight: 500;
}

.meta-project { color: var(--muted); }
.meta-count { color: var(--muted-2); }
.meta-separator { color: var(--muted); font-weight: 500; opacity: .82; }

.ledger-item.noise { opacity: .7; }
.ledger-item.noise .ledger-item-title { color: var(--fg-2); font-weight: 400; }

@media (max-width: 760px) {
  .ledger-item-meta { flex-wrap: wrap; row-gap: 4px; white-space: normal; }
}
</style>
