# 第 13 章 · 并发与所有权：心跳、租约、事务

第三部分开始。这一章处理的问题不属于任何单一部件——它的三个组成部分分散在三个文件里，谁也不"拥有"它。

## 问题：五种写者，一个数据库文件

```text
桌面 App 的 daemon 构建      持续跑，文件一变就索引
桌面 App 的手动重建          用户点"重建索引"
CLI 的被动拉取构建           每次 --search / --query / --attune 都会触发
心跳写入                     App 每 30 秒一次
attune 的记忆写入            用户批准后
```

外加任意多个读连接。全部指向同一个 `~/.obelisk/obelisk.sqlite`。

这不是设计失误——它是"一个本地索引，两个使用面"（第 1 章）的必然结果。你在用 Claude Code 问 `/obelisk 上次那个 bug`，同时 App 开着，同时 Claude Code 本身正在往 `~/.claude/projects` 写新的转写。**三件事在同一秒发生是常态。**

## 那个报错

修复的起点是一条错误信息：

```text
Obelisk index build failed: cannot rollback - no transaction is active
```

这条消息本身是无害的——它是**二级清理失败**。真正的问题是它做了什么：

```text
① 某次写入抛出了一个异常          ← 真正的错误，可能是 SQLITE_BUSY
② SQLite 已经自动结束了事务
③ catch 块无条件执行 ROLLBACK
④ ROLLBACK 因为"没有活跃事务"而抛错
⑤ 这个新异常盖掉了 ①
⑥ 一个本该被跳过的单文件失败，变成了整次构建失败
```

**主异常丢了。** 所以 ADR 里写得很克制：

> The masked exception was not preserved, so contention (`SQLITE_BUSY` / `SQLITE_BUSY_SNAPSHOT`) is the leading explanation rather than a proven historical fact.

**"最可能的解释，而不是已证实的事实"**——因为证据在第 ⑤ 步被销毁了。这个措辞值得学：报告里承认自己不知道的部分，比编一个确定的因果链有用。

而且这条错误暴露了一个更深的问题：**清理代码可以掩盖真实错误**，这类 bug 会让所有后续的诊断都建立在错误的信息上。

## 为什么不能靠 `busy_timeout` 解决

最容易想到的修复是"等久一点"。ADR 直接否掉了：

> `busy_timeout` alone is not a correctness fix. In particular, `SQLITE_BUSY_SNAPSHOT` is not made safe by waiting longer, and retrying only the failed statement can replay part of a transaction.

两个理由：

**一、`SQLITE_BUSY_SNAPSHOT` 不是"忙"，是"过期"。** 在 WAL 模式下，一个事务开始读之后，如果别人提交了新数据，这个事务的快照就落后了。它要写就必须重来——**等再久，快照也不会自己更新**。

**二、只重试失败的那条语句会重放事务的一部分。** 一个事务里有五条语句，第三条失败了，重试第三条——前两条已经执行过，第三条可能部分生效。得到的是一个谁也没设想过的中间状态。

所以 `configureConnection` 里那行注释写得很明确：

```ts
// busy_timeout is a real behavior change for node:sqlite (no default); it is set
// explicitly for better-sqlite3 too, whose own default already happens to be
// 5000ms. It is NOT the concurrency fix — see docs/adr/0006.
```

**"它不是并发修复"**——这句注释是写给未来那个想通过调大超时来解决问题的人看的。

## 修复的形状：一个原语 + 两层协调

```text
                  谁应该写？          心跳仲裁（政策）
                       ↓
                  谁不能重叠？        写者租约（互斥）
                       ↓
                  怎么安全地写？      事务原语 + 重试策略
```

三层各管一件事，下面逐层看。

---

## 第一层：事务原语

`tx.ts` 里的 `runWriteTransaction` 是**唯一**的写事务入口：

```ts
export function runWriteTransaction<T>(db: WriteTxDb, work: () => T, options = {}): T {
  const { label } = options;
  let phase: Phase = 'begin';
  try {
    db.exec('BEGIN IMMEDIATE');
    phase = 'work';
    const value = work();
    phase = 'commit';
    db.exec('COMMIT');
    return value;
  } catch (error) {
    // …见下…
  }
}
```

