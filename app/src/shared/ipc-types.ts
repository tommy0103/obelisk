// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

export interface SourceQueryOptions {
  source?: string;
}

export type UsageStatsOptions = SourceQueryOptions;

export type SessionPatchTable =
  | 'messages'
  | 'toolCalls'
  | 'toolResults'
  | 'subagents'
  | 'workflows'
  | 'summaries';

export type SessionPatchRow = Record<string, unknown>;
export type SessionPatchSnapshot = Partial<Record<SessionPatchTable, SessionPatchRow[]>>;
export type SessionPatchCursor = Record<SessionPatchTable, Record<string, string>>;

export interface SessionMetadata {
  id: string;
  title?: string | null;
  project?: string | null;
  project_path?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  git_branch?: string | null;
  version?: string | null;
  message_count?: number | null;
  jsonl_path?: string | null;
  source?: string | null;
}

export interface SessionPatch {
  changes: Record<SessionPatchTable, SessionPatchRow[]>;
  removed: Record<SessionPatchTable, string[]>;
  hashes: Record<SessionPatchTable, Record<string, string>>;
  positions: Record<SessionPatchTable, Record<string, number>>;
  session?: SessionMetadata | null;
}

export interface AppliedSessionPatch {
  snapshot: Record<SessionPatchTable, SessionPatchRow[]>;
  cursor: SessionPatchCursor;
}
