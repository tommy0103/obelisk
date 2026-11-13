# Obelisk CLI

The local Obelisk runtime used by coding agents. It indexes Claude Code, Codex, GitHub Copilot,
Kimi Code, Kiro, OpenCode, and Pi transcripts into `~/.obelisk/obelisk.sqlite` and exposes the
stable `build`, `search`, `query`, and `attune` process interface.

CLI 0.3.0 adds bounded `messages` retrieval. The default query surface is
`overview`, `sessions`, `search`, `messages`, `memories`, `summaries`, and `sql`.
Specialized helpers and older script globals remain callable; see the
[authoritative query contract](../../skill-doc/references/api-reference.md).

Requires **Node.js >=22.13.0** on the host. The CLI uses built-in `node:sqlite`;
the desktop app separately runs on Electron's embedded Node 24 and uses
`better-sqlite3`. See the
[runtime explanation](../../docs/adr/0005-app-electron-vite-ts-esm.md).

```bash
npm install --global @obelisk-apps/cli
obelisk --version
obelisk install
obelisk --query /tmp/query.mjs
```

### Unreadable provider settings

Only a missing settings file (`ENOENT` when read) selects default provider
roots. This uses the resolved settings location: `OBELISK_HOME/settings.json`
when overridden, the config location when XDG storage is enabled, or
`~/.obelisk/settings.json` by default. Access-denied, I/O and invalid-path
failures are reported as
unavailable settings, not as an absent configuration. A force build then fails
without publishing a snapshot. Existing indexed queries remain available with
an explicit refresh-skipped warning, but invocation-nonce recovery cannot write
or index default source roots while the settings are unknown. Correct the
reported settings read failure, then retry; no permission or configuration is
changed automatically.

### Agent skill

`obelisk install` installs the separate docs-only agent skill from
`tommy0103/obelisk-skill`. The CLI itself remains daemon-free: each command
refreshes the local index when write ownership is available, then exits.

DeepSeek Harness history defaults to `$DSH_HOME/sessions`, or
`~/.dsh/sessions` when `DSH_HOME` is unset or blank. Like DSH, Obelisk expands
bare `~`, `~/` and `~\` home prefixes and resolves relative `DSH_HOME` values
against the process working directory. An explicitly configured DeepSeek
source directory takes precedence and already names the sessions directory.

Codex history defaults to `$CODEX_HOME`, or `~/.codex` when `CODEX_HOME` is
unset or blank (expanding bare `~`, `~/` and `~\` and resolving relative values
against the process working directory). An explicit `providerRoots.codex`
setting in `settings.json` takes precedence and accepts either a single root
string or a non-empty array of absolute or `~`-prefixed root paths as the
complete set of Codex roots (include `~/.codex` explicitly if you want it
indexed alongside additional roots). Removing a root from `providerRoots.codex`
retains cached sessions during ordinary refresh and publishes only the
configured roots on a deliberate `--build` rebuild; an unavailable previously
indexed root that remains configured blocks destructive rebuilds.

### Index access errors

Search and query read from SQLite, but their pre-query refresh also needs write
access to `~/.obelisk/obelisk.sqlite`, its directory (including SQLite sidecars),
and the writer-lease file. A sandbox that permits reading the index but denies
these writes can therefore block a query before its script runs.

The CLI checks index writability before source discovery and stops on a shared
read-only writer failure instead of retrying every transcript. It reports the
index path and preserves the original error for SQLite read-only/cannot-open
failures and filesystem `EACCES`, `EPERM`, or `EROFS` at index access boundaries.
A source database's read-only error is not enough to blame the index: after a
safe rollback the CLI checks the writer again, and a readable sibling can still
index when only that source failed. No stale-result fallback,
automatic permission change, or alternative index is selected. If a host
sandbox is responsible, request host-approved permissions and retry the same
command with the same retrieval scope; persistent failures still exit nonzero.
