# Obelisk CLI

The local Obelisk runtime used by coding agents. It indexes Claude Code, Codex, GitHub Copilot,
Kimi Code, and Pi transcripts into `~/.obelisk/obelisk.sqlite` and exposes the
stable `build`, `search`, `query`, and `attune` process interface.

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

Only a missing `~/.obelisk/settings.json` (`ENOENT` when read) selects default
provider roots. Access-denied, I/O and invalid-path failures are reported as
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
