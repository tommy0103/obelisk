# 第 7 章 · 三个适配器：行增量、全量重解析、目录投影

上一章讲契约，这一章讲三个实现。

它们遵守同一份接口，但对"增量"的理解**完全不同**——不是风格差异，是被各自的源格式逼出来的。这一章的价值在于：**契约的好坏，要看它能不能吸收这种程度的差异而不变形。**

先看结论：

| | Claude Code | Codex | Kimi Code |
|---|---|---|---|
| 一个工作单元 | 一个文件 | 一个文件 | **一整个目录** |
| 增量策略 | 行增量 | 全量重解析 | 全量重放 |
| 游标含义 | mtime + 已处理行数 | mtime + 总行数 | **聚合** mtime + 总行数 |
| `countMode` | `delta`（首次为 `total`） | `total` | `total` |
| 每次解析的输出 | 只有新增部分 | 整个文件 | 先撤回整个 session，再重建 |
| 语义版本 | v2 | v2 | **v4** |

三种策略，一份 persist，一套表。

---

## Claude：行增量

最直观的一个，也是这套架构最初为之设计的形状。

### 游标就是"读到第几行"

```ts
function cursorToSkip(cursor: Cursor): number {
  if (!cursor) return 0;
  const n = Number(cursor.split(':')[1]);
  return Number.isFinite(n) ? n : 0;
}
```

游标是 `"<mtimeMs>:<已处理行数>"`。两个数字各司其职：**mtime 供 discover 判断"这个文件变了没"，行数供 parse 决定"从哪儿接着读"**。

parse 里的恢复逻辑就一行：

```ts
const skip = cursorToSkip(cursor);
...
if (lineNum <= skip) return;   // 已经处理过的行，跳过
```

文件追加了 200 行，这次就只解析这 200 行。一个几十 MB 的长会话，第二次索引几乎不花时间。

### `countMode` 是算出来的，不是写死的

```ts
countMode: skip > 0 ? 'delta' : 'total',
```

这行值得停一下。同一个适配器会在两种模式之间切换：

- `skip > 0` —— 这次是接着上次读的，产出的 `message_count` 只是"新增了多少条"，persist 要**累加**
- `skip === 0` —— 从头读的，产出的是"一共多少条"，persist 直接**替换**

第 4 章说过"从空游标开始的 delta 等价于 total"。这里是那句话的代码形式：适配器不假设 persist 记得什么，它每次都明说自己这一批是什么性质。

### 一个 session 会拆成多个单元

Claude 的一次会话在磁盘上不止一个文件：

```text
<project>/<sessionId>.jsonl                              主转写
<project>/<sessionId>/subagents/agent-<id>.jsonl         subagent 转写
<project>/<sessionId>/subagents/workflows/<runId>/*.jsonl workflow agent 转写
<project>/<sessionId>/workflows/wf_<runId>.json          workflow 运行记录
```

discover 把它们发现成**各自独立的 IndexUnit**——`IndexUnit` 里那两个字段 `isSubagent` / `agentId` 就是为此存在的。

这直接导致了第 4 章讲的那个现象：**一行由两个单元拼成**。`workflow_agents` 表里一行的 `agent_type` / `description` 来自 subagent 的转写文件，`phase` / `model` / `state` / `tokens` 来自 workflow 的运行记录 JSON。两个单元互不知晓，可能在不同的运行里被处理，顺序不定。

于是 `WorkflowAgentRecord` 上除了三个 ID 全部可选，persist 用 `COALESCE` 按列合并。**这不是"为了灵活"，是 Claude 的磁盘布局的直接后果。**

### 标题来自旁路文件

`~/.claude/history.jsonl` 存着 sessionId → 标题的映射，discover 阶段先把它读进一个 Map：

```ts
readLines(historyPath, (line) => {
  const item = JSON.parse(line);
  if (item?.sessionId && item?.title) historyTitles.set(item.sessionId, item.title);
});
```

所以 `watchRoots` 返回两个路径——`projects/` 和 `history.jsonl`。标题变了也要触发重新索引。

---

## Codex：全量重解析

Codex 每次都把整个文件读进内存，重新产出全部记录。这看起来是退步，但它是必需的。

### 为什么不能行增量

文件头的注释把原因写得很清楚：

> the `event_msg` ↔ `response_item` dedup needs whole-file (bidirectional) knowledge (the matching pair sits ±1 line apart but in either order)

Codex 的转写里，**同一条消息会以两种形式各出现一次**：一次是 `event_msg`（面向 UI 的事件），一次是 `response_item`（面向模型的协议记录）。两条挨着，但谁先谁后不一定。

