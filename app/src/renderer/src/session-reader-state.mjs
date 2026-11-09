// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { normalizeSessionDisclosureSnapshot } from './session-disclosures.mjs';

function normalizeAnchor(anchor) {
  if (!anchor || typeof anchor !== 'object') return null;
  return {
    itemKey: typeof anchor.itemKey === 'string' ? anchor.itemKey : null,
    messageUuid: typeof anchor.messageUuid === 'string' ? anchor.messageUuid : null,
    offset: Number.isFinite(anchor.offset) ? anchor.offset : 0,
    fallbackIndex: Number.isInteger(anchor.fallbackIndex) ? anchor.fallbackIndex : 0,
  };
}

function normalizeReaderState(state) {
  const mode = state?.mode === 'tail' ? 'tail' : 'anchor';
  return {
    mode,
    anchor: mode === 'anchor' ? normalizeAnchor(state?.anchor) : null,
    disclosures: normalizeSessionDisclosureSnapshot(state?.disclosures),
    expandedMessageIds: Array.isArray(state?.expandedMessageIds)
      ? [...new Set(state.expandedMessageIds.filter(id => typeof id === 'string'))]
      : [],
  };
}

function cloneReaderState(state) {
  return {
    mode: state.mode,
    anchor: state.anchor ? { ...state.anchor } : null,
    disclosures: state.disclosures.map(entry => ({ ...entry })),
    expandedMessageIds: [...state.expandedMessageIds],
  };
}

export function createSessionReaderStateCache({ maxEntries = 12 } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error('Session reader state cache requires maxEntries >= 1');
  }
  const entries = new Map();

  return {
    get(sessionId) {
      if (!entries.has(sessionId)) return null;
      const state = entries.get(sessionId);
      entries.delete(sessionId);
      entries.set(sessionId, state);
      return cloneReaderState(state);
    },
    set(sessionId, state) {
      if (!sessionId) return;
      entries.delete(sessionId);
      entries.set(sessionId, normalizeReaderState(state));
      while (entries.size > maxEntries) {
        entries.delete(entries.keys().next().value);
      }
    },
  };
}

export const sessionReaderStateCache = createSessionReaderStateCache();
