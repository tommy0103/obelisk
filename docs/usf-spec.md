# USF（Universal Session Format）规格说明

**版本：** 1（草稿）

**状态：** 草稿，用于讨论。装配和校验的参考实现在 `packages/core/src/usf.ts`（`assembleUsf`、`publishedUsf`、`validateUsf`），还没有接进索引和应用；遮盖、回合 ID、入库和 ATIF 导出在 Cairn 的原型里

**日期：** 2026-11-17

## 1. 概述

USF（Universal Session Format，通用 session 格式）是一条 session 的公开、带版本号的统一表示。adapter 把各家 harness 的记录变成它，使用方只读它：

- Obelisk 的索引（由 persist 把它写成 SQLite 的行）
- 桌面应用的 session 详情
- Cairn 发布的快照
- 导出成 ATIF（Agent Trajectory Interchange Format）

现有的 `TranscriptRecord`（`packages/core/src/providers/types.ts`）不直接充当这个角色，原因是它面向 SQLite：

- 工具调用和它的结果是两条分开的记录，靠 ID 关联；子 agent 和工作流又是另外的记录。
- 里面有只对索引有意义的记录：`message-turn-duration`、`delete-session`，以及带本机路径和计数方式的 `session`。
- “这条用户消息是不是人打的”要从 `role`、`is_meta`、是否带工具结果三处推断。
- 没有回合。

`assembleSessionDetail()` 已经在做一部分装配（消息带着工具调用，调用带着结果、子 agent 和工作流）。USF 可以看成把这个形状定成公开格式，再加上回合。

## 2. 目标和非目标

目标：

- 一条 session 只有一种公开形态，和 harness 无关。
- 回合是一等公民：人每提交一次开始一个回合，到下一次提交之前的所有内容都属于它。
- 回合里面是按顺序排列的步骤，不再分层。工具调用和它的结果在同一个步骤里。
- 文本不截断。
- 写法是字节级确定的（见第 6 节），所以可以对回合算哈希。
- 能导出成 ATIF（见第 8 节）。

非目标：

- 不替代 SQLite 的表结构。行仍然由 persist 从 USF 派生。
- 不保证能从 ATIF 导入。
- 不记录训练用的数据（token ID、对数概率）。
- 不把回合里的步骤再按“一次模型调用”分组。agent 回应人的一条消息通常要调用模型很多次，每次调用的输出在这里是相邻的几个步骤，不单独成一层。

## 3. 结构

三层：session、回合、步骤。

```json
{
  "usf": 1,
  "harness": { "name": "claude", "version": "2.1.0" },
  "id": "…",
  "title": "…",
  "git_branch": "main",
  "turns": [
    {
      "steps": [
        { "by": "human", "id": "u1", "at": "2026-03-01T10:00:00.000Z", "content": "把登录改成 OAuth" },
        { "by": "agent", "kind": "reasoning", "id": "a1", "at": "2026-03-01T10:00:03.000Z", "model": "…", "content": "先看现有实现。" },
        { "by": "agent", "kind": "text", "id": "a2", "at": "2026-03-01T10:00:04.000Z", "model": "…", "content": "我先读一下 auth 模块。" },
        {
          "by": "agent", "kind": "tool", "id": "a3", "at": "2026-03-01T10:00:04.000Z", "model": "…",
          "tool": { "id": "c1", "name": "Read", "input": { "file_path": "src/auth.ts" } },
          "file": "src/auth.ts",
          "result": { "at": "2026-03-01T10:00:05.000Z", "content": "…", "error": false }
        },
        { "by": "harness", "kind": "compaction", "id": "h1", "at": "…", "content": "……摘要……" }
      ]
    }
  ]
}
```

### 3.1 Session

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `usf` | 整数 | 格式版本，现在是 1 |
| `harness` | `{ name, version }` | 产生这条 session 的 harness。`name` 就是现在的 `source` |
| `id` | 字符串 | session 的 ID |
| `title` | 字符串或 null | |
| `git_branch` | 字符串或 null | session 所在的 git 分支。adapter 现在每条 session 只给一个值 |
| `turns` | 回合的数组 | 按顺序 |

本机信息（`jsonl_path`、项目路径）不在 USF 里，由使用方另外保存。

单独存成文件时，文件名用 `.usf.json` 结尾。

### 3.2 回合

一个回合从一个 `human` 步骤开始，到下一个 `human` 步骤之前为止。第一次提交之前如果有步骤，它们属于第一个回合，排在那个 `human` 步骤前面。