于是去重需要双向的视野。适配器的做法是**两遍扫描**：

```ts
// 第一遍：收集所有可见的 event_msg 的内容指纹
for (const { obj } of records) {
  if (obj?.type !== 'event_msg') continue;
  ...
  eventMessageKeys.add(codexVisibleMessageKey(role, text));
}

// 第二遍：正式产出记录，遇到指纹已存在的 response_item 就跳过
if (text !== null && !eventMessageKeys.has(codexVisibleMessageKey(role, text))) {
  insertMessage({ ... });
}
```

第一遍必须扫完整个文件，才能保证第二遍的判断是对的。**行增量在这里会漏判**：如果配对的两条被切在增量边界的两侧，去重就失效了，同一条消息会入库两次。

所以 `countMode` 恒为 `'total'`，persist 每次替换消息计数。

### 消息 ID 是合成的

Claude 的每条记录自带 `uuid`。Codex 没有，所以适配器自己造：

```ts
const lineUuid = (n: number): string => codexLineUuid(threadRawId, n);
// → "codex:<threadRawId>:<行号>"
```

用行号做 ID，前提正是全量重解析——只要文件不变，同一条记录每次都落在同一行，ID 就稳定。**这两个决定是绑在一起的**：如果改成行增量，行号仍然稳定，但去重会坏；如果换一种 ID 方案，全量重解析的必要性就少了一条。

第 6 章讲的 `raw()` 也依赖这个格式：

```ts
const match = /^codex:([^:]+):(\d+)$/.exec(input.messageUuid);
```

从 ID 里直接拆出线程 ID 和行号，再去文件里定位那一行。

### 子线程被投影成 subagent

Codex 的子 agent 是**独立的线程文件**，通过元数据里的 parent 字段关联。适配器的处理很干净：

```ts
const parentRawId = codexParentThreadId(meta);
const sessionId = codexDbId(parentRawId || threadRawId);
const agentId = parentRawId ? codexDbId(threadRawId) : null;
```

有父线程 → 这个文件的所有消息归到**父 session** 名下，带上 `agent_id`；没有父线程 → 它自己就是一个 session。

末尾的分叉是关键：

```ts
if (agentId) {
  out.push({ kind: 'subagent', agent_id: agentId, ... });   // 子线程产出 subagent 记录
} else {
  out.push({ kind: 'session', id: sessionId, ... });        // 根线程产出 session 记录
}
```

**同一段解析代码，根据自己是不是子线程，产出两种不同的顶层记录。** 于是 Codex 的父子线程结构，被投影进了原本为 Claude 的 subagent 设计的那张表里，`session-detail` 和检索 helper 一行都不用改。

### 撤回：guardian 线程

Codex 有一类内部线程（守卫/自动 review），不该出现在用户的历史里。但它们已经被写成了正常的转写文件，可能上一次索引已经进库了。

```ts
if (codexIsGuardianThread(meta, records)) {
  yield { kind: 'delete-session', sessionId: codexDbId(threadRawId) };
  return outCursor;
}
```

这是 `DeleteSessionRecord` 的第一个用例。**注意它的形状：适配器不去操作数据库，它只是"说"这个 session 应该消失**，persist 收到后执行级联删除。撤回因此和插入一样，是共同语言里的一等公民。

### 可见性：信封识别

```ts
const HIDDEN_CONTEXT_ENVELOPE_RE =
  /^\s*<(environment_context|codex_internal_context)\b[^>]*>[\s\S]*<\/\1>\s*$/;

function messageVisibility(role: string, text: string | null): 'visible' | 'hidden' {
  return role === 'user' && HIDDEN_CONTEXT_ENVELOPE_RE.test(text) ? 'hidden' : 'visible';
}
```

Codex 会把环境上下文以 user 角色注入进对话。它在协议上是用户消息，但显然不该显示成用户说的话。

**这个正则在这里是对的，在展示层就是错的。** 第 4 章讲过那条边界：识别工作属于适配器，因为只有它知道 Codex 用什么信封；展示层拿到的应该是已经判好的 `visibility` 字段，而不是再去猜一次文本。

顺带看一眼这行怎么落到两个字段上：

```ts
is_meta: visibility === 'hidden' || skillInstructions ? 1 : (isMeta || ...),
visibility,
```

隐藏的一定是 meta，但 meta 的不一定隐藏——Skill 指令是 meta，却要作为元数据卡片显示出来。两个字段各管一件事。

