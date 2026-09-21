---
name: adapter-review
description: Review a provider/agent adapter implementation or PR — transcript discovery, parsing, and indexing for agent hosts (Claude, Codex, Kimi, Pi, DeepSeek Harness, OMP, Copilot, etc.). Use when reviewing an adapter PR, adding a new provider adapter, or checking an adapter against a new upstream version.
---

# Adapter Review

Review along two axes — **Standards** (repo docs, contributing rules, ADRs) and **Spec** (issue /
PR body / upstream behavior) — plus the traps below. Report the axes separately; anything both hit
independently is top priority.

## Principles

- **No blocker without a repro.** Decisive evidence at a pinned commit (minimal fixture driving the
  real provider code, e.g. `sessions=[]` or a wrong count). Re-measure PR-reported test counts,
  benchmarks, and CI status yourself; attribute red tests to environment (missing deps, unbuilt
  packages) before charging them to the PR.
- **Upstream ground truth over assumptions.** Verify every format assumption — file layout, field
  case, version constants, ID generation, env vars, retention — against the host's real source and
  real local data. "Not on my machine" ≠ "doesn't exist" (the upstream repo may have moved); "zero
  rows locally" never justifies skipping a source structure (a later upstream migration silently
  invalidates present-state filtering).
- **Test claims ≠ what tests prove.** Open fixtures behind every "covered" claim: their ordering and
  fields must actually reach the bug (not route around it), and leak no machine paths. Confirm new
  test files actually run in CI where the workflow lists files explicitly. Hunt mocks over
  production paths, circular verification (verifying `discover()` with `discover()`), and test
  comments whose premise primary docs refute. Revert the changed file to confirm new tests fail for
  the right reason.
- **Attribute before grading.** `git show <base>:<file>` each finding: introduced by this PR →
  blocking; pre-existing but amplified → judge the amplification; purely pre-existing → follow-up
  issue, don't block. Withdraw findings whose premises fail upstream/data validation, and say why.
- **Fixes are a new attack surface.** Each round: re-reproduce prior findings on the new head, then
  review the fix code itself — especially new destructive paths. `git range-diff` before merge so
  what lands is byte-identical to what you reviewed.

## Where adapter PRs actually fail

1. **Identity/key asymmetry** — cursor key, session id, unit key derived differently across
   discover / parse / persist / delete. Test fakes are often symmetric exactly where the real
   adapter is not, so green suites hide it. Family-parameterized adapters must keep persisted
   identity byte-identical for existing sources.
2. **Destructive tombstone/retract misfires** — walk four scenarios: whole-directory delete,
   cross-workspace move, concurrent change during enumeration, source unavailable (distinguish
   ENOENT from EACCES). Deletes require complete inventory; changed-paths is a routing hint, never
   deletion evidence. Tombstones must leave a non-null cursor or deletes replay forever.
3. **Migration never converges** — check fresh DB × old-format DB × already-migrated DB against the
   upgrade trigger. Wire-format changes: strict version rejection + self-healing fallback, timed to
   ride an existing full-reindex window. Fields newly written to existing canonical rows: bump the
   version marker, add a backfill test simulating an old DB (old marker as a literal, not the
   constant), and confirm persist-layer null-merge can't drop stored values.
4. **Undeclared behavior change** — split the diff into new capability vs semantic change to
   existing paths; every line of the latter needs a declaration in PR body or commit message.
5. **Fast-path correctness debt** — when the correctness invariant spans a wider scope (tree, cursor
   window) than the optimization assumes (single file). If successive review rounds share one root
   cause, stop patching: escalate to fast-path/correctness-fallback with an equivalence property
   test (fast ≡ full), and quantify the win before accepting the state machine. Keep adversarial
   constructions inside the host's real threat model.
6. **Swallowed errors & state edges** — `existsSync` folding EACCES into ENOENT, try/finally without
   catch, partial state committed on failure; SQL three-valued logic (`NULL != 'x'` filters rows);
   independent flags combined inconsistently.
7. **Failure-mode sweep** — legal intermediate states (header-only file, torn frame), crash residue
   (WAL without shm), Windows semantics (ctime/inode/chmod), symlink/realpath aliases.
8. **New adapters: census the data first** — real-data distribution (row counts, type mix, anomalous
   session classes) surfaces internal-mechanism pollution at design time, not after launch.
9. **Dead contract promises** — for every promise in type comments / ADRs ("setting this retracts
   atomically"), grep all consumers and verify it is kept; a promise with no real consumer is a
   blocking finding.
10. **Sibling drift** — a bug class fixed in one adapter is a sweep of all siblings with the same
    frame; a shared-helper change must not silently move sibling adapters (fail-open/fail-closed
    predicates stay adapter-local unless deliberately shared).
11. **Process hygiene** — verdict every PR/issue claim one by one (Correct/Partial/Incorrect);
    mixed-scope PRs (unrelated work riding along), PR body drifted from the final diff, and wrong
    issue linkage are findings, not chores.
