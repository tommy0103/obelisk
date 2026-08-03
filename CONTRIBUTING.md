# Contributing to Obelisk

Thanks for contributing. This document exists because most PRs that stall here
are not low-quality code — they pass lint, typecheck, and their own tests. They
stall on a small number of recurring failures that are easy to avoid once
someone names them.

Read the section for the area you are changing. The verification contract at the
bottom applies to every PR.

---

## Six things that decide whether a PR lands

**1. Run every sentence of your PR description end to end.**
The single most common failure is a capability that is advertised but
unreachable. If you describe a config option, use that option from the outermost
entry point before submitting. If you post a screenshot, the input in that
screenshot must be an input the code can actually handle.

**2. Write assertions in the words of the requirement, not the shape of the
implementation.**
Copy the sentence from the issue into your test name. If the issue says "without
causing reader-position jumps", the assertion has to measure reader position —
not "the row got taller". If a test hits behavior you did not expect, decide
whether it is a bug before you pin it as expected.

**3. Anything destructive must converge when re-run after an interruption.**
Validate to the point of actual executability before you mutate. Put the whole
sequence in one transaction. Never use the name of the target state as the
completion marker. The test is: if the process dies on any line, does the next
start heal itself?

**4. Read the neighbouring implementation first, and reuse the concepts that
already exist.**
Adding a provider means reading `claude.ts`, `codex.ts`, and `kimi.ts` in full
first. Needing "don't display this row" means grepping for `visibility` before
inventing a field. The burden of proof for a new concept, field, state, or file
type is on the PR: say why the existing one is insufficient. The ADRs in
`docs/adr/` are constraints, not suggestions.

**5. Treat all transcript content as attacker-controlled.**
It is written by third-party agents. Any path where a transcript value reaches
`shell.*`, `fs.*`, `innerHTML`, or SQL/DDL is deny-by-default.

**6. Re-run verification on the final head.**
Merging main invalidates every claim in your PR description, including your own
"known limitations". Run the suites that cover the line you touched, not only
the test you added.

---

## Renderer / Electron UI changes

Proving the new element renders correctly is one third of the job. You also owe
evidence that it does not disturb virtual scrolling, async timing, existing
interactions, or the full Electron suites.

- Any change that can affect row height — new elements, async media, fonts,
  spacing, the shape of `renderMarkdown` output — needs a **reader-anchor
  assertion**: content above the viewport settling must not move the row the
  user is looking at. Follow the existing pattern in
  `app/tests/electron-session-virtualization.mjs`.
- Cover **three states, not just the final one**: mount, size-available-but-not-
  loaded, and load/error. Progressive images reach their final size long before
  `load` fires; signalling only on `load` will miss it.
- **Idle and mid-scroll are different scenarios.** `virtual-core`'s `resizeItem`
  skips scroll compensation for already-measured rows when
  `scrollDirection === 'backward'`, so drift can be zero at rest and large while
  scrolling up. Test both.
- Run `npm run test:electron:all` (all five suites), not only the suite you
  added.
- **Do not add `loading="lazy"` to virtualized rows.** Rows already mount near
  the viewport; lazy only defers decode into the scroll itself.
- **No hardcoded colors or type sizes inside shadow DOM.** Custom properties
  pierce the shadow boundary — use `var(--muted)`, `var(--hairline-strong)`,
  `var(--text-sm)`.
- **One visual treatment per user-visible concept.** "Blocked source" and "failed
  to load" are the same thing to a reader; they must not render two different
  ways.
- When you depend on a library's calling convention, either accept both shapes or
  pin the assumption in code. A silent signature change that degrades every item
  to a fallback is invisible to types and tests.
- **Every renderer-side probe needs a deadline and an `error` → reject path.** A
  promise with no rejection path plus a bare `await` turns a regression into a
  hung CI job instead of a red one.
- **No assertions with sub-pixel headroom.** Self-calibrate (e.g. take the median
  gap of currently mounted rows as the baseline) instead of hardcoding a
  threshold that a spacing tweak turns red.

## Provider adapters

- **Read `claude.ts`, `codex.ts`, and `kimi.ts` before writing a new adapter.**
  The conventions there are earned: zero-padded ordinals in ids
  (`parsing.ts` uses `padStart(6, '0')`), the
  `__<provider>_canonical_transcript_vN__` marker, how `git_branch` is handled.
- **Session identity must not be the source id alone.** Use a composite such as
  (normalized cwd, header id). Explicit session ids are usually project-local, so
  two projects may legitimately collide — and the second one indexed will
  overwrite the first.
- **A test must actually call `discover()`.** Asserting the resolved root string
  passes even when the directory-layout assumption is wrong.
- **Verify directory layout against the upstream source or format docs**, not
  against what your own machine happens to look like. A tool's default root and
  its custom root often have different nesting.
- **The canonical transcript invariant (ADR-0007) is a hard gate**: assembling
  directly from your adapter must equal assembling after a SQLite round-trip. Any
  design where duplicate ids merge or overwrite breaks it.