回合只有一个字段 `steps`。回合 ID、父回合这些属于发布形态，见第 7 节。

### 3.3 步骤

每个步骤都有：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `by` | `human`、`agent`、`harness` | 谁产生的 |
| `id` | 字符串 | 在这条 session 内唯一。有 harness 自己的 ID 就用它 |
| `at` | 时间或 null | 写法见第 4 节。harness 在这个位置写的东西如果读不成时间，按没有处理 |
| `state` | `inactive`、`hidden`，或者没有 | 只在本地形态里出现，含义同 ADR-0007 的 `visibility`。没有这个字段就是当前可见 |
| `skill` | 字符串，或者没有 | harness 标注的、这个步骤归属的 skill 的名字 |

**`human`：人提交的内容。** 只多一个字段 `content`（见 3.5）。带回工具结果的消息、harness 自己写的消息都不是 `human`。一次提交是一个步骤：文字加图片这样的几个部分放在同一个 `content` 里，不拆成几个步骤。

**`agent`：模型输出的一段。** 用 `kind` 区分：

| `kind` | 多出的字段 | 说明 |
| --- | --- | --- |
| `text` | `content` | 正文 |
| `reasoning` | `content` | 推理的文字 |
| `tool` | `tool`、`presentation`、`file`、`result`、`run` | 一次工具调用，见 3.4 |
| `run` | `run` | 一个子 agent 的运行，记录里没有说是哪次调用启动的，见 3.4 |

`text` 和 `reasoning` 的 `content` 可以是空字符串：harness 记下了这次输出，但没有留下文字（Claude Code 的推理常常是这样）。这样的步骤要保留，它说明模型在这里被调用过。只带工具调用、没有文字的消息不单独成步骤，工具调用本身就是步骤。

`agent` 步骤另有两个可选字段：`model`（模型名）和 `usage`（`{ input, cached, output }`，都是整数；`input` 包含缓存命中的部分，`cached` 是其中命中缓存的数量）。`run` 步骤没有这两个字段，用量在子 agent 自己的步骤上。

一条模型消息里发起几个工具调用时，每个调用是一个步骤，这条消息的 `usage` 只写在第一个上。USF 里没有“同一条消息”这一层。

**`harness`：harness 自己放进上下文的内容。**

| 字段 | 说明 |
| --- | --- |
| `kind` | `compaction`（压缩后留下的摘要）、`recap`（人离开一阵后的回顾）、`interruption`（请求被打断）、`command`（斜杠命令的外壳）、`reminder`（系统提醒）、`skill`（skill 的说明文字）、`attachment`（附带的文件）、`task`（交给子 agent 的任务）、`error`（模型调用失败时 harness 写下的错误）、`result`（一条工具结果，发起它的调用不在记录里）、`other` |
| `content` | 见 3.5 |
| `model`、`usage` | 可选，含义同 `agent` 步骤。harness 自己调用模型时才有，比如压缩 |

harness 用助手的身份写的通知（切换模型的提示之类）也是 `harness` 步骤，不是 `agent` 步骤。

### 3.4 工具调用

`kind` 是 `tool` 的步骤：

| 字段 | 说明 |
| --- | --- |
| `tool` | `{ id, name, input }`。`input` 是 JSON 值，不是 JSON 文本 |
| `presentation` | `skill`，或者没有。表示这次调用是在启动一个 skill；桌面应用靠它决定怎么展示 |
| `file` | 这次调用操作的文件的路径，没有就省略。由 adapter 按各家工具的输入给出，使用方不需要知道每种工具把路径放在哪个参数里 |
| `result` | `{ at, content, error }`。`error` 是布尔值。还没有结果时省略 |
| `run` | 这次调用启动的子 agent：`{ agent: { id, type, description }, steps: [...] }`。`steps` 里的步骤和上面相同，但没有 `human`；交给它的任务是一个 `kind: "task"` 的 `harness` 步骤 |

结果挂在调用上，不是单独的步骤。结果回来的时间写在 `result.at`。只有一种例外：结果在，发起它的调用不在记录里，这时它是一个 `kind: "result"` 的 `harness` 步骤，出错与否写在 `extra.error`。

子 agent 的运行有两种写法：

- 记录说明了是哪次调用启动的：挂在那个调用的 `run` 上。
- 记录没有说明：单独成一个 `kind: "run"` 的 `agent` 步骤，只有 `run` 一个内容字段，`id` 用子 agent 的 ID。它排在它自己第一个步骤的时间所在的位置。

