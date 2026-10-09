<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/obelisk-wordmark-d.svg">
  <img src=".github/assets/obelisk-wordmark-l2.svg" alt="Obelisk" width="540">
</picture>

[![stars](https://img.shields.io/github/stars/tommy0103/obelisk?style=flat-square)](https://github.com/tommy0103/obelisk/stargazers)
[![version](https://img.shields.io/github/v/tag/tommy0103/obelisk?label=version&style=flat-square)](https://github.com/tommy0103/obelisk/releases)
[![license](https://img.shields.io/badge/license-AGPL--3.0-blue.svg?style=flat-square)](LICENSE)

你的 Claude Code、Codex、GitHub Copilot、DeepSeek Harness、Hermes Agent、Kiro、Kimi Code、OMP、Pi、ZCode 历史会话——agent 快速查询，你浏览它们。

[English](README.md) · **中文**

</div>

<br />

Obelisk 把本地各种 coding agent 的历史会话统一索引进一个 SQLite 数据库，使得两种上游都可以使用：

- **Agent**：提供 `obelisk` CLI 和相应的 agent skill，让 coding agent 学会查自己的历史——它现场写 JS 查询，本地执行，然后组织语言回答你。
- **你**：提供一个 Electron 桌面应用，你可以翻会话、管记忆、看 token 用量、收每周回顾卡片。

读的是同一个 `~/.obelisk/obelisk.sqlite`，后台监听各 provider 的目录自动更新。

让 2 万行散落的 JSONL，变成 agent 用 `search()` 和 `sql()` 毫秒级查询的索引。

## 在 agent 里用

<div align="center">
  <img src=".github/assets/demo.png" alt="Obelisk skill 演示" width="720">
</div>

```text
/obelisk 上次 auth bug 最后到底改了哪些文件，为什么这么改
/obelisk 这个文件最近在哪些 sessions 里被反复修改
/obelisk 找出最近失败的 tool calls，它们分别发生在哪些任务里
/obelisk 那个 review workflow 的 subagents 各自结论是什么
/obelisk recap this week
```

### 安装

#### 让 agent 装（推荐）

最快速的办法：把下面这段话原样发给一个有 shell 权限的 coding agent
（Claude Code、Codex 之类）。注意是发给 agent，不是贴进终端：

```text
Install Obelisk by fetching and following this guide:
curl -fsSL https://raw.githubusercontent.com/tommy0103/obelisk/main/SKILL.md
```

agent 会先问你、再动手：装好并验证 CLI 之后，再问你要把正式的 `/obelisk`
skill 装在当前项目还是全局。

#### 手动装

需要 Node.js 22.13+。CLI 没有运行时 npm 依赖，用的是 Node 内置的 SQLite：

```bash
npm install --global @obelisk-apps/cli
obelisk --version
```

CLI 0.3.1+ 会自动安装 agent skill，无需交互：`npm install --global` 安装到
用户全局，普通 `npm install` 安装到调用 npm 的项目。设置
`OBELISK_SKIP_SKILL_INSTALL=1` 可以只装 CLI。skill 安装失败不影响 CLI；可用
`obelisk install --global --yes`（全局）或 `npx --no-install obelisk install --yes`（项目）重试。
加上 npm 的 `--foreground-scripts` 可以查看安装输出。

macOS、Linux、WSL 也可以用只安装 CLI 的一键脚本：

```bash
curl -fsSL https://raw.githubusercontent.com/tommy0103/obelisk/main/install.sh | sh
```

只装了 CLI，或想另选 skill 的安装范围时：

```bash
obelisk install
```

`obelisk install` 实际调的是 `tommy0103/obelisk-skill` 的标准 skills 安装器。
装完后在任意 agent 会话里直接 `/obelisk <你的问题>`。第一次运行会建索引
（100 个会话大约 5 秒），之后都是增量更新。

### 工作原理

```text
你提问
  ↓
agent 针对 SQLite 索引写一段 JS 查询
  ↓
通过 obelisk --query <script> 执行
  ↓
读 JSON 结果，用人话回答
```

默认查询接口（CLI 0.3.0+）为 `overview()`、`sessions()`、`search()`、
`messages()`、`memories()`、`summaries()` 和 `sql()`。
专题 helper 和旧脚本接口仍可使用。
签名、参数和查询范例都在 [API 参考](skill-doc/references/api-reference.md)里。

### 记忆层

如果一次检索得出了值得留下的结论，agent 会提议写一个 markdown 记忆文件；
你确认后，它用 `obelisk --attune <script>` 注册进去，以后的会话里
`memories()` 就能召回。它是结论的缓存，不替代原始记录。

### Recap

`/obelisk recap` 是可选功能：把一段时间的会话做成可分享的周报/月报卡片。
只有明确说要 recap 时才会加载对应文档。入口是
[skill-doc/references/recap/overview.md](skill-doc/references/recap/overview.md)，
之后一张一张卡片往下走。

## 桌面应用

<div align="center">
  <img src=".github/assets/app-screenshot.png" alt="Obelisk 应用" width="720">
</div>

- **Sessions** —— 搜索、按项目筛选所有会话；tool call 可读化展示（diff、终端输出、文件查看器）
- **Memory** —— 记忆文件的列表和详情
- **Activity** —— GitHub 风格热力图、每周/累计 token 图表
- **Recap** —— 可分享的周报/月报卡片，带 archetype 主题
- **Settings** —— 数据源、自动刷新、重建索引

macOS 和 Linux amd64 有预编译包，见
[Releases](https://github.com/tommy0103/obelisk/releases)，支持应用内更新
（macOS 走 Sparkle，Debian 包走 `DebUpdater`）。三个平台也都能跑源码——
构建需要 Node.js 22.13+，应用本身用的是 Electron 内置的 Node：

```bash
git clone https://github.com/tommy0103/obelisk.git
cd obelisk/app
npm ci
npm run dev
```

调试、打包、发布这些维护者向的内容在
[CONTRIBUTING.md](CONTRIBUTING.md#desktop-app-development-and-release) 里。

请注意：桌面应用开着的时候，索引写入由它独占，这时 CLI 是只读的。

## 索引内容

所有 provider 都写进同一组表；有几张表只在来源工具有这个概念时才有数据：

| 表 | 内容 | 哪些 provider 有 |
|----|------|------------------|
| **Sessions** | 标题、项目、时间戳、git 分支、来源 | 全部 |
| **Messages** | 完整文本、模型、token 用量、父子链 | 全部 |
| **Tool calls** | 工具名、输入、文件路径 | 全部 |
| **Subagents** | agent 类型、描述、完整对话 | Claude Code、Codex、DeepSeek Harness、Hermes Agent、Kiro V3、Kimi Code、ZCode |
| **Summaries** | provider 自己产生的会话摘要 | Kiro V3、Kimi Code |
| **Workflows** | workflow 脚本、结果、每个 agent 的记录 | Claude Code |
| **Memories** | 结论及其来源会话 | 注册的 markdown 文件 |

全文搜索（FTS5）覆盖所有表。每个 provider 具体从哪读，见下面
「[支持的 Provider](#支持的-provider)」。

## 支持的 Provider

所有 provider 共用一套 schema：每行带 `source`，非 Claude 的 ID 带
provider 前缀，不会撞。

| Provider | 默认读取位置 |
| --- | --- |
| Claude Code | `~/.claude/projects` |
| Codex | `~/.codex/sessions`、`~/.codex/archived_sessions` |
| GitHub Copilot | VS Code `User` 数据目录（Chronicle 存储 + workspace transcripts） |
| DeepSeek Harness | `~/.dsh/sessions`（或 `$DSH_HOME/sessions`） |
| Hermes Agent | `~/.hermes/state.db`（或 `$HERMES_HOME/state.db`） |
| Kiro | `~/.kiro/sessions` 和平台 `kiro-cli/data.sqlite3` 数据库 |
| Kimi Code | `~/.kimi-code/sessions`（或 `$KIMI_CODE_HOME/sessions`） |
| OMP | `~/.omp/agent/sessions` |
| Pi | `~/.pi/agent/sessions` |
| ZCode | `~/.zcode/cli/db/db.sqlite` |

如果来源工具能标记哪些历史被覆盖了，Obelisk 会把这些旧记录存成
inactive——默认查询看不到，支持的查询方法可以用 `includeInactive: true`
显式带上：

| Provider | 被覆盖历史的处理 |
| --- | --- |
| Pi | 分支、叶子、压缩状态都能判定 inactive |
| OMP | 分支、叶子、压缩状态都能判定 inactive |
| ZCode | rewind 保留区间和压缩可判定 inactive |
| Kimi Code | undo/clear 可判定覆盖；保留实现还在路上 |
| Hermes Agent | 不细分：压缩归档和 rewind 的行都存为 `inactive` |
| Claude Code | 来源本身不标记 rewind / 当前叶子状态 |
| Codex | 会话没有分支概念 |

非默认位置——比如 Pi 的 `--session-dir`、OMP 的自定义目录、VS Code
Insiders 的 `User` 目录——可以在应用的 **Settings** 里手动选。

适配器的内部细节（identity 哈希、覆盖重放、各 provider 的目录发现逻辑）见
[检索语义](skill-doc/references/retrieval-semantics.md)和 [ADR](docs/adr/)。

## 参与贡献

欢迎贡献，提交 PR 前请先读 [CONTRIBUTING.md](CONTRIBUTING.md)。它不长，
写的都是过去真实卡住 PR 的坑，不是泛泛的风格指南。几条核心：

- **PR 描述里的每句话都要端到端跑通过。** 卡住最常见的原因，是宣称的
  能力其实到不了——包括截图里的输入。
- **断言需求本身，而不是实现的形状。** 把 issue 里的原话抄进测试名。
- **transcript 内容一律视为不可信。** Obelisk 索引的是第三方 agent 的日志，
  任何流向 `shell.*`、`fs.*`、`innerHTML` 或 DDL 的路径默认拒绝。
- **合完 main 要重跑验证。** 合并之后之前的结论全部作废，包括你自己写过
  的"已知限制"。

---

## Star History

<a href="https://www.star-history.com/?repos=tommy0103%2Fobelisk&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=tommy0103/obelisk&type=date&theme=dark&legend=top-left&sealed_token=zGsTpxirzDypxpaSUQ4aiPpCQFVFbII1Xl68UlRRpVdaTr6NoPY_cEvprnA9kMMdmXnERYZn3uXo20PkKEiuoGQ8d-qD3nPDanawRUrZuFYnNPytlC2iTw" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=tommy0103/obelisk&type=date&legend=top-left&sealed_token=zGsTpxirzDypxpaSUQ4aiPpCQFVFbII1Xl68UlRRpVdaTr6NoPY_cEvprnA9kMMdmXnERYZn3uXo20PkKEiuoGQ8d-qD3nPDanawRUrZuFYnNPytlC2iTw" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=tommy0103/obelisk&type=date&legend=top-left&sealed_token=zGsTpxirzDypxpaSUQ4aiPpCQFVFbII1Xl68UlRRpVdaTr6NoPY_cEvprnA9kMMdmXnERYZn3uXo20PkKEiuoGQ8d-qD3nPDanawRUrZuFYnNPytlC2iTw" />
 </picture>
</a>

## 许可证

Copyright (C) 2026 tommy0103 and contributors.

Obelisk 采用 AGPL-3.0-only 许可证，见 [LICENSE](LICENSE)。欢迎二次开发：
分发修改版时请保留各文件头部的版权声明，并按 AGPL-3.0 §5 的要求明确标注
你的修改和日期。
