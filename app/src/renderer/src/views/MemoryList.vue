<script setup>
import { computed, ref, nextTick, onMounted, onUnmounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { state, FOLDER_SVG, setSelection, clearSelection } from '../store.js';
import {
  highlightPlain,
  escapeHTML,
  formatProjectLabel,
  fmtListTime,
  fmtRelative,
  markdownSessionCandidates,
  renderMarkdown,
} from '../utils.js';
import { loadMemoryMarkdown, loadSessionsByIds, archiveMemory, restoreMemory } from '../data.js';
import { resolveMemoryShortcut } from '../keyboard-shortcuts.mjs';

defineOptions({ name: 'MemoryList' });
const props = defineProps({ id: String });

const router = useRouter();
const listWrapRef = ref(null);
const undoCountdown = ref(0);

// --- Filtered/sorted memories ---

const visibleMemories = computed(() => {
  const q = state.query.trim().toLowerCase();
  return state.memories
    .filter(m => {
      if (state.view === 'archived') return m.archived;
      return !m.archived;
    })
    .filter(m => state.projectFilter === 'all' || m.project === state.projectFilter)
    .filter(m => !q || (m.path || '').toLowerCase().includes(q) || (m.summary || '').toLowerCase().includes(q))
    .sort((a, b) => state.sortDesc ? b.ts - a.ts : a.ts - b.ts);
});

const showProjectPrefix = computed(() => state.projectFilter === 'all');

// --- Detail state ---

const detailMemory = computed(() => props.id ? state.memories.find(memory => memory.id === props.id) : null);
const detailMarkdown = ref(null);
const detailSessionReferences = ref(new Map());
const showSource = ref(false);
const loadingMarkdown = ref(false);

const showDetail = computed(() => Boolean(props.id));

// --- Row helpers ---

function dominantRowStatus(m) {
  if (m.health === 'broken') return 'broken';
  if (m.health === 'partial') return 'partial';
  if (m.archived) return 'archived';
  return null;
}

function statusGlyphs(status) {
  if (!status) return '';
  const map = {
    broken: `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 1.5l5.5 9.5h-11z M7 5v3M7 9.2v.6"/></svg>`,
    partial: `<svg viewBox="0 0 14 14" fill="currentColor"><circle cx="7" cy="7" r="3.5"/></svg>`,
    archived: `<svg viewBox="0 0 14 14" fill="currentColor"><circle cx="7" cy="7" r="2.5"/></svg>`
  };
  return map[status] || '';
}

function pathHTML(m) {
  const full = m.path || '';
  const filename = full.split('/').pop() || full;
  return highlightPlain(filename, state.query.trim());
}

function relativePath(m) {
  const full = m.path || '';
  if (!m.project) return full;
  const projectDir = '/' + m.project.replace(/^-/, '').replace(/-/g, '/');
  if (full.startsWith(projectDir)) {
    return full.slice(projectDir.length + 1);
  }
  return full.split('/').slice(-3).join('/');
}

function summaryHTML(m) {
  return highlightPlain(m.summary || '', state.query.trim());
}

function sourceSessionTitle(m) {
  if (!m.session_id) return '';
  const s = state.sessions.find(x => x.id === m.session_id);
  return s?.title?.trim() || m.session_id;
}

function openSourceSession(m) {
  if (!m.session_id) return;
  if (m.message_start) {
    router.push({ path: `/sessions/${m.session_id}`, query: { focus: m.message_start } });
  } else {
    router.push(`/sessions/${m.session_id}`);
  }
}

function timeLabel(m) {
  return fmtListTime(m.ts);
}

function projectLabel(m) {
  return escapeHTML(formatProjectLabel(m.project));
}

// --- Selection ---

function toggleSelection(id, { range = false } = {}) {
  const s = new Set(state.selection);
  if (range && state.cursorId) {
    const ids = visibleMemories.value.map(memory => memory.id);
    const from = ids.indexOf(state.cursorId);
    const to = ids.indexOf(id);
    if (from !== -1 && to !== -1) {
      const [start, end] = from < to ? [from, to] : [to, from];
      for (let index = start; index <= end; index++) s.add(ids[index]);
    }
  } else if (s.has(id)) {
    s.delete(id);
  } else {
    s.add(id);
  }
  state.cursorId = id;
  setSelection(s);
}

// --- Cursor navigation ---

function moveCursor(direction, extendSelection = false) {
  const items = visibleMemories.value;
  if (!items.length) return;
  const previousId = state.cursorId;
  const curIdx = items.findIndex(m => m.id === state.cursorId);
  let next;
  if (curIdx === -1) {
    next = 0;
  } else {
    next = curIdx + direction;
    if (next < 0) next = 0;
    if (next >= items.length) next = items.length - 1;
  }
  const nextId = items[next].id;
  if (extendSelection && previousId) {
    setSelection([...state.selection, previousId, nextId]);
  }
  state.cursorId = nextId;
  nextTick(() => ensureVisible());
}

function ensureVisible() {
  if (!listWrapRef.value || !state.cursorId) return;
  const cursorEl = listWrapRef.value.querySelector(`.row[data-id="${state.cursorId}"]`);
  if (!cursorEl) return;
  const elRect = cursorEl.getBoundingClientRect();
  const wrapRect = listWrapRef.value.getBoundingClientRect();
  if (elRect.top < wrapRect.top + 30) {
    listWrapRef.value.scrollTop -= (wrapRect.top + 30 - elRect.top);
  } else if (elRect.bottom > wrapRect.bottom - 10) {
    listWrapRef.value.scrollTop += (elRect.bottom - wrapRect.bottom + 10);
  }
}

// --- Open detail ---

let detailLoadVersion = 0;
async function loadDetail(memory) {
  const version = ++detailLoadVersion;
  showSource.value = false;
  detailMarkdown.value = null;
  detailSessionReferences.value = new Map();
  loadingMarkdown.value = Boolean(memory);

  if (memory?.markdown == null && memory.path) {
    memory.markdown = await loadMemoryMarkdown(memory.path);
  }
  if (version !== detailLoadVersion) return;
  const markdown = memory?.markdown ?? null;
  const referenceIds = markdownSessionCandidates(markdown);
  const sessions = await loadSessionsByIds(referenceIds);
  if (version !== detailLoadVersion) return;
  detailSessionReferences.value = new Map(sessions.map(session => [session.id, session]));
  detailMarkdown.value = markdown;
  loadingMarkdown.value = false;
}

watch(detailMemory, loadDetail, { immediate: true });

function openDetail(m) {
  router.push({ name: 'MemoryDetail', params: { id: m.id } });
}

function closeDetail() {
  router.push({ name: 'MemoryList' });
}

function toggleSourceView() {
  showSource.value = !showSource.value;
}

// --- Row click ---

function onRowClick(m, event) {
  if (event.shiftKey || event.metaKey || event.ctrlKey) {
    toggleSelection(m.id, { range: event.shiftKey });
    return;
  }
  state.cursorId = m.id;
  openDetail(m);
}

// --- Archive/restore with undo ---

const undoSnapshot = ref(null);
let undoTimer = null;

async function mutateMemories(ids, action) {
  const targets = ids || (state.cursorId ? [state.cursorId] : []);
  if (!targets.length) return;
  undoSnapshot.value = { action, ids: [...targets] };
  undoCountdown.value = 5;
  for (const id of targets) {
    if (action === 'archive') await archiveMemory(id);
    else await restoreMemory(id);
  }
  clearSelection();
  startUndoTimer();
  if (targets.includes(state.cursorId)) {
    const items = visibleMemories.value;
    if (items.length) state.cursorId = items[0].id;
    else state.cursorId = null;
  }
  if (showDetail.value && targets.includes(detailMemory.value?.id)) {
    closeDetail();
  }
}

const doArchive = (ids) => mutateMemories(ids, 'archive');
const doRestore = (ids) => mutateMemories(ids, 'restore');

async function undoAction() {
  if (!undoSnapshot.value) return;
  const { action, ids } = undoSnapshot.value;
  for (const id of ids) {
    if (action === 'archive') await restoreMemory(id);
    else await archiveMemory(id);
  }
  undoSnapshot.value = null;
  undoCountdown.value = 0;
  if (undoTimer) { clearInterval(undoTimer); undoTimer = null; }
}

function startUndoTimer() {
  if (undoTimer) clearInterval(undoTimer);
  undoCountdown.value = 5;
  undoTimer = setInterval(() => {
    undoCountdown.value--;
    if (undoCountdown.value <= 0) {
      clearInterval(undoTimer);
      undoTimer = null;
      undoSnapshot.value = null;
    }
  }, 1000);
}

// --- Detail action ---

function detailArchiveRestore() {
  if (!detailMemory.value) return;
  if (detailMemory.value.archived) {
    doRestore([detailMemory.value.id]);
  } else {
    doArchive([detailMemory.value.id]);
  }
}

// --- Detail markdown rendering ---

const renderedMarkdown = computed(() => {
  if (detailMarkdown.value == null) return null;
  if (showSource.value) return null; // handled by pre block in template
  return renderMarkdown(detailMarkdown.value, {
    variant: 'body',
    sessionReferences: detailSessionReferences.value,
  });
});

function openMarkdownSession(event) {
  const link = event.target instanceof Element
    ? event.target.closest('[data-session-id]')
    : null;
  if (!link) return;
  event.preventDefault();
  const sessionId = link.dataset.sessionId;
  if (sessionId) router.push({ name: 'SessionDetail', params: { id: sessionId } });
}

// --- Keyboard handler ---

function onKeydown(e) {
  const tagName = e.target?.tagName;
  const command = resolveMemoryShortcut(e, {
    isTextInput: tagName === 'INPUT' || tagName === 'TEXTAREA' || e.target?.isContentEditable,
    showDetail: showDetail.value,
    hasUndo: Boolean(undoSnapshot.value),
    hasCursor: Boolean(state.cursorId),
  });
  if (!command) return;

  e.preventDefault();
  if (command.type === 'move-cursor') moveCursor(command.direction, command.extend);
  else if (command.type === 'open-detail') {
    const memory = visibleMemories.value.find(item => item.id === state.cursorId);
    if (memory) openDetail(memory);
  } else if (command.type === 'toggle-selection') toggleSelection(state.cursorId);
  else if (command.type === 'mutate-selection') {
    const targets = state.selection.size ? [...state.selection] : (state.cursorId ? [state.cursorId] : []);
    if (state.view === 'archived') doRestore(targets);
    else doArchive(targets);
  } else if (command.type === 'undo') undoAction();
  else if (command.type === 'close-detail') closeDetail();
  else if (command.type === 'mutate-detail') detailArchiveRestore();
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown);
});

onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown);
  if (undoTimer) { clearInterval(undoTimer); undoTimer = null; }
});
</script>

<template>
  <!-- Detail panel overlay -->
  <div v-if="showDetail" class="detail-wrap">
    <div v-if="detailMemory" class="detail">
      <div class="detail-header">
        <div class="detail-eyebrow">
          <span class="project-icon" v-html="FOLDER_SVG"></span>
          <span class="project-name">{{ formatProjectLabel(detailMemory.project) }}</span>
          <span v-if="detailMemory.archived" class="archived-tag">archived</span>
        </div>
        <div class="detail-path">{{ relativePath(detailMemory) }}</div>
        <div class="detail-summary">{{ detailMemory.summary }}</div>
        <div class="detail-meta">
          <button
            v-if="detailMemory.session_id"
            class="session-link"
            :title="`Session ID: ${detailMemory.session_id}`"
            :aria-label="`Open session: ${sourceSessionTitle(detailMemory)}`"
            @click="openSourceSession(detailMemory)"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">
              <path d="M3 4h10v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4z"/>
              <path d="M5.5 7h5M5.5 9.5h3" stroke-linecap="round"/>
            </svg>
            <span>{{ sourceSessionTitle(detailMemory) }}</span>
          </button>
          <span v-if="detailMemory.session_id" class="dot"></span>
          <span>{{ fmtRelative(detailMemory.ts) }}</span>
          <template v-if="detailMemory.message_start">
            <span class="dot"></span>
            <span class="message-range">
              {{ detailMemory.message_start.slice(0, 8) }}…→ {{ (detailMemory.message_end || '').slice(0, 8) }}…
            </span>
          </template>
        </div>
      </div>

      <div class="markdown-section">
        <div class="markdown-toolbar">
          <span class="markdown-toolbar-label">Body</span>
          <button
            class="source-toggle"
            :class="{ active: showSource }"
            :disabled="detailMarkdown == null"
            @click="toggleSourceView"
          >
            {{ showSource ? 'Show rendered' : 'Show source' }}
          </button>
        </div>

        <div v-if="loadingMarkdown" class="markdown-loading">Loading...</div>
        <div v-else-if="detailMarkdown == null" class="markdown-empty">
          File not found or empty.
        </div>
        <pre v-else-if="showSource" class="markdown-source">{{ detailMarkdown }}</pre>
        <div v-else class="markdown-body" @click="openMarkdownSession" v-html="renderedMarkdown"></div>
      </div>

      <div v-if="detailMemory.anchors?.length" class="detail-section-divider" id="anchors-section">
        <span>Anchors</span><span class="count">{{ detailMemory.anchors.length }}</span>
      </div>
      <div v-if="detailMemory.anchors?.length" class="anchor-list">
        <button
          v-for="anchor in detailMemory.anchors"
          :key="`${anchor.path}:${anchor.line}`"
          class="anchor-link"
          :disabled="anchor.exists === false"
          :title="anchor.exists === false ? 'File no longer exists' : 'Open in editor'"
        >
          <span class="anchor-icon">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round">
              <path d="M3.5 2h6l3 3v9a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/>
              <path d="M9.5 2v3h3"/>
            </svg>
          </span>
          <span class="anchor-path">{{ anchor.path }}</span>
          <span v-if="anchor.line" class="anchor-line">:{{ anchor.line }}</span>
        </button>
      </div>

      <div class="detail-actions">
        <button class="btn" @click="closeDetail">
          Back<span class="kbd">Esc</span>
        </button>
        <button
          class="btn"
          :class="detailMemory.archived ? 'primary' : 'danger'"
          @click="detailArchiveRestore"
        >
          {{ detailMemory.archived ? 'Restore' : 'Archive' }}<span class="kbd">D</span>
        </button>
      </div>
    </div>
    <div v-else class="empty">{{ state.loaded ? 'Memory not found.' : 'Loading...' }}</div>
  </div>

  <!-- List panel -->
  <div v-else ref="listWrapRef" class="list-wrap">
    <div v-if="!visibleMemories.length" class="empty">
      No memories{{ state.view === 'archived' ? ' archived' : '' }} here.
      <span class="hint">{{ state.query ? 'Try a different search term.' : 'Press / to search.' }}</span>
    </div>

    <div v-else class="memory-list">
      <div
        v-for="m in visibleMemories"
        :key="m.id"
        class="row"
        :class="{
          cursor: state.cursorId === m.id,
          selected: state.selection.has(m.id),
          archived: m.archived
        }"
        :data-id="m.id"
        @click="onRowClick(m, $event)"
      >
        <button
          class="row-checkbox"
          :class="{ checked: state.selection.has(m.id) }"
          aria-label="Select"
          @click.stop="toggleSelection(m.id, { range: $event.shiftKey })"
        >
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
            <path d="M2.5 6.5l2.5 2.5 4.5-5"/>
          </svg>
        </button>

        <div class="row-body">
          <div class="row-path">
            <span
              v-if="dominantRowStatus(m)"
              class="row-status"
              :class="dominantRowStatus(m)"
              :title="dominantRowStatus(m)"
              v-html="statusGlyphs(dominantRowStatus(m))"
            ></span>
            <template v-if="showProjectPrefix">
              <span class="project-prefix" v-html="projectLabel(m)"></span>
              <span class="project-prefix-sep">/</span>
            </template>
            <span class="path-text" v-html="pathHTML(m)"></span>
          </div>
          <div class="row-summary" v-html="summaryHTML(m)"></div>
        </div>

        <div class="row-right">
          <div class="row-meta"><span>{{ timeLabel(m) }}</span></div>
          <div class="row-actions">
            <button
              v-if="m.archived"
              class="row-action restore"
              @click.stop="doRestore([m.id])"
            >
              Restore<span class="kbd">D</span>
            </button>
            <button
              v-else
              class="row-action danger"
              @click.stop="doArchive([m.id])"
            >
              Archive<span class="kbd">D</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Undo toast -->
    <Transition name="undo-fade">
      <div v-if="undoSnapshot" class="undo-toast" @click="undoAction">
        {{ undoSnapshot.action === 'archive' ? 'Archived' : 'Restored' }}
        {{ undoSnapshot.ids.length }} memory{{ undoSnapshot.ids.length > 1 ? 'ies' : '' }}.
        <button class="undo-btn">Undo ({{ undoCountdown }}s)</button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.list-wrap {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  position: relative;
}

