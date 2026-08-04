# 第 11 章 · 记忆层：attune、remember、forget

上一章讲检索——从原始证据里取事实。这一章讲另一件事：**把从证据里得出的结论存下来。**

代码量很小。`createAttuneApi` 整块 68 行（两个 API 函数加两个校验辅助）；`memories()` 是第 16 个 helper，33 行；表结构 5 行。**这一章的内容不在代码量上，在于它划下的那几条线。**

## 两层记忆，一次查询

第 1 章的三层分类里，Obelisk 做后两层：

```text
② 可查询的会话记忆 —— 原始证据，随时可查
③ 人类批准的长期记忆 —— 结论，需要批准
```

关键是**它们不是替代关系**。skill 文档里的表述是：

> Every retrieval queries both layers: `memories()` for prior conclusions, `search()` and helpers for raw session evidence.
> Use memory as prior notes, not final authority.

**记忆是先前的笔记，不是最终权威。** 一个典型的首轮查询同时问两层：

```js
return {
  prior_memories: memories({ project, query: 'authentication bug fix', limit: 5 }),
  session_evidence: search('auth bug fix', { project, limit: 8 }),
};
```

这个"同时问两层"的姿势是有意义的。记忆可能过期——它记录的是**写下它的那一刻**的结论，而代码在那之后可能已经变了。所以文档要求：如果一条记忆影响了回答，要说明这是先前记录的；如果正确性依赖它，要拿原始证据对一遍。

这是第 1 章"拒绝隐式记忆"在使用层面的延续：**不仅召回要显式，召回结果的可靠性也要显式。**

## 记忆是什么：文件 + 注册记录

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY, session_id TEXT, project TEXT,
  message_start TEXT, message_end TEXT,
  path TEXT, anchors TEXT, summary TEXT, created_at TEXT,
  deleted_at TEXT, deleted_reason TEXT);
