# 第 2 章 · 系统由什么组成：模块地图与依赖方向

上一章讲的是外形。现在拆开外壳。

这一章要交付两样东西：**一张部件图**，和**三条不可越界的依赖规则**。规则比图重要——图会随代码变，规则不会，而且后面每一章都是在讲某个部件如何在不越界的前提下把活干完。

## 四个可以单独拿走的东西

仓库根目录下，真正独立的产物只有四个：

```text
packages/core/              @obelisk/core —— 私有 workspace，全部实现在这里
packages/cli/               @obelisk-apps/cli —— 发布到 npm 的命令行
app/                        Electron 桌面应用
skill-doc/                  纯文档的 agent skill（无可执行代码）
```

关系是一个明显的星形：

```text
              packages/cli          app/
                   │                 │
                   └────────┬────────┘
                            ↓
                     packages/core
                            ↓
                ~/.obelisk/obelisk.sqlite
```

`skill-doc/` 不在图里，因为它不连任何东西——它是纯文本，教 agent 怎么调用 CLI。

**两个消费者，一份实现。** 这句话是整个仓库最重要的结构事实。CLI 71 行、App 的主进程直接 `import` Core 的源码——没有一个消费者重新实现了检索或索引。

## Core 内部：六组模块

Core 约 4,700 行，分成六组。按它们在数据流里的位置排：

```text
① 词汇层（只有类型和 DDL，没有运行逻辑）
   providers/types.ts      canonical record 的定义 —— 全书的支点
   schema.sql              SQLite 表结构
   sqlite-types.ts         两种 binding 的公共 handle 形状

② Provider 轴（把外部格式翻译成 canonical record）
   providers/claude.ts     Claude Code 适配器
   providers/codex.ts      Codex 适配器
   providers/kimi.ts       Kimi Code 适配器
   providers/registry.ts   注册表
   providers/builtins.ts   内置三个适配器的组装（14 行）
   parsing.ts              纯解析工具（刻意不引 node:sqlite —— 见后文）

③ 写入侧
   persist.ts              唯一碰数据库的层
   db.ts                   连接生命周期与迁移
   tx.ts                   事务原语 + 连接 PRAGMA
   write-coordinator.ts    重试策略
   writer-lease.ts         跨进程单写者租约

④ 编排
   indexer.ts              一次 build 的完整流程
   provider-indexing.ts    计划的制定与执行

⑤ 读出侧
   query.ts                16 个 helper + 记忆写入 API
   core.ts                 四个动词的实现 + 沙箱

⑥ 展示侧
   session-detail.ts       canonical record → 时间线结构
```

注意 ② 到 ⑥ 之间的关系不是一条直线。②、③ 组成写入路径，⑤、⑥ 是两个**并列的出口**——一个通向 agent，一个通向人眼。它们共同依赖 ①。

这个形状下一章会走一遍，第 4 章会解释它为什么长这样。

## 三条依赖规则

### 规则一：provider 适配器从不打开数据库

`providers/types.ts` 在定义 `Provider` 接口的地方明写：

> A transcript source. Pure: it never touches the Obelisk database.

三个适配器的文件头都重复了一遍这句承诺。这不是风格洁癖，它有一个非常具体的后果：**适配器可以被 Electron 加载**。

Electron 打包的 Node 运行时里**没有 `node:sqlite`**。如果适配器里有一行 `import { DatabaseSync } from 'node:sqlite'`，App 就再也无法复用它，只能自己再写一套解析——那正是这套架构要消灭的东西。

所以 `parsing.ts` 只 import `node:fs` / `node:path` / `node:os`（外加 `node:module` 的 `createRequire`），一行 SQLite 都没有。这个约束是刻意维持的，而且很脆：任何人往 `parsing.ts` 里加一个数据库调用，App 侧会在运行时才炸。

### 规则二：persist 从不知道 provider 是谁

打开 `persist.ts`，那个 `switch` 分派的是 `record.kind`——`message`、`tool_call`、`session`……**没有一个分支是按 `source` 分的**。`source` 在整个文件里只作为一个列值出现，被原样写进表里。

```ts
const write = (r: TranscriptRecord) => {
  switch (r.kind) {
    case 'message':   st.msg.run(...); break;
    case 'tool_call': st.tc.run(...);  break;
    ...
  }
};
```

这意味着：**加一个新来源，`persist.ts` 一个字都不用改。** 第 7 章会用 Kimi 验证这句话——一个数据模型和 Claude 完全不同的来源，接进来时的硬约束就是"不改 schema、不加 record 类型"。

### 规则三：CLI 和 App 从不实现检索

CLI 那边已经看过了：71 行，全是转发。

