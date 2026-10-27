# OpenCode incremental adapter implementation plan

Status: approved for implementation in PR #237; implementation and verification
results will be recorded below. This document precedes the product changes.

## Contract and scope

Replace discovery's full-history payload hash with metadata discovery and
changed-session replay. Keep the public ProviderAdapter, canonical transcript,
read-only source ownership and destination transaction boundaries.

- An unchanged, established source reads **zero transcript payload rows**.
- A verified event-writer update replays only affected sessions and relationships.
- A changed session is the unit of replacement, not a message/event append.
- Legacy import's remaining message/part inserts must be found even when its
  session header and aggregate head do not change.
- Missing, unreadable, busy, unknown-schema or unstable sources retain last-good
  rows and cursors. Tombstones require a complete inventory and fresh verification.
- First import, explicit rebuild, schema/source replacement and loss of continuity
  may reconcile full payloads, with an explicit reason. Ordinary modern writes in
  a mixed store must not repeatedly scan all retained legacy payloads.
- Failed parsing/persistence does not acknowledge that unit's observation. Cursor
  and canonical replacement commit together; retry must converge after interruption.

This is metadata discovery plus session-level incrementality, **not** an
unconditional O(delta-message) guarantee. Let A = aggregate heads, S = sessions,
C = affected sessions, and B_changed = their payload bytes. Verified event-writer
work targets O(A + S + C log N + B_changed). Legacy/import compatibility may inspect
O(S + M + P) **metadata**, where M/P are retained message/part rows. Recovery may
read all payloads. No source triggers, indexes or journal changes will be installed.

## Pinned evidence and continuity constraints

- OpenCode v1.19.3: `e3c4eb242585dcd77be1a867391b7c25fd47ce52`.
- OpenCode v2.0.32: `843a6c514e606b436a7fe713422ace0a93ad3d61`.
- Starting Obelisk head: `ee9f60a57395dc2b7834ef8a8e0c2bdc50eeeb6e`;
  PR base: `a4b7329e1fcb8d907ec1f1c9543a26513d87631c`.

Normal durable writers update projector and event_sequence atomically. V2 event
payload persistence defaults off; session_message.seq is insertion order, not an
update revision. Deletion can remove the aggregate's head and log. V1 CLI import
writes session, messages and parts incrementally without one outer transaction or
aggregate-head updates. Therefore neither event payload replay nor head-only
cursors cover the declared source formats.

