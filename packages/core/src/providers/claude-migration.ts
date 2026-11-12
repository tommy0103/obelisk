// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Explicit compatibility migration for Claude Code multi-root identities.
//
// Pre-v7 indexes stored bare session/message/tool/subagent/workflow IDs even
// when `providerRoots.claude` pointed to a custom root directory. v7 assigns
// every non-default root a deterministic, list-independent namespace so custom
// single-root installs transitioning to an explicit root array keep stable IDs
// without splitting history or colliding across roots.

import { basename, dirname, join } from 'node:path';

import type { SqliteDb, SqliteRow } from '../sqlite-types.ts';
import {
  canonicalSessionId,
  pathInside,
  rootTagFor,
  sameNormalizedPath,
} from './claude.ts';

interface PriorClaudeSession {
  readonly source: string;
  readonly sessionId: string;
  readonly jsonlPath: string;
}

function claudeRootFromJsonlPath(jsonlPath: string): string | null {
  const projectDir = dirname(jsonlPath);
  const projectsDir = dirname(projectDir);
  if (basename(projectsDir) !== 'projects') return null;
  const rootDir = dirname(projectsDir);
  return rootDir && rootDir !== projectsDir ? rootDir : null;
}

function resolveRootForJsonlPath(
  jsonlPath: string,
  defaultRoot: string,
  configuredRoots: readonly string[],
): string | null {
  const inferred = claudeRootFromJsonlPath(jsonlPath);
  if (inferred !== null) {
    if (sameNormalizedPath(inferred, defaultRoot)) return defaultRoot;
    for (const root of configuredRoots) {
      if (sameNormalizedPath(inferred, root)) return root;
    }
  }
  for (const root of configuredRoots) {
    if (pathInside(root, jsonlPath)) return root;
  }
  if (pathInside(defaultRoot, jsonlPath)) return defaultRoot;
  return inferred;
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

function collectLegacyCandidates(
  db: SqliteDb,
  defaultRoot: string,
  configuredRoots: readonly string[] = [],
  priorSessions: readonly PriorClaudeSession[] = [],
): Map<string, { oldId: string; newId: string; jsonlPath: string }> {
  const candidates = new Map<string, { oldId: string; newId: string; jsonlPath: string }>();
  if (!tableExists(db, 'sessions')) return candidates;

  const register = (oldId: string, jsonlPath: string) => {
    if (!oldId || oldId.includes(':') || !jsonlPath) return;
    const root = resolveRootForJsonlPath(jsonlPath, defaultRoot, configuredRoots);
    if (root === null) return;
    const tag = rootTagFor(root, defaultRoot);
    if (!tag) return;
    const newId = canonicalSessionId(oldId, tag);
    if (newId !== oldId && !candidates.has(oldId)) {
      candidates.set(oldId, { oldId, newId, jsonlPath });
    }
  };

  const rows = db.prepare(`
    SELECT id, jsonl_path FROM sessions
    WHERE COALESCE(source, 'claude') = 'claude'
      AND jsonl_path IS NOT NULL
      AND jsonl_path != ''
  `).all() as SqliteRow[];
  for (const row of rows) {
    register(String(row.id), String(row.jsonl_path));
  }
  for (const session of priorSessions) {
    if (session.source === 'claude') {
      register(session.sessionId, session.jsonlPath);
    }
  }
  return candidates;
}

export function needsClaudeIdentityMigration(
  db: SqliteDb,
  defaultRoot: string,
  configuredRoots: readonly string[] = [],
): boolean {
  return collectLegacyCandidates(db, defaultRoot, configuredRoots).size > 0;
}

/**
 * Atomically migrate pre-v7 bare Claude identities under non-default roots to
 * their deterministic v7 root-tagged identities. Caller must invoke inside a
 * write transaction under the writer lease.
 */
export function reconcileLegacyClaudeRootIdentities(
  db: SqliteDb,
  defaultRoot: string,
  configuredRoots: readonly string[] = [],
  priorSessions: readonly PriorClaudeSession[] = [],
): number {
  const candidates = collectLegacyCandidates(db, defaultRoot, configuredRoots, priorSessions);
  if (candidates.size === 0) return 0;

  const hasMemories = tableExists(db, 'memories');
  const updateMemories = hasMemories
    ? db.prepare('UPDATE memories SET session_id = ? WHERE session_id = ?')
    : null;
  const hasSession = db.prepare('SELECT 1 FROM sessions WHERE id = ?');

  let migrated = 0;
  for (const { oldId, newId, jsonlPath } of candidates.values()) {
    updateMemories?.run(newId, oldId);
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
