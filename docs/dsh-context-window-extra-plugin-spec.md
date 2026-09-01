# Obelisk DSH Context Window Extra Plugin 规格说明

**状态：** 已实现，待评审

**日期：** 2026-09-02

**DeepSeek Harness 基线：** `dsh-v0.1.2-alpha.4`（commit `4e84901e64`）

## 1. 概述

在现有 `@obelisk/dsh-obelisk-plugin` package 内增加一个默认不挂载的 `./context-window` extra plugin。

现有 package 根导出和默认 DSH bundle 保持当前行为：安装普通 Obelisk DSH plugin 时，仍然只注册由 plugin 自己维护的 `obelisk` skill。只有用户在 Cordis 配置中显式挂载 `./context-window` 时，才会启用 context rollover、handoff guidance 和 `new_context` 工具。

extra plugin 向模型提供一个 `new_context` 工具。模型提交一段自由 prose handoff；handoff 应包含哪些内容由 prompt 约束，而不是由 JSON 字段或 Markdown 标题约束。成功的 `tool/call` 与 `tool/result` pair 表示模型已经请求 rollover，工具 handler 不立即清理 active history。当前 sampling step 完成后，plugin 在下一个安全 step 边界将 active DSH message surface 替换为 handoff message，并在同一个 user turn 内继续 inference。

extra plugin 同时拥有完整的 token-pressure policy：接近 normal budget 上限时自动提醒模型；normal budget 耗尽后进入一次 fallback reserve，只允许模型提交 handoff 并调用 `new_context`；reserve 耗尽或模型仍未切窗时，由 host 强制 rollover。fallback reserve 的目的不是延长普通任务执行，而是保证 handoff 在 normal budget 用尽后仍有机会完成。

handoff message 由 host 补充两个可以直接用于 Obelisk 的恢复标识：

- canonical Obelisk `session_id`：限定后续历史检索的默认 session；
- canonical Obelisk `message_uuid`：指向触发本次 rollover 的 root assistant tool-use message，可直接传给 `context(uuid)`，从上一段 context 的末尾恢复相关证据。

Obelisk 继续负责完整历史的索引与检索。本设计不增加 `window_id`、context-window 数据表、UUID 区间或新的通用 Obelisk query 工具。

## 2. 目标

- 复用 Codex `new_context` 的关键控制流：工具只声明 intent；sampling step 结束后才提交 destructive history transition；同一个 user turn 在新 context 中继续。
- 保留完整的 DSH append-only event log，只从 active model surface 移除旧消息。
- 将模型撰写的 prose handoff 作为新 context 的第一条 retained context。
- 通过 prompt 要求 prose handoff 覆盖 Codex guidance 中要求的语义信息。
- 为新 context 提供明确的 Obelisk session scope 和一个可以直接操作的 message anchor。
- 自动发出 near-limit reminder，并为未及时响应 reminder 的模型保留一次受限 fallback inference。
- fallback reserve 耗尽后由 host 强制 rollover，避免 context overflow 使 session 无法继续。
- 保持功能完全 opt-in；卸载 extra plugin 后，现有 Obelisk DSH plugin 行为不变。
- 只使用 DeepSeek Harness 已有的公开 plugin seams，不修改 DeepSeek Harness core package。

## 3. 非目标

- 普通 Obelisk DSH plugin 安装后不得默认启用 context rollover。
- 不新增 workspace package 或新的顶层 package 目录。
- 不修改现有 `obelisk.cordis.yml` 的默认挂载内容。
- 不向 Obelisk schema 或模型接口增加 `window_id`。
- 不把 context window 建模为 UUID 区间，也不增加 message-range query abstraction。
- 不要求 handoff prose 使用 JSON schema、固定 Markdown headings 或其他机器校验格式。
- 不新增 DSH 专用的 `obelisk_query` 工具。历史恢复继续使用现有 plugin-owned Obelisk skill 和 CLI query runtime。
- 不增加独立的 rollover intent/commit 状态机。成功的 DSH tool pair、durable pressure messages 和最终 surface replacement 已经提供所需事实。
- 不让 surface replacement 等待 Obelisk 完成实时索引。标识通过确定性规则计算，索引延迟不得阻止切窗。
- 不取消 Obelisk 的全局或跨 session 检索能力。`session_id` 只定义 handoff 恢复时的默认 scope。

## 4. DSH 版本基线与 Package 布局