### 旁路元数据

`~/.codex/session_index.jsonl` 提供标题和更新时间。它**不是**转写来源，只在 discover 阶段被读来做标题增强：

```ts
sessionIndex.set(codexRawId(item.id), { title: item.thread_name, updatedAt: item.updated_at });
```

而且它变了要触发全体重扫（`sessionIndexChanged`），因为标题可能变在任何一个 session 上。

---

## Kimi：目录投影 + 全量替换

第三个适配器是对这套契约最狠的一次压力测试。它的源格式和前两个**不在一个范式上**。

### 一个 session 是一个目录

```text
$KIMI_CODE_HOME/sessions/<workspaceId>/<sessionId>/
├── state.json
└── agents/
    ├── main/wire.jsonl
    └── <subagentId>/wire.jsonl
```

一个会话由 `state.json`（元数据）加**多个** `wire.jsonl`（主 agent 和各个子 agent）组成。它们必须被当作一个整体——单独解析某一个 wire 文件，得到的 session 是残缺的。

所以 `IndexUnit.key` 是**目录路径**，`meta` 里装着整个目录的清单：

```ts
interface KimiSessionUnitMeta {
  readonly sessionDir: string;
  readonly statePath: string;
  readonly wireFiles: readonly KimiWireFile[];
  readonly currentCursor: Exclude<Cursor, null>;
}
```

**这就是第 6 章那句"`IndexUnit` 不是文件"的兑现。** 如果当初把它定义成文件，Kimi 要么进不来，要么得在契约上开个口子。

### 游标是聚合出来的

```ts
function cursorFor(statePath: string, wires: readonly KimiWireFile[]): Cursor {
  const paths = [statePath, ...wires.map(w => w.path)].filter(existsSync);
  let maxMtime = 0;
  let totalLines = 0;
  for (const path of paths) {
    maxMtime = Math.max(maxMtime, statSync(path).mtimeMs);
    totalLines += fileLineCount(path);
  }
  return `${maxMtime}:${totalLines}`;
}
```

还是 `"数字:数字"`，但含义变了：**整个目录下所有文件的最大 mtime，和总行数之和**。

"总行数"在这里不再是"读到第几行"——它是一个**变更检测的指纹**。任何一个 wire 文件多了一行，总和就变。discover 的判断因此是相等比较，不是大小比较：

```ts
if (changedSessions === null && ctx.lastCursor(sessionDir) === currentCursor) continue;
```

同一个 `"数字:数字"` 格式，在三个适配器里是三种语义。第 6 章讲的"游标不透明"在这里得到了最好的例证。

### wire.jsonl 不是消息列表，是操作日志

这是 Kimi 最根本的不同。一条 assistant 消息在文件里是**散开的一串事件**：

```text
step.begin
  content.part      ← 文本片段
  content.part      ← 又一段
  tool.call
  tool.result
step.end
```

要还原成一条消息，需要一套有状态的折叠逻辑——`stepStarts`、`stepMessages`、`callMessageUuids` 这几个 Map 就是干这个的。

**这套逻辑只存在一份，在 Kimi 适配器里。** 第 4 章说过：如果让写入、检索、展示三侧各写一遍，就是给同一个 bug 准备三个藏身处。

### 撤回是必须支持的，所以必须全量重放

wire 日志里有两类记录会**让已经发生的事情失效**：

```ts
if (record.type === 'context.clear') {
  undoFloor = messages.length;      // 之前的全部封存，不再受 undo 影响
  resetOpenState();
  continue;
}
if (record.type === 'context.undo') {
  applyUndo(typeof record.count === 'number' ? record.count : 0);
  continue;
}
```

用户按了 undo，前面 N 条消息就该消失。

**这一条彻底否决了行增量。** 增量追加只能往前加，没法表达"把上次加过的东西拿掉"。所以 Kimi 每次都从头重放整个目录，在内存里算出撤回之后的最终状态。

`applyUndo` 里还有个细节：注入的消息不计入撤回计数（`injectionMessageUuids`），因为用户撤回的是自己的轮次，不是系统塞进去的上下文。

### 每次解析先撤回自己

parse 的第一条产出是：

```ts
yield { kind: 'delete-session', sessionId: unit.sessionId };
```

**先把这个 session 在库里的一切删掉，再重新写一遍。**

这是"全量替换"在共同语言里的表达方式。而它之所以安全，是因为第 6 章讲的那个性质：**解析、删除、重写、写游标全都在同一个事务里**。外界看不到中间的空窗，失败了就整体回滚。

