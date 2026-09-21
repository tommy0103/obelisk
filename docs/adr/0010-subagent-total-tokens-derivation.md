# Subagent total tokens: provider-stored wins, query-time derivation fills

**Context.** The `subagents.total_tokens` column predates incremental
providers: codex (full-reparse) stores an authoritative whole-thread aggregate
at persist time. A line/frame-incremental adapter cannot do that — any single
run sees only a slice of the subagent's stream, and persist's upsert merges
columns (`COALESCE`), so a partial sum stored as `total_tokens` would silently
overwrite the complete one and never converge.

The information needed is not lost, though: every sidechain message row already
carries the per-step usage it was indexed with, and those rows are
authoritative regardless of how indexing was sliced.

**Decision.** `total_tokens` is a two-source column with an explicit priority:

- A provider that stores a value (codex) wins. The query layer never
  overwrites or re-derives over a stored value.
- When the stored value is null (deepseek), `subagents()` and `context()`
  derive it at query time as `SUM(input_tokens + output_tokens)` over the
  subagent's sidechain messages. The derivation is null only when no
  usage-bearing message exists; a legitimate zero stays zero. Derivation is a presentation-layer null-fill,
  not a stored aggregate.

**Consequences.** Adding an incremental provider with subagent folding does not
require a persist-layer change or a schema migration. The query contract gains
one documented behavior (null-fill derivation) shared by all providers; any
provider that can compute the authoritative aggregate should keep storing it.
The same rule applies wherever subagent rows are presented, so consumers see
one consistent value.
