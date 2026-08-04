# 第 12 章 · 展示轴：session-detail 与桌面 App

第二部分的最后一章。前面七章走完了写入侧和检索侧，剩下最后一条路径：**同一份 canonical record 如何走向人眼。**

这一章的重心是那个接缝——`assembleSessionDetail`。App 的 Vue 部分不在讨论范围内，只讲它和 Core 之间的边界。

## 一个接缝，两种输入

```ts
export function assembleSessionDetail(
  input: Iterable<TranscriptRecord> | SessionDetailRows,
): SessionDetailSnapshot {
  const records = Symbol.iterator in input
    ? input as Iterable<TranscriptRecord>
    : sessionDetailRecordsFromRows(input as SessionDetailRows);
  return assembleTranscriptRecords(records);
}
```

函数签名本身就是这一章最重要的信息。它接受两种输入：

- **适配器一次全新解析产出的记录流**（`Iterable<TranscriptRecord>`）
- **从 SQLite 查回来的行**（`SessionDetailRows`）

而第二种会先被 `sessionDetailRecordsFromRows` **转回记录语言**，然后走完全相同的组装逻辑。

```text
适配器 parse ──────────────┐
                          ├──→ TranscriptRecord[] ──→ assembleTranscriptRecords
SQLite 行 ──→ 转回记录 ────┘
```

**这不是为了代码复用，是为了防止两条路径漂移。**

设想没有这个转换：从数据库来的数据走一套组装逻辑，从解析器来的走另一套。两套逻辑一开始是一致的，然后某个 bug 只在其中一条路径上被修复，从此它们就分家了。而且这种漂移很难发现——两条路径通常不会被同时用来渲染同一个会话。

现在的形状让它们**在类型上就是同一条路径**。数据库往返之后能不能得到同样的结果，是一个可以直接测试的性质。

`sessionDetailRecordsFromRows` 那 132 行几乎全是 `typeof x === 'string' ? x : null` 这样的收窄。它做的事只有一件：**把宽松的数据库行，重新收紧成严格的记录类型。**

## 一个断言，说明了这个接缝的前提

```ts
case 'session':
  if (record.countMode === 'delta') {
    throw new Error('Direct session detail assembly requires a fresh full parse (cursor = null), not a provider delta');
  }
```

第 7 章讲过 Claude 是行增量的：从游标处恢复，只产出新增部分。

那样的记录流**不能**直接拿来组装展示——它只有这个会话最新的几十条消息，前面的全都不在流里。组装出来的时间线是残缺的。

所以这里直接抛错，而不是默默产出一个不完整的结果。要走"直接解析"这条路径，必须从空游标开始做一次完整解析。

**这个断言是接缝契约的一部分**：它把"什么样的输入是合法的"从注释变成了运行期的检查。

## 组装做什么

拿到记录流之后，组装分两步。

### 第一步：分拣与关联

```ts
for (const record of records) {
  switch (record.kind) {
    case 'message':
      if (record.visibility === 'hidden') break;   // ← 唯一的可见性判断
      messages.push({ ... });
      if (record.agent_id === null) mainMessageUuids.add(message.uuid);
      break;
    case 'tool_call':   toolCalls.push(record); break;
    case 'tool_result': toolResults.push(record); break;
    ...
  }
}
```

注意那行 `visibility === 'hidden'`。这是整个展示层**唯一**一处决定消息显不显示的地方，而且它读的是一个**已经算好的字段**。（`visibility` 在这个文件里还出现在行→记录的转换处，但那是把数据库值收窄回记录类型，不是显示决策。）

第 4 章那条边界在这里兑现：适配器负责判断（Codex 的 `<environment_context>` 信封、Kimi 的注入消息），展示层只是读结果。**这里没有一个正则，也没有一个 `if (source === ...)`。**

然后是三张关联表：

```ts
resultsByCallId    // tool_use_id → 工具结果
subagentsByCallId  // parent_tool_use_id → subagent
workflowsByCallId  // parent_tool_use_id → workflow
```

工具调用因此能挂上它的结果、它派生出的 subagent、它启动的 workflow：

```ts
const call: AssembledToolCall = {
  id: toolCall.id, name: toolCall.name,
  presentation: toolCall.presentation,
  input_json: toolCall.input_json,
  result: resultsByCallId.get(toolCall.id) ?? null,
};
const subagent = subagentsByCallId.get(toolCall.id);
if (subagent) call.subagent = { agent_id, agent_type, description };
const workflow = workflowsByCallId.get(toolCall.id);
if (workflow) call.workflow = workflow;
```

**全靠 ID 匹配，没有一处启发式。** 第 4 章讲的"workflow 带 `parent_tool_use_id`"这个字段，作用就在这一行——如果没有它，展示层只能靠时间顺序去猜哪个 workflow 属于哪次调用。

### 第二步：合并成卡片

只有主线消息进入时间线：

