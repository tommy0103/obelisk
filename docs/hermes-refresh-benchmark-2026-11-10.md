# Hermes strict CLI and bounded normal refresh — 2026-11-10

Related to [issue #253](https://github.com/tommy0103/obelisk/issues/253).
This replaces the original PR's pipeline-only measurements and withdraws its
O(delta) strict-query claim. The owner selected strict immediate verification and
bounded ordinary refresh; see [ADR-0001](adr/0001-parse-core-and-persist-layers.md).

## Workload and method

- Main: `cc75c2dd1aead4f4374758a7536385307934e177`.
- Repair implementation: `4d26a2244da56880d388e62f13717e121a58dc24`.
- Node 22.23.3, SQLite 3.51.3, macOS Darwin24.4.0, Apple M3 Max,
  16 cores, 128GiB RAM, local temporary files. No cold-OS-cache claim.
- 2500 sessions ×64 messages =160000 initial messages, 9000 content bytes per
  message; source DB 1484644352 bytes (1.485GB decimal). Content is generated;
  full table shape is the checked-in captured Hermes schema32. Ordinary source
  lookup indexes follow pinned upstream Hermescommon. This is actual built CLI
  verification over a realistic generated store, not a user's personal corpus
  or a reproduction of the reporter's Windows/Node26 machine.
- Two independent source/index copies. All other providers disabled. The harness
  invokes actual built `--build`, `--query`, and `--search` processes. CLI wall
  time includes process startup, refresh, invoking-session lookup and query work.
  A recent indexed command record supplies each copy's own invocation path and
  a known search nonce, avoiding the unrelated nonce-miss polling delay.
- Three samples per phase, alternating variant order. Before due-query samples,
  the disposable destination's private `__last_build__` row is removed so main's
  30-second debounce does not skip the work being compared. Immediate repeats
  retain it. Source mutations are real SQLite writes in WAL mode; mixed append
  and same-length target rewrite share one transaction. The target is in the
  final session, outside the first bounded batch. Both versions must return the
  fresh text and actual search match. Checkpoint samples perform a real WAL
  checkpoint without logical changes.
- A separate compiled Core worker measures ordinary `buildIndex` after append;
  these are **not CLI strict measurements**. Its read-only connection wrapper
  only counts actual per-session transcript SELECTs; SQL results and canonical
  persistence are real. Final canonical counts must equal160006 (three strict
  and three normal appends) in each variant. Incomplete refresh warnings fail
  the harness. No production source or index is read or written.

## Results

All query/search freshness and final count assertions passed. Cold CLI build:
main25469.3ms, repair24449.1ms (one sample each, not a variability claim).

| Phase | Main ms: median (min–max) | Repair ms: median (min–max) |
| --- | ---: | ---: |
| Unchanged logical source, due query | 136.5 (130.8–4503.1) | 1874.6 (141.1–2779.7) |
| Immediate repeat query | 108.0 (106.7–118.1) | 133.6 (132.8–137.4) |
| Same-transaction append + hidden edit, query | 2856.3 (2671.0–2873.5) | 2591.4 (2562.3–2638.7) |
| Real search after mixed query | 2637.1 (2545.7–2826.8) | 189.8 (189.8–192.3) |
| Checkpoint-only query | 2627.0 (2614.8–4437.9) | 2520.6 (2465.1–2536.7) |
| Normal API append | 2646.4 (2609.2–2727.1) | 244.7 (235.6–323.0) |

Normal payload SELECT counts: main2500/2500/2500; repair64/65/65.
Normal median work is10.8× faster (about90.8% less time), while preserving a
persisted audit rather than indefinitely ignoring hidden edits. The fresh-work
budget is64 sessions, plus identified changes and failed-commit retries; it is
not a bytes or hard latency limit for an unusually large session.

The unchanged-logical-source phase includes journal/gate certification
transitions and has large variance. It is not a pure idle fast-path benchmark;
no idle speedup follows from its median. Immediate repeat medians are108ms
(main) and134ms (repair). Strict same-commit correctness costs roughly2.6s on
this machine. A checkpoint-only physical change still costs roughly2.5s. These
remaining full-verification costs are deliberate and must not be described as
O(delta). Search after an already verified mixed query costs about190ms in the
repair, versus main's repeated verification. Three warm samples do not establish
production p95 or cross-platform speed.

## Correctness and verification

Final implementation Node22 suite:1337 passed,0 failed,0 skipped. Root+App
TypeScript checks:0 errors. ESLint:0 errors,10 pre-existing warnings outside
changed files. The Hermes file runs in the CI Node22 matrix, and Linux runs the
complete repository suite. There is no App source change.

The original same-commit sibling-edit assertion is restored verbatim. Replacing
only the repaired provider with original PR254's provider makes it fail because
only the appended session is scheduled; the rewritten sibling is missing. New
coverage exercises >64-session strict/normal paths, continuous writes, persisted
restart progress, deadline fallback, failed acknowledgement prerequisites,
legacy/malformed control state and a repeated existing production reconcile
timer without new filesystem events. A real built CLI regression verifies query
and search inside the30-second recent-build window without clearing its marker.

Normal pending work expires after60s, but full verification runs at the next
refresh. The existing healthy desktop timer reconciles every5min, so the bound
includes the next timer tick and processing time; offline repair waits for the
next invocation. Continuous writes do not reset progress or the pending deadline.

[Raw samples and machine metadata](hermes-refresh-benchmark-2026-11-10.json).
Fresh-session adapter review and any additional native-binding evidence are
recorded in the PR verification section.

## Reproduce

Build both main and repair under Node22 (`npm ci`, `npm run build:cli`), then:

```sh
npm run bench:hermes -- --baseline /absolute/path/to/main-checkout \
  --sessions 2500 --messages-per-session 64 --content-bytes 9000 --runs 3 \
  --output /tmp/hermes-cli-results.json
```

Small smoke run: use `--sessions 8 --messages-per-session 4 --content-bytes 512
--runs 1`. Run the benchmark after builds/tests finish; rebuilding CLI concurrently
removes the built entry point and invalidates the measurement.
