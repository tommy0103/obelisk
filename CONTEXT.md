# Obelisk

Obelisk is explicit memory infrastructure for coding agents: it indexes local
Claude Code, Codex, Kimi Code, and Pi sessions into a queryable SQLite evidence layer, and a
CodeAct runtime lets an agent write a small query, run it, and answer from real
session history. This glossary pins the terms that are specific to Obelisk; it is
not a spec.

## Runtime interface

**Runtime interface**:
The public contract, expressed as four verbs — `build`, `search(text)`,
`query(code)`, `attune(code)`. CLI and a future MCP server are transports over
this same shape; neither adds its own retrieval surface. The agent skill is
docs-only guidance that invokes the CLI rather than a transport of its own.
_Avoid_: API, tool surface

**CodeAct**:
The interaction style where an agent writes JavaScript that runs inside the
`query(code)` sandbox and returns JSON, rather than calling many fine-grained
tools. This is Obelisk's core design choice.
_Avoid_: tool-calling, function-calling

**Helper**:
A convenience accessor available only inside the `query(code)` sandbox
(`overview`, `search`, `context`, `sql`, `memories`, …). Helpers are never
promoted to an external tool surface.

## Indexing

**Provider adapter**:
A pure per-source module (claude, codex, kimi, pi, …) that owns its
descriptor, watch roots, discovery, parsing, cursor interpretation, and raw
record lookup. It discovers `IndexUnit`s rather than assuming one transcript
file per unit; Kimi uses a session directory containing multiple wire logs. It
never opens or writes a database; adding a source means adding one adapter and
registering it. The shared pure
parse/discover helpers live in `packages/core/src/parsing.ts`, which imports only
node:fs/path/os — deliberately node:sqlite-free so the compiled providers can be
consumed by the app (whose Electron runtime has no `node:sqlite`).
_Avoid_: parse core, parser, ingest

**Transcript record**:
One provider-normalized fact (session, message, tool call, tool result, summary,
subagent, workflow, …) in the canonical transcript language. Provider adapters
resolve source-specific deduplication, visibility, and identity before emitting
it. The persist layer serializes transcript records; the session detail
assembler can consume the same stream directly.
_Avoid_: database row, raw event

**Session detail assembler**:
The provider-independent module that projects canonical transcript records into
the timeline shape used by the app. It may consume records directly from a
provider adapter's fresh full parse or after a SQLite round-trip. Provider deltas
require prior state and are handled by the snapshot/patch seam instead. It never
branches on provider and never infers provider semantics from message text.

**Persist layer**:
The single shared, provider- and binding-agnostic writer that consumes transcript records
from any adapter and writes them into an injected SQLite handle inside a
transaction. The binding is injected — `node:sqlite` (CLI) or
`better-sqlite3` (app) — so there is one persist implementation, not one per
binding.
_Avoid_: writer, sink, DAO

**Daemon indexing mode**:
Continuous incremental indexing driven by a long-lived process (the desktop app,
later a CLI daemon) that watches transcript directories and keeps the index fresh
as files change.
_Avoid_: watcher mode, live indexing

**Passive pull mode**:
On-demand incremental indexing performed by a CLI invocation when there is no
active daemon: the command brings the index up to date, then answers.
_Avoid_: lazy indexing, on-read indexing

**index_state**:
The bookkeeping table shared by both indexing modes. It stores the adapter's
numeric cursor pair in the existing `mtime` and `lines_processed` columns (a
file adapter can use mtime + line offset; Kimi uses aggregate max-mtime + total
lines), plus heartbeat/last-build markers used for daemon arbitration.

**Daemon arbitration**:
The policy by which the passive pull mode detects a fresh daemon from the
`__app_heartbeat__` marker and skips every CLI-side mutation, including schema
setup, indexing, checkpointing, and `attune`. The heartbeat alone means “the
daemon should write”; `__app_last_successful_build__` records coverage/freshness,
not ownership. Both indexing modes use the same persist layer.

**Writer lease**:
The hard cross-process safety mutex behind daemon arbitration. A writer holds
`BEGIN IMMEDIATE` on `.obelisk/writer.lock.sqlite` for the complete mutation;
manual rebuild holds it through build, target-database replacement, and reopen.
The heartbeat expresses policy, while the writer lease prevents overlapping
writes during races, stale heartbeats, or processes from different versions.

## Memory

**Queryable session memory**:
The evidence layer — real sessions, messages, tool calls, subagents, workflows —
that an agent queries on demand. Obelisk deliberately does this instead of
implicit/ambient memory.
_Avoid_: implicit memory, ambient memory, auto-recall

**Approved durable memory**:
Human-approved conclusions persisted as markdown plus a registry record, via
`attune(code)` calling `remember()`/`forget()`. Auditable and revocable.
_Avoid_: long-term memory, vector memory
