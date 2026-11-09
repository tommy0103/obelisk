// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// @ts-check

/** @typedef {import('./ipc-types.ts').AppliedSessionPatch} AppliedSessionPatch */
/** @typedef {import('./ipc-types.ts').SessionPatch} SessionPatch */
/** @typedef {import('./ipc-types.ts').SessionPatchCursor} SessionPatchCursor */
/** @typedef {import('./ipc-types.ts').SessionPatchRow} SessionPatchRow */
/** @typedef {import('./ipc-types.ts').SessionPatchSnapshot} SessionPatchSnapshot */
/** @typedef {import('./ipc-types.ts').SessionPatchTable} SessionPatchTable */

const TABLES = Object.freeze({
  messages: 'uuid',
  toolCalls: 'id',
  toolResults: 'tool_use_id',
  subagents: 'agent_id',
  workflows: 'run_id',
  summaries: 'id',
});

const TABLE_NAMES = /** @type {SessionPatchTable[]} */ (Object.keys(TABLES));

/**
 * @param {SessionPatchTable} table
 * @param {SessionPatchRow} row
 */
function rowId(table, row) {
  const id = row?.[TABLES[table]];
  if (id === undefined || id === null || id === '') {
    throw new Error(`Session patch row in ${table} is missing ${TABLES[table]}`);
  }
  return String(id);
}

/** @param {SessionPatchRow} row */
function rowHash(row) {
  const serialized = JSON.stringify(row);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < serialized.length; index++) {
    const code = serialized.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${serialized.length.toString(16)}:${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * @param {SessionPatchRow} row
 * @param {number} position
 */
function rowFingerprint(row, position) {
  return `${position.toString(36)}@${rowHash(row)}`;
}

/**
 * @template T
 * @param {() => T} factory
 * @returns {Record<SessionPatchTable, T>}
 */
function emptyTables(factory) {
  return /** @type {Record<SessionPatchTable, T>} */ (
    Object.fromEntries(TABLE_NAMES.map(table => [table, factory()]))
  );
}

/**
 * @param {SessionPatchSnapshot} [snapshot]
 * @returns {SessionPatchCursor}
 */
export function createSessionPatchCursor(snapshot = {}) {
  const cursor = emptyTables(() => /** @type {Record<string, string>} */ ({}));
  for (const table of TABLE_NAMES) {
    for (const [position, row] of (snapshot[table] || []).entries()) {
      cursor[table][rowId(table, row)] = rowFingerprint(row, position);
    }
  }
  return cursor;
}

/**
 * @param {SessionPatchSnapshot} [snapshot]
 * @param {Partial<SessionPatchCursor>} [cursor]
 * @returns {SessionPatch}
 */
export function createSessionPatch(snapshot = {}, cursor = {}) {
  const changes = emptyTables(() => /** @type {SessionPatchRow[]} */ ([]));
  const removed = emptyTables(() => /** @type {string[]} */ ([]));
  const hashes = emptyTables(() => /** @type {Record<string, string>} */ ({}));
  const positions = emptyTables(() => /** @type {Record<string, number>} */ ({}));

  for (const table of TABLE_NAMES) {
    const previous = cursor[table] || {};
    const currentIds = new Set();
    for (const [index, row] of (snapshot[table] || []).entries()) {
      const id = rowId(table, row);
      const hash = rowFingerprint(row, index);
      currentIds.add(id);
      if (previous[id] !== hash) {
        changes[table].push(row);
        hashes[table][id] = hash;
        positions[table][id] = index;
      }
    }
    for (const id of Object.keys(previous)) {
      if (!currentIds.has(id)) removed[table].push(id);
    }
  }

  return { changes, removed, hashes, positions };
}

/**
 * @param {SessionPatchSnapshot} [snapshot]
 * @param {Partial<SessionPatchCursor>} [cursor]
 * @param {Partial<SessionPatch>} [patch]
 * @returns {AppliedSessionPatch}
 */
export function applySessionPatch(snapshot = {}, cursor = {}, patch = {}) {
  const nextSnapshot = emptyTables(() => /** @type {SessionPatchRow[]} */ ([]));
  const nextCursor = emptyTables(() => /** @type {Record<string, string>} */ ({}));
  for (const table of TABLE_NAMES) {
    const currentRows = snapshot[table] || [];
    const tableChanges = patch.changes?.[table] || [];
    const tableRemoved = patch.removed?.[table] || [];
    const previousHashes = cursor[table] || {};
    const appendOnly = tableRemoved.length === 0 && tableChanges.every((row, offset) => {
      const id = rowId(table, row);
      return !Object.hasOwn(previousHashes, id)
        && patch.positions?.[table]?.[id] === currentRows.length + offset;
    });

    if (appendOnly) {
      nextSnapshot[table] = tableChanges.length > 0
        ? [...currentRows, ...tableChanges]
        : currentRows;
    } else {
      const removedIds = new Set(tableRemoved.map(String));
      const changedIds = new Set(tableChanges.map(row => rowId(table, row)));
      const nextRows = currentRows
        .filter(row => !removedIds.has(rowId(table, row)) && !changedIds.has(rowId(table, row)));
      const positionedRows = [...tableChanges]
        .sort((left, right) => (
          (patch.positions?.[table]?.[rowId(table, left)] ?? Number.MAX_SAFE_INTEGER)
            - (patch.positions?.[table]?.[rowId(table, right)] ?? Number.MAX_SAFE_INTEGER)
        ));
      for (const row of positionedRows) {
        const position = patch.positions?.[table]?.[rowId(table, row)] ?? nextRows.length;
        nextRows.splice(position, 0, row);
      }
      nextSnapshot[table] = nextRows;
    }

    const tableCursor = { ...(cursor[table] || {}) };
    for (const id of patch.removed?.[table] || []) delete tableCursor[String(id)];
    Object.assign(tableCursor, patch.hashes?.[table] || {});
    nextCursor[table] = tableCursor;
  }
  return { snapshot: nextSnapshot, cursor: nextCursor };
}
