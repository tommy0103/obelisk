# Hermes pre-query refresh benchmark — 2026-11-07

Measurements for issue
[#253](https://github.com/tommy0103/obelisk/issues/253): `--search` / `--query`
spent tens of seconds in the pre-query refresh on a large Hermes store.

The adapter change makes the strict refresh proportional to the delta: the
watermark pass reads record headers instead of every message body, unchanged
sessions are digested only when the physical store moved without an explained
session change, and the scan that does the work certifies the store for the next
one. See `packages/core/src/providers/hermes.ts`.

## Workload

`scripts/hermes-refresh-benchmark.mjs` builds a synthetic Hermes `state.db`
(WAL mode) in a temp dir and indexes it through the real
`createProviderIndexPlan` / `indexProviderPlan` pipeline into an on-disk SQLite
index. No production data is read or written.

| Parameter | Value |
| --- | --- |
| Sessions | 2,500 |
| Messages | 160,000 (64 per session) |
| Content per message | 9,000 bytes |
| Approx. payload | ~1.4 GB |
| Warm-up | 6 settle scans (break early once a scan plans no units) |
| Idle samples | 3 per run |
| Runs | 3, on each side |

Recorded columns:

- **wall time** — `performance.now()` around discovery + apply for one refresh;
- **payload reads** — executions of the per-session transcript select
  `FROM messages WHERE session_id = ? ORDER BY rowid`, counted through an
  injected `openStore` wrapper. This is the "unchanged source reads zero
  transcript payload rows" metric from
  `docs/opencode-adapter-incremental-plan.md`.

Base is `HEAD` (`1f8205b`) built with `git archive` into a temp dir; both sides
run the same benchmark script. Machine: Linux 7.2 (zen), Node 26 with
`--experimental-sqlite`, local SSD, `synchronous=OFF` for store creation.

## Results

Times in milliseconds. Ranges are the min–max over the 3 runs; a single value
means the spread was under the displayed precision.

| Phase | Base (ms) | Base payload reads | Change (ms) | Change payload reads |
| --- | --- | --- | --- | --- |
| Cold build (sum of settle rounds) | 22,748 – 22,901 | 2,500 (round 1) | 20,946 – 21,579 | 2,500 (round 1) |
| Cold settle round 2 | 633 | 0 | 117 | 0 |
| Idle re-scan | 3.6 – 8.7 | 0 | 3.6 – 8.4 | 0 |
| One-session append | 2,729 – 2,819 | 2,500 | 126 – 142 | 1 |
| Call after the append | 2,710 – 2,778 | 2,499 | 114 – 121 | 0 |
| Unexplained write (`api_content`, non-projected) | 2,728 – 2,818 | 2,500 | 2,262 – 2,293 | 2,500 |
| Call after the unexplained write | 2,710 – 2,778 | 2,500 | 4.1 – 4.3 | 0 |

Payload reads are executions of the per-session transcript select; the cold
round also plans a gate unit (2,501 units on both sides), which reads no
messages and is not a payload read.

Variability: cold-build total varies by ~3 % between runs and is dominated by
the one-time transcript write into the index; the steady-state numbers
(idle, append, confirmations) vary by roughly ±10 %. The unexplained path stays
in the seconds range in both columns — that is the deliberate conservative
reconciliation (exact digest over unchanged sessions), not a leftover of this
change.

## Reading the numbers

- **Idle is unchanged and already cheap.** Both sides skip the store on an
  identical gate; ~4 ms is the index-state lookup, not a store scan.
- **One-session append: 2,500 → 1 payload read, ~2.8 s → ~0.13 s.** The base
  fingerprinted every session with `SUM(LENGTH(...))` over the text blobs, so
  any write re-read the whole store twice (once to discover, once because the
  gate row was withheld and the next call repeated the pass). The change counts
  non-NULL projected columns — SQLite answers those from the record header —
  and certifies the store in the same scan, so the following call costs one
  header-only pass. The watermark still visits every message row to read its
  header (there is no per-session summary table to consult), which is the
  residual ~0.12 s; what it no longer reads is the ~1.4 GB of body text.
  Dropping `MAX(timestamp)` and `SUM(active)`/`SUM(compacted)` matters for the
  same reason: upstream stores those columns after `content`, so any of them
  drags the body's overflow pages into the scan even when only the value is
  wanted. A cross-check with `/proc/self/io` on a 10,000-row / ~90 MB-text
  store: one explained append read 11.2 MB from the store (discovery plus
  header scan, 1 transcript select), against 93.3 MB with the full aggregate
  set.
- **The append confirmation is not zero-cost by design.** The first call after
  an explained write persists a *partial* gate: it is recorded, so the next
  scan can skip the exact digest, but it is not marked complete, so a session
  that failed to commit cannot leave the store looking certified. The next scan
  re-runs the cheap watermark pass (no payload reads) and promotes the gate to
  complete. That is the 114–121 ms column — still one header scan, not a digest.
  Removing it would require trusting
  the physical gate without proof from the scheduled units; the partial gate
  keeps the retry semantics that withheld the gate before.
- **Unexplained write is intentionally unchanged.** When the physical store
  moved and no session watermark did, the exact digest still runs over every
  unchanged session. That is the accepted cost of detecting non-projected
  in-place changes without a changelog (`docs/opencode-adapter-incremental-plan.md`:
  concurrent arbitrary SQL edits behind a legitimate aggregate write cannot be
  inferred from public metadata). When the digest finds nothing, the *next* call
  settles instead of paying another full pass. When it does schedule a session,
  no gate row is written, so the following call re-examines the store — that is
  what retries a unit that failed to persist. The deferred class is any in-place edit
  of a projected column — body text of any length, or `timestamp`/`active`/`compacted`,
  which the watermark deliberately does not read — that shares a commit with
  another session's explained write; it is reconciled by that session's next
  write, the next unexplained gate move, or `--force`/a rebuild. Owner sign-off
  for this relaxation is required before merge.
- **One-time reparse.** The watermark input includes a version tag and no longer
  carries the three dropped aggregates, so cursors written by the previous code
  mismatch once: the first refresh after the upgrade re-reads each session at
  the cost of a cold-build round 1, then settles in the next cheap pass. No
  migration code; no data is rewritten.

## Residual costs / follow-ups

- A store that moves physically without any logical change (for example a
  checkpoint-only WAL churn) still pays the unexplained-write path. Logical
  certification with a bounded full verify would remove it, but it changes the
  strict-reconcile contract and needs an ADR amendment and owner sign-off; not
  part of this change.
- The core nonce-recovery path can run a second strict build per call
  (`packages/core/src/core.ts`). Unrelated to the Hermes adapter; tracked
  separately if the reporter's agent flow uses `--nonce`.

## Reproduce

```bash
# base commit, then the change
git archive <base> | tar -x -C /tmp/obelisk-base

npm run bench:hermes -- --sessions 2500 --messages 160000 --content-bytes 9000 --runs 3
node --experimental-strip-types --experimental-sqlite \
  scripts/hermes-refresh-benchmark.mjs --sessions 2500 --messages 160000 \
  --content-bytes 9000 --runs 3   # from the base copy

# smaller smoke run
npm run bench:hermes -- --sessions 20 --messages 800 --content-bytes 200 --runs 2
```