Primary contracts: [v1 durable transaction](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/core/src/event.ts#L239-L352),
[v1 import](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/cli/cmd/import.ts#L64-L109),
[v2 bus](https://github.com/anomalyco/opencode/blob/843a6c514e606b436a7fe713422ace0a93ad3d61/packages/core/src/bus.ts#L399-L430),
[v2 projector](https://github.com/anomalyco/opencode/blob/843a6c514e606b436a7fe713422ace0a93ad3d61/packages/core/src/session/projector.ts#L239-L257),
[v2 transfer](https://github.com/anomalyco/opencode/blob/843a6c514e606b436a7fe713422ace0a93ad3d61/packages/core/src/session/transfer.ts#L77-L143).
The checked-in upstream SQL fixtures contain the complete extracted schema.

A fresh connection's data_version is not a durable revision. WAL offsets/salts,
rowid tails, wall clocks and owner_id alone cannot establish continuity. Relevant
schema, store identity, complete session/header inventory, aggregate heads and
legacy member metadata form the observation. Unexplained physical source changes
must take a conservative reconciliation path, preserving existing same-millisecond
and body-only mutation tests. Concurrent arbitrary SQL edits that deliberately
hide behind another aggregate's legitimate write cannot be inferred from public
upstream metadata; do not claim a universal CDC protocol.

## Module boundaries

Keep opencode.ts as provider facade. Concentrate source schema/snapshot reads,
identity encoding/authentication, strict versioned decoding, canonical projection,
and manifest/cursor policy behind internal modules. Split only at meaningful
interfaces: a native row is decoded once for parse and raw; shared orchestration
never learns OpenCode table names or key syntax.

Identity encoders remain byte-compatible. All consumers use one decoder, including
paths containing `#ses:`. Delete metadata is an explicit union member with a native
ID, never an empty-ID sentinel. Watcher target file names and predicates compose
by union so a sibling provider's accepted files remain accepted.

## Phased commits and acceptance

1. **Plan and feasibility gate** (this document). Finalize observation/cursor and
   mixed-store recovery policy. Prefer per-unit state; introduce no fake canonical
   session or source checkpoint. If a new shared checkpoint contract becomes
   necessary, explain it before adopting it.
2. **Identity and watcher safety.** Add failing real-seam regressions for raw lookup
   and restored tombstones under delimiter-bearing paths, plus merged Hermes /
   OpenCode watcher targets. Centralize codec; authenticate destructive metadata.
3. **Decode and project.** Reject damaged legacy tool shapes without retracting
   last-good data. Decode native pre-split completed compaction and V2 lifecycle
   states consistently in parse/raw. Bump canonical marker to v3 because projection
   changes. Keep native rows for raw evidence.
4. **Incremental manifests.** Observe one read-only SQLite snapshot; indexed probes
   select modern-vs-legacy format without global message COUNTs. Compare header,
   aggregate head, legacy member sets/metadata and parent classification. Read
   payloads only for dirty sessions; validate discovery observation in parse's
   fresh snapshot. Store an explicitly versioned opaque cursor. Old/unknown cursors
   replay once; cursor serialization alone does not bump canonical marker.
5. **Compatibility and recovery.** Cover import prefixes, same-ID recreation,
   deletion races, DB/WAL rotation, schema migration, source replacement, malformed
   payload and transaction failures. Confirm app retry scheduling reaches parse
   instability; use a provider-neutral retry contract if needed. No per-provider
   orchestration branches and no source writes.
6. **Delivery.** Keep issue/PR claims aligned with the actual implementation and
   limits. Run complete Node 22 tests, root/app typecheck, lint and all Electron
   suites. Verify rebuilt CLI tarball and macOS packaged app/worker/raw entry points.
   Run fresh independent Standards and Spec adapter reviews and resolve blockers.
   Append commits to the original PR without force or merge, then add the authorized
   concise maintainer comment explaining the fixes and architecture.

Tests must fail against the preceding implementation for the intended reason.
Use synthetic data under real pinned upstream DDL, transparent SQLite row/byte
counters and real plan/persist/query/watch seams. Preserve existing assertions and
ensure new tests run in explicit CI file lists. Measure unchanged payload rows=0;
increasing unrelated history 10x must not increase dirty-session payload reads.
Record legacy metadata cost separately. Timings supplement operation counts.

## Implementation record

Pending. Record commit phases, deviations with reasons, final verification and
remaining limitations here as implementation proceeds.

### Correctness phase

Identity and decoding regressions were first run against the previous code: all
four failed for the reported behavior. Centralized the byte-compatible identity
codec, introduced explicit authenticated tombstone metadata, fixed shared watcher
union semantics and shared native payload decoding between projection and raw.
Pre-split completed compaction now projects to summaries; canonical marker is v3.
Targeted provider/watcher suites: 44 passed; root/app typecheck: zero errors.

Two existing assertions necessarily follow the new representation: the tombstone
now carries its real native ID and an explicit kind (instead of the empty-ID
sentinel); the successful migration asserts literal marker v3 instead of v2.
The literal old-marker fixture and all last-good/rollback assertions remain.

### Incremental implementation

The provider now has internal identity, decode, source-observation, manifest and
projection modules. Metadata discovery uses indexed format probes, session headers,
aggregate heads and compatibility member metadata; it never selects payload data.
Pinned modern event writers avoid message-member scans. Legacy and unverified
writers retain member metadata comparison. Changed sessions replay complete bodies.

Each successful cursor stores the local manifest, body attestation, physical source
identity/stamp, schema digest and recovery generation. Any cursor at the current
stamp can explain a normal store observation; it does not acknowledge failed
siblings. An unexplained physical write schedules per-session reconciliation;
equal bodies update only cursors, while changed bodies replace their session.
A monotonically increasing recovery generation carried by successful unit cursors
keeps failed reconciliation units pending across partial commits and restart.
No shared checkpoint or fake canonical session was needed. Related children replay
when a parent can be retracted, preserving links removed by destination cascades.

Read-only WAL initialization occurs before sampling the physical files; sampling
then brackets the SQLite snapshot. Parse checks the discovered manifest/schema/
physical observation and buffers projection before publishing. Instability uses a
provider-neutral RetryableSourceReadError; both indexers feed it into the existing
bounded inventory retry path, including strict rebuild failures.

The fallback is deliberately conservative: checkpoints, WAL replacement or an
unexplained data-only edit can schedule a full payload reconciliation. Normal
verified head updates in mixed stores do not do so. Metadata is not CDC: out-of-contract SQL edits concealed within the same unobserved interval by another
session's legitimate metadata/head update are not attested. Filesystem timestamp/identity guarantees still apply.
Sorting and indexed metadata probes add their ordinary comparison/lookup costs;
the stated O(A + S + C log N + B_changed) model omits sorting constants and applies
to payload work, not a claim of zero source-page IO or message-level O(delta).

Focused integration: 83 passed (provider, app indexing, service and watcher filter),
root/app typecheck: zero errors. Corrected performance regressions were also run
against commit 27ef497 and failed on actual full payload reads, then passed with
this implementation. The 10x-unrelated-history case reads 5 affected payload rows
per modern update, with zero unchanged payload reads, including cold provider
reconstruction. Final broader verification remains pending.

### Independent review adjustment: observed state and durable pending work

Fresh Standards and Spec reviews reproduced two gaps in the per-session-only
prototype: a failed known update masks a later separate data-only sibling edit;
and a failed forced child replay is forgotten after its parent commits and
cascades the child's relationship away. Successful-cursor recovery generations
alone do not prove which source inventory was previously observed.

Use a provider-private observation cursor, following Hermes' existing recordless
IndexUnit convention (`sessionId: ''`). It stores source identity/schema/stamp,
metadata inventory digest, observation revision, and pending per-session replay or
reconciliation requirements. It asserts **observed**, never **completed**. Session
cursors independently acknowledge required revisions only after successful persist.
This adds no canonical session, SQLite table, or provider-specific indexer branch.

Pending work must be durable **before** a parent replacement can cascade links.
The observation unit runs first. Session units declare an optional generic cursor
prerequisite; the shared per-unit transaction checks the prerequisite cursor before
persisting. If the observation write fails, dependent work cannot commit. Strict
rebuild sees the prerequisite inside its existing outer transaction. This small
IndexUnit extension is necessary to make the already-existing recordless cursor
pattern crash-safe across dependent unit transactions, without an OpenCode-only
orchestration hook or a callback into the destination from provider parsing.

The observation adjustment supersedes the earlier per-session-only prototype
record above. New regressions cover the sequential failed-head/body-edit case,
failed child plus grandchild replay after restart, and a failed observation write
preventing every destructive dependent. Focused suites: 85 passed; root/app
typecheck: zero errors. The source observation is stored before dependent work,
not as a later completion gate; exact cursor prerequisites are checked in the
existing destination transaction. Recordless control units do not start canonical
marker replay or clear last-good session cursors.

Test representation changes are explicit: transcript-count/projection assertions
now select transcript units, while complete-plan lifecycle tests execute control
units too. Last-good cursor comparisons exclude only the separately asserted
observation row, which intentionally records pending work after a parse failure;
all prior transcript rows and per-session cursors remain protected. The stale
rename/restore tombstone plan is rebuilt before successful verification because
its old physical observation is no longer current. No transcript/rollback/token/
identity assertion was weakened.

Actual metadata complexity includes session sorting O(S log S), indexed pre-split
format probes O(S_pre_split log N), and compatibility member enumeration/sorting.
The payload improvement is independent: zero unchanged payload rows, and only
changed-session payloads for verified event writers. The source observation adds
one metadata-only validation snapshot when the observed source or pending work
changes. It does not restore a full-history payload scan on ordinary updates.


### Final recovery and control-cost refinements

Unknown or missing observation formats now allocate a revision above every
validated live-session cursor, rather than resetting to one. The independent
review's revision-two / failed-child regression was red before this correction.
A second recordless proof unit requires the full pending cursor once and emits a
fixed-size digest cursor; session transactions depend on that proof. This avoids
quadratic destination cursor-byte work during large first imports/reconciliations.
The 1,000-session test checks one large pending read, bounded control bytes per
session, successful canonical history and no fake control session.

Focused provider/indexer/service/watcher suites: 87 passed; root/app typecheck:
zero errors. Final full verification and the independent followup reports are
recorded in the delivery section below.

## Delivery verification

Final reviewed product code: `b65cef4305fef9e31ab3fa3ed4b894dca92ee76d`;
subsequent delivery changes contain documentation and trailing-blank-line cleanup
only; runtime logic, app, tests and CI remain unchanged.
Host macOS arm64, Node 22.23.3; pinned upstream versions/SHAs remain those above.

- `npm test`: **975 passed, 0 failed**; root/app typecheck: **0 errors**;
  lint: **0 errors, 9 existing warnings**.
- `npm run test:electron:all`: **7/7 suites**.
- Fresh independent Standards followup: **113 passed, 0 failed**, no remaining
  blockers; Spec followup: **123 passed, 0 failed**, no remaining blockers.
  Both reproduced their original blocker and validated its repair. Standards also
  independently verified interrupted observation/proof/parent commits and proof
  transaction failure; all retries converge without losing child relationships.
- Rebuilt npm CLI tarball: first import, query/raw, tools/reasoning, tokens 19/23,
  same-ms body-only update, message add/delete, stable rebuild identity, missing
  source refusing destructive rebuild, unchanged source-main-file SHA256. Both
  complete official schemas and native shell shapes pass through the packed CLI.
- Rebuilt unsigned macOS app: actual packaged Electron **43.2.0**, embedded Node
  **24.18.0**, ABI **148** loads bundled better-sqlite3, indexes both official
  schemas in the worker, returns six channel DB/WAL hints, and retrieves raw text.
- Real SQLite busy/rollback/unknown-schema and native watcher checks pass: source
  updates without session timestamp changes, deletion, new dotted channel, inode
  replacement and missing-source last-good retention. Closed-source and closed-WAL
  cold-reader probes retain zero unchanged payload reads.
- Source workload: 100 legacy sessions / 2,000 or 20,000 parts read **zero payload
  rows/bytes** on unchanged discovery, instead of 2,100 / 20,100 rows. Metadata cost
  still grows with retained legacy records. Normal modern updates with 10x
  unrelated history read exactly five affected payload rows in both workloads.
- Independent destination-control probe: 100 / 1,000 sessions read the full pending
  list once and fetched 16,420 / 159,820 control cursor bytes, replacing the earlier
  quadratic 662,000 / 61,820,000 bytes. Single-run timings are not a latency SLA.

All data is synthetic or the existing sanitized fixture. Windows/Linux packaging,
network filesystems and later upstream writer versions were not certified. Arbitrary
SQL edits hidden by another legitimate metadata change within the same unobserved
interval are outside the attested writer contract. Checkpoint/rotation and unknown
continuity can intentionally trigger full reconciliation. Raw cursor authentication
may read the requested session's full payload. Source ownership remains read-only,
including normal SQLite WAL/shared-memory coordination.

Node 22.13.0 still fails CLI startup at the pre-existing DSH zstd import, reproduced
on base in the earlier review and again in the final packed CLI; this work verifies
Node 22.23.3 and does not repair or expand the declared runtime floor. Current main
was not merged; final verification applies to this PR's code and the recorded base.

### Merge preparation against current main

Main advanced to `63b041e3cf9e613d7e00ea6eb5b1734a7785d1d4` (#238/#239).
The merge preserves both the DeepSeek atomic publication/retention/replay-required
contract and OpenCode's recordless-control/prerequisite contract. Prerequisites
are checked per item inside the existing atomic batch transaction. Only a batch
containing transcript units schedules canonical replay; source-control cursors
remain ready for dependent units. CI and app-provider tests retain both additions.

Earlier no-main-merge statements and validation totals above describe historical
pre-merge heads. Verification is rerun for this integration; current totals and
merge evidence are recorded in the PR description and session merge report.
