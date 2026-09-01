# Indexing is a registry of pure provider adapters over one shared persist layer

> Revised 2026-07-08. The first draft framed the parse layer as a single "parse
> core" with "two thin persist layers, one per binding." That was wrong on both
> axes and is corrected below: the parse layer is a *registry of per-provider
> adapters* (driven by the multi-provider roadmap), and there is *one* shared
> persist layer, not one per binding.

**Context.** Obelisk had two divergent full indexers — the former
`scripts/indexer.mjs` (`node:sqlite`, the former skill-embedded runtime) and
`app/indexer.js`
(`better-sqlite3`, Electron
app) — that duplicated the same Claude and Codex JSONL parsing and had silently
diverged in write semantics (`INSERT OR REPLACE` vs `ON CONFLICT DO UPDATE`,
message-count accumulation). Two forces shape the fix: (1) the roadmap will add
more transcript sources — opencode, pi, and others — so the parse layer must be
*pluggable*, not one monolith; (2) `node:sqlite` and `better-sqlite3` share the
same `prepare/run/get/all` API, so persistence is *already* nearly
binding-agnostic and does not need a per-binding implementation.

**Decision.** Split indexing along two orthogonal axes.

- **Provider axis — a registry of pure adapters.** Each source (Claude Code,
  Codex, Kimi Code, Pi, …) is a provider adapter implementing one complete
  boundary: serializable descriptor metadata, `watchRoots(root)`,
  `discover(context) → IndexUnit[]`,
  `parse(unit, cursor) → Iterable<Record>`,
  and `raw(lookup)`. An `IndexUnit` is deliberately not a file abstraction: Kimi
  uses one session directory containing state plus multiple agent wire logs. An
  adapter is *pure*: it emits normalized records and never touches a database.
  Discovery receives a read-only view of the provider's already-indexed session
  paths. A full-reparse adapter can therefore attach `retractSessionIds` to a
  replacement or tombstone unit without querying SQLite itself. Unit retractions
  and replacement records commit in the same unit transaction, so a failed parse
  preserves the last complete snapshot.
  Provider identity may therefore be richer than a wire-level ID. Pi, whose
  explicit session IDs are project-local, deterministically namespaces the
  header ID by the normalized header cwd; source paths remain provenance rather
  than identity, so copying or moving a transcript does not rename the session.
  Adding a source means adding one adapter and registering it; nothing else
  changes. `parse` exposes an iterator as its common interface and streams when
  the provider semantics permit it. An adapter may buffer one complete
  `IndexUnit` when correctness requires whole-unit semantics — for example,
  Codex duplicate reconciliation, Kimi `context.undo` / `context.clear`
  replay, or Pi tree projection. Each adapter maps its own resume/change
  semantics onto an opaque cursor stored exactly in `index_state.cursor`;
  `mtime` and `lines_processed` remain compatibility/index-inspection columns.
  A provider-wide replay is a destructive snapshot boundary. Discovery reports
  any source location it could not enumerate; destructive rebuilds fail closed
  when such a report exists. Cleanup, parsing, persistence, FTS rebuild and
  marker publication commit in one transaction, so a parse failure cannot
  replace the last-good index.
  The emitted
  `TranscriptRecord` stream is also the input to provider-independent session
  detail assembly; see ADR-0007.
- **Persist axis — one shared orchestration.** A single provider-agnostic,
  binding-agnostic layer consumes records from any adapter and writes them:
  incremental `index_state` bookkeeping, FTS maintenance, and the canonical
  **upsert** (`ON CONFLICT(uuid) DO UPDATE`) write semantics reconciled from the
  drift on 2026-07-08. The database handle is *injected*, so `node:sqlite`
  (CLI) and `better-sqlite3` (app) run the same code — there is no
  per-binding persist layer.

**Amendment (2026-09-01): idempotent exact-value persistence.** Snapshot
providers may correctly replay a complete canonical session after a small
source change. The shared persist layer must not turn an identical replay into
physical database churn. `messages`, `tool_calls`, and `tool_results` therefore
use primary-key UPSERTs whose update branch runs only when at least one
authoritative persisted value differs, using NULL-safe comparison. Message
comparison deliberately excludes `turn_duration_ms`, which is owned by the
separate `message-turn-duration` record; that targeted update is itself skipped
when the stored duration already matches. A skipped message update also skips
the schema's `AFTER UPDATE` FTS maintenance, while a real message change retains
the existing atomic content-row and FTS update behavior. Tool rowids remain
stable across both identical and changed replay, preserving insertion order for
consumers such as workflow-parent healing.

This is a table-specific rule, not permission to mechanically replace every
write in `persist()`. Sessions derive merge values and counts from prior state;
subagents and workflow agents merge multiple contributors with `COALESCE`;
summaries and workflows retain whole-row replacement semantics; and
`index_state` must continue publishing provider progress. Any later no-op
optimization for those records must compare their computed post-merge state and
preserve their individual contracts. No provider cursor or canonical transcript
marker changes for this amendment because the projected canonical values do not
change.

**Two indexing modes** share all of the above and differ only in trigger:
**daemon mode** (the app, and potentially a future CLI daemon, watches and keeps
the index fresh) and **passive pull mode** (a CLI command indexes on invocation
when no daemon is active). They never write concurrently — passive mode detects
a fresh daemon via heartbeat markers in `index_state` (**daemon arbitration**).
One narrow exception: the invocation-nonce freshness build may index
incrementally under a fresh daemon heartbeat, arbitrated by the writer lease
(see the 2026-08-11 amendment in ADR-0006).

