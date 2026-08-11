# Write-transaction rollback safety and SQLite concurrency

**Context.** The app surfaced `Obelisk index build failed: cannot rollback - no
transaction is active`. That text was a secondary cleanup failure. SQLite had
already ended the transaction, then the catch block's unguarded `ROLLBACK`
threw over the primary exception and turned a skippable per-file failure into a
whole-build failure. The masked exception was not preserved, so contention
(`SQLITE_BUSY` / `SQLITE_BUSY_SNAPSHOT`) is the leading explanation rather than
a proven historical fact. It is plausible because daemon builds, manual
rebuilds, CLI passive-pull indexing, heartbeat writes, and reads share one WAL
database.

`busy_timeout` alone is not a correctness fix. In particular,
`SQLITE_BUSY_SNAPSHOT` is not made safe by waiting longer, and retrying only the
failed statement can replay part of a transaction.

**Decision.** Use one transaction primitive plus two explicit coordination
layers.

- `packages/core/src/tx.ts` owns the binding-agnostic
  `runWriteTransaction(db, work)`.
  Adapters expose transaction state from better-sqlite3's `inTransaction` and
  node:sqlite's `isTransaction`. The primitive performs `BEGIN IMMEDIATE`, runs
  `work` exactly once, commits, and attempts rollback only when the binding says
  a transaction is active or its state is unknown. Cleanup never masks the
  primary exception. Diagnostics record phase, SQLite code, rollback outcome,
  transaction state, label, and attempts.
- Retry is an upper-layer policy in `packages/core/src/write-coordinator.ts`, never hidden
  inside the transaction primitive. Only an idempotent whole transaction that
  failed during work/commit with `SQLITE_BUSY*` and is confirmed inactive may be
  retried. The default is three attempts within a one-second budget with short
  backoff. BEGIN contention is deferred to the build scheduler; an active or
  unknown post-error transaction aborts the build.
- Per-file failures remain warnings and are reported in `skippedFiles`; finalize
  failures propagate. `affectedSessionIds` is updated only after the relevant
  commit. Force cleanup is one atomic, retryable transaction, and finalize is
  likewise retried as a complete idempotent transaction.
- A fresh `__app_heartbeat__` is policy ownership: while it is fresh, the CLI
  opens no write connection and performs no migration, schema setup, checkpoint,
  index build, or `attune`. `__app_last_successful_build__` remains an
  observability/freshness marker and is not required for ownership. The CLI
  checks ownership again after acquiring the hard lease to close the TOCTOU
  window. Search/query connections are read-only.
- A dedicated `.obelisk/writer.lock.sqlite` provides the cross-process safety
  mutex on every platform. Acquisition is `BEGIN IMMEDIATE` with non-blocking or
  bounded waiting; release is idempotent. App builds and heartbeats, CLI builds
  and attune, app schema/legacy migrations and memory mutations, and manual
  rebuild all participate. Manual rebuild's main process owns the lease across
  worker build, atomic target replacement, and database reopen; the worker uses
  the explicit `caller-held` mode.
- The app's in-process indexer service permits one build at a time. A lease
  deferral retains changed paths and schedules a short retry without announcing
  a successful build. Service start publishes the ownership heartbeat
  immediately, then refreshes it periodically.
- Index-writer and CLI read connections use an explicit 250 ms SQLite busy
  timeout inside the larger bounded coordination budget. The long-lived app
  query connection retains a 5 s timeout; heartbeat is deliberately non-blocking
  (`0 ms`) so it never stalls the Electron main thread. Builds use
  `BEGIN IMMEDIATE`. Routine checkpointing is `PASSIVE`; blocking `TRUNCATE` is
  reserved for explicit maintenance.

