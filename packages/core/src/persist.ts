// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Shared Core persist layer (see docs/adr/0001).
//
// Provider-agnostic and binding-agnostic: it consumes the TranscriptRecord stream
// from any adapter's parse() and writes rows into the injected database handle
// (node:sqlite for the CLI, better-sqlite3 for the app — they share the
// prepare/run/get API). It is the ONLY layer that touches the database and the
// only place that knows the schema. Adapters stay pure.
//
// Write semantics are the canonical ones reconciled from the drift: messages
// and tool rows are prefetched in bounded batches so only new or changed values
// execute an upsert; sessions merge with any existing row (started_at MIN,
// ended_at MAX, message_count
// reset-or-accumulate, fill-if-null for the rest); turn-duration is a targeted
// conditional UPDATE; delete-session cascades. The generator's return value is
// the new cursor, persisted verbatim into index_state.

import type {
  Cursor,
  IndexUnit,
  MessageRecord,
  ToolCallRecord,
  ToolResultRecord,
  TranscriptRecord,
} from './providers/types.ts';
import type { SqliteDb, SqliteRow } from './sqlite-types.ts';

const REPLAY_FILTER_THRESHOLD = 250;
const SQLITE_SAFE_KEY_COUNT = 900;

const MESSAGE_FIELDS = [
  'session_id', 'type', 'parent_uuid', 'timestamp', 'role', 'text',
  'content_type', 'is_meta', 'visibility', 'model', 'is_sidechain',
  'agent_id', 'input_tokens', 'output_tokens', 'cwd', 'skill', 'source',
] as const satisfies readonly (keyof MessageRecord)[];
const TOOL_CALL_FIELDS = [
  'message_uuid', 'session_id', 'name', 'presentation', 'input_json', 'file_path',
] as const satisfies readonly (keyof ToolCallRecord)[];
const TOOL_RESULT_FIELDS = [
  'message_uuid', 'session_id', 'content', 'file_path', 'is_error',
] as const satisfies readonly (keyof ToolResultRecord)[];

interface ReplayState {
  messages: Map<string, SqliteRow>;
  toolCalls: Map<string, SqliteRow>;
  toolResults: Map<string, SqliteRow>;
}

function sameFields<T extends object>(row: SqliteRow, record: T, fields: readonly (keyof T)[]): boolean {
  return fields.every(field => row[String(field)] === record[field]);
}

function uniqueKeys(records: readonly TranscriptRecord[], kinds: readonly TranscriptRecord['kind'][]): string[] {
  const accepted = new Set(kinds);
  const keys = new Set<string>();
  for (const record of records) {
    if (!accepted.has(record.kind)) continue;
    if (record.kind === 'message' || record.kind === 'message-turn-duration') keys.add(record.uuid);
    else if (record.kind === 'tool_call') keys.add(record.id);
    else if (record.kind === 'tool_result') keys.add(record.tool_use_id);
  }
  return [...keys];
}

function loadRows(
  db: SqliteDb,
  table: 'messages' | 'tool_calls' | 'tool_results',
  keyColumn: 'uuid' | 'id' | 'tool_use_id',
  columns: string,
  keys: readonly string[],
): Map<string, SqliteRow> {
  if (keys.length === 0) return new Map();
  // Identifiers are closed unions supplied by this module. Transcript keys
  // remain bound values and never enter the SQL text.
  const result = new Map<string, SqliteRow>();
  for (let offset = 0; offset < keys.length; offset += SQLITE_SAFE_KEY_COUNT) {
    const chunk = keys.slice(offset, offset + SQLITE_SAFE_KEY_COUNT);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db.prepare(`SELECT ${columns} FROM ${table} WHERE ${keyColumn} IN (${placeholders})`).all(...chunk);
    for (const row of rows) result.set(String(row[keyColumn]), row);
  }
  return result;
}

function loadReplayState(db: SqliteDb, records: readonly TranscriptRecord[]): ReplayState {
  const messageKeys = uniqueKeys(records, ['message', 'message-turn-duration']);
  const toolCallKeys = uniqueKeys(records, ['tool_call']);
  const toolResultKeys = uniqueKeys(records, ['tool_result']);
  return {
    messages: loadRows(
      db,
      'messages',
      'uuid',
      `uuid,${MESSAGE_FIELDS.join(',')},turn_duration_ms`,
      messageKeys,
    ),
    toolCalls: loadRows(db, 'tool_calls', 'id', `id,${TOOL_CALL_FIELDS.join(',')}`, toolCallKeys),
    toolResults: loadRows(
      db,
      'tool_results',
      'tool_use_id',
      `tool_use_id,${TOOL_RESULT_FIELDS.join(',')}`,
      toolResultKeys,
    ),
  };
}

