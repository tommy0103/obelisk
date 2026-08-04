# 第 5 章 · 数据层：schema 与三类表

第二部分从这里开始，顺序是依赖顺序。数据层排第一，因为它是所有部件共用的词汇——讲谁在读写之前，得先知道读写的是什么。

一句提醒接着上一章：**`schema.sql` 不是转写语义的来源，`types.ts` 才是。** 这一章讲的是序列化的结果，不是模型本身。

整个文件 93 行（`packages/core/src/schema.sql`），是唯一的建库真相。

## 三类表，性质完全不同

十张表，按"能不能重建"分成三类。这个分法比按业务分更有用，因为它直接决定了每张表在故障和重建时的命运。

```text
① 证据表（8 张）—— 源文件的投影，可以完全重建
   sessions  messages  tool_calls  tool_results
   subagents  workflows  workflow_agents  summaries

② 记忆表（1 张）—— 人批准的产物，无法重建
   memories

③ 簿记表（1 张）—— 索引器自己的状态
   index_state
```

外加两张 FTS5 虚拟表（`messages_fts`、`memories_fts`）、六个触发器、十四个索引。

**这个分类是有执行后果的。** 看 `indexer.ts` 里 force rebuild 的清表列表：

```ts
for (const table of ['messages', 'tool_calls', 'tool_results', 'sessions',
                     'summaries', 'subagents', 'workflows', 'workflow_agents']) {
  db.prepare(`DELETE FROM ${table}`).run();
}
```

八张，正好是第一类。`memories` 不在里面，代码注释写明了原因：

> `memories` is the durable, human-approved layer and is never cleared

强制重建的语义因此是精确的：**把所有能从源文件重新算出来的东西扔掉重算，绝不碰那些算不出来的东西。** 第一章说 Obelisk 是显式记忆，这行清表列表是那个立场在代码里最硬的一处体现——人批准过的东西，连"重建索引"这种粗暴操作都不许动它。

## 证据表：一张主表，七张卫星表

八张证据表的关系很简单：

```text
                    sessions
                       │ session_id
        ┌──────────────┼──────────────┬──────────┐
        ↓              ↓              ↓          ↓
    messages       subagents      workflows   summaries
        │ message_uuid                │ run_id
   ┌────┴─────┐                       ↓
   ↓          ↓                  workflow_agents
tool_calls  tool_results
   └── tool_use_id ──┘
```

`messages` 是主表，其余都挂在它或 `sessions` 上。三条连接值得记住，因为写 SQL 时几乎每次都要用到：

- `tool_calls.id` = `tool_results.tool_use_id` —— 调用和它的结果
- `tool_calls.message_uuid` = `messages.uuid` —— **工具调用表本身没有时间戳**，要排序必须 JOIN 回消息
- `messages.agent_id` —— 属于某个 subagent 的消息，通过这一列归属

第三条解释了一个初看奇怪的设计：subagent 的对话内容**不在** `subagents` 表里。那张表只有元数据（类型、描述、耗时、token），实际消息躺在 `messages` 里，靠 `agent_id` 标记。所以"这个 subagent 说了什么"是一次普通的 `messages` 查询，不需要特殊路径。

## 六个能从 DDL 直接读出来的决定

### 一、一个外键都没有

93 行里没有一处 `FOREIGN KEY`。

这不是疏忽，是必需的。上一章讲过，一行可能由**两个独立的工作单元**在**任意顺序**下拼成——workflow agent 的记录可能先于它所属的 workflow 到达，工具结果可能先于承载它的消息到达。

有外键的话，"部分到达"就是一个错误。但在这里，部分到达是**常态**。

代价是删除得手写。`persist.ts` 里那个 `deleteSession()` 用八条 `DELETE` 手动级联，包括通过子查询处理 `agent_id` 关联的消息：

```ts
db.prepare('DELETE FROM messages WHERE session_id=? OR agent_id=?').run(sessionId, sessionId);
```

**这是一个明确的取舍：放弃数据库层的完整性保证，换取乱序写入的能力。**

### 二、主键全是 TEXT，带来源前缀

`sessions.id`、`messages.uuid`、`tool_calls.id` 全是 TEXT。非 Claude 的来源加前缀：

```text
claude:  5c396090-fbcc-417a-808e-92da269a2ef5
codex:   codex:019fc6ea-2bee-7ee1-9a9f-fe013f23124b
kimi:    kimi:<sessionId>
```

三个来源共用一个主键空间而不会撞。这就是为什么第 1 章说的"一套表而不是三个数据库"能成立——代价只是 ID 里多一个前缀。