### `BEGIN IMMEDIATE`

不是普通的 `BEGIN`。区别在于**什么时候取写锁**：

```text
BEGIN            延迟取锁 —— 直到第一条写语句才尝试
BEGIN IMMEDIATE  立刻取锁 —— BEGIN 这一步就成功或失败
```

延迟取锁的问题是：事务已经跑了一半，读了一些数据，这时候才发现拿不到写锁。而且在 WAL 下这正是 `SQLITE_BUSY_SNAPSHOT` 的温床——你基于一个已经过期的快照做了决策。

**立刻取锁把失败提前到了一个干净的位置**：`BEGIN` 失败时什么都还没做，直接放弃是安全的。

`phase` 变量记录的就是"失败在哪一步"，它后面会成为重试决策的关键依据。

### 清理绝不掩盖主异常

```ts
} catch (error) {
  let rollbackSucceeded: boolean | null = null;
  let rollbackError: string | null = null;
  const activeBeforeRollback = transactionState(db);
  if (activeBeforeRollback !== false) {          // ← 只在"活跃"或"未知"时回滚
    try {
      db.exec('ROLLBACK');
      rollbackSucceeded = true;
    } catch (rollbackFailure) {
      rollbackSucceeded = false;
      rollbackError = rollbackFailure instanceof Error ? rollbackFailure.message : String(rollbackFailure);
    }
  }
  ...
  throw error;      // ← 抛的永远是原始异常
}
```

三处修复，对应事故的三个环节：

**一、先问事务还在不在。**

```ts
function transactionState(db: WriteTxDb): boolean | null {
  try { return db.inTransaction(); } catch { return null; }
}
```

`true` 活跃、`false` 已结束、`null` 问不出来。条件是 `!== false`——**活跃就回滚，未知也回滚，只有确定已结束才跳过。** 未知时选择多做一次可能失败的清理，而不是留下一个可能还开着的事务。这是第 9 章那条"未知时保守"原则的又一次出现。

**二、回滚失败被捕获成数据，不再抛出。** 它变成 `rollbackSucceeded` 和 `rollbackError` 两个诊断字段。

**三、最后 `throw error`。** 抛的永远是原始异常。事故里那个"清理错误盖掉主错误"的路径被彻底堵死。

这两个方法名的差异也顺手抹平了：

```ts
export function betterSqliteTransactionAdapter(db) {
  return { exec: sql => db.exec(sql), inTransaction: () => db.inTransaction };
}
export function nodeSqliteTransactionAdapter(db) {
  return { exec: sql => db.exec(sql), inTransaction: () => db.isTransaction };
}
```

`inTransaction` vs `isTransaction`——两个 binding 的属性名不同。第 2 章讲的"薄适配器"在这里具体到了一个单词。

### 诊断信息挂在异常上

```ts
const diagnostics: WriteTxDiagnostics = {
  phase,                  // begin / work / commit / rollback
  code: busy ?? errorCode(error),
  label,                  // 'finalize' / 'force-cleanup' / 'provider:claude:/path/...'
  rollbackSucceeded,
  rollbackError,
  transactionActive: transactionState(db),
  attempts: 1,
};
attachDiagnostics(error, diagnostics);
```

挂载本身也要防御：

```ts
function attachDiagnostics(error: unknown, diagnostics: WriteTxDiagnostics): void {
  if (!error || typeof error !== 'object') return;
  try {
    (error as { obelisk?: WriteTxDiagnostics }).obelisk = diagnostics;
  } catch {
    // Frozen/native errors must still be rethrown unchanged.
  }
}
```

**如果异常对象是冻结的（原生错误可能是），挂载会失败——但那绝不能变成一个新异常。** 这是同一个教训的第二次应用：辅助动作永远不许影响主流程。

`busyCode` 的识别兼顾了两种表达方式：

```ts
const code = (raw?.code ?? raw?.errcode);
if (typeof code === 'string' && code.startsWith('SQLITE_BUSY')) return code;
if (typeof raw?.message === 'string' && BUSY_MESSAGE.test(raw.message)) return 'SQLITE_BUSY';
```

结构化的 `code` / `errcode` 优先，退回到正则匹配消息文本。两个 binding 报错的方式不完全一致。

