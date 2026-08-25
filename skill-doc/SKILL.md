---
name: obelisk
description: >
  Search and query past Claude Code, Codex, Kimi Code, and Pi session history.
  Reactive: when the user asks "how did I fix X", "what did we do last time", "find the session where", "上次怎么修的", "之前的session", "历史记录".
  Proactive: when the user references past work you lack context for, when you're about to modify a file with complex edit history, when the user says "继续之前的" or "continue where we left off", or when understanding prior decisions would improve your current response.
  Memory: when the user says "记住这个", "remember this", "写入记忆", "save this conclusion", or when you determine a retrieval result contains a conclusion worth persisting.
allowed-tools:
  - Read
  - Bash(obelisk:*)
  - Write
---

# obelisk

Search and query local Claude Code, Codex, Kimi Code, and Pi session history.
Obelisk indexes sessions, messages, tool calls, tool results, summaries,
subagents, workflows, workflow agents, parent chains, and raw JSONL lines into
SQLite + FTS5.

Obelisk has four transcript sources. Treat all of them as ordinary sessions by
default: Claude rows use `source='claude'`, Codex rows use `source='codex'`,
Kimi Code rows use `source='kimi'`, and Pi rows use `source='pi'`. Use `source`
only when provenance matters or the user asks to scope to one provider.
Provider-specific records are projected into the same canonical tables; some
providers may not emit every kind of subagent or workflow metadata.

Obelisk is a CodeAct memory layer: write a small JS query, run it locally, read
the JSON, then answer. Do not turn history into a flat document or browse entire
sessions by default.

## Fresh Index and Sandbox Permissions

Treat a successful Obelisk invocation as a precondition for using its results.
Obelisk refreshes `~/.obelisk/obelisk.sqlite` before retrieval so the answer
includes the latest sessions and can identify the invoking session. Never
degrade to a stale, read-only index when that refresh cannot write.

In Codex `workspace-write` or managed sandboxes, `~/.obelisk` may be outside the
writable roots. If an Obelisk command fails with `SQLITE_READONLY`, `EACCES`,
`EPERM`, `attempt to write a readonly database`, or another permission error for
`~/.obelisk`, rerun the same command with
`sandbox_permissions: "require_escalated"`. On another agent host, use its
equivalent mechanism to grant write access to `~/.obelisk`. Do not replace the
failed command with direct SQLite, JSONL, or stale-index reads.

If write access is unavailable or the user denies escalation, stop and report
the permission blocker. Retrieval is complete only when the Obelisk command
exits successfully and returns its query result.

## Quick Start

Fast keyword search (pass a unique nonce so Obelisk can recognize your own
session in results):

```bash
obelisk --search "keyword" --nonce "$(uuidgen 2>/dev/null || echo "$$.$RANDOM.$RANDOM")"
```

Custom query:

1. Write a bounded JS query to a unique temp file — the as-typed file path is
   your invocation nonce:

   ```bash
   qdir=$(mktemp -d /tmp/obq.XXXXXX 2>/dev/null || { d="/tmp/obq.$$.$RANDOM"; mkdir "$d"; echo "$d"; })
   qfile="$qdir/query.mjs"
   ```

   The `.mjs` name lives inside the unique directory, so the `mktemp`
   template always ends on the `X` run (BSD `mktemp` requires that).

2. Run:

   ```bash
   obelisk --query "$qfile"
   ```

3. Parse JSON stdout and answer with concise evidence.

The query file runs inside `(async () => { ... })()`. Use `return` to emit JSON.
Query scripts are read-only: `remember()` and `forget()` are not available, and
`sql()` only accepts read-only SELECT/WITH queries.

## Your Own Session In Results

