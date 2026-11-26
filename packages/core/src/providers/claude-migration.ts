// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Explicit compatibility migration for Claude Code multi-root identities.
//
// Pre-v7 indexes stored bare session/message/tool/subagent/workflow IDs even
// when `providerRoots.claude` pointed to a custom root directory. v7 assigns
// every non-default root a deterministic, list-independent namespace so custom
// single-root installs transitioning to an explicit root array keep stable IDs
// without splitting history or colliding across roots.

import { dirname, join } from 'node:path';

import { redirectSessionMemories } from '../persist.ts';
import { readProviderSessionProvenance, type StoredProviderState } from '../provider-indexing.ts';
import type { SqliteDb, SqliteRow } from '../sqlite-types.ts';
import {
  CLAUDE_CANONICAL_TRANSCRIPT_MARKER,
  legacyClaudeMigrationTargets,
  pathInside,
  sameNormalizedPath,
} from './claude.ts';

interface PriorClaudeSession {
  readonly source: string;
  readonly sessionId: string;
  readonly jsonlPath: string;
}

function prefixScopedId(value: string, newSessionId: string, oldSessionId: string): string {
  if (value.startsWith(`${newSessionId}:`)) return value;
  if (value.startsWith(`${oldSessionId}:`)) {
    return `${newSessionId}:${value.slice(oldSessionId.length + 1)}`;
  }
  return `${newSessionId}:${value}`;
}

