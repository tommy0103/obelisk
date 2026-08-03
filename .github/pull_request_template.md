<!--
Fill in what applies. Delete the area sections you did not touch.
Full guidance: CONTRIBUTING.md
-->

## What and why

<!-- What changes, and what problem it solves. Link the issue. -->

Closes #

## Verification

<!-- Paste the actual numbers. Re-run these after merging main — a merge voids
     every result above it, including any "known limitation" noted here. -->

- [ ] `npm test` — <!-- N pass / 0 fail -->
- [ ] `npm run typecheck` — 0 errors (root + app)
- [ ] `npm run lint` — 0 errors
- [ ] `npm run test:electron:all` — <!-- required if app/ changed; N/N suites -->
- [ ] New tests actually run in CI (`.github/workflows/`)
- [ ] No existing assertion was loosened <!-- if one was, explain below -->
- [ ] Every capability described above was exercised end to end from the
      outermost entry point (including anything shown in a screenshot)
- [ ] Re-ran the checks above on the current head, after the most recent merge

## Deliberately out of scope

<!-- What you chose not to do, and open questions you'd rather not guess at.
     Do not ship a code path you have flagged to yourself as unverified — file a
     follow-up issue instead. -->

---

<details>
<summary><b>Renderer / Electron UI</b> — expand if you touched <code>app/src/renderer</code> or row rendering</summary>

- [ ] Reader-anchor assertion added — content settling above the viewport does
      not move the row the user is looking at
- [ ] Async media covered at mount, size-available, and load/error — not only the
      final state
- [ ] Tested both at rest and mid-scroll (`virtual-core` skips compensation for
      measured rows when scrolling backward)
- [ ] No `loading="lazy"` on virtualized rows
- [ ] No hardcoded colors or type sizes in shadow DOM (`var(--muted)` etc.)
- [ ] One visual treatment per user-visible concept
- [ ] Library calling conventions either accept both shapes or are pinned in code
- [ ] Every renderer probe has a deadline and an `error` → reject path
- [ ] No assertion with sub-pixel headroom (self-calibrate instead)

</details>

<details>
<summary><b>Provider adapter</b> — expand if you touched <code>packages/core/src/providers</code></summary>

- [ ] Read `claude.ts`, `codex.ts`, and `kimi.ts` in full first
- [ ] Session identity is composite (e.g. normalized cwd + header id), not the
      source id alone
- [ ] A test actually calls `discover()` against each supported directory layout
- [ ] Directory layout verified against upstream source or format docs
- [ ] Canonical transcript invariant holds: direct assembly == SQLite round-trip
      (ADR-0007)
- [ ] Text-less records (image-only, aborted-with-usage) still emit a row
- [ ] `indexVersionMarker` bumped if uuid format, role normalization, or any
      stored-row shape changed
- [ ] "Should not be displayed" uses `visibility`, not a new meaning for
      `is_sidechain`
- [ ] Cursor detects same-millisecond rewrites (mtime + ctime + size + inode)
- [ ] Unknown/newer versions are skipped and recorded, not thrown on

</details>

<details>
<summary><b>Schema / migration</b> — expand if you touched <code>schema.sql</code> or <code>schema-migrations.ts</code></summary>

- [ ] `schema.sql` hash updated in `tests/provider-schema-stability.test.mjs`,
      with justification above
- [ ] Destructive DDL runs inside `runWriteTransaction`
- [ ] Completion is not inferred from the target state's own name — interrupting
      at any line self-heals on the next start
- [ ] Validation rejects anything SQLite would reject, before any mutation
- [ ] Checked that no table carries its own arguments that a blanket write would
      erase
- [ ] External input spliced into DDL has an allowlist and an injection test

</details>

<details>
<summary><b>Main process / untrusted input</b> — expand if you touched <code>app/src/main</code></summary>

<!-- Transcript content is written by third-party agents. Treat it as
     attacker-controlled. -->

- [ ] Transcript-derived paths do not reach `shell.openPath` unguarded;
      confirmation dialogs default to Cancel
- [ ] File reads triggered by transcript content are allowlisted to known roots
- [ ] No `innerHTML` / detached `<textarea>` decoding of untrusted text; decode
      exactly once, escape on output, pinned by a test
- [ ] No synchronous IO in the main process
- [ ] Interception scope not broadened beyond this feature
- [ ] New main/preload sources are `.ts` (ADR-0005)

</details>

<details>
<summary><b>Indexing / daemon</b> — expand if you touched <code>indexer.ts</code>, <code>provider-indexing.ts</code>, or write coordination</summary>

- [ ] Read-only while the daemon heartbeat is fresh — no write connection,
      migration, PRAGMA change, checkpoint, or indexing
- [ ] Anything needing periodic refresh has a refresh point that is genuinely
      called repeatedly, including on existing installations
- [ ] Configuration mismatch under `daemon_active` is an explicit error, not a
      silent fall back to a stale index
- [ ] Trigger vs. full-rebuild choice is justified above

</details>
