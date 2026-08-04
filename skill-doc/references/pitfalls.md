# Obelisk Pitfalls

Use this after a query error, suspicious empty result, over-large output, or
unclear helper row shape. For query design, read `retrieval-semantics.md` first.

## Missing Columns And Wrong Aliases

Common wrong guesses:

- Summaries: use `source` and `content`; do not use `summary_type` or `text`.
- Tool call name: use `tool_calls.name`. `tool_name` is only an alias in `SELECT tc.name AS tool_name`; `tc.tool_name` is not a column.
- Tool call timestamps: `tool_calls` has no timestamp. Join `messages m ON m.uuid = tc.message_uuid`.
- Tool result timestamps: `tool_results` has no timestamp. Join `messages m ON m.uuid = tr.message_uuid`.
- Workflow agent message counts: `workflowTree()` returns `messageCount` for agents.

When uncertain, inspect a tiny sample instead of guessing:

```js
const rows = summaries({ limit: 1 });
return rows.length ? Object.keys(rows[0]) : [];
```

## FTS5 Syntax Errors

`search(text)` uses raw FTS5 `MATCH`. Hyphenated terms and punctuation can be
parsed as syntax.

```js
// tokenized phrase for FTS
search('"workflow script"', { limit: 10 })
```

For literal punctuation, use SQL `LIKE` under the same scope:

```js
sql(`
  SELECT m.uuid, s.id AS session_id, s.title, substr(m.text,1,180) AS snippet
  FROM messages m
  JOIN sessions s ON s.id = m.session_id
  WHERE s.project LIKE ?
    AND m.text LIKE ?
    AND COALESCE(m.visibility, 'visible') = 'visible'
  ORDER BY m.timestamp DESC
  LIMIT 10
`, '%quiet-zero%', '%workflow-script%')
```

## Over-Large Runtime JSON

If runtime stdout is large, fix the query instead of reading it in chunks.

- Lower `LIMIT`.
- Shorten snippets to 160-240 chars.
- Group in SQL/JS and return counts plus sparse examples.
- For `fileHistory()`, filter to `Edit`/`Write` before projecting evidence.
- For `workflowTree()`, omit `script`, `result_json`, and full agent messages unless explicitly requested.
- Use `raw(uuid, { offset, limit })` only after identifying one specific message UUID.

## Empty Results

An empty array can be the correct answer for exact scopes or sentinels.

When the user asks for a scoped project/file/session or exact term:

1. run the scoped query;
2. return `[]` or compact counts;
3. say no matching prior result was found;
4. do not call `recent()`, all-project `summaries()`, or `thread()` as fallback unless the user asks.

## Counting From Snippets

If the user asks "how many", "counts", "top N", or "group by", compute it in
SQL or in the query script. Do not infer counts from visible snippets.

```js
sql(`
  SELECT tc.name AS tool_name, COUNT(*) AS n
  FROM tool_results tr
  JOIN tool_calls tc ON tc.id = tr.tool_use_id
  WHERE tr.is_error = 1
  GROUP BY tc.name
  ORDER BY n DESC
  LIMIT 10
`)
```
