# Bounded messages and a smaller default retrieval surface

**Context.** The original context helper follows every indexed parent before
returning an ancestor array; thread returns a complete session. Historical
scripts commonly truncate these arrays only after retrieval. The fixed corpus
contains 29 context scripts: 22 use ancestor tails, one of those also reads the
full count, and nine read session metadata. An ordinary time window changed
seven of twenty successfully replayed script outputs; a bounded parent window
with matching filters and metadata changed only the full-count caller.
Differences include equal-time ordering, physical records outside parent paths,
and missing indexed Claude parents. A smaller return cannot silently preserve
the complete-chain contract.

**Decision.** Add messages as an intentional additive extension to the
ADR-0002 query-global contract, introduced in CLI 0.3.0. Existing helper return
shapes and globals remain unchanged. messages has one result envelope for exact
UUID lookup, finite anchor windows, and bounded session intervals/pages. The
authoritative option/default/return contract lives in api-reference.md and is
covered by helper-shape, provider, and CLI tests.

Temporal anchor windows stay in the anchor's session and agent and order by
timestamp plus UUID; this is explicitly not a provider entry order or a branch
assertion. Parent windows follow parent_uuid and return only a qualifying
ancestor tail. They do not support forward descendants: the indexed schema does
not always attest a unique current branch, so we will not invent one. Missing
parents terminate the path. A schema migration/provider ordering field and
forward branch selection are outside this addition.

Content/meta/visibility filters run before counting neighbors or paging rows.
An explicit anchor remains readable if queryable, independently of neighbor
filters. Hidden records never appear; inactive evidence requires opt-in. Parent
recursion carries structure and projects body fields only for eligible rows.
Cycles or excessive structural traversal fail without partial evidence.
Session metadata is optional. Full ancestor counts remain explicit SQL work,
not an implicit cost of a small window.

The default teaching surface is overview, sessions, search, messages, memories,
summaries, and sql. recent is a deprecated sessions alias. context/thread retain
their existing compatibility behavior; trace/workflows/workflowTree remain
advanced compatibility capabilities. fileHistory/failures/subagents retain
their specialized association, visibility, and statistics semantics. raw remains
original-record access.
This changes guidance, not legacy script availability. Memory mutations remain
local and separate from retrieval.

**Consequences.** New scripts can retrieve bounded evidence without fetching
whole sessions/chains, and users learn fewer default helpers. Exact old-context
equivalence still requires the correct parent relation, content/meta filters,
and metadata selection; neither full counts nor all external uses have migrated.
Session keyset pagination is deterministic on a stable snapshot; pages across
concurrent indexing can change, so it is not a snapshot token. Bounded rows do not imply bounded scan work
in every filtered path.
Compatibility helpers are retained until deliberate migration/deletion work.