```ts
const detailMessages = session === null
  ? messages
  : messages.filter((message) => mainMessageUuids.has(message.uuid));
```

subagent 的消息不在主时间线上——它们通过工具调用上挂的 `subagent` 引用，在用户点开时单独加载。

排序有个细节：

```ts
detailMessages.sort((left, right) => {
  const leftTimestamp = left.timestamp ?? '';
  const rightTimestamp = right.timestamp ?? '';
  if (leftTimestamp !== rightTimestamp) return leftTimestamp < rightTimestamp ? -1 : 1;
  return left.uuid < right.uuid ? -1 : left.uuid > right.uuid ? 1 : 0;
});
```

**时间戳相同时按 uuid 排。** 这是为了确定性——同一份数据每次排出来的顺序必须一致，否则界面会在刷新时莫名跳动。同一毫秒内的多条记录并不罕见。

然后 `assembleMessages` 做真正的合并。它处理三类模式：

**thinking 块并入后续消息。**

```ts
if (message.type === 'assistant' && message.content_type === 'thinking') {
  const thinkingParts = [message.text ?? ''];
  let nextIndex = index + 1;
  while (nextIndex < raw.length && raw[nextIndex].content_type === 'thinking') {
    thinkingParts.push(raw[nextIndex].text ?? '');
    nextIndex++;
  }
  if (nextIndex < raw.length && raw[nextIndex].type === 'assistant'
      && raw[nextIndex].content_type !== 'thinking') {
    raw[nextIndex]._thinking = thinkingParts.join('\n\n');   // 挂到后面那条上
    ...
  }
  output.push({ ...message, text: thinkingParts.join('\n\n') });  // 后面没东西了，自己成一张卡
}
```

连续的思考块先合并，然后挂到紧随其后的那条真实消息上（成为可展开的部分）。如果后面没有真实消息了——比如会话就停在思考那里——它自己成为一张卡片。

**连续的工具调用合并成一条。**

一条 assistant 消息可能触发多次工具调用，在记录里是多条 `tool_use` 消息。展示时它们应该聚成一张卡：

```ts
if (!skillOnly && next.type === 'assistant' && next.content_type === 'tool_use') {
  if (next.tool_calls) mergedCalls.push(...next.tool_calls);
  ...
}
```

那个 `skillOnly` 是个例外：

```ts
const skillOnly = mergedCalls.length === 1 && mergedCalls[0].presentation === 'skill';
```

**只调用了一次 Skill 的消息不参与合并**——Skill 调用在界面上是独立的一张卡，把它和后续的普通工具调用合成一张会让语义混淆。

`presentation` 这个字段（第 4 章）唯一的用处就在这里。

**Skill 指令并入它的调用。**

```ts
if (next.content_type === 'skill_instructions' && next.text) {
  merged._skillMd = next.text;
  nextIndex++;
  continue;
}
```

Skill 的指令文本是一条 meta 消息——第 4 章说过它"可见但是 meta"，所以它不该独立成卡，而应该作为那次 Skill 调用的可展开内容。`content_type` 携带的这个分类，让展示层不需要靠文本特征去识别它。

**这三类合并全部基于 `content_type` 和 `presentation` 这两个显式字段。** 如果没有它们，这里就得靠"文本以什么开头""前后消息是什么"来猜——那正是第 4 章讲的、被拆掉的那条回边。

## App 怎么用它

主进程按 session 拉六张表，组装，送出去：

```ts
function querySessionSnapshot(sessionId: string): SessionDetailAssemblyInput {
  return {
    messages: querySessionMessages(sessionId),
    toolCalls: querySessionToolCalls(sessionId),
    toolResults: querySessionToolResults(sessionId),
    subagents: querySessionSubagents(sessionId),
    workflows: querySessionWorkflows(sessionId),
    summaries: querySessionSummaries(sessionId),
  };
}

function querySessionDisplaySnapshot(sessionId: string): SessionPatchSnapshot {
  const snapshot = querySessionSnapshot(sessionId);
  const detail = assembleSessionDetail(snapshot);
  return { messages: detail.messages, workflows: detail.workflows, summaries: detail.summaries };
}
```

这些查询是六条平铺直叙的 `SELECT ... WHERE session_id = ?`。**主进程不做任何组装逻辑**，那是 Core 的事。

第 2 章提过的那个九行 shim：

```js
import { assembleSessionDetail } from '../../../packages/core/src/session-detail.ts';
export { assembleSessionDetail };
```

它存在的唯一价值是给渲染进程和主进程一个统一的导入路径，同时用注释标明"生产调用方只走 Core 这一个接缝"。

## 实时刷新：快照 + 补丁

会话还在进行时，界面要跟着更新。全量重传整个时间线是可行的但很浪费——一个长会话的快照可能有几 MB。

所以有了 `session-patch.mjs`：**每次刷新重新取快照，和上一次的指纹对比，只传差异。**

