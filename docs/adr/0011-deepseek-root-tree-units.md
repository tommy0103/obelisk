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
built per discovery: bounded canonicalization (realpath, resolving through
the longest existing ancestor so renamed-away paths still converge across
symlink aliases) plus a bounded ancestor lookup (exact member file → session
dir → project dir) — two maps keyed by path, whose values are SETs of trees
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


**Amendment (2026-10-20): future members retain their whole tree.** A readable
future-format identity envelope participates in ancestry discovery but its body
never reaches projection. An unsupported member retains the complete root tree,
not just its physical session directory. Discovery closes that decision over
both the current graph and checkpointed members, so another tree cannot adopt a
member and overwrite retained rows. If historical ownership is unavailable,
project-local protection is conservative. Unaccounted historical identities
defer deletion until unknown content clears. The same current and
historical ownership closure expands watcher invalidation on recovery, so an
old owner cannot retract a member without its new owner being projected in the
same completed refresh. Pending replay also bypasses the changed-path filter.
Malformed or unreadable headers still invalidate inventory and use the
established project suppression.

Retention matches current and checkpointed paths through the same physical-path
canonicalization as watcher routing, including the longest existing ancestor for
removed generations. Current realpath or directory existence alone is not proof
of historical ownership: links can be rebound and members can move while the old
project remains. A checkpoint is trusted only for its own indexed session id.
While future artifacts exist, an indexed tree whose historical member identities
are not fully accounted for in the current census retains its last-good closure.
A rootless group remains ownership evidence, but cannot account for historical
members because it cannot publish a replacement tree.
Unknown envelopes may change id, scope and location together, and a source path
may be rebound or replaced by a regular directory. Without historical physical
namespace evidence, no current-path comparison can distinguish such a move from
a deletion. This correctness fallback covers root/child relocation and namespace
reuse without adding another ownership heuristic. Intact readable trees continue
publishing; a genuinely deleted historical root or member may remain stale until
unknown content clears, including when that content later proves unrelated.
Recovery then converges to the same result as a fresh full rebuild.

If checkpoint membership is missing or belongs to another session, canonical
subagent ownership supplies historical edges and the member census. Legacy
callers without either source retain possible projects conservatively. An
absent root still retains its own history. Persisted unit keys,
checkpoint encoding and canonical identities remain unchanged.

Historical paths/checkpoints identify candidate replaced roots, not deletion
proof. Old identities may retire only when the complete current root census
proves them absent everywhere; a live moved root is protected even if its old
directory is reused. Retirement uses `IndexUnit.retractSessionIds` inside the
publication transaction and requires strict snapshot validation, so no-op
parse guards cannot certify an eager retraction. A standalone indexed root
adopted as a subagent retires its old root row in that same transaction.
Its moved-away checkpoint closes without repeating the retraction after the
new owner writes child rows. If its old directory now belongs to a different
root, that replacement owns the checkpoint key and must not retract the
adopted identity. A changed checkpoint identity bypasses watcher routing hints
and requires a complete snapshot.
Force, canonical-marker replay, and pending replay of an indexed identity set
`snapshotRequired`; an unavailable member, changed header, or undurable seed
fails that projection instead of committing a cursor-only no-op after
destructive cleanup or reporting unfinished recovery as complete. Ordinary
incremental no-op guards retain their existing fail-closed behavior and cannot
commit a retirement.

**Amendment (2026-10-20): ownership transfers publish atomically.** Current
trees, owned checkpoint members and canonical subagent ownership form connected
components. A component with more than one root owner receives a shared
`atomicGroup`; all its live owners and proven tombstones are planned together,
including unchanged owners outside a watcher hint. Every live unit requires a
complete snapshot. Shared indexing commits or rolls back that set as a whole,
so the old owner cannot delete history before a failing new owner publishes it.
A known divergent or unreadable receiver withholds the connected owners during
discovery. A rootless transfer also withholds them; a rootless singleton may
still represent a proven root deletion. Incomplete inventory protects historical
members that cannot be accounted for, as does an unsupported artifact. Healthy
components continue independently.

Canonical ownership remains evidence even when its source checkpoint is lost or
reused. It does not make every recorded spawn a required on-disk file: an owned
checkpoint's actual file census remains authoritative when available. A
successfully published deletion leaves a non-null tombstone cursor, clearing
replay debt without recreating the retired session.