Obelisk refreshes the index before each query, so your own live session shows
up in results. The invocation nonce (`--search --nonce`, or the unique
`--query` file path) lets Obelisk mark it: session projections in `search()`
hits and `sessions()` rows carry `is_invoking: true`, and
`overview().current.session_id` holds the invoking session id when known. Treat
a session flagged `is_invoking` as your own current context, NOT as independent
historical evidence. Resolution is newest-wins over recent matches; only a
near-simultaneous same-nonce collision (or no match at all) leaves nothing
marked and `current.session_id` null — identity is honestly unknown.

## Default First Pass

Start with helpers, not raw SQL. For the first Obelisk query in a task, normally
call `overview({ limit: 6 })` unless the user already gave an exact
`session_id`, message `uuid`, or absolute file path.

For semantic or synthesis tasks, combine orientation, memory recall, and raw
session evidence before deciding whether a detail pass is needed:

```js
const map = overview({ limit: 6 });
const project = map.current.project?.project;
const topic = 'English topic terms translated from the user request';

return {
  orientation: map.current_project,
  prior_memories: memories({ project, query: topic, limit: 5 }),
  session_evidence: search(topic.replace(/[-_]/g, ' '), { project, limit: 8 }),
};
```

Use `sql()` only as an escalation path for exact joins, aggregations, or schema
questions that helpers cannot express cleanly. Do not use raw SQL as a generic
fallback for broad retrieval.

## Intent Routing

Obelisk supports a small intent prefix layer after `/obelisk`. This is for
output intent, not retrieval architecture.

| Intent | Description | Reference |
|---|---|---|
| `recap [target]` | Generate weekly/monthly recap card content for app handoff or share-style output. | `references/recap/overview.md` |

Routing rules:

1. If the first word is `recap`, read `references/recap/overview.md` before the
   first query. Everything after `recap` is the recap target.
   Common app-generated prompts include `/obelisk recap this week`,
   `/obelisk recap last week`, `/obelisk recap this month`, and
   `/obelisk recap last month`; interpret these as natural period targets
   relative to the current date and timezone.
2. `recap` does not create a separate retrieval layer. It still uses
   `overview()`, `memories()`, helpers, and `sql()` only when needed.
3. Follow the overview's card-by-card sequence. Each card has its own retrieval
   pattern and writing file; retrieve that card's evidence, read that card's
   writing file, update the JSON, then move to the next card. Do not preload all
   recap references before the current card is written.
4. If the first word is not `recap`, do not load
   `references/recap/overview.md`. Continue with Query Routing below. Do not
   infer recap from broad requests for weekly/monthly summaries, charts,
   rankings, shareable cards, or playlist-style metaphors.

## Reference Map

Use references by job, not by habit:

| Reference | Use when |
|---|---|
| `references/query-patterns.md` | Broad synthesis, progress summaries, design history, weekly/monthly reviews, approved memory write/archive/update scripts, or questions about what the user did/learned/decided/tried/abandoned. |
| `references/retrieval-semantics.md` | Multi-step retrieval, scoped project/file/session searches, or when scope/artifact/semantic boundaries affect query design. |
| `references/schema.md` | Raw SQL field and join quick reference before writing non-trivial `sql()`. |
| `references/api-reference.md` | Helper signatures, option names, return fields, or exact `remember()` / `forget()` parameter details are unclear. |
| `references/pitfalls.md` | Error recovery, FTS syntax, aliases, ordering, row-shape surprises, or compact/raw tradeoffs. |
| `references/recap/overview.md` | Explicit `/obelisk recap ...` requests only. |

## Query Routing

Before writing a query, classify the task. Progressive disclosure is useful, but
skipping the relevant reference usually costs extra query rounds.