本规格基于 `dsh-v0.1.2-alpha.4` 的公开 seams：

- `agent/pre-step` 仍是上一批 tools settle 后、下一次 model request 前的安全点；
- native tool calls 仍通过 `tool/call` 与 `tool/result` 持久化；
- PTC nested calls 仍通过 `tool/code-dispatch-start` 与 `tool/code-dispatch` 持久化；
- active history 仍由 session surface fold 决定，并支持 `user/message` range replacement；
- `ctx.sessions.flush(session)` 仍是 model request 前的 durability checkpoint；
- DSH 没有新增内置 `new_context`、token-budget rollover 或 post-step lifecycle hook。

该版本将 session event position 与 log offset 分成不同 branded types：

```ts
type SessionSeq = BrandedNumber<'SessionSeq'>
type SessionLogOffset = BrandedNumber<'SessionLogOffset'>
```

extra plugin 必须保留这一区分：

- 现有 event、`surfaceOp.start/end`、`sourceEventSeqs` 使用 `SessionSeq`；
- log 长度、半开读取边界和 projection watermark 使用 `SessionLogOffset`；
- 不得把未验证的普通 `number` 直接当作 event position。

`Session.events` 全量 getter 已不存在。实现不得依赖它，也不得在每个 `agent/pre-step` 通过 `snapshotEvents()` 全量扫描长 session。model-requested rollover、reminder、fallback 和 replacement 状态由 host-only session projection 增量折叠；`eventAt()` 用于已知 `SessionSeq` 的精确读取，`snapshotEvents()` 只用于有界恢复或测试断言。

逻辑 `SessionHeader` 的 fork metadata 已改为 `isSeeded`，exact inherited cut 由 `session.inheritedEventCount` 持有。extra plugin 不依赖这些字段判断 rollover generation。物理 JSONL version-0 header 仍将该 cut 编码为可选 `seedLength`，因此当前 Obelisk DeepSeek provider 的 header discovery 前提不变。

### Package 布局与启用方式

所有实现留在现有 `packages/dsh-plugin` 内，并在 `src/` 中平铺：

```text
packages/dsh-plugin/
├── src/
│   ├── index.ts                    # 现有根插件；行为保持不变
│   ├── context-window.ts           # extra plugin 入口、配置与注册
│   ├── context-window-budget.ts    # reminder、fallback reserve 与 hard limit
│   ├── context-window-state.ts     # host-only session projection
│   ├── context-window-rollover.ts  # safe-boundary surface replacement
│   ├── context-window-prompt.ts    # guidance、reminder 与 fallback prompt
│   └── context-window-identity.ts  # Obelisk DeepSeek identity adapter
├── obelisk.cordis.yml              # 现有默认 bundle；保持不变
└── package.json
```

`package.json` 增加 subpath export，但默认 bundle 不引用它：

```json
{
  "exports": {
    ".": "./dist/index.js",
    "./context-window": "./dist/context-window.js",
    "./package.json": "./package.json"
  }
}
```

用户通过额外 Cordis row 显式启用：

```yaml
- insert:
    - id: obelisk-context-window
      name: '@obelisk/dsh-obelisk-plugin/context-window'
```

删除该 row 后，`new_context`、handoff guidance、reminder 和 rollover listener 一并撤销；根插件注册的 Obelisk skill 不受影响。

启用 extra plugin 的 agent composition 同时必须关闭该 agent 的 `compaction-basic.auto`。context-window plugin 自己拥有 reminder、fallback reserve 和 hard-limit rollover；两个 automatic pressure policies 不能竞争同一段 history。手动 `/compact` 可以继续挂载。

### Alpha.4 peer metadata

现有 `@deepseek-ai/dsh-skill` peer range `>=0.0.1-rc.1 <1` 按 npm prerelease 规则不匹配 `0.1.2-alpha.4`。实现本 extra plugin 时必须同步修正 package peer metadata，并使用 alpha.4 dev dependencies/typecheck：

- package root plugin 仍可保留已验证的旧 DSH compatibility；
- `./context-window` 所需的 `dsh-agent`、`dsh-session`、`dsh-session-projection`、`dsh-system-prompt`、`dsh-tools`、`dsh-token-meter` 等 peers 必须声明并验证 alpha.4；
- 不得用宽泛 prerelease wildcard 暗示未经测试的未来 alpha 版本兼容；
- npm 和 DSH 默认 pnpm plugin 安装路径都必须有安装测试。