```

**正文不在数据库里。** 数据库存的是一条指向 markdown 文件的注册记录。

这个拆分带来几个直接后果：

**记忆是普通文件。** 放在 `.obelisk/memories/` 下，可以用编辑器打开、用 git 管起来、直接 diff。它不是某个系统内部的不透明数据。

**`summary` 是检索面，文件是内容面。** `memories()` 返回的是摘要，agent 据此判断相关性；真的相关再去读文件。这是一次两阶段召回——摘要进上下文的成本很低，全文只在需要时才付。

所以 skill 文档对摘要有个不寻常的要求：

> `summary` must be English and detailed enough that `memories()` results alone can judge relevance without reading the file. Include the decision, the reasoning, and the key constraints — not just a title.

**摘要不是标题，是一段能独立判断相关性的说明。** 要包含决定、理由和关键约束。

**`message_start` / `message_end` 是回溯锚点。** 记录这个结论是在对话的哪一段得出的，将来可以顺着它回到原始证据。**结论和它的出处之间始终有一条可走的路**——这正是 `PRODUCT.md` 第一条设计原则：

> Evidence before assertion: every interpretation keeps a clear path back to the raw session record.

**`anchors` 是可选的召回面。** 一个 JSON 数组，通常是相关文件的路径。它让"我正在改这个文件"也能成为一条召回线索。

## `remember()`：四道校验

```ts
const remember = ({ path: memoryPath, session_id, message_start, message_end, summary, project, anchors }) => {
  if (!memoryPath || !summary) throw new Error('remember() requires path and summary');
  assertEnglishMemoryText(summary, 'remember() summary');
  const normalizedPath = resolveMemoryPath(memoryPath, session_id);
  const normalizedAnchors = normalizeAnchors(anchors);
  const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const proj = project || db.prepare('SELECT project FROM sessions WHERE id=?').get(session_id)?.project || null;
  const created_at = new Date().toISOString();
  db.prepare('INSERT OR REPLACE INTO memories (...) VALUES (?,?,?,?,?,?,?,?,?)').run(...);
  return { id, path: normalizedPath, project: proj, anchors: normalizedAnchors, created_at };
};
```

四道校验，每一道都在防一类具体的失败。

### 一、文件必须已经存在

```ts
const resolveMemoryPath = (memoryPath: string, sessionId?: string): string => {
  let base = null;
  if (sessionId) {
    base = db.prepare('SELECT project_path FROM sessions WHERE id=?').get(sessionId)?.project_path || null;
  }
  const resolved = path.isAbsolute(memoryPath)
    ? path.normalize(memoryPath)
    : path.resolve(base || process.cwd(), memoryPath);
  let stat;
  try { stat = fs.statSync(resolved); }
  catch { throw new Error(`remember() memory file does not exist: ${resolved}`); }
  if (!stat.isFile()) throw new Error(`remember() memory path is not a file: ${resolved}`);
  return resolved;
};
```

**注册一个不存在的文件会直接报错。** 因为 attune 沙箱**不能写文件**——第 10 章讲过，白名单里没有 `fs`。

于是流程被强制拆成两步：

```text
1. agent 用 Write 工具写 markdown 文件  ← 人在这里看到并批准了内容
2. agent 跑 --attune 脚本注册它          ← 人在这里批准了注册动作
```

**第一步是人批准的关键点。** 内容以一次普通的文件写入呈现给用户，用的是用户已经熟悉的批准界面。如果 attune 能自己写文件，记忆的正文就会藏在一段 JS 字符串里,审查体验会差很多。

这是"能力越窄，审查越容易"的一个具体应用——**沙箱不给 `fs`，不只是安全考虑，也是产品设计**。

相对路径的解析基准也有讲究：优先用 `session_id` 对应的 `project_path`（第 8、9 章讲的那个由收尾阶段统计出来的真实路径），没有才退回 `process.cwd()`。所以文档推荐的写法是 `.obelisk/memories/xxx.md` 加 `session_id`——**这样记忆文件落在它所属项目里，而不是 agent 当时碰巧所在的目录**。

最终存进库的是规范化后的绝对路径。

### 二、摘要必须是英文

```ts
assertEnglishMemoryText(summary, 'remember() summary');
```

第 10 章讲过理由：`unicode61` 分词器对 CJK 基本失效，更重要的是跨语言召回——同一个结论如果按各自语言索引，会分裂成互相召回不到的几份。

值得注意的是**报错而不是静默翻译**。静默转换会让 agent 以为写进去的是原文，将来读文件时发现对不上。

### 三、anchors 必须是对象数组

```ts
const normalizeAnchors = (anchors: unknown): string | null => {
  if (anchors == null) return null;
  let parsed = anchors;
  if (typeof anchors === 'string') {
    try { parsed = JSON.parse(anchors.trim()); }
    catch { throw new Error('remember() anchors must be a JSON array'); }
  }
  if (!Array.isArray(parsed)) throw new Error('remember() anchors must be an array');
  for (const anchor of parsed) {
    if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) {
      throw new Error('remember() anchors entries must be objects');
    }
  }
  return parsed.length ? JSON.stringify(parsed) : null;
};
```

字符串会被当成 JSON 解析——因为 agent 有时会把它序列化好再传。空数组归一成 `null`，避免库里出现 `'[]'` 和 `NULL` 两种"没有锚点"。

**校验只到"是对象数组"为止**，不检查对象里有什么字段。`anchors` 是个开放结构，现在主要用 `{ kind: 'file', path: '...' }`，将来可能有别的种类。**在结构上收紧、在内容上留白**，是个合理的分寸。

### 四、project 自动继承

```ts
const proj = project || db.prepare('SELECT project FROM sessions WHERE id=?').get(session_id)?.project || null;
```

没显式传就从 session 继承。这让 `memories({ project })` 的过滤能自动生效——大部分记忆是项目相关的，而 agent 未必每次都想着传这个字段。

## `forget()`：归档，不是删除

```ts
const forget = ({ id, reason }: ForgetInput) => {
  const deletionReason = String(reason || '').trim();
  if (!id || !deletionReason) throw new Error('forget() requires id and reason');
  const row = db.prepare('SELECT id, deleted_at, deleted_reason FROM memories WHERE id=?').get(id);
  if (!row) throw new Error(`forget() memory not found: ${id}`);
  if (row.deleted_at) {
    return { id, deleted_at: row.deleted_at, deleted_reason: row.deleted_reason, already_deleted: true };
  }
  const deleted_at = new Date().toISOString();
  db.prepare('UPDATE memories SET deleted_at=?, deleted_reason=? WHERE id=?').run(deleted_at, deletionReason, id);
  return { id, deleted_at, deleted_reason: deletionReason };
};
```

四个决定，每一个都指向同一个立场。

**一、`reason` 是必填的。** 不给理由就报错。这不是形式主义——一条记忆被归档三个月后，"当时为什么觉得它不对了"是唯一还能帮你判断要不要恢复的信息。

**二、软删除。** `deleted_at` + `deleted_reason` 两列，记录本身留着。`memories()` 的过滤是 `AND mem.deleted_at IS NULL`，所以它从召回里消失，但审计时还能查到。

第 1 章说"忘记是一次归档而非删除"，这两列就是那句话的全部实现。

**三、markdown 文件不动。** `forget()` 只改注册记录。文件还在磁盘上、还在 git 里。**撤销一次归档不需要恢复任何数据。**

**四、重复归档是幂等的。**

```ts
if (row.deleted_at) {
  return { ...row, already_deleted: true };
}
```

不报错，返回原来的时间和理由，加一个 `already_deleted: true` 标记。**因为重复调用 `forget()` 通常意味着调用方状态不同步，而不是出了错**——报错只会让 agent 去处理一个不需要处理的异常。而返回原始的 `deleted_reason`，调用方还能看到它当初是为什么被归档的。

## 更新 = 归档 + 新写

没有 `update()`。skill 文档里"更新记忆"是这样定义的：

> updating memory is one user-approved operation: archive the old memory with `forget()`, then write and register a replacement markdown memory with `remember()`.

先 `forget()` 旧的，再 `remember()` 新的。

**这不是能力缺失，是让历史留痕。** 原地更新会抹掉"曾经我们认为是 X，后来改成了 Y，理由是 Z"这条线索。而归档加新写之后：旧记录还在（带归档理由），旧文件还在,新记录指向新文件。整个认知的演变过程是可追溯的。

对一个专门做"记录结论"的系统来说，**它自己对结论变更的处理方式，应该和它推荐给用户的一样**。

## 三处批准边界

记忆层最微妙的部分不在代码里，在 skill 文档定义的批准规则里。这些规则决定了 agent 什么时候该问、什么时候不该问。

### 用不用一条记忆：不需要批准

> judging whether to use a memory in the current answer is an agent decision and does not require approval.

召回是检索的一部分。每次都问"我能用这条记忆吗"会让整个系统难以忍受。

### 改变记忆状态：需要批准

写入和归档都要人同意。**但"同意"的形式是宽松的**：

> If the user explicitly says a memory is wrong, outdated, should be forgotten, or should now say something else, that request is the approval to archive or update the exact matching memory. Do not ask for a second confirmation unless multiple memories could match.

用户说"这条记忆过时了"，这句话本身就是批准。再问一次"你确定要归档吗"是多余的。

**除非有歧义**——多条记忆都可能匹配时才该问是哪一条。

### agent 自己发现的冲突：要先问

> If you notice a possible conflict yourself, explain it briefly and ask before changing memory state.

这条和上一条的分界很清楚：**用户主动说的，执行；agent 自己判断的，先问。**

因为后者的判断依据是 agent 对当前证据的理解，而它可能理解错。一条被误判为"过时"的记忆如果被自动归档，用户可能永远不会发现。

### 什么值得记

文档给了正反两组：

```text
适合：设计决策、项目约定、放弃的备选方案、反复出现的失败原因、
      工作流范式、跨多个证据点综合出来的结论

