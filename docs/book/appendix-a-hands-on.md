# 附录 A · 动手与代码导航

正文按"整体 → 局部 → 横切"讲完了。这份附录是操作手册：**怎么把它跑起来，以及带着一个具体问题时该翻哪个文件。**

它被放在附录而不是正文，因为它是查阅材料，不是论述——夹在正文里会打断推进。

---

## 一、装起来

需要 Node 22.13 或更新（Core 用了 `node:sqlite`，那是 Node 22 才内置的）。

```bash
npm install --global @obelisk-apps/cli
obelisk --version
```

然后装 agent skill：

```bash
obelisk install
```

这一步只是转包给标准的 skills 安装器（第 1 章：skill 是纯文档，不含运行时）。

首次运行会建索引，100 个 session 大约 5 秒；之后增量。

## 二、第一条查询

最短的验证路径：

```bash
obelisk --search "auth"
```

它会先建索引再检索，所以第一次会慢一点。

然后手写一条脚本，这才是 CodeAct 的真实用法：

```bash
cat > /tmp/q.mjs <<'EOF'
const map = overview({ limit: 5 });
return {
  cwd: map.current.cwd,
  project: map.current.project,          // 注意 confidence 字段
  totals: map.totals,
  recent: map.current_project?.sessions?.map(s => ({
    id: s.id, title: s.title, source: s.source, msgs: s.message_count,
  })),
};
EOF
obelisk --query /tmp/q.mjs
```

`map.current.project` 里那个 `confidence` 字段值得看一眼——第 10 章讲过，它不假装自己一定对。

### 几条自检查询

**索引里有什么：**

```js
return sql(`SELECT COALESCE(source,'claude') AS source, COUNT(*) AS sessions,
                   MAX(COALESCE(ended_at, started_at)) AS latest
            FROM sessions GROUP BY 1 ORDER BY 3 DESC`);
```

**索引新鲜度和所有权标记**（第 13、14 章那三类特殊 key）：

```js
return sql(`SELECT jsonl_path AS key,
                   datetime(mtime/1000, 'unixepoch', 'localtime') AS at
            FROM index_state WHERE substr(jsonl_path,1,2)='__' ORDER BY key`);
```

跑出来会看到 `__last_build__`、三个 `__*_canonical_transcript_v*__` 版本标记；用过 App 的话还有 `__app_heartbeat__`、`__app_last_successful_build__`、`__indexer_owner_app__`、`__fts_triggers_ready__`、`__last_source_mtime__`（后五个只由 App 写，不在 Core 里）。

**可能还会看到几个源码里已经不存在的标记**，比如 `__kimi_canonical_transcript_v3__` 和 `v4` 并存。退役的版本标记不会被清理——它们无害，但正好是一份重放历史的记录。

**验证第 5 章那个 schema 漂移：**

```js
return sql(`SELECT sql FROM sqlite_master WHERE name='messages'`);
```

对比 `packages/core/src/schema.sql` 里的定义——如果你的库不是全新建的，`visibility` 的列位置会不一样。

**验证第 8 章那个关键的列清单：**

```js
return sql(`SELECT COUNT(*) AS with_duration FROM messages WHERE turn_duration_ms IS NOT NULL`);
```

跑一次 `obelisk --search x` 触发重新索引，再跑一次这个查询。**数字不该变小**——如果变小了，说明 `messages` 的 upsert 被人加上了那一列。

## 三、隔离实验

开发时最好别碰真实索引：

```bash
# macOS / Linux
HOME=/tmp/obelisk-dev obelisk --build
```

会在 `/tmp/obelisk-dev/.obelisk/` 下建一个全新的库。数据源目录可以在 App 的设置里改，或者直接把 fixture 放到对应位置。

真实索引在 `~/.obelisk/obelisk.sqlite`，测试破坏性操作前先备份。

## 四、本地跑源码

```bash
git clone https://github.com/tommy0103/obelisk.git
cd obelisk
npm ci
```

### 测试

```bash
npm test          # 会先 build:core + build:cli
npm run typecheck # tsc --noEmit，含 app 的 tsconfig
npm run lint
```

62 个测试文件。**按文件名找对应章节的测试是读代码的一条捷径：**

| 想验证 | 测试文件 |
|---|---|
| 三个适配器的解析 | `claude-parse` / `codex-parse` / `kimi-parse` |
| 增量与游标（第 14 章） | `incremental-index` |
| 写语义漂移（第 8 章） | `indexer-upsert-drift` |
| 心跳仲裁（第 13 章） | `daemon-arbitration` |
| 回滚安全（第 13 章） | `app-rollback-guard` / `app-writer-lease` |
| helper 返回形状（第 10 章的 Tier 2 契约） | `contract-helper-shapes` |
| schema（第 5 章） | `db-schema` |

`contract-helper-shapes` 那个尤其值得一看——它就是 ADR-0002 里"契约测试断言实际返回与文档一致"的实现。

### 构建产物

```bash
npm run build:core   # → packages/core/dist/   编译的 @obelisk/core
npm run build:cli    # → packages/cli/dist/    可发布的 npm 载荷
npm run build:skill  # → dist/obelisk-skill/   纯文档的 skill artifact
```

三个 `dist/` 都是生成的，不要手改（第 2 章：ADR-0004 规定 CLI 发布的是可读、不打包、不压缩的 tsc 输出）。

### 跑 App

```bash
cd app
npm ci
npm run dev
```

