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