function tableExists(db: SqliteDb, table: string): boolean {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function deleteOldClaudeSession(db: SqliteDb, oldSessionId: string): void {
  db.prepare('DELETE FROM tool_results WHERE session_id=? OR message_uuid IN (SELECT uuid FROM messages WHERE session_id=? OR agent_id=?)')
    .run(oldSessionId, oldSessionId, oldSessionId);
  db.prepare('DELETE FROM tool_calls WHERE session_id=? OR message_uuid IN (SELECT uuid FROM messages WHERE session_id=? OR agent_id=?)')
    .run(oldSessionId, oldSessionId, oldSessionId);
  db.prepare('DELETE FROM messages WHERE session_id=? OR agent_id=?').run(oldSessionId, oldSessionId);
  db.prepare('DELETE FROM subagents WHERE agent_id=? OR session_id=?').run(oldSessionId, oldSessionId);
  db.prepare('DELETE FROM workflow_agents WHERE session_id=?').run(oldSessionId);
  db.prepare('DELETE FROM workflows WHERE session_id=?').run(oldSessionId);
  db.prepare('DELETE FROM summaries WHERE session_id=?').run(oldSessionId);
  db.prepare('DELETE FROM sessions WHERE id=?').run(oldSessionId);
}

function migrateSessionRows(db: SqliteDb, oldId: string, newId: string, jsonlPath: string): void {
  const toolResults = db.prepare(`
    SELECT rowid, tool_use_id, message_uuid FROM tool_results
    WHERE session_id = ? OR message_uuid IN (SELECT uuid FROM messages WHERE session_id = ? OR agent_id = ?)
  `).all(oldId, oldId, oldId) as SqliteRow[];
  const hasToolResult = db.prepare('SELECT 1 FROM tool_results WHERE tool_use_id = ?');
  const updateToolResult = db.prepare('UPDATE tool_results SET tool_use_id = ?, message_uuid = ?, session_id = ? WHERE rowid = ?');
  const deleteToolResult = db.prepare('DELETE FROM tool_results WHERE rowid = ?');
  for (const row of toolResults) {
    const oldPk = String(row.tool_use_id);
    const nextPk = prefixScopedId(oldPk, newId, oldId);
    const nextMsg = typeof row.message_uuid === 'string' ? prefixScopedId(row.message_uuid, newId, oldId) : null;
    if (nextPk !== oldPk && hasToolResult.get(nextPk)) deleteToolResult.run(row.rowid);
    else updateToolResult.run(nextPk, nextMsg, newId, row.rowid);
  }

  const toolCalls = db.prepare(`
    SELECT rowid, id, message_uuid FROM tool_calls
    WHERE session_id = ? OR message_uuid IN (SELECT uuid FROM messages WHERE session_id = ? OR agent_id = ?)
  `).all(oldId, oldId, oldId) as SqliteRow[];
  const hasToolCall = db.prepare('SELECT 1 FROM tool_calls WHERE id = ?');
  const updateToolCall = db.prepare('UPDATE tool_calls SET id = ?, message_uuid = ?, session_id = ? WHERE rowid = ?');
  const deleteToolCall = db.prepare('DELETE FROM tool_calls WHERE rowid = ?');
  for (const row of toolCalls) {
    const oldPk = String(row.id);
    const nextPk = prefixScopedId(oldPk, newId, oldId);
    const nextMsg = typeof row.message_uuid === 'string' ? prefixScopedId(row.message_uuid, newId, oldId) : null;
    if (nextPk !== oldPk && hasToolCall.get(nextPk)) deleteToolCall.run(row.rowid);
    else updateToolCall.run(nextPk, nextMsg, newId, row.rowid);
  }

  const messages = db.prepare('SELECT rowid, uuid, parent_uuid, agent_id FROM messages WHERE session_id = ? OR agent_id = ?')
    .all(oldId, oldId) as SqliteRow[];
  const hasMessage = db.prepare('SELECT 1 FROM messages WHERE uuid = ?');
  const updateMessage = db.prepare('UPDATE messages SET uuid = ?, parent_uuid = ?, agent_id = ?, session_id = ? WHERE rowid = ?');
  const deleteMessage = db.prepare('DELETE FROM messages WHERE rowid = ?');
  for (const row of messages) {
    const oldPk = String(row.uuid);
    const nextPk = prefixScopedId(oldPk, newId, oldId);
    const nextParent = typeof row.parent_uuid === 'string' && row.parent_uuid.length > 0
      ? prefixScopedId(row.parent_uuid, newId, oldId)
      : row.parent_uuid ?? null;
    const nextAgent = typeof row.agent_id === 'string' && row.agent_id.length > 0
      ? prefixScopedId(row.agent_id, newId, oldId)
      : row.agent_id ?? null;
    if (nextPk !== oldPk && hasMessage.get(nextPk)) deleteMessage.run(row.rowid);
    else updateMessage.run(nextPk, nextParent, nextAgent, newId, row.rowid);
  }

  const subagents = db.prepare('SELECT rowid, agent_id, parent_tool_use_id FROM subagents WHERE session_id = ? OR agent_id = ?')
    .all(oldId, oldId) as SqliteRow[];
  const hasSubagent = db.prepare('SELECT 1 FROM subagents WHERE agent_id = ?');
  const updateSubagent = db.prepare('UPDATE subagents SET agent_id = ?, parent_tool_use_id = ?, session_id = ? WHERE rowid = ?');
  const deleteSubagent = db.prepare('DELETE FROM subagents WHERE rowid = ?');
  for (const row of subagents) {
    const oldPk = String(row.agent_id);
    const nextPk = prefixScopedId(oldPk, newId, oldId);
    const nextParent = typeof row.parent_tool_use_id === 'string' && row.parent_tool_use_id.length > 0
      ? prefixScopedId(row.parent_tool_use_id, newId, oldId)
      : row.parent_tool_use_id ?? null;
    if (nextPk !== oldPk && hasSubagent.get(nextPk)) deleteSubagent.run(row.rowid);
    else updateSubagent.run(nextPk, nextParent, newId, row.rowid);
  }

  const workflowAgents = db.prepare('SELECT rowid, agent_id, run_id FROM workflow_agents WHERE session_id = ?')
    .all(oldId) as SqliteRow[];
  const hasWorkflowAgent = db.prepare('SELECT 1 FROM workflow_agents WHERE agent_id = ?');
  const updateWorkflowAgent = db.prepare('UPDATE workflow_agents SET agent_id = ?, run_id = ?, session_id = ? WHERE rowid = ?');
  const deleteWorkflowAgent = db.prepare('DELETE FROM workflow_agents WHERE rowid = ?');
  for (const row of workflowAgents) {
    const oldPk = String(row.agent_id);
    const nextPk = prefixScopedId(oldPk, newId, oldId);
    const nextRun = typeof row.run_id === 'string' && row.run_id.length > 0
      ? prefixScopedId(row.run_id, newId, oldId)
      : row.run_id ?? null;
    if (nextPk !== oldPk && hasWorkflowAgent.get(nextPk)) deleteWorkflowAgent.run(row.rowid);
    else updateWorkflowAgent.run(nextPk, nextRun, newId, row.rowid);
  }

  const workflows = db.prepare('SELECT rowid, run_id, parent_tool_use_id FROM workflows WHERE session_id = ?')
    .all(oldId) as SqliteRow[];
  const hasWorkflow = db.prepare('SELECT 1 FROM workflows WHERE run_id = ?');
  const updateWorkflow = db.prepare('UPDATE workflows SET run_id = ?, parent_tool_use_id = ?, session_id = ? WHERE rowid = ?');
  const deleteWorkflow = db.prepare('DELETE FROM workflows WHERE rowid = ?');
  for (const row of workflows) {
    const oldPk = String(row.run_id);
    const nextPk = prefixScopedId(oldPk, newId, oldId);
    const nextParent = typeof row.parent_tool_use_id === 'string' && row.parent_tool_use_id.length > 0
      ? prefixScopedId(row.parent_tool_use_id, newId, oldId)
      : row.parent_tool_use_id ?? null;
    if (nextPk !== oldPk && hasWorkflow.get(nextPk)) deleteWorkflow.run(row.rowid);
    else updateWorkflow.run(nextPk, nextParent, newId, row.rowid);
  }

  const summaries = db.prepare('SELECT rowid, id FROM summaries WHERE session_id = ?').all(oldId) as SqliteRow[];
  const hasSummary = db.prepare('SELECT 1 FROM summaries WHERE id = ?');
  const updateSummary = db.prepare('UPDATE summaries SET id = ?, session_id = ? WHERE rowid = ?');
  const deleteSummary = db.prepare('DELETE FROM summaries WHERE rowid = ?');
  for (const row of summaries) {
    const oldPk = String(row.id);
    const nextPk = prefixScopedId(oldPk, newId, oldId);
    if (nextPk !== oldPk && hasSummary.get(nextPk)) deleteSummary.run(row.rowid);
    else updateSummary.run(nextPk, newId, row.rowid);
  }

  db.prepare('UPDATE sessions SET id = ? WHERE id = ?').run(newId, oldId);

  if (tableExists(db, 'index_state')) {
    const sessionDir = join(dirname(jsonlPath), oldId);
    const checkpoints = db.prepare("SELECT jsonl_path FROM index_state WHERE jsonl_path NOT LIKE '\\_\\_%' ESCAPE '\\'").all() as SqliteRow[];
    const markReplay = db.prepare('UPDATE index_state SET replay_required = 1 WHERE jsonl_path = ?');
    for (const checkpoint of checkpoints) {
      const key = String(checkpoint.jsonl_path);
      if (sameNormalizedPath(key, jsonlPath) || pathInside(sessionDir, key)) {
        markReplay.run(key);
      }
    }
  }
}

interface LegacyClaudeMigration {
  oldId: string;
  newId: string;
  jsonlPath: string;
}

export function planLegacyClaudeRootIdentityMigration(
  db: SqliteDb,
  defaultRoot: string,
  configuredRoots: readonly string[],
  priorSessions: readonly PriorClaudeSession[] = readProviderSessionProvenance(db),
  priorIndexState?: ReadonlyMap<string, StoredProviderState>,
): LegacyClaudeMigration[] {
  const hasStoredState = db.prepare('SELECT 1 FROM index_state WHERE jsonl_path = ?');
  const hasIndexState = (key: string) => priorIndexState === undefined
    ? Boolean(hasStoredState.get(key))
    : priorIndexState.has(key);
  // A durable v7 marker records that bare-ID identities were already handled.
  // Its cursor is normally NULL, so cursor value cannot distinguish the row
  // from an absent marker. The v8 marker has the same row-presence contract.
  if (hasIndexState('__claude_canonical_transcript_v7__')
    || hasIndexState(CLAUDE_CANONICAL_TRANSCRIPT_MARKER)) return [];
  if (!priorSessions.some(session => session.source === 'claude' && !session.sessionId.includes(':'))) return [];
  const readCursor = db.prepare('SELECT cursor FROM index_state WHERE jsonl_path = ?');
  const claudeSessions = priorSessions.filter(session => session.source === 'claude' && session.sessionId && session.jsonlPath);
  return legacyClaudeMigrationTargets(defaultRoot, configuredRoots, claudeSessions, (path) => {
    const cursor = priorIndexState?.has(path)
      ? priorIndexState.get(path)?.cursor
      : readCursor.get(path)?.cursor;
    return typeof cursor === 'string' ? cursor : null;
  });
}

/**
 * Atomically migrate pre-v7 bare Claude identities under non-default roots to
 * their deterministic v7 root-tagged identities. Caller must invoke inside a
 * write transaction under the writer lease.
 */
export function reconcileLegacyClaudeRootIdentities(
  db: SqliteDb,
  candidates: readonly LegacyClaudeMigration[],
): number {
  if (candidates.length === 0) return 0;

  const hasMemories = tableExists(db, 'memories');
  const hasSession = db.prepare('SELECT 1 FROM sessions WHERE id = ?');

  let migrated = 0;
  for (const { oldId, newId, jsonlPath } of candidates) {
    if (hasMemories) redirectSessionMemories(db, { oldId, newId, oldPrefix: '', newPrefix: `${newId}:` });
    if (!hasSession.get(oldId)) continue;
    if (hasSession.get(newId)) {
      deleteOldClaudeSession(db, oldId);
    } else {
      migrateSessionRows(db, oldId, newId, jsonlPath);
    }
    migrated++;
  }
  return migrated;
}
