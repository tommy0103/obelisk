-- Hermes state schema used by existing adapter fixtures.
-- Column names, types, defaults and order are captured from the source store.
CREATE TABLE schema_version (version INTEGER NOT NULL);
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, user_id TEXT, model TEXT, model_config TEXT,
    system_prompt TEXT, parent_session_id TEXT, started_at REAL NOT NULL, ended_at REAL,
    end_reason TEXT, message_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0,
    input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0,
    cache_write_tokens INTEGER DEFAULT 0, reasoning_tokens INTEGER DEFAULT 0, billing_provider TEXT,
    billing_base_url TEXT, billing_mode TEXT, estimated_cost_usd REAL, actual_cost_usd REAL,
    cost_status TEXT, cost_source TEXT, pricing_version TEXT, title TEXT, api_call_count INTEGER DEFAULT 0,
    handoff_state TEXT, handoff_platform TEXT, handoff_error TEXT, cwd TEXT,
    rewind_count INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, session_key TEXT,
    chat_id TEXT, chat_type TEXT, thread_id TEXT, git_branch TEXT, git_repo_root TEXT,
    compression_failure_cooldown_until REAL, compression_failure_error TEXT, display_name TEXT,
    origin_json TEXT, expiry_finalized INTEGER DEFAULT 0, compression_fallback_streak INTEGER NOT NULL DEFAULT 0,
    profile_name TEXT, system_prompt_hash TEXT, title_source TEXT, last_activity_at REAL,
    last_activity_description TEXT, last_activity_provenance TEXT,
    compression_ineffective_count INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
    last_read_at REAL, git_metadata_generation INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0,
    compression_recovery_deadline REAL, tool_names TEXT, created_source TEXT,
    compression_overload_streak INTEGER NOT NULL DEFAULT 0, auto_archived INTEGER NOT NULL DEFAULT 0,
    runtime_revision INTEGER NOT NULL DEFAULT 0, runtime_generation INTEGER NOT NULL DEFAULT 0,
    transcript_revision INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (parent_session_id) REFERENCES sessions(id)
  );
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL, content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT,
    timestamp REAL NOT NULL, token_count INTEGER, finish_reason TEXT, reasoning TEXT,
    reasoning_content TEXT, reasoning_details TEXT, codex_reasoning_items TEXT, codex_message_items TEXT,
    platform_message_id TEXT, observed INTEGER DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
    compacted INTEGER NOT NULL DEFAULT 0, effect_disposition TEXT, api_content TEXT, display_kind TEXT,
    display_metadata TEXT, _compressed_summary INTEGER NOT NULL DEFAULT 0,
    display_identity BLOB, display_order INTEGER,
    message_uid TEXT, absorbed_message_uids TEXT, tool_call_uids TEXT, tool_call_uid TEXT
  );