## 5. 模型接口

extra plugin 只注册一个工具：

```ts
type NewContextInput = {
  handoff: string
}
```

模型看到的 schema：

```json
{
  "name": "new_context",
  "description": "Start a fresh context after preserving a prose handoff for continuing the current task.",
  "parameters": {
    "type": "object",
    "properties": {
      "handoff": {
        "type": "string",
        "description": "A concise prose handoff covering the current goal, decisions, progress, learnings, next steps, unresolved user requests, and important actions. Preserve details only when they are needed to continue; older evidence remains recoverable through Obelisk."
      }
    },
    "required": ["handoff"],
    "additionalProperties": false
  }
}
```

模型不提交 `session_id`、`message_uuid`、window number 或 transition identifier。这些值属于 host facts，不能信任模型自报。

工具拒绝空字符串和仅含空白的 handoff。第一版不引入任意的硬编码字符上限；如果后续 eval 证明需要 hard cap，应将其设计为明确的 plugin config，而不是隐藏常量。

成功结果只说明 rollover request 已接受，并将在当前 sampling step 完成后的安全边界应用。结果不得回显完整 handoff。该成功 `tool/result` 与已经记录参数的 `tool/call` 共同构成 durable model-requested rollover；plugin 不再追加同义 intent event。

## 6. Handoff Prompt 约束

extra plugin 持续向模型提供 context rollover guidance。具体文案可以通过 eval 调整，但必须明确表达以下要求：

1. handoff 必须足以让一个只看到新 context 的模型继续当前 user task。
2. 调用 `new_context` 前，模型需要写一段简洁 prose，覆盖：
   - 当前 goal；
   - 已做出的 decisions 及必要 rationale；
   - 已完成和正在进行的 progress；
   - 会影响后续工作的 learnings；
   - 明确的 next steps；
   - 所有尚未完成的 user requests；
   - 后续可能需要的重要 actions 或 tool results。
3. 不要把旧 transcript 整段复制进 handoff。
4. 进入新 context 后，默认使用 handoff 提供的 Obelisk `session_id` 检索当前任务的历史。
5. 需要从上一段 context 末尾扩展时，使用 handoff 提供的 `message_uuid` 调用 `context(uuid)`。
6. 只有任务确实需要跨 session 或跨 harness 证据时，才扩大检索 scope。

handoff 正文始终是 prose。上述内容属于 prompt-driven semantic contract，不是 typed checkpoint body。

## 7. Obelisk 恢复标识

### 7.1 `session_id`

`session_id` 是 Obelisk DeepSeek provider 生成的 canonical root-tree session identifier，不是当前 agent 的原始 DSH session id。

对 top-level agent，root-tree id 由当前 DSH session id 和 cwd scope 得出。对 subagent，Obelisk 将 child messages 作为 sidechain 折叠进最顶层 root session；handoff 中的 `session_id` 因此必须指向该 root session，而不是 child member id。extra plugin 需要沿 durable `parentSession` lineage 解析 root，不能只对当前 child id 应用 top-level identity 公式。

它的用途是让模型对当前任务的缺失信息进行 scoped retrieval，避免 handoff 之后误把普通恢复查询执行为 global history search：

```js
return search('exact error or decision terms', {
  sessionId: '<session_id from handoff>',
  limit: 8,
});
```

### 7.2 `message_uuid`

`message_uuid` 是当前 DSH member 中 root model call 对应的 canonical Obelisk assistant `tool_use` anchor：

- native tool mode 下，root call 就是 `new_context`；
- PTC mode 下，root call 是包裹 `new_context` 的 `run_code`，通过 `ToolExecution.rootCallId` 识别。

plugin 根据 root `tool/call` event 获得 `turn` 和 `step`，并保留当前 member session id，然后调用与 Obelisk DeepSeek indexer 相同的 canonical identity helper。该 UUID 因此会与 Obelisk 后续真正索引出的 member message UUID 一致，而不是 plugin 自创的第二种 boundary identifier。该 message row 的 `session_id` 仍是上一节解析出的 root-tree session id。

新 context 可以直接执行：

```js
return context('<message_uuid from handoff>');
```

该 UUID 是上一段 active context 的末端 anchor。它不是可以进行字典序比较的区间端点，调用方不得用 UUID 大小推导消息顺序。

### 7.3 共享 identity 实现

