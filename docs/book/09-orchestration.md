# 第 9 章 · 编排：一次 build 的完整生命周期

前两章讲的是两个纯粹的部件：适配器只翻译，persist 只落库。这一章讲把它们组织起来的那层——**它是唯一需要处理"事情会出错"的地方**。

代码在两个文件：`indexer.ts`（166 行，一次构建的完整流程）和 `provider-indexing.ts`（106 行，计划的制定与执行）。

一句范围说明：这一章讲**流程**，包括失败怎么降级。**谁有资格写**（心跳仲裁、写者租约）留给第 13 章，那是横切问题；**游标和版本标记的语义**留给第 14 章。这里只把它们当作已经通过的关卡。

## 骨架

```ts
function buildIndex({ force = false } = {}) {
  const ownership = inspectBuildOwnership({ force });     // ① 所有权检查
  if (ownership.skip) return ownership;

  const lease = acquireWriterLease({ ... });              // ② 拿租约
  if (!lease) return { skip: true, reason: 'writer_busy' };
  try {
    const ownershipAfterLease = inspectBuildOwnership({ force });  // ③ 再查一次
    if (ownershipAfterLease.skip) return ownershipAfterLease;

    const db = openDb();
    try {
      if (force) { /* ④ 清表 */ }

      const registry = createBuiltinProviderRegistry();
      const providerPlan = createProviderIndexPlan(db, registry, { force });   // ⑤ 制定计划
      const providerResult = indexProviderPlan({ ... });                       // ⑥ 逐单元执行
      if (providerResult.stopped) return { skip: true, reason: 'database_busy', ... };

      runRetryableWriteTransaction(txDb, () => { /* ⑦ 收尾 */ }, { label: 'finalize' });

      return { skip: false, skipped: skippedFiles.length, skippedFiles };
    } finally { db.close(); }
  } finally { lease.release(); }
}
```

七步。①②③是关卡（第 13 章），④⑤⑥⑦是正题。

先注意两个 `finally`：**数据库连接和写者租约的释放，不管走哪条返回路径都会执行。** 中间有五处 `return`，任何一处都不会漏掉清理。

## ⑤ 制定计划：先算清楚要做什么

```ts
export function createProviderIndexPlan(db, registry, { force, changedPaths } = {}): ProviderIndexPlan {
  const items: ProviderIndexItem[] = [];
  const pendingMarkers = new Map<string, string>();

  for (const provider of registry.list()) {
    const marker = provider.indexVersionMarker;
    const markerMissing = marker !== undefined && !db.prepare(
      'SELECT jsonl_path FROM index_state WHERE jsonl_path = ?').get(marker);
    if (markerMissing) pendingMarkers.set(provider.name, marker);

    const fullReindex = force || (markerMissing && sourceAlreadyIndexed(db, provider.name));

    const units = provider.discover({
      lastCursor: fullReindex ? () => null : (key) => storedProviderCursor(db, key),
      changedPaths: fullReindex ? undefined : changedPaths,
    });

    for (const unit of units) {
      items.push({ provider, unit, cursor: fullReindex ? null : storedProviderCursor(db, unit.key) });
    }
  }
  return { items, pendingMarkers };
}
```

**"先制定计划，再执行"是这一层最重要的结构选择。** 计划是一个纯数据结构：一个 `(provider, unit, cursor)` 三元组的数组，加一份待写的版本标记。

好处有三个：

**第一，重索引的决策集中在一处。** `fullReindex` 是个布尔值，算出来之后同时影响两件事——传给 `discover` 的 `lastCursor` 恒返回 `null`，以及每个 item 的 `cursor` 也是 `null`。两处必须一致，写在一起就不会漏。

**第二，`changedPaths` 在全量重索引时被主动清空。** 这是个容易漏的细节：daemon 模式下上层会传"哪些文件变了"，但如果这次是全量重索引，只看变化的文件就是错的。这里用 `fullReindex ? undefined : changedPaths` 关掉它。

**第三，计划可以被检查、被测试，而不必真的写库。** 执行阶段只是遍历，没有决策。

### `sourceAlreadyIndexed` 这个条件

```ts
const fullReindex = force || (markerMissing && sourceAlreadyIndexed(db, provider.name));
```

标记缺失**并且**这个来源已经索引过东西，才触发全量重索引。

为什么要加后半个条件？考虑一个全新的用户：库是空的，所有标记都缺失。如果只看 `markerMissing`，第一次构建就会被判定成"全量重索引"——虽然结果一样（本来就没有游标），但语义上是错的，而且会让第一次构建走一条不必要的路径。

