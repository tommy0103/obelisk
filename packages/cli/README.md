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
obelisk --query /tmp/query.mjs
```

Starting with CLI 0.3.1, npm also installs the docs-only `obelisk` skill from
`tommy0103/obelisk-skill` using the standard skills installer, without prompts.
Global npm
installs use the user's global skill directories; ordinary npm installs use
the project where npm was invoked. The main repository's `SKILL.md` is an
installation guide, so it is not the source for this retrieval skill.

Set `OBELISK_SKIP_SKILL_INSTALL=1` or use npm's `--ignore-scripts` to install
only the CLI. Repository dependency installs also skip this setup. Skill setup
has a 60-second deadline; if it fails, the CLI remains usable. Retry with
`obelisk install --global --yes` for a global install, or
`npx --no-install obelisk install --yes` from the project for a local install.
npm normally hides lifecycle output; use `--foreground-scripts` to see setup progress and errors.
`obelisk install` remains available for interactive setup or a different scope.

The CLI itself remains daemon-free: each command
refreshes the local index when write ownership is available, then exits.