目前 DeepSeek provider 内部的 session/message canonicalization 需要抽取成纯共享模块。Indexer 和 context-window extra plugin 必须共同调用该实现；extra plugin 不得复制 provider 的字符串模板或 cwd hashing 规则。

共享接口只暴露当前确实存在的消费者都需要的操作：

```ts
deepseekProjectScope(cwd): string
canonicalDeepseekTreeSessionId(rootNativeSessionId, scope): string
canonicalDeepseekMemberAssistantMessageUuid(
  memberNativeSessionId,
  scope,
  turn,
  step,
  kind,
): string
```

该重构必须保证现有所有 DeepSeek fixture 的 indexed IDs 完全不变。

alpha.4 继续在物理 header 中保存 `parentSession`，因此 lineage 输入仍然存在。root resolution 必须同时覆盖 live parent chain 和当前 parent 未进入 live `SessionStore` 的 resumed-child 场景；后者通过 DSH persistence metadata 解析，不能依赖 Obelisk index 已经刷新。

当前 Obelisk adapter 对 seeded fork child 尚未过滤物理 header 的 `seedLength` inherited prefix，会重复索引 child sidechain 中的父历史。这不是 alpha.4 新回归，但会降低 subagent handoff recovery 的准确性。在宣称 context-window extra plugin 支持 fork-based subagents 前，必须修正该 adapter 缺口并加入 alpha.4 seeded-child fixture。top-level 与无 inherited prefix 的 continuable child 不受该缺口影响。

## 8. 新 Context 中的 Handoff 呈现

rollover 后，新 active surface 中第一条 retained user-role context 使用以下稳定形式：

```text
Previous context is available in Obelisk.
session_id: <canonical Obelisk session id>
message_uuid: <previous-context assistant tool-use UUID>

<handoff>
<模型撰写的原始 prose>
</handoff>
```

字段名直接对应 Obelisk helper 的输入。模型可见内容中不出现 `boundary_uuid`、`transition_id` 或 `window_id` 等无法直接操作的实现词汇。

## 9. Model-requested Rollover 的 Durable 事实

extra plugin 不增加 `context-window/requested` event。DSH 已经记录了 model-requested rollover 所需的完整事实。

native tool mode 使用：

```text
assistant/message
→ tool/call(name = new_context, arguments = { handoff })
→ tool/result(success)
```

`tool/call` 保存原始 handoff 参数，成功的 `tool/result` 证明 tool runtime 已接受该请求。两者通过 `callId` 配对，并且都属于现有 durable session log。只有 call、没有成功 result 时不得触发 rollover。

PTC mode 使用 nested dispatch 的现有 durable pair：

```text
tool/code-dispatch-start(name = new_context, arguments = { handoff })
→ tool/code-dispatch(isError = false)
→ enclosing run_code tool/result(success)
```

`tool/code-dispatch-start` 与 `tool/code-dispatch` 通过 `subCallId` 配对，并通过 `rootCallId` 关联 enclosing model call。只有 nested dispatch 和 enclosing `run_code` 都成功时，才形成 model-requested rollover intent。

下一个 `agent/pre-step` 从 session log 找到最近一个满足以下条件的 pair：

- native tool pair 或 PTC nested dispatch 的 tool name 是 `new_context`；
- 对应 result 成功；
- PTC mode 下 enclosing `run_code` result 也成功；
- 当前 active history 中还没有引用该 root call 的 handoff replacement。

该 pair 本身就是 model-requested rollover intent。增加另一份 intent event 只会重复已有数据，并产生新的 replay consistency 问题。

### Host-only session projection

`context-window-state.ts` 注册一个不提供 client wire view 的 session projection。projection 只折叠 durable session events，并保存当前 active generation 的最小状态：

```ts
interface ContextWindowState {
  generation: number
  pendingModelRollover?: {
    mode: 'native' | 'ptc'
    rootCallId: ToolCallId
    handoff: string
    turn: number
    step: number
  }
  reminderClaimed: boolean
  fallbackClaimed: boolean
}
```

实现可以在 projection 内保留配对尚未完成的 native/PTC correlation records；这些记录属于内部 fold state，不进入其他模块的读取接口，并在 settle 或 generation rotation 后及时清理。fallback 是否耗尽由 budget policy 基于 `fallbackClaimed` 和当前 token measurement 计算，不重复存储。

projection 负责：

