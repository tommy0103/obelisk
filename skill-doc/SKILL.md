---
name: obelisk
description: >
  Search and query past Claude Code, Codex, Kimi Code, Kiro, OMP, and Pi session history.
  Reactive: when the user asks "how did I fix X", "what did we do last time", "find the session where", "上次怎么修的", "之前的session", "历史记录".
  Proactive: when the user references past work you lack context for, when you're about to modify a file with complex edit history, when the user says "继续之前的" or "continue where we left off", or when understanding prior decisions would improve your current response.
  Memory: when the user says "记住这个", "remember this", "写入记忆", "save this conclusion", or when you determine a retrieval result contains a conclusion worth persisting.
allowed-tools:
  - Read
  - Bash(obelisk:*)
  - Write
---

# obelisk

Retrieve local coding-agent history through the installed `obelisk` CLI.
Write a bounded JS query, read its JSON result, then answer from evidence.

## Retrieval workflow

1. Choose the narrowest project, file, session, time range, or topic scope.
   Read the matching reference below before writing the query.
2. Normally start a new task with `overview({ limit: 6 })`; skip orientation
   for an exact session ID, message UUID, or absolute file path. Overview is
   a navigation map, not evidence.
3. Recall prior conclusions with `memories()` and verify against session
   evidence with `search()` or scoped helpers. Use English memory query terms.
   Expand selected hits with `messages()` rather than loading entire sessions.
4. Group, deduplicate, and project inside the query. Return stable IDs and short
   snippets; keep synthesis JSON around 10k–12k characters when possible.
5. Answer with concise evidence. Identify prior memories naturally when they
   influence the answer. Offer to save a durable, new conclusion; wait for
   approval before writing the memory file or changing memory records.

Treat `is_invoking: true` as your current session, not independent historical
evidence. Ordinary conversation evidence uses visible, non-meta text;
thinking and tool output have different evidentiary roles. Read retrieval
semantics before querying those surfaces or superseded branches.

## Run a query

Use a unique temporary directory so the query path cannot collide:

```bash
qdir=$(mktemp -d /tmp/obq.XXXXXX 2>/dev/null || { d="/tmp/obq.$$.$RANDOM"; mkdir "$d"; echo "$d"; })
qfile="$qdir/query.mjs"
cat > "$qfile" <<'JS'
const hits = search('auth fix', { limit: 5 });
return hits.map(h => ({
  session_id: h.session.id, uuid: h.message.uuid,
  content_type: h.message.content_type,
  snippet: h.message.text?.slice(0, 240),
}));
JS
obelisk --query "$qfile"
```

The CLI runs the file in an async wrapper; `return` emits JSON. Queries are
read-only, with no filesystem or network access inside the script. For broad
history, adapt the first-pass recipe in query patterns instead of this tiny
keyword example.

For a quick keyword lookup:

```bash
obelisk --search "keyword" --nonce "obq-<unique-token-you-invent>"
```

Type a unique literal nonce: shell substitutions cannot identify the invocation in the transcript.
Query-file identity resolves through its recorded path or script content.

## Fresh index and permissions

A successful CLI invocation is required: it refreshes `~/.obelisk/obelisk.sqlite`
before retrieval. Never degrade to a stale, read-only index when refresh fails.

If the command fails with a write-permission error for `~/.obelisk` (such as
`SQLITE_READONLY`, `EACCES`, or `EPERM`), rerun the same command with
`sandbox_permissions: "require_escalated"`, or the host's equivalent write
permission mechanism. If access is unavailable or denied, stop and report the
blocker. Direct SQLite or JSONL reads do not substitute for a successful refresh.

## Choose helpers

The default retrieval surface is:

| Helper | Purpose |
|---|---|
| `overview` | Orient to projects and recent entry points. |
| `sessions` | Locate sessions under structural filters. |
| `search` | Find message evidence by topic. |
| `messages` | Read one message, a bounded window, or a session interval (CLI 0.3.0+). |
| `memories` | Recall previously saved conclusions. |
| `summaries` | Read recorded session summaries. |
| `sql` | Express joins or aggregations the other helpers cannot. |

Specialized and legacy helpers remain callable; read their API contracts when
needed. Check uncertain option names and row fields before relying on them.

## Load references by task

Load only the references needed for the current task. Each reference owns its
contracts or recipes; do not preload the whole directory.

| Before doing this | Read |
|---|---|
| Broad synthesis, design history, progress summaries, ordinary weekly/monthly reviews, or what the user did, learned, decided, tried, or abandoned | [Query patterns](references/query-patterns.md) and [retrieval semantics](references/retrieval-semantics.md). |
| Scoped project/file/session searches, multi-step retrieval, correlation, or evidence classification | [Retrieval semantics](references/retrieval-semantics.md). |
| Choosing helper options, fields, paging, or specialized/legacy helpers | [API reference](references/api-reference.md); for message expansion, the [messages contract](references/api-reference.md#messagesoptsoruuid). |
| Writing raw SQL | [Schema](references/schema.md) before execution. |
| Saving, archiving, or updating memory | [Memory workflow](references/memory-workflow.md) before writing files or running a mutation. |
| Workflow-specific retrieval | [Advanced helpers](references/advanced-helpers.md). |
| Recovering from an error or resolving FTS, ordering, row-shape, or raw-record surprises | [Pitfalls](references/pitfalls.md). |
| Explicit `/obelisk recap ...` | [Recap overview](references/recap/overview.md) before the first query, then follow its card-by-card disclosure. |

Route to recap only when the first word after `/obelisk` is `recap`; ordinary
weekly/monthly summaries do not select that workflow.

Approved memory changes run locally through a separate mutation entry point:
`obelisk --attune /tmp/register-memory.mjs`. Retrieve the necessary IDs first
with `--query`; `--attune` exposes only `remember()` and `forget()`.
