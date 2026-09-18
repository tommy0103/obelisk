# DeepSeek provider: session format multi-version support (v0–v3)

**Context.** DeepSeek Harness (dsh) versions its session format with a
monotonic integer carried both in the header line's `version` field and in the
filename generation: `session.jsonl[.zstd]` (v0), `session.vN.jsonl[.zstd]`
(N ≥ 1). v2 shipped in dsh-v0.1.3, v3 in dsh-v0.1.5-alpha.1. The provider was
written against v0: it discovers only the two v0 filenames and its header gate
accepts only `version === 0`. Under DSH ≥ 0.1.3 the adapter therefore discovers
no new sessions at all, and a session write-opened by a newer DSH gains a
higher-generation twin while its old file freezes — the adapter keeps indexing
the frozen file silently (no tombstone fires: the old path still exists).

Upstream guarantees that shape the design (verified against dsh 0.1.6-alpha.2):
the zstd container, directory layout, and every field the projection consumes
(`tool/call`, `tool/result`, `usage`, `subagent/descriptor`,
`request/header.config.model`, `assistant/message.message.content[]`) are
identical from v0 to v3; generations coexist immutably in one session
directory and the canonical one is the numerically highest; the real semantic
deltas are the seed-prefix marker, `surfaceOp` replace, and the
`code`→`ptc` renames. Separately, PTC/code-mode *inner* tool calls are
recorded only as `tool/code-dispatch` / `tool/ptc-dispatch` settle events —
they never get `tool/call`/`tool/result` rows — so every shipped adapter
version has silently lost their content.

**Decision.** The deepseek provider supports format versions 0–3 in one
adapter, following the pi provider's normalize-forward pattern: accept a
version range at the header gate, normalize per version at load time, keep one
projection path.

- **Discovery**: match the upstream canonical basename
  `session(?:.vN)?.jsonl[.zstd]` and keep only the single highest generation
  per session directory, sniffing both compression suffixes. `session.lock`,
  `session.migration.*.tmp`, and `*.<hex>.tmp` entries are ignored everywhere,
  including watcher routing. Highest-generation-only selection is what keeps a
  post-migration twin pair from tripping the divergent-identity guard or
  double-indexing.
- **Version gate**: accept `undefined`, 0, 1, 2, 3; anything newer stays
  fail-closed (skip and record, suppress the project directory — CONTRIBUTING:
  tolerate the unknown, never poison the provider). v1 is physically v0 and
  takes the v0 path.
- **Seed-prefix marker**: v0/v1 keep using `header.seedLength`; v2/v3 drop it,
  so the inherited parent prefix ends at the last `session/end-seed` event
  with `data.inherited === true` (skip `seq <` that event's seq). The resolved
  count is checkpointed per member (`seededPrefix`, optional — cursor state
  stays at version 1 via defensive defaults); on a stale cursor it is
  recomputed from the file head once.
- **`surfaceOp` replace is deliberately NOT applied.** Obelisk indexes the
  append-only log verbatim: shadowed originals stay searchable (finding
  pre-compaction work is the product's purpose), and the replacement row
  projects as an ordinary append — so neither the snapshot path nor the delta
  fast path needs replace handling at all. This is guarded by
  `tests/dsh-context-window-plugin.test.mjs` ("…crash after prune but before
  replacement converges on resume"), which requires pruned/replaced content
  to remain searchable; a shadow-skipping variant was implemented first and
  broke exactly that contract, which is why this point is explicit here.
- **PTC dispatch indexing**: settle events (`tool/ptc-dispatch`, and
  `tool/code-dispatch` for v0–v2) project as one `tool_call` + one
  `tool_result` each, keyed by `subCallId`. They carry no `turn`/`step`, so
  sub-calls anchor to the outer `run_code` call's tool_use anchor via a
  per-member `parentCallId → anchor uuid` map (file order suffices — upstream
  appends `tool/call` before its dispatches; the map is checkpointed for
  fast-path windows, with a deterministic synthetic provisional anchor as the
  miss fallback). Dispatch `arguments` are already-parsed JSON, unlike
  `tool/call`'s JSON string. `*-dispatch-start` carries only timing and is
  skipped.
- **`indexVersionMarker` is bumped** (`__deepseek_canonical_transcript_v4__`):
  dispatch indexing adds records to already-indexed v0 sessions, which only a
  reindex backfills (CONTRIBUTING: bump the marker when already-stored rows
  are affected).
- **Unchanged**: the vendored zstd/chunk-row codecs (container identical
  across versions), tree grouping, identity scheme, two-path parse structure,
  and the fields consumed per event. `system/message` (v3) stays unindexed —
  v0/v2 system prompts were never indexed either; promoting it is a separate
  canonical-model decision.

**Consequences.**

- v0/v1 projection output is unchanged except for the added dispatch records;
  the marker bump reindexes all deepseek trees once.
- A session migrated upstream (v0 → v3 twin) keeps its identity: the member
  path changes, so the unit takes the snapshot fallback under the same
  session id — no tombstone, no duplicate.
- New log-only event types (`assistant/attempt`, `feedback/*`,
  `deliverables/presented`, `workspace/changes`, `image/offload`, …) fall into
  the projection's default branch and are skipped. `workspace/changes` is a
  future file-history data source if product wants it.
- Fixtures must be real DSH ≥ 0.1.5 writer output (CONTRIBUTING verification
  contract), covering: v3 root session, multi-generation directory, v3 seeded
  subagent (end-seed marker), compaction replace, PTC dispatches in both
  spellings, lock/tmp siblings.
- The pre-existing v0 fidelity gaps (image parts, `assistant/message
  .interrupted`) are unchanged by this decision.

Implementation detail: `docs/deepseek-harness-v2-v3-multiversion-adapter-plan.md`.
