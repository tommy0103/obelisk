<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/obelisk-wordmark-d.svg">
  <img src=".github/assets/obelisk-wordmark-l2.svg" alt="Obelisk" width="540">
</picture>

[![stars](https://img.shields.io/github/stars/tommy0103/obelisk?style=flat-square)](https://github.com/tommy0103/obelisk/stargazers)
[![version](https://img.shields.io/github/v/tag/tommy0103/obelisk?label=version&style=flat-square)](https://github.com/tommy0103/obelisk/releases)
[![license](https://img.shields.io/badge/license-AGPL--3.0-blue.svg?style=flat-square)](LICENSE)

Past Claude Code, Codex, Kimi Code, Pi, and DeepSeek Harness sessions -- queryable by your agent, browsable by you.

</div>

<br />

## Two sides of the same index

Obelisk has two sides that share one SQLite index:

**Agent side** — the `obelisk` CLI owns the local runtime, while a separate
agent skill teaches coding agents how to search and query their session history.
The agent writes JS queries, runs them locally, and answers in plain language.

**App side** — an Electron desktop app for humans to browse sessions, manage memories, view usage stats, and see weekly recap cards.

Both read from the same `~/.obelisk/obelisk.sqlite` database. The indexer reads Claude Code transcripts from `~/.claude/projects`, Codex transcripts from `~/.codex/sessions` and `~/.codex/archived_sessions`, Kimi Code sessions from `~/.kimi-code/sessions` (or `$KIMI_CODE_HOME/sessions`), Pi sessions from `~/.pi/agent/sessions`, and DeepSeek Harness sessions from `~/.dsh/sessions`.

## Multi-provider support

Obelisk indexes every provider into the same SQLite schema instead of keeping separate databases. Rows carry a `source` value, and non-Claude IDs are provider-prefixed so they cannot collide.

Codex root threads become normal Obelisk sessions. Codex child threads are attached through the same `subagents` table when parent-thread metadata is available. Codex does not emit Claude-style workflow metadata, so workflow tables may be empty for Codex-only history.

Kimi session directories become one Obelisk session each. Main and child-agent
`wire.jsonl` streams are projected into the same messages, tools, summaries and
subagents tables. Undo/clear is handled as a full session replay, so retracted
wire records do not remain in the index.

DeepSeek Harness session logs (`session.jsonl.zstd` under `~/.dsh/sessions`)
are projected through the same provider contract: each session file is indexed
incrementally — committed zstd frames are immutable and only appended, so a
refresh decodes and re-emits only the new frames' events (countMode `delta`),
with an automatic full reparse if a crash repair ever truncates the log. A
session whose header carries a `parentSession` is a
subagent — its messages fold into the root parent session as sidechain
messages, and the `subagents` table links the delegation (the parent session
contributes `parent_tool_use_id`; the subagent session contributes
`agent_type`/`description`/duration, and the shared query layer derives its
total tokens from the sidechain messages' usage). Multi-frame Zstandard logs
and the lossless packed chunk-row codec are decoded inside the adapter, so no
DeepSeek-specific database or renderer branch is needed.

Pi JSONL v1-v3 sessions are projected through the same provider contract. Pi's tree, branch summaries, compactions, durable leaf, retained checkpoint tail, custom messages, bash records, tool calls, token usage, and raw JSONL evidence stay inside the adapter; no Pi-specific database or renderer branch is needed. Active visibility follows Pi's own context rules: a retained tail replaces pre-compaction ancestors even when those physical entries still exist and bounds any later legacy compaction, while a legacy-only chain retains ancestors beginning at `firstKeptEntryId`. Missing parents form orphan branch roots, matching Pi's recovery behavior. Pi entries that the source explicitly superseded are stored as `inactive`: the app and normal agent queries omit them, while supported query helpers can include them with `includeInactive: true`. Display-suppressed or transport-only records remain `hidden` and are never returned by those helpers.

| Provider | Superseded-history support |
| --- | --- |
| Pi | Branch, leaf, and compaction state attests inactive history |
| Kimi Code | Undo/clear can attest supersession; preservation is a follow-up |
| Claude Code | The source does not attest rewind or current-leaf state |
| DeepSeek Harness | The append-only log does not attest rewind or supersession |
| Codex | Sessions have no branching semantics |

Because Pi's explicit `--session-id` is project-local, Obelisk combines the header ID with a deterministic hash of the normalized header `cwd`; this keeps the identity stable across file moves and v1-v3 migration while allowing two projects to use the same custom ID. Replacement and deletion replay is provenance-aware, so stale session snapshots are retracted atomically; compaction and branch-summary model usage is included in usage totals.

For live app refresh, Obelisk watches the roots declared by every registered provider, including `~/.claude/projects`, `~/.codex/sessions`, `~/.codex/archived_sessions`, `~/.kimi-code/sessions`, `~/.pi/agent/sessions`, and `~/.dsh/sessions`. Codex's `session_index.jsonl` is used as lightweight title/update metadata during indexing, not as the message transcript source.

Pi chooses its session directory in this order: `--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, `sessionDir` in settings, then the default under `~/.pi/agent/sessions`. Obelisk automatically follows absolute or `~`-prefixed environment/global settings and the project setting for Obelisk's launch cwd; a relative project setting is resolved against that cwd. CLI-only roots, relative environment/global settings, and project settings from another launch cwd cannot be inferred safely, so select the resolved directory in Obelisk **Settings** instead of letting Obelisk guess.

## Skill: agent-first retrieval

<div align="center">
  <img src=".github/assets/demo.png" alt="Obelisk App" width="720">
</div>

You can use obelisk like:

```
/obelisk 上次 auth bug 最后到底改了哪些文件，为什么这么改
/obelisk 这个文件最近在哪些 sessions 里被反复修改
/obelisk 找出最近失败的 tool calls，它们分别发生在哪些任务里
/obelisk 那个 review workflow 的 subagents 各自结论是什么
/obelisk recap this week
```

### Install

#### Let your agent install it (recommended)

The shortest path is to give the bootstrap guide directly to a coding agent
with shell access. Paste this as a prompt into Claude Code, Codex, or another
agent — not into your terminal:

```text
Install Obelisk by fetching and following this guide:
curl -fsSL https://raw.githubusercontent.com/tommy0103/obelisk/main/SKILL.md
```

The agent will ask before changing your machine, install and verify the CLI,
then ask whether the formal `/obelisk` skill should be installed for the current
project or globally. The bootstrap guide is only for one-time setup; it is not
the query skill itself.

#### Install manually

Obelisk requires Node.js 22.13 or newer. Install the platform-neutral CLI:

```bash
npm install --global @obelisk-apps/cli
obelisk --version
```

On macOS, Linux, or WSL, the CLI-only installer is equivalent:

```bash
curl -fsSL https://raw.githubusercontent.com/tommy0103/obelisk/main/install.sh | sh
```

Then install the agent skill:

```bash
obelisk install
```

`obelisk install` delegates to the standard skills installer for
`tommy0103/obelisk-skill`.

Then in any Claude Code session:

```
/obelisk <your question>
```

First run builds the index (~5 seconds for 100 sessions). After that it rebuilds incrementally.

### How it works

```
You ask a question
  ↓
Agent writes a JS query against the SQLite index
  ↓
Runs it via obelisk --query <script>
  ↓
Reads the JSON result, answers in natural language
```

Core API: `search()`, `context()`, `sql()`, plus structured helpers (`sessions`, `memories`, `summaries`, `workflows`, `failures`, `fileHistory`, etc).

### Memory layer

When a retrieval produces a conclusion worth keeping, the agent proposes a markdown memory file. After user approval, it registers the file with `obelisk --attune <script>`. Memories are recalled via `memories()` in future sessions — a synthesis cache, not a replacement for raw evidence.

## App: A surface for humans

A companion desktop app for browsing the same index maintained by the CLI or
the app daemon.

<div align="center">
  <img src=".github/assets/app-screenshot.png" alt="Obelisk App" width="720">
</div>

- **Sessions** — browse all sessions with search, project filtering, readable tool calls (diffs, terminal output, file viewers)
- **Memory** — list and detail views for registered memory files
- **Activity** — GitHub-style heatmap, weekly/cumulative token charts
- **Recap** — shareable weekly/monthly recap cards with archetype theming
- **Settings** — data source configuration, auto-refresh, rebuild index

Prebuilt releases are currently available for macOS from
[Releases](https://github.com/tommy0103/obelisk/releases). The source app can be
run locally on macOS, Windows, and Linux.

### Run locally

Install [Node.js 22](https://nodejs.org/) and npm, then run the app from its own
package directory:

```bash
git clone https://github.com/tommy0103/obelisk.git
cd obelisk/app
npm ci
npm run dev
```

`electron-vite` starts the renderer dev server and launches Electron. On first run, Obelisk creates `~/.obelisk/obelisk.sqlite`, indexes the available registered-provider transcripts, and then watches them for changes. The default sources include `~/.claude/projects`, `~/.codex/sessions`, `~/.codex/archived_sessions`, `~/.kimi-code/sessions`, `~/.pi/agent/sessions`, and `~/.dsh/sessions`; use **Settings** to point the app at different directories. On Windows, Obelisk also checks common WSL distributions for the Claude Code directory.

### Debug the app

- Renderer changes use Vite hot module replacement. Open Electron DevTools with
  `Cmd+Option+I` on macOS or `Ctrl+Shift+I` on Windows/Linux.
- Main-process and preload logs appear in the terminal running `npm run dev`;
  their source changes are rebuilt by electron-vite.
- To attach a Node debugger to the Electron main process, start it with
  `npm run dev -- --inspect=5858`, then attach your debugger to port `5858`.
- The development app reads and updates the real `~/.obelisk` index. Back it up
  before testing destructive rebuilds. For an isolated run, launch with a
  disposable home directory (`HOME=/tmp/obelisk-dev npm run dev` on
  macOS/Linux, or set a temporary `USERPROFILE` first on Windows), then select
  fixture source directories in **Settings**.

`better-sqlite3` provides prebuilt binaries for common platforms. If `npm ci`
falls back to compiling it locally, install the platform's C/C++ build tools and
run `npm ci` again.

## What gets indexed

| Layer | Source | What's captured |
|-------|--------|----------------|
| **Sessions** | Claude `<project>/<sessionId>.jsonl`; Codex `sessions/YYYY/MM/DD/*.jsonl` and `archived_sessions/*.jsonl`; Kimi session directories; Pi recursive `*.jsonl`; DeepSeek Harness `<project>/<sessionId>/session.jsonl[.zstd]` | Title, project, timestamps, git branch, source |
| **Messages** | user + assistant turns | Full text, model, token usage, parent chain |
| **Tool calls** | every tool invocation | Tool name, input, file paths |
| **Subagents** | Claude `subagents/agent-<id>.jsonl`; Codex child threads; DeepSeek Harness child sessions (folded into the root session) | Agent type, description, full conversation |
| **Workflows** | Claude `workflows/wf_<runId>.json` | Script, result, agent count |
| **Workflow agents** | Claude `subagents/workflows/wf_<runId>/` | Per-agent transcripts |
| **Memories** | registered markdown files | Conclusions linked to source sessions |

Full-text search via FTS5 covers all layers.

## Structure

```
packages/core/                # @obelisk/core npm workspace (TypeScript + ESM)
├── src/
│   ├── providers/
│   │   ├── types.ts          # Provider + TranscriptRecord contract
│   │   ├── claude.ts         # Claude Code adapter (line-incremental)
│   │   ├── codex.ts          # Codex adapter (full-reparse)
│   │   ├── kimi.ts           # Kimi Code adapter (session projection)
│   │   └── pi.ts             # Pi adapter (tree-aware full-reparse)
│   ├── session-detail.ts     # Provider-independent transcript projection
│   ├── persist.ts            # Binding-agnostic record writer (upsert/merge)
│   ├── tx.ts                 # Write transaction + connection config
│   ├── write-coordinator.ts  # Bounded retry policy
│   ├── writer-lease.ts       # Cross-process single-writer lease (SQLite lock DB)
│   ├── core.ts               # buildIndex / searchText / executeQuery / executeAttune
│   ├── indexer.ts            # Skill orchestration (discover → persist → finalize)
│   ├── parsing.ts            # Pure helpers (node:sqlite-free, app-consumable)
│   ├── db.ts                 # node:sqlite lifecycle + migrations
│   ├── query.ts              # Query/attune sandbox API (helpers)
│   └── schema.sql            # SQLite schema (single source of truth)
├── package.json
└── dist/                     # Generated package JS, declarations, and schema

packages/cli/                 # @obelisk-apps/cli npm workspace
├── src/obelisk.ts            # CLI shell + skill installer delegation
├── scripts/build.mjs         # Compiles CLI + readable Core into one package
├── package.json
└── dist/                     # Generated platform-neutral npm payload

skill-doc/                    # Source for the docs-only obelisk agent skill
├── SKILL.md                  # Query and memory workflow
└── references/               # Progressive-disclosure API/schema/pattern docs
    └── recap/                # Per-card recap retrieval + writing references

app/                          # Electron desktop app (electron-vite + Vue)
├── src/main/                 # TypeScript main process (consumes shared core)
├── src/preload/              # CJS preload (sandbox)
├── src/renderer/             # Vue renderer
└── electron.vite.config.ts

packaging/                    # Skill publish infrastructure
├── build-skill.mjs           # Builds the docs-only skill artifact
├── skill-package.json
├── skill-README.md
├── skill-LICENSE             # MIT (relicensed for the skill artifact)
└── publish-skill.sh

SKILL.md                      # Remote one-time CLI + skill bootstrap guide
install.sh                    # POSIX CLI-only installer
CONTEXT.md                    # Project glossary
docs/adr/                     # Architecture decision records (0001–0006)
```

The optional `/obelisk recap` flow is loaded only for explicit `/obelisk recap` intent.
It starts at `skill-doc/references/recap/overview.md` and proceeds card-by-card:

- `skill-doc/references/recap/pattern1-cover.md` + `skill-doc/references/recap/writing1-cover.md`
- `skill-doc/references/recap/pattern2-thinking.md` + `skill-doc/references/recap/writing2-thinking.md`
- `skill-doc/references/recap/pattern3-vibe.md` + `skill-doc/references/recap/writing3-vibe.md`
- `skill-doc/references/recap/pattern4-workflow.md` + `skill-doc/references/recap/writing4-workflow.md`
- `skill-doc/references/recap/pattern5-closing.md` + `skill-doc/references/recap/writing5-closing.md`

### Generated build outputs

- `packages/core/dist/` is produced by `npm run build:core`. It is the compiled
  internal `@obelisk/core` workspace: JavaScript, type declarations, and
  `schema.sql`.
- `packages/cli/dist/` is produced by `npm run build:cli`. It is the publishable
  `@obelisk-apps/cli` payload: the thin command shell, readable compiled Core,
  and `schema.sql`.
- `dist/obelisk-skill/` is produced by `npm run build:skill`. It is the
  docs-only skill artifact: `SKILL.md`, references, and skill package metadata.
- Skill publishing stages that artifact at `skills/obelisk/` in the
  `obelisk-skill` repository; only `README.md` and `LICENSE` remain at the
  repository root for `npx skills` discovery.

Both directories are generated and should not be edited by hand. The Electron
app imports `packages/core/src/` directly so electron-vite can bundle Core.

## Implementation Notes

The index rebuilds incrementally — only new or modified JSONL files are re-parsed.
When the optional app is running, it is the active indexer: it watches Claude
project files and builds in a worker thread. A fresh `__app_heartbeat__` alone
means the daemon owns writes, so CLI invocations remain read-only; a separate SQLite
writer lease prevents cross-process writes from overlapping. The
`__app_last_successful_build__` marker records index freshness, not ownership.

The CLI has zero runtime npm dependencies and uses Node 22's built-in
`node:sqlite` with FTS5. The formal skill contains instructions and references,
not a second executable runtime.

20K lines of scattered JSONL → something the agent can search() and sql() against in milliseconds.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening
a PR — it is short, and it is written from what actually blocked past PRs rather
than from generic style rules.

The parts worth knowing up front:

- **Run every claim in your PR description end to end.** The most common reason a
  PR stalls here is a capability that is advertised but unreachable — including
  inputs shown in screenshots.
- **Assert the requirement, not the implementation.** Copy the sentence from the
  issue into your test name.
- **Transcript content is attacker-controlled.** Obelisk indexes third-party
  agent logs; anything reaching `shell.*`, `fs.*`, `innerHTML`, or DDL is
  deny-by-default.
- **Re-run verification after merging main.** A merge voids every result above
  it, including your own noted limitations.

`CONTRIBUTING.md` also carries hard constraints per area — renderer/Electron,
provider adapters, schema migrations, main process, and indexing/daemon
ownership. The PR template mirrors them as per-area checklists.

---

## Star History

<a href="https://www.star-history.com/?repos=tommy0103%2Fobelisk&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=tommy0103/obelisk&type=date&theme=dark&legend=top-left&sealed_token=zGsTpxirzDypxpaSUQ4aiPpCQFVFbII1Xl68UlRRpVdaTr6NoPY_cEvprnA9kMMdmXnERYZn3uXo20PkKEiuoGQ8d-qD3nPDanawRUrZuFYnNPytlC2iTw" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=tommy0103/obelisk&type=date&legend=top-left&sealed_token=zGsTpxirzDypxpaSUQ4aiPpCQFVFbII1Xl68UlRRpVdaTr6NoPY_cEvprnA9kMMdmXnERYZn3uXo20PkKEiuoGQ8d-qD3nPDanawRUrZuFYnNPytlC2iTw" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=tommy0103/obelisk&type=date&legend=top-left&sealed_token=zGsTpxirzDypxpaSUQ4aiPpCQFVFbII1Xl68UlRRpVdaTr6NoPY_cEvprnA9kMMdmXnERYZn3uXo20PkKEiuoGQ8d-qD3nPDanawRUrZuFYnNPytlC2iTw" />
 </picture>
</a>

## License

Copyright (C) 2026 tommy0103 and contributors.

Obelisk is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only); see [LICENSE](LICENSE). Derivative works are welcome: if you distribute a modified version, please keep the per-file copyright notices intact and mark your modifications prominently with a date, as AGPL-3.0 §5 requires.