**Amendment (2026-09-01): Kimi session-manifest cursors.** A Kimi session
directory remains one atomic `IndexUnit`: `state.json`, the main wire, and
subagent wires jointly define one canonical timeline, and a genuinely changed
unit may still require a complete replay for undo, clear, compaction, member
removal, and cross-wire tool relationships. That snapshot policy does not
justify reading every unchanged wire body during discovery. Passive-pull
discovery must scale with member metadata, not total transcript bytes.

Kimi therefore separates three internal operations behind the unchanged
provider interface: collect one normalized session-member snapshot, encode that
snapshot as a cursor, and classify a stored cursor as current, upgradeable, or
requiring replay. The snapshot contains the sorted relative member paths and
their identity/change metadata (`dev`, `ino`, `size`, `mtime`, and `ctime`) for
`state.json`, current agent wires, and the legacy root wire when applicable.
Discovery hashes only this metadata; it never hashes or counts wire contents to
decide that an unhinted session is unchanged. The cursor keeps the two numeric
compatibility slots followed by a provider-owned format tag and digest, for
example `maxMtime:0:kimi-manifest-v1:<digest>`. Path normalization, sort order,
included fields, serialization, and digest algorithm are all part of that
cursor-format version.

The discovery snapshot travels in `IndexUnit.meta`. Parse takes a fresh snapshot
before reading and another after projection; a member-set or metadata change at
either boundary rejects the torn unit and leaves its prior cursor and canonical
rows intact. A watcher hint continues to re-plan its session even when the
stored cursor matches. An indexed session that loses a member, including its
last wire, is a changed/tombstone unit rather than an unchanged session to skip.
An enumeration/stat race is reported as incomplete or unstable inventory and is
retried; it must not publish a cursor for a snapshot the adapter did not prove.

Kimi deletion reconciliation is identity-based, not path-ordered. The
namespaced native session id remains stable when Kimi moves a session directory
between workspaces, so discovery first builds a provider-wide identity census
and then routes work to the current directory. A missing old path never produces
a tombstone while the same identity is live elsewhere; the current directory is
replayed instead, updating canonical provenance atomically. Duplicate live
directories for one identity make the census ambiguous and fail closed.

`changedPaths` is an invalidation/routing hint, not evidence that a missing path
was intentionally deleted. Discovery-known retractions are emitted through
`IndexUnit.retractSessionIds` only after the complete identity census proves the
identity absent. If the sessions root, a workspace, or a required member cannot
be inventoried, Kimi may still replay source-local readable units, but it must
withhold tombstones and moved-provenance replacement until a later complete
census. This preserves the last-good canonical snapshot across unmounts,
permission failures, and observation races.

Cursor-format versions and canonical-transcript markers have different
lifecycles. A legacy or unknown Kimi cursor never proves that a unit is
unchanged, but it also does not throw: it fails closed to replay and is replaced
atomically only after that unit succeeds. For a future manifest version, the
adapter may compute both old and new fingerprints from one metadata snapshot;
when the stored old fingerprint still matches, `parse` may yield no transcript
records and return only the new cursor, giving a per-unit cursor-only migration.
If the old format cannot validate the current snapshot, the unit replays once.
Failed units retain their old cursor and retry independently.

`indexVersionMarker` is not bumped for a cursor-format change alone. It is the
provider-wide repair boundary for changes that affect already-stored canonical
rows (UUIDs, roles, visibility, projection semantics, or stale rows requiring
retraction). Using it for manifest serialization would conflate control-state
migration with transcript migration and force an unnecessary destructive
provider replay. The former `maxMtime:totalLines` Kimi cursor violated this
decision because computing it reread the complete wire corpus merely to return
no changed units; issue #128 records the measured impact and migration context.

Rejected alternatives are: directory mtime alone, which cannot prove nested
member stability; content hashing or line counting during every discovery,
which makes unchanged cost proportional to transcript bytes; and bumping the
canonical marker merely to change cursor encoding. Metadata cannot detect a
rewrite for which a platform exposes no changed path, identity, size, mtime, or
ctime; watcher hints remain the live invalidation path, while reconciliation
provides the strongest portable metadata check required by the provider cursor
contract.

**Consequences.** Golden tests anchor on each adapter's `parse` output (feed
fixture JSONL, assert the yielded record sequence) — independent of binding and
persistence. The app's richer changed-path discovery becomes a `discover`
strategy injected into the shared orchestration, not a fork of it. The Electron
main process migrates to ESM (ADR-0003) to import the shared core. The real work
is disentangling the currently interleaved parse-and-write inside `indexJsonl` /
`indexCodexJsonl` into (pure adapter parse) + (shared persist).

The normalized `TranscriptRecord` union is the stable center of the design, and
SQLite is one serialization adapter for it. Provider-only concepts are either
projected lossily into that language or ignored. A genuinely shared concept may
extend the canonical language by explicit decision: summary-generating model
calls, for example, carry the same normalized input/output usage as ordinary
messages. The registry, not provider switches, drives both indexers, watcher
roots, persisted source roots, source catalog/UI labels and colors, and
raw-record routing. Adding Pi therefore adds no Pi-specific branch to the
shared schema, persist layer, indexers, settings, query API, or renderer; the
provenance and summary-usage additions are provider-neutral contracts.
