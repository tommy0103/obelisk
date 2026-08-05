// Core provider contract (see docs/adr/0001).
//
// The indexing layer splits along two orthogonal axes:
//   - Provider axis: pure per-source adapters (claude, codex, later opencode,
//     pi, …) that discover their own work and parse it into records. A source is
//     NOT assumed to be a single JSONL file — an adapter may read a SQLite store,
//     a directory tree, etc. So discovery, change-detection, and resume cursoring
//     are all adapter-owned and format-specific.
//   - Consumer axis: shared, provider-agnostic modules consume the canonical
//     transcript for persistence and session-detail presentation.
//
// This file defines only the shapes crossing that seam. Many fields mirror the
// SQLite schema, but the database is a serialization adapter rather than the
// source of transcript semantics. Types only — no runtime code — so consumers
// must import with `import type`.

// Opaque per-unit resume/watermark token. The orchestration stores it verbatim
// (in index_state) and hands it back on the next run; ONLY the adapter that
// produced it interprets it. A JSONL adapter might encode `"${mtime}:${lines}"`;
// a SQLite-backed adapter might encode a rowid or timestamp high-water mark.
export type Cursor = string | null;

// One unit of work an adapter has discovered. It is not necessarily a file: for
// a file-based source `key` is the path; for a DB-backed source it might be
// `"${dbPath}#${internalId}"`. `meta` carries adapter-private data (e.g. the
// resolved file path or source handle) that the orchestration passes back to
// parse() untouched.
export interface IndexUnit {
  /** Stable identity used as the index_state cursor key. */
  key: string;
  /** Session id this unit indexes into. */
  sessionId: string;
  /** Project slug (dash-encoded path), when the source exposes one. */
  project?: string;
  /** Set for subagent transcripts, whose messages carry an agent id. */
  isSubagent?: boolean;
  agentId?: string;
  /** Adapter-private payload, opaque to the orchestration. */
  meta?: unknown;
  /** Previously indexed sessions atomically retracted by persist before this unit is written. */
  retractSessionIds?: readonly string[];
}

/** Read-only source provenance exposed to one provider during discovery. */
export interface IndexedSession {
  sessionId: string;
  jsonlPath: string;
}

/** One source location that prevented a provider from certifying its inventory. */
export interface InventoryIssue {
  readonly path: string;
  readonly error: string;
}

/** Context the orchestration provides to discovery. */
export interface DiscoverContext {
  /** Look up the cursor persisted for a unit key on a previous run. */
  lastCursor(key: string): Cursor;
  /** When set (daemon changed-path mode), restrict discovery to these paths. */
  changedPaths?: string[];
  /** Sessions already indexed for this provider, keyed by their canonical source path. */
  indexedSessions?(): readonly IndexedSession[];
  /** Report that the source inventory could not be enumerated completely. */
  reportIncompleteInventory?(issue?: InventoryIssue): void;
}

/** Canonical language emitted by every provider adapter. Persist serializes it;
 * session-detail assembly consumes it directly. Most record kinds map to one
 * schema table; update/retraction records encode canonical state transitions. */
export type TranscriptRecord =
  | SessionRecord
  | MessageRecord
  | ToolCallRecord
  | ToolResultRecord
  | SummaryRecord
  | SubagentRecord
  | WorkflowRecord
  | WorkflowAgentRecord
  | MessageTurnDurationRecord
  | DeleteSessionRecord;

export type MessageVisibility = 'visible' | 'inactive' | 'hidden';

export interface MessageRecord {
  kind: 'message';
  uuid: string;
  session_id: string;
  type: string;
  parent_uuid: string | null;
  timestamp: string | null;
  role: string | null;
  text: string | null;
  content_type: string | null;
  is_meta: 0 | 1;
  /**
   * Provider-attested evidence state. `inactive` requires an explicit source
   * supersession signal; assemblers never infer it from text or tree shape.
   */
  visibility: MessageVisibility;
  model: string | null;
  is_sidechain: 0 | 1;
  agent_id: string | null;
  /** Provider-normalized total input, including provider-reported cached input. */
  input_tokens: number | null;
  output_tokens: number | null;
  cwd: string | null;
  skill: string | null;
  source: string;
}

export interface ToolCallRecord {
  kind: 'tool_call';
  id: string;
  message_uuid: string;
  session_id: string;
  name: string;
  presentation: 'default' | 'skill';
  input_json: string;
  file_path: string | null;
}

export interface ToolResultRecord {
  kind: 'tool_result';
  tool_use_id: string;
  message_uuid: string;
  session_id: string;
  content: string;
  file_path: string | null;
  is_error: 0 | 1;
}

export interface SummaryRecord {
  kind: 'summary';
  id: string;
  session_id: string;
  timestamp: string | null;
  source: string;
  content: string;
  /** Provider-attested evidence state. Aggregate accounting may include non-visible usage. */
  visibility?: MessageVisibility;
  /** Provider-normalized total input, including provider-reported cached input. */
  input_tokens?: number | null;
  output_tokens?: number | null;
}

// One codex subagent. Like workflow_agent, a row can be contributed by more than
// one point in the parse (the spawn event vs the agent's own thread), so non-key
// fields are optional and persist merges them column-wise with COALESCE.
export interface SubagentRecord {
  kind: 'subagent';
  agent_id: string;
  session_id: string;
  parent_tool_use_id?: string | null;
  agent_type?: string | null;
  description?: string | null;
  duration_ms?: number | null;
  total_tokens?: number | null;
}