- 配对 native `tool/call` 与 `tool/result`；
- 配对 PTC `tool/code-dispatch-start`、`tool/code-dispatch` 与 enclosing `run_code` result；
- 识别 plugin-owned reminder/fallback context sources；
- 识别 committed handoff replacement，并递增内部 generation、清除上一 generation 的 pending/claim state；
- 从完整 replay 或 projection cache 恢复完全相同的状态。

`agent/pre-step` 通过 `ctx.sessionProjections.stateOf(session, key)` 读取状态，不重新遍历 session log。需要读取 projection 已定位的具体 event 时，使用 `session.eventAt(seq)`；禁止恢复旧的 `session.events[index]` 写法。

projection state 是从 durable log 派生的读模型，不是第二份 authoritative rollover store。即使没有加载 projection cache，也必须能从 session events 完整重建。

## 10. 安全边界上的 Surface Replacement

extra plugin 注册一个 `{ prepend: true }` 的 `agent/pre-step` waterfall listener。这是上一批 tool calls 已经 settle、下一次 model request 尚未从 active surface 派生 history 的公开安全点。

listener 先决定本次是否存在 rollover trigger：

1. 成功且尚未应用的 `new_context` tool pair 优先；
2. 没有 explicit request、但 fallback reserve 已耗尽时使用 `hard-limit` trigger；
3. 其他情况不执行 replacement。

对 explicit trigger，listener：

1. 检查 cancellation。
2. 从 host-only session projection 读取已经配对和校验的 prose handoff。
3. 通过 root call 的 `turn`/`step` 计算 host-derived `session_id` 和 `message_uuid`。
4. 确认当前 session 中尚不存在引用同一 root call 的 handoff replacement。
5. 读取 `session.surface.nodes`；所有节点均为 `SessionSeq`。
6. 使用 recovery anchors 和原样 prose 构造 handoff message。
7. 使用 token meter 对同一组 surface nodes 的 fixed-heuristic token price 求和，并先追加 DSH 现有的 `compaction/prune` shadow-price 记录。该记录只负责让 token projection 正确扣除被替换内容，不表示 rollover intent 或 commit。
8. 紧接着追加一个 `user/message`，以 `surfaceOp: { op: 'replace', start, end }` 替换完整 active surface。
9. 在 `sourceEventSeqs: SessionSeq[]` 中包含所有被 shadow 的 surface nodes。
10. flush session；flush 成功前不得 dispatch 下一次 model request。
11. 调用 `next()`，并保留 downstream `PreStepDecision` 的全部字段。

对 `hard-limit` trigger，listener 执行同一个私有 surface-replacement 操作，但使用 host 生成的降级 handoff：

```text
No prose handoff was produced before the hard context limit.
Recover the current task from this Obelisk session and message anchor.

session_id: <canonical Obelisk session id>
message_uuid: <latest previous-context assistant message UUID>
```

hard-limit anchor 指向强制 rollover 前最后一个可索引的 assistant message。该路径不伪造 model-authored handoff。

replacement message 使用 plugin-owned message source，在不可见的 durable metadata 中记录 trigger 和 recovery anchors：

```ts
type ContextRolloverTrigger =
  | { kind: 'model'; rootCallId: ToolCallId }
  | { kind: 'hard-limit' }

interface ObeliskContextHandoffSource {
  kind: 'obelisk-context-handoff'
  trigger: ContextRolloverTrigger
  sessionId: string
  previousContextMessageUuid: string
}
```

DSH 的 `MessageSourceMap` 支持 declaration merging。该 source 既是 handoff provenance，也是唯一的 durable rollover result。resume 时，model trigger 通过 `rootCallId` 幂等；hard-limit trigger 通过当前 generation 已存在的 replacement 幂等。

本设计只有一个私有 surface-replacement implementation，不增加公共 rollover commit interface，也不增加 opening/closing transaction events。

`compaction/prune` 必须与 replacement 相邻。实现需要在追加它之前完成 message、surface range、token measurement 和 identity 的全部可失败校验，沿用 DSH compaction 已有的 shadow-price plan/commit 约束；不得留下会被后续无关 replacement 消费的悬空计价记录。

DSH 当前在 `agent/pre-step` 之前已经完成 system prompt assembly。因此 rollover listener 不维护 window-specific dynamic system prompt。稳定 guidance 在 rollover 前后不变；新的 recovery identifiers 通过 replacement message 进入新 context。

## 11. Active History 与 Durable History

