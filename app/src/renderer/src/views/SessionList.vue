<!-- Copyright (C) 2026 tommy0103 and contributors. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

<script setup>
import { computed, ref, shallowRef, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { useVirtualizer } from '@tanstack/vue-virtual';
import { useRouter } from 'vue-router';
import { state } from '../store.js';
import { highlightPlain, escapeHTML, formatProjectLabel, fmtListTime, fmtRelative } from '../utils.js';

defineOptions({ name: 'SessionList' });

const router = useRouter();
const debugEmpty = ref(false);

function onKeydown(e) {
  if (e.key === 'm' && !e.metaKey && !e.ctrlKey && e.target.tagName !== 'INPUT') {
    debugEmpty.value = !debugEmpty.value;
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onUnmounted(() => window.removeEventListener('keydown', onKeydown));

const homePath = (typeof process !== 'undefined' && process.env?.HOME) || '~';

const showProjectPrefix = computed(() => state.projectFilter === 'all');
const showNoise = ref(false);
const scrollElement = ref(null);
const catalogueLoading = ref(true);
const totals = ref({ normal: 0, quiet: 0 });
const pages = shallowRef(new Map());
const pending = new Set();
const PAGE_SIZE = 100;
let generation = 0;
const options = () => ({
  source: state.sourceFilter,
  project: state.projectFilter,
  query: state.query,
  descending: state.sortDesc,
});

async function fetchPage(quiet, page, version, refresh = false) {
  const key = `${quiet}:${page}`;
  if ((!refresh && pages.value.has(key)) || pending.has(key)) return;
  pending.add(key);
  try {
    const result = await window.obelisk.getSessionCatalogue({ ...options(), quiet, offset: page * PAGE_SIZE, limit: PAGE_SIZE });
    if (version !== generation) return;
    totals.value = { ...totals.value, [quiet ? 'quiet' : 'normal']: result.total };
    const next = new Map(pages.value);
    next.delete(key);
    next.set(key, result.rows);
    while (next.size > 8) next.delete(next.keys().next().value);
    pages.value = next;
  } catch (error) {
    console.error('Failed to load session catalogue:', error);
  } finally {
    if (version === generation) pending.delete(key);
  }
}

watch(() => [state.query, state.projectFilter, state.sourceFilter, state.sortDesc, state.catalogueVersion],
  async (current, previous) => {
    const version = ++generation;
    const filtersChanged = !previous || current.slice(0, 4).some((value, index) => value !== previous[index]);
    catalogueLoading.value = true;
    pending.clear();
    const requests = new Map([['false:0', [false, 0]], ['true:0', [true, 0]]]);
    if (filtersChanged) {
      pages.value = new Map();
      totals.value = { normal: 0, quiet: 0 };
    } else {
      // Retain the mounted rows and list height while refresh IPC is pending.
      // Discard offscreen pages so revisiting them fetches the new generation.
      const retained = new Map();
      for (const item of virtualRows.value) {
        const request = pageForRow(item.index);
        if (!request) continue;
        const [quiet, page] = request;
        const key = `${quiet}:${page}`;
        requests.set(key, request);
        if (pages.value.has(key)) retained.set(key, pages.value.get(key));
      }
      pages.value = retained;
    }
    await Promise.all([...requests.values()].map(([quiet, page]) => fetchPage(quiet, page, version, true)));
    if (version === generation) catalogueLoading.value = false;
    if (version === generation && previous && filtersChanged) {
      await nextTick();
      scrollElement.value?.scrollTo(0, 0);
    }
  }, { immediate: true });

const itemCount = computed(() => totals.value.normal + (totals.value.quiet ? 1 + (showNoise.value ? totals.value.quiet + 2 : 0) : 0));
const virtualizer = useVirtualizer(computed(() => ({
  count: itemCount.value,
  getScrollElement: () => scrollElement.value,
  estimateSize: index => index < totals.value.normal ? 72
    : index === totals.value.normal ? 56
      : index === totals.value.normal + 1 ? 28
        : index === itemCount.value - 1 ? 40 : 64,
  getItemKey: index => index,
  overscan: 8,
})));
const virtualRows = computed(() => virtualizer.value.getVirtualItems());
const totalSize = computed(() => virtualizer.value.getTotalSize());

function rowAt(index) {
  const normal = index < totals.value.normal;
  const offset = normal ? index : index - totals.value.normal - 2;
  if (!normal && (offset < 0 || offset >= totals.value.quiet)) return null;
  return pages.value.get(`${!normal}:${Math.floor(offset / PAGE_SIZE)}`)?.[offset % PAGE_SIZE] || null;
}

function pageForRow(index) {
  const normal = index < totals.value.normal;
  const offset = normal ? index : index - totals.value.normal - 2;
  return offset >= 0 && (normal || offset < totals.value.quiet)
    ? [!normal, Math.floor(offset / PAGE_SIZE)] : null;
}

watch(virtualRows, rows => {
  const version = generation;
  for (const item of rows) {
    const request = pageForRow(item.index);
    if (request) void fetchPage(...request, version);
  }
}, { immediate: true });

function titleHTML(session) {
  return highlightPlain(session.title || '(untitled)', state.query.trim());
}

function projectLabel(session) {
  return escapeHTML(formatProjectLabel(session.project));
}

function timeLabel(session) {
  const ts = new Date(session.ended_at || session.started_at || 0).getTime();
  return fmtListTime(ts);
}

function lastActiveLabel(session) {
  const ts = new Date(session.ended_at || session.started_at || 0).getTime();
  return fmtListTime(ts);
}

function createdLabel(session) {
  const ts = new Date(session.started_at || 0).getTime();
  return fmtRelative(ts);
}

function openSession(session) {
  router.push({ name: 'SessionDetail', params: { id: session.id } });
}

function obeliskStyle(session) {
  const created = new Date(session.started_at || 0).getTime();
  const days = Math.max(0, (Date.now() - created) / 86400000);
  const height = Math.min(1, Math.log(1 + days) / Math.log(1 + 365));

  let color;
  if (days < 7) color = '#a855f7';
  else if (days < 30) color = '#6366f1';
  else if (days < 90) color = '#64748b';
  else color = '#475569';

  const glow = days < 7 ? `0 0 4px ${color}` : 'none';
  const maxHeight = 36; // px, roughly the row height minus padding

  return {
    height: `${Math.max(4, Math.round(height * maxHeight))}px`,
    background: color,
    boxShadow: glow,
  };
}
</script>

<template>
  <div class="session-list-wrap">
    <!-- Empty state: no data source / debug toggle -->
    <div v-if="state.loaded && (debugEmpty || (!catalogueLoading && !itemCount && !state.query && !state.stats.sessions))" class="empty-content">
      <div class="empty-eyebrow">
        <span class="diamond"></span>
        <span>No data source connected</span>
      </div>
      <div class="empty-title">Obelisk reads your Claude Code session history.</div>
      <div class="empty-body">
        We didn't find <code>~/.claude</code> on this machine. If you've already used
        Claude Code, point Obelisk at where its data lives in
        <button class="inline-link" @click="router.push('/settings')">Settings</button>. If you haven't,
        <strong>install Claude Code first</strong> — Obelisk has nothing to read until
        sessions exist.
      </div>
      <div class="empty-actions">
        <button class="toolbar-action primary" @click="router.push('/settings')">
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">
            <path d="M2.5 3.5h3.5l1.2 1.2h4.3a1 1 0 0 1 1 1V11a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/>
          </svg>
          Choose folder…
        </button>
      </div>
      <div class="empty-divider"></div>
      <div class="empty-help">
        <div class="help-row">
          <span class="label">expected</span>
          <code>~/.claude</code>
        </div>
        <div class="help-row">
          <span class="label">searched</span>
          <code>{{ homePath }}</code>
        </div>
      </div>
    </div>

    <!-- Empty state: search returned nothing -->
    <div v-else-if="state.loaded && !catalogueLoading && !itemCount" class="empty">
      No sessions here.
      <span class="hint">{{ state.query ? 'Try a different search term.' : 'Press / to search.' }}</span>
    </div>

    <div v-else ref="scrollElement" class="session-scroll">
      <div class="session-list" :style="{ height: `${totalSize}px` }">
        <div v-for="item in virtualRows" :key="item.key" :data-index="item.index"
          class="virtual-row" :style="{ transform: `translateY(${item.start}px)` }">
          <template v-if="rowAt(item.index)">
            <div :class="['srow', { noise: item.index > totals.normal, cursor: state.cursorId === rowAt(item.index).id }]"
              :data-session-id="rowAt(item.index).id" @click="openSession(rowAt(item.index))">
              <div v-if="item.index < totals.normal" class="srow-obelisk" :style="obeliskStyle(rowAt(item.index))"></div>
              <div class="srow-body">
                <div class="srow-title" v-html="titleHTML(rowAt(item.index))"></div>
                <div class="srow-meta">
                  <template v-if="showProjectPrefix">
                    <span class="project-tag" v-html="projectLabel(rowAt(item.index))"></span>
                    <span class="dot"></span>
                  </template>
                  <span>{{ rowAt(item.index).message_count || 0 }} msg</span>
                </div>
              </div>
              <div class="srow-right">{{ timeLabel(rowAt(item.index)) }}</div>
            </div>
          </template>
          <div v-else-if="item.index === totals.normal" class="fold-banner" :class="{ expanded: showNoise }" @click="showNoise = !showNoise">
            <svg class="chev" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 2.5l3 3.5-3 3.5"/></svg>
            <div class="body"><strong>{{ totals.quiet }}</strong> quiet sessions hidden — untitled, likely tests or incomplete runs.</div>
            <span v-if="!showNoise" class="reveal-link">Show all</span>
          </div>
          <div v-else-if="item.index === totals.normal + 1" class="noise-group-head">{{ totals.quiet }} sessions · untitled</div>
          <button v-else-if="item.index === itemCount - 1" class="noise-fold-bottom" @click="showNoise = false">Collapse</button>
          <div v-else class="srow loading-row"></div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.session-list-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.session-scroll { flex: 1; min-height: 0; overflow-y: auto; }
.session-list { position: relative; }
.virtual-row { position: absolute; top: 0; left: 0; width: 100%; }
.srow { box-sizing: border-box; height: 72px; min-height: 0; overflow: hidden; }
.srow.noise { height: 64px; }
.fold-banner { box-sizing: border-box; height: 56px; }
.noise-group-head { box-sizing: border-box; height: 28px; }
.noise-fold-bottom { box-sizing: border-box; height: 40px; }

.srow {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: start;
  column-gap: 12px;
  padding: 12px 16px;
  min-height: var(--row-h-session);
  cursor: pointer;
  user-select: none;
  border-bottom: 1px solid var(--hairline);
  transition: background 0.06s;
  position: relative;
}
.srow:hover {
  background: rgba(255, 255, 255, 0.025);
}
.srow.cursor {
  background: var(--surface);
}
.srow.cursor::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--muted-2);
}

.srow-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.srow-title {
  font-size: var(--text-md);
  font-weight: 500;
  color: var(--fg);
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.srow-title :deep(mark) {
  background: var(--accent-soft);
  color: var(--accent-2);
  padding: 0 2px;
  border-radius: 2px;
}

.srow-meta {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.srow-meta .project-tag {
  color: var(--fg-2);
  font-weight: 500;
}
.srow-meta .dot {
  width: 2px;
  height: 2px;
  background: var(--muted-2);
  border-radius: 50%;
  flex-shrink: 0;
}

.srow-right {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--fg-2);
  text-align: right;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
  padding-top: 2px;
  white-space: nowrap;
}

.empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted-2);
  font-size: var(--text-sm);
  padding: 60px 20px;
  text-align: center;
  flex-direction: column;
  gap: 8px;
}
.empty .hint {
  font-size: 11px;
  color: var(--muted-2);
}