- Read `references/query-patterns.md` before the first query for broad synthesis, progress summaries, design history, ordinary weekly/monthly reviews, or questions that ask what the user did, learned, decided, tried, or abandoned. Start from the first-pass or one-shot synthesis pattern, then run a faceted detail pass if needed.
- Read `references/retrieval-semantics.md` before multi-step retrieval, scoped project/file/session searches, or synthesis/conclusion/history questions. It defines the query design frame.
- Read `references/schema.md` before raw `sql()` unless the needed table/column relationship is already explicit here. It is intentionally short and SQL-focused. Do this before running the SQL, not after a missing-column error. Do not start with raw SQL for broad synthesis unless helpers cannot express the needed aggregation or join.
- Read `references/api-reference.md` when helper option names, return fields, scalar shorthand behavior, or `remember()`/`forget()` details are unclear.
- Read `references/pitfalls.md` after an error or when FTS syntax, aliases, ordering, row shapes, or compact/raw tradeoffs are unclear.

If a helper row shape is unclear, first run a tiny scoped query and return
`Object.keys(row)` or a compact sample. Do not invent field names.

For approved memory mutations, follow the Memory Layer section below first.
Use `references/query-patterns.md` for copyable `--attune` scripts
(`Attune Approved Memory`, `Forget Approved Memory`, `Update Approved Memory`),
and `references/api-reference.md` only for exact parameter semantics.

## Core API

### `search(text, opts?)`

Full-text search across main messages, subagent messages, and workflow-agent
messages.

Returns:

```js
[{ message: { uuid, text, content_type, is_meta, role, timestamp, model, cwd, visibility, source },
   session: { id, title, project, started_at, source, is_invoking? },
   rank,
   context }]
```

`session.is_invoking` is `true` only when the hit belongs to the session that
ran this query (see "Your Own Session In Results"); it is omitted otherwise.

`context` here means temporal neighbors: nearby messages in the same session by
timestamp. It is not the parent chain. Use `context(uuid)` or `trace(uuid)` for
causal/parent-chain context.

Use `message.content_type` to keep evidence boundaries intact:
`text` is user/assistant visible language, `thinking` is trace/debug material,
`tool_use` marks a tool-call message whose details live in `tool_calls`, and
`tool_result` marks a tool-result message whose details live in `tool_results`.
`unknown` is a conservative fallback. Do not treat `thinking` as a user-visible
assistant conclusion. Real user input is `type='user'` plus `content_type='text'`;
do not invent a separate `user_message` content type.

Use `message.is_meta` to separate transcript control-plane material from
conversation evidence. `is_meta=1` marks injected caveats, command envelopes, or
other messages that entered the transcript as user-role content but should not
be treated as the user's request by default. `search()` and `thread()` omit meta
messages unless `includeMeta: true` is passed; `context()` and `trace()` preserve
the current causal chain and expose `is_meta` on returned rows.

Pi can preserve a branch that was tried and later superseded as
`visibility='inactive'`. Only Pi populates it: other sources either do not
record supersession in their transcripts or discard it while indexing, so an
empty inactive result never means nothing was abandoned -- only that this
source cannot say. Default helpers return only `visible` evidence. Pass
`includeInactive: true` to `search()`, `context()`, `trace()`, `thread()`,
`summaries()`, `raw()`, `fileHistory()`, or `failures()` only when the abandoned
path matters. Every returned message or evidence row is labeled with
`visibility`; describe inactive evidence as something tried and then
superseded, never as the final decision. `hidden` is reserved for
display-suppressed or transport-only records and is never returned by these
helpers, even with the option enabled.

Opts:
`{ limit, sessionId, project, after, before, cwd, source, includeMeta, includeInactive }`.

`project` is a SQL `LIKE` filter over `sessions.project`, not an exact project
identity. Results are already ordered by FTS5 rank; lower rank sorts earlier.
Prefer returned order over manually interpreting numeric rank unless you are
deliberately using FTS5 semantics.

`source` can be `'claude'`, `'codex'`, `'kimi'`, `'pi'`, or omitted. Omitted
means search all indexed sources.

### `context(uuid, opts?)`

Returns the full story around one indexed message:

```js
{ message, parentChain, session, subagent, workflow }
```

