# Semantic read-only validation for the query sandbox

**Context.** Issue #107: `sql()` classified statements with a lexical
pre-check — a `SELECT`/`WITH` prefix regex plus a mutation-keyword scan over
the entire SQL text. The keyword scan cannot distinguish executable syntax
from data, so read-only queries were rejected whenever a blocked word appeared
inside a string literal, comment, or quoted identifier
(`SELECT 'live update' AS text`, `substr(replace(text, ...))`, a `CASE WHEN`
label containing the standalone word "replace"). The runtime contract depended
on the wording of data-matching predicates instead of on what SQLite would
execute.

Three structural facts shaped the fix:

- The query runtime always opens the index through `openReadDb()` with
  `{ readOnly: true }`, so the lexical scan never was the mutation boundary —
  it only produced early errors, and it produced wrong ones.
- History shows a single-statement contract is safe: 299 historical `sql()`
  calls contained zero multi-statement single calls, and a replay of all 435
  unique literal SQL strings agents have written on the maintainer's machine
  produced zero regressions on organic queries (PR #110).
- The supported runtime floor (Node 22.13.0) does not offer a uniform
  semantic classifier. `sqlite.constants` exists since v22.13.0 and
  `StatementSync.sourceSQL` since v22.5.0, but `DatabaseSync.setAuthorizer`
  exists only since v24.10.0; better-sqlite3 has no authorizer at all but
  exposes `statement.readonly` and rejects multi-statement prepares natively.
  Two traps were verified empirically: node:sqlite's `prepare` compiles only
  the first statement and silently ignores the tail (so no prepare-time
  mechanism can see a second statement), and returning `SQLITE_IGNORE` for a
  `SQLITE_READ` action silently nulls columns instead of failing.

**Decision.** `sql()`'s read-only contract is enforced in layers, each with a
distinct job (`packages/core/src/query.ts`):

1. **Top-level `SELECT`/`WITH` prefix check (all runtimes).** The cheap entry
   contract. It also keeps statement-level `PRAGMA` out, which matters because
   layer 2 must allow `SQLITE_PRAGMA` actions for pragma table-valued
   functions (`pragma_table_info(...)`) used for schema exploration.
2. **Prepare-time denylist authorizer where the driver exposes it**
   (node:sqlite ≥24.10). DML, DDL, `ATTACH`/`DETACH`, and `SAVEPOINT` action
   codes return `SQLITE_DENY`; everything else — recursive CTEs
   (`SQLITE_RECURSIVE`), FTS shadow-table reads, pragma TVFs, and unknown
   future read actions — is allowed by default. A denylist can never
   false-positive on read syntax the way the keyword scan did, and failing
   open on unknown actions is safe because of layer 4. Only `SQLITE_DENY` is
   ever returned — never `SQLITE_IGNORE`. Authorizer denials surface as the
   stable contract error (`sql() only supports read-only SELECT/WITH
   queries`).
3. **Multi-statement detection via `sourceSQL`** (node:sqlite ≥22.5).
   `stmt.sourceSQL` exposes exactly the compiled first statement; any tail
   beyond whitespace and comments fails with a distinct clear error. Multiple
   independent `sql()` calls per script remain the supported way to run
   several statements.
4. **The read-only connection is the final mutation boundary (all
   runtimes).** Anything layer 2 misses fails at execute time with SQLite's
   own read-only error and the index never mutates. On Node 22.13–24.9 this
   layer is also the write classifier: error-message quality degrades (raw
   `attempt to write a readonly database` instead of the contract message) but
   no write can succeed. The boundary never fails open.

The capability seam in `packages/core/src/sqlite-types.ts` — optional
`SqliteDb.setAuthorizer`, `SqliteStatement.readonly`, and
`SqliteStatement.sourceSQL` — is deliberately reserved. The better-sqlite3
`readonly` branch has no production consumer today (the app never runs
`createQueryApi`), and review flagged it as possible speculative generality.
It stays by maintainer decision: it is three lines completing an
already-shared interface, and it is the only driver-correct classification
for that binding if the app ever executes sandbox queries. This paragraph
records that the reservation is intentional, not an oversight.

This refines ADR 0002's Tier-1 contract. What is frozen is the sandbox
guarantee — `sql()` is read-only and accepts exactly one statement per call —
not the lexical mechanism that used to approximate it. The observable behavior
change (previously rejected read-only queries now succeed) is the purpose of
issue #107.

The performance budget from issue #107 — no more than 1 µs median added
latency per `sql()` call and no more than 10% relative regression on the
representative workload — is gated in `scripts/bench-sql-readonly.mjs` as:
absolute, the workload median of per-shape median deltas; relative, the
workload-aggregate ratio (sum of per-shape median deltas over sum of legacy
medians). Per-shape relative medians were measured to be non-repeatable
(±100 ns of timer noise on a ~2 µs baseline amplifies into ±10% swings, and
identical code was observed at 17.7% / 7.3% / 7.9%), so the issue's "median
relative regression" is operationalized as the aggregate ratio, which averages
that noise over the full workload and directly answers whether the workload
gets materially slower. Per-shape numbers remain printed for transparency.

**Consequences.** Keyword false positives are eliminated structurally, and
read syntax added by future SQLite versions cannot be rejected by omission.
The cost is a fixed ~90 ns per authorizer action crossing, 1–12 crossings per
prepare depending on tables, columns, and FTS shadow tables touched; measured
workload medians are ~0.5–0.7 µs absolute and ~2–3% aggregate-relative, with
FTS-heavy shapes at the budget boundary (~1 µs). Tests are capability-gated:
prepare-time write-rejection assertions require Node ≥24.10, while a
file-backed read-only test proves the final boundary on every supported
runtime. Multi-statement detection depends on node:sqlite's `sourceSQL`
semantics, which the tests pin explicitly.
