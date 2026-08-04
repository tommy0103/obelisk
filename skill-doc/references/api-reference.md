# Obelisk -- Helper API Reference

Detailed reference for globals available inside `obelisk --query` and
`obelisk --attune` scripts.

- Use `references/schema.md` for raw SQL table/field/join checks.
- Use `references/query-patterns.md` for copyable retrieval plans.
- Use `references/retrieval-semantics.md` for query design and scope choices.
- Use `references/pitfalls.md` after runtime errors or confusing row shapes.

Query scripts run inside an async IIFE with a 30-second timeout. Use `return` to
emit JSON. `--query` scripts are read-only. `--attune` scripts expose only
memory mutation helpers.

## Query API Reference

### Read Helpers

These globals are available only in `obelisk --query` scripts:

```js
sql, search, context, trace, thread, raw,
overview, sessions, recent, summaries, memories,
subagents, workflows, workflowTree, fileHistory, failures
```

All list helpers accept bounded `limit` options. Many helpers also accept
`project`, `sessionId`, `sessions`, `after`, `before`, `branch`, and `source`
when the underlying table can express that scope. Passing a string to many list
helpers is treated as `sessionId`; passing a number is treated as `limit`.

### Mutation Helpers

These globals are available only in `obelisk --attune` scripts:

```js
remember, forget
```

`--attune` does not expose `search()`, `sql()`, `memories()`, or other read
helpers. If you need IDs, discover them first with a normal `--query` script.

---

## Core Helpers

#### `search(text, opts?)`

Full-text search across all indexed message text using FTS5.

| Param | Type | Description |
| --- | --- | --- |
| `text` | `string` | FTS5 query string |
| `opts.limit` | `number` | Max results, default 20 |
| `opts.sessionId` | `string` | Restrict to one session |
| `opts.project` | `string` | SQL `LIKE` pattern over `sessions.project` |
| `opts.after` | `string` | ISO lower bound on message timestamp |
| `opts.before` | `string` | ISO upper bound on message timestamp |
| `opts.cwd` | `string` | SQL `LIKE` filter over `messages.cwd` |
| `opts.source` | `string` | Provider ID such as `"claude"`, `"codex"`, `"kimi"`, or `"pi"` |
| `opts.includeMeta` | `boolean` | Include `is_meta=1` rows, default false |
| `opts.includeInactive` | `boolean` | Include provider-attested superseded rows, default false |

Returns:

```js
Array<{
  message: { uuid, text, content_type, is_meta, role, timestamp, model, cwd, visibility, source },
  session: { id, title, project, started_at, source },
  rank,
  context
}>
```

`context` is temporal neighbor context in the same session, not a parent chain.
Hits and neighbors carry `visibility`.
Use `context(uuid)` or `trace(uuid)` for causal/parent-chain expansion. Lower
FTS rank sorts earlier; prefer returned order unless deliberately inspecting
FTS ranking.

Valid FTS5 syntax in `text` is honored. Input that FTS5 would reject as
malformed (for example a hyphenated term like `foo-bar`) does not error: it
falls back to safe per-token quoting — the same tokenization `memories()` uses —
so ordinary text never crashes the query.

#### `context(uuid, opts?)`

Full indexed context around one message.

| Param | Type | Description |
| --- | --- | --- |
| `uuid` | `string` | Message UUID |
| `opts.includeInactive` | `boolean` | Include a superseded target and ancestors, default false |

Returns:

```js
{ message, parentChain, session, subagent, workflow } | null
```

`message` and every returned ancestor carry `visibility`. `parentChain`
contains ancestors, not temporal neighbors. If the message belongs
to a subagent or workflow agent, `subagent` or `workflow` is populated when the
metadata exists. Hidden targets always return `null`, and hidden ancestors are
always omitted.

#### `sql(query, ...params)`

Read-only SQL helper with positional `?` bindings.

| Param | Type | Description |
| --- | --- | --- |
| `query` | `string` | `SELECT` or `WITH` statement |
| `...params` | `any` | Bind values |

