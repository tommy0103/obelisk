# MiniMax Code (`mcode`) Fixture Provenance

- **Upstream tool**: `@minimax-ai/code@0.8.0` (`MiniMax-AI/minimax-code` `main` @ `3c21163`).
- **Capture**: Generated locally via `mcode exec` against an isolated `MINIMAX_DATA_DIR` and a local OpenAI-completions loopback server, exercising:
  - Plain user/assistant turns with `thinking` blocks and `custom` (`execution_budget_reminder`, `session_identity_reminder`) harness messages.
  - `read` tool call + `toolResult`.
  - Two consecutive `llm_checkpoint` compactions (`g000000000000--*.jsonl`, `g000000000001--*.jsonl`, plus `env-g*.json` sidecars and `history_artifact.parentSnapshot` chain in `messages.jsonl`).
- **Sanitization**: Host-specific paths (`/Users/...`) were replaced with `/workspace/demo` and `/data/minimax`.
- **`schema.sql`**: Extracted verbatim from `v2/sqlite/runtime-state.sqlite` (`local_runtime_sessions`).