---

## 第二层：重试是上层策略

`write-coordinator.ts` 的文件头说清了立场：

> Core's bounded retry policy above the transaction primitive. Callers opt in only for idempotent work; BEGIN contention and an uncertain/live transaction are never retried here.

**重试不在事务原语内部。** 因为原语不知道这个 `work` 是不是幂等的，也不知道调用方的时间预算。

三个判定函数把诊断信息翻译成决策：

```ts
export function isBeginBusyFailure(error: unknown): boolean {
  const info = diagnostics(error);
  return info?.phase === 'begin' && isBusyCode(info.code) && info.transactionActive === false;
}

export function hasUnusableTransaction(error: unknown): boolean {
  const info = diagnostics(error);
  return Boolean(info && info.transactionActive !== false);
}

export function isRetryableWriteFailure(error: unknown): boolean {
  const info = diagnostics(error);
  return (info?.phase === 'work' || info?.phase === 'commit')
      && isBusyCode(info.code)
      && info.transactionActive === false;
}
```

**可重试的条件有三个，缺一不可**：

1. 失败在 `work` 或 `commit` 阶段（不是 `begin`——那是调度问题，该由上层退避，不是原地重试）
2. 错误码是 `SQLITE_BUSY*`（其他错误重试也没用）
3. **事务确认已经不活跃**（`=== false`，不是 `!== true`——未知一律不重试）

第三条是最严格的。第 9 章那个 `hasUnusableTransaction(error) → throw` 的分支用的就是它：事务状态不明时，整个构建放弃，因为任何后续操作都可能建立在一个悬空的事务上。

重试循环本身很朴素：

```ts
export function runWithWriteRetry<T>(operation: () => T, {
  maxAttempts = 3, budgetMs = 1000, retryDelayMs = 25, ...
}): T {
  const startedAt = now();
  for (let attempt = 1; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      const info = diagnostics(error);
      if (info) info.attempts = attempt;
      if (!isRetryableWriteFailure(error) || attempt >= maxAttempts) throw error;
      const remaining = budgetMs - (now() - startedAt);
      if (remaining <= 0) throw error;
      sleep(Math.min(retryDelayMs * attempt, remaining));
    }
  }
}
```

**三次尝试，一秒总预算，递增退避。** 两个上限同时生效——次数用完或时间用完，都立刻放弃。

关键在于 `operation` 是**整个事务**，不是单条语句：

```ts
export function runRetryableWriteTransaction<T>(db, work, transactionOptions, retryOptions): T {
  return runWithWriteRetry(() => runWriteTransaction(db, work, transactionOptions), retryOptions);
}
```

重试意味着**重新 `BEGIN IMMEDIATE`、重新跑完整个 `work`、重新 `COMMIT`**。这就是前面说的"只重试失败语句会重放事务的一部分"的正确解法：要么整个重来，要么不重来。

`info.attempts = attempt` 那行是把尝试次数写回诊断，所以最终抛出的异常带着"我试了几次"。

---

## 第三层：谁有资格写

前两层保证"写的时候是安全的"，这一层决定"谁该写"。

它由**两个独立的机制**组成，而理解它们的区别是这一章的重点：

```text
心跳    表达政策 —— "现在应该由谁写"
租约    保证互斥 —— "无论政策怎么说，写者不能重叠"
```

ADR 的表述：

> Heartbeat and lease have deliberately different jobs: the heartbeat decides who should write, while the lease guarantees writers cannot overlap when policy information races or is stale.

**为什么需要两个？** 因为心跳是有延迟的信息。App 刚启动还没写第一次心跳、App 崩溃了心跳还没过期、两个不同版本的进程对心跳的解释不一样——这些情况下政策会失灵。租约是那个兜底。

### 心跳：一个时间戳

```ts
function writeHeartbeat({ dbPath, ... }) {
  if (!fs.existsSync(dbPath)) return;
  const lease = acquireWriterLease({ lockPath: writerLeasePath, openDb: ... });
  if (!lease) return false;
  try {
    const db = new DatabaseImpl(dbPath);
    configureConnection(db, { busyTimeoutMs: 0 });     // ← 绝不阻塞
    runWriteTransaction(txDb, () => writeIndexMarker(db, '__app_heartbeat__'), { label: 'heartbeat' });
    return true;
  } finally { lease.release(); }
}
```

