# Obelisk CLI

The local Obelisk runtime used by coding agents. It indexes Claude Code, Codex, GitHub Copilot,
Kimi Code, Kiro, and Pi transcripts into `~/.obelisk/obelisk.sqlite` and exposes the
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

`obelisk install` installs the separate docs-only agent skill from
`tommy0103/obelisk-skill`. The CLI itself remains daemon-free: each command
refreshes the local index when write ownership is available, then exits.

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
