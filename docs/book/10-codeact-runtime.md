# 第 10 章 · CodeAct 运行时：沙箱、helper 与只读边界

转到读出侧。

第 1 章说过 `query(code)` 的参数是代码而不是查询条件，当时只是陈述。这一章讲它是怎么实现的、边界划在哪里，以及**为什么不是给 agent 一组检索工具**。

两个文件：`core.ts`（90 行，四个动词 + 沙箱）和 `query.ts`（595 行，16 个 helper）。

## 四个动词的实现

`core.ts` 里三个导出函数，对应四个动词中的三个（`build` 直接复用 `buildIndex`）：

```ts
export function searchText(text: string, opts?): unknown {
  buildIndex();
  const db = openReadDb();
  try {
    return createQueryApi(db).search(text, opts);
  } finally { db.close(); }
}

export async function executeQuery(scriptContent: string): Promise<unknown> {
  buildIndex();
  const db = openReadDb();
  try {
    return await runInSandbox(createQueryApi(db), scriptContent);
  } finally { db.close(); }
}

export async function executeAttune(scriptContent: string): Promise<unknown> {
  // …所有权检查与写者租约（第 13 章）…
  const db = openDb();
  try {
    return await runInSandbox(createAttuneApi(db), scriptContent);
  } finally { db.close(); }
}
```

三个函数的形状一模一样：**刷新索引 → 开连接 → 造 API → 跑 → 关连接**。差别只有两处：`executeAttune` 开的是可写连接，而且它注入的是另一套 API。

`searchText` 值得注意——它没有走沙箱，直接调用了 `search` helper。因为 `--search` 的参数是一个字符串而不是一段代码，不需要执行环境。**它是 `query` 的一个便捷特例，不是独立的能力。**

## 沙箱：8 行

```ts
function runInSandbox(api: SandboxApi, scriptContent: string): Promise<unknown> {
  const sandbox = {
    ...api, JSON, Math, Array, Object, Set, Map, Date, RegExp,
    parseInt, parseFloat, String, Number, Boolean, Error, Promise, console, setTimeout,
  };
  const ctx = createContext(sandbox);
  return runInNewContext(`(async()=>{${scriptContent}})()`, ctx, { timeout: 30000 });
}
```

四件事：

**一、上下文是一个对象字面量。** 沙箱里能访问的全局，就是这个对象的键。`...api` 展开的是 16 个 helper，后面跟着一批内置对象。

**二、脚本被包成异步 IIFE。** 于是脚本里可以直接 `return`（这是 agent 写脚本的默认姿势），也可以 `await`。

**三、30 秒超时。** 一段写坏的查询最多浪费半分钟。

**四、返回的是 Promise。** `runInNewContext` 返回 IIFE 的求值结果，也就是那个 Promise，调用方 `await` 它。

### 白名单里没有什么

比"有什么"更重要：

```text
没有 require        → 加载不了任何模块
没有 import         → 同上（而且 vm 上下文里本来就没有模块系统）
没有 fs             → 读不了文件、写不了文件
没有 fetch / http   → 发不出网络请求
没有 process        → 拿不到环境变量、命令行、也退不出进程
没有 Buffer         → 摸不到原始内存
```

**净效果：脚本能读数据库、能算，但带不走任何东西。** 它唯一的输出通道是返回值。

这不是防恶意——脚本是 agent 自己写的，而且 agent 本来就有 shell 权限。它的作用是**把"查询"这个动作的能力边界钉死成一个纯函数**。一段查询脚本不可能有副作用，所以：

- 重跑一遍一定得到相同的结果（除非索引变了）
- 它不可能悄悄修改你的文件或者把数据发到别处
- 出了问题，可能性空间只有"这段 SQL 写错了"

第 1 章说 Obelisk 是显式记忆、查询发生在明处——**这 8 行是那句话的技术实现**。

### 两套 API 不相交

```ts
createQueryApi(db)  → { sql, search, context, trace, thread, subagents, workflows,
                        workflowTree, fileHistory, failures, sessions, recent,
                        summaries, raw, memories, overview }

createAttuneApi(db) → { remember, forget }
```

**没有交集。** `--query` 的脚本调不到 `remember()`，`--attune` 的脚本调不到 `search()`、`sql()`、甚至 `memories()`。

