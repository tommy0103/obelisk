-- Devin CLI sessions.db schema at refinery migration 20 (live_row_times).
-- Read from a real store's sqlite_master; contains no session data.

CREATE TABLE refinery_schema_history(
             version int4 PRIMARY KEY,
             name VARCHAR(255),
             applied_on VARCHAR(255),
             checksum VARCHAR(255));

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  working_directory TEXT NOT NULL,
  backend_type TEXT NOT NULL,
  model TEXT NOT NULL,
  agent_mode TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL, title TEXT, main_chain_id INTEGER, shell_last_seen_index INTEGER DEFAULT 0, cogs_json TEXT, workspace_dirs TEXT, hidden INTEGER NOT NULL DEFAULT 0, metadata TEXT);

CREATE INDEX idx_sessions_activity
  ON sessions(last_activity_at DESC);

CREATE TABLE prompt_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  session_id TEXT NOT NULL
, is_shell INTEGER NOT NULL DEFAULT 0);

CREATE INDEX idx_prompt_history_timestamp
  ON prompt_history(timestamp DESC);

CREATE INDEX idx_prompt_history_session
  ON prompt_history(session_id);

CREATE TABLE message_nodes (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  node_id INTEGER NOT NULL,           -- node_id within this session's forest
  parent_node_id INTEGER,             -- NULL for root nodes
  chat_message TEXT NOT NULL,
  created_at INTEGER NOT NULL, metadata TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  UNIQUE(session_id, node_id)
);

CREATE INDEX idx_message_nodes_session
  ON message_nodes(session_id);

CREATE TABLE rendered_commits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  sequence_number INTEGER NOT NULL,
  rendered_html TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  UNIQUE(session_id, sequence_number)
);

CREATE INDEX idx_rendered_commits_session
  ON rendered_commits(session_id, sequence_number);

CREATE TABLE app_state (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);

CREATE TABLE tool_call_state (
    session_id    TEXT    NOT NULL,
    tool_call_id  TEXT    NOT NULL,
    -- Serialised acp::ToolCall JSON (the initial ToolCall event).
    -- Nullable: may be absent for interrupted sessions where the tool result
    -- was saved but resolve_and_commit did not complete.
    tool_call_json     TEXT,
    -- Serialised acp::ToolCallUpdate JSON (the final completion update).
    tool_call_update_json TEXT, source_node_ids TEXT,
    PRIMARY KEY (session_id, tool_call_id),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX idx_sessions_hidden ON sessions(hidden);

CREATE TABLE subagent_heads (
    session_id    TEXT    NOT NULL,
    agent_id      TEXT    NOT NULL,
    chain_node_id INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    PRIMARY KEY (session_id, agent_id),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE VIRTUAL TABLE message_search USING fts5(
  content,
  content = '',
  contentless_delete = 1,
  tokenize = 'unicode61'
);

CREATE TRIGGER message_search_after_insert
AFTER INSERT ON message_nodes
WHEN CASE WHEN json_valid(new.chat_message) THEN
  (json_extract(new.chat_message, '$.role') = 'assistant'
   OR (json_extract(new.chat_message, '$.role') = 'user'
       AND json_extract(new.chat_message, '$.metadata.is_user_input') = 1))
  AND typeof(json_extract(new.chat_message, '$.content')) = 'text'
  AND json_extract(new.chat_message, '$.content') <> ''
ELSE 0 END
BEGIN
  INSERT INTO message_search (rowid, content)
  VALUES (new.row_id, json_extract(new.chat_message, '$.content'));
END;

CREATE TRIGGER message_search_after_delete
AFTER DELETE ON message_nodes
BEGIN
  DELETE FROM message_search WHERE rowid = old.row_id;
END;

CREATE TRIGGER message_search_after_update
AFTER UPDATE OF chat_message ON message_nodes
BEGIN
  DELETE FROM message_search WHERE rowid = old.row_id;
  INSERT INTO message_search (rowid, content)
  SELECT new.row_id, json_extract(new.chat_message, '$.content')
   WHERE CASE WHEN json_valid(new.chat_message) THEN
     (json_extract(new.chat_message, '$.role') = 'assistant'
      OR (json_extract(new.chat_message, '$.role') = 'user'
          AND json_extract(new.chat_message, '$.metadata.is_user_input') = 1))
     AND typeof(json_extract(new.chat_message, '$.content')) = 'text'
     AND json_extract(new.chat_message, '$.content') <> ''
   ELSE 0 END;
END;

CREATE TABLE live_row_times (
    session_id  TEXT NOT NULL,
    row_key     TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    PRIMARY KEY (session_id, row_key)
);

-- Applied migrations (applied_on and checksum omitted).
INSERT INTO refinery_schema_history (version, name) VALUES
  (1, 'initial_schema'),
  (2, 'add_thinking_column'),
  (3, 'add_prompt_history'),
  (4, 'add_metadata_column'),
  (5, 'message_forest'),
  (6, 'add_node_metadata'),
  (7, 'add_shell_context'),
  (8, 'add_session_cogs'),
  (9, 'add_rendered_commits'),
  (10, 'add_workspace_dirs'),
  (11, 'add_prompt_history_is_shell'),
  (12, 'add_app_state'),
  (13, 'rename_permission_mode_to_agent_mode'),
  (14, 'tool_call_state'),
  (15, 'add_hidden_column'),
  (16, 'add_session_json_metadata'),
  (17, 'subagent_heads'),
  (18, 'tool_call_state_source_nodes'),
  (19, 'add_message_search'),
  (20, 'live_row_times');
