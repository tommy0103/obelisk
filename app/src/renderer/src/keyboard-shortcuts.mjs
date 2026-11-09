// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

export function normalizeShortcutKey(event) {
  return event.key.length === 1 ? event.key.toLowerCase() : event.key;
}

export function resolveGlobalShortcut(event, context) {
  if (event.defaultPrevented) return null;

  const key = normalizeShortcutKey(event);
  const modifier = event.metaKey || event.ctrlKey;
  if (modifier) {
    if (key === '1') return 'open-sessions';
    if (key === '2') return 'open-active-memories';
    if (key === '3') return 'open-archived-memories';
    return null;
  }
  if (event.altKey) return null;

  if (context.isTextInput) {
    return key === 'Escape' ? 'blur-input' : null;
  }

  if (key === '/' && context.isListRoute) return 'focus-search';
  if (key === 's' && context.isListRoute) return 'toggle-sort';

  if (key === 'Escape') {
    if (context.hasSelection) return 'clear-selection';
    if (context.hasQuery) return 'clear-query';
  }

  return null;
}

export function resolveMemoryShortcut(event, context) {
  if (event.defaultPrevented || context.isTextInput) return null;

  const key = normalizeShortcutKey(event);
  const modifier = event.metaKey || event.ctrlKey;
  if (modifier) {
    if (key === 'z' && !event.shiftKey && context.hasUndo) return { type: 'undo' };
    return null;
  }
  if (event.altKey) return null;

  if (context.showDetail) {
    if (key === 'Escape') return { type: 'close-detail' };
    if (key === 'd') return { type: 'mutate-detail' };
    return null;
  }

  if (key === 'j' || key === 'ArrowDown') {
    return { type: 'move-cursor', direction: 1, extend: Boolean(event.shiftKey) };
  }
  if (key === 'k' || key === 'ArrowUp') {
    return { type: 'move-cursor', direction: -1, extend: Boolean(event.shiftKey) };
  }
  if (key === 'Enter' && context.hasCursor) return { type: 'open-detail' };
  if (key === 'x' && context.hasCursor) return { type: 'toggle-selection' };
  if (key === 'd') return { type: 'mutate-selection' };
  if (key === 'u' && context.hasUndo) return { type: 'undo' };

  return null;
}
