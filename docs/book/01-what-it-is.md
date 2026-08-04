# 第 1 章 · 它是什么：显式记忆与四个动词

## 一个每天都会发生的场景

你在改一个认证相关的 bug。改到一半想起来：三周前好像也碰过这块，当时试了个方案又放弃了，理由记不清了。

这段记忆在哪儿？它在你机器上——`~/.claude/projects/` 下某个 `.jsonl` 文件里，混在两万行别的东西中间。它没有丢，只是**不可达**。你可以 grep，但 grep 给不了你"哪次 session、什么时候、上下文是什么、当时的 subagent 得出了什么结论"。

Obelisk 处理的就是这件事：**把散落在本地的 agent 转写变成可查询的证据层**。

## 三层记忆，它只做后两层

谈 agent memory 的时候，通常混着三种完全不同的东西：

```text
① 隐式记忆 (implicit memory)
   自动注入上下文，静默影响 agent 行为
   用户常常不知道它用了什么、为什么用、有没有过期

② 可查询的会话记忆 (queryable session memory)
   agent 需要历史时主动查询
   证据来自真实 session、tool call、subagent、workflow
   回答可以追溯到"确实发生过的事"

③ 人类批准的长期记忆 (approved durable memory)
   只有值得长期保留的结论才沉淀
   markdown + 注册表，可读、可撤回、可审计
```

Obelisk **只做 ② 和 ③**，并且是有意识地不做 ①。

这不是"少做了一层"，是一个立场：coding agent 的记忆不应该默认是黑盒。第一层的问题在于，它悄悄想起一些东西，而你不知道它想起了什么、依据是什么、是不是已经过期了。

这个立场在代码里留下了可以核对的痕迹：

- **`schema.sql` 里没有 embedding、没有向量表。** 检索走的是 FTS5 全文索引和结构化 JOIN。你能读懂每一次召回是怎么发生的。
- **`memories` 表有 `deleted_at` 和 `deleted_reason` 两列**（`packages/core/src/schema.sql`）。忘记是一次**归档**，不是删除——记录留着，理由留着，随时可审计。而且 `forget()` 只归档注册记录，不动那个 markdown 文件。
- **记忆的正文是 markdown 文件，不是数据库里的 blob。** 数据库存的是路径、摘要和它来自哪几条消息（`message_start` / `message_end`）。你可以用任何编辑器打开、用 git 管起来。

代价也是明确的：查询要花当前 agent 的 context。这个成本没有被藏起来，它变成了**可见成本**——agent 明确地决定"我现在要查历史"，你能看到它查了什么。

## 四个动词

Obelisk 的公共接口小到可以一眼看完。打开 `packages/cli/src/obelisk.ts`，整个 CLI 是 71 行，除去 `--version`，命令分支只有五个，其中一个还是把安装工作转包给别人：

```text
obelisk --build            # 重建索引
obelisk --search "text"    # 全文检索
obelisk --query  <file.js> # 执行一段只读脚本
obelisk --attune <file.js> # 执行一段记忆写入脚本
obelisk install            # 委托给 skills 安装器
```

去掉 `install`，剩下四个就是全部的运行时契约：

```text
build
search(text)
query(code)
attune(code)
```

三件事值得马上注意。

**第一，`query(code)` 的参数是代码，不是查询条件。** 你不是在调一个带十几个参数的检索接口，你是在提交一小段 JavaScript，它会在本地一个沙箱里跑，返回 JSON。这是 Obelisk 最核心的设计选择，叫 CodeAct，第 10 章整章讲它。

**第二，`overview()`、`search()`、`context()`、`sql()`、`memories()` 这些东西不在这个列表里。** 它们是 helper，只存在于 `query(code)` 的沙箱内部，从不被提升为对外的工具。这条边界是刻意的：一旦把它们摊开成一组外部 tool，Obelisk 就从"记忆运行时"退化成了"普通检索插件"。

**第三，写入被单独隔离在 `attune` 里。** `--query` 的沙箱拿不到 `remember()` 和 `forget()`；`--attune` 的沙箱反过来拿不到 `search()`、`sql()`、`memories()`。想写一条记忆，你得先用 `--query` 查出需要的 ID，再用 `--attune` 单独提交一段窄脚本。两条路径在代码里是两个不同的 API 构造函数（`createQueryApi` / `createAttuneApi`，见 `packages/core/src/core.ts`）。