rollover 只改变 active DSH surface：

- 旧 user、assistant 和 tool-result messages 仍保留在 append-only session log；
- surface fold 只向下一次模型请求暴露 replacement handoff 及之后追加的 messages；
- Obelisk 继续索引完整 durable log，包括从 active DSH surface 中被 shadow 的旧消息；
- 新 context 可以通过 scoped search 或 `context(message_uuid)` 按需恢复证据。

本设计不创建第二套 handoff store。成功 tool pair 或 durable hard-limit state 提供 trigger，最终 replacement message 提供唯一结果。

## 12. Token Budget、Reminder 与 Fallback Reserve

extra plugin 挂载后，token-pressure policy 是必需行为，不是可选 feature。具体 token 数值属于 model-specific config，不得硬编码 Codex 的数值。

每个模型的有效 policy 至少包含：

```ts
interface ContextWindowBudgetPolicy {
  reminderThresholdTokens: number
  fallbackReserveTokens: number
  outputReserveTokens: number
}
```

第一版的配置归属为 context-window extra plugin row。三个字段都允许显式覆盖；未覆盖时，分别使用当前 request 的 effective `maxTokens`，因此 reserve 随 adapter/model 的实际输出上限变化，而不是复制 Codex 的固定数值。若 adapter 和 agent 都没有提供 effective `maxTokens`，并且 plugin row 也没有显式提供 `outputReserveTokens`，pressure policy 必须给出可操作的配置错误，不能静默失效。

host 使用 DSH 的有效 token measurement 和当前模型 context capacity 计算剩余预算。模型不得自报 token usage。

当前 `TokenMeasurement.logRevision` 是 `SessionLogOffset`，每个 `TokenSurfaceNode.seq` 是 `SessionSeq`。budget module 应直接消费这些 branded values，不引入自己的裸 `number` revision/position 类型。

预算分为：

```text
model context capacity
├── normal task budget
├── fallback reserve
└── output reserve
```

状态转换如下：

```text
normal
→ remaining <= reminder threshold
→ 自动注入一次 near-limit reminder
→ normal budget 耗尽且没有成功 new_context pair
→ 自动进入一次 fallback reserve inference
→ fallback reserve 耗尽或模型仍未请求 rollover
→ hard-limit forced rollover
```

### Near-limit reminder

- 每段 active context 最多注入一次。
- reminder 重复 prose handoff 的语义要求，并要求模型尽快调用 `new_context`。
- reminder 是带 plugin-owned source 的 durable user-role context，resume 后不得重复 claim。
- explicit `new_context` 已成功时，不再注入 reminder 或 fallback。

### Fallback reserve

fallback reserve 只用于生成 prose handoff 并调用 `new_context`，不得继续普通任务。

fallback prompt 要求模型：

1. 停止当前任务执行，不输出 final；
2. 生成覆盖 goal、decisions、progress、learnings、next steps、未完成 requests 和重要 actions 的简洁 prose handoff；
3. 调用一次 `new_context`；
4. 不调用其他工具。

fallback sampling 的工具 surface 只保留 `new_context`。由于 DSH 在 `agent/pre-step` 之前 assemble system prompt 和 tool schemas，extra plugin 必须在 `system-prompt/assemble` waterfall 中根据 token measurement 与 host-only projection state 识别 fallback phase，并过滤本次 assembly 的 tools。plugin 同时注册 execution guard，拒绝 fallback phase 中的其他 tool calls；不能只依赖 schema filtering 或 prompt discipline。

fallback claim 必须通过 plugin-owned durable context source 记录。每段 active context 只能 claim 一次，resume 后不能重新获得一份 reserve。

### Hard-limit forced rollover

如果 fallback sampling 未成功产生 `new_context` pair，或 reserve 已不足以继续安全 sampling，host 在下一个安全边界强制执行降级 surface replacement。该路径必须前进，不能因为缺少 prose handoff 而死锁。

forced rollover 使用 `handoff_status: missing` 的内部 provenance，并在新 context 中明确要求模型使用 `session_id` 与 `message_uuid` 从 Obelisk 恢复任务。

## 13. Resume 与失败语义