App 每 30 秒往 `index_state` 写一行 `__app_heartbeat__`，值是当前时间戳（第 5 章讲的"把表当信令板用"）。

CLI 那边的判断：

```ts
const APP_HEARTBEAT_FRESH_MS = 60000;

function shouldSkipBuild(db, { now = Date.now(), ignoreRecentBuild = false } = {}) {
  const appHeartbeat = db.prepare("SELECT mtime FROM index_state WHERE jsonl_path='__app_heartbeat__'").get();
  if (appHeartbeat && now - appHeartbeat.mtime < APP_HEARTBEAT_FRESH_MS) {
    return { skip: true, reason: 'daemon_active' };
  }
  ...
}
```

**60 秒的新鲜窗口，30 秒的写入间隔——两倍余量。** App 偶尔卡一下不会被误判成已死。

心跳写入用 `busyTimeoutMs: 0`，是**非阻塞**的：它跑在 Electron 主线程上，宁可这次心跳写失败（下次 30 秒后再来），也不能让界面卡住哪怕 250 毫秒。

而 `__app_last_successful_build__` 是另一回事：

> `__app_last_successful_build__` remains an observability/freshness marker and is not required for ownership.

**它记录覆盖度，不表达所有权。** 两个标记长得像，但只有心跳决定谁能写。

### 心跳新鲜时，CLI 做什么都不做

政策的执行范围被定义得非常宽：

```text
不索引
不建表 / 不迁移 schema
不改 PRAGMA
不做 checkpoint
不执行 attune
```

**只读查询照常。** 这就是第 3 章说的"只读连接不建表、不迁移"的由来——如果 CLI 的读路径顺手做了 schema 迁移，它就在 daemon 拥有写权的时候写了库。

`executeAttune` 里那两条错误消息（第 9 章）就是这个政策的用户可见部分：

```ts
if (build?.reason === 'daemon_active') {
  throw new Error('Obelisk daemon owns index writes; attune is read-only until the daemon stops');
}
```

### 租约：一个独立的 SQLite 文件

```ts
export function writerLockPathFor(dbPath: string): string {
  return join(dirname(dbPath), 'writer.lock.sqlite');
}
```

**锁不在主库里，在一个专门的小数据库里。** 文件头解释了为什么：

> The lock lives in a dedicated SQLite database so node:sqlite and better-sqlite3 share identical locking semantics on every supported platform.

这个选择值得展开。可选方案有 `flock`、锁文件、命名互斥量，但它们各有问题：`flock` 在 Windows 上语义不同、NFS 上不可靠；锁文件要自己处理陈旧锁和原子创建；命名互斥量得按平台分别实现。

而 SQLite 的锁：**两个 binding 用的是同一个 C 库，在所有平台上行为完全一致，而且进程崩溃时操作系统自动释放。** 用一个空数据库当互斥量，是拿一个已经在依赖里的、久经考验的实现，换掉三套平台特定的代码。

获取就是持有一个写事务：

```ts
for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
  const db = openDb(lockPath);
  try {
    db.exec('PRAGMA busy_timeout=0');
    db.exec('BEGIN IMMEDIATE');
    let released = false;
    return {
      release() {
        if (released) return;              // ← 幂等
        released = true;
        try { db.exec('ROLLBACK'); }
        catch { /* 关连接也会释放锁 */ }
        finally { db.close(); }
      },
    };
  } catch (error) {
    db.close();
    if (!isBusy(error)) throw error;       // ← 非 BUSY 错误直接上抛
    const remaining = waitMs - (now() - startedAt);
    if (remaining <= 0 || attempt + 1 >= maxAttempts) return null;
    sleep(Math.min(retryDelayMs, remaining));
  }
}
```

几处细节：

**`busy_timeout=0` 加自己的有界重试。** 不用 SQLite 内建的等待，因为那样无法在等待过程中做别的判断，也无法精确控制总预算。

**`release()` 幂等。** 第二次调用直接返回。而且 `ROLLBACK` 失败也无所谓——`finally` 里的 `close()` 一定会释放锁。

