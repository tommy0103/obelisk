# @obelisk/dsh-plugin

Obelisk retrieval plugin for DeepSeek Harness. Mounts one read-only model tool,
`obelisk_query`, plus a short guidance section, giving the model a second
retrieval channel: `session_search` covers this tool's own prior sessions, while
`obelisk_query` covers the cross-tool archive (Claude Code, Codex, Kimi Code,
Pi) and the durable memory layer. See
[ADR-0009](../../docs/adr/0009-obelisk-as-dsh-optional-retrieval-plugin.md).

## Prerequisites

- The Obelisk CLI on `PATH` (`npm install --global @obelisk-apps/cli`),
  version 0.2.3 or newer — older releases lack the daemon-aware query refresh
  and fail while the desktop app holds the index write lease. The plugin runs
  `obelisk --query` per invocation, exactly like other agent harnesses.
- The Obelisk agent skill installed (`obelisk install --global`). The plugin
  does not embed or re-teach the skill; DeepSeek Harness discovers it from
  `~/.agents/skills` through its own skill filesystem, and the guidance text
  points the model at loading it with the `skill` tool before the first query.

## Enable

Add the plugin row to a harness patch, for example:

```bash
dsh web --patch packages/dsh-plugin/obelisk.cordis.yml
```

or add `obelisk.cordis.yml` to your profile's `cordis.patch.yml`. The plugin is
opt-in; a deployment without it behaves exactly as before.

## Configuration

| Key | Default | Contract |
|---|---:|---|
| `cliPath` | `obelisk` | Command used to run the Obelisk CLI. |
| `timeoutMs` | `30000` | Cooperative subprocess deadline for one invocation; must be 1000–120000. |
| `maxResultChars` | `24000` | Maximum characters returned to the model per invocation; must be 1000–1000000. |

## Model experience

One fixed guidance section plus one fixed tool schema are sent while the plugin
is mounted; the result is data-dependent plain text (the query's JSON return
value, capped). The tool deliberately exposes no index internals, no cursors,
and no mutation surface: memory writes and archives keep their human-approved
flow in the obelisk skill.

## Frontend presentation (browser half)

The package is dual-face (`dsh.client`, platform `web`): the host serves its
`lib/client.js` to the browser, which registers a distinct card for
first-party `obelisk_query` calls — monolith glyph, "Obelisk" label, bounded
query summary, and expandable QUERY/RESULT sections, themed through DSW alias
tokens. The browser half is presentation only:

- The model-facing surface is untouched: same tool schema, same result text.
- The durable session record is untouched: calls stay ordinary
  `obelisk_query` events; no presentation metadata is written back.
- Only the `obelisk_query` wire name is claimed, so no other tool's rendering
  changes.

Skill-driven invocations through the shell tool (`obelisk --query ...` as a
Bash call) keep the standard Bash row for now: keyed toolview slots are
all-or-nothing per wire name, and the bundle purity gate forbids reusing the
shipped Bash row. A generic conditional-claim extension in DeepSeek Harness
would enable that recognition later (see ADR-0009).

## Limitations

- **Batch freshness.** Obelisk is a snapshot archive; just-finished sessions
  appear after the next index refresh. Live history stays with `session_search`.
- **Single-writer index.** Queries reuse the CLI's incremental index refresh;
  while another process (for example the Obelisk desktop app) holds the index
  write lease, a query may fail with a readonly-database error.
- **Serial execution.** The tool does not declare itself concurrency-safe, so
  the harness executes it exclusively.
- **Version alignment.** Developed against `@deepseek-ai/dsh-tools` `0.1.0-rc.6`
  and `@deepseek-ai/cordis` `^4.0.1`; keep the host's copies aligned when
  upgrading.

## Development

```bash
npm install
npm run typecheck --workspace @obelisk/dsh-plugin
npm run build --workspace @obelisk/dsh-plugin
node --experimental-test-module-mocks --test tests/dsh-plugin.test.mjs tests/dsh-plugin-client-model.test.mjs
```
