# 第 14 章 · 增量与重放：游标、版本标记、force rebuild

第二个横切问题。

游标由适配器产出、由 persist 落库、由编排层解释——**三方各持一段，谁也不完整**。所以它进不了任何一个局部章节，只能单独讲。

这一章的主线是一个问题：**当索引和源文件对不上时，怎么让它们重新对上？** 答案有三层，代价递增。

## 三层"重新来过"

```text
① 单元级重试     游标不前进 → 下次构建重新处理这一个单元
   代价：一个文件

② 来源级重放     版本标记缺失 → 这个来源的全部单元从头解析
   代价：一个来源的全部文件

③ 全库重建       force → 清空所有派生表，从当前文件重新索引
   代价：全部
```

三层的**触发条件、覆盖范围、代价**各不相同，而且它们是嵌套的——上层做不到的事才升级到下层。

理解这三层，就理解了这个系统为什么能从大多数错误里自己爬出来。

---

## 第一层：游标

### 一圈完整的生命

```text
① 适配器 parse() 返回新游标
      return `${mtime}:${lineNum}`

② persist 拆成两个数字写进 index_state
      const [mtime, lines] = cursor.split(':');
      st.idx.run(unit.key, Number(mtime), Number(lines));

③ 下次构建，编排层拼回来
      return row ? `${row.mtime}:${row.lines_processed}` : null;

④ 交给 discover 判断"变了没"
      ctx.lastCursor(key)

⑤ 交给 parse 决定"从哪儿接着读"
      provider.parse(unit, cursor)
```

**中间没有任何人解释它的含义。** 第 6 章讲过这一点，这里补上它的完整闭环：游标在②被拆开、在③被拼回，两次操作都是纯机械的。

三种语义（第 7 章）：

| | 编码内容 | discover 怎么用 |
|---|---|---|
| Claude | 文件 mtime + **已处理行数** | mtime 比较，`<` 才重新处理 |
| Codex | 文件 mtime + 总行数 | mtime 比较，`>=` 就跳过 |
| Kimi | 目录聚合 mtime + **总行数之和** | **相等**比较，不等就重新处理 |

Claude 那个"已处理行数"是真的会被 `parse` 用来跳过前 N 行；Codex 的"总行数"从不被读回来（它每次全量重解析）；Kimi 的"总行数之和"是个变更指纹。

**同一个 `"数字:数字"`，三种用法。**

### 变更检测的实际代码

Claude 的判断是一个四项析取：

```ts
const cursor = ctx.lastCursor(file.path);
return historyChanged
  || forcedPaths.has(normalizedPath)
  || cursor === null
  || Number(cursor.split(':')[0]) < fs.statSync(file.path).mtimeMs;
```

四种情况会重新处理这个文件：

1. `history.jsonl` 变了——标题可能变在任何一个 session 上，全部重扫
2. 这个路径被"强制"了——见下
3. 从没处理过（游标为 `null`）
4. 文件 mtime 比游标里记的新

第 2 条对应一个具体场景：

```ts
if (absolute.toLowerCase().endsWith('.meta.json')) {
  const transcript = absolute.slice(0, -'.meta.json'.length) + '.jsonl';
  changedTranscriptPaths.add(transcript);
  forcedPaths.add(transcript);
}
```

**subagent 的元数据文件变了，要强制重新处理它对应的转写文件——即使那个转写文件的 mtime 没变。**

因为第 7 章讲过：`workflow_agents` 的一行由两个单元拼成。元数据来了，但承载它的那次解析已经跑过了，mtime 检查会让它被跳过。`forcedPaths` 就是这个跨文件依赖的补偿。

**这是纯粹的 mtime 增量检测扛不住的地方**：一个文件的"是否需要重新处理"，取决于**另一个文件**变没变。

Codex 有个类似的：

```ts
if (!sessionIndexChanged && cursor !== null && Number(cursor.split(':')[0]) >= fs.statSync(file.path).mtimeMs && guardian === null) {
  return [];
}
```

除了 mtime，还多两个条件：`session_index.jsonl`（标题来源）变了要重扫，以及**守卫线程永远重新处理**——因为它要产出 `delete-session`，而这个撤回必须每次都发出。

### `changedPaths`：daemon 模式的优化

