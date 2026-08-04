# 第 4 章 · 支点：canonical record 与两条正交轴

三条路径交在一个点上。这一章讲那个点。

它是一个类型定义，一百多行，没有任何运行逻辑：`packages/core/src/providers/types.ts`。整个系统的形状由它决定。

## 它是什么

```ts
export type TranscriptRecord =
  | SessionRecord
  | MessageRecord
  | ToolCallRecord
  | ToolResultRecord
  | SummaryRecord
  | SubagentRecord
  | WorkflowRecord
  | WorkflowAgentRecord
  | MessageTurnDurationRecord
  | DeleteSessionRecord;
```

十种记录。适配器产出它们，persist 消费它们，session-detail 也消费它们。

前八种大致对应数据库里的表。**后两种不是表，是操作**：

- `MessageTurnDurationRecord` —— 一次定点更新。某条消息的耗时信息，可能出现在**另一行**、甚至**另一次运行**里。它被表达成"把这个 uuid 的 turn_duration 设成这个值"，落库时是一条 `UPDATE`，不会碰这条消息的其他列。
- `DeleteSessionRecord` —— 一次撤回。适配器发现某个之前索引过的 session 必须消失（比如 Codex 的守卫线程，或者 Kimi 用户执行了 undo），就产出这条记录，落库时级联删除该 session 在所有表里的行。

这件事很关键：**共同语言里说的不只是"有什么"，还有"发生了什么变化"。** 如果只能表达"这里有一条消息"，那么"这条消息的耗时后来才知道"和"这段历史被用户撤销了"这两件事，就只能靠适配器自己去动数据库——而那正是规则一禁止的。

## 为什么划在这里

判断一个抽象划得对不对，最好的办法是想清楚它划在别处会怎样。这个接缝有两个明显的替代位置。

### 如果划得更低：让适配器直接产出数据库行

也就是没有中间语言，适配器认识 schema，直接拼 SQL 或者拼行对象。

这正是这套代码曾经的样子，代价出现在**展示侧**。

数据库的行是**扁平**的。一条消息就是一行，它属于哪个工具调用、是不是注入的传输上下文、该不该显示——这些语义在写入的时候被抹平了。等到展示层要重建时间线，它只能从行结构**反推**：用正则去猜哪条消息是注入的、根据前后顺序去猜 thinking 块和工具调用的从属关系。

猜就会错。而且每加一个来源，猜错的方式就多一种，最后必然演变成在展示层写 `if (source === 'codex')`——那是一条从展示侧指回 provider 轴的回边，上一章说过，出现回边就是规则被破坏了。

**canonical record 的作用是给"猜"提供替代品：把语义变成显式字段。** 于是有了这些看起来有点奇怪的设计：

- 消息带 `visibility: 'visible' | 'hidden'`，而且它**和 `is_meta` 是两个独立的字段**。因为这是两个正交的问题——"要不要显示"和"是不是控制面材料"。隐藏的传输上下文不该出现在时间线里；而可见的系统证据（比如 Skill 指令）应该显示，只是显示成一张元数据卡片。混成一个布尔值，两种材料就没法区分了。
- 工具调用带 `presentation: 'default' | 'skill'`，直接说明这次调用该怎么呈现。
- workflow 带 `parent_tool_use_id`，直接说明它挂在哪次调用下面。

每一个这样的字段，都对应着一处曾经需要靠猜来还原的东西。

### 如果划得更高：让每个消费者直接读原始 JSONL

那就是写入、检索、展示三侧各自去理解三种格式。任何一处理解得不一样，三边就开始漂移。

而且原始格式的复杂度是真实存在的、无法回避的。举个具体的：Kimi 的 `wire.jsonl` 根本不是消息列表，是**操作日志**——一条 assistant 消息在文件里是这样散着的：

```text
step.begin → content.part → content.part → tool.call → tool.result → step.end
```

要把它折回成一条消息，需要一套有状态的折叠逻辑。这套逻辑应该只存在一份，在 Kimi 适配器里。让三侧各写一遍，是在为同一个 bug 准备三个藏身处。

### 所以：划在语义完整、但还没被序列化的那一层

往下一层，语义已经被压扁；往上一层，格式还没被消化。canonical record 卡在中间——**所有来源特有的解释都已完成，所有存储特有的取舍都还没发生**。

有一句注释把这个位置说得很准（`types.ts` 开头）：

> the database is a serialization adapter rather than the source of transcript semantics

**数据库是序列化适配器，不是转写语义的来源。** 这句话反过来读更有味道：如果你想知道 Obelisk 认为一次会话是由什么构成的，去读 `types.ts`，不要去读 `schema.sql`。

## 两条正交轴

有了这个交点，系统的变化被分解成两个互不相干的方向：

```text
                      Provider 轴（N 种来源）
                claude       codex        kimi       …
                  │            │            │
                  └────────────┴────────────┘
                               ↓
                     ╔═══════════════════╗
                     ║ TranscriptRecord  ║
                     ╚═══════════════════╝
                               ↓
                  ┌────────────┴────────────┐
                  │                         │
             persist                 session-detail       …
                      Consumer 轴（M 个消费者）
```