**拿不到返回 `null`，不抛错。** "现在有别人在写"不是错误，是一个需要处理的状态。而**非 BUSY 的错误直接上抛**——那才是真的出问题了。

**同步睡眠：**

```ts
function syncSleep(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // 同步睡眠不可用时，有界的尝试次数仍能防止无限循环
  }
}
```

`Atomics.wait` 是**同步阻塞**的。用它是因为 `buildIndex` 整条路径都是同步的（第 12 章讲过 App 为此把索引放进了 worker 线程）。

`catch` 分支处理的是 `Atomics.wait` 在主线程上被禁止的环境——那时候退化成忙循环，但尝试次数的上限保证它不会转太久。

### 六步流程

把心跳和租约合起来，完整的判断顺序是：

```text
1. 用只读连接检查心跳
2. 心跳新鲜 → 直接查询现有 DB，不碰租约
3. 心跳过期 → 尝试获取写者租约
4. 拿到租约后再次检查心跳     ← 关键
5. 仍无活跃 daemon → 才打开写连接、迁移、索引
6. 租约获取失败 → 放弃索引，退回只读查询
```

**第 4 步是这套流程的核心。** 第 1 步和第 3 步之间有一个时间窗口——就在你决定"没有 daemon"到你真的拿到锁之间，App 可能刚好启动了。

`core.ts` 的 `executeAttune` 里这个窗口被显式关闭，注释直接点名：

```ts
const lease = acquireWriterLease({ ..., waitMs: 1000 });
if (!lease) throw new Error('Obelisk index writer is busy; attune was not applied');
try {
  // Close the heartbeat TOCTOU window after acquiring the hard lease.
  const ownershipDb = openReadDb();
  try {
    const ownership = shouldSkipBuild(ownershipDb, { ignoreRecentBuild: true });
    if (ownership.reason === 'daemon_active') {
      throw new Error('Obelisk daemon owns index writes; attune is read-only until the daemon stops');
    }
  } finally { ownershipDb.close(); }
  ...
```

`buildIndex` 里是同样的模式（第 9 章的①②③步）：

```ts
const ownership = inspectBuildOwnership({ force });
if (ownership.skip) return ownership;
const lease = acquireWriterLease({ ... });
if (!lease) return { skip: true, reason: 'writer_busy' };
try {
  // Ownership may change between the first read and lease acquisition.
  const ownershipAfterLease = inspectBuildOwnership({ force });
  if (ownershipAfterLease.skip) return ownershipAfterLease;
```

**同一个模式在两个入口各写了一遍**，因为它们的后续动作不同（一个索引、一个写记忆），但检查的顺序必须一致。

> **当时**
>
> 这六步是逐条讨论出来的。先是把"CLI 不动"精确定义成一个范围：
>
> > "这里的'不动'应精确定义为：skill 可以只读查询，但不得打开写路径、迁移 schema、改变 PRAGMA、checkpoint 或索引。"
>
> 然后是流程本身，包括那个关键的第 4 步：
>
> > "1. skill 用只读连接检查 heartbeat。2. heartbeat 新鲜：直接查询现有 DB；不碰 writer lease。3. heartbeat 过期：尝试获取 writer lease。**4. 获取 lease 后再次检查 heartbeat，消除 TOCTOU 竞态。** 5. 仍无活跃 daemon，才打开写连接、迁移并索引。6. lease 获取失败：放弃索引，退回只读查询。"
>
> 同一次会话里也校正了架构认识：
>
> > "app 与 skill 是两种 indexing mode，不是两套 persistence……事务与 writer lease 必须进入共享 Core，通过 SQLite binding adapter 注入。"
>
> 出处：Codex session `019f4b11`（评估 rollback 修复），2026-07-10。

---

## 超时预算：四个不同的数字

```text
250 ms   索引写连接、CLI 读连接
5000 ms  App 的长期查询连接（configureConnection 的默认值）
0 ms     心跳写入、租约获取
有界      租约等待（attune 1 秒，App 构建 2 秒）
```

**这四个数字互不相同，各有各的理由：**

**250 毫秒**——够短，让"暂时忙"很快变成一个明确的返回值，而不是长时间挂起；够长，扛得住一次正常的短写入。

