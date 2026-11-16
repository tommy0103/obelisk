# Vendor: DeepSeek Harness session-format decoder

Obelisk reads DeepSeek Harness session logs directly from `~/.dsh/sessions`.
To do that it needs the DeepSeek Harness multi-frame Zstandard container
decoder, which has no standalone package we could depend on. It is vendored
here, adapted to be a self-contained read-only module.

## Sources

Upstream: <https://github.com/deepseek-ai/deepseek-harness> (MIT License)

Vendored at commit `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`
(last touch `25dcd7293c` "docs: purge chain-of-thought leakage from prose").

| Vendored module | Upstream file(s) |
|---|---|
| `dsh-zstd.ts` | `packages/session/session-persistence-jsonl/src/zstd.ts`, `zstd-public-decoder.ts`, `zstd-private-decoder.ts` |

## Adaptation notes

The module preserves upstream logic verbatim and only adapts boundaries for
Obelisk:

- **Read-only**: the upstream write-side helpers (`compressZstdFrame`,
  `decompressZstdPrefix`) are omitted — Obelisk never writes
  DeepSeek Harness session logs.
- **Self-contained**: Obelisk must not depend on `@deepseek-ai/*` packages.
- The MIT copyright attribution is kept in the module header.

## Sync procedure

When upstream changes one of these files, port the delta into the vendored
copy:

1. Diff `deepseek-harness/packages/session/session-persistence-jsonl/src/zstd*.ts`
   against the vendored module.
2. Carry over decoder-side changes only; skip write-side helpers.
3. Re-apply the self-containment adaptation (drop `@deepseek-ai/*` imports,
   inline the local types).
4. Update the vendored-at commit + last-touch hashes in this README and in
   the module header.
5. Run `node --test tests/deepseek-tree.test.mjs tests/deepseek-identity.test.mjs`
   — the multi-frame zstd tests cover the vendored path.

Note: the container format is unchanged across session format
v0–v4 (ADR-0014); the vendored decoder needed no update for multi-version
support. The v4 codec reuses the released V2 physical framing and only swaps
the header version, so a `session.v4.jsonl.zstd` artifact decodes through the
same scanner and frame decoder as v3.
