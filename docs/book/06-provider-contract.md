# 第 6 章 · Provider 契约：discover / parse / cursor

沿 provider 轴往上走。这一章讲**契约**——一个适配器必须提供什么、被禁止做什么；下一章讲三个实现如何在同一份契约下做出完全不同的选择。

契约全文在 `packages/core/src/providers/types.ts`，269 行里绝大部分是注释。**这个文件没有一行运行代码**，注释里明确要求消费者用 `import type` 引入——它连一个可执行的模块都不是。

## 完整的接口

契约分两层：

```ts
// 索引必需的最小面
export interface Provider {
  readonly name: string;
  discover(ctx: DiscoverContext): IndexUnit[];
  parse(unit: IndexUnit, cursor: Cursor): Generator<TranscriptRecord, Cursor>;
}

// 加上展示与配置需要的部分
export interface ProviderAdapter extends Provider {
  readonly descriptor: ProviderDescriptor;
  readonly indexVersionMarker?: string;
  watchRoots(configuredRoot: string): string[];
  raw(input: RawLookup): RawRecord | null;
}
```

六个成员。Claude 适配器的工厂函数把它们凑齐只用了 14 行：

```ts
export function createClaudeProvider({ rootDir = join(homedir(), '.claude') } = {}): ProviderAdapter {
  return {
    name,
    descriptor: { id: name, name: 'Claude Code', vendor: 'Anthropic',
                  defaultRoot: rootDir, color: '#d97757' },
    indexVersionMarker: CLAUDE_CANONICAL_TRANSCRIPT_MARKER,
    watchRoots: (configuredRoot) => [
      join(configuredRoot, 'projects'),
      join(configuredRoot, 'history.jsonl'),
    ],
    discover: (ctx) => discoverAt(rootDir, ctx),
    parse,
    raw: rawClaude,
  };
}
```

注意它是**工厂**而不是单例导出——根目录可以注入。这让测试可以指向 fixture 目录，也让 App 的设置界面能改数据源。文件末尾另外导出了一个默认实例 `claudeProvider`，方便不需要定制的调用方。

下面逐个拆。

## IndexUnit：工作单元不是文件

```ts
export interface IndexUnit {
  key: string;          // 稳定标识，用作游标的键
  sessionId: string;    // 索引进哪个 session
  project?: string;     // 项目 slug（如果来源有这个概念）
  isSubagent?: boolean; // 这是一份 subagent 转写
  agentId?: string;
  meta?: unknown;       // 适配器私有载荷，编排层原样传回
}
```

类型注释开头就把话说死了：

> One unit of work an adapter has discovered. It is not necessarily a file.

这句话是整个契约里最重要的一处克制。**如果 `IndexUnit` 被定义成"一个文件"，那么所有非文件型的来源都进不来。** 具体地说：

- Claude：一个转写文件是一个单元，subagent 文件、workflow 的 JSON 各自也是单元
- Kimi：**一整个 session 目录**是一个单元——目录里有 `state.json` 和多个 `agents/*/wire.jsonl`，它们必须被当作一个整体处理
- 将来某个基于 SQLite 的来源：`key` 可以是 `"${dbPath}#${内部id}"`

`meta` 字段是配套的逃生口：适配器在 discover 阶段算出来的任何东西（解析好的路径、目录清单、文件句柄）都可以塞进去，编排层**原样**传回给 `parse`，中途绝不检查内容。

于是 discover 和 parse 之间有了一条私有通道，而编排层对通道里的东西一无所知。

## discover：适配器自己决定什么变了

```ts
export interface DiscoverContext {
  lastCursor(key: string): Cursor;
  changedPaths?: string[];
}
```

编排层提供两样东西，然后完全放手。

**`lastCursor(key)`** 让适配器查"这个单元上次处理到哪儿"。注意查询是**按需**的——适配器自己决定要不要查、查哪些 key。编排层不会替它算出一份"变更清单"。

