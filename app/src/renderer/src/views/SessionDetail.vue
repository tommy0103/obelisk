<!-- Copyright (C) 2026 tommy0103 and contributors. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

<script setup>
import { ref, shallowRef, computed, reactive, onMounted, onBeforeUnmount, onUnmounted, nextTick, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { state, FOLDER_SVG, getSessionSummary } from '../store.js';
import {
  fetchSessionDetailPatch,
  getCachedSessionDetail,
  loadSessionDetail,
  loadFullText,
  materializeSessionDetailPatch,
} from '../data.js';
import { clearSessionDirty, consumeGlobalSessionDirty, markSessionDirty } from '../session-live.mjs';
import { applySnapshot } from '../session-timeline.mjs';
import { reconcileTimelineItems } from '../session-timeline-items.mjs';
import { createSessionDisclosureState } from '../session-disclosures.mjs';
import { createSessionLiveReloadCoordinator } from '../session-live-reload.mjs';
import { createSessionUserScroll } from '../session-user-scroll.mjs';
import { useSessionTimelineViewport } from '../session-timeline-viewport.mjs';
import { sessionReaderStateCache } from '../session-reader-state.mjs';
import FlapNumber from '../components/FlapNumber.vue';
import SessionTimelineRow from '../components/SessionTimelineRow.vue';
import {
  fmtRelative,
  formatProjectLabel
} from '../utils.js';
import { sourceColor, sourceLabel } from '../source-catalog.mjs';

defineOptions({ name: 'SessionDetail' });
const props = defineProps({ id: String });

const router = useRouter();
const route = useRoute();

// --- Reactive state ---
const liveSessionMetadata = shallowRef(null);
const session = computed(() => (
  liveSessionMetadata.value || getSessionSummary(props.id)
));
const messages = shallowRef([]);
const timelineItems = shallowRef([]);
const loading = ref(false);
const timelineReady = ref(false);
const progressPct = ref(0);
const active = ref(false);
const focusedItemKey = ref(null);
const pendingFocusUuid = ref(
  typeof route.query.focus === 'string' ? route.query.focus : null,
);
const expandedMessageText = reactive(new Map());
const fullTextLoading = reactive(new Set());
let removeSessionUpdated = null;
let keydownAttached = false;
let focusTimer = null;
let loadRevision = 0;
let pendingReaderState = sessionReaderStateCache.get(props.id);
let readerStatePrepared = false;

// DOM refs
const wrapRef = ref(null);
const timelineRef = ref(null);
const headerRef = ref(null);
const timelineScrollMargin = ref(0);
const disclosures = createSessionDisclosureState();
let headerResizeObserver = null;
const NAV_HEIGHT = 52;
const userScroll = createSessionUserScroll({ onEnd: handleUserScrollEnd });

const timelineViewport = useSessionTimelineViewport({
  items: timelineItems,
  scrollElement: wrapRef,
  timelineElement: timelineRef,
  scrollMargin: timelineScrollMargin,
  scrollPaddingEnd: NAV_HEIGHT,
  userScroll,
});
const {
  virtualRows,
  totalSize,
  measureElement,
  settleAfterUserScroll,
  waitForStableLayout,
} = timelineViewport;
const liveReloadCoordinator = createSessionLiveReloadCoordinator({
  isScrolling: () => userScroll.isActive(),
  load: loadLiveSnapshot,
  commit: commitLiveSnapshot,
});

async function handleUserScrollEnd() {
  if (!active.value) return;
  await settleAfterUserScroll(() => (
    active.value ? liveReloadCoordinator.flush() : Promise.resolve()
  ));
}

function syncTimelineScrollMargin() {
  timelineScrollMargin.value = timelineRef.value?.offsetTop || 0;
}

function observeSessionHeader() {
  headerResizeObserver?.disconnect();
  headerResizeObserver = null;
  if (!headerRef.value || typeof ResizeObserver === 'undefined') return;
  headerResizeObserver = new ResizeObserver(syncTimelineScrollMargin);
  headerResizeObserver.observe(headerRef.value);
}

function saveReaderState(sessionId = props.id) {
  if (!timelineReady.value || !sessionId || timelineItems.value.length === 0) return;
  sessionReaderStateCache.set(sessionId, {
    ...timelineViewport.captureReaderPosition(),
    disclosures: disclosures.snapshot(),
    expandedMessageIds: [...expandedMessageText.keys()],
  });
}

async function prepareReaderState(messageUuids) {
  if (readerStatePrepared || !pendingReaderState) return;
  disclosures.restore(pendingReaderState.disclosures, messageUuids);
  const expandedIds = pendingReaderState.expandedMessageIds
    .filter(messageUuid => messageUuids.has(messageUuid));
  await Promise.all(expandedIds.map(messageUuid => handleLoadFullText(messageUuid)));
  readerStatePrepared = true;
}

async function restoreReaderStateAfterLayout() {
  const explicitFocus = Boolean(pendingFocusUuid.value);
  if (explicitFocus) {
    await focusPendingMessage();
  } else if (pendingReaderState) {
    userScroll.clearUpwardIntent();
    await timelineViewport.restoreReaderPosition(pendingReaderState);
  }
  updateScrollProgress();
  pendingReaderState = null;
  readerStatePrepared = false;
}

// --- Load session on mount or when id changes ---
const FONT_SIZE_KEY = 'obelisk:session-font-size';
const FONT_SIZES = [12, 13, 14, 15, 16, 18];
const fontSizeIdx = ref(FONT_SIZES.indexOf(parseInt(localStorage.getItem(FONT_SIZE_KEY)) || 14));
if (fontSizeIdx.value < 0) fontSizeIdx.value = 2;
const fontSize = computed(() => FONT_SIZES[fontSizeIdx.value] + 'px');

function adjustFont(delta) {
  const next = fontSizeIdx.value + delta;
  if (next >= 0 && next < FONT_SIZES.length) {
    fontSizeIdx.value = next;
    localStorage.setItem(FONT_SIZE_KEY, FONT_SIZES[next]);
  }
}

function handleZoom(e) {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key === '=' || e.key === '+') {
    e.preventDefault();
    if (fontSizeIdx.value < FONT_SIZES.length - 1) fontSizeIdx.value++;
    localStorage.setItem(FONT_SIZE_KEY, FONT_SIZES[fontSizeIdx.value]);
  } else if (e.key === '-') {
    e.preventDefault();
    if (fontSizeIdx.value > 0) fontSizeIdx.value--;
    localStorage.setItem(FONT_SIZE_KEY, FONT_SIZES[fontSizeIdx.value]);
  } else if (e.key === '0') {
    e.preventDefault();
    fontSizeIdx.value = 2;
    localStorage.setItem(FONT_SIZE_KEY, FONT_SIZES[fontSizeIdx.value]);
  }
}

