# The CLI ships readable compiled JS; the skill remains docs-only

**Context.** Obelisk reads a user's entire local Claude Code and Codex history,
so auditability is the foundation of trust. Bundling/minifying Core into one
opaque file would make the runtime harder to inspect. Shipping executable Core
inside `.claude/skills` / `.agents/skills` would also blur the boundary between
the agent's instructions and the local data runtime.

**Decision.** `@obelisk-apps/cli` ships **readable, non-bundled, non-minified**
compiled JavaScript emitted straight from `tsc` (module structure and comments
preserved, ~1:1 with the TypeScript source), plus `schema.sql`. It excludes the
app, renderer, release assets, and tests. The separately published agent skill
ships only `SKILL.md`, `references/`, and metadata; every executable action in
the skill delegates to the installed `obelisk` command. Bundling into one file
is deliberately rejected because it trades auditability for marginal size.

**Consequences.** Runtime ownership is unambiguous: npm installs the CLI, while
the skills installer installs only agent guidance. A future contributor may be
tempted to re-embed Core in the skill or bundle the CLI — this ADR records that
both are intentional boundaries. `build:cli` owns compiled code;
`build:skill` owns docs-only packaging.

**Amendment: npm skill setup (CLI 0.3.1).** The CLI's readable `postinstall`
script invokes the standard skills installer for `tommy0103/obelisk-skill`,
selecting the docs-only `obelisk` skill without prompts. Global npm installation
uses global skill directories; ordinary npm installation uses npm's invoking
project (`INIT_CWD`), rather than the package directory. The runtime and skill
remain separately distributed: the npm tarball does not embed the skill or
executable code in skill directories. The main repository's root skill is an
installation guide and must not replace the retrieval skill as this source.

Repository dependency installs and `OBELISK_SKIP_SKILL_INSTALL=1` skip setup.
The CLI-only shell installer and agent bootstrap use that opt-out to preserve
their existing scope-selection flow. A failed installer or its 60-second
deadline leaves the CLI installation usable and reports the underlying cause
with a scoped retry command. npm's `--foreground-scripts` exposes lifecycle
output when progress or diagnosis is needed.
