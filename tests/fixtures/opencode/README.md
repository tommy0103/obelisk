# OpenCode fixtures

`real-store-rows.json` is the original PR's sanitized store-row capture. Its V1
rows describe retained legacy history (the session reports version 1.17.7), not
all writers shipped in v1.19.3. The regression fixtures below separately verify
the actual schemas and modern writer used by these pinned official releases:

- v1.19.3: `e3c4eb242585dcd77be1a867391b7c25fd47ce52`
- v2.0.32: `843a6c514e606b436a7fe713422ace0a93ad3d61`

## Pinned upstream schema fixtures

`upstream-v1.19.3.sql` and `upstream-v2.0.32.sql` contain the literal SQL passed
to `tx.run()` in each commit's `packages/core/src/database/schema.gen.ts`, in
source order, with template-literal backtick escapes and trailing whitespace removed. They retain the
upstream MIT license and include the real constraints and indexes (notably
`part_session_idx`). The tests create new on-disk stores from this SQL and insert
only synthetic `/workspace/synthetic` data; no local history is read.

The source contracts were checked in `packages/core/src/session/sql.ts` and
`projector.ts`: v1.19.3 already writes modern `session_message` rows under the
`session` metadata table. v2.0.32 uses `session_v2` for that metadata. Its
`20260804233008_loose_psylocke.ts` migration renames the pre-split V2 table in
place. Format selection must therefore be per session, not inferred solely
from the metadata table name. Native shell fixtures follow
`packages/schema/src/shell.ts` and `packages/core/src/session/message-updater.ts`
at the pinned v2 commit, including structured Output and native exit states.

## Captured structure & schemas

The original row capture exercises these relational layouts:
- Legacy: `session`, `message`, `part` tables covering user turns, assistant reasoning,
  text, tool execution (`read`), and step tokens in `step-finish`.
- V2: `session_v2`, `session_message` tables covering user turns, model switches
  (`Model.Ref` objects `{ id, providerID }`), agent switches, assistant
  reasoning/text/tools, compaction summaries, and subagent parent-child relations.

## Sanitization and transformations

To protect privacy and remove environment-specific traces while preserving exact
structural fidelity:
- All personal home paths and developer directories have been sanitized to
  generic project workspaces (`/workspace/v1-project`, `/workspace/v2-project`).
- Authentic `Model.Ref` object structures (`{ id, providerID }`) are preserved in
  V2 assistant messages and switch cards, matching upstream schema types.
- Relational foreign keys (`session_id`, `message_id`, `callID`, `parent_id`),
  timestamps, token accounting, and tool states are faithfully retained.

## Synthetic adversarial test fixtures

Synthetic adversarial edge cases (such as textless step-finish accounting,
part-level reverts on multi-part user messages, database concurrency race
conditions, and spoofed provenance lookup attempts) are generated programmatically
within `tests/opencode-provider.test.mjs` with explicit test-level assertions.