function attachKeydown() {
  if (keydownAttached) return;
  window.addEventListener('keydown', handleZoom);
  keydownAttached = true;
}

function detachKeydown() {
  if (!keydownAttached) return;
  window.removeEventListener('keydown', handleZoom);
  keydownAttached = false;
}

const HINT_KEY = 'obelisk:font-hint-shown';
const showFontHint = ref(false);

onMounted(async () => {
  active.value = true;
  userScroll.attach(wrapRef.value);
  attachKeydown();
  removeSessionUpdated = window.obelisk?.onSessionUpdated?.(({ sessionId } = {}) => {
    if (!active.value || !props.id || sessionId !== props.id) return;
    void liveReloadCoordinator.request();
  }) || null;
  if (!localStorage.getItem(HINT_KEY)) {
    showFontHint.value = true;
    localStorage.setItem(HINT_KEY, '1');
    setTimeout(() => { showFontHint.value = false; }, 4000);
  }
  await loadMessages({ force: consumeGlobalSessionDirty(props.id) });
  await nextTick();
  syncTimelineScrollMargin();
  observeSessionHeader();
});

onBeforeUnmount(() => {
  saveReaderState();
});

onUnmounted(() => {
  active.value = false;
  loadRevision++;
  detachKeydown();
  if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
  scrollFrame = null;
  if (focusTimer !== null) clearTimeout(focusTimer);
  focusTimer = null;
  headerResizeObserver?.disconnect();
  headerResizeObserver = null;
  userScroll.detach();
  liveReloadCoordinator.stop();
  removeSessionUpdated?.();
  removeSessionUpdated = null;
});

watch(() => session.value?.id, async sessionId => {
  if (sessionId === props.id && messages.value.length === 0) {
    await loadMessages({ force: true });
  }
});