后半句常被误解成设计缺陷——写记忆的时候难道不该先查查有没有重复吗？该，但那要分两步做：先用 `--query` 查出需要的 ID，再用 `--attune` 提交一段窄脚本。

**这个不便是刻意的。** 记忆写入是需要人批准的操作，它的脚本应该短到人能一眼看完。如果 attune 沙箱里有完整的检索能力，一段"写记忆"的脚本可以长成任意复杂的程序，人就没法审了。

## `sql()` 的三重保障

```ts
const q = (sql: string, ...p: any[]) => {
  assertReadOnlySql(sql);
  return db.prepare(sql).all(...p);
};
```

只读性由三层保证，层层独立：

**第一层：连接本身是只读的。**

```ts
new DatabaseSync(DB_PATH, { readOnly: true });
```

这是硬保障——即使前两层全被绕过，SQLite 也会拒绝写入。

**第二层：语句必须以 SELECT / WITH 开头。**

```ts
if (!/^(SELECT|WITH)\b/i.test(text)) {
  throw new Error('sql() only supports read-only SELECT/WITH queries');
}
```

**第三层：黑名单关键字。**

```ts
if (/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|VACUUM|ATTACH|DETACH)\b/i.test(text)) {
  throw new Error('sql() only supports read-only SELECT/WITH queries');
}
```

后两层不是为了安全——第一层已经够了——**它们是为了让错误提前，并且报得清楚**。一个 agent 写了 `UPDATE`，得到的是"sql() 只支持只读查询"，而不是 SQLite 抛出的"attempt to write a readonly database"。前者能让它立刻改对，后者会让它以为是权限配置问题。

黑名单里 `PRAGMA` 和 `ATTACH` 值得单独提：前者能改连接行为，后者能挂载别的数据库文件。它们在只读连接上未必能造成写入，但都属于"不该出现在一次检索里"的动作。

代价是有一类误伤：一个正当的查询如果在字符串字面量里包含 `delete` 这个词，会被拦下。这是个已知的取舍——**宁可偶尔误伤，也不放过**。

## helper 的几个共同模式

16 个 helper 长得很像，因为它们共享几个模式。理解这几个模式，就理解了整套 API。

### 模式一：标量简写

```ts
function normalizeOpts(optsOrScalar, scalarKey = 'sessionId'): QueryOptions {
  if (optsOrScalar == null) return {};
  if (typeof optsOrScalar === 'string') return { [scalarKey]: optsOrScalar };
  if (typeof optsOrScalar === 'number') return { limit: optsOrScalar };
  return optsOrScalar;
}
```

传字符串当 `sessionId`，传数字当 `limit`，传对象就是完整选项。于是 `subagents('abc-123')` 和 `subagents({ sessionId: 'abc-123' })` 等价，`sessions(5)` 和 `sessions({ limit: 5 })` 等价。

**这是为写脚本的人（agent）优化的**：最常见的两种调用不需要写对象字面量。

`overview` 有自己的一份变体——它的字符串参数是 `project` 而不是 `sessionId`，因为对一张地图来说按项目过滤才是常识默认。

### 模式二：过滤器和列名解耦

```ts
function buildWhere(opts: QueryOptions, aliases: ColumnAliases) {
  const clauses: string[] = [];
  const params: any[] = [];
  if (opts.sessionId) { clauses.push(`${aliases.sessionId} = ?`); params.push(opts.sessionId); }
  if (opts.project)   { clauses.push(`${aliases.project} LIKE ?`); params.push(opts.project); }
  if (opts.after)     { clauses.push(`${aliases.timestamp} > ?`); params.push(opts.after); }
  ...
  return { where: clauses.length ? clauses.join(' AND ') : '1=1', params };
}
```

同一组过滤器（`sessionId` / `project` / `after` / `before` / `branch` / `source`）要作用在不同的表上，而每张表里这些概念对应的列名不同。`ColumnAliases` 就是那张映射表，每个 helper 传自己的：

```ts
// workflows
{ sessionId: 'w.session_id', project: 's.project', timestamp: 'w.timestamp', branch: 's.git_branch', source: 's.source' }

// failures
{ sessionId: 'tr.session_id', project: 's.project', timestamp: 'rm.timestamp', branch: 's.git_branch', source: 's.source' }
```

