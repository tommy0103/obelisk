# Codex apply_patch fixture

`codex-apply-patch.jsonl` is a minimal excerpt of a real Codex rollout captured
on 2026-09-06: session metadata, a `custom_tool_call`, and its matching
`custom_tool_call_output`. Event types, timestamps, call status, patch line
boundaries and markers retain their captured shape. IDs and paths were replaced,
patch prose was masked, and the result text was sanitized. Unrelated events and
private session metadata were omitted. No production transcript is read by tests.

The larger patch in the regression test is deliberately generated stress data;
it is not presented as a captured transcript.