不适合：一次性查找、不确定的发现、已有记忆已经覆盖的结论
```

判据是**未来会不会重复用到**，以及**是不是综合出来的**。一条能靠一次 `search()` 直接查到的事实，没必要记——记了反而增加了一份可能过期的副本。

## 与 build 的关系：记忆从不参与重建

这一点在前面几章反复出现，这里收拢一下：

| 场景 | 证据表 | `memories` |
|---|---|---|
| 增量索引 | 更新 | 不碰 |
| `force` 强制重建（第 9 章） | 全部清空重建 | **不清** |
| `delete-session` 级联（第 8 章） | 该 session 的行全删 | **不删** |
| 源文件被删除 | 对应的行最终消失 | **保留** |

代码里那句注释是权威表述：

> `memories` is the durable, human-approved layer and is never cleared

**证据层是源文件的投影，记忆层不是。** 前者随时可以扔掉重算，后者一旦丢失就真的没了——它是人的判断，源文件里没有。

这也解释了为什么记忆的正文是 markdown 文件而不是数据库字段:**即使整个索引损坏了，记忆的内容还在磁盘上。** 丢失的只是注册记录，那是可以重建的。

## 一条记忆的完整生命

```text
① 检索产生了一个值得留下的结论
     agent 简短地提出建议，不擅自动手

② 用户同意
     agent 用 Write 工具写 markdown        ← 人在这里看到内容并批准

③ 注册
     obelisk --attune /tmp/register.mjs    ← 人在这里批准注册动作
     remember({ path, session_id, message_start, message_end, summary, anchors })
     → 校验文件存在、摘要是英文、anchors 合法
     → 写入 memories 表，触发器同步 memories_fts

④ 召回
     memories({ project, query: 'english terms' })
     → 摘要进上下文，判断相关性
     → 真的相关才读文件全文

⑤ 过期
     用户说"这条不对了" → forget({ id, reason })
     → deleted_at / deleted_reason 落库
     → 从召回中消失，审计中仍可见，文件不动

⑥ 替换
     forget() 旧的 + remember() 新的
     → 认知的演变过程留在记录里
```

每一步的批准点都在**人已经熟悉的界面**上：写文件是文件写入批准，注册是命令执行批准。**没有为记忆层单独发明一套批准机制**——这是它能被信任的重要原因。

## 这一章你应该带走的

1. 两层记忆**同时查**：记忆是先前的笔记，不是最终权威；正确性依赖它时要拿原始证据核对。
2. 记忆 = **markdown 文件 + 注册记录**。摘要是检索面，文件是内容面，两阶段召回。
3. `remember()` 要求**文件必须已存在**——因为 attune 沙箱不能写文件，于是内容批准被强制发生在一次普通的文件写入上。
4. `forget()` 是**归档**：理由必填、软删除、文件不动、重复调用幂等。
5. **没有 update**：更新 = 归档 + 新写，让认知的演变留痕。
6. 批准边界三条：用记忆不用批准、改状态要批准、agent 自己发现的冲突要先问。
7. 记忆**从不参与任何重建**——它是这个系统里唯一算不出来的东西。

第二部分只剩最后一章：同一份 canonical record 如何走向人眼。