```ts
if (ctx.changedPaths !== undefined && !historyChanged && !changedTranscriptPaths.has(normalizedPath)) return false;
```

App 监听到文件变化后，把具体路径传下来（第 12 章）。适配器可以只看这几个路径，不用扫整棵目录树。

**注意判断用的是 `!== undefined` 而不是真值检查。** 空数组 `[]` 是有意义的——"我确定什么都没变"，那就一个单元都不产出。而 `undefined` 是"我不知道，你自己扫"。

这个优化在两处必须被关掉：

```ts
changedPaths: fullReindex ? undefined : changedPaths,
```

全量重索引时（第 9 章），只看变化的文件是错的。**这行是把优化显式关闭的地方**——漏了它，一次本该完整的重放会退化成增量更新，而且不会报错。

### 游标就是重试队列

第 9 章讲过，这里再明确一次：

```text
某个单元解析失败
  → 事务回滚
  → 游标没写进 index_state（它和记录在同一个事务里）
  → 下次 discover 时，这个文件的 mtime 仍然 > 旧游标
  → 它再次出现在计划里
```

**不需要独立的重试队列、不需要失败列表、不需要退避表。** 失败自然导致游标停滞，游标停滞自然导致重试。

代价是失败的单元会在每次构建时都被重试一遍。如果一个文件永久性地解析不了（格式真的坏了），它会每次都失败一次、每次都往 stderr 打一行警告。**这是个可接受的浪费**——它有上限（一个文件），而且它保证了"文件被修好之后系统会自动恢复"，不需要任何人手动清理状态。

---

## 第二层：版本标记

游标解决"文件变了"。它解决不了另一类问题：**文件没变，但我解析它的方式变了。**

### 为什么不是数据迁移

传统做法是写迁移脚本：读出旧行、按新语义转换、写回去。

但在这里有更好的选择——**源文件还在**。索引是投影，不是原件（第 5 章）。所以正确的动作不是修改数据，而是**扔掉重算**。

```ts
export const CLAUDE_CANONICAL_TRANSCRIPT_MARKER = '__claude_canonical_transcript_v2__';
const CODEX_CANONICAL_TRANSCRIPT_MARKER = '__codex_canonical_transcript_v2__';
export const KIMI_CANONICAL_TRANSCRIPT_MARKER = '__kimi_canonical_transcript_v4__';
```

改了解析逻辑，就把版本号 `+1`。**数据迁移被替换成了一次重放。**

一个小细节：**退役的标记不会被清理**。真实使用一段时间的库里会同时存在 `__kimi_canonical_transcript_v3__` 和 `v4`，以及一些源码里早已删除的旧标记。它们无害——没有代码会再查询它们——而且正好构成一份重放历史。但这说明 `index_state` 的 key 空间只增不减，是那张"信令板"表（第 5 章）的又一处代价。

这个红利的前提条件很硬：**索引必须是可完全重建的**。第 5 章那个"证据表 / 记忆表"的分类在这里兑现了它的价值——证据表可以随便扔，因为它们算得回来。

### 三种状态

```ts
const marker = provider.indexVersionMarker;
const markerMissing = marker !== undefined && !db.prepare(
  'SELECT jsonl_path FROM index_state WHERE jsonl_path = ?').get(marker);
if (markerMissing) pendingMarkers.set(provider.name, marker);

const fullReindex = force || (markerMissing && sourceAlreadyIndexed(db, provider.name));
```

标记在 `index_state` 里的三种状态：

| 状态 | 含义 | 动作 |
|---|---|---|
| 行存在 | 当前语义已经全量应用过 | 正常增量 |
| 行不存在 + 该来源已有数据 | 库里是旧语义的数据 | **整源重放** |
| 行不存在 + 该来源没有数据 | 全新的库，或没用过这个来源 | 正常索引（第一次本来就是全量） |

第三种是 `sourceAlreadyIndexed` 这个条件的作用（第 9 章讲过）。它让"重放"这个词保持准确——只有真的存在旧数据时，才叫重放。

还有一种情况：**适配器根本没声明 `indexVersionMarker`**。

```ts
const markerMissing = marker !== undefined && ...
```