于是过滤逻辑只写一遍，而 `after: '2026-08-01'` 在 `workflows()` 里筛的是 workflow 自己的时间戳、在 `failures()` 里筛的是那条工具结果所属消息的时间戳。

`where` 为空时返回 `'1=1'`，这样调用处永远可以无条件拼 `WHERE ${where}`。

### 模式三：惰性 JOIN

```ts
const needsJoin = opts.project || opts.branch || opts.source;
const join = needsJoin ? 'LEFT JOIN sessions s ON s.id=sa.session_id' : '';
```

只有在过滤条件真的用到 `sessions` 表的列时才 JOIN。不带过滤条件的 `subagents()` 跑的是单表查询。

### 模式四：一切都有上限

每个列表 helper 都有默认 `limit`：`search` 20、`sessions` 50、`failures` 50、`subagents` 100、`workflows` 100、`summaries` 100、`fileHistory` 200。

**没有一个 helper 会返回无界的结果。** 因为返回值要进 agent 的上下文——一次没有上限的查询可能直接吃掉整个 context window。

### 模式五：默认排除 meta

```ts
const metaClause = includeMeta ? '' : 'AND COALESCE(is_meta,0)=0';
```

`search()` 和 `thread()` 默认过滤掉 `is_meta=1` 的行。而 `context()` 和 `trace()` **不过滤**——它们要还原真实的父链，中间少一环链就断了。它们的做法是把 `is_meta` 原样返回，让调用方自己判断。

**"该不该显示"和"该不该存在于链条里"是两个问题**，这里区分得很干净。

## `search()` 里的两个细节

### FTS5 语法的兜底

```ts
let rows;
try {
  rows = runMatch(text);
} catch {
  const safe = buildSafeFtsQuery(text);
  rows = safe ? runMatch(safe) : [];
}
```

先原样把用户输入交给 FTS5。如果它是合法的 FTS5 语法（`"exact phrase"`、`a OR b`、`prefix*`），就按 FTS5 的语义执行——这让懂的调用方能用上全部能力。

如果 FTS5 解析失败（输入里有连字符、括号、中文标点这些会被当成操作符的字符），退回安全模式：

```ts
function buildSafeFtsQuery(text: unknown): string {
  const tokens = String(text || '').match(/[\p{Letter}\p{Number}]+/gu) || [];
  return tokens.slice(0, 12).map(token => `"${token}"`).join(' ');
}
```

按 Unicode 字母数字切词，每个加引号，最多 12 个。

**两个目标同时达成**：raw 语法可用，普通输入不崩。这个 `try/catch` 是"先尝试强大的，失败了退回安全的"这个模式的一个干净例子。

### 三种"上下文"

`search()` 返回的每条命中带一个 `context` 字段：

```sql
SELECT uuid, text, content_type, is_meta, role, timestamp, model, ...
FROM messages
WHERE session_id = ? AND uuid != ? AND COALESCE(is_meta,0) = 0
ORDER BY ABS(JULIANDAY(timestamp) - JULIANDAY(?))
LIMIT 6
```

按时间距离取最近的 6 条，再按时间排回正序。所以一条命中不是孤零零一句话，而是一小段现场。

但这个词在这套 API 里有三个不同的意思，**这是最容易踩的坑**：

| | 是什么 | 用途 |
|---|---|---|
| `search()` 返回的 `context` | **时间邻居** | 快速判断这条命中值不值得追 |
| `context(uuid)` | 消息 + **父链** + session + subagent + workflow | 展开一个证据点的完整背景 |
| `trace(uuid)` | 纯**父链**，从根到这条 | 只要因果链 |

时间上挨着 ≠ 因果上相关——尤其在有 subagent 并发的会话里，时间邻居可能来自完全无关的另一条线。

## `overview()`：一张带置信度的地图

这是最长的一个 helper，也是最不像"查询"的一个。它回答的是"我现在在哪"。

最有意思的是它怎么判断当前项目——**三级降级，每一级都记录了自己的可信度**：