const minStr = (a: string | null, b: string | null) => (a == null ? b : b == null ? a : a < b ? a : b);
const maxStr = (a: string | null, b: string | null) => (a == null ? b : b == null ? a : a > b ? a : b);

function statements(db: SqliteDb) {
  return {
    msg: db.prepare(`
      INSERT INTO messages (uuid,session_id,type,parent_uuid,timestamp,role,text,content_type,is_meta,visibility,model,is_sidechain,agent_id,input_tokens,output_tokens,cwd,skill,source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(uuid) DO UPDATE SET
        session_id=excluded.session_id, type=excluded.type, parent_uuid=excluded.parent_uuid,
        timestamp=excluded.timestamp, role=excluded.role, text=excluded.text,
        content_type=excluded.content_type, is_meta=excluded.is_meta,
        visibility=excluded.visibility, model=excluded.model,
        is_sidechain=excluded.is_sidechain, agent_id=excluded.agent_id,
        input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
        cwd=excluded.cwd, skill=excluded.skill, source=excluded.source
      WHERE messages.session_id IS NOT excluded.session_id
        OR messages.type IS NOT excluded.type
        OR messages.parent_uuid IS NOT excluded.parent_uuid
        OR messages.timestamp IS NOT excluded.timestamp
        OR messages.role IS NOT excluded.role
        OR messages.text IS NOT excluded.text
        OR messages.content_type IS NOT excluded.content_type
        OR messages.is_meta IS NOT excluded.is_meta
        OR messages.visibility IS NOT excluded.visibility
        OR messages.model IS NOT excluded.model
        OR messages.is_sidechain IS NOT excluded.is_sidechain
        OR messages.agent_id IS NOT excluded.agent_id
        OR messages.input_tokens IS NOT excluded.input_tokens
        OR messages.output_tokens IS NOT excluded.output_tokens
        OR messages.cwd IS NOT excluded.cwd
        OR messages.skill IS NOT excluded.skill
        OR messages.source IS NOT excluded.source`),
    tc: db.prepare(`
      INSERT INTO tool_calls (id,message_uuid,session_id,name,presentation,input_json,file_path)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        message_uuid=excluded.message_uuid,
        session_id=excluded.session_id,
        name=excluded.name,
        presentation=excluded.presentation,
        input_json=excluded.input_json,
        file_path=excluded.file_path
      WHERE tool_calls.message_uuid IS NOT excluded.message_uuid
        OR tool_calls.session_id IS NOT excluded.session_id
        OR tool_calls.name IS NOT excluded.name
        OR tool_calls.presentation IS NOT excluded.presentation
        OR tool_calls.input_json IS NOT excluded.input_json
        OR tool_calls.file_path IS NOT excluded.file_path`),
    tr: db.prepare(`
      INSERT INTO tool_results (tool_use_id,message_uuid,session_id,content,file_path,is_error)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(tool_use_id) DO UPDATE SET
        message_uuid=excluded.message_uuid,
        session_id=excluded.session_id,
        content=excluded.content,
        file_path=excluded.file_path,
        is_error=excluded.is_error
      WHERE tool_results.message_uuid IS NOT excluded.message_uuid
        OR tool_results.session_id IS NOT excluded.session_id
        OR tool_results.content IS NOT excluded.content
        OR tool_results.file_path IS NOT excluded.file_path
        OR tool_results.is_error IS NOT excluded.is_error`),
    sum: db.prepare('INSERT OR REPLACE INTO summaries (id,session_id,timestamp,source,content,visibility,input_tokens,output_tokens) VALUES (?,?,?,?,?,?,?,?)'),
    ses: db.prepare('INSERT OR REPLACE INTO sessions (id,title,project,project_path,started_at,ended_at,git_branch,version,message_count,jsonl_path,source) VALUES (?,?,?,?,?,?,?,?,?,?,?)'),
    sub: db.prepare(`
      INSERT INTO subagents (agent_id,session_id,parent_tool_use_id,agent_type,description,duration_ms,total_tokens)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(agent_id) DO UPDATE SET
        session_id=excluded.session_id,
        parent_tool_use_id=COALESCE(excluded.parent_tool_use_id, subagents.parent_tool_use_id),
        agent_type=COALESCE(excluded.agent_type, subagents.agent_type),
        description=COALESCE(excluded.description, subagents.description),
        duration_ms=COALESCE(excluded.duration_ms, subagents.duration_ms),
        total_tokens=COALESCE(excluded.total_tokens, subagents.total_tokens)`),
    wf: db.prepare(`
      INSERT OR REPLACE INTO workflows
        (run_id,session_id,parent_tool_use_id,task_id,script,result_json,timestamp,agent_count,duration_ms,total_tokens,status,workflow_name)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
    wa: db.prepare(`
      INSERT INTO workflow_agents
        (agent_id,run_id,session_id,agent_type,description,phase,label,model,state,duration_ms,tokens,tool_calls)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(agent_id) DO UPDATE SET
        run_id=excluded.run_id, session_id=excluded.session_id,
        agent_type=COALESCE(excluded.agent_type, workflow_agents.agent_type),
        description=COALESCE(excluded.description, workflow_agents.description),
        phase=COALESCE(excluded.phase, workflow_agents.phase),
        label=COALESCE(excluded.label, workflow_agents.label),
        model=COALESCE(excluded.model, workflow_agents.model),
        state=COALESCE(excluded.state, workflow_agents.state),
        duration_ms=COALESCE(excluded.duration_ms, workflow_agents.duration_ms),
        tokens=COALESCE(excluded.tokens, workflow_agents.tokens),
        tool_calls=COALESCE(excluded.tool_calls, workflow_agents.tool_calls)`),
    turn: db.prepare('UPDATE messages SET turn_duration_ms=? WHERE uuid=? AND turn_duration_ms IS NOT ?'),
    idx: db.prepare('INSERT OR REPLACE INTO index_state (jsonl_path,mtime,lines_processed,cursor) VALUES (?,?,?,?)'),
    getSession: db.prepare('SELECT * FROM sessions WHERE id=?'),
  };
}

// Cascade-delete every row belonging to a session/thread (guardian retraction).
function deleteSession(db: SqliteDb, sessionId: string) {
  db.prepare('DELETE FROM tool_results WHERE session_id=? OR message_uuid IN (SELECT uuid FROM messages WHERE session_id=? OR agent_id=?)').run(sessionId, sessionId, sessionId);
  db.prepare('DELETE FROM tool_calls WHERE session_id=? OR message_uuid IN (SELECT uuid FROM messages WHERE session_id=? OR agent_id=?)').run(sessionId, sessionId, sessionId);
  db.prepare('DELETE FROM messages WHERE session_id=? OR agent_id=?').run(sessionId, sessionId);
  db.prepare('DELETE FROM subagents WHERE agent_id=? OR session_id=?').run(sessionId, sessionId);
  db.prepare('DELETE FROM workflow_agents WHERE session_id=?').run(sessionId);
  db.prepare('DELETE FROM workflows WHERE session_id=?').run(sessionId);
  db.prepare('DELETE FROM summaries WHERE session_id=?').run(sessionId);
  db.prepare('DELETE FROM sessions WHERE id=?').run(sessionId);
}

// Consume one unit's record stream into the database and return the new cursor
// (also written to index_state). `db` is any SQLite handle sharing prepare/run.
export function persist(db: SqliteDb, unit: IndexUnit, gen: Generator<TranscriptRecord, Cursor>): Cursor {
  const st = statements(db);
  for (const sessionId of unit.retractSessionIds ?? []) deleteSession(db, sessionId);

  const write = (r: TranscriptRecord, replay: ReplayState | null) => {
    switch (r.kind) {
      case 'message': {
        const previous = replay?.messages.get(r.uuid);
        if (replay != null && previous != null && sameFields(previous, r, MESSAGE_FIELDS)) break;
        st.msg.run(r.uuid, r.session_id, r.type, r.parent_uuid, r.timestamp, r.role, r.text, r.content_type, r.is_meta, r.visibility, r.model, r.is_sidechain, r.agent_id, r.input_tokens, r.output_tokens, r.cwd, r.skill, r.source);
        replay?.messages.set(r.uuid, { ...r, turn_duration_ms: previous?.turn_duration_ms ?? null });
        break;
      }
      case 'tool_call': {
        const previous = replay?.toolCalls.get(r.id);
        if (replay != null && previous != null && sameFields(previous, r, TOOL_CALL_FIELDS)) break;
        st.tc.run(r.id, r.message_uuid, r.session_id, r.name, r.presentation, r.input_json, r.file_path);
        replay?.toolCalls.set(r.id, r);
        break;
      }
      case 'tool_result': {
        const previous = replay?.toolResults.get(r.tool_use_id);
        if (replay != null && previous != null && sameFields(previous, r, TOOL_RESULT_FIELDS)) break;
        st.tr.run(r.tool_use_id, r.message_uuid, r.session_id, r.content, r.file_path, r.is_error);
        replay?.toolResults.set(r.tool_use_id, r);
        break;
      }
      case 'summary':
        st.sum.run(
          r.id,
          r.session_id,
          r.timestamp,
          r.source,
          r.content,
          r.visibility ?? 'visible',
          r.input_tokens ?? null,
          r.output_tokens ?? null,
        );
        break;
      case 'subagent':
        st.sub.run(r.agent_id, r.session_id, r.parent_tool_use_id ?? null, r.agent_type ?? null, r.description ?? null, r.duration_ms ?? null, r.total_tokens ?? null);
        break;
      case 'workflow':
        st.wf.run(r.run_id, r.session_id, r.parent_tool_use_id ?? null, r.task_id, r.script, r.result_json, r.timestamp, r.agent_count, r.duration_ms, r.total_tokens, r.status, r.workflow_name);
        break;
      case 'workflow_agent':
        st.wa.run(r.agent_id, r.run_id, r.session_id, r.agent_type ?? null, r.description ?? null, r.phase ?? null, r.label ?? null, r.model ?? null, r.state ?? null, r.duration_ms ?? null, r.tokens ?? null, r.tool_calls ?? null);
        break;
      case 'message-turn-duration': {
        const previous = replay?.messages.get(r.uuid);
        if (replay != null && (previous == null || previous.turn_duration_ms === r.turn_duration_ms)) break;
        st.turn.run(r.turn_duration_ms, r.uuid, r.turn_duration_ms);
        if (replay != null && previous != null) {
          replay.messages.set(r.uuid, { ...previous, turn_duration_ms: r.turn_duration_ms });
        }
        break;
      }
      case 'session': {
        const prev = st.getSession.get(r.id);
        // 'delta' accumulates onto the existing count (line-incremental adapters);
        // 'total' replaces it (full-reparse adapters).
        const message_count = r.countMode === 'delta' ? (prev?.message_count || 0) + r.message_count : r.message_count;
        st.ses.run(
          r.id,
          r.title ?? prev?.title ?? null,
          r.project ?? prev?.project ?? null,
          prev?.project_path ?? null, // authoritative project_path is set by refreshSessionProjectPaths
          minStr(prev?.started_at ?? null, r.started_at),
          maxStr(prev?.ended_at ?? null, r.ended_at),
          r.git_branch ?? prev?.git_branch ?? null,
          r.version ?? prev?.version ?? null,
          message_count,
          r.jsonl_path,
          r.source,
        );
        break;
      }
      case 'delete-session':
        deleteSession(db, r.sessionId);
        break;
      default:
        throw new Error(`persist: unhandled record kind ${(r as { kind: string }).kind}`);
    }
  };

  let replayFiltering = false;
  let batch: TranscriptRecord[] = [];
  const flush = () => {
    if (batch.length === 0) return;
    if (batch.length >= REPLAY_FILTER_THRESHOLD) replayFiltering = true;
    const replay = replayFiltering ? loadReplayState(db, batch) : null;
    for (const record of batch) write(record, replay);
    batch = [];
  };

  let step = gen.next();
  while (!step.done) {
    // A stream-level deletion invalidates any prefetched state for the session.
    // Flush around it so records after the tombstone observe the deletion.
    if (step.value.kind === 'delete-session') {
      flush();
      write(step.value, null);
    } else {
      batch.push(step.value);
      if (batch.length >= REPLAY_FILTER_THRESHOLD) flush();
    }
    step = gen.next();
  }
  flush();
  const cursor = step.value;

  if (cursor != null) {
    const [mtime, lines] = cursor.split(':');
    st.idx.run(unit.key, Number(mtime), Number(lines), cursor);
  }
  return cursor;
}