`electron-vite` 起渲染进程的 dev server 并拉起 Electron。渲染层改动走 HMR；主进程和 preload 的日志在跑 `npm run dev` 的终端里。

**注意：开发中的 App 读写真实的 `~/.obelisk` 索引。** 要隔离就用上面那个 `HOME=/tmp/obelisk-dev npm run dev`。

给主进程挂调试器：

```bash
npm run dev -- --inspect=5858
```

Electron 侧还有两个专门的并发测试（用真实的 Electron-ABI better-sqlite3）：

```bash
npm run test:electron
```

## 五、代码导航：带着问题查表

### 按问题

| 我想知道… | 去读 | 正文 |
|---|---|---|
| 公共接口到底是什么 | `packages/cli/src/obelisk.ts`（71 行） | 第 1 章 |
| 四个动词怎么实现的 | `packages/core/src/core.ts` | 第 10 章 |
| **系统的共同语言** | `packages/core/src/providers/types.ts` | **第 4、6 章** |
| 表结构 | `packages/core/src/schema.sql` | 第 5 章 |
| 一次构建都做了什么 | `packages/core/src/indexer.ts` | 第 9 章 |
| 计划怎么制定 | `packages/core/src/provider-indexing.ts` | 第 9、14 章 |
| 记录怎么变成行 | `packages/core/src/persist.ts` | 第 8 章 |
| 某个来源怎么解析的 | `packages/core/src/providers/{claude,codex,kimi}.ts` | 第 7 章 |
| helper 的实现和返回形状 | `packages/core/src/query.ts` | 第 10 章 |
| 记忆怎么写入和归档 | `query.ts` 的 `createAttuneApi` | 第 11 章 |
| 时间线怎么组装 | `packages/core/src/session-detail.ts` | 第 12 章 |
| 事务与回滚 | `packages/core/src/tx.ts` | 第 13 章 |
| 重试策略 | `packages/core/src/write-coordinator.ts` | 第 13 章 |
| 跨进程互斥 | `packages/core/src/writer-lease.ts` | 第 13 章 |
| App 怎么监听和索引 | `app/src/main/indexer-service.ts` | 第 12 章 |
| 实时补丁 | `app/src/shared/session-patch.mjs` | 第 12 章 |
| agent 被教了什么 | `skill-doc/SKILL.md` + `references/` | 第 10、11 章 |

### 按"我要改什么"

| 任务 | 必须动 | 顺带检查 |
|---|---|---|
| 加一个数据源 | 新建 `providers/<name>.ts` + `builtins.ts` 加一行 | 第 15 章那六个坑 |
| 改某个来源的解析语义 | 那个适配器 + **升 `indexVersionMarker`** | 第 14 章 |
| 加一个检索 helper | `query.ts` + `skill-doc/references/api-reference.md` | Tier 2 契约，两边必须同改 |
| 改表结构 | `schema.sql` + `schema-migrations.ts` 加一条 ADD COLUMN | 只加列，不改不删 |
| 改展示的组装 | `session-detail.ts` | 别引入 `source` 分支 |

### 读代码的建议顺序

如果要通读，这个顺序的认知负担最小：

```text
1. packages/cli/src/obelisk.ts        71 行，看清公共面
2. packages/core/src/core.ts          90 行，四个动词
3. packages/core/src/providers/types.ts   共同语言（读注释，不读类型）
4. packages/core/src/schema.sql       93 行，序列化的结果
5. packages/core/src/persist.ts       153 行，语言 → 表
6. packages/core/src/providers/claude.ts  最直观的一个适配器
7. packages/core/src/indexer.ts       把前面几个串起来
8. 其余按需
```

**第 3 步是关键。** `types.ts` 没有一行运行代码，但整个系统的形状由它决定——它的注释比类型本身信息量大。

## 六、三条不会被编译器拦住的规矩

第 15 章列过，这里再放一遍，因为它们是提交前该自查的：

```text
① 适配器和 parsing.ts 不许 import node:sqlite
     违反后果：CLI 正常，App 运行时崩

② messages 的 upsert 列清单不许包含 turn_duration_ms
     违反后果：全量重解析的来源每次都清掉耗时数据，静默

③ fullReindex 时必须把 changedPaths 设为 undefined
     违反后果：完整重放静默退化成增量更新
```

三条都没有类型保护。改到相关代码时，手动过一遍。

## 七、常见状况

**`--query` 返回 `{error: "..."}`，退出码 1。** 这是正常的错误信封（第 1 章 Tier 1 契约的一部分）。`stack` 字段里有堆栈。

**脚本报 "sql() only supports read-only..."。** 第 10 章那三层保障的第二、三层。检查语句是不是以 `SELECT`/`WITH` 开头，以及有没有在字符串字面量里撞上黑名单关键字。

**记忆相关的调用报 "must be written in English"。** 第 11 章那道语言闸，`memories({query})` 和 `remember({summary})` 都要英文。

**索引没更新。** 按第 9 章那四种 `reason` 排查：App 开着的话它拥有写权（`daemon_active`）；30 秒内刚构建过会跳过（`recent_build`）；拿不到租约是 `writer_busy`。跑一次 `obelisk --build` 会强制重建并绕过防抖。

**删了一些 session，但它们还在索引里。** 第 14 章那个幽灵行——增量索引表达不了"这个东西不在了"，需要 `obelisk --build`。

**FTS 查询报语法错误。** 一般不会——`search()` 有兜底（第 10 章）。但 `sql()` 里直接写 `MATCH` 没有这层保护。