watch(() => route.query.focus, async focus => {
  pendingFocusUuid.value = typeof focus === 'string' ? focus : null;
  if (
    !pendingFocusUuid.value
    || String(route.params.id || '') !== props.id
    || !timelineReady.value
  ) return;
  await focusPendingMessage();
});

async function loadMessages({ force = false } = {}) {
  const requestedSessionId = props.id;
  if (!requestedSessionId) return;
  const revision = ++loadRevision;
  const hadContent = messages.value.length > 0;
  let committed = false;

  loading.value = !hadContent;
  if (!hadContent) timelineReady.value = false;
  try {
    const latest = await fetchSessionSnapshot(requestedSessionId, { force });
    if (revision !== loadRevision || requestedSessionId !== props.id) return;
    await commitSessionSnapshot(latest);
    committed = true;
  } finally {
    if (revision === loadRevision) {
      loading.value = false;
      if (!committed) timelineReady.value = true;
    }
  }
  if (!hadContent) await revealColdTimeline(revision, requestedSessionId);
}

async function revealColdTimeline(revision, sessionId) {
  await nextTick();
  if (revision !== loadRevision || sessionId !== props.id) return;
  syncTimelineScrollMargin();
  if (timelineItems.value.length === 0) {
    pendingReaderState = null;
    readerStatePrepared = false;
    timelineReady.value = true;
    return;
  }

  await waitForStableLayout({
    isCurrent: () => revision === loadRevision && sessionId === props.id,
  });
  if (revision !== loadRevision || sessionId !== props.id) return;
  await restoreReaderStateAfterLayout();
  if (revision !== loadRevision || sessionId !== props.id) return;
  timelineReady.value = true;
}

async function fetchSessionSnapshot(sessionId, { force = false } = {}) {
  const messageSnapshot = force ? null : getCachedSessionDetail(sessionId);
  if (messageSnapshot) return messageSnapshot;
  const cached = state.sessions.find(session => session.id === sessionId);
  if (cached && (force || !cached.messages || cached.messages.length === 0)) {
    return loadSessionDetail(sessionId);
  }
  return cached;
}

async function loadLiveSnapshot() {
  const sessionId = props.id;
  if (!sessionId) return null;
  // Live reload ordering is owned by the coordinator. Capture the current
  // full-load generation so a patch cannot invalidate cold-open layout work.
  const revision = loadRevision;
  const patchRequest = await fetchSessionDetailPatch(sessionId);
  return { sessionId, revision, patchRequest };
}

async function commitLiveSnapshot(snapshot) {
  if (snapshot.revision !== loadRevision || snapshot.sessionId !== props.id) {
    markSessionDirty(snapshot.sessionId);
    return;
  }
  const latest = await materializeSessionDetailPatch(snapshot.patchRequest);
  if (snapshot.revision !== loadRevision || snapshot.sessionId !== props.id) {
    markSessionDirty(snapshot.sessionId);
    return;
  }
  await commitSessionSnapshot(latest);
  const accepted = latest?.acceptMessagePatch?.() ?? true;
  if (accepted) clearSessionDirty(snapshot.sessionId);
  else markSessionDirty(snapshot.sessionId);
}

async function commitSessionSnapshot(latest) {
  // The route can mount before the initial session list arrives. Keep
  // first-snapshot tail following disabled until an actual session exists.
  if (!latest) return;
  liveSessionMetadata.value = latest;
  const incoming = latest?.messages || [];
  const tailPatch = latest.messagePatch?.tailOnly
    ? {
        messages: incoming,
        addedIds: latest.messagePatch.changedIds,
        updatedIds: [],
        removedIds: [],
        changed: true,
        tailOnly: true,
      }
    : null;
  const reconciliation = tailPatch || applySnapshot(messages.value, incoming);
  const restoreTail = reconciliation.tailOnly
    && !userScroll.hasUpwardIntent()
    && timelineViewport.isFollowingTail();
  if (reconciliation.changed) {
    messages.value = reconciliation.messages;
    if (tailPatch) {
      const addedMessages = reconciliation.messages.slice(
        reconciliation.messages.length - reconciliation.addedIds.length,
      );
      timelineItems.value = [
        ...timelineItems.value,
        ...reconcileTimelineItems([], addedMessages),
      ];
    } else {
      timelineItems.value = reconcileTimelineItems(timelineItems.value, reconciliation.messages);
      const retainedMessageUuids = new Set(reconciliation.messages.map(message => message.uuid));
      disclosures.retainMessages(retainedMessageUuids);
      for (const uuid of reconciliation.updatedIds) expandedMessageText.delete(uuid);
      for (const uuid of expandedMessageText.keys()) {
        if (!retainedMessageUuids.has(uuid)) expandedMessageText.delete(uuid);
      }
      await prepareReaderState(retainedMessageUuids);
    }
  }

  if (!reconciliation.changed) {
    if (timelineReady.value && pendingFocusUuid.value) await focusPendingMessage();
    timelineViewport.completeInitialSnapshot();
    return;
  }

  await nextTick();
  timelineViewport.completeInitialSnapshot();
  if (restoreTail) await timelineViewport.scrollToEnd();
  syncTimelineScrollMargin();
  if (timelineReady.value) {
    if (!pendingFocusUuid.value) onScroll();
    else await focusPendingMessage();
  }
}

