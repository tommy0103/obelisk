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
obelisk install
```

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