Use this after `search()` finds a promising message. It is the usual way to
expand vertically from one evidence point without dumping the whole session.
The target and returned ancestors must be visible by default. Pass
`{ includeInactive: true }` to follow an explicitly superseded Pi path.

### `sql(query, ...params)`

Read-only SQL SELECT/WITH with `?` placeholders. Returns array rows. SQL is an
escape hatch for exact structured joins and aggregations after the helper-first
surface is insufficient; it is not the default retrieval entry point.

Before writing non-trivial SQL, read `references/schema.md`. It is the raw SQL
field/join quick reference. The executable DDL is CLI-owned and is deliberately
not duplicated in this docs-only skill. Common safe joins:

- `tool_calls` does not have timestamps. Join `messages m ON m.uuid = tc.message_uuid`.
- `tool_results` does not have timestamps. Join `messages m ON m.uuid = tr.message_uuid`.
- For project/session filters, join `sessions s ON s.id = <table>.session_id`.
- Prefer SQL-side `GROUP BY`, `COUNT`, `MAX`, `ORDER BY`, and `LIMIT` over hand-counting in the final answer.

Tables: `sessions`, `messages`, `tool_calls`, `tool_results`, `summaries`,
`memories`, `subagents`, `workflows`, `workflow_agents`, `messages_fts`.

## Structured Helpers

These helpers are convenience accessors over the same SQLite structure. They do
not replace `sql()`, but they are the default first-pass surface. Use `sql()`
when you need an exact aggregation or a join the helper does not expose.

All list helpers accept a bounded `limit`. Many also accept:
`{ project, after, before, sessionId, sessions, branch, source }`. Check
`references/api-reference.md` or a tiny sample before relying on less common
filters or return fields.

- `overview(opts?)` -- compact orientation map. Returns current cwd/project if knowable, the invoking session id (`current.session_id`) when the invocation nonce resolved, global project/source counts, and current-project recent sessions plus memory records. It is a map, not evidence.
- `sessions(opts?)` -- session rows, newest first. `project` is a SQL `LIKE` pattern. `message_count` counts the visible canonical transcript; inactive and hidden records are excluded. The invoking session row carries `is_invoking: true`.
- `recent(n?)` -- shorthand for recent sessions.
- `summaries(opts?)` -- summary rows, newest first: `{ id, session_id, timestamp, source, content, visibility, session_title, project }`; inactive rows require `includeInactive: true`, hidden rows are never returned, and `source` is the summary kind rather than the transcript provider.
- `subagents(opts?)` -- subagent metadata plus `messageCount`.
- `workflows(opts?)` -- workflow runs, newest first.
- `workflowTree(runId)` -- workflow row plus parsed `result` and `agents`; may include bulky `script` and `result_json`, so project compact fields.
- `fileHistory(filePath, opts?)` -- Read/Edit/Write tool calls for a file, oldest first; includes many `Read` rows and labels each result with `visibility`.
- `failures(opts?)` -- failed tool results with tool/session context and `visibility`, newest first.
- `trace(uuid, opts?)` -- parent chain from root to message.
- `thread(sessionId, opts?)` -- session messages ordered by timestamp, omitting meta messages by default. Pass `{ includeMeta: true }` for injected context or `{ includeInactive: true }` for superseded Pi history.
- `raw(uuid, opts?)` -- windowed source access for one visible message. Pi returns the selected source-message container whether it was stored directly or inside a retained tail. Inactive targets require `includeInactive: true`; hidden targets return `null`.
- `memories(opts?)` -- recall memory layer. opts: `{ query, project, sessionId, sessions, after, before, branch, limit }`. Without `query`, returns active memory records newest first. With `query`, searches `summary`/`path` through safe FTS5 tokenization and returns `rank`; lower rank sorts earlier. Records may include nullable JSON `anchors` for explicit recall surfaces such as files. Read the file at `path` for full content.

## Retrieval Contract

Keep queries scoped, bounded, and structural.