Returns `Array<object>`.

Write statements are rejected. Use `references/schema.md` before non-trivial SQL
joins, and use `--attune` with `remember()` / `forget()` for memory mutation.

---

## Orientation And Lists

#### `overview(opts?)`

Compact orientation map for choosing retrieval scope. It is not evidence: it
does not return snippets, full messages, or markdown memory contents.

Passing a string is treated as `project`. Passing a number is treated as
`limit`.

| Param | Type | Description |
| --- | --- | --- |
| `opts.project` | `string` | Project slug or SQL `LIKE` pattern to use as current scope |
| `opts.limit` | `number` | Max recent sessions in `current_project.sessions`, default 8 |
| `opts.projectLimit` | `number` | Max global project rows, default 20 |
| `opts.memoryLimit` | `number` | Max memories in `current_project.memories`, default 100 |

If `opts.project` is absent, `overview()` tries to identify the current project
from `process.cwd()` against `sessions.project_path`, then from exact
`messages.cwd` matches. It does not guess the current session.

Returns:

```js
{
  current: {
    cwd,
    project: {
      project,
      project_path,
      source: 'opts' | 'cwd_project_path' | 'cwd_messages',
      confidence: 'exact' | 'inferred' | 'unknown'
    } | null
  },
  current_project: {
    project,
    project_path,
    session_total,
    sessions: [
      { id, title, project, project_path, started_at, ended_at, git_branch, message_count, source }
    ],
    memory_total,
    memories: [
      { id, path, anchors, summary, session_id, project, created_at }
    ]
  } | null,
  projects: [
    {
      project,
      project_path,
      session_count,
      memory_count,
      last_session_at,
      last_memory_at,
      recent_branches
    }
  ],
  totals: {
    projects,
    sessions,
    memories,
    sources: [{ source: 'claude' | 'codex' | 'kimi' | 'pi', session_count, last_session_at }]
  }
}
```

Confirm facts with `memories()`, `search()`, other helpers, or `sql()`.

#### `sessions(opts?)`

Session rows ordered by `ended_at` descending. Passing a number is treated as
`limit`.

| Param | Type | Description |
| --- | --- | --- |
| `opts.project` | `string` | SQL `LIKE` pattern over `sessions.project` |
| `opts.after` | `string` | ISO lower bound on `started_at` |
| `opts.before` | `string` | ISO upper bound on `started_at` |
| `opts.limit` | `number` | Max rows, default 50 |
| `opts.branch` | `string` | Exact git branch |
| `opts.source` | `string` | Provider ID such as `"claude"`, `"codex"`, `"kimi"`, or `"pi"`; omit for all |
| `opts.sessionId` | `string` | Exact session ID |
| `opts.sessions` | `string[]` | Restrict to session IDs |

Returns `Array<session_row>`.
`message_count` describes the visible canonical transcript; inactive and hidden
records do not increase it.

#### `recent(n?)`

Shorthand for `sessions({ limit: n })`. Default `n` is 10.

Returns `Array<session_row>`.

#### `summaries(opts?)`

Session summary rows ordered by summary `timestamp` descending. Passing a string
is treated as `sessionId`; passing a number is treated as `limit`.

| Param | Type | Description |
| --- | --- | --- |
| `opts.sessionId` | `string` | Restrict to one session |
| `opts.sessions` | `string[]` | Restrict to session IDs |
| `opts.project` | `string` | SQL `LIKE` pattern over source session project |
| `opts.after` | `string` | ISO lower bound on summary timestamp |
| `opts.before` | `string` | ISO upper bound on summary timestamp |
| `opts.branch` | `string` | Exact source session branch |
| `opts.source` | `string` | Provider filter through joined session |
| `opts.limit` | `number` | Max rows, default 100 |
| `opts.includeInactive` | `boolean` | Include superseded summaries, default false |

Returns:

```js
Array<summary_row & { session_title, project }>
```

