# DeepSeek provider: root-tree units with a two-path parse (checkpointed fast path, snapshot fallback)

Supersedes the file-level incremental design of PR #74 (never merged).

**Context.** DeepSeek Harness (dsh) persists a *process log*: append-only
zstd-framed JSONL where events are self-contained items sharing a `{turn,
step}` flow identity, but the canonical transcript is a computed projection
(anchors synthesized from durable `tool/call` events, subagent child files
folded into the root session, aggregates accumulated across the stream). PR
#74's file-level frame cursor assumed "one append-only file = one independent
unit", and every cross-window or cross-file invariant (anchor canonicality,
parent chains, aggregate ownership, generation detection) became a heuristic
patch. Three adversarial review rounds demonstrated that the patch series does
not converge: each fix introduced the next boundary case.

The full snapshot alternative (reparse everything on every change, like the
codex provider) is correct but discards a real property of the format: dsh
events are self-contained and their identities are derivable from event
content alone (`{turn, step}`), so incremental emission needs only a small,
enumerable amount of carried state.

**Decision.** The deepseek provider uses **root-tree units with a two-path
parse**.

- **One `IndexUnit` = one root session tree** (a root session file plus all
  its descendant subagent files, grouped at discovery by project-scoped
  ancestry). `IndexUnit` has never meant "file" (ADR-0001); the codex
  provider already folds child threads into one unit. This makes every
  cross-file ownership question (sidechain messages, subagent rows, session
  aggregates) internal to the unit.
- **The cursor is a checkpoint, not a counter.** Alongside the
  persist-compatible `mtime:count` prefix it carries an opaque base64url
  JSON state: per-member `{ agentId, headerHash, inode, count,
  prefixHash }` (sha256 over ALL committed frames/lines, not just the
  boundary entry) plus per-member `lastMessageUuid` (and its own parent,
  so a step straddling the boundary resumes without parent cycles) and the
  set of steps with an emitted tool_use anchor.
  What used to be heuristic inference (signature gates, backward frame
  scans) becomes explicit, inspectable state.
- **Fast path** applies only when every member satisfies strict
  preconditions: identical member set and identities, unchanged inodes,
  counts non-decreasing, and the stored cumulative prefix hash still
  matches the current committed prefix (every frame/line, not just the
  boundary entry). Then only new
  frames/lines are decoded, `lastMessageUuid` is restored from the
  checkpoint, and records emit with `countMode: 'delta'`. In real logs the
  step's `assistant/message` is persisted at step end — before the durable
  `tool/call` checkpoint of the tool it ordered — so the canonical anchor
  normally exists first, and the checkpointed anchor-step set keeps a
  later-window tool/call from rewriting it. A provisional anchor arises only
  for steps whose assistant/message never lands (crash/abort); it may never
  be followed by a canonical row, and the checkpoint keeps it stable.
- **Snapshot fallback** covers everything else (member added/removed,
  replacement, truncation, identity change): emit `delete-session` for the
  root — the cascade is safe because the whole tree is re-emitted by the
  same unit in the same stream — then a complete re-parse with
  `countMode: 'total'`.
- Discovery emits tombstone units (`retractSessionIds`) for indexed deepseek
  sessions whose files have disappeared.

**Changed-path routing.** Watcher events route through one lookup structure
built per discovery: every changed path is canonicalized once (realpath,
resolving through the longest existing ancestor so renamed-away paths still
converge across symlink aliases), then matched exact member file → session
dir → project dir — two maps keyed by path, whose values are SETs of trees
(multiple trees may share a project directory — no key overwrite). Two extra knowledge sources keep the table complete: member
paths recorded in each tree's cursor checkpoint (a deleted member still
routes precisely to its tree) and indexed sessions' jsonl_paths (the old path
of a moved tree routes by identity). A directory-level event or an unroutable
path reconciles every tree. Paths outside this provider's root are ignored
entirely.

**Consequences.**

- The correctness invariant is property-testable: for any split point, a
  two-phase incremental parse converges the database to the same state as a
  single full parse.
- No persist-layer changes are required: the fallback's delete-session
  precedes re-emission, so merge semantics never see stale aggregates; no
  unit-scoped retraction primitive is needed (PR #74's `retract-scope` is
  withdrawn with the design).
- Subagent `total_tokens` cannot be authoritative on the delta fast path (a
  window sees only part of a child's usage), so the query-layer null-fill
  derivation of ADR-0010 remains the shared semantics.
- Packed chunk rows are not expanded during projection (their content
  duplicates the step-final `assistant/message`); the vendored codec stays
  available for raw reconstruction but is not on the indexing path.