关键在于这两条轴**正交**：加一个来源不影响任何消费者，加一个消费者不影响任何适配器。工作量是 **N + M**，不是 N × M。

这不是理论上的漂亮话，它有可验证的形式：

- 加第三个来源（Kimi）时，硬约束是"不改 `schema.sql`，不加新的 record 类型"。第 7 章会讲这个约束是怎么被满足的。
- App 作为第二个消费者接进来时，`persist.ts` 一行没改——它只是从另一个 binding 收到了一个 handle。

反过来说，**这套架构最容易被破坏的方式，就是遇到新需求时去动中间这层语言。** 需求来了先问一句：能不能在外围加一层适配，让它去适应内核？绝大多数时候可以。给共同语言加一个类型、给公共接口加一个动词，是最后的手段，不是第一反应。

## 记录本身的三个设计特征

读 `types.ts` 时有三处会让人困惑，它们都是被现实逼出来的。

### 一、大量可选字段，因为一行可能由多个来源拼成

看 `WorkflowAgentRecord`，除了三个 ID 之外全是可选的。注释解释了原因：

> A single row is contributed by TWO independent units, in any order

一个 workflow agent 的信息散在两个地方：subagent 的元数据文件知道它的类型和描述，workflow 的运行记录知道它的阶段、模型、耗时和 token。这两个文件是**两个独立的工作单元**，可能在不同的运行里被处理，顺序不定。

所以记录的约定是：**你不知道的字段就别写**。落库时按列合并：

```sql
ON CONFLICT(agent_id) DO UPDATE SET
  agent_type = COALESCE(excluded.agent_type, workflow_agents.agent_type),
  phase      = COALESCE(excluded.phase,      workflow_agents.phase),
  ...
```

`COALESCE` 保证了"我不知道"（`null`）永远不会覆盖掉"别人已经知道的"。这就是为什么 `persist.ts` 里 `COALESCE` 出现得那么密集——它不是防御性编程，是这个数据模型的直接后果。

### 二、`countMode`，因为适配器的增量策略根本不同

`SessionRecord` 上有个奇怪的字段：

```ts
countMode: 'total' | 'delta';
```

它存在是因为三个适配器对"增量"的理解不一样：

- **Claude 是行增量的**：只解析文件里新增的那些行，所以它报出来的 `message_count` 是"这一批新增了多少条"→ `'delta'`，persist 累加到已有的值上。
- **Codex 是全量重解析的**：它必须把整个文件读进来（去重逻辑需要双向的全文件视野），所以它报的是"这个 session 一共多少条"→ `'total'`，persist 直接替换。

与其让 persist 去猜（那就要认 source，破坏规则二），不如让适配器**明说**。这个字段是"共同语言必须能表达差异，而不是消灭差异"的一个具体例证。

顺带一提，从空游标开始的一次 `'delta'` 解析，效果等价于 `'total'`——首次索引时两者自然对齐。

### 三、`Cursor` 是不透明的

```ts
export type Cursor = string | null;
```

产出它的适配器是**唯一**能解释它的人。编排层原样存、原样递回。上一章说过这一点，这里补一句为什么类型这么松：因为它必须能容纳还没被设想出来的来源。文件型的用 `"mtime:行数"`，目录型的用聚合值，将来某个基于数据库的来源可能用一个 rowid 或时间戳水位。

**接口不知道内容是什么，才可能容纳还不存在的内容。**

> **当时**
>
> 这个接缝是被一个 Codex 会话的显示 bug 逼出来的。当时 `session-detail` 的组装逻辑虽然没有显式的 provider 分支，但仍然在"用文本正则补判 `is_meta`""重新推断 thinking / tool 消息的组合关系"——原话把这个状态称为**"provider 语义泄漏后的兜底"**。
>
> 定下边界的那句话是：
>
> > "这次 Codex 问题应该在 Codex parser 中产出正确的 canonical event；不应在 session-detail assembly 里增加 `if source === 'codex'`。"
>
> 同一次讨论里还提出了把 `is_meta` 拆开：
>
> > "最好逐步拆成类似 `visibility: visible | hidden` 和明确的 message kind，避免把'隐藏注入'和'需要展示的 Skill/system metadata'混为一类。"
>
> 这就是今天 `MessageRecord` 上 `visibility` 和 `is_meta` 并存的由来。
> 出处：Codex session `019f8000`（修复 session detail 的 computer use 显示），2026-07-20。

## 第一部分结束

到这里，你应该已经能凭记忆画出这个系统了：

1. **外形**：四个动词，显式记忆，一个本地 SQLite，两个使用面。
2. **组成**：两个消费者共用一份 Core；三条依赖规则；binding 靠注入。
3. **运作**：写入、检索、展示三条路径；检索嵌套写入；展示不认来源。
4. **支点**：`TranscriptRecord` 是共同语言，划在"语义已完整、序列化未发生"的那一层；两条轴正交，成本是 N + M。

后面十一章都是在这张图里填内容。**如果某一章的细节让你迷失，回到这四条。** 每个部件都只是在回答一个问题：如何在不越界的前提下，把自己那部分活干完。

第二部分从数据层开始——先建立词汇，再讲谁在读写它。
