# Obelisk Retrieval Semantics

Read this before designing a non-trivial query. This is the query design frame;
`pitfalls.md` is only the debug checklist.

## Four Principles

### Scope First

Classify the user's request before choosing tools.

| User signal | Locator mode | Start with | Avoid first |
|-------------|--------------|------------|-------------|
| unclear project/session landscape | orientation | `overview()` | treating overview rows as evidence |
| project name/path, session, cwd, file, time range | scope | `sessions()`, exact SQL on `project_path`, `sessionId`, `fileHistory()` | broad FTS |
| workflow, subagent, tool call, summary, edit | artifact | `workflows()`, `subagents()`, `summaries()`, `tool_calls`, `tool_results` | all-session search |
| concept, conclusion, design history, vague memory | semantic | `memories({ query })`, `search()`, summaries, bounded facet sweep | session dumps |

`overview()` is a navigation map: current cwd/project if knowable, global
project counts, and recent current-project session/memory entry points. Use it
when scope is unclear, then query the memory or raw session layer for evidence.
It does not guess the current session.

For a new task, the first pass normally starts with `overview({ limit: 6 })`
unless the user gave an exact session ID, message UUID, or absolute file path.
Broad synthesis and progress-summary tasks should start from
`references/query-patterns.md`, not raw SQL.

One-shot retrieval is not all-shot retrieval. A query script may perform
multiple steps, but the first locator should be the narrowest semantic fit. If a
scope locator finds the relevant project/session/file, do not also run broad FTS
unless scoped evidence is insufficient and `query_plan` says why.

Project-like fields are distinct:

- `sessions.project`: provider-normalized project slug.
- `memories.project`: stored project slug copied onto registered memory records.
- `sessions.project_path`: absolute session path derived from message `cwd` when available; slug decoding is only a fallback.
- `messages.cwd`: working directory at message time.
- `sessions.source` / `messages.source`: transcript provider: `claude`, `codex`, `kimi`, or `pi`.
- helper `project`: SQL `LIKE` over `sessions.project`, not exact membership.
- helper `source`: optional provider filter. Omit it unless provenance matters.

For exact project membership, prefer helper filters or a scoped first pass when
they are expressive enough; use `sql()` with `s.project = ?` or
`s.project_path = ?` when you need exact membership across a join or
aggregation. Empty or tiny scoped results are valid results; do not broaden
unless the user asks or your `query_plan` explicitly marks a fallback.

### Plan Before Probe

For conclusion, broad history, failure investigation, or file evolution tasks,
prefer a retrieval script over interactive probing.

Good shape:

1. locate candidates with scope/artifact/semantic locators;
2. expand only selected hits;
3. dedupe and group in the script;
4. return compact evidence rows plus counts and limits.

If a second detail pass is needed, derive filters or facets from the first pass:
candidate sessions, discovered vocabulary, files, tools, timestamps, or
decisions. Prefer a learned faceted detail pass over `LIMIT 25` session windows.
If vocabulary is still unclear, use a small filtered window and say so in
`query_plan`.

### Structure Before Text

Use the database shape before asking the model to read text. This means
structured helpers and compact JS shaping first; raw SQL only when it expresses
the needed join, grouping, or exact schema-level check better than helpers.

- Count and aggregate in SQL or JS (`GROUP BY`, `COUNT`, `MAX`, `ORDER BY`, `LIMIT`).
- Join metadata from the owner table instead of inventing fields.
- Project compact rows; do not return whole sessions, complete workflow trees, full raw messages, or entire tool results.
- Keep synthesis runtime JSON around 10k-12k chars when possible.
- For recent failures, aggregate by session/task and return sparse examples.
- For file evolution, filter `fileHistory()` to `Edit`/`Write`, group by session or phase, and return short deltas.

Ordering and context are semantic:

- `sessions()`, `summaries()`, `workflows()`, and `failures()` are newest first.
- `memories()` without `query` is newest first; `memories({ query })` is FTS-ranked over memory `summary`/`path`, with lower rank sorting earlier.
- `fileHistory()` is oldest first.
- `search().context` is temporal neighbors in one session, not causal context.
- `context(uuid)` and `trace(uuid)` are for parent-chain/causal expansion.
  They return only current evidence by default. Use `includeInactive: true` for
  a Pi path that was tried and then superseded; hidden records remain
  unavailable.

### Evidence Before Conclusion

Obelisk's raw session layer stores original structure, not precompiled claims:
sessions, messages, summaries, tool calls/results, files, subagents, workflows,
parent chains, and raw JSONL windows. The memory layer can store
human-approved markdown conclusions, but treat them as prior notes to compare
against raw evidence when correctness matters.

For semantic questions, build a task-local evidence view:

```js
{
  query_plan: { mode, scope, facets, limits },
  prior_memories: [
    { id, path, anchors, session_id, created_at, summary }
  ],
  evidence: [
    { type, id, session_id, timestamp, content_type, is_meta, facet, snippet }
  ],
  omitted: 0
}
```

For message evidence, preserve `content_type` when projecting snippets.
`text` can support user-visible claims; `thinking` is only trace/debug context;
`tool_use` means follow `tool_calls` for structured details; `tool_result`
means follow `tool_results` for structured output. Mixed or unfamiliar message
surfaces remain `unknown`.

Preserve `is_meta` separately from `content_type`. Default message evidence
should exclude `is_meta=1` rows because they are transcript control-plane
content, not ordinary user intent or assistant conclusions. Include them only
when investigating injected caveats, command envelopes, or transcript structure.
When writing raw SQL for ordinary conversation evidence, add
`COALESCE(m.is_meta,0)=0` to message filters unless meta rows are the subject of
the investigation.

Memory recall is English-indexed: translate non-English user requests into
concise English query terms before calling `memories({ query })`. Memory
summaries registered with `remember()` are also English, regardless of the
conversation language.
`memories({ query })` uses safe FTS5 tokenization over memory `summary` and
`path`, so hyphens and punctuation do not need raw `MATCH` escaping.
`memories()` returns active memories only. For raw SQL memory recall, include
`deleted_at IS NULL`; archived memory records are management/audit data.

The agent may decide whether to use, ignore, or verify a recalled memory for the
current answer without user approval because no persistent state changes. If a
user explicitly says a memory is wrong, outdated, should be forgotten, or should
be replaced, that request is approval to mutate the exact matching memory. If
the agent discovers the conflict without an explicit user request, it should
answer from current evidence and ask before archiving or replacing the memory.

Then synthesize the conclusion in the final answer. Do not pretend the raw
evidence view is itself a stored Obelisk entity.

After synthesis, check whether the conclusion should become a memory. Offer to
write one when the result is durable, likely to help future sessions, and not
already covered by `prior_memories`. Good candidates include design decisions,
project conventions, abandoned alternatives, repeated failure causes, workflow
patterns, and conclusions synthesized across multiple raw evidence points. Do
not propose memory for one-off lookups, uncertain findings, or duplicate
coverage. The offer is only a proposal: write the markdown file and run
`--attune` only after user approval.

Memory updates are archive-plus-write, not in-place edits: run `forget()` on the
old record and `remember()` the replacement markdown file under the same user
approval.

## Text Search Semantics

`search(text)` passes text to SQLite FTS5 `MATCH`.

- Hyphens tokenize: for `workflow-script`, use `"workflow script"` or SQL `LIKE` for literal punctuation.
- Special characters may produce FTS syntax errors; simplify or quote the FTS query under the same scope.
- Exact phrase, token search, and literal punctuation are different semantics.
- Results are ordered by `ORDER BY rank`; lower rank sorts earlier. Prefer returned order over "closer to zero" comparisons.