```ts
const resolveCurrentProject = () => {
  // 一级：调用方明确指定
  if (opts.project) { ... return projectDescriptor(row, 'opts', confidence); }

  // 二级：cwd 落在某个 project_path 之内
  const byProjectPath = paths
    .filter(r => cwd === r.project_path || cwd.startsWith(r.project_path + path.sep))
    .sort((a, b) => b.project_path.length - a.project_path.length || ...)[0];
  if (byProjectPath) return projectDescriptor(byProjectPath, 'cwd_project_path', 'exact');

  // 三级：某条消息的 cwd 恰好等于当前 cwd
  const byMessageCwd = db.prepare(`... WHERE m.cwd = ? ...`).get(cwd);
  if (byMessageCwd) return projectDescriptor(byMessageCwd, 'cwd_messages', 'inferred');

  return null;
};
```

返回值里带着 `source` 和 `confidence` 两个字段：

```json
{ "project": "-Users-tomiya-Code-quiet-zero",
  "project_path": "/Users/tomiya/Code/quiet-zero",
  "source": "cwd_project_path",
  "confidence": "exact" }
```

**它不假装自己一定对。** 二级匹配按 `project_path` 长度降序排——嵌套目录时最长（最具体）的那个胜出。这是个推断，所以标 `exact` 只是因为路径前缀匹配是确定的；三级是从消息 cwd 反推的，标 `inferred`。

这对应 `PRODUCT.md` 里那条设计原则：

> Preserve uncertainty: never present inferred structure as observed execution fact.

**skill 文档里也反复强调 `overview()` 是地图不是证据**——它帮你确定查询范围，结论要靠 `search()` 和其他 helper 去取。

## `raw()`：query 层不解析格式

```ts
const raw = (messageUuid: string, opts = {}) => {
  const message = db.prepare('SELECT * FROM messages WHERE uuid=?').get(messageUuid);
  if (!message) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(message.session_id) ?? null;
  const subagent = ...; const workflowAgent = ...;
  const source = message.source || session?.source || 'claude';

  const record = providerRegistry.raw({ source, messageUuid, session, agentId, subagent, workflowAgent });
  if (record === null) return null;

  const totalLength = record.totalLength ?? record.text.length;
  return { text: record.text.slice(offset, offset + limit), totalLength, offset, limit,
           hasMore: offset + limit < totalLength };
};
```

query 层做的事只有两件：**从数据库里凑齐定位所需的信息**，然后**把结果切片分页**。中间那步"怎么找到那一行原文"完全转给注册表，由对应的适配器实现（第 6 章）。

这是第 2 章那三条依赖规则在读出侧的体现：**检索层不认识任何来源的文件格式**。

## 记忆层的语言闸

```ts
const CJK_TEXT_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function assertEnglishMemoryText(value: unknown, label: string): void {
  if (CJK_TEXT_RE.test(text)) {
    throw new Error(`${label} ${requirement}; translate user-language terms before using the memory layer`);
  }
}
```

`memories({ query })` 和 `remember({ summary })` 都过这道闸。检测到中日韩文字直接抛错。

理由在第 5 章讲过一半：`memories_fts` 用的是 `unicode61` 分词器，对 CJK 的分词效果很差（没有词边界，基本退化成整串匹配）。但更根本的理由是**跨语言复用**：用户可能用中文、日文、英文提问，如果记忆按各自的语言索引，同一个结论就会分裂成互相召回不到的几份。

强制英文让记忆层成为一个统一的检索面。这道闸是**运行时报错**而不是静默转换，因为静默转换会让 agent 以为自己写进去的是原文。

`messages_fts` 不受这个限制——它索引的是原始对话，本来就什么语言都有。

## 返回形状是契约的一部分

ADR-0002 把运行时契约分成两层：

**Tier 1（硬冻结）**：四个动词的 CLI I/O 信封（文件/参数进、格式化 JSON 出、`{error, stack}` 错误信封、退出码），以及沙箱契约（`sql()` 只读、`attune` 只暴露 `remember`/`forget`、沙箱里有哪些全局）。

**Tier 2（锁定到文档）**：每个 helper 的返回形状，以 `skill-doc/references/api-reference.md` 为准，由契约测试断言实际返回与文档一致。

