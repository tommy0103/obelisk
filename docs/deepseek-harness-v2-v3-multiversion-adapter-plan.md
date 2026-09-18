# DeepSeek Harness session format v0–v3 multi-version adapter plan

Status: implemented (ADR-0014, PR #182). Supersedes the v0-only assumption documented in
`docs/deepseek-harness-0.1.2-alpha.4-obelisk-dsh-adapter-impact-research.md`.

## Background

DSH versions its session format with a monotonic integer that appears both as the
header line's `version` field and as the filename generation:

| Version | Filename | Shipped in | Key traits |
| --- | --- | --- | --- |
| v0 | `session.jsonl[.zstd]` | ≤ dsh-v0.1.2 | packed chunk rows, header `seedLength` |
| v1 | `session.v1.jsonl[.zstd]` | never tagged | physically identical to v0, header `version: 1` |
| v2 | `session.v2.jsonl[.zstd]` | dsh-v0.1.3 | packed rows removed, `data.stream` embedded in `assistant/message`, header `isSeeded`, optional `surfaceOp` |
| v3 | `session.v3.jsonl[.zstd]` | dsh-v0.1.5-alpha.1 | `system/message` events, `surfaceOp` required with `startSeq`/`endSeq`, `code`→`ptc` renames |

Facts that shape the design (verified against the DSH repo, current checkout
0.1.6-alpha.2):

- **Container is unchanged across all versions.** Concatenated checksummed zstd
  frames, header alone in frame 0, torn final frame tolerated. The vendored
  `packages/core/src/vendor/dsh-zstd.ts` needs no change.
- **Generations coexist.** DSH never rewrites old files; write-open migrates by
  publishing `session.v<N+1>.*` next to the untouched source. Canonical selection
  is "highest numeric version in the directory"
  (`session-persistence-jsonl/src/index.ts:1368-1405`).
- **Layout is unchanged**: `<root>/<projectDir>/<sessionId>/…`; extra entries to
  ignore: `session.lock`, `session.migration.<hex>…tmp`, `<name>.<hex>.tmp`.
- **The fields the adapter consumes are stable across versions**: `tool/call`
  `{turn, step, callId, name, arguments}`, `tool/result`
  `{message.source.callId, message.content[], error}`, `usage` shape,
  `subagent/descriptor` payload, `request/header.data.header.config.model`, and
  `assistant/message.data.message.content[]` (v2's embedded `data.stream` is
  purely additional and can stay ignored, exactly like v0's packed rows).
- **Two semantic breaks need real handling**: the seed-prefix marker and PTC
  dispatch events (work items 3 and 5). `surfaceOp` replace turned out to need
  a deliberate non-decision — see work item 4.
- The `code`→`ptc` renames matter precisely for the dispatch events
  (`tool/code-dispatch*` → `tool/ptc-dispatch*`, message-source plugin
  `tools-code-mode` → `tools-ptc`): once we index dispatch content (work item
  5), both spellings must be matched — v0–v2 logs use `code`, native/migrated
  v3 logs use `ptc`. The remaining renames (`agentPreset` `code`→`ptc`) touch
  fields the adapter never consumes — no-op. `assistant/attempt` (v2+,
  log-only) and unknown new event types fall into the existing `default:`
  branch — safe.

The pattern to follow is the pi adapter (`packages/core/src/providers/pi.ts`):
accept a version range at the header gate, normalize forward per version at load
time, keep one projection path, fail closed on anything newer.

## Goals / non-goals

Goals: one adapter reads v0, v1, v2, and v3 files, chosen per file; a session
migrated upstream (v0 → v3 twin) keeps its identity and continues indexing from
the new generation; PTC/code-mode inner tool calls are indexed for all
versions (closing a gap that already exists for v0).

Non-goals: system-prompt extraction (`system/message` stays unindexed, matching
today's v0/v2 behavior); image-block extraction; vendored codec updates.

## Work items

### 1. Discovery: versioned filenames + highest-generation selection

`packages/core/src/providers/deepseek.ts`:

- Replace `SESSION_FILENAMES` probing in `collectSessionFiles` (current
  `deepseek.ts:324-363`) with the upstream canonical basename rule
  `/^session(?:\.v([1-9][0-9]*))?\.jsonl$/` plus optional `.zstd`, sniffing both
  compression suffixes per file (upstream makes mixed suffixes an error; an
  external reader should tolerate). Per session directory, keep only the single
  highest numeric generation. This both finds v2/v3 files and prevents the
  post-migration twin from tripping the divergent-identity guard
  (`deepseek.ts:516-545`) or double-indexing.
- Explicitly ignore `session.lock`, `session.migration.*.tmp`, and
  `*.<12-hex>.tmp` basenames in `splitChangedPaths` (`deepseek.ts:382-407`):
  they must neither route to a file nor escalate to reconcile-all (the lock file
  is touched on every write).
- `findSessionFile` and `raw()` inherit the selection rule for free through
  `collectSessionFiles`.

### 2. Version gate

Widen the gate at `deepseek.ts:492` from `version !== 0` to accepting
`undefined` (legacy), 0, 1, 2, 3. Keep fail-closed ("skip and record", project
directory suppressed) for anything ≥ 4. v1 files take the v0 path (packed rows
skipped, `seedLength` honored).

### 3. Seed-prefix marker for v2/v3 (the silent-corruption fix)

v0/v1 mark the inherited parent prefix with `header.seedLength`; v2/v3 drop it.
The v2/v3 rule: skip events with `seq <` the seq of the **last
`session/end-seed` event whose `data.inherited === true`**; the marker itself is
child-owned (DSH `session-format-v1-to-v2/src/codec.ts:114-127`).

- Compute the inherited count per member:
  - v0/v1: `header.seedLength` (today's logic at `deepseek.ts:1000-1007`).
  - v2/v3, snapshot path (`fromCount === 0`): scan the decoded records for the
    marker.
  - v2/v3, fast path: the marker is almost always in an earlier frame window, so
    persist the resolved count in the cursor checkpoint as an optional
    `seededPrefix` facet on the member's own record. (During implementation the
    cursor consolidated from six parallel path-keyed maps into per-member
    `MemberState` records, `CURSOR_STATE_VERSION` 1 → 2 — see the ADR revision;
    the v1 shape decodes as null and self-heals via snapshot fallback.) When
    the facet is absent, recompute by decoding from frame 0 until the marker is
    found; the seed prefix is small and this happens once per member.
- Unseeded v2/v3 sessions have no marker → inherited count 0. No header
  `isSeeded` validation needed beyond "marker present ⇒ honor it".

### 4. `surfaceOp` replace semantics — deliberately not applied (revised during implementation)

v2/v3 producers (compaction, tool-result pruner, v3 system-prompt head
replacement) emit `{op:'replace', start/end}` (v2) or
`{op:'replace', startSeq, endSeq}` (v3) on the four surface types. The initial
draft of this plan proposed skipping shadowed seqs to avoid double-counting.
**Implementation evidence reversed that decision**: Obelisk's context-window
plugin flow (a persisted prune followed by a resume-time replacement message)
requires pruned/replaced content to remain searchable —
`tests/dsh-context-window-plugin.test.mjs` ("a persisted crash after prune but
before replacement converges on resume") fails the moment shadowed rows are
dropped. Obelisk is a history-retrieval tool: it indexes the append-only log
verbatim, so a replace row projects as an ordinary append and no shadow set,
fast-path guard, or endpoint-name normalization is needed. v0 behavior is
unchanged by construction.

### 5. PTC / code-mode dispatch events (index the inner tool calls)

`tool/code-dispatch` (v0–v2) / `tool/ptc-dispatch` (v3) settle events are the
**only durable record** of code-mode inner tool calls — inner calls never get
`tool/call`/`tool/result` events; the outer `run_code` result carries only the
curated program output (DSH `packages/core/tools/src/ptc.ts:579-611`, design
note at `ptc.ts:1-7`). DSH's own chat UI renders dispatches as first-class tool
calls grouped under the outer call; our adapter must do the same or lose every
inner call's name, arguments, and result content. This gap already exists for
v0 — dispatch events predate v1 — so this item is version-independent and
improves v0 indexing too.

Projection per settle event (one record = complete tool_call + tool_result):

- Match both spellings: `tool/ptc-dispatch` and `tool/code-dispatch`.
- `tool_call`: `id = callId(dbId, data.subCallId)`, `name = data.name`,
  `input_json = truncJson(data.arguments)` — note `arguments` is already a
  parsed JSON value here, **not** the JSON string `tool/call` carries, so skip
  `parseToolArguments`. `file_path` via `dshToolFilePath` as usual.
- `tool_result`: `tool_use_id = callId(dbId, data.subCallId)`,
  `content = toolResultContent(data.content)`, `is_error` from `data.isError`
  or presence of `data.error` (`error` was only added 2026-09-12 — older
  settle events rely on `isError` alone).
- **Anchor (`message_uuid`)**: dispatch events carry no `turn`/`step`, so the
  existing `t<turn>:s<step>:tool_use` anchor scheme does not apply. Attach
  sub-calls to the outer `run_code` call's anchor: keep a per-member map
  `parentCallId → anchor uuid`, populated by the existing `tool/call` branch
  (upstream appends `tool/call` before any dispatch, so file order suffices),
  and checkpoint it in the cursor (same pattern as `anchorSteps`) so fast-path
  windows after the outer call still resolve. On a map miss (e.g. cursor from
  an older build), mint a deterministic synthetic anchor
  `${dbId}:ptc:${encodeURIComponent(parentCallId)}` and emit a provisional
  `tool_use` message with it (idempotent across windows, same pattern as the
  existing provisional anchors at `deepseek.ts:1164-1174`).
- `tool/ptc-dispatch-start` adds only start timing — skip (both spellings).
- Caveat accepted: `content` may be spill-truncated to a preview + locator by
  DSH's spill policy; index what is on disk.

### 6. What deliberately does not change

- Vendored `dsh-zstd.ts` / `dsh-chunk-rows.ts` (container identical).
- Tree grouping, identity scheme, cursor fast-path gates — `headerHashOf`
  already includes `version` (`deepseek.ts:803`), and a migration changes the
  member path, so an upstream-migrated session naturally takes the snapshot
  fallback under the same identity (no tombstone, `jsonl_path` updates).
- `session/title`, `subagent/descriptor`, usage, tool linkage: unchanged.
- `indexVersionMarker`: **bumped** (e.g. to
  `__deepseek_canonical_transcript_v4__`). Dispatch indexing adds records to
  already-indexed v0 sessions, which only a reindex can backfill.

### 7. Tests and fixtures

- New fixtures under `tests/fixtures/deepseek/`, generated with the real DSH
  0.1.6 writer (script lives in `tmp/`, artifacts committed):
  - a v3 root session (with `system/message`, dense seq);
  - a multi-generation directory — shipped as `session.v2.jsonl` +
    `session.v3.jsonl` (frozen v2 codec + the real write-open migration; a
    v0 artifact cannot be produced by the current writer stack): only v3 is
    read, identity preserved, no divergent suppression, including when the
    v2 generation was already indexed;
  - a v3 seeded subagent (end-seed marker) → inherited prefix skipped;
  - a v3 session with compaction replace → shadowed originals AND the
    replacement stay indexed (verbatim-log semantics, item 4);
  - a v3 session with a `run_code` PTC block → inner dispatches indexed as
    tool_call/tool_result under the outer call's anchor;
  - v2 fixture (optional but cheap: covers `start`/`end` naming and the
    `tool/code-dispatch` spelling);
  - a directory containing `session.lock` and `*.tmp` files → ignored.
- Extend `tests/deepseek-tree.test.mjs`:
  - version gate accepts 0–3, rejects 4 (fail closed, project suppressed);
  - highest-generation selection and watcher routing for `session.v3.*`;
  - a replace landing in a new window stays on the fast path (delta, no
    retraction);
  - dispatch projection: both spellings, missing `error` field (pre-2026-09-12
    shape), historical `:code:` subCallId scheme, anchor resolution across a
    checkpoint boundary;
  - cursor round-trip of the new `seededPrefix` and parent-callId map fields.
- Update the layout comment at `deepseek.ts:10-12` and the stale test-file
  reference in `packages/core/src/vendor/README.md:47`.

### 8. Verification

- Root scripts per `CONTRIBUTING.md` verification contract: unit tests
  (`tests/deepseek-*.test.mjs`), typecheck, lint.
- Manual validation against live data: point `DSH_HOME` at a real
  `~/.dsh` written by DSH ≥ 0.1.5 and confirm v3 sessions index, migrated
  sessions continue (no tombstone, no duplicates), dispatch content is
  searchable, and v0 fixtures otherwise produce byte-identical projections.

## Risks / open decisions

- **`system/message` indexing**: plan skips it (parity with v0/v2). If product
  later wants system prompts searchable, that is a separate canonical-model
  decision, not part of this change.
- **`sourceEventSeqs` / replace endpoint naming**: moot — replace semantics
  are not applied (work item 4).
- **v1 files in the wild**: never shipped in a tagged release; supporting them
  costs nothing (v0 path) and avoids a fail-closed surprise on dev machines.
- **Spill-truncated dispatch content**: oversized inner-call results may be
  previews with a locator. Indexing the preview matches how we treat other
  truncated content; resolving locators is out of scope.
