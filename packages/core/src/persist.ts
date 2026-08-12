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
// upsert via ON CONFLICT; sessions merge with any existing row (started_at MIN,
// ended_at MAX, message_count reset-or-accumulate, fill-if-null for the rest);
// turn-duration is a targeted UPDATE; delete-session cascades. The generator's
// return value is the new cursor, persisted verbatim into index_state.

import type { Cursor, TranscriptRecord, IndexUnit } from './providers/types.ts';
import type { SqliteDb } from './sqlite-types.ts';

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
        cwd=excluded.cwd, skill=excluded.skill, source=excluded.source`),
    tc: db.prepare('INSERT OR REPLACE INTO tool_calls (id,message_uuid,session_id,name,presentation,input_json,file_path) VALUES (?,?,?,?,?,?,?)'),
    tr: db.prepare('INSERT OR REPLACE INTO tool_results (tool_use_id,message_uuid,session_id,content,file_path,is_error) VALUES (?,?,?,?,?,?)'),
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
    turn: db.prepare('UPDATE messages SET turn_duration_ms=? WHERE uuid=?'),
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

  const write = (r: TranscriptRecord) => {
    switch (r.kind) {
      case 'message':
        st.msg.run(r.uuid, r.session_id, r.type, r.parent_uuid, r.timestamp, r.role, r.text, r.content_type, r.is_meta, r.visibility, r.model, r.is_sidechain, r.agent_id, r.input_tokens, r.output_tokens, r.cwd, r.skill, r.source);
        break;
      case 'tool_call':
        st.tc.run(r.id, r.message_uuid, r.session_id, r.name, r.presentation, r.input_json, r.file_path);
        break;
      case 'tool_result':
        st.tr.run(r.tool_use_id, r.message_uuid, r.session_id, r.content, r.file_path, r.is_error);
        break;
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
      case 'message-turn-duration':
        st.turn.run(r.turn_duration_ms, r.uuid);
        break;
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

  let step = gen.next();
  while (!step.done) { write(step.value); step = gen.next(); }
  const cursor = step.value;

  if (cursor != null) {
    const [mtime, lines] = cursor.split(':');
    st.idx.run(unit.key, Number(mtime), Number(lines), cursor);
  }
  return cursor;
}