第二层的意义在于：**agent 依赖的不是函数签名，而是返回的 JSON 里有哪些字段。** 一个 helper 悄悄改掉某个字段名，类型系统不会报错，但所有教 agent 怎么用它的文档和示例会同时失效。

所以那份 API 文档被提升为**权威契约**：改一个 helper 的返回形状，必须同时改文档，并且是一次有意的版本变更。

## 为什么是 CodeAct 而不是一组工具

到这里可以回答第 1 章留下的问题了。

设想另一种设计：把这 16 个 helper 各自暴露成一个工具，agent 通过工具调用来检索。表面上更"标准",但代价是具体的：

**一、过滤只能在 context 里做。** 工具返回什么，就有什么进上下文。想要"最近 8 条命中，每条截断到 240 字"，要么工具支持这个参数，要么全量返回后由 agent 自己截——而后者意味着全文已经进过上下文了。

CodeAct 里这是一行 `.map()`：

```ts
search('auth bug', { project, limit: 8 }).map(h => ({
  session_id: h.session.id, uuid: h.message.uuid,
  snippet: h.message.text?.slice(0, 240),
}))
```

**裁剪发生在数据这一侧。**

**二、多步检索要多个回合。** "先 overview 拿到项目，再按项目 search，再对每条命中取父链"——工具形态下是三到四个回合，每个回合的中间结果都留在上下文里。CodeAct 里是一个脚本、一次调用、一份结果。

**三、组合能力受限于预设。** 工具能做的组合是设计者预先想到的那些。而"把 failures 的结果按 session 分组、只留错误数超过 3 的、再取每组第一条的父链"这种查询，没人会专门做成一个工具，但写成 JS 是十行。

**四、helper 一旦外露就变成公共契约。** 内部 helper 可以改；一组对外的工具改一个参数就是破坏性变更。把它们关在沙箱里，`api-reference.md` 那层契约的演进成本才是可控的。

代价也要说清楚：**agent 得会写 JavaScript，而且写错了会拿到运行时错误。** 这是个真实的门槛，skill 文档里那些查询范式和常见陷阱就是在补这个门槛。

> **当时**
>
> 这个设计差点在一次讨论里被走偏。2026-07-08 讨论 MCP 传输层时，助手按常见的 MCP 设计，顺手把接口拆成了 `search / context / thread / memories` 一组工具。被指出后：
>
> > "你说得对，这个锅我接。我前面明明已经看过 `runtime.mjs` 和 `SKILL.md`，里面写得很清楚：Obelisk 的核心不是 helper tools，而是 **agent 写 JS query，由 runtime 执行**。我却在讲 MCP 的时候顺手套了常见 MCP 设计，把它拆成一堆工具调用。"
>
> 修正后的基线被写成一句不变原则：
>
> > "Obelisk 的外部接口必须保持 runtime-shaped，而不是 tool-shaped。"
> > "未来所有 adapter 只是换传输层……而不是 `MCP exposes search/context/thread/memories...`"
>
> 以及那句判断后果的话：
>
> > "一旦搞错这一点，后面的 roadmap 都会偏：它会把 Obelisk 从 CodeAct memory infra 变成普通 retrieval plugin。"
>
> 出处：Codex session `019f4049`（提升 obelisk 影响力），2026-07-08。

## 这一章你应该带走的

1. 三个动词的实现形状相同：**刷新索引 → 开连接 → 造 API → 跑 → 关连接**。
2. 沙箱只有 8 行，白名单里**没有任何 I/O**——脚本能读，但带不走。
3. query 和 attune 两套 API **不相交**，因为记忆写入的脚本必须短到人能审。
4. `sql()` 的只读性有三层保障，后两层是为了让错误报得清楚。
5. helper 的五个共同模式：标量简写、过滤器与列名解耦、惰性 JOIN、处处有上限、默认排除 meta。
6. "context"在这套 API 里有三个意思，时间邻居 ≠ 因果父链。
7. `overview()` 是**带置信度的地图**，不是证据。
8. 返回形状是 Tier 2 契约，改它要同时改文档。
9. CodeAct 的核心优势是**过滤发生在数据侧、多步检索只花一个回合**。

下一章讲第二套 API：记忆层。