两种写法里 `run` 的形状相同，子 agent 还可以再有自己的子 agent。USF 不去猜一个没有说明来源的子 agent 属于哪次调用。

### 3.5 内容

内容是字符串，或者分段的数组：

- `{ "type": "text", "text": "…" }`
- `{ "type": "image", "media_type": "image/png", "blob": { "sha256": "…", "bytes": 12345 } }`
- `{ "type": "file", "media_type": "…", "blob": { … } }`

图片和很大的内容单独存放，USF 里只有它的哈希和大小。USF 不规定这些内容存在哪里。

## 4. 规则

- 时间按 RFC 3339 写：日期、`T`、时间，再加 `Z` 或时区偏移，推荐 `YYYY-MM-DDTHH:mm:ss.sssZ`。读不成时间的值不是时间，写 `null`。
- 步骤的顺序是 adapter 给出记录的顺序，不按时间重排。时间可以没有，也可以相同，顺序不能靠它。
- 数字只有整数。
- 文本不截断。Obelisk 的索引要不要截断，是 persist 写行时的事（这和 ADR-0007 的往返不变有关，见第 9 节）。
- 没有的字段省略，不写 `null`。例外是 `at`、`title` 和 `git_branch`，没有时写 `null`。
- 不认识的字段不允许出现。扩展只能放在每个步骤可选的 `extra` 对象里，`extra` 的内容同样受“只有整数、不截断”的约束。

## 5. 从现有记录怎么得到

| USF | 现有记录 | 缺什么 |
| --- | --- | --- |
| 回合的划分 | `human` 步骤的位置 | |
| `human` 步骤 | `message`：`role` 是 `user`、不是注入、`content_type` 不是 `tool_result`、不在子 agent 里。紧挨着、时间相同、并且把前一条当作父消息的几条，是同一次提交的几个部分，合成一个步骤 | Claude 的 adapter 没有把压缩摘要和打断标记标成注入。“几个部分”没有明确的标记，只能靠这三个条件认 |
| `harness` 步骤 | `is_meta` 的 `message`（不论角色）、角色不是 `user` 也不是 `assistant` 的 `message`、`content_type` 是 `error` 的 `message`，以及 `summary` | `kind` 只有几种能从记录得到：`skill` 和 `error` 看 `content_type`，`task` 看是不是子 agent 里的用户消息，`compaction` 和 `recap` 看 `summary` 的 `source`。其余一律是 `other`。按 ADR-0007，装配不读消息的文字去猜，所以 `interruption`、`command`、`reminder`、`attachment` 要等 adapter 给出来 |
| `agent` 步骤，`text` 和 `reasoning` | `content_type` 是 `text`、`thinking` 的助手 `message`，包括 `text` 为空的 | |
| `agent` 步骤，`tool` | `tool_call`，加上 `tool_use_id` 相同的 `tool_result`。`content_type` 是 `tool_result` 的 `message` 自己不成步骤，除非它的文字和结果不一样 | |
| `harness` 步骤，`result` | 找不到 `tool_call` 的 `tool_result` | |
| `file` | `tool_call` 的 `file_path`，没有时用 `tool_result` 的 | |
| `presentation` | `tool_call` 的 `presentation` | |
| `skill` | `message` 的 `skill`；工具步骤用它所在消息的 | |
| `git_branch` | `session` 的 `git_branch` | 原始记录里每条都有分支，adapter 只留了最后一个 |
| `model`、`usage` | `message` 的 `model`、`input_tokens`、`output_tokens` | 没有单独的缓存命中数；用量有重复，见第 10 节 |
| `run` | `subagent` 记录，加上这个子 agent 的 `message`：或者在同一条 session 里带着它的 `agent_id`，或者它本身是另一条 session，ID 就是 `agent_id`。`parent_tool_use_id` 有值就挂在那个调用上，没有就是 `run` 步骤 | 样本里有子 agent 的 8 个 adapter，只有 4 个给了 `parent_tool_use_id`，见 5.1 |
| `state` | `visibility` | Claude 的 adapter 把所有消息都标成可见 |
| 图片、附带的文件 | 没有 | adapter 现在不输出 |

这张表里的装配不需要 adapter 提供新的信息就能做出来。“缺什么”一栏是做出来之后仍然不对或不全的地方。

