-- Copyright (C) 2026 tommy0103 and contributors.
-- SPDX-License-Identifier: AGPL-3.0-only

-- Shared Obelisk Core schema.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, title TEXT, project TEXT, project_path TEXT,
  started_at TEXT, ended_at TEXT, git_branch TEXT, version TEXT,
  message_count INTEGER DEFAULT 0, jsonl_path TEXT, source TEXT DEFAULT 'claude');
CREATE TABLE IF NOT EXISTS messages (
  uuid TEXT PRIMARY KEY, session_id TEXT, type TEXT, parent_uuid TEXT,
  timestamp TEXT, role TEXT, text TEXT, content_type TEXT,
  is_meta INTEGER DEFAULT 0, visibility TEXT DEFAULT 'visible', model TEXT,
  is_sidechain INTEGER DEFAULT 0, agent_id TEXT,
  input_tokens INTEGER, output_tokens INTEGER,
  cwd TEXT, skill TEXT, turn_duration_ms INTEGER,
  source TEXT DEFAULT 'claude');
CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY, message_uuid TEXT, session_id TEXT,
  name TEXT, presentation TEXT DEFAULT 'default', input_json TEXT, file_path TEXT);
CREATE TABLE IF NOT EXISTS tool_results (
  tool_use_id TEXT PRIMARY KEY, message_uuid TEXT, session_id TEXT,
  content TEXT, file_path TEXT, is_error INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS subagents (
  agent_id TEXT PRIMARY KEY, session_id TEXT, parent_tool_use_id TEXT,
  agent_type TEXT, description TEXT, duration_ms INTEGER, total_tokens INTEGER);
CREATE TABLE IF NOT EXISTS workflows (
  run_id TEXT PRIMARY KEY, session_id TEXT, parent_tool_use_id TEXT, task_id TEXT,
  script TEXT, result_json TEXT, timestamp TEXT, agent_count INTEGER DEFAULT 0,
  duration_ms INTEGER, total_tokens INTEGER, status TEXT, workflow_name TEXT);
CREATE TABLE IF NOT EXISTS workflow_agents (
  agent_id TEXT PRIMARY KEY, run_id TEXT, session_id TEXT,
  agent_type TEXT, description TEXT,
  phase TEXT, label TEXT, model TEXT, state TEXT,
  duration_ms INTEGER, tokens INTEGER, tool_calls INTEGER);
CREATE TABLE IF NOT EXISTS index_state (
  jsonl_path TEXT PRIMARY KEY, mtime REAL, lines_processed INTEGER, cursor TEXT);
CREATE TABLE IF NOT EXISTS summaries (
  id TEXT PRIMARY KEY, session_id TEXT, timestamp TEXT,
  source TEXT, content TEXT, visibility TEXT DEFAULT 'visible',
  input_tokens INTEGER, output_tokens INTEGER);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  uuid UNINDEXED, session_id UNINDEXED, text, content=messages, content_rowid=rowid);
CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, uuid, session_id, text)
  VALUES (new.rowid, new.uuid, new.session_id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, uuid, session_id, text)
  VALUES ('delete', old.rowid, old.uuid, old.session_id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, uuid, session_id, text)
  VALUES ('delete', old.rowid, old.uuid, old.session_id, old.text);
  INSERT INTO messages_fts(rowid, uuid, session_id, text)
  VALUES (new.rowid, new.uuid, new.session_id, new.text);
END;
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(agent_id);
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(session_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_main_timeline
  ON messages(session_id, timestamp, uuid)
  WHERE agent_id IS NULL AND COALESCE(visibility, 'visible') = 'visible';
CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source);
CREATE INDEX IF NOT EXISTS idx_messages_source ON messages(source);
CREATE INDEX IF NOT EXISTS idx_messages_usage_day
  ON messages(timestamp, COALESCE(source, 'claude'), input_tokens, output_tokens)
  WHERE input_tokens IS NOT NULL OR output_tokens IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_turn_duration
  ON messages(turn_duration_ms DESC, COALESCE(source, 'claude'))
  WHERE turn_duration_ms IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tc_session_name ON tool_calls(session_id, name);
CREATE INDEX IF NOT EXISTS idx_tc_message ON tool_calls(message_uuid);
CREATE INDEX IF NOT EXISTS idx_tc_file ON tool_calls(file_path);
CREATE INDEX IF NOT EXISTS idx_tr_session ON tool_results(session_id);
CREATE INDEX IF NOT EXISTS idx_tr_message ON tool_results(message_uuid);
CREATE INDEX IF NOT EXISTS idx_sa_session ON subagents(session_id);
CREATE INDEX IF NOT EXISTS idx_wf_session ON workflows(session_id);
CREATE INDEX IF NOT EXISTS idx_wa_run ON workflow_agents(run_id);
CREATE INDEX IF NOT EXISTS idx_summaries_session ON summaries(session_id);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, session_id TEXT, project TEXT,
  message_start TEXT, message_end TEXT,
  path TEXT, anchors TEXT, summary TEXT, created_at TEXT,
  deleted_at TEXT, deleted_reason TEXT);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  id UNINDEXED, path, summary,
  content=memories, content_rowid=rowid,
  tokenize='unicode61 remove_diacritics 1');
CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, id, path, summary)
  VALUES (new.rowid, new.id, new.path, new.summary);
END;
CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, id, path, summary)
  VALUES ('delete', old.rowid, old.id, old.path, old.summary);
END;
CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, id, path, summary)
  VALUES ('delete', old.rowid, old.id, old.path, old.summary);
  INSERT INTO memories_fts(rowid, id, path, summary)
  VALUES (new.rowid, new.id, new.path, new.summary);
END;
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
