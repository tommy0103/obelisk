# Hermes fixtures

`real-store-rows.json` holds rows captured from a real Hermes Agent store
(`~/.hermes/state.db`, schema version 30) on 2026-09-23, opened read-only. The
capture is a sample, not a transcript: 13 sessions and 32 messages (7 user, 16
assistant, 9 tool), picked for the shapes the adapter has to cope with rather than
for their content. A row can cover more than one shape, so these counts overlap:

- 11 rows carry `tool_calls` JSON — 2 of those call ids are reused across 2
  sessions — and 9 carry the `tool_call_id` their results pair on;
- 5 rows carry more than one call; 2 of those rows carry text *and* two calls whose
  names are not in ascending order — `20260602_184207_9d4321`/502
  (`browser_snapshot`, `browser_console`, both with their results) and
  `20260914_160026_63b914`/11486 (`terminal`, `execute_code`): a message's calls
  are stored in source order, so a reader that takes them in any other order (the
  `(session_id, name)` index, say) diverges from what the provider emits
  (ADR-0007);
- 11 rows carry `reasoning_content`;
- 9 rows are `active = 0` (2 of them with `compacted = 0`, the rewind shape) and 7
  are `compacted = 1`;
- both `display_kind` values appear: 2 `hidden` and 2 `async_delegation_complete`;
- 4 rows carry the private `_compressed_summary` flag — 2 standalone handoffs and 2
  merged carriers that keep a preserved turn;
- 1 row carries the handoff marker text without the flag, and 1 tool row merely
  quotes that marker inside its payload;
- 7 rows have empty `content`, and 2 of those carry their text in `api_content`
  instead (`[response interrupted]`);
- 1 session is delegated (`source = 'subagent'`) and is captured without its
  messages, because its parent owns the spawning call.

What was changed: `cwd`, `git_branch` and titles were replaced or neutralised, and
every prose column (`content`, `tool_calls` arguments, `reasoning_content`,
`display_metadata`, `api_content`, `codex_message_items`) was rewritten as neutral
text of the same shape. JSON values keep their keys, nesting and types; NULL stays
NULL; an empty string stays empty. Session ids, message ids (`INTEGER`, as the host
stores them), `tool_calls` call ids and timestamps are unchanged: the adapter keys
on them, and renamed ids would not exercise the identity and pairing rules they are
here for. Upstream's own handoff markers — `[CONTEXT COMPACTION …]`,
`[CONTEXT SUMMARY]:`, `[PRIOR CONTEXT …]`, `[END OF PRIOR CONTEXT …]`,
`[ASYNC DELEGATION …]`, `[response interrupted]` — are structural text and are kept
verbatim and in place, because the adapter classifies on them.

Not captured here: `codex_message_items`. No row in the local store carries a value
for that column (it is written only by the Responses transport), so its fixture stays
synthetic in `tests/hermes-provider.test.mjs` and follows
`agent/codex_responses_adapter.py` upstream.
