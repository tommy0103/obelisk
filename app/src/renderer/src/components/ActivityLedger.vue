<!-- Copyright (C) 2026 tommy0103 and contributors. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

<script setup>
import { computed, reactive } from 'vue';
import {
  activityGroupHasMixedSources,
  activityGroupSessions,
} from '../activity-ledger.mjs';
import ActivityLedgerRow from './ActivityLedgerRow.vue';

const props = defineProps({
  block: { type: Object, required: true },
  eventDate: { type: String, default: '' },
});

const emit = defineEmits(['open-session']);
const expanded = reactive({});

function plural(count, singular, pluralForm = `${singular}s`) {
  return count === 1 ? singular : pluralForm;
}

function projectCount(split) {
  return new Set(activityGroupSessions(split).map(session => session.project || '(none)')).size;
}

const groups = computed(() => [
  {
    key: 'workspaces',
    kind: 'workspace',
    split: props.block.newWorkspaces,
    title: `Created ${props.block.newWorkspaces.total} new ${plural(props.block.newWorkspaces.total, 'workspace')}`,
    includeProject: false,
  },
  {
    key: 'sessions',
    kind: 'started',
    split: props.block.newSessions,
    title: `Started ${props.block.newSessions.total} ${plural(props.block.newSessions.total, 'session')} in ${projectCount(props.block.newSessions)} ${plural(projectCount(props.block.newSessions), 'project')}`,
    includeProject: true,
  },
  {
    key: 'continued',
    kind: 'continued',
    split: props.block.continued,
    title: `Continued ${props.block.continued.total} ${plural(props.block.continued.total, 'session')}`,
    includeProject: true,
  },
].filter(group => group.split.total > 0).map(group => ({
  ...group,
  mixedSources: activityGroupHasMixedSources(group.split),
})));

function toggleNoise(key) {
  expanded[key] = !expanded[key];
}
</script>

<template>
  <div class="activity-ledger" v-if="groups.length">
    <article
      v-for="group in groups"
      :key="group.key"
      class="ledger-group"
      :class="group.kind"
    >
      <div class="ledger-node" aria-hidden="true">
        <svg v-if="group.kind === 'workspace'" viewBox="0 0 24 24">
          <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>
        </svg>
        <svg v-else-if="group.kind === 'started'" viewBox="0 0 24 24">
          <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"/>
        </svg>
        <svg v-else viewBox="0 0 24 24">
          <path d="m17 2 4 4-4 4"/>
          <path d="M3 11v-1a4 4 0 0 1 4-4h14"/>
          <path d="m7 22-4-4 4-4"/>
          <path d="M21 13v1a4 4 0 0 1-4 4H3"/>
        </svg>
      </div>

      <header class="ledger-group-header">
        <h3>{{ group.title }}</h3>
        <time v-if="eventDate">{{ eventDate }}</time>
      </header>

      <div class="ledger-items">
        <ActivityLedgerRow
          v-for="session in group.split.normal"
          :key="session.id"
          :session="session"
          :mixed-sources="group.mixedSources"
          :include-project="group.includeProject"
          :tone="group.kind"
          @open="emit('open-session', $event)"
        />

        <template v-if="group.split.noise.length">
          <button
            class="noise-fold-row"
            :class="{ expanded: expanded[group.key] }"
            type="button"
            :aria-expanded="Boolean(expanded[group.key])"
            @click="toggleNoise(group.key)"
          >
            <svg class="chev" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 2.5l3 3.5-3 3.5"/></svg>
            <span>{{ group.split.noise.length }} hidden, likely test or throwaway runs</span>
          </button>

          <ActivityLedgerRow
            v-for="session in (expanded[group.key] ? group.split.noise : [])"
            :key="session.id"
            :session="session"
            :mixed-sources="group.mixedSources"
            :include-project="group.includeProject"
            :tone="group.kind"
            noise
            @open="emit('open-session', $event)"
          />
        </template>
      </div>
    </article>
  </div>
</template>

<style scoped>
.activity-ledger {
  position: relative;
  margin-left: 10px;
  padding-left: 44px;
}

.activity-ledger::before {
  content: '';
  position: absolute;
  top: 2px;
  bottom: 4px;
  left: 12px;
  width: 1px;
  background: var(--hairline);
}

.ledger-group {
  position: relative;
  padding-bottom: 28px;
}

.ledger-group:last-child { padding-bottom: 6px; }

.ledger-node {
  position: absolute;
  top: -2px;
  left: -44px;
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border: 1px solid var(--hairline-strong);
  border-radius: 50%;
  background: var(--surface);
  color: var(--muted);
  box-shadow: 0 0 0 5px var(--bg);
}

.ledger-node svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.workspace .ledger-node {
  color: #f59e0b;
  border-color: rgba(245, 158, 11, .28);
  background: rgba(245, 158, 11, .1);
}

.started .ledger-node {
  color: var(--accent-2);
  border-color: rgba(167, 139, 250, .28);
  background: var(--accent-soft);
}

.ledger-group-header {
  min-height: 24px;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 9px;
}

.ledger-group-header h3 {
  margin: 0;
  color: var(--fg);
  font-size: var(--text-base);
  font-weight: 500;
}

.ledger-group-header time {
  color: var(--muted-2);
  font: 10px/1 var(--font-mono);
  letter-spacing: .05em;
  white-space: nowrap;
}

.ledger-items {
  display: grid;
  gap: 2px;
}

.noise-fold-row {
  width: fit-content;
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px 0 0 -4px;
  padding: 6px 8px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--muted-2);
  font: var(--text-xs)/1.25 var(--font-mono);
  text-align: left;
  cursor: pointer;
}

.noise-fold-row:hover { color: var(--muted); background: var(--surface-strong); }

.noise-fold-row .chev {
  width: 9px;
  height: 9px;
  flex-shrink: 0;
  transition: transform .15s cubic-bezier(.22, 1, .36, 1);
}

.noise-fold-row.expanded .chev { transform: rotate(90deg); }

@media (max-width: 760px) {
  .activity-ledger { margin-left: 6px; padding-left: 40px; }
  .activity-ledger::before { left: 12px; }
  .ledger-node { left: -40px; }
  .ledger-group-header { gap: 12px; }
}
</style>
