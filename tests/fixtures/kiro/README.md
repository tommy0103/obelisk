# Kiro CLI 2.27.1 captures

Sanitized excerpts captured on 2026-10-06. Top-level fixtures came from existing
history opened read-only. V3 fixtures came from native CLI runs in a disposable
HOME and database copy. Separate `--agent-engine v1/v2/v3` runs verified the
SQLite, flat CLI and nested workspace layouts respectively. Event `version: v1`
is a serialization label, independent of the engine number.

- `cli.json{,l}`: subagent-origin metadata, turn usage/message ids, prompt,
  thinking, tools, JSON/text results, an error and final assistant text.
- `session.json` / `messages.jsonl`: workspace schema 1.0.0 with text and credits.
- `conversation.json`: a `conversations_v2` row with tools/results and cancelled
  input. Tests serialize `value` into a temporary SQLite TEXT column.
- `v3/`: native file/shell tools, child execution and its completion response.
  Child start precedes its orchestration tool call, matching native ordering.
- `v3/compaction.jsonl`: assistant `Summary` produced by TUI `/compact`.
- `v3/tangent/`: native `/tangent smoke` session with parent and fork metadata.

Content, paths, ids, signatures and timestamps are replaced. Shared identities,
protocol discriminants and usage values are preserved. Unused transport fields,
repeated turns and duplicate `orig_args` are omitted. Tests mutate copies for
regressions. `.history` files contain line-editor input, not complete transcripts.

References: [session management](https://kiro.dev/docs/cli/chat/session-management/),
[platform data directories](https://kiro.dev/docs/cli/experimental/knowledge-management/).
The newer field schemas were verified locally; Kiro publishes no stable contract.
