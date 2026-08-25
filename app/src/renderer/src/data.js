// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Data loading layer -- bridges Electron IPC (window.obelisk.*) to reactive store.
// All DB access goes through this module.

import { markRaw } from 'vue';
import { state } from './store.js';
import {
  applySessionPatch,
  createSessionPatchCursor,
} from '../../shared/session-patch.mjs';
import { assembleSessionDetail } from '../../shared/session-detail-assembly.mjs';

const sessionMessageSnapshots = new Map();
const MAX_SESSION_MESSAGE_SNAPSHOTS = 3;

function rememberSessionMessageSnapshot(sessionId, entry) {
  sessionMessageSnapshots.delete(sessionId);
  sessionMessageSnapshots.set(sessionId, entry);
  while (sessionMessageSnapshots.size > MAX_SESSION_MESSAGE_SNAPSHOTS) {
    sessionMessageSnapshots.delete(sessionMessageSnapshots.keys().next().value);
  }
}

function sessionMetadata(session) {
  if (!session) return null;
  const metadata = { ...session };
  delete metadata.messages;
  delete metadata.workflow;
  delete metadata.summaries;
  return markRaw(metadata);
}

function commitStoredSessionMetadata(sessionId, metadata) {
  const session = state.sessions.find(candidate => candidate.id === sessionId);
  if (session?.messages?.length) session.messages = markRaw([]);
  const visibleTitle = state.sessionTitleOverrides.get(sessionId) ?? session?.title;
  if (metadata?.title !== undefined && metadata.title !== visibleTitle) {
    state.sessionTitleOverrides.set(sessionId, metadata.title);
  }
}

/**
 * Fetch the global catalogue without mutating renderer state. Navigation can
 * then gate a reply that started before SessionDetail became active.
 */
export async function fetchInitialData() {
  const [rawMemories, rawSessions, stats, projects] = await Promise.all([
    window.obelisk.getMemories(),
    window.obelisk.getSessions({ source: 'all', limit: 1000 }),
    window.obelisk.getStats(),
    window.obelisk.getProjects()
  ]);
  return { rawMemories, rawSessions, stats, projects };
}

/** Commit a fetched global catalogue snapshot to shared renderer state. */
export function commitInitialData({ rawMemories, rawSessions, stats, projects }) {
  // Transform memories: DB records -> render-layer shape
  state.memories = (rawMemories || []).map(m => ({
    ...m,
    ts: m.created_at ? new Date(m.created_at).getTime() : 0,
    archived: !!m.deleted_at,
    archivedAt: m.deleted_at ? new Date(m.deleted_at).getTime() : null,
    anchors: m.anchors ? (typeof m.anchors === 'string' ? JSON.parse(m.anchors) : m.anchors) : [],
    markdown: null  // loaded on demand via loadMemoryMarkdown
  }));

  // The catalogue now owns the latest metadata; route overlays can retire.
  state.sessionTitleOverrides.clear();

  // Sessions: merge with existing data to preserve already-loaded messages
  const existingSessions = new Map(state.sessions.map(s => [s.id, s]));
  state.sessions = (rawSessions || []).map(s => {
    const existing = existingSessions.get(s.id);
    return {
      ...s,
      messages: existing?.messages?.length ? existing.messages : []
    };
  });

  state.projects = projects || [];
  state.stats = stats || {};
  state.loaded = true;
}

/**
 * Load full detail for a session: messages with inline tool_calls (each with
 * result), summaries, subagents, and workflow data.
 *
 * Returns the assembled session object (also updates state.sessions entry).
 */
export async function loadSessionDetail(sessionId) {
  const [messages, toolCalls, toolResults, subagents, workflows, summaries] = await Promise.all([
    window.obelisk.getSessionMessages(sessionId),
    window.obelisk.getSessionToolCalls(sessionId),
    window.obelisk.getSessionToolResults(sessionId),
    window.obelisk.getSessionSubagents(sessionId),
    window.obelisk.getSessionWorkflows(sessionId),
    window.obelisk.getSessionSummaries(sessionId),
  ]);
  const detail = assembleSessionDetail({ messages, toolCalls, toolResults, subagents, workflows, summaries });
  const snapshot = {
    messages: detail.messages,
    workflows: detail.workflows,
    summaries: detail.summaries,
  };
  const metadata = sessionMetadata(state.sessions.find(candidate => candidate.id === sessionId));
  rememberSessionMessageSnapshot(sessionId, {
    snapshot,
    cursor: createSessionPatchCursor(snapshot),
    session: metadata,
  });
  return commitSessionDetail(sessionId, snapshot, { updateStore: true, metadata });
}