为什么这么设计？因为**"什么算变了"是格式相关的**。Claude 比对文件 mtime；Kimi 得聚合整个目录下所有 wire 文件的最大 mtime 和总行数；某个数据库型来源可能要比对一个 rowid 水位。这些判断只有适配器懂。

**`changedPaths`** 是给 daemon 模式的优化：桌面 App 监听到具体哪些文件变了，就把清单传下来，适配器可以只扫这些路径而不是整棵树。注意它是**可选**的——不传就是全量扫描。而且强制重建时编排层会主动把它清空（`provider-indexing.ts`），因为那时候"只看变化的"是错的。

## parse：一个返回游标的生成器

```ts
parse(unit: IndexUnit, cursor: Cursor): Generator<TranscriptRecord, Cursor>;
```

这个签名有两处不寻常，都是有意的。

**第一，它是生成器，不是返回数组的函数。**

于是记录一边产出一边被写入，不需要先在内存里攒一份完整列表。对一个几十 MB 的转写文件来说这不是小事。

`persist.ts` 里消费它的循环朴素到极点：

```ts
let step = gen.next();
while (!step.done) { write(step.value); step = gen.next(); }
const cursor = step.value;
```

**第二，生成器的 `return` 值是新游标。**

TypeScript 的 `Generator<T, TReturn>` 第二个类型参数正好表达这件事：产出的是记录，最终返回的是"我处理到这里了"。

这个选择的好处是**游标和记录在同一个事务里**。看 `provider-indexing.ts` 那行：

```ts
const cursor = runTransaction(..., () => persist(db, item.unit, item.provider.parse(item.unit, item.cursor)));
```

解析、写记录、写游标，全部在一个事务内。要么这个单元的所有记录和它的新游标一起提交，要么全部回滚、游标停在原处、下次重来。**不可能出现"记录写了一半但游标已经前进"的状态。**

如果游标是通过回调或者另一次调用返回的，这个原子性就得靠约定维持。现在它由类型保证。

## Cursor：不透明是一种能力

```ts
export type Cursor = string | null;
```

上一章讲过它的存储形式，这里讲它的语义规则。类型注释写得很直接：

> ONLY the adapter that produced it interprets it.

编排层做的事只有存和取。存的时候按冒号拆成两个数字塞进 `index_state` 的两列（`persist.ts`）：

```ts
const [mtime, lines] = cursor.split(':');
st.idx.run(unit.key, Number(mtime), Number(lines));
```

取的时候拼回来（`provider-indexing.ts`）：

```ts
return row ? `${String(row.mtime)}:${String(row.lines_processed)}` : null;
```

**这里有一处诚实的妥协值得指出**：编排层其实假设了游标是 `"数字:数字"` 的形状——它要拆开塞进两个数值列。所以"完全不透明"是有折扣的，真实的约束是"内容语义不透明，但格式是一对数字"。

这对现有三个适配器都成立（Claude 用 mtime + 行数，Codex 用 mtime + 行数，Kimi 用聚合 mtime + 总行数）。将来如果有来源需要别的形状，这里就是要改的地方——`types.ts` 的注释里也提到了"rowid 或时间戳水位"这类可能。**知道抽象在哪里有折扣，比假装它没有折扣更有用。**

## 纯：三层含义

契约反复强调适配器是"纯"的。这个词在这里有三层意思，一层比一层强：

**第一层：不写数据库。** 显而易见。

**第二层：不知道数据库存在。** 适配器不接收 db handle、不 import 任何持久化模块、不知道自己的产出会被存成什么。它只是把一种格式翻译成另一种格式。

**第三层：可以被没有 SQLite 的运行时加载。** 这是最实际的一层，也是最容易被无意破坏的一层。

第 2 章讲过：Electron 打包的 Node **没有 `node:sqlite`**。所以适配器和它们依赖的 `parsing.ts` 必须一行 SQLite 都不碰——不是"最好不碰"，是"碰了 App 就在运行时炸"。