/* Onboarding empty state */
.empty-content {
  flex: 1;
  display: flex; flex-direction: column; gap: 16px;
  max-width: 520px;
  margin: 0 auto;
  justify-content: center;
  padding: 40px;
}
.empty-eyebrow {
  display: flex; align-items: center; gap: 8px;
  font-family: var(--font-mono); font-size: 11px;
  color: var(--muted); letter-spacing: 0.04em;
}
.empty-eyebrow .diamond {
  width: 6px; height: 6px;
  background: var(--accent, #a78bfa); transform: rotate(45deg);
  box-shadow: 0 0 6px rgba(167,139,250,0.4); flex-shrink: 0;
}
.empty-title {
  font-family: var(--font-serif, Georgia); font-size: 22px;
  font-weight: 500; color: var(--fg);
  letter-spacing: -0.015em; line-height: 1.2;
}
.empty-body {
  font-family: var(--font-serif, Georgia); font-style: italic;
  font-size: 14px; color: var(--fg-3); line-height: 1.6; max-width: 460px;
}
.empty-body code {
  font-family: var(--font-mono); font-style: normal; font-size: 12.5px;
  color: var(--accent-2, #c4b5fd); background: rgba(167,139,250,0.12);
  padding: 1px 6px; border-radius: 3px;
}
.empty-body strong { color: var(--fg); font-weight: 600; font-style: normal; }
.empty-body .inline-link {
  color: var(--accent-2, #c4b5fd); background: none;
  border: none; border-bottom: 1px solid rgba(167,139,250,0.4);
  padding: 0 0 1px; font: inherit; cursor: pointer; transition: all 0.12s;
}
.empty-body .inline-link:hover { color: var(--accent, #a78bfa); border-bottom-color: var(--accent); }
.empty-actions { display: flex; gap: 8px; margin-top: 6px; }
.empty-actions .toolbar-action {
  display: inline-flex; align-items: center; gap: 6px;
  height: 32px; padding: 0 14px; border-radius: 5px;
  font-size: 12px; font-weight: 500; cursor: pointer; transition: all 0.12s;
}
.empty-actions .toolbar-action.primary {
  border: 1px solid rgba(167,139,250,0.35); background: rgba(167,139,250,0.12); color: #c4b5fd;
}
.empty-actions .toolbar-action.primary:hover {
  background: rgba(167,139,250,0.18); border-color: #a78bfa; color: var(--fg);
  box-shadow: 0 0 12px rgba(167,139,250,0.2);
}
.empty-actions .toolbar-action svg { width: 13px; height: 13px; }
.empty-divider { width: 100%; height: 1px; background: var(--hairline); margin: 6px 0; }
.empty-help {
  display: flex; flex-direction: column; gap: 6px;
  font-family: var(--font-mono); font-size: 11px; color: var(--muted);
}
.empty-help .help-row { display: flex; align-items: baseline; gap: 8px; }
.empty-help .help-row .label { color: var(--muted-2); letter-spacing: 0.04em; width: 76px; flex-shrink: 0; }
.empty-help code {
  font-family: var(--font-mono); color: var(--fg-2);
  background: rgba(0,0,0,0.3); padding: 1px 6px; border-radius: 3px;
}

/* Noise fold */
.fold-banner {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 22px;
  background: rgba(255,255,255,0.015);
  border-top: 1px solid var(--hairline);
  border-bottom: 1px solid var(--hairline);
  font-size: 12.5px; color: var(--muted);
  cursor: pointer; transition: all 0.1s;
}
.fold-banner:hover { background: rgba(255,255,255,0.03); color: var(--fg-2); }
.fold-banner.expanded { color: var(--fg-3); background: rgba(255,255,255,0.02); }
.fold-banner .chev {
  width: 10px; height: 10px; color: var(--muted-2);
  transition: transform 0.15s; flex-shrink: 0;
}
.fold-banner.expanded .chev { transform: rotate(90deg); color: var(--accent-2); }
.fold-banner .body { flex: 1; }
.fold-banner .body strong {
  color: var(--fg-2); font-weight: 500;
  font-variant-numeric: tabular-nums;
  font-family: var(--font-mono); font-size: 11.5px;
}
.fold-banner .reveal-link {
  font-size: 11.5px; color: var(--accent-2);
  text-decoration: none; border-bottom: 1px solid rgba(167,139,250,0.4);
  padding-bottom: 1px; transition: all 0.12s; flex-shrink: 0;
}
.fold-banner:hover .reveal-link { color: var(--accent); border-bottom-color: var(--accent); }

.noise-group {
  border-bottom: 1px solid var(--hairline-strong);
  background: rgba(0,0,0,0.15);
}
.noise-group-head {
  padding: 6px 22px;
  font-family: var(--font-mono); font-size: 10px; color: var(--muted-2);
  letter-spacing: 0.06em; text-transform: uppercase;
  background: rgba(0,0,0,0.1); border-bottom: 1px solid var(--hairline);
}
.srow.noise { padding: 8px 22px 8px 18px; }
.srow.noise .srow-title {
  color: var(--muted); font-style: italic;
  font-size: 13px; font-weight: 400;
}
.srow.noise .srow-meta { color: var(--muted-2); }

.noise-fold-bottom {
  padding: 8px 22px; background: rgba(0,0,0,0.2);
  font-family: var(--font-mono); font-size: 11px; color: var(--muted);
  cursor: pointer; transition: all 0.1s;
  display: flex; align-items: center; gap: 8px;
  border-top: 1px solid var(--hairline);
  border: none; width: 100%; text-align: left;
}
.noise-fold-bottom:hover { background: rgba(0,0,0,0.3); color: var(--fg-2); }
.noise-fold-bottom .chev {
  width: 9px; height: 9px; color: var(--muted-2);
  transform: rotate(-90deg);
}
</style>