**加了这个条件，"重放"的语义才准确：只有当库里躺着旧语义解析出来的数据时，才需要重放。**

## ⑥ 逐单元执行：一个单元一个事务

```ts
for (const item of plan.items) {
  try {
    const cursor = runTransaction(`provider:${item.provider.name}:${item.unit.key}`, () => (
      persist(db, item.unit, item.provider.parse(item.unit, item.cursor))
    ));
    committed.push(item);
    onCommitted(item, cursor);
  } catch (error) {
    failedProviders.add(item.provider.name);
    if (onError(error, item) === 'stop') {
      return { committed, failedProviders, stopped: { item, error } };
    }
  }
}
```

循环体只有一句实质代码，但它把第 6、8 章的两个承诺合在了一起：

```ts
persist(db, item.unit, item.provider.parse(item.unit, item.cursor))
```

`parse` 返回生成器，`persist` 消费它并在末尾写游标，整个表达式包在一次事务里。**解析、写记录、写游标，同生共死。**

事务的 label 是 `provider:<来源>:<单元 key>`。它会出现在错误诊断里（第 13 章），所以出问题时能直接看出是哪个来源的哪个文件。

### 失败降级：skip 还是 stop

错误处理被做成了一个回调，返回两种决策之一。调用方（`indexer.ts`）的策略是：

```ts
onError: (error, { provider, unit }) => {
  if (isBeginBusyFailure(error)) return 'stop';
  if (hasUnusableTransaction(error)) throw error;
  const message = errorMessage(error);
  skippedFiles.push({ path: unit.key, error: message, diagnostics: detail?.obelisk });
  process.stderr.write(`Warning: failed to index ${provider.name} unit ${unit.key}: ${message}\n`);
  return 'skip';
},
```

三条分支，按严重程度递减排列——**这个顺序本身就是策略**：

**`isBeginBusyFailure` → `stop`。** 连事务都开不起来，说明数据库正被别的进程占着。继续遍历剩下几百个单元只会重复失败。整个构建停下，返回 `database_busy`。这不是错误，是"现在不是时候"。

**`hasUnusableTransaction` → 直接抛。** 事务状态不确定——可能还开着，可能回滚失败了。这时候**任何后续操作都是不安全的**，所以不降级、不吞掉，直接向上抛。这一条是第 13 章那个 rollback 事故的直接产物。

**其余 → `skip`。** 一个文件解析炸了（格式坏了、磁盘读错了、适配器有 bug），记下来、警告一句、继续下一个。**一个坏文件不该让整个索引不可用。**

被跳过的单元有个自然的补偿：**它的游标没有前进**。下次构建会重新尝试同一个单元。不需要额外的重试队列——游标机制本身就是重试机制。

### 失败的来源被记住

```ts
const failedProviders = new Set<string>();
```

这个集合的用途只有一个，在第 ⑦ 步：**如果某个来源有任何单元失败，就不给它写版本标记。**

## ⑦ 收尾：一个事务，不许失败

```ts
runRetryableWriteTransaction(txDb, () => {
  refreshSessionProjectPaths(db);
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
  rebuildMemoryFts(db);
  db.prepare("INSERT OR REPLACE INTO index_state (jsonl_path, mtime, lines_processed) VALUES ('__last_build__', ?, 0)").run(Date.now());
  writeProviderIndexMarkers(db, providerPlan, providerResult);
}, { label: 'finalize' });
```

五件事，一个事务。代码上方有一句注释说明了它和前面的区别：

> Finalize is one transaction and is NOT swallowed: a finalize failure fails the build (a half-finalized index would be inconsistent).

**逐单元阶段容忍失败，收尾阶段不容忍。** 因为收尾做的是全局性的工作——FTS 重建到一半、项目路径回填到一半，索引就处于一个自相矛盾的状态。宁可整次构建报失败。

### 回填 project_path

```ts
function refreshSessionProjectPaths(db: NodeSqliteDb): void {
  const sessions = db.prepare('SELECT id, project FROM sessions').all();
  const cwdStmt = db.prepare(`
    SELECT cwd FROM messages
    WHERE session_id = ? AND cwd IS NOT NULL AND cwd != ''
    ORDER BY timestamp IS NULL, timestamp`);
  const update = db.prepare('UPDATE sessions SET project_path = ? WHERE id = ?');
  for (const session of sessions) {
    const cwds = cwdStmt.all(session.id).map((row) => row.cwd);
    const projectPath = inferProjectPath(session.project, cwds);
    if (projectPath) update.run(projectPath, session.id);
  }
}
```