`DeleteSessionRecord` 的注释里只提到了撤回场景，但 Kimi 用它实现了一个更强的语义——**幂等的整体替换**。这是共同语言比它的设计者想象得更通用的一个例子。

### 两处防御

**一、索引期间文件变了就抛错：**

```ts
const before = cursorFor(meta.statePath, meta.wireFiles);
const projected = projectSession(meta, unit.sessionId, state);
const after = cursorFor(meta.statePath, meta.wireFiles);
if (before !== after) throw new Error(`Kimi session changed while indexing: ${meta.sessionDir}`);
```

Kimi 是活跃会话，可能正在被写入。解析前后各算一次游标，不一致就放弃这次——上层会记下跳过、下次重来。**宁可这一轮不更新，也不写入一个撕裂的状态。**

**二、还没开始的会话保持撤回：**

```ts
// Kimi persists a titled session before the first prompt;
// keep it retracted until user evidence exists.
if (state.title === 'New Session' && !hasLastPrompt && !hasProjectedUserPrompt) return after;
```

Kimi 在用户输入第一句话之前就落盘了一个 session。这时候前面那条 `delete-session` 已经产出，而 session 记录不产出——**净效果就是"这个 session 不存在"**。等用户真的说了话，下一次索引它自然出现。

### 版本标记是 v4

```ts
export const KIMI_CANONICAL_TRANSCRIPT_MARKER = '__kimi_canonical_transcript_v4__';
```

Claude 和 Codex 都停在 v2，Kimi 已经到 v4。这个数字诚实地记录了：**折叠操作日志这件事，比解析消息列表难，改了更多次。**

而每一次改，代价只是换一个字符串——第 6 章讲的重放机制把"数据迁移"变成了"重新算一遍"。三个适配器里，Kimi 是这个机制最大的受益者。

---

## 契约吸收了什么

回头看这三个实现，会发现契约里那些当初看着抽象的设计，每一个都在**具体地**承接某种差异：

| 契约里的设计 | 承接的差异 |
|---|---|
| `IndexUnit` 不是文件 | Kimi 的一个目录 vs Claude 的一个文件 |
| `meta` 是私有载荷 | Kimi 要把整个目录清单从 discover 传到 parse |
| 游标不透明 | 同一个 `"数字:数字"`，三种语义 |
| `countMode` | Claude 报增量、Codex 报总量 |
| `delete-session` | Codex 的守卫线程、Kimi 的全量替换 |
| 可选字段 + `COALESCE` | Claude 一行由两个单元拼成 |
| `parse` 是生成器且 return 游标 | Kimi 的删除+重写必须原子 |
| `raw()` 由适配器实现 | 三种完全不同的定位方式 |

**没有一处需要 persist 或 session-detail 认识来源。** 这是这套抽象最有说服力的证据——不是因为它设计得优雅，而是因为它被三种范式各异的源格式撑过一遍之后，中间那层语言一个字都没改。

> **当时**
>
> Kimi 接入的方案讨论里，硬约束是先定下来的：
>
> > "保持数据库 schema 和 `IndexRecord` 不变，把 Kimi 的复杂语义全部封装在 adapter 内。"
> > "本次不修改 `schema.sql`，也不新增 `IndexRecord` 类型。"
>
> 随后列出了 Kimi 只能使用的那几种既有记录，以及策略结论：
>
> > "把 Kimi Code 作为'目录型 provider'接入。一个 `IndexUnit` 应对应整个 session 目录，并采用'全量 replay + 事务内替换'，不要按 JSONL 行增量追加。"
>
> 难点也在同一段里被点明：
>
> > "核心难点是 `wire.jsonl` 不是消息列表，而是操作日志。"
>
> 出处：Codex session `019f7c21`（分析 kimi-code session 接入方案），2026-07-19 至 07-21。

## 这一章你应该带走的

1. **Claude 行增量**：游标记行号，`countMode` 在 delta / total 之间动态切换，一个 session 拆成多个单元。
2. **Codex 全量重解析**：因为跨行去重需要双向视野；ID 由行号合成，与全量策略互为前提；子线程投影成 subagent；守卫线程用 `delete-session` 撤回。
3. **Kimi 目录投影**：一个目录一个单元，游标是聚合指纹，wire 是操作日志需要折叠，撤回语义强制全量重放，每次先 `delete-session` 再重建。
4. 三种范式，共同语言一个字没改。

下一章走到轴的另一侧：这些记录流被 persist 怎么落进表里。