装配截在 persist 前面：输入就是 adapter 交给 persist 的那些 `TranscriptRecord`，对所有 adapter 是同一套规则，不看是哪个 harness，也不读消息的文字。和 persist 不同的是，它要一条 session 所有 unit 的记录凑齐，而且必须是完整解析（`cursor = null`）得到的，增量解析的记录会被拒绝。

现有记录里没有带进 USF 的：`workflow` 和 `workflow_agent`（见第 11 节）、`message-turn-duration`、`message` 的 `cwd`、`parent_uuid`、`is_sidechain`。

是别的 session 的子 agent 的 session，嵌在上级的 `run` 里，不再单独导出；上级不在时才单独成一条。

### 5.1 在 12 个 adapter 上的检验

这张表的装配在 Obelisk 自己的测试样本上跑过一遍：12 个 adapter，26 组样本，72 条 session。每一条 `message`、`tool_call`、`tool_result`、`summary`、`subagent` 记录都落进了某个步骤，token 数的合计对得上；转出来的 USF 通过校验，能遮盖、能算回合 ID、能拆成数据库的行，导出的 ATIF 全部通过 Harbor 的参考校验器。样本是测试用的小样本，不是真实使用的数据量。

装配的规则对所有 adapter 是同一套，没有哪一条是为某个 harness 写的。但各 adapter 给记录的方式并不一致，下面这些现在由装配来兜，放进 Obelisk 时值得在 adapter 这一侧统一：

| 不一致的地方 | 现状 |
| --- | --- |
| 子 agent 是哪次调用启动的 | Claude、Codex、Kimi、Kiro 给了；DeepSeek、Hermes、OpenCode、ZCode 没有给，这些子 agent 只能写成 `run` 步骤。其余 4 个的样本里没有子 agent |
| 交给子 agent 的任务 | 多数是一条普通的用户消息；Kimi 把它标成注入；Kiro 用 `system` 角色 |
| 带回工具结果的消息 | 角色有 `user`，也有 `toolResult`（OMP、Pi）；有的把结果的文字在消息上再写一遍；Hermes 里有结果挂在助手消息上、调用不在记录里 |
| harness 写的通知 | ZCode、Hermes 用助手角色加 `is_meta`；Kiro、OpenCode 用 `system` 角色 |
| 一条消息的几个部分 | Pi 每个内容块给一条记录，其余 adapter 一条消息一条记录 |
| 记录的顺序 | 没有约定必须按时间；Kiro 有一处不按时间。Obelisk 的应用是按时间排的 |
| `summary` 的 `source` | 没有统一的词表：`away_summary`、`compaction`、`kiro:compaction`、`pi:compaction`、`copilot`。Kiro 把分支对话（tangent）的回答也记成了压缩 |
| 图片 | 只有 Pi 给了一个占位的文字，其余不给 |

## 6. 确定的写法

对回合算哈希时，写法用 RFC 8785（JSON Canonicalization Scheme）：键按 UTF-16 码元排序，没有空白，字符串按 ECMAScript 的 `JSON.stringify` 转义。字符串必须是合法的 Unicode。

“现有记录 → USF”的装配在 `packages/core/src/usf.ts`，12 个 adapter 的样本都跑过（见 5.1）。Cairn 的原型在它上面实现了遮盖、回合 ID、从 USF 入库和 ATIF 导出，并用同样的写法在 JavaScript 和 Go 之间对过回合 ID；导出的 ATIF 通过了 Harbor 的参考校验器。

## 7. 两种形态

| | 本地形态 | 发布形态 |
| --- | --- | --- |
| 用在哪 | Obelisk 的索引和应用 | Cairn 的快照 |
| 范围 | 全部步骤，可以带 `state` | 只有当前可见的步骤，没有 `state` |
| 敏感内容 | 原样 | 已遮盖。步骤可以带 `masks`，记下每个占位符在哪个字段、什么位置 |
| 回合 | 只有 `steps` | 另有 `v`、`parent` 和回合 ID，ID 是回合内容的哈希 |

发布形态的其余规定（遮盖、推送）属于 Cairn，不在这份文档里。session 级别的字段（`title`、`git_branch`）不在回合里，发布时放在哪由 Cairn 定。

## 8. 导出成 ATIF

对照的是 ATIF 1.8。ATIF 的一个 step 本意是一次模型调用；这里按一个步骤导出一个 step，所以一次模型调用可能变成相邻的几个 step。ATIF 的结构允许这样写，`llm_call_count` 不填。