`parsing.ts` 的 import 只有 `node:fs`、`node:path`、`node:os`。这个约束没有类型系统保护，全靠人守。

## registry：启动时就把错误挡住

```ts
export function createProviderRegistry(providers: readonly ProviderAdapter[]): ProviderRegistry {
  for (const provider of providers) {
    const id = provider.descriptor.id;
    if (provider.name !== id) {
      throw new Error(`Provider name "${provider.name}" must match descriptor id "${id}"`);
    }
    if (byId.has(id)) throw new Error(`Duplicate provider id: ${id}`);
    byId.set(id, provider);
  }
  ...
}
```

两条校验，都在**构造时**抛错，不是运行到一半才发现。

第一条（`name` 必须等于 `descriptor.id`）看起来是多余的重复，其实是在防一类很隐蔽的 bug：`name` 被写进数据库的 `source` 列，`descriptor.id` 被用于设置界面和 `raw()` 分派。两者不一致的话，索引进去的行永远查不回原始记录——**而且不会报错，只会静默地找不到**。构造时校验把这类问题变成启动即崩。

内置注册表本身只有 14 行（`builtins.ts`），就是把三个工厂串起来。加第四个来源，这里加一行。

注册表还提供两个聚合能力：

```ts
watchRoots: (configuredRoots = {}) => [...new Set(
  list().flatMap(p => p.watchRoots(configuredRoots[p.name] ?? p.descriptor.defaultRoot))
)],
raw: (input) => byId.get(input.source)?.raw(input) ?? null,
```

`watchRoots` 把所有适配器要监听的路径合并去重——桌面 App 拿这一份清单去建文件监听，不需要知道有几个来源。`raw` 按 `source` 分派，找不到就返回 `null` 而不是抛错。

## raw：为什么适配器还得管"回到原文"

`raw()` 这个成员初看很违和：索引都建好了，为什么还要回源文件？

因为**索引里的文本是被截断的**。`parsing.ts` 里 `TEXT_LIMIT = 10000`，超过 1 万字符的消息正文和工具输入输出在入库时就被切掉了。这是个刻意的取舍：索引是为检索服务的，不是为归档服务的。

但有时候确实需要全文——App 里展开一条超长的工具输出，或者 agent 要看某条消息的完整原始 JSONL 行。这时候只能回源文件。

而**只有适配器知道怎么定位那一行**。看 Claude 的实现：

```ts
function rawClaude(input: RawLookup): RawRecord | null {
  const mainPath = input.session?.jsonl_path;
  let sourcePath = mainPath;
  if (input.agentId !== null) {
    const runId = input.workflowAgent?.['run_id'];
    sourcePath = typeof runId === 'string'
      ? join(dirname(mainPath), sessionId, 'subagents', 'workflows', runId, `${agentId}.jsonl`)
      : join(dirname(mainPath), sessionId, 'subagents', `${agentId}.jsonl`);
  }
  ...
}
```

一条属于 workflow agent 的消息，原文在 `subagents/workflows/<runId>/<agentId>.jsonl`；一条普通 subagent 的消息在 `subagents/<agentId>.jsonl`；主线消息在 session 自己的文件里。**这套目录约定是 Claude Code 的私事**，让通用代码去懂它就是又一次语义泄漏。

找到之后是逐行扫描：先用 `line.includes(uuid)` 快速排除，命中了再 `JSON.parse` 确认。返回结构支持分页（`offset` / `limit` / `hasMore`），因为原始行本身可能极长。

所以 `raw()` 的存在不是设计冗余，而是"索引有损"这个事实的必然配套。**有损索引 + 可回源，合起来才是完整的证据层。**

## indexVersionMarker：解析语义变了怎么办

```ts
readonly indexVersionMarker?: string;
```