```js
const TABLES = Object.freeze({
  messages:    'uuid',
  toolCalls:   'id',
  toolResults: 'tool_use_id',
  subagents:   'agent_id',
  workflows:   'run_id',
  summaries:   'id',
});
```

六张表，每张有自己的主键列。

指纹的算法值得看：

```js
function rowFingerprint(row, position) {
  return `${position.toString(36)}@${rowHash(row)}`;
}
```

**位置 + 内容哈希。** 两者都进指纹，意味着：

- 行内容变了 → 指纹变 → 重传
- 行内容没变但**位置**变了 → 指纹也变 → 重传

第二条是必要的。一条消息如果因为新数据插入而在时间线上前移，渲染层必须知道——只比内容的话，界面上的顺序会错。

差异计算是直白的集合运算：

```js
for (const [index, row] of (snapshot[table] || []).entries()) {
  const id = rowId(table, row);
  const hash = rowFingerprint(row, index);
  currentIds.add(id);
  if (previous[id] !== hash) {
    changes[table].push(row);   // 新增或变化
    ...
  }
}
for (const id of Object.keys(previous)) {
  if (!currentIds.has(id)) removed[table].push(id);   // 消失了
}
```

内容哈希用的是双 FNV 变体，拼上序列化长度：

```js
return `${serialized.length.toString(16)}:${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
```

不是加密哈希——**这里只需要检测变化，不需要抗碰撞**。加上长度前缀让偶然碰撞的概率进一步降低，而代价接近零。

注意这套补丁机制作用在**组装之后**的快照上，不是数据库行上。所以渲染层收到的补丁已经是它要显示的东西，不需要再组装一次。

## App 是活跃的索引者

第 3 章说过"检索路径会顺手跑一遍写入路径"。App 在的时候，情况不同——**它主动索引**。

```ts
const DEFAULT_DEBOUNCE_MS = 2000;
const DEFAULT_STABILITY_MS = 500;
const DEFAULT_HEARTBEAT_MS = 30000;
const DEFAULT_WATCH_RETRY_MS = 5000;
```

`indexer-service.ts` 用 chokidar 监听所有适配器声明的根目录（第 6 章那个 `registry.watchRoots()` 合并去重的结果），文件变化后防抖 2 秒、等文件稳定 500 毫秒，然后触发一次带 `changedPaths` 的增量构建。

同时每 30 秒写一次心跳——那是第 13 章的主题。

### 索引跑在 worker 线程里

```ts
port.on('message', ({ id, args }) => {
  try {
    const result = buildIndex(args || {});
    port.postMessage({ id, result });
  } catch (error) {
    port.postMessage({ id, error: { message: ..., stack: ... } });
  }
});
```

整个 worker 只有 20 行。它存在的理由很实际：**`buildIndex` 是同步的**——第 9 章那些 `readLines`、`statSync`、事务，全是阻塞调用。跑在主进程里，索引期间整个界面会卡住。

worker 客户端负责生命周期：worker 崩了或退出了，所有等待中的构建请求被拒绝，`worker = null`，下次调用时重建。

**这是 Electron 侧唯一一处"因为是 App 所以要多做点事"的地方。** 索引逻辑本身一行没变——它只是被换了个线程执行。

## 展示轴的完整形状

```text
                 SQLite 六张表
                       ↓  六条 SELECT（无逻辑）
                 SessionDetailRows
                       ↓  sessionDetailRecordsFromRows
                 TranscriptRecord[]   ←──── 或者直接来自适配器的全新解析
                       ↓  assembleTranscriptRecords
                    分拣与关联
                    （visibility 过滤、ID 匹配）
                       ↓  assembleMessages
                    合并成卡片
                    （thinking 内联、工具调用聚合、Skill 指令内联）
                 SessionDetailSnapshot
                       ↓  createSessionPatch（位置+内容指纹）
                    差异补丁
                       ↓  IPC
                    Vue 渲染
```

**从记录到卡片，全程没有一次对来源的判断。**

## 这一章你应该带走的

1. `assembleSessionDetail` 接受两种输入，数据库行会先**转回记录语言**——不是为了复用，是为了让两条路径不可能漂移。
2. `countMode === 'delta'` 直接抛错：直接组装必须来自完整解析。
3. 可见性判断只有一处，读的是**已经算好的字段**；关联全靠 ID 匹配，没有启发式。
4. 三类合并（thinking 内联、工具调用聚合、Skill 指令内联）全部基于 `content_type` 和 `presentation` 两个显式字段。
5. 排序在时间戳相同时按 uuid 兜底，保证确定性。
6. 实时刷新用**位置 + 内容**双重指纹算补丁；位置进指纹是必要的。
7. App 把索引放进 worker 线程，因为 `buildIndex` 是同步的——**索引逻辑一行没改**。

第二部分到此结束。第三部分处理那些不属于任何单一部件的问题，从并发开始。