Codex 的消息 ID 还带一个序号后缀（`...:000322`），因为 Codex 的原始记录本身没有稳定的逐条 ID，序号由适配器合成。**ID 的生成规则是适配器的私事**，schema 只要求它是个唯一字符串。

### 三、时间戳是 TEXT，因为 ISO 8601 的字典序就是时间序

`started_at`、`timestamp` 这些全是 TEXT，存 ISO 8601 字符串。

于是排序、比较、取最值全都可以用普通的字符串操作。`persist.ts` 里合并 session 时间范围的两个函数，本体就是字符串比较：

```ts
const minStr = (a, b) => (a == null ? b : b == null ? a : a < b ? a : b);
const maxStr = (a, b) => (a == null ? b : b == null ? a : a > b ? a : b);
```

不需要解析成时间对象，不需要考虑时区。查询里的 `ORDER BY timestamp` 也是直接可用的。

唯一需要真正时间运算的地方，是 `search()` 里找时间邻居——那里用了 `JULIANDAY()` 求距离。

### 四、`source` 的默认值是 `'claude'`，这是一层可读的地层

```sql
source TEXT DEFAULT 'claude'
```

这个默认值暴露了历史：这套库最早只索引 Claude Code，`source` 是后来加的列。老库里在此之前写入的行，这一列是 `NULL`。

所以查询代码里到处是这样的写法：

```sql
COALESCE(m.source, s.source, 'claude')
```

**这不是防御性编程，是在处理一个真实存在的历史地层。** 读到 `COALESCE(..., 'claude')` 就该想到：这行可能来自 `source` 列存在之前。

### 五、FTS5 用 external content，索引不存正文副本

```sql
CREATE VIRTUAL TABLE messages_fts USING fts5(
  uuid UNINDEXED, session_id UNINDEXED, text,
  content=messages, content_rowid=rowid);
```

`content=messages` 让 FTS 表变成**外部内容表**：它只存倒排索引，正文仍然只在 `messages` 里存一份。查询时 FTS 通过 `content_rowid` 回表取原文。

代价是同步得自己维护，所以有三个触发器（insert / delete / update）。删除和更新时要先往 FTS 里写一条特殊的 `'delete'` 命令，把旧词条撤掉，再插新的：

```sql
CREATE TRIGGER messages_fts_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, uuid, session_id, text)
  VALUES ('delete', old.rowid, old.uuid, old.session_id, old.text);
  INSERT INTO messages_fts(rowid, uuid, session_id, text)
  VALUES (new.rowid, new.uuid, new.session_id, new.text);
END;
```

触发器负责增量，但每次构建收尾时还会整体重建一次：

```sql
INSERT INTO messages_fts(messages_fts) VALUES('rebuild')
```

**两条路都留着**：触发器保证过程中的一致性，收尾重建保证最终的一致性。

### 六、两张 FTS 表的分词器不一样

```sql
-- messages_fts: 默认分词器
-- memories_fts: tokenize='unicode61 remove_diacritics 1'
```

`memories_fts` 显式指定了分词，并且去掉变音符号。配合运行时那道"记忆摘要必须是英文、CJK 直接报错"的检查，记忆层是一个**刻意保持单语言的检索面**。

理由是记忆是跨语言复用的：你用中文提问，但记忆索引统一用英文，才能被稳定命中。证据层（`messages_fts`）不做这个限制，因为它索引的是原始对话，本来就是什么语言都有。

## 簿记表：一张被当信令板用的表

```sql
CREATE TABLE index_state (
  jsonl_path TEXT PRIMARY KEY, mtime REAL, lines_processed INTEGER);
```

字面意思是"每个文件处理到哪儿了"。但它实际承担了三种职责：

```text
① 真正的游标
   key = 工作单元的 key（通常是文件路径）
   存的是适配器返回的游标，拆成 mtime / lines_processed 两个数字

② 进程间信令
   '__app_heartbeat__'   桌面 App 还活着（mtime 存时间戳）
   '__last_build__'      上次构建完成的时间

③ 版本标记
   '__claude_canonical_transcript_v2__'  等
   标记"这个适配器的解析语义版本已经应用过"
```

后两类是**把一张表当键值存储用**：列名叫 `jsonl_path`，存的却是 `__app_heartbeat__`；列名叫 `mtime`，存的却是心跳时间戳。