- 只有 `new_context` call、没有成功 result：不执行 model-requested rollover。
- 成功 `new_context` pair 存在、但没有对应 replacement：下一个 eligible `agent/pre-step` 应用 rollover。
- replacement source 已包含同一 `rootCallId`：后续处理 no-op。
- reminder/fallback source 已存在于当前 generation：不得重复 claim。
- fallback reserve 已耗尽且没有成功 tool pair：执行 hard-limit forced rollover。
- identity derivation 失败时，explicit tool result 必须失败，不得留下一个看似成功但无法恢复的 rollover request。
- surface replacement 校验失败时，旧 active history 继续保持 authoritative；不得报告 rollover 已应用。
- durability flush 失败时，下一次 model request 不得 dispatch。
- replacement append 后、flush 前发生 hard crash 时，由 DSH persistence semantics 决定恢复结果：replacement 已持久化则证明完成；否则成功 tool pair 或 durable hard-limit state 仍可在下一 eligible step 重试。
- Obelisk index lag 不阻止 rollover。确定性 identity 允许 handoff 在 incremental index catch up 前引用未来会出现的 canonical UUID。

## 14. Tool Scheduling、PTC 与 Compaction

`new_context` 不声明 concurrency-safe，因此 DSH 将它作为 exclusive barrier 调度。

第一版不修改 DSH scheduler，并与 Codex 初版一样接受 sibling semantics：同一个 assistant response 中，位于 rollover 之前的 sibling tools 可能已经执行。guidance 应要求模型只在 handoff 完成后调用 `new_context`，并且不要在其后安排无关工作。

PTC mode 下，`new_context` 是 SDK nested call。prompt 必须要求它成为 program 的最后一个 operation。plugin 可以在成功 result 后拒绝新的 nested tool calls，但无法撤销之前已经执行的 calls。严格 direct-model-only exposure 或整个 tool batch 的预先拒绝需要修改 DSH tools，不属于本 extra plugin 的范围。

context-window pressure policy 与 `compaction-basic.auto` 不得同时控制同一个 agent。启用 extra plugin 的 composition 必须关闭该 agent 的 automatic compaction，让 reminder、fallback reserve 和 forced rollover 成为唯一 pressure policy。手动 `/compact` 可以保留；它是用户显式选择的独立操作。

explicit rollover 与 hard-limit forced rollover 都在 prepended `agent/pre-step` listener 中先完成 replacement。之后继续委托时，后续 listener 只会看到已经缩小的 active surface。

## 15. Obelisk Skill 调整

现有 plugin-owned Obelisk skill 仍是历史检索接口。为 DSH rollover 增加一段简洁 guidance：

1. 先阅读当前 handoff。
2. 普通恢复查询默认使用其中的 `session_id`。
3. 需要从上一段 context 末尾展开时，使用 `context(message_uuid)`。
4. 只有任务需要当前 session 之外的证据时，才使用 global search。

skill 不教授 window listing、UUID range 或第二套 query protocol。

## 16. 验证要求

### 16.1 Package 与启用行为

- package 根导出仍然只注册 Obelisk skill。
- 现有 `obelisk.cordis.yml` 输出保持不变。
- `./context-window` export 可以独立 build、pack 和 load。
- 不挂载 extra row 的真实 Loader composition 不暴露 `new_context` 或 rollover guidance。
- 挂载 extra row 后，同时保留现有 Obelisk skill 和 extra behavior。
- package peer ranges 明确接受已验证的 alpha.4 peers；npm 与 pnpm 安装 smoke 均通过。

### 16.2 DSH v0.1.2-alpha.4 接口适配

- build 和 typecheck 使用 `SessionSeq` 表示 event/surface positions，使用 `SessionLogOffset` 表示 log lengths、half-open boundaries 和 watermarks。
- extra plugin 不访问已经移除的 `session.events`。
- host-only session projection 从完整 replay、incremental append 和 projection-cache restore 得到相同状态。
- hot-path `agent/pre-step` 不调用无界 `snapshotEvents()`；已知 event 通过 `eventAt(SessionSeq)` 精确读取。
- physical JSONL header fixture 仍使用 version-0 `seedLength` encoding，Obelisk DeepSeek provider 可以继续 discovery/index。
- `agent/pre-step`、tool result ordering、surface replacement 和 `ctx.sessions.flush()` 的现有行为分别有 real-composition coverage。

### 16.3 Prompt 与工具

- guidance 要求 goal、decisions、progress、learnings、next steps、未完成 user requests 和重要 actions，同时保留自由 prose body。
- 工具 schema 只接受一个非空 prose string，不接受模型控制的 identity fields。
- 调用工具只产生现有 DSH tool call/result 记录，不追加同义 intent event，也不立即改变 `session.surface.nodes`。
- 工具结果不回显 handoff。

