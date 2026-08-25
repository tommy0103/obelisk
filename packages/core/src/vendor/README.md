# Vendor: DeepSeek Harness session-format decoders

Obelisk reads DeepSeek Harness session logs directly from `~/.dsh/sessions`.
To do that it needs two pieces of the DeepSeek Harness on-disk format that
have no standalone package we could depend on: the multi-frame Zstandard
container decoder and the lossless packed chunk-row codec. Both are vendored
here, adapted to be self-contained read-only modules.

## Sources

Upstream: <https://github.com/deepseek-ai/deepseek-harness> (MIT License)

Vendored at commit `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`
(last touch `25dcd7293c` "docs: purge chain-of-thought leakage from prose").

| Vendored module | Upstream file(s) |
|---|---|
| `dsh-zstd.ts` | `packages/session/session-persistence-jsonl/src/zstd.ts`, `zstd-public-decoder.ts`, `zstd-private-decoder.ts` |
| `dsh-chunk-rows.ts` | `packages/core/session/src/chunk-rows.ts` |

## Adaptation notes

Both modules preserve upstream logic verbatim and only adapt boundaries for
Obelisk:

- **Read-only**: the upstream write-side helpers (`compressZstdFrame`,
  `decompressZstdPrefix`, `packChunkRuns`) are omitted — Obelisk never writes
  DeepSeek Harness session logs.
- **Self-contained**: the `@deepseek-ai/dsh-session` / `@deepseek-ai/dsh-llm`
  type imports are replaced by minimal local types (`DshEvent`, inline row
  shapes). Obelisk must not depend on `@deepseek-ai/*` packages.
- The MIT copyright attribution is kept in each module header.

## Sync procedure

When upstream changes one of these files, port the delta into the vendored
copy:

1. Diff `deepseek-harness/packages/session/session-persistence-jsonl/src/zstd*.ts`
   and `deepseek-harness/packages/core/session/src/chunk-rows.ts` against the
   vendored modules.
2. Carry over decoder-side changes only; skip write-side helpers.
3. Re-apply the self-containment adaptation (drop `@deepseek-ai/*` imports,
   inline the local types).
4. Update the vendored-at commit + last-touch hashes in this README and in
   both module headers.
5. Run `node --test tests/deepseek-parse.test.mjs` — the multi-frame zstd and
   chunk-row tests cover the vendored paths.