- Scope First: classify the locator as scope, artifact, or semantic. Use the narrowest structural locator before FTS; empty scoped results are valid unless the user asks to broaden.
- Orient First: for a new task, normally call `overview({ limit: 6 })` before deeper retrieval unless the user gave an exact session/message/file locator. It is a navigation map; confirm facts with `memories()`, `search()`, helpers, or, only when needed, `sql()`.
- Helper First: prefer `overview()`, `memories()`, `search()`, `sessions()`, `summaries()`, `fileHistory()`, and other helpers for first-pass retrieval. Escalate to raw `sql()` only when helpers cannot express the needed join, grouping, or exact schema-level check.
- Plan Before Probe: for conclusion, broad history, failure investigation, or file evolution, write a bounded retrieval script instead of spending turns on intermediate results.
- Structure Before Text: compute counts, joins, grouping, dedupe, and projection in SQL or JS; keep runtime JSON compact, ideally under 10k-12k chars for synthesis tasks.
- Evidence Before Conclusion: return compact evidence with stable IDs (`session_id`, `uuid`, `tool_call_id`, `run_id`, `agent_id`) and short snippets, then synthesize in the final answer.
- Exclude Meta By Default: `is_meta=1` rows are injected/control-plane transcript material. Helpers hide them by default; raw SQL for ordinary conversation evidence should include `COALESCE(m.is_meta,0)=0` unless meta rows are the investigation target.
- Exclude Superseded Paths By Default: ordinary evidence must use exact visible-only filtering. Opt into inactive Pi history only to explain an abandoned path, and label it as tried then superseded.
- Persist Durable Conclusions: after answering, if retrieval produced a durable conclusion that future sessions are likely to reuse and `memories()` does not already cover it, explicitly offer to write a memory. Keep the offer brief. Do not write the markdown file or run `--attune` until the user approves.

If field, context, ordering, FTS, or helper semantics affect the query, read
`references/retrieval-semantics.md` before coding. If a query errors, read
`references/pitfalls.md` before retrying.

## Memory Layer

Obelisk has a persistent memory layer alongside raw session data. Every
retrieval queries both layers: `memories()` for prior conclusions, `search()`
and helpers for raw session evidence. Use memory as prior notes, not final
authority. If a memory record influences your answer, say naturally that it was
previously recorded, and compare it with raw session evidence when correctness
depends on it. Raw session data is the evidence layer, but one hit is not a
complete truth; query and cite it compactly.

The memory layer is English-indexed. Use English terms in `memories({ query })`
even when the user asks in another language. Write every `remember().summary`
in English, regardless of the current conversation language. The runtime rejects
obvious CJK text in memory queries and summaries as a guardrail.

**Recall:** query `memories({ query: 'English topic terms', project: '...' })`
to find prior conclusions relevant to the current task. Translate non-English
user requests into concise English query terms before calling `memories()`.
Memory recall uses safe FTS5 tokenization over `summary` and `path`, so
hyphens/punctuation are tokenized instead of causing raw `MATCH` syntax errors.
Like other list helpers, passing a string is treated as `sessionId`, and passing
a number is treated as `limit`. Read the file at `path` for full content.
`memories()` returns active memories only. An archived memory is
management/audit data, not recall data.

Good memory candidates include design decisions, project conventions, abandoned
alternatives, repeated failure causes, workflow patterns, and conclusions
synthesized across multiple raw evidence points. Do not propose memory for
one-off lookups, uncertain findings, or conclusions already covered by existing
memories.

**Mutation approvals:** judging whether to use a memory in the current answer is
an agent decision and does not require approval. Persistent memory changes do.
If the user explicitly says a memory is wrong, outdated, should be forgotten, or
should now say something else, that request is the approval to archive or update
the exact matching memory. Do not ask for a second confirmation unless multiple
memories could match. If you notice a possible conflict yourself, explain it
briefly and ask before changing memory state.

**Writing memories:** after a retrieval produces a conclusion worth persisting,
propose writing a memory file. The user must approve. Flow:

1. Write a markdown file using the `Write` tool (user approves).
2. Register it via `remember()` in a narrow memory-registration script:

```js
return remember({
  path: '.obelisk/memories/design-decision-x.md',
  session_id: 'current-session-id',
  message_start: 'uuid-of-first-relevant-msg',
  message_end: 'uuid-of-last-relevant-msg',
  anchors: [{ kind: 'file', path: 'src/path/to/file.ts' }],
  summary: 'Detailed summary: what was decided, why, what alternatives were considered, and what constraints drove the choice.'
})
```

Run the registration script with:

```bash
obelisk --attune /tmp/register-memory.mjs
```

`--attune` exposes only memory mutation helpers: `remember()` and `forget()`.
It does not expose `search()`, `sql()`, `memories()`, or other retrieval
helpers. If you need source IDs or memory IDs, find them first with a normal
`--query` script.

`remember()` validates that `path` already exists and points to a file. Relative
paths are resolved against the source session's `project_path` when
`session_id` is provided, then stored as normalized absolute paths. Prefer
project-relative paths such as `.obelisk/memories/...` plus `session_id`.
Optional `anchors` must be an array of objects and is stored as nullable JSON
text. Use it only for explicit recall surfaces, such as files associated with
the memory.

`summary` must be English and detailed enough that `memories()` results alone
can judge relevance without reading the file. Include the decision, the
reasoning, and the key constraints — not just a title.

The `message_start`/`message_end` range marks where in the conversation this
conclusion was drawn. Use it later to trace back to the original evidence.

**Forgetting memories:** if the user says a memory is outdated, wrong, or should
be forgotten, use normal recall first to identify the exact memory ID. If there
is exactly one clear candidate, the user's request is approval to archive it. If
multiple memories could match, ask which one to forget. Then run an `--attune`
script:

```js
return forget({
  id: 'mem-id-to-delete',
  reason: 'Outdated by newer project guidance.',
});
```

`forget()` archives the memory record by setting `deleted_at` and
`deleted_reason`. It removes the record from active recall but does not delete
the markdown file. Memory records survive index rebuilds and are never changed
automatically.

**Updating memories:** updating memory is one user-approved operation:
archive the old memory with `forget()`, then write and register a replacement
markdown memory with `remember()`. If the user explicitly corrected the memory,
that correction is approval for the combined archive-plus-write flow. If you
discovered the mismatch yourself, ask first.

## Minimal Patterns

Search, then expand one promising hit:

```js
const hits = search('auth fix', { limit: 5 });
if (!hits.length) return [];
return hits.slice(0, 3).map(h => ({
  session_id: h.session.id,
  session_title: h.session.title,
  uuid: h.message.uuid,
  snippet: h.message.text?.slice(0, 240),
}));
```

Check helper fields before assuming names:

```js
const rows = summaries({ project: '%quiet-zero%', limit: 1 });
return rows.length ? Object.keys(rows[0]) : [];
```

Fetch message neighbors without a full thread:

```js
const hit = search('runtime query', { limit: 1 })[0];
return sql(
  `SELECT uuid, role, timestamp, substr(text,1,240) AS snippet
   FROM messages
   WHERE session_id=? AND timestamp>=?
     AND COALESCE(visibility, 'visible') = 'visible'
   ORDER BY timestamp LIMIT 6`,
  hit.session.id,
  hit.message.timestamp
);
```

See `references/query-patterns.md` for longer recipes.

## Notes

- First run builds the index. Later runs update incrementally.
- DB location: `~/.obelisk/obelisk.sqlite`; old `~/.claude/obelisk.sqlite` is copied forward if needed.
- Query scripts run in a sandboxed VM with no filesystem or network access from inside the script.
- Indexed text and stored tool inputs/results are truncated to 10k chars. Use `raw(uuid, { offset, limit })` for specific JSONL windows.