考虑这个场景：你改了 Claude 适配器，让它现在能正确识别某类之前被误判的消息。代码是对的了，但**数据库里躺着的是旧逻辑解析出来的行**。

传统做法是写一个数据迁移脚本。但在这里有更简单的路——**源文件还在**。所以正确的动作不是迁移数据，而是**把这个来源整个重放一遍**。

`indexVersionMarker` 就是这件事的开关。它是个字符串（Claude 的是 `__claude_canonical_transcript_v2__`），编排层检查 `index_state` 里有没有这个 key：

```ts
const markerMissing = marker !== undefined && !db.prepare(
  'SELECT jsonl_path FROM index_state WHERE jsonl_path = ?').get(marker);
const fullReindex = force || (markerMissing && sourceAlreadyIndexed(db, provider.name));
```

没有这个标记、而且这个来源已经索引过东西——说明库里是旧语义的数据，于是这一次把所有游标当成 `null`，整源重解析。跑完并且没有失败，才写下标记。

**改了解析逻辑，就换一个 marker 字符串。** 数据迁移就这样被替换成了一次重放。这是"索引是投影、源文件才是真相"这个立场带来的直接红利。

注释里还有一句值得注意：

> absence forces one provider-owned replay

不提供 marker 的适配器，行为是保守的那一侧。细节在第 14 章。

## descriptor：给人看的那部分

```ts
export interface ProviderDescriptor {
  readonly id: string;
  readonly name: string;      // 'Claude Code'
  readonly vendor: string;    // 'Anthropic'
  readonly defaultRoot: string;
  readonly color: string;     // '#d97757'
}
```

里面有个 `color`，说明它的用途很明确：**这是给设置界面和渲染层用的可序列化元数据**。App 里那些区分来源的色块就来自这里。

它被单独拎成一个字段而不是散在适配器上，是为了让它能安全地穿过 IPC 边界——`catalog()` 返回的是 `{ ...provider.descriptor }` 的浅拷贝，不带任何函数。

## 契约禁止什么

正面列完，反过来看边界。一个适配器**不可以**：

| 禁止 | 原因 |
|---|---|
| 打开或写数据库 | 规则一；也会让 App 无法加载它 |
| 引入 `node:sqlite` | Electron 运行时没有它 |
| 解释别的适配器的游标 | 游标语义是私有的 |
| 假设自己一定被完整调用 | 单元可能失败被跳过，下次从旧游标重来 |
| 产出未定义的 record kind | `persist` 的 `default` 分支直接抛错 |
| 依赖被调用的顺序 | 单元之间无序，一行可能由多个单元拼成 |

最后两条最容易犯。第五条有硬保护——`persist.ts` 的 switch 末尾：

```ts
default:
  throw new Error(`persist: unhandled record kind ${(r as { kind: string }).kind}`);
```

第六条没有保护，只能靠适配器自己遵守：**任何一个单元都必须假设自己可能第一个跑、也可能最后一个跑。** 这正是上一章讲的"大量可选字段 + `COALESCE` 合并"存在的原因——它是这条约束在写入侧的配套。

## 这一章你应该带走的

1. 契约六个成员：`name` / `discover` / `parse` / `descriptor` / `watchRoots` / `raw`，外加可选的 `indexVersionMarker`。
2. **`IndexUnit` 不是文件**，`meta` 是 discover 到 parse 的私有通道。
3. `parse` 是生成器且 `return` 游标，于是记录和游标天然在同一个事务里。
4. 游标语义不透明——但格式上仍被假设为一对数字，这是个已知的折扣。
5. "纯"的最强含义是：**能被没有 SQLite 的运行时加载**。
6. `raw()` 是"索引有损"的必然配套；`indexVersionMarker` 用重放取代了数据迁移。

下一章看三个适配器如何在这份契约下做出完全不同的选择——尤其是 Kimi，它的来源根本不是消息列表。
