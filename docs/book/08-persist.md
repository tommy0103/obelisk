# 第 8 章 · persist：唯一碰数据库的层

走到轴的另一侧。上一章三个适配器产出的记录流，在这里落成表里的行。

`packages/core/src/persist.ts`，153 行。文件头的自我描述是全书引用最多的一句：

> It is the ONLY layer that touches the database and the only place that knows the schema. Adapters stay pure.

**唯一**碰数据库、**唯一**知道 schema。这一章就是看它怎么在这个位置上把活干完。

## 形状：三段

整个模块只有三段。

**第一段：预编译语句。** `statements(db)` 返回一个对象，十个 SQL 语句加一个查询：

```ts
function statements(db: SqliteDb) {
  return {
    msg: db.prepare(`INSERT INTO messages (...) VALUES (...) ON CONFLICT(uuid) DO UPDATE SET ...`),
    tc:  db.prepare('INSERT OR REPLACE INTO tool_calls (...) VALUES (...)'),
    ...
    getSession: db.prepare('SELECT * FROM sessions WHERE id=?'),
  };
}
```

**第二段：分派。** 一个 `switch`，按 `record.kind` 把记录送给对应的语句。

**第三段：消费循环。** 五行：

```ts
let step = gen.next();
while (!step.done) { write(step.value); step = gen.next(); }
const cursor = step.value;

if (cursor != null) {
  const [mtime, lines] = cursor.split(':');
  st.idx.run(unit.key, Number(mtime), Number(lines));
}
return cursor;
```

拉完生成器，拿到 return 的游标，写进 `index_state`，返回。

**注意这里没有事务。** `persist` 自己不开事务——它假设调用方已经在事务里了。这是第 6 章那个原子性的实现方式：`provider-indexing.ts` 把 `parse` + `persist` 整个包在一次 `runTransaction` 里，所以记录和游标要么一起提交，要么一起回滚。**职责分离得很干净：persist 管写什么，调用方管什么时候提交。**

## 三种写语义，各有各的理由

十个语句里用了三种不同的冲突处理。这不是随手写的，每一种对应一类不同的数据到达模式。

### 一、整行替换：`INSERT OR REPLACE`

```sql
INSERT OR REPLACE INTO tool_calls (id,message_uuid,session_id,name,presentation,input_json,file_path)
VALUES (?,?,?,?,?,?,?)
```

用在 `tool_calls`、`tool_results`、`summaries`、`workflows`、`index_state` 上。

适用条件很明确：**这一行只会由一个来源、一次性地完整产出**。工具调用的所有信息都在同一条原始记录里，重新解析一次得到的是完全相同的内容，整行盖掉没有任何损失。

### 二、列合并：`ON CONFLICT DO UPDATE SET col = COALESCE(excluded.col, col)`

```sql
INSERT INTO workflow_agents (agent_id,run_id,session_id,agent_type,description,phase,label,model,state,duration_ms,tokens,tool_calls)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(agent_id) DO UPDATE SET
  run_id=excluded.run_id, session_id=excluded.session_id,
  agent_type=COALESCE(excluded.agent_type, workflow_agents.agent_type),
  description=COALESCE(excluded.description, workflow_agents.description),
  phase=COALESCE(excluded.phase, workflow_agents.phase),
  ...
```

用在 `subagents` 和 `workflow_agents` 上——正是第 7 章讲的**由两个独立单元拼成**的那两张表。

`COALESCE(excluded.col, col)` 读作：**新值不是 null 就用新值，是 null 就保留旧值。** 于是"我不知道这个字段"永远不会覆盖掉"别人已经知道的"。

注意 key 之外的两列（`run_id`、`session_id`）没有包 `COALESCE`——它们是必填的，任何一个贡献者都知道，直接覆盖。**哪些列合并、哪些列覆盖，是按"谁一定知道它"划分的。**

这也解释了第 6 章那条禁令"不能依赖被调用的顺序"：两个单元谁先谁后都行，`COALESCE` 保证结果一样。**顺序无关性不是靠约定，是靠 SQL 语义保证的。**

### 三、整行覆盖但**故意漏掉一列**：`messages`

这是全文件最值得看的一处。