async function focusPendingMessage() {
  const targetUuid = pendingFocusUuid.value;
  if (!targetUuid) return;
  pendingFocusUuid.value = null;
  const targetIndex = timelineItems.value.findIndex(item => (
    item.anchorUuid === targetUuid || item.messageUuid === targetUuid
  ));
  if (targetIndex < 0) return;
  focusedItemKey.value = timelineItems.value[targetIndex].key;
  userScroll.clearUpwardIntent();
  timelineViewport.scrollToIndex(targetIndex, { align: 'end' });
  if (focusTimer !== null) clearTimeout(focusTimer);
  focusTimer = setTimeout(() => {
    focusedItemKey.value = null;
    focusTimer = null;
  }, 2000);
  await nextTick();
  onScroll();
}

// --- Scroll / progress tracking ---
const currentMsgIdx = ref(0);
const totalMsgs = computed(() => timelineItems.value.length);
let navLock = false;
let scrollFrame = null;

function onScroll(event) {
  if (navLock) return;
  if (scrollFrame !== null) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = null;
    updateScrollProgress();
  });
}

function setMessagePosition(index, total) {
  currentMsgIdx.value = index;
  progressPct.value = total <= 1 ? 100 : Math.round((index / (total - 1)) * 100);
}

function updateScrollProgress() {
  if (!wrapRef.value || !timelineItems.value.length) {
    currentMsgIdx.value = 0;
    progressPct.value = 0;
    return;
  }
  const bottomMsgIdx = timelineViewport.indexAtViewportEnd(NAV_HEIGHT);
  setMessagePosition(bottomMsgIdx, timelineItems.value.length);
}

function navTo(target) {
  if (!wrapRef.value) return;
  const count = timelineItems.value.length;
  if (!count) return;
  let idx;
  if (target === 'first') idx = 0;
  else if (target === 'last') idx = count - 1;
  else if (target === 'prev') idx = Math.max(0, currentMsgIdx.value - 1);
  else if (target === 'next') idx = Math.min(count - 1, currentMsgIdx.value + 1);
  else return;
  if (target === 'last') userScroll.clearUpwardIntent();
  setMessagePosition(idx, count);
  navLock = true;
  timelineViewport.scrollToIndex(idx, { align: 'end' });
  setTimeout(() => {
    navLock = false;
    onScroll();
  }, 50);
}

// --- Full text loading ---
async function handleLoadFullText(uuid) {
  if (fullTextLoading.has(uuid)) return;
  fullTextLoading.add(uuid);
  try {
    const fullText = await loadFullText(uuid);
    if (fullText && messages.value.some(message => message.uuid === uuid)) {
      expandedMessageText.set(uuid, fullText);
    }
  } finally {
    fullTextLoading.delete(uuid);
  }
}

// --- Subagent navigation ---
function navigateToSubagent(agentId) {
  router.push({
    name: 'SubagentDetail',
    params: { id: props.id, agentId }
  });
}

</script>