这是第 8 章埋的伏笔：`project_path` 为什么由编排层负责。

原因是**它需要跨记录的视野**。一个 session 的真实工作目录，要从它所有消息的 `cwd` 里统计出来：

```ts
const best = [...byPath.values()].sort((a, b) => b.count - a.count || a.first - b.first)[0];
return best?.path || legacyProjectPathFromSlug(project);
```

**出现次数最多的那个路径胜出，平局时取先出现的。** 单个适配器在解析一个单元时看不到全貌——它可能只处理了这个 session 的 subagent 转写，或者只处理了新追加的几行。只有全部落库之后，这个统计才有意义。

兜底是从项目 slug 反推（把 `-Users-tomiya-Code-quiet-zero` 还原成路径）。这条路径不可靠——目录名里本来就带横杠的话就还原错了——所以它只是兜底，实测的 `cwd` 优先。

注意 `ORDER BY timestamp IS NULL, timestamp`：**把时间戳为空的行排到最后**。SQLite 里 `NULL` 默认排在最前，这个写法把它翻过来，让"先出现"这个平局判据用的是真实的时间顺序。

### 重建 FTS

```sql
INSERT INTO messages_fts(messages_fts) VALUES('rebuild')
```

第 5 章讲过：触发器保证过程中的一致性，这里保证最终的一致性。

为什么两条都要？因为**触发器覆盖不到 `force` 清表那条路径**——`DELETE FROM messages` 会触发 `messages_fts_ad`，但大批量删除后 FTS 索引会碎片化。而且外部内容表的索引和主表理论上可能因为异常路径失去同步。每次收尾重建一次，成本可控，换一个确定的状态。

### 版本标记：全成功才写

```ts
export function writeProviderIndexMarkers(db, plan, result): void {
  const write = db.prepare('INSERT OR REPLACE INTO index_state (jsonl_path, mtime, lines_processed) VALUES (?, ?, 0)');
  for (const [provider, marker] of plan.pendingMarkers) {
    if (!result.failedProviders.has(provider) && result.stopped === undefined) {
      write.run(marker, Date.now());
    }
  }
}
```

两个条件：**这个来源没有任何单元失败，并且整次构建没有被 stop 打断。**

这是重放机制的正确性保障。标记的含义是"这个来源已经全部按新语义重新解析过了"——只要有一个单元没成功，这句话就不成立，标记就不能写。下次构建会再次发现标记缺失，再重放一次。

**这是一个自我修复的机制**：只要有一次完整成功的构建，标记就落下；在那之前，每次都会重试。

## ④ force：清得干净，但不碰记忆

```ts
if (force) {
  runRetryableWriteTransaction(txDb, () => {
    db.prepare("DELETE FROM index_state WHERE jsonl_path != '__last_build__'").run();
    for (const table of ['messages', 'tool_calls', 'tool_results', 'sessions',
                         'summaries', 'subagents', 'workflows', 'workflow_agents']) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
  }, { label: 'force-cleanup' });
}
```

代码里的注释解释了为什么清表而不只是清游标：

> Clearing index_state alone re-indexes existing files but leaves rows for files that no longer exist on disk (stale sessions accumulate).

**只清游标是不够的**：源文件被删掉了，它的行还留在库里，而且再也不会被任何单元覆盖到。所以强制重建必须是"清空派生数据 + 从当前文件重新索引"。

三个细节：

`index_state` 清除时**保留 `__last_build__`**。其余的 key（游标、心跳、版本标记）全清——版本标记也清掉，意味着 force 之后所有来源都会重新写标记。

**`memories` 不在列表里**（第 5 章）。

**这一步单独一个事务**，而且它的失败处理和别处不同：

```ts
} catch (error) {
  if (isBeginBusyFailure(error)) {
    return { skip: true, reason: 'database_busy', ... };
  }
  throw error;
}
```

开不起事务就当作"现在不是时候"退出，其余错误直接抛。**清表清到一半是最坏的状态**，绝不降级。

## 返回值：三种"没做成"

`buildIndex` 的返回值是个判别联合，调用方靠 `reason` 区分：

| 返回 | 含义 | 谁来处理 |
|---|---|---|
| `{ skip: false, skipped, skippedFiles }` | 构建完成，可能跳过了几个坏文件 | 正常路径 |
| `{ skip: true, reason: 'daemon_active' }` | 桌面 App 拥有写权 | 第 13 章 |
| `{ skip: true, reason: 'recent_build' }` | 30 秒内刚构建过，跳过 | 见下 |
| `{ skip: true, reason: 'writer_busy' }` | 拿不到写者租约 | 第 13 章 |
| `{ skip: true, reason: 'database_busy' }` | 数据库被占，构建中断 | 第 13 章 |
| 抛错 | 收尾失败或事务状态不确定 | 向上传播 |

