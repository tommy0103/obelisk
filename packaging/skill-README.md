# Obelisk Skill

Explicit memory infrastructure for coding agents — a queryable SQLite evidence
layer over local Claude Code, Codex, Kimi Code, and Pi session history.

## Install with your agent (recommended)

Paste this into a coding agent with shell access:

```text
Install Obelisk by fetching and following this guide:
curl -fsSL https://raw.githubusercontent.com/tommy0103/obelisk/main/SKILL.md
```

The agent installs and verifies the CLI first, then asks whether this skill
should be installed for the current project or globally.

## Install manually

```bash
npm install --global @obelisk-apps/cli
```

CLI 0.3.1+ installs this skill automatically using the standard skills installer:
global npm
installs use global skill directories, and ordinary npm installs use the
invoking project. Set `OBELISK_SKIP_SKILL_INSTALL=1` to install only the CLI.
If skill setup fails, the CLI still works; retry with
`obelisk install --global --yes` or `npx --no-install obelisk install --yes` from the project.
Use npm's `--foreground-scripts` to see setup output, or `obelisk install` to
choose a different scope interactively.

The CLI is the executable runtime. This repository contains only the agent
instructions and progressive-disclosure references.

Then in any Claude Code session:

```
/obelisk <your question>
```

## Source

This repository is **auto-published** from the docs-only skill artifact of
[tommy0103/obelisk](https://github.com/tommy0103/obelisk). Do not open pull
requests here — contribute to the source repo instead.

## License

MIT — see [LICENSE](LICENSE) in this repository. The
[source repository](https://github.com/tommy0103/obelisk) is AGPL-3.0; this
skill documentation artifact is explicitly relicensed under MIT by the copyright
holder.