**Verification.** Fast tests inject auto-rollback and BUSY failures to prove the
primary error is preserved, retry replays the whole transaction, persistent
per-file failure is skipped, force cleanup is atomic, and affected-session state
is commit-aware. The Electron harness uses real Electron-ABI better-sqlite3 and
two child processes: one holds the SQLite writer lease until signalled, while
the other runs synchronous `buildIndex`. It verifies both release-within-budget
success and bounded `writer_busy` deferral. Separate arbitration tests prove a
heartbeat-only daemon marker keeps query and attune paths read-only.

**Consequences.** Heartbeat and lease have deliberately different jobs: the
heartbeat decides who should write, while the lease guarantees writers cannot
overlap when policy information races or is stale. A single bad transcript can
still be skipped so the index self-heals on a later build; structural/finalize
failures remain visible. Longer timeouts must not replace the transaction and
ownership rules recorded here.

**Amendment (2026-08-11): invocation-nonce freshness carve-out.** The original
decision makes a fresh `__app_heartbeat__` policy ownership for every CLI write
path. One narrow exception is now granted: the invocation-nonce freshness
build — the single incremental build a query runs when its invocation nonce is
not yet indexed (`buildIndex({ ignoreRecentBuild: true, ignoreDaemonOwnership:
true })`) — may ignore daemon policy ownership. Without the carve-out, nonce
resolution in daemon mode could never succeed: the pre-query refresh always
skips with `daemon_active`, and the daemon's watcher-driven build lags the
just-written tool-call record by seconds.

The heartbeat's job is unchanged; the writer lease remains the sole arbitrator
of who actually writes. The carve-out build acquires the lease non-blocking, so
it can never overlap a daemon build. Loser paths are unchanged: on
`writer_busy` the CLI falls back to the existing bounded poll of freshly opened
read snapshots and then to honest null, and the daemon's indexer service keeps
its defer-and-retry on lease contention with changed paths retained.
Consistency holds because incremental cursors live in `index_state` inside the
database: a CLI incremental build and later daemon builds read and advance the
same cursors. The carve-out build never selects the force full-republish path,
and it runs only against an already-initialized index: schema setup under a
fresh heartbeat remains the daemon's job, so a CLI query against an
uninitialized index stays read-only and falls back to the bounded poll. The
gate enforces this with `coreSchemaNeedsMigration`, so a legacy schema whose
tables exist but whose columns predate the current version also blocks the
carve-out build.
Note that `openDb()` always applies the shared `schema.sql` idempotently, so
additive `IF NOT EXISTS` statements (for example a new index) may also be
applied by a carve-out build while holding the lease; this is safe because
the daemon applies the identical shared schema on its own builds. What the
carve-out never does is initialize or migrate a missing/legacy schema.

Every other CLI write path keeps the original rule: the regular pre-query
refresh, `attune`, migrations, schema setup, and checkpoints all remain
read-only under a fresh heartbeat.

**Amendment (2026-08-11, later the same day): memory-mutation carve-out.** The
blanket rule above listed `attune` among the paths that stay read-only under a
fresh heartbeat. That was over-broad: `remember()`/`forget()` write only the
`memories` table (plus its FTS triggers), which index builds — force rebuilds
included — never delete from, and a memory mutation carries no multi-transaction
state for the writer lease to protect. Blocking memory writes while the app ran
made the CLI memory flow unusable in exactly the configuration where it is most
used. This paragraph supersedes the "attune remains read-only" rule above.

`executeAttune` therefore no longer reads provider settings, builds the index,
checks daemon ownership, or acquires the writer lease. It opens the existing
database through `openAttuneDb()`, which never creates, migrates, or configures
the index and fails honestly when the memory layer is absent. Each mutation runs
as one short `runRetryableWriteTransaction`. Concurrent mutations need no mutex:
`remember()` generates unique ids, `forget()` is idempotent, and WAL serializes
writers — contention surfaces as a bounded busy retry, never as a logical
conflict. Index builds and memory mutations can still interleave at the SQLite
level; both orders are consistent because `memories_fts` is maintained either by
its triggers (attune inserts) or rebuilt from `memories` (index finalize).