.detail-wrap {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.detail {
  max-width: 720px;
  margin: 0 auto;
  padding: 32px 32px 60px;
}

.memory-list {
  display: flex;
  flex-direction: column;
}

/* Row styles */
.row {
  display: grid;
  grid-template-columns: 22px 1fr auto;
  align-items: start;
  column-gap: 12px;
  padding: 14px 16px 14px 14px;
  min-height: var(--row-h, 60px);
  cursor: pointer;
  user-select: none;
  border-bottom: 1px solid var(--hairline);
  transition: background 0.06s;
  position: relative;
}
.row:last-child { border-bottom: 0; }
.row:hover { background: rgba(255,255,255,0.025); }
.row.cursor { background: var(--surface); }
.row.cursor::before {
  content: '';
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 2px;
  background: var(--muted-2);
}
.row.selected { background: var(--accent-soft); }
.row.selected::before {
  content: '';
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 2px;
  background: var(--accent);
  box-shadow: 0 0 12px var(--accent-glow);
}
.row.cursor.selected { background: rgba(167,139,250,0.16); }

.row-checkbox {
  width: 18px; height: 18px; margin-top: 1px;
  border-radius: 4px;
  border: 1.5px solid var(--muted-2);
  background: transparent;
  cursor: pointer;
  display: grid;
  place-items: center;
  opacity: 0;
  transition: all 0.1s;
  justify-self: center;
}
.row:hover .row-checkbox,
.row.selected .row-checkbox,
.row.cursor .row-checkbox { opacity: 1; }
.row-checkbox:hover { border-color: var(--accent); }
.row-checkbox.checked {
  background: var(--accent);
  border-color: var(--accent);
  box-shadow: 0 0 8px var(--accent-glow);
}
.row-checkbox svg { width: 10px; height: 10px; color: #0a0b14; opacity: 0; }
.row-checkbox.checked svg { opacity: 1; }

.row-body { min-width: 0; display: flex; flex-direction: column; gap: 6px; }

.row-path {
  font-family: var(--font-mono);
  font-size: var(--text-md);
  font-weight: 500;
  color: var(--fg);
  line-height: 1.4;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.row-status {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px; height: 14px;
  flex-shrink: 0;
}
.row-status :deep(svg) { width: 100%; height: 100%; }
.row-status.broken { color: var(--danger); }
.row-status.partial { color: var(--warn); }
.row-status.archived { color: var(--muted-2); }

.row-path .project-prefix { color: var(--muted); font-weight: 400; flex-shrink: 0; }
.row-path .project-prefix-sep { color: var(--muted-2); margin: 0 2px; flex-shrink: 0; }
.row-path .path-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.row-path :deep(mark), .row-summary :deep(mark) {
  background: var(--accent-soft);
  color: var(--accent-2);
  padding: 0 2px;
  border-radius: 2px;
}

.row-summary {
  font-size: var(--text-base);
  color: var(--fg-2);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}

.row-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
  flex-shrink: 0;
  padding-top: 1px;
}

.row-meta {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--muted);
  letter-spacing: 0.02em;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  display: flex;
  gap: 8px;
}
.row:hover .row-meta { color: var(--muted-2); }

.row-actions { display: flex; gap: 4px; opacity: 0; transition: opacity 0.1s; }
.row:hover .row-actions, .row.cursor .row-actions { opacity: 1; }

.row-action {
  height: 24px; padding: 0 8px; border-radius: 4px;
  color: var(--muted); font-size: var(--text-sm);
  display: inline-flex; align-items: center; gap: 5px;
  transition: all 0.1s; border: 1px solid transparent;
  background: transparent; cursor: pointer;
}
.row-action:hover { background: var(--surface-hi); color: var(--fg); border-color: var(--hairline-strong); }
.row-action.danger:hover { background: var(--danger-soft); color: var(--danger); border-color: rgba(248,113,113,0.3); }
.row-action.restore { color: var(--accent-2); }
.row-action.restore:hover { background: var(--accent-soft); color: var(--fg); border-color: var(--accent-soft); }
.row-action .kbd {
  font-family: var(--font-mono); font-size: 9.5px; color: var(--muted-2);
  padding: 0 3px; border: 1px solid var(--hairline); border-radius: 2px; line-height: 1.4;
}
.row-action:hover .kbd { color: var(--fg-2); border-color: var(--hairline-strong); }

.row.archived .row-path, .row.archived .row-summary { color: var(--muted); }
.row.archived .row-path .project-prefix { color: var(--muted-2); }

/* Empty state */
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
.empty .hint { font-size: 11px; color: var(--muted-2); }

/* Detail panel styles */
.detail-header { margin-bottom: 24px; }
.detail-eyebrow {
  display: flex; align-items: center; gap: 6px;
  font-size: 11px; color: var(--muted);
  margin-bottom: 14px; flex-wrap: wrap;
}
.detail-eyebrow .project-icon { width: 13px; height: 13px; color: var(--muted); display: inline-flex; }
.detail-eyebrow .project-icon :deep(svg) { width: 100%; height: 100%; }
.detail-eyebrow .project-name { color: var(--fg-2); font-weight: 500; }
.detail-eyebrow .archived-tag {
  color: var(--accent-2);
  display: inline-flex; align-items: center; gap: 5px;
  margin-left: auto;
}
.detail-eyebrow .archived-tag::before {
  content: ''; width: 6px; height: 6px; border-radius: 50%;
  background: var(--accent); box-shadow: 0 0 6px var(--accent-glow);
}
.detail-path {
  font-family: var(--font-mono); font-size: 17px; font-weight: 500;
  color: var(--fg); line-height: 1.5;
  word-break: break-all; margin-bottom: 16px;
}
.detail-summary { font-size: var(--text-md); color: var(--fg-2); line-height: 1.6; margin-bottom: 16px; }
.detail-meta {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  font-family: var(--font-mono); font-size: var(--text-sm);
  color: var(--muted); font-variant-numeric: tabular-nums;
  padding-bottom: 16px; border-bottom: 1px solid var(--hairline);
}
.detail-meta .dot { width: 2px; height: 2px; background: var(--muted-2); border-radius: 50%; flex-shrink: 0; }
.message-range { font-size: 11px; }
.session-link {
  color: var(--accent-2); border: 0; background: transparent;
  padding: 2px 5px; margin: -2px 0; border-radius: 3px;
  font: inherit; cursor: pointer; transition: all 0.1s;
  text-decoration: underline; text-decoration-color: rgba(167,139,250,0.25);
  text-underline-offset: 3px;
  display: inline-flex; align-items: center; gap: 5px;
}
.session-link:hover { background: rgba(167,139,250,0.12); color: var(--accent-2); text-decoration-color: var(--accent-2); }
.session-link svg { width: 11px; height: 11px; }

.markdown-section { margin: 28px 0 8px; }
.markdown-toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.markdown-toolbar-label {
  font-size: 10.5px; color: var(--muted);
  font-weight: 500; letter-spacing: 0.04em; flex: 1;
}
.source-toggle {
  height: 22px; padding: 0 8px; border-radius: 4px;
  border: 1px solid var(--hairline-strong); background: var(--surface);
  color: var(--muted); font-size: var(--text-sm);
  transition: all 0.1s; cursor: pointer;
}
.source-toggle:hover { background: var(--surface-strong); color: var(--fg-2); }
.source-toggle.active { background: var(--accent-soft); color: var(--accent-2); border-color: var(--accent-soft); }
.source-toggle:disabled { opacity: 0.4; cursor: not-allowed; }

.markdown-loading {
  color: var(--muted-2); font-style: italic; padding: 20px; text-align: center;
}
.markdown-empty {
  color: var(--muted-2); font-style: italic; padding: 20px; text-align: center;
  border: 1px dashed var(--hairline); border-radius: 6px;
}
.markdown-source {
  background: rgba(0,0,0,0.3); border: 1px solid var(--hairline);
  border-radius: 6px; padding: 14px 16px;
  font-family: var(--font-mono); font-size: 12px; line-height: 1.55;
  color: var(--fg-2); white-space: pre-wrap; word-wrap: break-word;
}

.detail-actions { margin-top: 32px; display: flex; justify-content: flex-end; gap: 8px; }
.detail-actions .btn {
  height: 30px; padding: 0 14px; border-radius: 6px;
  font-size: var(--text-base); font-weight: 500;
  transition: all 0.1s;
  display: inline-flex; align-items: center; gap: 8px;
  border: 1px solid var(--hairline-strong);
  color: var(--fg-2); background: var(--surface);
  cursor: pointer;
}
.detail-actions .btn:hover { background: var(--surface-strong); color: var(--fg); }
.detail-actions .btn.danger { color: var(--danger); }
.detail-actions .btn.danger:hover { background: var(--danger-soft); border-color: rgba(248,113,113,0.3); }
.detail-actions .btn.primary { color: var(--accent-2); }
.detail-actions .btn.primary:hover { background: var(--accent-soft); border-color: var(--accent-soft); color: var(--fg); }
.detail-actions .btn .kbd {
  font-family: var(--font-mono); font-size: 10px; color: var(--muted-2);
  padding: 0 4px; border: 1px solid var(--hairline); border-radius: 3px;
  line-height: 1.4;
}

/* Undo toast */
.undo-toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--surface-strong);
  border: 1px solid var(--hairline-strong);
  border-radius: 8px;
  padding: 10px 16px;
  font-size: var(--text-sm);
  color: var(--fg-2);
  display: flex;
  align-items: center;
  gap: 12px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.4);
  z-index: 100;
  cursor: pointer;
}
.undo-btn {
  background: var(--accent-soft);
  border: 1px solid rgba(167,139,250,0.3);
  border-radius: 4px;
  padding: 3px 10px;
  font-size: var(--text-sm);
  color: var(--accent-2);
  cursor: pointer;
  transition: all 0.1s;
  font-family: var(--font-mono);
}
.undo-btn:hover { background: rgba(167,139,250,0.25); border-color: var(--accent); }

.undo-fade-enter-active, .undo-fade-leave-active { transition: opacity 0.2s, transform 0.2s; }
.undo-fade-enter-from, .undo-fade-leave-to { opacity: 0; transform: translateX(-50%) translateY(10px); }
</style>
