// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Shared renderer state. Navigation state belongs to Vue Router; this store
// holds only data and cross-view UI preferences.

import { reactive, shallowReactive, markRaw } from 'vue';

export const state = reactive({
  memories: [],
  sessions: [],
  sessionTitleOverrides: shallowReactive(new Map()),
  projects: [],
  sources: [],
  stats: {},
  view: 'active',          // 'active' | 'archived'
  query: '',
  projectFilter: 'all',
  sourceFilter: 'all',
  projectSearch: '',
  sortDesc: true,
  includeMessageBodies: false,
  cursorId: null,
  selection: markRaw(new Set()),
  loaded: false
});

export function getSessionSummary(sessionId) {
  const id = String(sessionId || '');
  const session = state.sessions.find(candidate => candidate.id === id);
  const title = state.sessionTitleOverrides.get(id);
  if (title === undefined) return session;
  return { ...(session || { id }), title };
}

// SVG icon constants
export const FOLDER_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M2.5 4h4l1.5 1.5h5.5v7a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-8z"/></svg>`;
export const MINIMIZE_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M4 8h8"/></svg>`;
export const MAXIMIZE_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><rect x="4" y="4" width="8" height="8" rx="1.2"/></svg>`;
export const RESTORE_SVG  = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><rect x="3" y="5.5" width="7.5" height="7.5" rx="1.2"/><path d="M5.5 5.5V4.2a1.2 1.2 0 0 1 1.2-1.2h5.1a1.2 1.2 0 0 1 1.2 1.2v5.1a1.2 1.2 0 0 1-1.2 1.2h-1.3"/></svg>`;
export const CLOSE_SVG    = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>`;

// --- Action functions ---

export function setSelection(ids) {
  state.selection = markRaw(new Set(ids));
}

export function clearSelection() {
  setSelection([]);
}

export function resetListState() {
  state.cursorId = null;
  clearSelection();
  state.query = '';
}

export function setView(v) {
  state.view = v;
  state.cursorId = null;
  clearSelection();
  state.projectFilter = 'all';
}

export function setProject(p) {
  state.projectFilter = p;
  state.cursorId = null;
  clearSelection();
}

export function toggleSort() {
  state.sortDesc = !state.sortDesc;
}

export function setQuery(q) {
  state.query = q;
}

export function setProjectSearch(q) {
  state.projectSearch = q;
}

export function toggleIncludeMessageBodies() {
  state.includeMessageBodies = !state.includeMessageBodies;
}