- **Never drop a record just because it has no text.** Image-only messages and
  aborted turns that carry usage must still emit a row (`text: null`,
  `content_type: 'unknown'`), or token accounting and the timeline develop holes.
- **Bump `indexVersionMarker` whenever you change uuid format, role
  normalization, or anything else affecting already-stored rows.** Otherwise the
  mtime short-circuit in discovery leaves old-format rows in the database
  forever.
- **Express "this should not be shown" with the existing `visibility` field**
  (`providers/types.ts`), which is defined as provider-normalized display
  eligibility and already has a consumer in the assembler. Do not add a third
  meaning to `is_sidechain`.
- **Cursors must detect same-millisecond rewrites**: mtime + ctime + size + inode,
  not mtime alone. Reconcile moves, copies, deletes, and replacements.
- **Version gates must tolerate the unknown.** Throwing on an unexpected higher
  version makes one bad file trigger a full re-index every run, because the
  provider's index markers are withheld while any unit fails. Skip and record
  instead of poisoning the provider.

## Schema and migrations

- `schema.sql` is pinned by sha256 in `tests/provider-schema-stability.test.mjs`.
  Changing it is an explicit decision plus a full re-index: justify it in the PR
  and update the hash in the same commit. Prefer additive changes.
- **Destructive DDL goes in one transaction.** The repository already has
  `runWriteTransaction` (`packages/core/src/tx.ts`) and both SQLite adapters, and
  the entry points already hold the writer lease — you do not need to invent a
  migration marker.
- **Do not use the name of the target state as the completion marker.** If the
  process is interrupted after CREATE but before the rebuild finishes, comparing
  the current setting against the requested one reports success forever and the
  data is never backfilled.
- **Validate to executability, not to lexical shape.** A regex that accepts a
  string SQLite will reject means you drop the table and then fail.
- **Before writing one value across every table, check whether any table carries
  its own arguments.** Overwriting them leaves the migration looking complete,
  so it never self-heals.
- **Any external input spliced into DDL needs an allowlist and an injection test
  case.**

## Main process and untrusted input

- **Transcript paths must not reach `shell.openPath` unguarded.** On macOS,
  `.app` / `.command` / `.sh` are executed, not opened. Confirmation dialogs must
  default to Cancel.
- **Reading a file because a transcript said so requires an allowlist**, scoped to
  the session's project cwd or known source roots.
- **Do not decode untrusted text through `innerHTML` or a detached `<textarea>`.**
  Decode the specific entities your markdown library actually emits, escape on
  the way out, and pin "decode exactly once" with a test (`&amp;lt;` must stay
  `&lt;`).
- **No synchronous IO in the main process.** A network mount or UNC path freezes
  the whole UI. Use `fs.promises`.
- **Do not broaden interception beyond your feature.** Catching every `file:`
  navigation when you only meant to handle markdown links affects everyone else.
- **Main and preload sources are TypeScript** (ADR-0005). `app/tsconfig.json` sets
  `checkJs: false`, so a `.mjs` module has no type coverage at all.

## Indexing, daemon, and write ownership

- **The heartbeat decides who may write.** While a daemon is fresh, the CLI side
  is read-only: no write connection, no schema migration, no PRAGMA change, no
  checkpoint, no indexing. Guarded by `tests/daemon-arbitration.test.mjs` and
  `tests/app-writer-lease.test.mjs`.
- **If you add something that needs periodic refresh, prove its refresh point is
  actually called repeatedly.** Hanging a full rebuild off a first-run-only gate
  means it runs once and never again — and for existing installations, never at
  all.
- **`daemon_active` must not swallow a configuration change.** Distinguish
  "correctly skipping" from "configuration mismatch"; the latter is an explicit
  error, not a silent fallback to a stale index.
- **State your reasoning when choosing triggers vs. full rebuild.** For example,
  rows written with `INSERT OR REPLACE` do not fire DELETE triggers while
  `recursive_triggers` is off, so a trigger-based refresh would leave stale text
  behind.

---

## Verification contract

Every PR:

1. `npm test`, `npm run typecheck` (root and app tsconfig), `npm run lint` — all
   green. Quote the **numbers** in the PR description.
2. Touching `app/` also requires `npm run test:electron:all`.
3. **After merging main, re-run everything.** Conclusions from before the merge —
   including any "known limitation" you documented — are void.
4. **Do not loosen an existing assertion.** If one must change, give it its own
   section in the PR description explaining why the original was wrong.
5. **Fixtures are real provider output**, not hand-written approximations.
6. **Confirm your new tests actually run in CI** (`.github/workflows/`).

## Scope and review

- One PR does one thing. Note explicitly anything you deliberately left out.
- If you are unsure about a design decision, say so in the PR instead of
  guessing — an open question is cheaper to resolve than a silent assumption.
- Do not ship a code path you have flagged to yourself as unverified. Writing
  "this call site is worth another look" is honest, but it belongs in a follow-up
  issue, not in the diff.
