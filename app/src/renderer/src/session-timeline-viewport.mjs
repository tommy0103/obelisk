// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { computed, nextTick, onScopeDispose, ref } from 'vue';
import {
  defaultRangeExtractor,
  elementScroll,
  measureElement as measureVirtualElement,
  useVirtualizer,
} from '@tanstack/vue-virtual';
import { createSessionTimelineScrollPolicy } from './session-timeline-scroll-policy.mjs';
import {
  SESSION_IMAGE_PENDING_EVENT,
  SESSION_IMAGE_SETTLED_EVENT,
} from './session-image-contract.js';

// How long after an image settles its row still counts as "grew because media
// finished" rather than "grew because the estimate was wrong". Covers the
// remeasurement that follows the final state change.
const MEDIA_SETTLE_WINDOW_MS = 1_000;

function estimatedTextHeight(text = '') {
  return Math.min(560, Math.ceil(String(text).length / 72) * 20);
}

export function estimateTimelineItemSize(item) {
  if (!item) return 96;
  if (item.kind === 'meta') return 34;
  if (item.kind === 'thinking') return 38;
  if (item.kind === 'skill') return 84;
  if (item.kind === 'workflow') {
    const agents = item.workflowCall?.workflow?.agents?.length || 0;
    return 72 + Math.min(360, agents * 34);
  }
  if (item.kind === 'workflow-tools') {
    return 48 + (item.toolCalls?.length || 0) * 38;
  }
  const message = item.message || {};
  return 72
    + estimatedTextHeight(message.text)
    + (message.tool_calls?.length || 0) * 38
    + (message.summary ? 34 : 0)
    + (message._thinking ? 34 : 0);
}

export function createViewportRangeExtractor({
  getScrollElement,
  getVirtualizer,
  bufferViewports = 4,
}) {
  return range => {
    const element = getScrollElement();
    const instance = getVirtualizer();
    const viewportSize = element?.clientHeight || 0;
    if (!instance || viewportSize <= 0) return defaultRangeExtractor(range);

    // The compositor can advance wheel scrolling before the renderer receives
    // the scroll event. Buffer in pixels so short rows do not collapse a
    // count-based overscan into less than one trackpad gesture.
    const bufferSize = viewportSize * bufferViewports;
    const scrollOffset = element.scrollTop || 0;
    const first = instance.getVirtualItemForOffset(Math.max(0, scrollOffset - bufferSize));
    const last = instance.getVirtualItemForOffset(
      scrollOffset + viewportSize + bufferSize,
    );
    if (!first || !last) return defaultRangeExtractor(range);

    const startIndex = Math.max(0, Math.min(first.index, range.startIndex));
    const endIndex = Math.min(range.count - 1, Math.max(last.index, range.endIndex));
    return Array.from(
      { length: endIndex - startIndex + 1 },
      (_, offset) => startIndex + offset,
    );
  };
}

export function resolveReaderAnchorIndex(anchor, items = []) {
  if (!items.length) return null;
  if (anchor?.itemKey) {
    const itemIndex = items.findIndex(item => item?.key === anchor.itemKey);
    if (itemIndex >= 0) return itemIndex;
  }
  if (anchor?.messageUuid) {
    const messageIndex = items.findIndex(item => item?.messageUuid === anchor.messageUuid);
    if (messageIndex >= 0) return messageIndex;
  }
  const fallbackIndex = Number.isInteger(anchor?.fallbackIndex) ? anchor.fallbackIndex : 0;
  return Math.max(0, Math.min(items.length - 1, fallbackIndex));
}

