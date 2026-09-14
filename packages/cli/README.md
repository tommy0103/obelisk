# Obelisk CLI

The local Obelisk runtime used by coding agents. It indexes Claude Code, Codex,
Kimi Code, and Pi transcripts into `~/.obelisk/obelisk.sqlite` and exposes the
stable `build`, `search`, `query`, and `attune` process interface.

```bash
npm install --global @obelisk-apps/cli
obelisk --version
obelisk install
obelisk --query /tmp/query.mjs
```

`obelisk install` installs the separate docs-only agent skill from
`tommy0103/obelisk-skill`. The CLI itself remains daemon-free: each command
refreshes the local index when write ownership is available, then exits.

## Compact Retrieval

Agent retrieval should bound the number of hits and neighboring messages, and
use compact output to avoid embedding full conversations in tool results:

```bash
obelisk --search "keyword" --compact --limit 8 --context 0 --snippet-length 240
```

- `--limit N` caps the number of hits.
- `--context N` caps neighboring messages per hit and accepts `0`.
- `--compact` returns only stable IDs, metadata, and snippets.
- `--snippet-length N` caps snippet length and enables compact output.