<template>
  <div class="detail-wrap" ref="wrapRef" @scroll="onScroll" :style="{ '--text-base': fontSize, '--text-md': fontSize }">
    <div class="detail">
      <!-- Progress bar -->
      <div class="session-progress">
        <div class="session-progress-fill" :style="{ width: progressPct + '%' }"></div>
      </div>

      <!-- Loading state -->
      <div v-if="loading || !timelineReady" class="empty first-open-loading">
        Loading session...
      </div>

      <!-- Session header -->
      <template v-if="session && !loading">
        <div class="session-header" :class="{ 'is-preparing': !timelineReady }" ref="headerRef">
          <div class="session-eyebrow">
            <span class="project-icon" v-html="FOLDER_SVG"></span>
            <span class="project-name">{{ formatProjectLabel(session.project) }}</span>
            <span class="sep">&middot;</span>
            <span class="project-path">{{ session.project_path || '' }}</span>
            <span class="via">
              <span class="via-dot" :style="{ '--source-color': sourceColor(session.source, state.sources) }"></span>
              via {{ sourceLabel(session.source, state.sources) }}
            </span>
          </div>
          <div class="session-title">{{ session.title || '(untitled)' }}</div>
          <div class="session-meta-inline">
            <span>created {{ fmtRelative(new Date(session.started_at || 0).getTime()) }}</span>
            <span class="dot"></span>
            <span>last active {{ fmtRelative(new Date(session.ended_at || session.started_at || 0).getTime()) }}</span>
            <span class="dot"></span>
            <span>{{ session.message_count || 0 }} messages</span>
            <template v-if="session.git_branch">
              <span class="dot"></span>
              <span>{{ session.git_branch }}</span>
            </template>
          </div>
        </div>

        <!-- Message timeline -->
        <div
          ref="timelineRef"
          class="timeline virtual-timeline"
          :class="{ 'is-preparing': !timelineReady }"
          :style="{ height: `${totalSize}px` }"
        >
          <div
            v-for="virtualRow in virtualRows"
            :key="virtualRow.key"
            :ref="measureElement"
            class="virtual-timeline-row"
            :data-index="virtualRow.index"
            :style="{ transform: `translateY(${virtualRow.start - timelineScrollMargin}px)` }"
          >
            <SessionTimelineRow
              :item="timelineItems[virtualRow.index]"
              :focused="focusedItemKey === timelineItems[virtualRow.index].key"
              :query="state.query"
              :disclosures="disclosures"
              :expanded-message-text="expandedMessageText"
              :full-text-loading="fullTextLoading"
              @load-full-text="handleLoadFullText"
              @navigate-subagent="navigateToSubagent"
            />
          </div>
        </div>
      </template>
    </div>

    <!-- Pagination nav -->
    <div class="msg-nav" v-if="totalMsgs > 0">
      <button class="msg-nav-btn" @click="navTo('first')" :disabled="currentMsgIdx === 0" title="First">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v8M7 8l4-4v8z"/></svg>
      </button>
      <button class="msg-nav-btn" @click="navTo('prev')" :disabled="currentMsgIdx === 0" title="Previous">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 4l-4 4 4 4"/></svg>
      </button>
      <span class="msg-nav-pos"><span class="msg-nav-current">{{ currentMsgIdx + 1 }}</span> / <FlapNumber :value="totalMsgs" /></span>
      <button class="msg-nav-btn" @click="navTo('next')" :disabled="currentMsgIdx >= totalMsgs - 1" title="Next">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>
      </button>
      <button class="msg-nav-btn" @click="navTo('last')" :disabled="currentMsgIdx >= totalMsgs - 1" title="Last">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v8M9 8l-4-4v8z"/></svg>
      </button>
    </div>

    <Transition name="toast">
      <div v-if="showFontHint" class="font-toast">
        ⌘ +/- to adjust font size
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.detail {
  position: relative;
}
.detail-wrap {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  position: relative;
}
.first-open-loading {
  position: absolute;
  inset: 0;
  z-index: 2;
  padding: 60px 0;
  text-align: center;
  color: var(--muted);
}
.session-header.is-preparing,
.virtual-timeline.is-preparing {
  visibility: hidden;
}
.virtual-timeline {
  display: block;
  position: relative;
  gap: 0;
}
.virtual-timeline-row {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
}
.font-toast {
  position: fixed;
  bottom: 48px;
  left: 50%;
  transform: translateX(-50%);
  padding: 8px 16px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.75);
  border: 1px solid var(--hairline-strong);
  backdrop-filter: blur(12px);
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--fg-2);
  pointer-events: none;
  z-index: 100;
}
.toast-enter-active { transition: opacity 0.3s, transform 0.3s; }
.toast-leave-active { transition: opacity 0.6s, transform 0.6s; }
.toast-enter-from { opacity: 0; transform: translateX(-50%) translateY(8px); }
.toast-leave-to { opacity: 0; transform: translateX(-50%) translateY(-4px); }
</style>