App 那边更值得看，因为它有充分的理由自己写一套——它用的是另一个 SQLite binding。但打开 `app/src/main/indexer.ts` 的 import 段：

```ts
import Database from 'better-sqlite3';
import { createBuiltinProviderRegistry } from '../../../packages/core/src/providers/builtins.ts';
import { createProviderIndexPlan, ... } from '../../../packages/core/src/provider-indexing.ts';
import { runWriteTransaction, betterSqliteTransactionAdapter } from '../../../packages/core/src/tx.ts';
import { acquireWriterLease } from '../../../packages/core/src/writer-lease.ts';
```

它直接引用 Core 的**源码**（不是编译产物，这样 electron-vite 能把 Core 打进去）。索引计划、事务、写者租约，全是 Core 的。App 自己贡献的只有一样东西：**一个 better-sqlite3 的 handle**。

展示侧更极端。`app/src/shared/session-detail-assembly.mjs` 整个文件长这样：

```js
import { assembleSessionDetail } from '../../../packages/core/src/session-detail.ts';
export { assembleSessionDetail };
```

九行，其中三行是注释，说明"生产调用方只走 Core 这一个接缝"。

## Binding 注入：一处实现，两种 SQLite

规则三之所以能成立，靠的是一个很朴素的观察：`node:sqlite` 和 `better-sqlite3` 的 `prepare / run / get / all` 是同一套形状。

于是 Core 不选 binding，它**接收** binding：

```ts
export function persist(db: SqliteDb, unit: IndexUnit, gen: Generator<...>): Cursor
```

`SqliteDb` 就是那组公共方法的类型（`sqlite-types.ts`，21 行）。谁调用谁负责传进来：

```text
CLI  → node:sqlite 的 DatabaseSync   → persist(db, ...)
App  → better-sqlite3 的 Database    → persist(db, ...)
```

事务层同理，`tx.ts` 里两个适配器函数只是抹平一个属性名的差异（`isTransaction` vs `inTransaction`）：

```ts
export function betterSqliteTransactionAdapter(db) { ... }
export function nodeSqliteTransactionAdapter(db)   { ... }
```

**关键在于这是"一个实现 + 两个薄适配器"，不是"两个实现"。** 写语义只有一份，不可能再次分叉。

## 完整的依赖方向

把上面的规则画成一张图，所有箭头单向，没有回边：

```text
              providers/types.ts  ←── 所有人都依赖它，它不依赖任何人
                      ↑
        ┌─────────────┼─────────────┬──────────────┐
        │             │             │              │
   providers/*    persist.ts   session-detail   query.ts
   （纯，不碰DB）  （唯一碰DB）  （不碰provider）  （只读DB）
        │             │             │              │
        └──────┬──────┘             │              │
               ↓                    │              │
        provider-indexing           │              │
        indexer.ts                  │              │
               ↓                    ↓              ↓
        ┌────────────────────┬──────────────────────┐
        │        CLI         │         App          │
        └────────────────────┴──────────────────────┘
```

一个有用的检查方法：**如果你发现自己需要画一条向上的箭头，你多半正在破坏某条规则。** 比如"能不能让 session-detail 认一下 source"——那就是从展示侧向 provider 轴画了一条回边。第 4 章会讲这条回边曾经真的存在过，以及它是怎么被拆掉的。

> **当时**
>
> ADR-0001 的第一版把这套东西描述成"一个 parse core + 两个 persist layer（按 SQLite binding 分）"。修订版在文档开头直接承认：
>
> > "That was wrong on both axes and is corrected below."
>
> 两处都错了：解析层不是一个整块，而是**按来源分的适配器注册表**；持久化层不需要按 binding 分成两个，因为两种 binding 的 API 本来就几乎一样，注入一个 handle 就够了。
>
> 一次会话里的复述可以当作这次修正的落点：
>
> > "Obelisk 只有一个共享、binding-agnostic 的 Persist layer；Claude/Codex 是 Provider adapter。app 与 skill 是两种 indexing mode，不是两套 persistence。"
>
> `CONTEXT.md` 的术语表也跟着从 "Parse core" 改成了 "Provider adapter + single persist layer"。
> 出处：ADR-0001 修订说明（2026-07-08）；Codex session `019f4b11`（评估 rollback 修复），2026-07-10。

## 这一章你应该带走的

1. 两个消费者共用一份 Core 实现；skill 是纯文档，不参与运行。
2. 三条依赖规则：**适配器不碰数据库、persist 不认来源、外壳不实现检索**。
3. 两种 SQLite binding 靠注入统一，Core 只有一份写语义。
4. 所有依赖箭头单向；出现回边就是在破坏规则。

下一章让这张静态图动起来：三条真实路径穿过它。