export async function fetchSessionDetailPatch(sessionId) {
  const current = sessionMessageSnapshots.get(sessionId);
  if (!current || typeof window.obelisk.getSessionPatch !== 'function') {
    return { sessionId, current: null, patch: null };
  }
  const patch = await window.obelisk.getSessionPatch(sessionId, current.cursor);
  return { sessionId, current, patch };
}

export async function materializeSessionDetailPatch({ sessionId, current, patch }) {
  if (!current || !patch) return loadSessionDetail(sessionId);
  const next = applySessionPatch(current.snapshot, current.cursor, patch);
  const metadata = sessionMetadata(patch.session) || current.session;
  const latest = commitSessionDetail(sessionId, next.snapshot, {
    updateStore: false,
    metadata,
  });
  latest.acceptMessagePatch = () => {
    if (sessionMessageSnapshots.get(sessionId) !== current) return false;
    rememberSessionMessageSnapshot(sessionId, { ...next, session: metadata });
    commitStoredSessionMetadata(sessionId, metadata);
    return true;
  };
  latest.messagePatch = {
    changedIds: (patch.changes?.messages || []).map(message => message.uuid),
    removedIds: patch.removed?.messages || [],
    tailOnly: (patch.removed?.messages || []).length === 0
      && (patch.changes?.messages || []).length > 0
      && (patch.changes?.messages || []).every((message, offset) => (
        !Object.hasOwn(current.cursor.messages || {}, message.uuid)
        && patch.positions?.messages?.[message.uuid] === current.snapshot.messages.length + offset
      )),
  };
  return latest;
}

export function getCachedSessionDetail(sessionId) {
  const current = sessionMessageSnapshots.get(sessionId);
  if (!current) return null;
  return commitSessionDetail(sessionId, current.snapshot, {
    updateStore: false,
    metadata: current.session,
  });
}

function commitSessionDetail(sessionId, { messages, workflows = [], summaries = [] }, { updateStore, metadata = null }) {
  const session = state.sessions.find(candidate => candidate.id === sessionId);
  const assembled = {
    ...(session || {}),
    ...(metadata || {}),
    id: sessionId,
    messages: markRaw(messages),
    summaries: markRaw(summaries),
  };
  if (workflows.length > 0) assembled.workflow = workflows[0];

  if (updateStore) {
    const index = state.sessions.findIndex(candidate => candidate.id === sessionId);
    if (index !== -1) state.sessions[index] = assembled;
  }
  return assembled;
}

/**
 * Load full detail for a subagent conversation.
 * Returns assembled messages with tool_calls inline.
 */
export async function loadSubagentDetail(agentId) {
  const [messages, toolCalls, toolResults] = await Promise.all([
    window.obelisk.getSubagentMessages(agentId),
    window.obelisk.getSubagentToolCalls(agentId),
    window.obelisk.getSubagentToolResults(agentId),
  ]);
  return assembleSessionDetail({
    messages,
    toolCalls,
    toolResults,
    subagents: [],
    workflows: [],
  }).messages;
}

const TEXT_LIMIT = 10000;

/**
 * Check if a message text was truncated during indexing.
 */
export function isTextTruncated(text) {
  return text && text.length >= TEXT_LIMIT;
}

/**
 * Fetch the full untruncated text for a message from its source JSONL.
 * Returns the full text string or null.
 */
export async function loadFullText(uuid) {
  try {
    return await window.obelisk.getMessageFullText(uuid);
  } catch {
    return null;
  }
}

/**
 * Load the markdown content of a memory file.
 * Returns the content string or null on failure.
 */
export async function loadMemoryMarkdown(memoryPath) {
  try {
    const content = await window.obelisk.readMemoryFile(memoryPath);
    return content || null;
  } catch {
    return null;
  }
}

/**
 * Archive a memory by id. Updates state after successful IPC call.
 */
export async function archiveMemory(id) {
  await window.obelisk.archiveMemory(id);
  const mem = state.memories.find(m => m.id === id);
  if (mem) {
    mem.archived = true;
    mem.archivedAt = Date.now();
  }
}

/**
 * Restore an archived memory by id. Updates state after successful IPC call.
 */
export async function restoreMemory(id) {
  await window.obelisk.restoreMemory(id);
  const mem = state.memories.find(m => m.id === id);
  if (mem) {
    mem.archived = false;
    mem.archivedAt = null;
  }
}