**5 秒**——App 的查询连接长期存在，用户在界面上点开一个 session 时宁愿多等一会儿，也不愿看到"数据库忙"。

**0 毫秒**——心跳和租约获取绝不阻塞。心跳跑在 Electron 主线程上；租约有自己的重试循环，不需要 SQLite 帮它等。

**有界等待**——`attune` 等 1 秒（用户刚批准了一个操作，值得多试一下），App 构建等 2 秒（后台工作，可以慢）。

`configureConnection` 里还有两行：

```ts
db.exec('PRAGMA journal_mode=WAL');
db.exec('PRAGMA synchronous=NORMAL');
```

**WAL 让读写可以并发**——没有它，任何一次写入都会阻塞所有读取，"App 索引时 CLI 还能查"根本不成立。`synchronous=NORMAL` 是在 WAL 下的常规选择：牺牲"断电时丢失最后几次提交"的风险，换取显著的写入吞吐。对一个可以整体重建的索引来说，这个交换是划算的（第 5 章：证据表可重建）。

## `caller-held`：一个跨越多个阶段的租约

手动重建是所有操作里最复杂的一个：

```text
① 在 worker 线程里构建一个全新的数据库文件
② 原子替换掉目标数据库
③ 重新打开连接
```

**这三步必须在同一个租约下完成。** 如果 ① 结束就释放，另一个进程可能在 ② 之前抢到锁，然后它的写入会被 ② 的替换整个丢掉。

于是 `buildIndex` 多了一个参数：

```ts
if (writerLeaseMode !== 'acquire' && writerLeaseMode !== 'caller-held') {
  throw new Error(`Unknown writer lease mode: ${writerLeaseMode}`);
}
let lease = null;
if (writerLeaseMode === 'acquire') {
  lease = acquireWriterLease({ ... });
  if (!lease) return deferredBuildResult('writer_busy');
}
```

`caller-held` 表示"调用方已经拿着租约了，你别自己拿"。主进程在整个重建流程外面持有租约，worker 用这个模式。

**注意它是显式的字符串枚举，还带一个未知值检查。** 这种"谁持有锁"的隐式约定最容易出错，做成一个必须显式声明的参数，至少让它在代码里可见。

## 贯穿全章的一条原则

回头看，同一个判断反复出现：

| 场景 | 未知时的选择 |
|---|---|
| 事务状态问不出来（`null`） | 当作还活着，执行回滚 |
| 所有权读取失败（非"表不存在"） | 当作 daemon 可能活着，不写 |
| 事务是否可重试 | 只有确认 `=== false` 才重试 |
| 心跳刚好在窗口边缘 | 60 秒窗口 vs 30 秒间隔，两倍余量 |

**信息不确定时，选择"少做"而不是"多做"。** 因为这个系统的失败代价是不对称的：漏掉一次索引，下次构建会补上（游标没前进，第 9 章）；而两个进程同时写，可能损坏索引。

**可恢复的失败和不可恢复的失败，不该用同一个决策标准。**

## 这一章你应该带走的

1. 五种写者共享一个 WAL 数据库，并发是这个架构的必然产物，不是设计失误。
2. 事故的教训是**清理代码不许掩盖主异常**——它会销毁诊断所需的证据。
3. `busy_timeout` 不是并发修复：`SQLITE_BUSY_SNAPSHOT` 等再久也没用，重试单条语句会重放事务的一部分。
4. `BEGIN IMMEDIATE` 把失败提前到一个干净的位置。
5. **重试是上层策略**，条件严格：work/commit 阶段 + BUSY + 事务确认已结束；重试的是**整个事务**。
6. **心跳表达政策，租约保证互斥**——两者职责不同，因为政策信息会竞态或过期。
7. TOCTOU 窗口靠"拿到租约后再检查一次"关闭，两个写入口各实现一遍。
8. 租约用独立的 SQLite 文件，因为两个 binding 在所有平台上锁语义一致，且崩溃自动释放。
9. 四个不同的超时数字各有理由；心跳和租约获取绝不阻塞。
10. **信息不确定时选择少做**，因为失败代价不对称。

下一章讲另一个横切问题：增量与重放。
