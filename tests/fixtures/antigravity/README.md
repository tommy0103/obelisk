Excerpts of real Antigravity step logs
(`brain/<conversation>/.system_generated/logs/transcript_full.jsonl`), captured
from the Antigravity 2.x desktop app on Windows, with the text removed.

What is kept as captured: every line's keys, `type`, `source`, `status`,
`step_index`, token counts, tool names, tool argument keys, number and boolean
argument values, media MIME types, and the tag skeleton of user inputs
(`<USER_REQUEST>`, `<ADDITIONAL_METADATA>`, `<USER_SETTINGS_CHANGE>`).

What is replaced: all request, reply, reasoning, output and error text, string
argument values, paths and media URIs (`Example …`, `/workspace/example/…`).
Equal original strings map to equal replacements, so a resent request stays a
repeat. Timestamps are moved to fixed dates; their order is kept. Each file is
a set of whole step windows (a response and the outputs that follow it), cut
from one conversation:

- `conversation-a.jsonl`: the first request logged three times under one step
  index, system notices, tool rounds (one output still `RUNNING`, one `ERROR`,
  one with an image), a compaction `CHECKPOINT` with usage, a malformed-call
  `ERROR_MESSAGE`, and a request with an attachment.
- `conversation-b.jsonl`: three outputs after a response with two calls.
- `conversation-c.jsonl`: responses logged without token usage.

`conversation_summaries.sql` is the `conversation_summaries` table definition
from the same installation's `conversation_summaries.db`. Tests create the
database from it with their own rows.