`marker` 为 `undefined` 时 `markerMissing` 恒为 `false`，这个适配器永远不会被这套机制触发重放。类型注释里那句：

> Optional index semantics marker; absence forces one provider-owned replay.

说的是**标记行的缺失**触发一次由该 provider 自己承担的重放。而不声明标记的适配器，等于放弃了这个能力——它得自己想办法处理语义变更（或者干脆加一个标记）。

### 为什么是按来源，而不是全局

标记是**每个 provider 一个**，重放也是每个 provider 独立的。

这个粒度是对的：Kimi 的折叠逻辑改了，没有理由让 Claude 的几百个文件也重新解析一遍。第 7 章那个"Claude v2 / Codex v2 / Kimi v4"的版本差异，正是这个独立性的证据——**Kimi 已经改过四次，另外两个一次都没被牵连。**

### 全成功才写

```ts
for (const [provider, marker] of plan.pendingMarkers) {
  if (!result.failedProviders.has(provider) && result.stopped === undefined) {
    write.run(marker, Date.now());
  }
}
```

两个条件：这个来源没有任何单元失败，且整次构建没有被 `stop` 打断。

标记的语义是"**这个来源已全部按新语义解析过**"。只要有一个单元没成功，这句话就不成立。

于是机制自我修复：标记没写下去，下次构建再次发现缺失，再重放一次。**在有一次完整成功的构建之前，它会一直重试。**

注意 `result.stopped === undefined` 这个条件——即使某个 provider 的所有单元都成功了，只要整次构建在后面被 `database_busy` 打断，也不写标记。因为构建被打断意味着**计划没跑完**，而这个 provider 的单元可能排在被打断的位置之后。

---

## 第三层：force rebuild

最粗的一层，第 9 章讲过流程，这里讲它为什么必须清表。

### 幽灵行

```ts
db.prepare("DELETE FROM index_state WHERE jsonl_path != '__last_build__'").run();
for (const table of ['messages', 'tool_calls', 'tool_results', 'sessions',
                     'summaries', 'subagents', 'workflows', 'workflow_agents']) {
  db.prepare(`DELETE FROM ${table}`).run();
}
```

代码注释解释了为什么不能只清游标：

> Clearing index_state alone re-indexes existing files but leaves rows for files that no longer exist on disk (stale sessions accumulate).

**只清游标，只能让还存在的文件被重新解析。** 那些已经从磁盘上消失的 session——用户删了、Claude Code 清理了——它们的行留在库里，而且**再也不会被任何单元覆盖到**，因为没有任何单元对应它们。

这是增量索引的固有盲区：**它只能表达"更新"和"新增"，表达不了"这个东西不在了"。**

（唯一的例外是 `delete-session`，但那要求适配器**主动发现**某个东西该消失——比如 Codex 的守卫线程。对"用户手动删了个文件"这种情况，没有任何适配器会知道。）

所以 force rebuild 的语义必须是：**清空一切能重算的，然后从当前实际存在的文件重新索引。**

### App 的手动重建更复杂

CLI 的 `--build` 是在原库上清表重建。App 的"重建索引"按钮走的是另一条路：

```text
① 在一个新文件里构建全新的数据库
② 从旧库里把 memories 搬过来
③ 原子替换目标文件
④ 重新打开连接
```

这四步全程持有同一个写者租约（第 13 章的 `caller-held` 模式）。

第 ② 步是关键：

```ts
function copyMemoriesFromDb(db, sourceDbPath) {
  if (!sourceDbPath || !fs.existsSync(sourceDbPath)) return false;
  db.prepare('ATTACH DATABASE ? AS previous_obelisk').run(sourceDbPath);
  try {
    const hasMemories = db.prepare(`
      SELECT name FROM previous_obelisk.sqlite_master
      WHERE type='table' AND name='memories'`).get();
    if (!hasMemories) return false;

    const sourceColumns = new Set(
      db.prepare('PRAGMA previous_obelisk.table_info(memories)').all().map(c => c.name),
    );
    const targetColumns = ['id', 'session_id', 'project', 'message_start', 'message_end',
                           'path', 'anchors', 'summary', 'created_at', 'deleted_at', 'deleted_reason'];
    ...
```