| USF | ATIF |
| --- | --- |
| session | 根对象：`schema_version`、`session_id`、`agent.name`、`agent.version` |
| `human` 步骤 | `source: "user"` 的 step，`message` 是内容 |
| `harness` 步骤 | `source: "system"` 的 step，`message` 是内容 |
| `harness` 步骤，`kind: "compaction"` | 同上，另加 `extra.context_management = { type: "compaction", boundary: "replace" }` |
| `agent` 步骤，`text` | `source: "agent"` 的 step，`message` 是内容 |
| `agent` 步骤，`reasoning` | `source: "agent"` 的 step，`message` 是空字符串，`reasoning_content` 是内容 |
| `agent` 步骤，`tool` | `source: "agent"` 的 step，`message` 是空字符串；`tool_calls` 里一项（`tool_call_id`、`function_name`、`arguments`，`input` 不是对象时包成 `{ "input": … }`）；`observation.results` 里一项（`source_call_id`、`content`，`error` 放进 `extra.is_error`）；`file` 和 `presentation` 放进这个调用的 `extra` |
| `run`（挂在调用上的） | 根对象的 `subagent_trajectories[]` 里的一条轨迹，`trajectory_id` 用 `agent.id`；对应的结果带 `subagent_trajectory_ref` |
| `agent` 步骤，`run` | `source: "agent"` 的 step，`message` 是空字符串；`observation.results` 里一项，只带 `subagent_trajectory_ref` |
| `harness` 步骤的 `model`、`usage` | step 的 `extra.model`、`extra.usage`（ATIF 只允许 agent 的 step 带模型和用量） |
| `model`、`usage` | `model_name`；`metrics`：`prompt_tokens`、`cached_tokens`、`completion_tokens` |
| 图片 | `ContentPart`，`source.path` 填使用方给的地址 |
| 步骤的顺序 | `step_id` 从 1 连续编号，跨回合不重新开始 |
| 回合的边界和 ID | 每个 step 的 `extra.turn` |
| `skill` | step 的 `extra.skill` |
| `git_branch` | 根对象的 `extra.git_branch` |

导出时丢掉的：`state` 不是当前可见的步骤；`kind` 里 ATIF 没有对应约定的那些（保留在 `extra.kind`）。

ATIF 不允许没有 step 的轨迹。所以一条没有步骤的 session 不导出；一个没有步骤的子 agent 不单独成轨迹，只在指向它的 step 的 `extra.subagent` 里留下它的描述。

另一个打算支持的导出目标是 Hugging Face 的 session trace 格式，Hub 上的查看器认它。它只有消息这一层，没有回合、工具是否出错、子 agent 的概念，所以只用于展示。还没有做。

## 9. 还没定的

只有一条，不影响现在继续做：

- **和 ADR-0007 的关系。** ADR-0007 规定直接装配和经过 SQLite 往返后装配必须相同。USF 不截断，而索引现在按上限截断。等 USF 接进 persist 的时候再定：要么索引也存全文，要么这条不变量重新表述。

## 10. 已经按默认做法处理的

下面这些草稿里已经有了做法，有不同意见再改：

- **怎么得到 USF**：adapter 不动，把现有记录统一转换成 USF。
- **第一次提交之前的步骤**并入第一个回合。
- **步骤的顺序**用 adapter 给出记录的顺序。
- **一条消息里的多个工具调用**各成一步，不保留“同一条消息”。后果是按消息计数时，Obelisk 的索引算一条，从 USF 得到的算每个调用一条。
- **`extra`** 保留，只允许出现在步骤上，受和其他字段相同的约束。
- **用量**原样保留在 `usage` 里。Claude Code 把一次模型调用的输出写成几条记录，每条都带着这次调用的用量（这台机器的 6 条 session 里，1,054 次模型调用有 814 次是这样，逐条相加的输出 token 数是按调用计一次的 2.57 倍），所以 `usage` 不能直接相加。以后需要准确的合计时，给 `agent` 步骤加一个可选字段标明属于哪一次调用即可，不需要改结构。上一条里按消息计数的差别也可以用同一个字段消掉。

## 11. 遇到再说的

- 工作流（Claude 的 workflow 运行记录）怎么表示。`workflow` 和 `workflow_agent` 记录现在不读：工作流里的子 agent 写成 `run` 步骤，它们属于哪次调用、阶段和状态都没有带上。一次调用启动多个子 agent 时，`run` 只能挂一个，要带上这层关系就得让它能挂多个。
- 没有步骤的子 agent、单独存在的子 session 这类边角，现在按最简单的办法处理。
