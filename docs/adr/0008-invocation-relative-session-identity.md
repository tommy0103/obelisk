# Invocation-relative session identity via nonce self-search

**Context.** Obelisk deliberately refreshes its index before each query, so the
session invoking that query is indexed and returned beside genuine historical
sessions with identical shape (#45). Agents then miscount their own live
session as independent evidence. The obvious identity channels all fail: the
agent (the LLM) does not know its own session id, so skill instructions cannot
have it pass one; provider runtimes cannot be modified by this project; and
several agents may query concurrently, so "current" must mean *the session
invoking this retrieval*, never "every recently active session".

Two facts opened a better channel. First, the CLI runs as a descendant of the
agent runtime, and every provider flushes the tool-call record to its
transcript **before the tool finishes executing** — verified for Kimi Code
(live `wire.jsonl` inspection), Claude Code (`tool_use`/`tool_result`
timestamp deltas), Codex (rollout `function_call` vs `function_call_output`
deltas), and Pi (source: `agent-loop.ts` persists `message_end` via
synchronous `appendFileSync` before `executeToolCalls`). Second, the pre-query
refresh therefore indexes the CLI's own invocation record before the resolver
runs.

**Decision.** Identify the invoking session by **nonce self-search**, with no
agent cooperation and no provider changes.

- The CLI carries a per-invocation unique nonce in its own argv: the as-typed
  query file path for `--query` (skill docs prescribe unique temp names), and
  an explicit `--nonce <token>` for `--search` (never part of the FTS text).
  Skill docs use `mktemp`/`uuidgen` with shell-builtin fallbacks.
- `resolveInvokingSessionId` searches the freshly refreshed index for the
  nonce: FTS over message text, plus a LIKE over `tool_calls.input_json` for
  providers that record tool input separately. Both legs are bounded by a
  15-minute recency window (`INVOCATION_RECENCY_MS`) — the invoking record is
  always written "now" — which keeps the scan off the full `tool_calls` table
  and keeps weeks-old fixed-path reuse out of the candidate set. A
  `messages(timestamp)` index (`idx_messages_time`) plus a `CROSS JOIN`
  planner hint keep the bounded scan index-driven.
- Multi-match resolution is **newest-wins**: matches far apart in time are
  unrelated history, not ambiguity. Only when the two newest matching records
  (necessarily different sessions) fall within `INVOCATION_COLLISION_MS`
  (10 s) is it a genuine concurrent collision. Zero matches, a collision, or
  an unparseable timestamp resolve to **honest null** — nothing is marked.
  Newest-wins also absorbs the false-poisoning case where another session
  merely quotes the command in text: the quote is older than the real
  execution and loses.
- Resolved identity is annotation, not filtering: `search()` hit sessions and
  `sessions()` rows gain `is_invoking: true` (omitted otherwise), and
  `overview().current.session_id` exposes the id (null when unresolved).
  Ordinary query semantics are unchanged.
- Freshness recovery (`resolveInvokingSessionIdWithWait`): on a first miss,
  run one incremental build (`ignoreRecentBuild`, never the force
  full-republish path) — allowed under a fresh daemon heartbeat via the narrow
  ADR-0006 carve-out (`ignoreDaemonOwnership`) — then poll freshly opened
  read snapshots (~300 ms, ~4 s cap) as the lease-contention fallback. Still
  unresolved is honest null. Queries without a nonce or with an immediate hit
  pay zero added latency.

Rejected alternatives: agent-supplied session id (the agent does not know it);
an explicit env/flag override channel (deferred — real need only for MCP
transports and tests, and it must never be documented for agents to fill in);
ancestor-pid registry lookup (only Claude Code ships a pid→session registry
today; remains a possible future optimization, not a second mechanism);
scanning transcript files directly (duplicates provider path knowledge and
file→session mapping in the resolver); classifying recently active sessions
as current (violates the meaning of "current").

**Verification.** Flush-timing evidence per provider as above. Dedicated
suite `tests/invoking-session.test.mjs` covers resolution via both legs,
missing/unknown nonces, newest-wins vs collision epsilon vs
quote-loses-execution, the recency boundary, incremental-vs-force recovery
builds, the daemon-heartbeat carve-out, the legacy-schema gate, and the
writer-busy poll fallback, plus CLI end-to-end runs. Live smoke on a
daemon-owning machine resolves the invoking session correctly. The schema
canary in `provider-schema-stability.test.mjs` records the additive index as
an explicit decision.

**Consequences.** The retrieval contract gains invocation-relative identity
without changing result sets. Agents must treat an `is_invoking` session as
their own current context, not corroborating evidence. Non-unique invocation
signatures degrade safely: worst case is a concurrent-collision null, never a
mis-mark. #17's `excludeSession` composes on top once the invoking id is
known. If an MCP transport is added, it will need an explicit identity
channel (the deferred override), since a long-lived server shares no fresh
process ancestry with each caller.