### 16.4 Identity

- 共享 canonical helpers 对所有现有 DeepSeek provider fixtures 生成完全相同的 session/message IDs。
- native `new_context` 得到自身 assistant `tool_use` anchor UUID。
- PTC `new_context` 得到 enclosing root assistant `tool_use` anchor UUID。
- Obelisk 完成索引后，handoff 中的 `session_id` 存在，`context(message_uuid)` 可以解析预期的 previous-context message。
- top-level handoff 的 `session_id` 指向自身 Obelisk session；child handoff 的 `session_id` 指向 Obelisk root-tree session，`message_uuid` 指向 child member message。
- resumed child 在 parent 不 live 时仍能通过 persistence metadata 解析 root lineage。
- fork-based child 支持启用前，seeded-child fixture 证明 adapter 不重复索引 `seedLength` inherited prefix。

### 16.5 Rollover

- 下一次 `agent/pre-step` 将完整 active surface 替换为恰好一个 handoff message。
- 旧 user、assistant 和 tool-result content 不进入下一次 model request。
- 下一次 request 包含原样 prose handoff 和两个 recovery anchors。
- rollover 后同一个 user turn 继续 inference。
- 静态 initial context、system prompt 和 tool schemas 仍然存在。
- explicit rollover 不生成 summary。
- 启用 context-window pressure policy 的 composition 关闭 `compaction-basic.auto`，但仍可保留手动 `/compact`。

### 16.6 Reminder、Fallback 与 Forced Rollover

- 达到 model-specific reminder threshold 时自动注入一次 durable reminder。
- 同一 active context 不重复 claim reminder。
- normal budget 耗尽且没有成功 `new_context` 时，自动进入一次 fallback reserve inference。
- fallback sampling 的工具 schema 只保留 `new_context`，execution guard 拒绝其他 calls。
- 成功 `new_context` 优先于 fallback 和 forced rollover。
- fallback reserve 耗尽后强制 rollover，并生成带 `handoff_status: missing` provenance 的降级 handoff。
- resume 不重复发放已经 claim 的 reminder 或 fallback reserve。

### 16.7 Durability 与恢复

- replay 同一 root call id 只生成一个 committed replacement。
- committed rollover resume 后恢复 replacement surface。
- 成功 tool pair 尚未产生 replacement 时，resume 后在下一个 eligible step 应用 rollover。
- 只有 tool call、没有成功 result 时不 rollover。
- flush failure 阻止下一次 model request。
- Obelisk index lag 不影响 rollover；后续 refresh 可以解析预计算的 message UUID。

### 16.8 Product-level composition

- keyless recorded DSH session 覆盖从 tool call 到新 context request 的完整路径。
- recorded session 包含成功 tool pair、surface replacement、prose handoff 和 recovery anchors。
- 单独的 recorded sessions 覆盖 reminder、fallback success 和 forced rollover。
- 使用 handoff `session_id` 的端到端 Obelisk query 只返回目标 session 的证据。

## 17. 待确认问题

1. PTC calls 是否只使用 prompt discipline，还是 extra plugin 应在成功 `new_context` dispatch 后拒绝所有后续 nested tool calls？
2. 缺少 Obelisk skill contribution 时，extra plugin 是否应在 load 阶段失败？还是只要 CLI 和 model guidance 可用即可？
3. 当前 DSH persistence checkpoint policy 是否足以证明上述 crash cases，还是实现前需要增加一个 focused persistence fixture？

## 18. 验收标准

显式挂载 `@obelisk/dsh-obelisk-plugin/context-window` 后，模型可以提交 prose handoff；成功的现有 DSH tool pair 表示 model-requested rollover，handler 不立即修改 history；plugin 在下一安全 step 边界替换 active surface，并在同一个 user turn 中继续。接近 normal budget 上限时，host 自动提醒模型；normal budget 耗尽后提供一次只允许 `new_context` 的 fallback reserve；reserve 耗尽后强制 rollover。新 context 获得 host-derived Obelisk `session_id` 和可直接传给 `context()` 的 previous-context `message_uuid`；这些标识在不修改 Obelisk schema 的前提下可由现有 DeepSeek provider 索引并解析。

仅安装 package 根插件时，必须保持当前行为不变。