```sql
INSERT INTO messages
  (uuid,session_id,type,parent_uuid,timestamp,role,text,content_type,is_meta,
   visibility,model,is_sidechain,agent_id,input_tokens,output_tokens,cwd,skill,source)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(uuid) DO UPDATE SET
  session_id=excluded.session_id, type=excluded.type, parent_uuid=excluded.parent_uuid,
  timestamp=excluded.timestamp, role=excluded.role, text=excluded.text,
  ...
  cwd=excluded.cwd, skill=excluded.skill, source=excluded.source
```

数一下列：插入 18 列，更新 18 列。但 `messages` 表有 **19** 列。

漏掉的那一列是 `turn_duration_ms`。

**这不是遗漏，是这条语句存在的全部理由。**

回想第 4 章：`MessageTurnDurationRecord` 是一条独立的更新操作，因为一条消息的耗时**可能出现在另一行、甚至另一次运行里**。Codex 的耗时来自后续的 `task_complete` 事件，Claude 的来自另一条记录。

现在设想 `messages` 用的是 `INSERT OR REPLACE`：

```text
第一次运行：消息入库 → 后续记录带来耗时 → UPDATE 写入 turn_duration_ms  ✓
第二次运行：全量重解析，消息再次入库
          → INSERT OR REPLACE 整行替换，未指定的列归 NULL
          → turn_duration_ms 被清掉                                    ✗
```

Codex 和 Kimi 都是全量重解析，**每一次索引都会重演这个覆盖**。耗时会在写入和清除之间反复横跳。

`ON CONFLICT DO UPDATE SET` 只更新显式列出的列，所以 `turn_duration_ms` 安然无恙。

**一条 SQL 语句的列清单，编码了"这张表的某一列由另一种记录负责"这个事实。** 这种知识没有类型系统保护——往那个列表里手滑加上 `turn_duration_ms`，测试未必能抓到，但耗时数据会开始莫名其妙地丢。

## session：唯一需要先读后写的记录

`sessions` 用的是 `INSERT OR REPLACE`，但它安全，因为合并在**代码里手工做完了**：

```ts
case 'session': {
  const prev = st.getSession.get(r.id);
  const message_count = r.countMode === 'delta'
    ? (prev?.message_count || 0) + r.message_count
    : r.message_count;
  st.ses.run(
    r.id,
    r.title ?? prev?.title ?? null,
    r.project ?? prev?.project ?? null,
    prev?.project_path ?? null,
    minStr(prev?.started_at ?? null, r.started_at),
    maxStr(prev?.ended_at ?? null, r.ended_at),
    r.git_branch ?? prev?.git_branch ?? null,
    r.version ?? prev?.version ?? null,
    message_count,
    r.jsonl_path,
    r.source,
  );
  break;
}
```

先 `SELECT` 出旧行，再逐列决定新值。四种不同的合并策略挤在这十一行里：

| 列 | 策略 | 原因 |
|---|---|---|
| `started_at` | `MIN` | 一个 session 可能由多个单元贡献，取最早的 |
| `ended_at` | `MAX` | 同理，取最晚的 |
| `message_count` | 累加或替换 | 由 `countMode` 决定 |
| `title` / `project` / `git_branch` / `version` | 有新值用新值，否则保留旧值 | 旁路元数据（如 Claude 的 `history.jsonl`）可能后到，不能被 null 冲掉 |
| `project_path` | **始终写旧值** | 见下 |
| `jsonl_path` / `source` | 直接覆盖 | 单元自己一定知道 |

最值得注意的是 `project_path`，代码里带着注释：

```ts
prev?.project_path ?? null, // authoritative project_path is set by refreshSessionProjectPaths
```

它**从不由适配器决定**。权威值是在构建收尾阶段，由编排层从已入库的消息 `cwd` 反推出来的（第 9 章）。persist 在这里的动作是"原样保留，别碰"。

这是个有意思的分工：`project`（目录 slug）来自适配器，`project_path`（真实绝对路径）来自全局推断。前者是来源给的，后者是证据里算的。

`minStr` / `maxStr` 就是第 5 章说的字符串比较——ISO 8601 的字典序即时间序，不需要解析时间：

```ts
const minStr = (a, b) => (a == null ? b : b == null ? a : a < b ? a : b);
```

## 两条操作记录

前八种记录写行，剩下两种改状态。

### `message-turn-duration`：定点更新

```ts
turn: db.prepare('UPDATE messages SET turn_duration_ms=? WHERE uuid=?'),
```

一条 `UPDATE`，只碰一列。**如果目标消息还没入库，这条更新影响 0 行，静默通过。** 没有报错，也没有补偿。