**"没做成"被细分成四种，而不是笼统的失败。** 这在 `executeAttune` 里有实际用途（`core.ts`）：

```ts
if (build?.reason === 'daemon_active') {
  throw new Error('Obelisk daemon owns index writes; attune is read-only until the daemon stops');
}
if (build?.reason === 'writer_busy' || build?.reason === 'database_busy') {
  throw new Error('Obelisk index writer is busy; attune was not applied');
}
```

两种情况给用户的说明完全不同：一个是"有别的程序在管，你得先关掉它"，一个是"暂时忙，重试即可"。**如果这里只返回一个布尔值，这个区分就消失了。**

`recent_build` 那条是个防抖：

```ts
const BUILD_DEBOUNCE_MS = 30000;
```

30 秒内构建过就跳过。因为第 3 章讲的"每次查询都先 `buildIndex()`"——agent 连续查三次，没必要扫三次磁盘。`force` 会绕过它（`ignoreRecentBuild`）。

## 一个防御：表不存在

```ts
function isMissingIndexStateTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table:\s*(?:main\.)?index_state\b/i.test(message);
}

function inspectBuildOwnership({ force = false } = {}) {
  if (!fs.existsSync(DB_PATH)) return { skip: false };
  const db = openReadDb();
  try {
    return shouldSkipBuild(db, { ignoreRecentBuild: force });
  } catch (error) {
    if (isMissingIndexStateTable(error)) return { skip: false };
    throw error;
  } finally { db.close(); }
}
```

所有权检查用的是**只读连接**（第 3 章说过：读连接不建表、不迁移）。但一个全新的或者很老的库里，`index_state` 表可能根本不存在，查询会报错。

这里的处理是：**只有"表不存在"这一种错误被解释成"可以继续"**（让写路径去建表），其余任何读失败都向上抛。注释写明了理由：

> Any other read failure leaves daemon ownership unknown, so fail closed.

**所有权未知时，选择保守。** 这个原则会在第 13 章反复出现。

靠正则匹配错误消息不优雅，但在这里是必要的——两种 SQLite binding 对这个错误的表达不完全一致，正则里的 `(?:main\.)?` 就是在吸收这个差异。

## 完整的流程图

```text
buildIndex({ force })
  │
  ├─ ① 所有权检查（只读）──────────── daemon 活着？30 秒内构建过？→ 直接返回
  ├─ ② 拿写者租约 ─────────────────── 拿不到 → writer_busy
  ├─ ③ 再查一次所有权 ─────────────── 关掉 ①②之间的窗口
  │
  ├─ ④ force ? 清空派生表（独立事务，不降级）
  │
  ├─ ⑤ 制定计划
  │     for 每个 provider:
  │       标记缺失且已索引过 → 这个来源全量重放
  │       discover() → 一批 IndexUnit
  │       每个 unit 配上它的游标
  │
  ├─ ⑥ 逐单元执行
  │     for 每个 item:
  │       事务 { parse → persist → 写游标 }
  │       失败 → BEGIN 忙就 stop / 事务不明就抛 / 其余 skip 并记录
  │
  ├─ ⑦ 收尾（一个事务，失败即整体失败）
  │     回填 project_path（跨记录统计 cwd）
  │     重建 messages_fts / memories_fts
  │     写 __last_build__
  │     给全部成功的来源写版本标记
  │
  └─ finally: 关连接、放租约
```

## 这一章你应该带走的

1. **先制定计划再执行**：计划是纯数据，重索引的决策集中在一处，执行阶段没有决策。
2. **一个单元一个事务**，解析/写记录/写游标同生共死；单元之间互不影响。
3. **失败按严重程度分三档**：BEGIN 忙就停、事务状态不明就抛、其余跳过并记录。跳过的单元游标不前进，**游标本身就是重试机制**。
4. **逐单元容忍失败，收尾不容忍**——半完成的收尾意味着不一致的索引。
5. `project_path` 由收尾阶段跨记录统计得出，因为单个适配器看不到全貌。
6. 版本标记**全成功才写**，于是重放机制自我修复。
7. "没做成"被细分成四种原因，因为它们对用户意味着完全不同的事。

第二部分的写入侧到此为止。下一章转到读出侧：CodeAct 运行时。
