# Obelisk -- Raw SQL Quick Reference

Read this before writing non-trivial `sql()` queries. It is a compact field and
join map for raw SQL, not the full helper API manual.

- Canonical executable DDL: [`packages/core/src/schema.sql`](https://github.com/tommy0103/obelisk/blob/main/packages/core/src/schema.sql) in the CLI source repository (not duplicated in this docs-only skill)
- Helper signatures and return shapes: `references/api-reference.md`
- Query recipes and synthesis patterns: `references/query-patterns.md`
- FTS, alias, ordering, and compactness traps: `references/pitfalls.md`

Database path: `~/.obelisk/obelisk.sqlite`. Older `~/.claude/obelisk.sqlite`
databases are copied forward on first open when the new database does not
exist.

## Source Model

Obelisk stores Claude Code, Codex, Kimi Code, and Pi transcripts in the same
schema.

- Claude rows use `source='claude'`.
- Codex rows use `source='codex'`; root session and message IDs are prefixed
  with `codex:`.
- Kimi Code rows use `source='kimi'`.
- Pi rows use `source='pi'`; session IDs are prefixed with `pi:`.
- Omit `source` filters unless provider provenance matters.
- Codex child threads are represented through `subagents`; Codex may not have
  Claude-style workflow rows.

## Scope Fields

Use the narrowest scope before text search.

| Field | Meaning | Raw SQL note |
| --- | --- | --- |
| `sessions.project` | Provider-normalized project slug | Use `LIKE ?` for fuzzy project filters |
| `sessions.project_path` | Absolute project path inferred from cwd | Use for exact local project identity |
| `messages.cwd` | Working directory at message time | Useful when a session spans directories |
| `sessions.source` / `messages.source` | Transcript provider | Use only when provider matters |
| `messages.is_meta` | Injected/control-plane transcript material | Ordinary evidence should filter it out |

For ordinary conversation evidence in raw SQL, add:

```sql
COALESCE(m.is_meta, 0) = 0
```

Do not add that filter when investigating injected context, command envelopes,
or transcript structure.

## Tables

### `sessions`

One row per root session.

| Column | Meaning |
| --- | --- |
| `id` | Session ID (`codex:<thread-id>` for Codex roots) |
| `title` | AI/session title |
| `project` | Provider-normalized project slug |
| `project_path` | Absolute project path when known |
| `started_at`, `ended_at` | ISO timestamps |
| `git_branch` | Branch at session time |
| `version` | Provider CLI/app version |
| `message_count` | Visible canonical messages; inactive and hidden records are excluded |
| `jsonl_path` | Source JSONL path |
| `source` | Provider ID: `claude`, `codex`, `kimi`, or `pi` |

### `messages`

Core evidence table.

| Column | Meaning |
| --- | --- |
| `uuid` | Message ID |
| `session_id` | FK to `sessions.id` |
| `type`, `role` | User/assistant role fields |
| `parent_uuid` | Conversation tree parent |
| `timestamp` | ISO timestamp |
| `text` | Extracted text, truncated to 10k chars |
| `content_type` | `text`, `thinking`, `tool_use`, `tool_result`, or `unknown` |
| `is_meta` | 1 for injected/control-plane messages |
| `visibility` | `visible` for current evidence, `inactive` for provider-attested superseded history, `hidden` for display-suppressed or transport-only material. Only Pi emits `inactive` |
| `model` | Assistant model name |
| `is_sidechain` | Retry/branch marker |
| `agent_id` | Subagent/workflow agent ID |
| `input_tokens`, `output_tokens` | Assistant token usage |
| `cwd` | Working directory at message time |
| `skill` | Skill that generated the response, if known |
| `turn_duration_ms` | Wall-clock duration for the turn |
| `source` | Provider ID: `claude`, `codex`, `kimi`, or `pi` |

`content_type='tool_use'` is only a marker. Tool-call details live in
`tool_calls`. `content_type='tool_result'` marks provider-emitted tool-result
messages; structured tool-result rows live in `tool_results`.

### `tool_calls`

One row per assistant tool invocation.

| Column | Meaning |
| --- | --- |
| `id` | Tool-use ID |
| `message_uuid` | Assistant message containing the call |
| `session_id` | Denormalized session ID |
| `name` | Tool name (`Read`, `Edit`, `Bash`, etc.) |
| `input_json` | JSON-serialized input, truncated to 10k chars |
| `file_path` | Extracted file path for file tools |

`tool_calls` does not have timestamps. Join through `messages`.

### `tool_results`

One row per tool result.

| Column | Meaning |
| --- | --- |
| `tool_use_id` | FK to `tool_calls.id` |
| `message_uuid` | User/tool-result message carrying the result |
| `session_id` | Denormalized session ID |
| `content` | Result text, truncated to 10k chars |
| `file_path` | Tool result file path metadata, if any |
| `is_error` | 1 when the provider marks the result as an error |

`tool_results` does not have timestamps. Join through `messages`.

### `summaries`

Session summary rows.

| Column | Meaning |
| --- | --- |
| `id` | Summary ID |
| `session_id` | FK to `sessions.id` |
| `timestamp` | Summary timestamp |
| `source` | Summary kind, such as `away_summary`; not provider source |
| `content` | Summary text |
| `visibility` | Same `visible` / `inactive` / `hidden` contract as messages |
| `input_tokens`, `output_tokens` | Model usage when summary generation was a separate provider call |

### `subagents`

Metadata for non-workflow subagent spawns.

| Column | Meaning |
| --- | --- |
| `agent_id` | Subagent ID |
| `session_id` | Parent session |
| `parent_tool_use_id` | Tool call that spawned the subagent |
| `agent_type` | Agent type label |
| `description` | Assigned task |
| `duration_ms` | Wall-clock duration |
| `total_tokens` | Sum of indexed agent tokens |

### `workflows`

Workflow execution records.

| Column | Meaning |
| --- | --- |
| `run_id` | Workflow run ID |
| `session_id` | Parent session |
| `task_id` | Task identifier |
| `script` | Workflow script content, truncated |
| `result_json` | JSON-serialized workflow result |
| `timestamp` | Execution timestamp |
| `agent_count` | Number of workflow agents |
| `duration_ms`, `total_tokens` | Aggregate run cost |
| `status` | Run status |
| `workflow_name` | Name from workflow metadata |

### `workflow_agents`

Individual agents inside a workflow run.

| Column | Meaning |
| --- | --- |
| `agent_id` | Workflow agent ID |
| `run_id` | FK to `workflows.run_id` |
| `session_id` | Parent session |
| `agent_type`, `description` | Agent task metadata |
| `phase`, `label` | Workflow positioning |
| `model`, `state` | Runtime state |
| `duration_ms`, `tokens`, `tool_calls` | Per-agent cost |

### `memories`

Human-approved markdown memory records. The markdown file at `path` is the
durable memory; `summary` is the compact retrieval surface.

| Column | Meaning |
| --- | --- |
| `id` | Memory ID |
| `session_id` | Source session, if known |
| `project` | Project slug for scoped recall |
| `message_start`, `message_end` | Source message UUID range |
| `path` | Normalized absolute markdown path |
| `anchors` | Optional JSON array of recall anchors |
| `summary` | English retrieval summary |
| `created_at` | Registration timestamp |
| `deleted_at` | Archive timestamp |
| `deleted_reason` | Archive reason |

Active memory means `deleted_at IS NULL`. Recall helpers omit archived rows.
When using raw SQL for memory recall, include `memories.deleted_at IS NULL`.

### `index_state`

Indexer progress and sentinel state.

| Column | Meaning |
| --- | --- |
| `jsonl_path` | Source path or synthetic sentinel key |
| `mtime` | Last indexed mtime |
| `lines_processed` | Incremental line cursor |
| `cursor` | Exact opaque provider cursor; legacy rows fall back to `mtime:lines_processed` |

Sentinel keys include `__last_build__`, `__app_heartbeat__`,
`__app_last_successful_build__`, `__indexer_owner_app__`, and
`__last_source_mtime__`.

### FTS Tables

| Table | Search surface | Use |
| --- | --- | --- |
| `messages_fts` | `messages.text` | Usually through `search()` |
| `memories_fts` | `memories.path`, `memories.summary` | Usually through `memories({ query })` |

Prefer helpers for FTS. Raw `MATCH` syntax is easy to get wrong; see
`references/pitfalls.md` before debugging FTS behavior.

## Key Relationships

```
sessions.id        <--  messages.session_id
sessions.id        <--  tool_calls.session_id
sessions.id        <--  tool_results.session_id
sessions.id        <--  subagents.session_id
sessions.id        <--  workflows.session_id
sessions.id        <--  memories.session_id
messages.uuid      <--  tool_calls.message_uuid
messages.uuid      <--  tool_results.message_uuid
messages.uuid      <--  memories.message_start / memories.message_end
messages.agent_id  -->  subagents.agent_id
messages.agent_id  -->  workflow_agents.agent_id
tool_calls.id      <--  tool_results.tool_use_id
workflows.run_id   <--  workflow_agents.run_id
```

## Safe SQL Joins

Tool calls with timestamps:

```sql
SELECT tc.id, tc.name, tc.file_path, m.timestamp, s.title
FROM tool_calls tc
JOIN messages m ON m.uuid = tc.message_uuid
JOIN sessions s ON s.id = tc.session_id
WHERE s.project LIKE ?
  AND COALESCE(m.visibility, 'visible') = 'visible'
ORDER BY m.timestamp DESC
LIMIT 20;
```

Tool failures with timestamps:

```sql
SELECT tr.tool_use_id, tc.name, m.timestamp, substr(tr.content, 1, 200) AS error
FROM tool_results tr
JOIN tool_calls tc ON tc.id = tr.tool_use_id
JOIN messages m ON m.uuid = tr.message_uuid
WHERE tr.is_error = 1
  AND COALESCE(m.visibility, 'visible') = 'visible'
ORDER BY m.timestamp DESC
LIMIT 20;
```

Ordinary message evidence:

```sql
SELECT m.uuid, m.role, m.timestamp, substr(m.text, 1, 220) AS snippet
FROM messages m
JOIN sessions s ON s.id = m.session_id
WHERE s.project LIKE ?
  AND COALESCE(m.is_meta, 0) = 0
  AND COALESCE(m.visibility, 'visible') = 'visible'
ORDER BY m.timestamp DESC
LIMIT 20;
```

Active memories:

```sql
SELECT id, path, anchors, summary, session_id, created_at
FROM memories
WHERE project LIKE ?
  AND deleted_at IS NULL
ORDER BY created_at DESC
LIMIT 20;
```

## Indexes

Common indexed filters:

- `messages(session_id)`
- `messages(agent_id)`
- `messages(session_id, timestamp)`
- `sessions(source)`
- `messages(source)`
- `tool_calls(session_id, name)`
- `tool_calls(file_path)`
- `subagents(session_id)`
- `workflows(session_id)`
- `workflow_agents(run_id)`
- `summaries(session_id)`
- `memories(project)`
- `memories(session_id)`
- `memories(created_at)`

## Raw SQL Pitfalls

- Start with helpers. Use raw `sql()` for exact joins, grouping, aggregation, or
  fields helpers do not expose.
- `sql()` accepts only read-only `SELECT`/`WITH`; use `--attune` for memory
  mutation.
- `tool_calls` and `tool_results` do not have timestamps. Join `messages`.
- For normal user/assistant evidence, filter `COALESCE(m.is_meta, 0) = 0`.
- `summaries.source` is a summary kind, not provider provenance. Provider
  source is on `sessions.source` and `messages.source`.
- `sessions.project` is a slug/fuzzy scope; `sessions.project_path` is the
  absolute path when known; `messages.cwd` is per-message working directory.
- Memory rows are archived with `deleted_at`; do not recall archived memories.
- Indexed text and JSON fields are truncated to 10k chars. Use `raw()` from
  `references/api-reference.md` when a specific message needs its source record.
- Prefer SQL-side `COUNT`, `GROUP BY`, `MAX`, `ORDER BY`, and `LIMIT` over
  returning large row sets and hand-counting in the final answer.