上面列的是 Core 会写的 key。**桌面 App 还会往同一张表里写它自己的几个**（`__app_last_successful_build__`、`__indexer_owner_app__`、`__fts_triggers_ready__`、`__last_source_mtime__`），它们定义在 `app/src/main/indexer.ts` 里，不在 Core 中。所以只读 Core 会以为这张表的 key 空间比实际小——**一张被当信令板用的表，天然会吸引更多写入者**，这也是这个设计的代价之一。

这个设计务实但不干净。好处是不用新增表、不用额外的锁文件，而且所有索引状态天然在同一个事务里。代价是读代码时那些 `__` 包围的字符串得靠约定认出来，而且没有任何地方能一眼看全它们。

这三类 key 分别是第 14 章（游标与版本标记）和第 13 章（心跳）的主题。

## 迁移：只加列，不改列

`schema-migrations.ts` 全文 34 行，做的事只有一件：

```ts
db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
```

十条迁移，全是加列，没有一条改类型、删列或改名。加上 `schema.sql` 里每张表都是 `CREATE TABLE IF NOT EXISTS`，整个演进策略是：

```text
新库  →  schema.sql 一次建好
老库  →  CREATE ... IF NOT EXISTS 全部跳过，migrations 补上缺的列
```

只加列的好处是**新旧代码可以读同一个库**：老代码看不见新列，但也不会崩。这在一个用户可能同时装着 CLI 和 App、版本还不一定同步的场景里，是必要的。

`openDb()` 里有个细节，迁移被调了两次——`schema.exec()` 前后各一次：

```ts
migrateCoreSchemaColumns(db);
db.exec(SCHEMA);
migrateCoreSchemaColumns(db);
```

前一次处理"表已存在但缺列"（老库），后一次处理"这次刚建的表还需要补迁移列"的边界情况。

## 一个必然的漂移：schema.sql 与 sqlite_master

最后讲一件读代码时一定会撞上、但很少被写下来的事。

SQLite 没有独立的元数据服务，一个 `.db` 文件就是全部。所以它必须自描述：**你执行过的 `CREATE` 语句被原样存成文本**，放在 `sqlite_master` 里。每次打开数据库，SQLite 重新解析这段文本，才知道表长什么样。

这意味着：

| | `schema.sql` | `sqlite_master` |
|---|---|---|
| 是什么 | 仓库里的建库脚本 | 每个 .db 内置的系统表 |
| 角色 | **意图**（我们想要的结构） | **状态**（这个库实际的结构） |
| 何时生效 | 建库时执行一次 | 每次打开都被解析 |
| 会不会漂 | 会——脚本更新了，老库不会自动跟着变 | 不会，它就是事实 |

而且**老库一定是漂的**。把仓库里的脚本和一个真实使用中的库对比：

```text
schema.sql  ... is_meta INTEGER DEFAULT 0, visibility TEXT DEFAULT 'visible', model TEXT, ...
                                           ^^^^^^^^^^ 第 9 列

真实的库    ... is_meta INTEGER DEFAULT 0, model TEXT, ...
            ... source TEXT DEFAULT 'claude', visibility TEXT DEFAULT 'visible')
                                              ^^^^^^^^^^ 最后一列
```

原因就是上面那条迁移策略：`visibility` 是通过 `ALTER TABLE ADD COLUMN` 加进老库的，SQLite 只能把新列**追加到末尾**；而 `schema.sql` 是给新库用的，作者按逻辑分组把它写在了中间。

**这个漂移是无害的**——列的顺序不影响任何按列名访问的代码。但两条实践值得记住：

1. **不要写 `SELECT *` 然后按位置取值。** 全书所有查询都按列名取，原因在此。
2. **判断"我的库到底有没有这一列"时，看 `sqlite_master` 或 `PRAGMA table_info`，不要看 `schema.sql`。** 后者是意图，不是事实。这也正是 `schema-migrations.ts` 的做法——它先 `PRAGMA table_info` 查实际列，再决定要不要加。

## 这一章你应该带走的

1. 三类表：**证据表可重建、记忆表不可重建、簿记表是索引器自己的状态**；force rebuild 只清第一类。
2. 没有外键，因为乱序到达是常态；级联删除靠手写。
3. TEXT 主键带来源前缀、TEXT 时间戳靠字典序、`source` 的默认值是一层历史地层。
4. FTS5 是外部内容表，触发器保过程一致、收尾重建保最终一致。
5. `index_state` 兼作进程间信令板。
6. 迁移只加列；`schema.sql` 是意图，`sqlite_master` 是事实，老库必然漂移且无害。

下一章开始沿 provider 轴往上走：适配器凭什么能做到"纯"。