// A workflow run. `agent_count` is optional presentation metadata; persist still
// computes the authoritative aggregate because agents may arrive on other runs.
export interface WorkflowRecord {
  kind: 'workflow';
  run_id: string;
  session_id: string;
  parent_tool_use_id?: string | null;
  task_id: string | null;
  script: string | null;
  result_json: string | null;
  timestamp: string | null;
  agent_count: number;
  duration_ms: number | null;
  total_tokens: number | null;
  status: string | null;
  workflow_name: string | null;
}

// One workflow agent. A single row is contributed by TWO independent units, in
// any order: the subagent .meta.json unit fills agent_type/description; the
// workflow run json unit fills phase/label/model/state/duration_ms/tokens/
// tool_calls. So every optional field a unit does not know is omitted, and
// persist merges column-wise (ON CONFLICT(agent_id) DO UPDATE SET
// col=COALESCE(excluded.col, col)). All contributors MUST use the same unified
// agent_id key so the merge lands on the same row.
export interface WorkflowAgentRecord {
  kind: 'workflow_agent';
  agent_id: string;
  run_id: string;
  session_id: string;
  agent_type?: string | null;
  description?: string | null;
  phase?: string | null;
  label?: string | null;
  model?: string | null;
  state?: string | null;
  duration_ms?: number | null;
  tokens?: number | null;
  tool_calls?: number | null;
}

// Update op (not a table): sets messages.turn_duration_ms for a message that was
// (or will be) inserted by a separate line, possibly on a different run. Persist
// applies it as a targeted UPDATE, so it never clobbers other message columns.
export interface MessageTurnDurationRecord {
  kind: 'message-turn-duration';
  uuid: string;
  turn_duration_ms: number | null;
}

// Retraction op (not a table). An adapter emits this when removal is discovered
// during parsing, e.g. a Codex guardian thread. Discovery-known retractions use
// IndexUnit.retractSessionIds instead. Persist cascades either form.
export interface DeleteSessionRecord {
  kind: 'delete-session';
  sessionId: string;
}

// Session-level aggregate. Emitted once, after the unit's records are produced,
// because started_at/ended_at/message_count are computed across the stream.
// title/ended_at may be enriched by the adapter from source-specific auxiliary
// files (claude history.jsonl, codex session_index.jsonl); persist upserts with
// fill-if-null (COALESCE) so those never clobber a value already present.
// project_path is NOT set here — the orchestration's global pass derives it from
// persisted message cwds (refreshSessionProjectPaths).
//
// countMode tells persist how to treat message_count, because providers differ:
// a line-incremental adapter (claude) yields only new messages ('delta', persist
// accumulates onto the existing row); a full-reparse adapter (codex) yields every
// message each run ('total', persist replaces). A 'delta' parse from an empty
// cursor is equivalent to 'total'. The count describes the standard visible
// transcript surface; records behind inactive/hidden visibility do not contribute.
export interface SessionRecord {
  kind: 'session';
  id: string;
  title: string | null;
  project: string | null;
  started_at: string | null;
  ended_at: string | null;
  git_branch: string | null;
  version: string | null;
  message_count: number;
  countMode: 'total' | 'delta';
  jsonl_path: string;
  source: string;
}

// A transcript source. Pure: it never touches the Obelisk database. It owns its
// own discovery, change-detection, and resume cursoring, because those are
// format-specific (file mtime, DB watermark, …). `parse` is a generator that
// yields records for one unit and RETURNS the new cursor to persist.
export interface Provider {
  /** Stable source tag stored on rows, e.g. 'claude' | 'codex'. */
  readonly name: string;
  /** Discover units needing (re)indexing, using stored cursors to detect change. */
  discover(ctx: DiscoverContext): IndexUnit[];
  /** Yield records for one unit resuming from `cursor`; return the new cursor. */
  parse(unit: IndexUnit, cursor: Cursor): Generator<TranscriptRecord, Cursor>;
}

/** Serializable source metadata consumed by settings and renderer surfaces. */
export interface ProviderDescriptor {
  readonly id: string;
  readonly name: string;
  readonly vendor: string;
  readonly defaultRoot: string;
  readonly color: string;
  /** The automatic root is ambiguous; callers must preserve omission until the user chooses one. */
  readonly requiresExplicitRoot?: boolean;
  /** User-facing explanation for an unavailable automatic root. */
  readonly rootResolutionReason?: string;
}

export interface RawLookup {
  readonly source: string;
  readonly messageUuid: string;
  readonly session: Record<string, unknown> | null;
  readonly agentId: string | null;
  /** Cursor committed for this session's source unit, when available. */
  readonly cursor?: Cursor;
  readonly subagent?: Record<string, unknown> | null;
  readonly workflowAgent?: Record<string, unknown> | null;
}

export interface RawRecord {
  readonly text: string;
  readonly totalLength?: number;
  readonly offset?: number;
  readonly limit?: number;
  readonly hasMore?: boolean;
  /** Provider-projected full message body for renderer expansion. */
  readonly messageText?: string | null;
}

/** Complete adapter interface used by every indexing and presentation caller. */
export interface ProviderAdapter extends Provider {
  readonly descriptor: ProviderDescriptor;
  /** Optional index semantics marker; absence forces one provider-owned replay. */
  readonly indexVersionMarker?: string;
  watchRoots(configuredRoot: string): string[];
  raw(input: RawLookup): RawRecord | null;
}
