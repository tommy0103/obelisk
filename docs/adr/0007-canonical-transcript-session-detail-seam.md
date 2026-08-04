# Canonical transcript records are the session-detail seam

**Context.** Provider adapters originally emitted database-shaped records, while
the desktop app reconstructed presentation semantics after querying SQLite.
Although that reconstruction had no explicit provider switch, it still inferred
metadata from raw message text. As more providers are added, those heuristics
would make provider semantics leak into a shared presentation module and allow
the direct parse path to drift from the persisted path.

**Decision.** Every provider adapter emits a canonical `TranscriptRecord`
stream. The adapter owns all source-specific interpretation: duplicate raw
events, stable identities, tool relationships, message classification, and
visibility. Messages and summaries carry provider-normalized visibility.
`visibility` is separate from `is_meta`. `visible` is current evidence.
`inactive` is physical evidence that the provider explicitly attests was
superseded; default queries omit it, and supported helpers may return it only
with `includeInactive: true`. `hidden` is display-suppressed or transport-only
material and no standard helper returns it. Session detail and the desktop app
remain visible-only, while visible system evidence can remain a metadata card.
Presentation-sensitive concepts are explicit canonical fields: tool calls carry
a presentation class, Skill instructions carry a content type, and workflows
carry their parent tool-call identity. Summaries carry normalized input/output
usage when their provider performed a separate model call; cached input is
folded into input usage by the provider, as it is for messages. Visibility does
not erase accounting: aggregate usage includes model calls that were later
abandoned.

Only a provider with an explicit source-level supersession signal may emit
`inactive`. Tree shape alone is insufficient; providers without that signal
leave their evidence visible.

The Core `assembleSessionDetail(input)` module is the only session-detail seam.
It accepts either a provider's complete transcript stream from a fresh parse
(`cursor = null`) or table-shaped rows after a persistence round-trip. A delta
parse cannot produce a complete detail snapshot without prior state, so the
assembler rejects a `SessionRecord` whose `countMode` is `delta`; incremental UI
updates use the existing snapshot/patch seam. Its internal row adapter restores
the canonical record language before assembly. The implementation may sort,
group thinking, and attach tool results, subagents, and workflows, but it never
checks the provider and never parses message text to recover provider semantics.
Tool names are likewise display data, not assembly control flow.

The persist layer only serializes transcript records and cursor state. SQLite is
not the source of transcript semantics, and a persistence round-trip must not
change the assembled result.

**Consequences.** A new provider is complete only when its canonical transcript
can pass directly through `assembleSessionDetail`. Provider conformance tests
cover that seam, while persistence tests verify that canonical classification
survives a database round-trip. Codex-owned normalization now classifies hidden
context envelopes and structurally removes image wrappers before duplicate
reconciliation. Adding another provider does not add branches to the app's
session-detail code.
