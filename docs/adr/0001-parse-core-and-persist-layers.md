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
  replacement or tombstone unit without querying SQLite itself. Retraction and
  replacement records commit in the same unit transaction, so a failed parse
  preserves the last complete snapshot.
  Provider identity may therefore be richer than a wire-level ID. An adapter
  can namespace a local ID with immutable source metadata while keeping paths
  as provenance rather than identity.
  Adding a source means adding one adapter and registering it; nothing else
  changes. `parse` exposes an iterator as its common interface and streams when
  the provider semantics permit it. An adapter may buffer one complete
  `IndexUnit` when correctness requires whole-unit semantics — for example,
  Codex duplicate reconciliation, Kimi `context.undo` / `context.clear`
  replay, or tree projection. Each adapter maps its own resume/change
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

**Two indexing modes** share all of the above and differ only in trigger:
**daemon mode** (the app, and potentially a future CLI daemon, watches and keeps
the index fresh) and **passive pull mode** (a CLI command indexes on invocation
when no daemon is active). They never write concurrently — passive mode detects
a fresh daemon via heartbeat markers in `index_state` (**daemon arbitration**).

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
raw-record routing. Adding another provider therefore adds no
provider-specific branch to the shared schema, persist layer, indexers,
settings, query API, or renderer.
