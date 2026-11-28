# MiniMax Code (`minimax`) Provider Adapter Design Spec

This document specifies the `minimax` provider adapter (`packages/core/src/providers/minimax.ts`) for MiniMax Code (`mcode` / `mavis` v2) session transcripts (Issue #190).

## 1. Storage Layout & Root Resolution

- **Root precedence** (`defaultMinimaxRoot`):
  1. Explicit `rootDir` argument (settings override)
  2. `MINIMAX_DATA_DIR` environment variable
  3. `MAVIS_DATA_DIR` environment variable
  4. `~/.minimax`
  - All overrides expand `~` and resolve via `path.resolve(...)`; persisted settings reject relative paths in `provider-settings.ts`.
- **Session directories**: `<root>/v2/sessions/YYYY/MM/DD/<sessionDir>/` containing:
  - `manifest.json` (`schemaVersion: 1`, `sessionId`, `createdAtMs`, `updatedAtMs`)
  - `messages.jsonl` (active generation JSONL transcript)
  - Optional `snapshots/gNNNNNNNNNNNN--<compactionId>.jsonl` (historical generations before compaction)
- **SQLite metadata store**: `<root>/v2/sqlite/runtime-state.sqlite` (`local_runtime_sessions` table, WAL mode).
- **Watch targets**: tree watch on `<root>/v2/sessions` (`manifest.json`, `messages.jsonl`) plus file watches on `runtime-state.sqlite` and `runtime-state.sqlite-wal`.

## 2. Identity, Deduplication & Filtering

- **Canonical session ID**: `minimax:<encodeURIComponent(rawSessionId)>`.
- **Unit key**: `dirname(normalize(jsonlPath))` (the winning session directory).
- **Duplicate `sessionId` disambiguation**: prefers the directory matching SQLite `history_relative_dir`, then highest `mtimeNs`, then canonical UTC directory layout, then lexical path.
- **Cross-directory replacement**: when the winning directory for an already-indexed `sessionId` changes, `discover()` flags `replaceExisting: true` so `parse()` ignores any stale cursor and emits `delete-session` before replaying.
- **Session filtering & `started_by`**:
  - Excludes internal `session_kind === 'peek'`, `session_kind === 'cron'`, and non-`task` sessions with `visibility === 'hidden'`.
  - Indexes `session_kind === 'task'` even when `visibility === 'hidden'`, setting `started_by = 'agent'`.
  - All other sessions (including no-SQLite sessions and archived human `conversation` rows carrying `parent_session_id`) have `started_by = null`.

## 3. SQLite Read Semantics (Fail-Closed When Present)

- If `runtime-state.sqlite` does not exist (`ENOENT`), discovery proceeds without SQLite enrichment (`started_by = null`, derived title).
- If `runtime-state.sqlite` exists as a non-regular file/symlink, is missing the `local_runtime_sessions` schema (`0`-byte or uninitialized DB), or fails to open/query (`EACCES`, `SQLITE_BUSY`, WAL recovery error, corruption), `discover()` reports an inventory issue via `reportIncompleteInventory`, retains all scoped indexed sessions (`retainSession`), and emits zero units so hidden/peek/cron sessions cannot leak and stored titles are not clobbered.
- Legacy SQLite rows (`columnar_version < 3` or missing columnar fields) fall back to `record_json` for metadata and visibility filtering.

## 4. Three-Tier Indexing & Compaction Equivalence

1. **Metadata-only patch**: when `messages.jsonl` is unchanged (`statMatchesCursor` + matching `structuralMetaHash` + `generation`) and only SQLite `title` or `updatedAtMs` advanced, emit one `session` record (`countMode: 'total'`, zero `delete-session`).
2. **Case A (Steady-state append)**: same `dev`/`ino`/`generation`/`structuralMetaHash`, monotonic growth, and matching prefix (`tailHash` in `normal` mode, full SHA-256 `prefixHash` in `strict` mode) append only new complete lines, deduplicating against cursor `seenIdHashes` and emitting `countMode: 'total'` without `delete-session`.
3. **Case C (Safety net)**: compactions (`llm_checkpoint`, `tool_archive`, `tool_trim`), rewinds, directory switches, structural metadata changes, or failed prefix checks emit `delete-session` and replay `resolveReachableFiles()` oldest-to-newest along the `history_artifact.parentSnapshot` chain (first occurrence of each `message_id` wins, preserving un-archived tool outputs).

## 5. Message Projection, `raw()`, and Security Boundaries

- **User canonical text & multimodal blocks**: prefers `genuineUserQueryText` / `canonicalTextRange` (with lone UTF-16 surrogate normalization per ADR-0007) to strip `<system-reminder>` wrappers while preserving sibling `image`, `video`, `audio`, and `file` blocks.
- **Background task notifications & control reminders**: `hostMetadata.backgroundTaskOrigin` / `backgroundTaskOrigin` maps to `is_meta: 1, harness_kind: 'notification'` (preserving full text when `canonicalTextRange` is empty); worktree-fork `timestamp: 0` `<system-reminder>` messages do not pull `started_at` to 1970 and map to `is_meta: 1, harness_kind: 'reminder', visibility: 'hidden'`.
- **Internal custom messages**: `role: 'custom'` maps to `is_meta: 1` with `harness_kind: 'result' | 'reminder' | 'other'` and `display: false` -> `visibility: 'hidden'`.
- **`archonCompaction` v2**: emits `SummaryRecord` only when `summary` is a string; v2 marker-only user envelopes project normally.
- **Symlink & path containment**: `lstatSync` rejects symlinks for `manifest.json`, `messages.jsonl`, `snapshots/*.jsonl`, and `runtime-state.sqlite`; `raw()` verifies both lexical and `realpath` containment within `sessionsDir` and returns `messageText: null` for `toolCall` blocks.
