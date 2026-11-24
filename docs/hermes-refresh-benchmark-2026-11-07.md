# Hermes refresh benchmark correction

The original 2026-11-07 measurements used an adapter pipeline, not a real CLI
process, and allowed hidden sibling edits to remain stale indefinitely. Its
O(delta) strict-query claim is withdrawn. The repaired contract is recorded in
[ADR-0001](adr/0001-parse-core-and-persist-layers.md): strict CLI verification is
immediate; normal refresh uses persisted bounded audits and a deadline.

The reproducible replacement is `npm run bench:hermes -- --baseline <checkout>`.
Both checkouts must first run `npm ci` and `npm run build:cli` under Node 22.
The harness runs actual built CLI processes over generated content in the
checked-in real Hermes schema. It asserts query/search freshness and final
canonical counts, and reports normal Core API measurements separately. It never
reads a production source or index. Final measured results are in the
[2026-11-10 verification report](hermes-refresh-benchmark-2026-11-10.md).