**记忆必须被显式搬运。** CLI 那条路径靠"不清 `memories` 表"就够了，因为它在原库上操作。这条路径是造一个新库，所以不搬就没了。

这段代码很谨慎：先查目标库有没有 `memories` 表（旧版本可能没有），再用 `PRAGMA table_info` 查旧库**实际有哪些列**，只搬两边都有的。这正是第 5 章那条实践的应用——**判断列是否存在要看 `sqlite_master` / `PRAGMA table_info`，不要看 `schema.sql`**，因为老库一定是漂的。

第 11 章那句"记忆是这个系统里唯一算不出来的东西"，在这段代码里是最具体的：**其他所有表都可以扔掉重建，只有它需要被小心地搬过去。**

---

## 三层的关系

```text
                触发条件              覆盖        代价      自动？
① 单元级重试     解析失败（游标停滞）    一个单元    极小      是
② 来源级重放     版本标记缺失          一个来源    中        是
③ 全库重建       用户显式要求          全部        大        否
```

**前两层全自动，第三层需要人。** 这个分界是合理的：前两层的触发条件都是系统自己能判断的（失败了、标记不在），第三层的触发条件是系统判断不了的（"我怀疑索引有问题"、"我删了一堆 session 想清理一下"）。

而且它们是**递进覆盖**的：

- 单元级修不好的（比如解析逻辑本身变了），来源级能修
- 来源级修不好的（比如幽灵行），全库级能修

## 这个系统在什么情况下能自愈

把前面几章的机制汇总，会发现自愈能力覆盖得相当广：

| 出了什么事 | 怎么恢复 | 需要人吗 |
|---|---|---|
| 某个转写文件格式坏了 | 跳过并记录，游标不前进；文件修好后自动重新索引 | 否 |
| 索引期间源文件正在被写 | Kimi 的前后游标校验抛错 → 跳过 → 下次重试 | 否 |
| 数据库被别的进程占着 | `writer_busy` / `database_busy` → 下次调用重来 | 否 |
| 事务因竞争失败 | 整事务重试三次；仍失败则跳过该单元 | 否 |
| 解析逻辑升级了 | 版本标记缺失 → 整源重放 | 否 |
| 重放中途失败 | 标记不写 → 下次继续重放 | 否 |
| 新增了一个数据源 | 新适配器的所有单元游标为 `null` → 全量索引 | 否 |
| **源文件被删除，留下幽灵行** | **只能 force rebuild** | **是** |
| **索引文件本身损坏** | **只能 force rebuild** | **是** |

**只有两种情况需要人介入，而且都有明确的补救手段。**

这个自愈能力不是某一个机制带来的，而是几个决定叠加的结果：

1. **索引是投影**（第 5 章）——所以扔掉重建总是安全的
2. **游标和记录同事务**（第 6 章）——所以失败自然等于重试
3. **失败按严重程度分档**（第 9 章）——所以局部问题不会升级成全局故障
4. **记忆层独立于重建**（第 11 章）——所以最粗暴的手段也不会造成不可逆的损失

第 4 条尤其重要：**正因为最坏情况下的损失是有界的（只是重新索引一遍，人的判断不会丢），所以才敢把"清空重建"设计成一个用户随手能点的按钮。**

## 这一章你应该带走的

1. 三层"重新来过"：**单元级重试、来源级重放、全库重建**，代价递增、覆盖递增，前两层全自动。
2. 游标一圈的生命：适配器产出 → persist 拆成两列 → 编排层拼回 → discover 和 parse 各用一次，**中间没人解释它**。
3. 纯 mtime 增量有盲区：跨文件依赖靠 `forcedPaths` 补偿，"文件消失"根本表达不了。
4. `changedPaths` 用 `!== undefined` 判断（空数组是有意义的），且全量重索引时必须显式关掉。
5. **游标就是重试队列**——失败导致游标停滞，停滞导致重试，不需要额外机制。
6. 版本标记把**数据迁移换成了重放**，前提是索引可完全重建；粒度按来源，全成功才写。
7. force rebuild 必须清表而不只是清游标，否则幽灵行永远留着。
8. App 的重建要显式搬运 `memories`——**它是唯一算不出来的东西**。

最后一章：加一个新来源要动哪几处，以及这套架构现在已知的不足。