## 一个索引，两个使用面

同一个 `~/.obelisk/obelisk.sqlite`，两拨人在用：

```text
                  ~/.obelisk/obelisk.sqlite
                     ↑                ↑
             CLI + agent skill      Electron 桌面 App
             （给 agent 查）         （给人看）
```

**agent 那一面**：`obelisk` CLI 拥有本地运行时；另有一个纯文档的 skill，教 agent 怎么写查询脚本。注意这个分工——skill 里**没有任何可执行代码**，它只是指令和参考文档，所有动作都委托给已安装的 `obelisk` 命令。运行时的归属因此毫不含糊：npm 装运行时，skills 装指引。

**人那一面**：一个 Electron 应用，浏览 session、管理记忆、看用量统计和周报卡片。

两面读同一个库，但它们不是对等的：App 运行时会成为**活跃的索引者**，CLI 则退回只读。谁有资格写、竞态在哪里关闭，是第 13 章的内容。

## 它索引了什么

| 层 | 来源 | 捕获内容 |
|---|---|---|
| Sessions | Claude `<project>/<sessionId>.jsonl`；Codex `sessions/YYYY/MM/DD/*.jsonl`；Kimi session 目录 | 标题、项目、时间、git 分支、来源 |
| Messages | user + assistant 轮次 | 全文、模型、token 用量、父链 |
| Tool calls | 每一次工具调用 | 工具名、入参、文件路径 |
| Subagents | Claude `subagents/agent-<id>.jsonl`；Codex 子线程 | agent 类型、描述、完整对话 |
| Workflows | Claude `workflows/wf_<runId>.json` | 脚本、结果、agent 数量 |
| Memories | 注册过的 markdown 文件 | 结论 + 它来自哪次 session |

三个来源写进**同一套表**，不是三个数据库。行上带一个 `source` 值，非 Claude 的 ID 加来源前缀（`codex:`、`kimi:`）所以不会撞。

这个决定看起来只是省事，其实是整本书的伏笔：三种格式差异极大的转写，凭什么能落进同一张 `messages` 表？答案在第 4 章。

## 它不承诺什么

写清楚边界，比宣称能力更有用：

- **不做自动召回。** 不查就没有历史进你的上下文。
- **不做跨机同步。** 一切都在本地，`~/.obelisk/` 下。
- **不拥有源日志。** 索引是从 `~/.claude`、`~/.codex`、`~/.kimi-code` 读出来的投影；Obelisk 不改它们，也不负责它们的生命周期。
- **不做摘要代理。** 它不会替你先压缩一份"你需要知道的东西"再递过来。证据是原样的，综合由当前那个 agent 自己完成。

最后一条最容易被误读成缺陷，所以值得展开一句：coding 场景里的记忆往往不是固定的召回题，而是**调查题**。当前那个 agent 知道它卡在哪个文件、刚刚哪个测试挂了、用户这句话的真实意图是什么、哪条线索值得继续追。如果先由一个外部代理压缩成一个 packet 递过来，最容易丢的恰恰是"问题正在成形"的那部分细节。

> **当时**
>
> 2026-07-08 的一次产品定位讨论中，助手提议在 Obelisk 之上再加一层 memory broker 来节省 context。用户的判断是不加。收敛出的表述是：
>
> > "Traditional memory optimizes for invisible recall. Obelisk optimizes for situated investigation."
> > "context cost 不是隐藏掉了，而是变成可见成本。"
>
> 同一次会话里确立了三层记忆的分类，以及"Obelisk 有意识地拒绝第一层"这个立场。
> 出处：Codex session `019f4049`（提升 obelisk 影响力），2026-07-08。

## 这一章你应该带走的

1. Obelisk 是**显式**记忆：查询发生在明处，记忆的沉淀需要人批准。
2. 公共接口只有四个动词，helper 全部关在 `query(code)` 的沙箱里。
3. 读写在两个隔离的沙箱里，不共享 API。
4. 三种来源、一套表、一个索引文件；agent 和人共用它。

这一章讲的是系统的**外形**——从外面看它是什么。下一章拆开外壳，看它由哪些部件组成、这些部件之间的依赖是怎么定向的。
