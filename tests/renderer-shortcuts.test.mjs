// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeShortcutKey,
  resolveGlobalShortcut,
  resolveMemoryShortcut,
} from '../app/src/renderer/src/keyboard-shortcuts.mjs';

const context = {
  isTextInput: false,
  isListRoute: true,
  hasSelection: false,
  hasQuery: false,
};

test('global shortcuts switch between routed library views', () => {
  assert.equal(resolveGlobalShortcut({ key: '1', metaKey: true }, context), 'open-sessions');
  assert.equal(resolveGlobalShortcut({ key: '2', ctrlKey: true }, context), 'open-active-memories');
  assert.equal(resolveGlobalShortcut({ key: '3', metaKey: true }, context), 'open-archived-memories');
  assert.equal(resolveGlobalShortcut({ key: '4', metaKey: true }, context), null);
});

test('global shortcuts focus search and toggle list sorting', () => {
  assert.equal(resolveGlobalShortcut({ key: '/' }, context), 'focus-search');
  assert.equal(resolveGlobalShortcut({ key: '/' }, { ...context, isListRoute: false }), null);
  assert.equal(resolveGlobalShortcut({ key: 's' }, context), 'toggle-sort');
  assert.equal(resolveGlobalShortcut({ key: 's' }, { ...context, isListRoute: false }), null);
});

test('printable shortcut keys are normalized without changing named keys', () => {
  assert.equal(normalizeShortcutKey({ key: 'J' }), 'j');
  assert.equal(normalizeShortcutKey({ key: 'K' }), 'k');
  assert.equal(normalizeShortcutKey({ key: 'ArrowDown' }), 'ArrowDown');
});

test('Escape clears selection before query and blurs text inputs', () => {
  assert.equal(resolveGlobalShortcut({ key: 'Escape' }, { ...context, hasSelection: true, hasQuery: true }), 'clear-selection');
  assert.equal(resolveGlobalShortcut({ key: 'Escape' }, { ...context, hasQuery: true }), 'clear-query');
  assert.equal(resolveGlobalShortcut({ key: 'Escape' }, { ...context, isTextInput: true }), 'blur-input');
});

test('handled component events and text entry do not leak into global shortcuts', () => {
  assert.equal(resolveGlobalShortcut({ key: '/', defaultPrevented: true }, context), null);
  assert.equal(resolveGlobalShortcut({ key: '/' }, { ...context, isTextInput: true }), null);
  assert.equal(resolveGlobalShortcut({ key: 's' }, { ...context, isTextInput: true }), null);
  assert.equal(resolveGlobalShortcut({ key: 's', metaKey: true }, context), null);
  assert.equal(resolveGlobalShortcut({ key: '/', ctrlKey: true }, context), null);
  assert.equal(resolveGlobalShortcut({ key: '/', altKey: true }, context), null);
});

const memoryContext = {
  isTextInput: false,
  showDetail: false,
  hasUndo: true,
  hasCursor: true,
};

test('memory shortcuts navigate and extend selection with shifted keys', () => {
  assert.deepEqual(resolveMemoryShortcut({ key: 'J', shiftKey: true }, memoryContext), {
    type: 'move-cursor', direction: 1, extend: true,
  });
  assert.deepEqual(resolveMemoryShortcut({ key: 'ArrowUp' }, memoryContext), {
    type: 'move-cursor', direction: -1, extend: false,
  });
  assert.deepEqual(resolveMemoryShortcut({ key: 'Enter' }, memoryContext), { type: 'open-detail' });
  assert.deepEqual(resolveMemoryShortcut({ key: 'x' }, memoryContext), { type: 'toggle-selection' });
  assert.deepEqual(resolveMemoryShortcut({ key: 'd' }, memoryContext), { type: 'mutate-selection' });
});

test('memory undo remains available from detail while route shortcuts bubble globally', () => {
  const detail = { ...memoryContext, showDetail: true };
  assert.deepEqual(resolveMemoryShortcut({ key: 'z', metaKey: true }, detail), { type: 'undo' });
  assert.deepEqual(resolveMemoryShortcut({ key: 'Escape' }, detail), { type: 'close-detail' });
  assert.deepEqual(resolveMemoryShortcut({ key: 'D' }, detail), { type: 'mutate-detail' });
  assert.equal(resolveMemoryShortcut({ key: '2', metaKey: true }, detail), null);
  assert.equal(resolveMemoryShortcut({ key: 'j' }, { ...detail, isTextInput: true }), null);
});
