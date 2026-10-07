<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/obelisk-wordmark-d.svg">
  <img src=".github/assets/obelisk-wordmark-l2.svg" alt="Obelisk" width="540">
</picture>

[![stars](https://img.shields.io/github/stars/tommy0103/obelisk?style=flat-square)](https://github.com/tommy0103/obelisk/stargazers)
[![version](https://img.shields.io/github/v/tag/tommy0103/obelisk?label=version&style=flat-square)](https://github.com/tommy0103/obelisk/releases)
[![license](https://img.shields.io/badge/license-AGPL--3.0-blue.svg?style=flat-square)](LICENSE)

过往的 Claude Code、Codex、GitHub Copilot、DeepSeek Harness、Hermes Agent、Kimi Code、OMP、Pi 和 ZCode 会话——你的 agent 可以查询，你可以浏览。

[English](README.md) · **中文**

</div>

<br />

Obelisk 把你本地的 coding-agent 历史索引进一个 SQLite 数据库，服务两类读者：

- **Agent** —— `obelisk` CLI 加上一个 agent skill，教 coding agent 检索自己的
  会话历史。agent 编写 JS 查询、在本地运行、用自然语言回答。
- **人** —— 一个 Electron 桌面应用，用来浏览会话、管理记忆、查看用量统计
  和每周回顾卡片。

两者读同一个 `~/.obelisk/obelisk.sqlite`，并通过监听所有已配置的 provider
目录保持更新。

2 万行散落的 JSONL → agent 可以用 `search()` 和 `sql()` 以毫秒级查询的东西。

## 在 agent 中使用

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

#### 让 agent 来安装（推荐）

最短路径是把引导指南直接交给一个有 shell 权限的 coding agent。把下面这段
作为提示词贴进 Claude Code、Codex 或其他 agent——而不是贴进你的终端：

```text
Install Obelisk by fetching and following this guide:
curl -fsSL https://raw.githubusercontent.com/tommy0103/obelisk/main/SKILL.md
```

agent 会先询问再改动你的机器，安装并验证 CLI，然后问你是否要为当前项目或
全局安装正式的 `/obelisk` skill。引导指南只用于一次性安装，它本身不是查询
用的 skill。

#### 手动安装

Obelisk 需要 Node.js 22.13 或更新版本。安装平台无关的 CLI（没有运行时 npm
依赖——使用 Node 内置的 SQLite）：

```bash
npm install --global @obelisk-apps/cli
obelisk --version
```

在 macOS、Linux 或 WSL 上，纯 CLI 安装脚本是等价的：

```bash
curl -fsSL https://raw.githubusercontent.com/tommy0103/obelisk/main/install.sh | sh
```

然后安装 agent skill：

```bash
obelisk install
```

`obelisk install` 会委托给 `tommy0103/obelisk-skill` 的标准 skills 安装器。
然后在任意 agent 会话里：`/obelisk <你的问题>`。首次运行会构建索引
（100 个会话约 5 秒），之后增量重建。

### 工作原理

```text
你提出一个问题
  ↓
Agent 针对 SQLite 索引编写 JS 查询
  ↓
通过 obelisk --query <script> 运行
  ↓
读取 JSON 结果，用自然语言回答
```

核心 API：`search()`、`context()`、`sql()`，以及结构化辅助方法（`sessions`、
`memories`、`summaries`、`workflows`、`failures`、`fileHistory` 等）。函数签名、
选项和查询模式见 [API 参考](skill-doc/references/api-reference.md)。

### 记忆层

当一次检索得出了值得保留的结论，agent 会提议一个 markdown 记忆文件。经你
批准后，通过 `obelisk --attune <script>` 注册。未来的会话可以用 `memories()`
召回——它是一个综合缓存，而不是原始证据的替代品。

### Recap

可选的 `/obelisk recap` 流程会把一段时间的会话变成可分享的每周/每月回顾卡片。
它只在显式的 recap 意图下加载参考文件：从
[skill-doc/references/recap/overview.md](skill-doc/references/recap/overview.md)
开始，逐张卡片进行。

## 在应用中浏览

<div align="center">
  <img src=".github/assets/app-screenshot.png" alt="Obelisk 应用" width="720">
</div>

- **Sessions** —— 搜索和筛选所有会话；可读的 tool call 展示（diff、终端输出、文件查看器）
- **Memory** —— 已注册记忆文件的列表与详情视图
- **Activity** —— GitHub 风格的热力图、每周/累计 token 图表
- **Recap** —— 可分享的每周/每月回顾卡片，带 archetype 主题
- **Settings** —— 数据源配置、自动刷新、重建索引

macOS 和 Linux amd64 的预编译版本见
[Releases](https://github.com/tommy0103/obelisk/releases)，支持应用内更新
（macOS 用 Sparkle，Debian 安装用 `DebUpdater`）。在 macOS、Windows 和
Linux 上也可以从源码运行——构建工具需要 Node.js 22.13+，应用本身运行在
Electron 内置的 Node 上：

```bash
git clone https://github.com/tommy0103/obelisk.git
cd obelisk/app
npm ci
npm run dev
```

调试、打包和发布流程属于维护者文档，见
[CONTRIBUTING.md](CONTRIBUTING.md#desktop-app-development-and-release)。

注意：桌面应用运行时持有索引的写入权，此时 CLI 调用保持只读。

## 索引了什么

每个 provider 都投影到同一组共享层级；少数层级只在来源工具有对应概念时存在：

| 层级 | 捕获内容 | 覆盖范围 |
|-------|--------|---------|
| **Sessions** | 标题、项目、时间戳、git 分支、来源 | 所有 provider |
| **Messages** | 完整文本、模型、token 用量、父链 | 所有 provider |
| **Tool calls** | 工具名、输入、文件路径 | 所有 provider |
| **Subagents** | agent 类型、描述、完整对话 | Claude Code、Codex、DeepSeek Harness、Hermes Agent、Kimi Code、ZCode |
| **Summaries** | provider 产生的会话摘要 | Kimi Code |
| **Workflows** | workflow 脚本、结果和每个 agent 的 transcript | Claude Code |
| **Memories** | 关联到来源会话的结论 | 注册的 markdown 文件 |

FTS5 全文搜索覆盖所有层级。各 provider 的读取位置见
[Provider 覆盖情况](#provider-覆盖情况)。

## Provider 覆盖情况

每个 provider 都索引进同一套 schema；行携带 `source` 值，非 Claude 的 ID
带有 provider 前缀，不会冲突。

| Provider | 默认数据来源 |
| --- | --- |
| Claude Code | `~/.claude/projects` |
| Codex | `~/.codex/sessions`、`~/.codex/archived_sessions` |
| GitHub Copilot | VS Code `User` 数据目录（Chronicle 存储 + workspace transcripts） |
| DeepSeek Harness | `~/.dsh/sessions`（或 `$DSH_HOME/sessions`） |
| Hermes Agent | `~/.hermes/state.db`（或 `$HERMES_HOME/state.db`） |
| Kimi Code | `~/.kimi-code/sessions`（或 `$KIMI_CODE_HOME/sessions`） |
| OMP | `~/.omp/agent/sessions` |
| Pi | `~/.pi/agent/sessions` |
| ZCode | `~/.zcode/cli/db/db.sqlite` |

当 provider 能证明历史被取代（superseded）时，Obelisk 会把它保留为普通
查询默认省略的 inactive 行；支持的查询辅助方法可以用 `includeInactive: true`
选择包含它们。

| Provider | 被取代历史的支持 |
| --- | --- |
| Pi | 分支、叶节点和压缩状态可证明 inactive 历史 |
| OMP | 分支、叶节点和压缩状态可证明 inactive 历史 |
| ZCode | rewind 保留范围和压缩可证明 inactive 历史 |
| Kimi Code | undo/clear 可证明取代；保留是后续工作 |
| Hermes Agent | 被取代的历史不再细分：压缩归档和 rewind 的行都存为 `inactive` |
| Claude Code | 来源不证明 rewind 或当前叶节点状态 |
| Codex | 会话没有分支语义 |

非默认位置——Pi 的 `--session-dir`、OMP 的自定义目录、VS Code Insiders 的
`User` 目录——可以在应用的 **Settings** 里选择。

适配器内部实现（identity 哈希、取代重放、各 provider 的目录发现）记录在
[检索语义](skill-doc/references/retrieval-semantics.md)和 [ADR](docs/adr/) 中。

## 参与贡献

欢迎贡献。提交 PR 前请读 [CONTRIBUTING.md](CONTRIBUTING.md)——它很短，
而且是从过去真实卡住 PR 的原因里写出来的，不是泛泛的风格规则。值得提前
知道的部分：

- **端到端跑通 PR 描述里的每一句话。** PR 卡住最常见的原因是宣称的能力
  实际上触达不到——包括截图里出现的输入。
- **断言需求，而不是实现。** 把 issue 里的原句复制进测试名。
- **transcript 内容视为攻击者可控。** Obelisk 索引的是第三方 agent 的日志；
  任何流向 `shell.*`、`fs.*`、`innerHTML` 或 DDL 的路径都默认拒绝。
- **合并 main 之后重跑验证。** 合并会使之前所有结论失效，包括你自己注明
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

Obelisk 以 GNU Affero General Public License v3.0（AGPL-3.0-only）发布，见
[LICENSE](LICENSE)。欢迎衍生作品：如果你分发修改后的版本，请保留逐文件的
版权声明，并按 AGPL-3.0 §5 的要求显著标注你的修改和日期。