这是刻意的：耗时是锦上添花的信息，缺了不影响任何东西。**为一个可选字段引入"等待目标行出现"的机制，代价远大于收益。** 下次全量重解析时它自然会对上。

### `delete-session`：手写级联

```ts
function deleteSession(db: SqliteDb, sessionId: string) {
  db.prepare('DELETE FROM tool_results WHERE session_id=? OR message_uuid IN (SELECT uuid FROM messages WHERE session_id=? OR agent_id=?)').run(sessionId, sessionId, sessionId);
  db.prepare('DELETE FROM tool_calls WHERE session_id=? OR message_uuid IN (SELECT uuid FROM messages WHERE session_id=? OR agent_id=?)').run(sessionId, sessionId, sessionId);
  db.prepare('DELETE FROM messages WHERE session_id=? OR agent_id=?').run(sessionId, sessionId);
  db.prepare('DELETE FROM subagents WHERE agent_id=? OR session_id=?').run(sessionId, sessionId);
  db.prepare('DELETE FROM workflow_agents WHERE session_id=?').run(sessionId);
  db.prepare('DELETE FROM workflows WHERE session_id=?').run(sessionId);
  db.prepare('DELETE FROM summaries WHERE session_id=?').run(sessionId);
  db.prepare('DELETE FROM sessions WHERE id=?').run(sessionId);
}
```

第 5 章说过：没有外键，级联得手写。这八条就是代价。

三处细节：

**顺序不是随意的。** 前两条要通过子查询找 `messages`，所以必须在删 `messages` 之前执行。

**`OR agent_id=?` 出现了三次。** 因为一个 session ID 也可能作为某条消息的 `agent_id` 出现——Codex 的子线程 ID 就是这样。删一个 session 得同时清掉"以它为 agent"的那些行。

**`memories` 不在列表里。** 和第 5 章的 force rebuild 一样，人批准过的东西不参与级联删除。

## 未知记录直接抛错

```ts
default:
  throw new Error(`persist: unhandled record kind ${(r as { kind: string }).kind}`);
```

不是忽略，不是警告，是抛错。

配合上层的错误处理，效果是：这个单元的事务回滚、游标不前进、记录到 `skippedFiles`、stderr 打一行警告、继续下一个单元。**一个适配器产出了共同语言里没有的东西，不会静默地丢数据。**

这是共同语言"封闭"的执行保障。TypeScript 的联合类型在编译期挡一道，这个 `default` 在运行期挡第二道——后者是必要的，因为适配器可能来自另一个编译单元。

## 它不做什么

反过来看边界，比正面列举更能说明这一层的位置：

| 不做 | 谁做 |
|---|---|
| 开事务 / 提交 / 回滚 | 调用方（`provider-indexing` + `tx.ts`） |
| 重试 | `write-coordinator.ts` |
| 决定谁有资格写 | `writer-lease.ts` + 心跳仲裁 |
| 认识 `source` | 没有人——`source` 只是一个列值 |
| 排序记录 | 没有人——顺序无关性由 `COALESCE` 保证 |
| 校验引用完整性 | 没有人——乱序到达是常态 |
| 推断 `project_path` | 编排层的收尾阶段 |
| 重建 FTS | 触发器 + 收尾阶段 |

**它只是把一种语言翻译成另一种语言。** 上一章讲的三个适配器把外部格式翻译成 canonical record，这一章讲的 persist 把 canonical record 翻译成 SQL。两者结构上是对称的，只是方向相反。

这个对称性正是第 4 章那句话的落点：**数据库是序列化适配器，不是转写语义的来源。** persist 就是那个序列化适配器本身。

## 这一章你应该带走的

1. persist **不开事务**——原子性由调用方保证，它只管写什么。
2. 三种写语义对应三类到达模式：一次性完整产出用整行替换、多单元拼成用 `COALESCE` 列合并、需要跨记录保护的用带列清单的 upsert。
3. `messages` 的 upsert **故意漏掉 `turn_duration_ms`**，否则全量重解析会反复清掉它。
4. `session` 是唯一先读后写的记录，四种合并策略并存；`project_path` 由编排层的收尾阶段负责。
5. 未知 record kind 抛错，让共同语言的封闭性有运行期保障。
6. 它不排序、不校验引用完整性、不认来源——这些"不做"共同定义了这一层的位置。

下一章往上一层，看编排层怎么把适配器和 persist 组织成一次完整的构建。
