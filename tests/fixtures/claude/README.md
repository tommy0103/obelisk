# Claude Code fixtures

`custom-title-session.jsonl` is an excerpt of a real Claude Code 2.1.260
session captured on 2026-09-15 via:

    CLAUDE_CONFIG_DIR=<isolated dir> claude -p -n "obelisk fixture capture" "Reply with exactly: ok"

Every line is byte-for-byte as written by Claude Code: the `custom-title`
and `agent-name` records it writes at session start when `-n` assigns a
display name, plus the first real user message. The capture's attachment,
queue-operation, and synthetic error-message records were dropped as
parser-irrelevant noise; no retained line was edited.

The provider consumes `custom-title` and ignores `agent-name`; both are
kept to document what real transcripts carry.
