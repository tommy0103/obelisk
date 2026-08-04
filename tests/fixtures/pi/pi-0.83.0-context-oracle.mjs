/*
 * Test-only transcription of the Pi 0.83.0 context algorithms:
 * https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/src/core/session-manager.ts
 * https://github.com/earendil-works/pi/blob/v0.83.0/packages/agent/src/harness/session/session.ts
 *
 * MIT License
 *
 * Copyright (c) 2025 Mario Zechner
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

export const PI_CONTEXT_ORACLE_VERSION = '0.83.0';

function buildEntryIndex(entries, byId) {
  if (byId) return byId;
  const index = new Map();
  for (const entry of entries) index.set(entry.id, entry);
  return index;
}

export function buildCodingAgentSessionPath(entries, leafId, byId) {
  const index = buildEntryIndex(entries, byId);
  let leaf;
  if (leafId === null) return [];
  if (leafId) leaf = index.get(leafId);
  leaf ??= entries[entries.length - 1];
  if (!leaf) return [];

  const path = [];
  let current = leaf;
  while (current) {
    path.push(current);
    current = current.parentId ? index.get(current.parentId) : undefined;
  }
  path.reverse();
  return path;
}

// pi-agent-core 0.83.0 JsonlSessionStorage.getPathToRootOrCompaction().
// The checked fixtures may contain synthetic orphan edges; those terminate the
// path just as the coding-agent oracle above does instead of exercising the
// storage API's separate invalid-session error.
export function buildAgentCoreSessionPath(entries, leafId, byId) {
  const index = buildEntryIndex(entries, byId);
  if (leafId === null) return [];
  let current = leafId ? index.get(leafId) : entries[entries.length - 1];
  current ??= entries[entries.length - 1];
  if (!current) return [];

  const path = [];
  let stopAtEntryId = null;
  while (current) {
    path.unshift(current);
    if (stopAtEntryId !== null && current.id === stopAtEntryId) break;
    if (current.type === 'compaction') {
      if (current.retainedTail) break;
      stopAtEntryId = current.firstKeptEntryId ?? null;
    }
    if (!current.parentId) break;
    current = index.get(current.parentId);
  }
  return path;
}

export function buildCodingAgentContextEntries(entries, leafId, byId) {
  const path = buildCodingAgentSessionPath(entries, leafId, byId);
  let compaction = null;
  for (const entry of path) {
    if (entry.type === 'compaction') compaction = entry;
  }
  if (!compaction) return path;

  const compactionIndex = path.findIndex(entry => entry.id === compaction.id);
  if (compactionIndex < 0) return path;

  const contextEntries = [compaction];
  let foundFirstKept = false;
  for (let index = 0; index < compactionIndex; index++) {
    const entry = path[index];
    if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
    if (foundFirstKept) contextEntries.push(entry);
  }
  contextEntries.push(...path.slice(compactionIndex + 1));
  return contextEntries;
}

export function defaultAgentCoreContextEntryTransform(pathEntries) {
  let compaction = null;
  for (const entry of pathEntries) {
    if (entry.type === 'compaction') compaction = entry;
  }
  if (!compaction) return [...pathEntries];

  const entries = [compaction];
  const compactionIndex = pathEntries.findIndex(entry => (
    entry.type === 'compaction' && entry.id === compaction.id
  ));
  if (compaction.retainedTail) {
    for (let index = compactionIndex + 1; index < pathEntries.length; index++) {
      entries.push(pathEntries[index]);
    }
    return entries;
  }
  if (compaction.firstKeptEntryId) {
    let foundFirstKept = false;
    for (let index = 0; index < compactionIndex; index++) {
      const entry = pathEntries[index];
      if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
      if (foundFirstKept) entries.push(entry);
    }
  }
  for (let index = compactionIndex + 1; index < pathEntries.length; index++) {
    entries.push(pathEntries[index]);
  }
  return entries;
}

export function pi083LeafId(entries) {
  let leafId = null;
  for (const entry of entries) {
    leafId = entry.type === 'leaf' ? entry.targetId : entry.id;
  }
  return leafId;
}

function evidence(kind, source, role, content) {
  return JSON.stringify({ kind, source, role, content });
}

// The Pi oracles select the active context entries. Obelisk stores those entries
// in durable physical order for its evidence timeline, while retainedTail
// messages remain immediately after their owning compaction summary.
export function projectCanonicalEvidence(physicalEntries, contextEntries) {
  const activeIds = new Set(contextEntries.map(entry => entry.id));
  return physicalEntries.filter(entry => activeIds.has(entry.id)).flatMap((entry) => {
    if (entry.type === 'message') {
      return [evidence('message', null, entry.message.role, entry.message.content)];
    }
    if (entry.type === 'branch_summary') {
      return [evidence('summary', 'pi:branch_summary', null, entry.summary)];
    }
    if (entry.type === 'compaction') {
      return [
        evidence('summary', 'pi:compaction', null, entry.summary),
        ...(entry.retainedTail ?? []).map(message => (
          evidence('message', null, message.role, message.content)
        )),
      ];
    }
    return [];
  });
}
