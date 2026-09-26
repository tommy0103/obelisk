# Copilot fixture provenance

`transcript-v1.jsonl` and `transcript-empty-v1.jsonl` are privacy-sanitized
copies of complete transcript-version-1 files observed in VS Code Insiders on
2026-09-17. Their event order, envelopes, field presence, empty/non-empty text
states, tool rounds, success flags, resumed-session shape, and incomplete final
turns are unchanged. Sanitization replaced identifiers, timestamps, paths,
conversation text, reasoning text, tool names, and tool argument values while
preserving value types and cross-event identifier relationships.

`chronicle-v3.json` is not a literal Copilot artifact. It is a privacy-sanitized
JSON projection of rows from the observed Chronicle SQLite schema version 3,
used by the test setup to construct a real SQLite database with the observed
`sessions` and `turns` columns. Values were replaced; column presence and SQLite
value types were retained.

Two fixtures are explicit synthetic compatibility mutations:

- `transcript-unknown-version.jsonl` changes an observed
  `session.start.data.version` to `99`; its following event retains the observed
  version-1 envelope solely to prove that no event is interpreted.
- `transcript-unknown-event-v1.jsonl` combines an observed version-1
  `session.start` envelope with a made-up `future.event`. The event is not
  presented as upstream output and must be ignored conservatively.

No fixture contains original paths, identifiers, conversation text, reasoning,
tool arguments, credentials, or other private values.