`summaries.source` is the summary kind, such as `away_summary`; it is not the
provider source. `input_tokens` and `output_tokens` contain normalized usage
when the provider performed a separate model call for that summary.
Rows carry `visibility`. Inactive summaries describe work that was tried and
then superseded. Hidden summaries are never returned.

#### `memories(opts?)`

Active registered markdown memory records. Passing a string is treated as
`sessionId`; passing a number is treated as `limit`.

| Param | Type | Description |
| --- | --- | --- |
| `opts.query` | `string` | English recall query over `summary` and `path` |
| `opts.project` | `string` | SQL `LIKE` pattern over `memories.project` |
| `opts.sessionId` | `string` | Restrict to one source session |
| `opts.sessions` | `string[]` | Restrict to source session IDs |
| `opts.after` | `string` | ISO lower bound on `created_at` |
| `opts.before` | `string` | ISO upper bound on `created_at` |
| `opts.branch` | `string` | Exact source session branch |
| `opts.source` | `string` | Provider filter through the source session |
| `opts.limit` | `number` | Max rows, default 50 |

Returns:

```js
Array<memory_row & { rank?: number }>
```

Archived memories are omitted. Without `query`, rows are newest first. With
`query`, rows are ordered by safe FTS rank first, then `created_at` descending.
Lower rank sorts earlier. Translate non-English requests into concise English
query terms before calling `memories()`. Read the markdown file at `path` for
full content.

---

## Structural Expansion Helpers

#### `trace(uuid, opts?)`

Walk the `parent_uuid` chain from a message to the conversation root.

Pass `{ includeInactive: true }` to follow a superseded path. Returns labeled
messages ordered root-first. A hidden target returns an empty array, and hidden
ancestors are omitted.

#### `thread(sessionId, opts?)`

Messages in a session ordered by timestamp.

| Param | Type | Description |
| --- | --- | --- |
| `sessionId` | `string` | Session ID |
| `opts.includeMeta` | `boolean` | Include injected/control-plane rows, default false |
| `opts.includeInactive` | `boolean` | Include superseded messages, default false |

Returns `Array<message>`. Use `thread()` as a last resort; prefer targeted
search/context or compact SQL projections.

#### `raw(uuid, opts?)`

Windowed access to the source record for one indexed message, normally its
original JSONL line. Use this when indexed text, tool inputs, or tool results
were truncated and you need the raw source. Pi returns the selected source
message object for both direct and retained-tail storage, so one physical
compaction line never exposes other retained messages.

| Param | Type | Description |
| --- | --- | --- |
| `uuid` | `string` | Message UUID |
| `opts.offset` | `number` | Character offset into the JSONL line, default 0 |
| `opts.limit` | `number` | Max characters, default 10000 |
| `opts.includeInactive` | `boolean` | Allow a superseded target, default false |

Returns:

```js
{ text, totalLength, offset, limit, hasMore, visibility } | null
```

`raw()` resolves main-session, subagent, workflow-agent, and Codex JSONL paths
from indexed metadata. Hidden targets always return `null`.

---

## Agent And Workflow Helpers

#### `subagents(opts?)`

Subagent metadata plus message counts. Passing a string is treated as
`sessionId`.

| Param | Type | Description |
| --- | --- | --- |
| `opts.sessionId` | `string` | Restrict to one session |
| `opts.project` | `string` | SQL `LIKE` pattern over source session project |
| `opts.source` | `string` | Provider filter |
| `opts.limit` | `number` | Max rows, default 100 |

Returns:

```js
Array<{ ...subagent_row, messageCount }>
```

#### `workflows(opts?)`

Workflow run rows ordered newest first. Passing a string is treated as
`sessionId`.

| Param | Type | Description |
| --- | --- | --- |
| `opts.sessionId` | `string` | Restrict to one session |
| `opts.project` | `string` | SQL `LIKE` pattern over source session project |
| `opts.after` | `string` | ISO lower bound on workflow timestamp |
| `opts.before` | `string` | ISO upper bound on workflow timestamp |
| `opts.source` | `string` | Provider filter |
| `opts.limit` | `number` | Max rows, default 100 |