export function useSessionTimelineViewport({
  items,
  scrollElement,
  timelineElement,
  scrollMargin,
  overscan = 6,
  gap = 14,
  scrollPaddingEnd = 0,
  userScroll,
}) {
  const tailFollowReady = ref(false);
  let settlementActive = false;
  let compensatedTimeline = null;
  let originalTimelineTranslate = '';
  let suppressedAdjustment = 0;
  const scrollPolicy = createSessionTimelineScrollPolicy({
    isUserScrolling: () => (
      settlementActive || (userScroll?.isActive() ?? false)
    ),
    writeScroll: elementScroll,
    onSuppressedAdjustment: applySuppressedAdjustment,
  });
  let virtualizer = null;
  const rangeExtractor = createViewportRangeExtractor({
    getScrollElement: () => scrollElement.value,
    getVirtualizer: () => virtualizer?.value,
  });
  virtualizer = useVirtualizer(computed(() => ({
    count: items.value.length,
    getScrollElement: () => scrollElement.value,
    estimateSize: index => estimateTimelineItemSize(items.value[index]),
    getItemKey: index => items.value[index]?.key || index,
    scrollMargin: scrollMargin.value,
    scrollPaddingEnd,
    overscan,
    rangeExtractor,
    gap,
    anchorTo: 'end',
    followOnAppend: false,
    scrollEndThreshold: 50,
    isScrollingResetDelay: 450,
    useScrollendEvent: true,
    useAnimationFrameWithResizeObserver: true,
    measureElement: measureVirtualElement,
    scrollToFn: scrollPolicy.scrollToFn,
  })));

  const virtualRows = computed(() => virtualizer.value.getVirtualItems());
  const totalSize = computed(() => virtualizer.value.getTotalSize());

  // virtual-core deliberately skips scroll compensation when an already-measured
  // row above the viewport is re-measured during an upward scroll, because that
  // is normally an estimate correction and compensating it makes rows jump while
  // the reader scrolls back. Media growth is not an estimate correction: the row
  // really did get taller, so leaving it uncompensated pushes everything the
  // reader is looking at down the screen.
  //
  // A row counts as settling from the moment an image mounts until loading
  // finishes, because a decoder grows the row from the image header long before
  // the load event -- keying off load alone would miss the first and largest
  // growth. Counted, not flagged, so a message with several images stays marked
  // until the last of them is done.
  const mediaPending = new Map();
  const mediaSettledAt = new Map();

  function rowKeyFor(event) {
    const row = event.target?.closest?.('.virtual-timeline-row');
    if (!row) return null;
    const timeline = timelineElement?.value;
    if (timeline && !timeline.contains(row)) return null;
    const index = Number(row.dataset?.index);
    if (!Number.isInteger(index)) return null;
    return items.value[index]?.key ?? index;
  }

  function noteMediaPending(event) {
    const key = rowKeyFor(event);
    if (key === null) return;
    mediaPending.set(key, (mediaPending.get(key) ?? 0) + 1);
    mediaSettledAt.delete(key);
  }

  function noteMediaSettled(event) {
    const key = rowKeyFor(event);
    if (key === null) return;
    const outstanding = (mediaPending.get(key) ?? 0) - 1;
    if (outstanding > 0) mediaPending.set(key, outstanding);
    else mediaPending.delete(key);
    const now = performance.now();
    for (const [settledKey, at] of mediaSettledAt) {
      if (now - at > MEDIA_SETTLE_WINDOW_MS) mediaSettledAt.delete(settledKey);
    }
    mediaSettledAt.set(key, now);
  }

  function isMediaSettling(key) {
    if (mediaPending.has(key)) return true;
    const at = mediaSettledAt.get(key);
    if (at === undefined) return false;
    if (performance.now() - at > MEDIA_SETTLE_WINDOW_MS) {
      mediaSettledAt.delete(key);
      return false;
    }
    return true;
  }

  // Bound to the document rather than to the timeline element, because rows
  // announce their images while mounting -- before a ref-driven listener would
  // be in place to hear the first one.
  const eventTarget = globalThis.document ?? null;
  eventTarget?.addEventListener(SESSION_IMAGE_PENDING_EVENT, noteMediaPending);
  eventTarget?.addEventListener(SESSION_IMAGE_SETTLED_EVENT, noteMediaSettled);
  onScopeDispose(() => {
    eventTarget?.removeEventListener(SESSION_IMAGE_PENDING_EVENT, noteMediaPending);
    eventTarget?.removeEventListener(SESSION_IMAGE_SETTLED_EVENT, noteMediaSettled);
  });

  virtualizer.value.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    if (item.start >= instance.getScrollOffset() + instance.scrollAdjustments) return false;
    // Never measured before: the estimate is what placed the reader, so the
    // estimate-to-actual difference always has to be taken out.
    if (!instance.itemSizeCache.has(item.key)) return true;
    if (isMediaSettling(item.key)) return true;
    return instance.scrollDirection !== 'backward';
  };

  function resolveTimelineElement(instance = virtualizer?.value) {
    return timelineElement?.value
      || [...(instance?.elementsCache?.values?.() || [])]
        .find(element => element.isConnected)?.parentElement
      || null;
  }

  function applySuppressedAdjustment(_offset, options, instance) {
    const adjustment = Number(options.adjustments) || 0;
    if (adjustment === 0) return;
    const target = resolveTimelineElement(instance);
    if (!target) return;
    if (compensatedTimeline !== target) {
      if (compensatedTimeline) {
        compensatedTimeline.style.translate = originalTimelineTranslate;
      }
      compensatedTimeline = target;
      originalTimelineTranslate = target.style.translate || '';
      suppressedAdjustment = 0;
    }
    suppressedAdjustment += adjustment;
    target.style.translate = `0 ${-suppressedAdjustment}px`;
  }

  function clearSuppressedAdjustment() {
    if (compensatedTimeline) {
      compensatedTimeline.style.translate = originalTimelineTranslate;
    }
    compensatedTimeline = null;
    originalTimelineTranslate = '';
    suppressedAdjustment = 0;
  }

  function measureElement(element) {
    if (!element) return;
    virtualizer.value.measureElement(element);
  }

  async function settleAfterUserScroll(commit = () => Promise.resolve()) {
    if (settlementActive) return false;
    const instance = virtualizer.value;
    const element = scrollElement.value;
    if (!instance || !element) {
      clearSuppressedAdjustment();
      return false;
    }

    const scrollOffset = element.scrollTop;
    const viewportRect = element.getBoundingClientRect();
    const mountedRows = [...instance.elementsCache.entries()]
      .filter(([, row]) => row.isConnected)
      .map(([key, row]) => ({ key, row, rect: row.getBoundingClientRect() }));
    const visibleAnchor = mountedRows
      .filter(({ rect }) => (
        rect.bottom > viewportRect.top && rect.top < viewportRect.bottom
      ))
      .sort((left, right) => left.rect.top - right.rect.top)[0];
    const fallbackMeasurement = instance.getVirtualItemForOffset(scrollOffset);
    const anchor = visibleAnchor
      ? {
          key: visibleAnchor.key,
          screenOffset: visibleAnchor.rect.top - viewportRect.top,
        }
      : fallbackMeasurement
        ? {
            key: fallbackMeasurement.key,
            screenOffset: fallbackMeasurement.start - scrollOffset,
          }
        : null;
    settlementActive = true;
    try {
      // Publish the coalesced live patch inside the same geometry transaction.
      // Real row sizes remain live throughout; only scrollTop corrections are
      // suppressed until the reader anchor can be reconciled once.
      await commit();
      if (userScroll?.isActive() ?? false) return false;

      const indexByKey = new Map(
        items.value.map((item, index) => [item?.key || index, index]),
      );
      let appliedMeasurements = 0;
      let stableFrames = 0;
      for (let pass = 0; pass < 12 && stableFrames < 2; pass++) {
        await nextTick();
        if (userScroll?.isActive() ?? false) return false;
        let changed = false;
        const settledRows = [...instance.elementsCache.entries()]
          .filter(([, row]) => row.isConnected)
          .map(([key, row]) => ({ key, size: Math.round(row.getBoundingClientRect().height) }))
          .filter(({ size }) => size > 0);
        for (const { key, size } of settledRows) {
          const index = indexByKey.get(key);
          if (index === undefined) continue;
          const cachedSize = instance.itemSizeCache.get(key)
            ?? instance.options.estimateSize(index);
          if (cachedSize === size) continue;
          instance.resizeItem(index, size);
          appliedMeasurements++;
          changed = true;
        }
        stableFrames = changed ? 0 : stableFrames + 1;
        const targetWindow = element.ownerDocument?.defaultView;
        if (targetWindow) {
          await new Promise(resolve => targetWindow.requestAnimationFrame(resolve));
        }
      }

      let targetOffset = scrollOffset;
      if (anchor) {
        const anchorIndex = indexByKey.get(anchor.key);
        const nextMeasurement = anchorIndex === undefined
          ? null
          : instance.getMeasurements?.()[anchorIndex];
        if (nextMeasurement) targetOffset = nextMeasurement.start - anchor.screenOffset;
      }

      const viewportWasRepositioned = (userScroll?.isActive() ?? false)
        || Math.abs(element.scrollTop - scrollOffset) >= 1;
      if (viewportWasRepositioned) {
        clearSuppressedAdjustment();
        instance.scrollOffset = element.scrollTop;
      } else if (Math.abs(element.scrollTop - targetOffset) >= 0.5) {
        clearSuppressedAdjustment();
        instance.scrollOffset = targetOffset;
        elementScroll(targetOffset, { behavior: 'auto' }, instance);
      } else {
        clearSuppressedAdjustment();
        instance.scrollOffset = element.scrollTop;
      }
      return appliedMeasurements > 0;
    } catch (error) {
      clearSuppressedAdjustment();
      throw error;
    } finally {
      settlementActive = false;
    }
  }

  function indexAtViewportEnd(inset = 0) {
    const instance = virtualizer.value;
    const viewportSize = instance.scrollRect?.height || scrollElement.value?.clientHeight || 0;
    const offset = (instance.scrollOffset || scrollElement.value?.scrollTop || 0)
      + viewportSize
      - inset;
    return instance.getVirtualItemForOffset(offset)?.index ?? 0;
  }

  function runWithMeasurementRetry(scroll) {
    scroll();
    const targetWindow = scrollElement.value?.ownerDocument?.defaultView;
    if (!targetWindow) return Promise.resolve();
    return new Promise(resolve => targetWindow.requestAnimationFrame(() => {
      targetWindow.requestAnimationFrame(() => {
        scroll();
        resolve();
      });
    }));
  }

  function captureReaderPosition() {
    if (isFollowingTail()) return { mode: 'tail', anchor: null };
    const itemIndex = resolveReaderAnchorIndex(null, items.value);
    if (itemIndex === null) return { mode: 'anchor', anchor: null };

    const instance = virtualizer.value;
    const scrollOffset = instance.scrollOffset ?? scrollElement.value?.scrollTop ?? 0;
    const measurement = instance.getVirtualItemForOffset(scrollOffset)
      || instance.getMeasurements?.()[itemIndex];
    const index = measurement?.index ?? itemIndex;
    const item = items.value[index];
    return {
      mode: 'anchor',
      anchor: {
        itemKey: item?.key || null,
        messageUuid: item?.messageUuid || null,
        offset: scrollOffset - (measurement?.start ?? scrollOffset),
        fallbackIndex: index,
      },
    };
  }

  async function restoreReaderPosition(position) {
    if (position?.mode === 'tail') {
      await scrollToEnd();
      return;
    }
    const index = resolveReaderAnchorIndex(position?.anchor, items.value);
    if (index === null) return;
    const offsetWithinItem = Number.isFinite(position?.anchor?.offset)
      ? position.anchor.offset
      : 0;
    const scroll = () => {
      const measurement = virtualizer.value.getMeasurements?.()[index];
      const targetOffset = Math.max(0, (measurement?.start || 0) + offsetWithinItem);
      scrollPolicy.runExplicit(() => {
        virtualizer.value.scrollToOffset(targetOffset, { behavior: 'auto' });
      });
    };
    await runWithMeasurementRetry(scroll);
  }

  function scrollToIndex(index, options = {}) {
    const scroll = () => {
      scrollPolicy.runExplicit(() => {
        virtualizer.value.scrollToIndex(index, { behavior: 'auto', ...options });
      });
    };

    // A far jump starts from estimates. Re-align after mounted rows have been
    // measured so the requested item does not remain only in overscan.
    return runWithMeasurementRetry(scroll);
  }

  async function scrollToEnd() {
    const targetWindow = scrollElement.value?.ownerDocument?.defaultView;
    if (targetWindow) {
      await new Promise(resolve => targetWindow.requestAnimationFrame(resolve));
    }
    const scroll = () => {
      scrollPolicy.runExplicit(() => {
        const element = scrollElement.value;
        if (element && 'scrollHeight' in element) {
          element.scrollTo({ top: element.scrollHeight, behavior: 'auto' });
        } else {
          virtualizer.value.scrollToEnd({ behavior: 'auto' });
        }
      });
    };
    scroll();
  }

  function isFollowingTail() {
    if (!tailFollowReady.value) return false;
    const element = scrollElement.value;
    if (element && 'scrollHeight' in element) {
      return element.scrollHeight - element.clientHeight - element.scrollTop <= 50;
    }
    return virtualizer.value.isAtEnd(50);
  }

  function completeInitialSnapshot() {
    tailFollowReady.value = true;
  }

  async function waitForStableLayout({ maxFrames = 8, isCurrent = () => true } = {}) {
    const targetWindow = scrollElement.value?.ownerDocument?.defaultView;
    if (!targetWindow || items.value.length === 0) return true;
    for (let frame = 0; frame < maxFrames; frame++) {
      await new Promise(resolve => targetWindow.requestAnimationFrame(resolve));
      if (!isCurrent()) return false;
      const rows = [...virtualizer.value.elementsCache.values()]
        .filter(element => element.isConnected)
        .sort((left, right) => (
          Number(left.dataset.index) - Number(right.dataset.index)
        ))
        .map(element => element.getBoundingClientRect())
        .filter(rect => rect.height > 0);
      const overlaps = rows.some((rect, index) => (
        index > 0 && rect.top < rows[index - 1].bottom - 1
      ));
      if (rows.length > 0 && !overlaps) return true;
    }
    return false;
  }

  return {
    virtualRows,
    totalSize,
    measureElement,
    settleAfterUserScroll,
    indexAtViewportEnd,
    scrollToIndex,
    scrollToEnd,
    captureReaderPosition,
    restoreReaderPosition,
    isFollowingTail,
    completeInitialSnapshot,
    waitForStableLayout,
  };
}
