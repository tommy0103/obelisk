# The CLI ships readable compiled JS; the skill remains docs-only

**Context.** Obelisk reads a user's local Claude Code, Codex, Kimi Code, and Pi history,
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