Returns `Array<workflow_row>`.

#### `workflowTree(runId)`

Lightweight execution tree for one workflow run. It parses `result_json` and
adds per-agent message counts. It does not load agent messages.

Returns:

```js
{ ...workflow_row, result: object | null, agents: Array<{ ...workflow_agent_row, messageCount }> } | null
```

---

## Evidence Helpers

#### `fileHistory(filePath, opts?)`

Tool calls that touched one file, ordered oldest first. Includes `Read` rows as
well as `Edit`/`Write`.

| Param | Type | Description |
| --- | --- | --- |
| `filePath` | `string` | Absolute file path |
| `opts.after` | `string` | ISO lower bound |
| `opts.before` | `string` | ISO upper bound |
| `opts.source` | `string` | Provider filter |
| `opts.limit` | `number` | Max rows, default 200 |
| `opts.includeInactive` | `boolean` | Include superseded tool evidence, default false |

Returns:

```js
Array<{
  toolCall: { id, message_uuid, name, input_json },
  session: { id, title, project },
  timestamp,
  visibility
}>
```

Use raw SQL with `ORDER BY m.timestamp DESC` when you need newest-first file
history.

#### `failures(opts?)`

Failed tool results with tool/session context and the next three messages after
the failure. Passing a string is treated as `sessionId`.

| Param | Type | Description |
| --- | --- | --- |
| `opts.sessionId` | `string` | Restrict to one session |
| `opts.project` | `string` | SQL `LIKE` pattern over source session project |
| `opts.after` | `string` | ISO lower bound on result message timestamp |
| `opts.before` | `string` | ISO upper bound on result message timestamp |
| `opts.source` | `string` | Provider filter |
| `opts.limit` | `number` | Max rows, default 50 |
| `opts.includeInactive` | `boolean` | Include superseded failures and neighbors, default false |

Returns:

```js
Array<{ toolCall, result, session, nextMessages, visibility }>
```

Use SQL for precise counts and grouping; treat `failures()` as compact evidence,
not a counting primitive.

---

## Memory Mutation Helpers

#### `remember(record)`

Register a human-approved markdown memory file. Available only in
`obelisk --attune` scripts.

| Param | Type | Description |
| --- | --- | --- |
| `record.path` | `string` | Existing markdown file path |
| `record.summary` | `string` | Required English retrieval summary |
| `record.session_id` | `string` | Source session ID, if known |
| `record.message_start` | `string` | First relevant source message UUID |
| `record.message_end` | `string` | Last relevant source message UUID |
| `record.project` | `string` | Project slug override |
| `record.anchors` | `array` or JSON `string` | Optional recall anchors |

Relative paths resolve against the source session `project_path` when
`session_id` is provided, otherwise against the runtime cwd. `remember()`
validates that `path` exists and is a regular file, rejects obvious CJK text in
`summary`, stores the normalized absolute path, and accepts nullable `anchors`.

Returns:

```js
{ id, path, project, anchors, created_at }
```

#### `forget(record)`

Archive a human-approved memory record. Available only in
`obelisk --attune` scripts.

| Param | Type | Description |
| --- | --- | --- |
| `record.id` | `string` | Exact memory ID |
| `record.reason` | `string` | Required archive reason |

`forget()` sets `deleted_at` and `deleted_reason`. It does not delete the
markdown file at `path`. Active recall helpers omit archived rows.

Returns:

```js
{ id, deleted_at, deleted_reason } |
{ id, deleted_at, deleted_reason, already_deleted: true }
```

### Memory Mutation Approval

Agents may decide whether to use, ignore, or verify memory in a single answer
without approval. Approval is required only for persistent memory mutations.

When the user explicitly says a memory is wrong, outdated, should be forgotten,
or should say something else, that utterance is approval to mutate the exact
matching memory. If multiple memories could match, ask the user to choose.

Updating is not in-place: archive the old record with `forget()`, then write and
register a replacement markdown file with `remember()` under the same approval.
