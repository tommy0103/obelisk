# Codex incremental indexing uses cooperative, verified, and snapshot read plans

**Status: proposed.**

**Context.** Codex rollouts normally grow as append-only JSONL files. Replaying the
whole file after each small append makes source I/O and parse work proportional
to session history. The original verified-append work can retain continuation
state while rereading and fingerprinting the completed prefix, but that still
requires `O(N + delta)` source I/O.

A direct offset resume can reduce normal append I/O to `O(delta)`, but it has a
different trust model. File metadata and a saved offset do not prove that an
arbitrary writer did not rewrite the prefix in place. Repair and reconciliation
must therefore retain a path that verifies or rebuilds the source rather than
silently inherit the append-only assumption.

This decision also has persistence consequences. Codex child rollouts may
contribute messages, tool rows, and subagent rows to a shared parent session
projection. A source subsequently classified as a guardian must retract only
that child contribution, not the shared parent projection.

**Decision.** Codex chooses one internal read plan per `IndexUnit` while keeping
the provider adapter interface unchanged. The shared orchestration passes a
provider-neutral read mode through `IndexUnit.meta`; the Codex adapter owns plan
selection, cursor interpretation, and all source-specific invariants.

| Read plan | Preconditions | Source I/O | Semantics |
| --- | --- | ---: | --- |
| `cooperative-append` | Normal read mode; complete v4 checkpoint and continuation state; valid complete-line offset; matching `dev` and inode; monotonic source growth | `O(delta)` | Seek to the suffix and trust Codex's normal append-only writer. Recheck source identity before and after reads. |
| `verified-append` | Strict mode, or cooperative is unavailable; a bounded completed-prefix fingerprint and continuation state validate | `O(N + delta)` | Reread/hash the prefix before projecting the suffix. |
| `snapshot` | Fresh, legacy, or incomplete cursor; replacement/truncation; failed offset/identity/fingerprint gate; cross-boundary dedup ambiguity; guardian invalidation; or a read-time validation failure | `O(N)` | Rebuild canonical, deduplication, and continuation state from the source. |

`normal` is the ordinary watcher/event-driven indexing mode. `strict` is
verification mode — used by reconciliation and repair, and by any full-inventory
refresh that acts as its caller's reconciliation (the app's periodic
reconcile/repair and the CLI's pre-query refresh and invocation-nonce recovery:
a CLI-only user has no watcher, so that refresh is their reconciliation). It
explicitly disables cooperative append. A full snapshot remains the canonical
truth and repair mechanism; cooperative append is a performance optimization,
not a source-integrity proof.

The v4 cursor stores a complete-line restart boundary (`completeLineOffset` and
`sourceSize`), source identity (`mtime`, `ctime`, `dev`, inode), bounded prefix
hashes, bounded dedup and open-call state, and continuation state for
usage/duration records. A partial tail never advances the checkpoint. Only a
snapshot or verified scan can establish `verifiedPrefix`; a cooperative append
must not claim that its enlarged prefix was verified. Legacy cursor formats
conservatively replay and never qualify for offset resumption.

The parser stages records until source stability has been checked after scanning
and after emitting. A read-time mutation or invalid boundary returns the old
cursor without yielding a mixed projection. A malformed completed JSONL line
fails closed the same way, with one distinction: when a prior checkpoint
exists, the adapter throws so the build's per-unit skipped-file diagnostics
surface the frozen source (the rollback preserves the old cursor); a source
without a checkpoint — a force rebuild or a first sight — stays silent so a
single corrupt archive file cannot block a whole-snapshot rebuild. A same-size
source whose fingerprint just verified (a `cp -p`/`rsync -a` style touch)
refreshes the cursor's stat legs instead of returning a cursor whose signature
can never heal, so one verified pass — not every build — pays the O(N)
fingerprint. Records and the new cursor commit through the existing per-unit
transaction, preserving the at-least-once recovery contract.

`meta.guardian === true` is an explicit source invalidation. It bypasses noop,
cooperative, and verified fast paths, then performs a complete scan and emits a
child-identity retraction. The shared persistence semantics remove rows owned
by that child (`agent_id` or child message UUID) while retaining the parent
session and root/sibling contributions.

**Verification.** The implementation must demonstrate all of the following:

- Direct canonical assembly equals the SQLite round-trip (ADR-0007).
- A final-source snapshot equals prefix snapshot plus either incremental plan,
  including messages, tool calls/results, subagents, usage, and duration fields.
- Legacy cursor, same-mtime rewrite, replacement/truncation, partial and
  malformed tails, read-time mutation, cross-boundary dedup, bounded cursor
  state, and guardian reclassification all fail closed or converge.
- A ctime-only touch heals the cursor signature after one verified pass and
  becomes a no-op; a malformed-line freeze surfaces as a skipped-file
  diagnostic on every incremental build and stays silent on whole-snapshot
  builds; a repaired source resumes indexing and clears the freeze.
- Convergence tests run in CI.
- Cooperative and verified measurements use the same real-rollout append
  workload and report workload size, variation, and remaining costs honestly.

**Consequences.** Callers retain a small interface: watcher/event-driven
indexing asks for normal mode, while repair, reconciliation, and
full-inventory refreshes that act as their caller's reconciliation (the CLI's
pre-query refresh and nonce recovery) ask for strict mode. The Codex adapter
contains the complex selector and recovery rules, preserving locality. Future
providers do not inherit the cooperative assumption; each provider must make
its own source and cursor guarantees. The parse-observability probe
(`CodexParseMetrics`/`CodexParseTestHooks`, optional parameters used only by
tests and benchmarks; production callers pass the two-argument contract) is
likewise deliberately Codex-local: it should be lifted into a provider-neutral
observer on the shared provider contract only when a second provider actually
needs parse observability, with its shape defined from at least two real
consumers rather than extrapolated from Codex alone. The remaining rollout
decision—whether normal-mode cooperative append needs an explicit feature
flag—remains open in RFC issue #172; cold-cache and repeated-sample
performance evidence are also not settled by this ADR.
