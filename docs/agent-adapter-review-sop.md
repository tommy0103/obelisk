# Agent Adapter Review SOP —— 从历史 review session 提炼

> 本文档通过 obelisk 检索了本仓库（tommy0103/obelisk）中所有对 agent adapter（provider
> adapter）实现的 review session，逐次提取卡点（review 中发现并卡住/险些卡住合并的问题），
> 归纳"从什么角度 review 会发现这些问题"，最后抽象成一套可被 agent 直接执行的 SOP。
>
> 生成日期：2026-09-19。检索工具：obelisk（本地 session 历史索引）。共分析 13 组
> review session（约 15 个 PR / 评估对象），证据 session id 见附录。

---

## 1. 历次 review 全景：每次的卡点

### 1.1 PR #35 provider indexing foundations（kimi，859 msgs，CLOSED→经 #23 合入）

不是单 adapter，而是 provider 索引基础设施（opaque cursor、原子撤回、可见性状态）。

| 卡点 | 严重度 | 要点 |
|---|---|---|
| kimi marker replay 静默 no-op | 阻塞 | replay 用 `sessions.jsonl_path` 做 key 去 DELETE `index_state`，但 kimi 的 cursor key 是 session 目录，永远匹配不到；claude/codex 恰好 key 对称不受影响；**测试全用 key 对称的假 provider，完全没覆盖**。修复：#38 新增 `sessionUnitKey` 钩子 |
| `retractSessionIds` 死契约 | 阻塞 | types.ts 和 ADR-0001 承诺"设置即原子撤回"，但全仓唯一消费者只做 UI 通知，core persist 不删数据。修复：#37 |
| `failures()` LEFT→INNER JOIN 回归 | major | 孤儿 tool_result 从诊断工具消失；被审查代码自身的 `|| ''` 兜底反证孤儿形状真实存在。修复：#38 |
| opaque cursor 契约被自身实现违反 | major | types.ts 说只有 adapter 能解释 cursor，但 persist/app 都在 `split(':')`。git 考古后确认是 #23 之前的旧问题 → 降级开 issue #41 |
| app 双 indexer-service 泄漏 | major | rebuild `finally` 无条件 start，旧实例不停 → 双份 watcher。归因：旧 bug 被 PR 放大。修复：#38 |
| 其余 8 项 minor + 3 个 base 旧 bug + 5 个次生发现 | minor~low | 迁移窗口、disabled provider 卡死重建、错误路径无 catch 等 |

**这次 review 的特点**：4 分区并行（AgentSwarm）+ 同一问题被两个分区独立发现作为高置信信号；
对每条 finding 做 `git show base:file` 归因（PR 引入 / 旧 bug 被放大 / 纯旧 bug），并**主动更正了
自己的错误归类**。

### 1.2 PR #4 Pi session provider（codex，187 msgs，CLOSED 未合并）

| 卡点 | 严重度 | 要点 |
|---|---|---|
| 自定义 session 目录完全索引不到 | P1 阻塞 | PR 声称支持 `PI_CODING_AGENT_SESSION_DIR`，但 Pi 实际把自定义目录 session **平铺**写盘，discover 只扫子目录 → 功能形同虚设；测试只校验 root 字符串。靠 clone 上游 pi-mono 源码确认真实布局 + flat fixture 实测 `discover()` 返回 0 发现 |
| 重复 entry ID 破坏一致性 | P2 | 直接组装两条消息、SQLite round-trip 后一条，两条路径结果不一致（违反 ADR-0007） |
| 跨项目 session ID 碰撞覆盖 | P2 | session ID 无 project 命名空间，后索引者经 `delete-session` 覆盖前者。用两个 project 同 ID 的 fixture 实测证实 |
| custom metadata 未投影，测试名不副实 | P2 | PR 声称 fixture 覆盖 custom metadata，实际 fixture 只放了文本 —— **打开 fixture 核对实际内容才识破** |

### 1.3 PR #65 codex index archived sessions（kimi，175 msgs，MERGED）

| 卡点 | 严重度 | 要点 |
|---|---|---|
| 未声明的行为变更：cursor-skip 加 `!fileChanged` | 建议（两轴独立命中） | diff 里藏着对**既有路径**的语义改动，PR body 只字未提。深挖后确认方向正确，以 PR 评论 + squash commit message 显式记录，不阻塞合并 |
| 常量撞名 / 重复计算 / 同 id 双目录冲突仅隐式处理 | 建议 | smell 与未文档化的隐式依赖 |
| `session_index.jsonl` 变更触发全量重 parse 冷语料 | 建议（性能隐患） | 过滤器被绕过的爆炸半径推演 |

**特点**：reviewer 第一轮曾建议删掉 `!fileChanged`，经 `git log` 考古 + 对比三个兄弟 provider
的约定后**收回错误建议**——可疑守卫先考古再下结论。

### 1.4 PR #69 Kimi undo replay（kimi，139 msgs，MERGED）

| 卡点 | 严重度 | 要点 |
|---|---|---|
| prompt-owned injection 回拉缺失（只修了一半） | 阻塞 | 上游 `computeUndoCut` 会把 cutIndex 前移吃掉 `ownerPromptId` 匹配的连续 injection；PR 的 fixture 恰好没有这种排序，测不到。**只有对照上游真实实现逐行读才能发现**。作者追加 commit 修复 |
| 删分支后 `injectionMessageUuids` 变死代码 | 建议 | 只写不读，grep 全仓确认 |
| `system_trigger` 是否计入 count 无法验证 | 疑问 | 上游在私有仓库；诚实标注"无法验证"，后借本地 kimi-code 克隆闭环 |
| `Map<string, unknown>` 类型过宽 | 建议 | approve 时附带，作者次日 PR #73 落地 |

### 1.5 PR #72 vs #74 → #113 DeepSeek Harness provider（kimi 1442 msgs + codex 4819 msgs，#72/#74 CLOSED，#113 MERGED）

最重的一次。两个竞争实现 → 三轮补丁循环 → 判定架构不收敛 → 重写为 ADR-0011 树级架构 → 12 轮对抗 review。

| 阶段 | 代表卡点 | 要点 |
|---|---|---|
| #72/#74 对比 | token 双倍计数；增量边界丢 tool result；`raw()` sidechain 取错行；`file_path`/`agent_type` 恒 null；缺 `$DSH_HOME` | 全部靠**构造数据在两个分支上实际运行**发现；`dsh-chunk-rows.ts` 167 行被对照实验（含/不含输出逐项相同）证明冗余 |
| #74 R1–R3 | 跨帧重写 anchor → `parent_uuid` 自指 → `trace()` 死循环；root shrink 级联删 child 但保留 cursor → **数据长期消失**；真实 fixture 未脱敏（256 处用户路径） | 连续三轮 findings 全部集中在 frame 级增量 → 诊断"问题不在补丁质量，在架构位置" |
| #113 R1–R13 | root move 后自删（session 数变 0）；`existsSync` 分不清 ENOENT/EACCES → 临时权限错误变 tombstone 删数据；**新测试没进 CI 清单**；PR 声明"542/542 全绿"与 GitHub 实际 Windows 红不符；symlink/realpath 字面前缀过滤；Windows-safe ID **测试循环验证**（用 discover 验证 discover） | 每个 blocker 附固定 commit 上的可复现构造数据；用户介入校准威胁模型（"对抗构造不要超出真实威胁模型"） |

### 1.6 PR #82 OMP session indexing（kimi，194 msgs，MERGED）

| 卡点 | 严重度 | 要点 |
|---|---|---|
| `excludeInvoking` 误删 NULL session 的 memories | 阻塞 | SQL 三值逻辑：`NULL != 'x'` 为 NULL 被静默过滤；**测试没暴露因为 fixture 的 memory 全带 session_id**。用 node:sqlite 内存库最小 repro 证实 |
| PR 范围混杂：无关 query/CLI 增强捆绑 | 结构性阻塞 | 所有未决问题都在无关的 commit 4 → 要求拆 PR，拆走后用 `range-diff` 确认剩余提交与已审内容逐字节一致才合并 |
| 与 main 同行冲突 | 流程 | 主动 `git merge-tree` 预演，不等 CI 报 |
| title prelude 位置假设无注释 | 建议 | 失败模式推演：上游若把 title 更新写到文件中部 → 整个 session 解析失败；同文件两处宽容度不对称 |

### 1.7 PR #121/#122/#123 Codex guardian cursor 三连（codex，391 msgs，#121/#123 MERGED，#122 CLOSED）

| 卡点 | 严重度 | 要点 |
|---|---|---|
| CI 未执行核心新测试 | P1 | `cli.yml` 用显式测试文件列表，漏了新增测试文件 —— **"CI 全绿"并不保护本次回归**。同一模式在复审轮再次抓到（F13） |
| 已跑过 #121 的存量数据库永不升级 | P1 阻塞 | #122 沿用 v3 marker，而 replay 只在 marker 缺失时发生 → v3+旧格式 cursor 的库永远漏检。**持久化格式迁移的三态推演**（全新库/旧格式库/已迁移库） |
| 旧两段式 cursor 仍 fail-open | P1 阻塞 | NaN 比较导致非法 cursor 被永久跳过；失败模式推演 |
| Windows skip 的事实依据错误 | P1 | 测试注释称"Windows 无法检测 same-size rewrite"；reviewer 用 curl 拉 Node fs 官方文档 + libuv 源码**证伪注释前提** |
| "replacement"测试不是真 replacement | P1 | `writeFileSync` 原路径重写保留 inode，只测了 ctime 分支；应 tmp+rename 真正命中 inode 分支 —— **测试声称 ≠ 测试所证** |

架构结论：fail-closed 谓词应下沉为 Codex-local（`codebase-design` seam 检查），避免共享 helper
意外改变 Claude 行为 —— #122 因此关闭，#123 重做后合并。

### 1.8 PR #129 Kimi manifest discovery（codex，305 msgs，MERGED）

| 卡点 | 严重度 | 要点 |
|---|---|---|
| 整目录删除不回收旧数据 | 阻塞 | 实测删除目录后 `discover()` 返回 0，旧数据残留到 force rebuild |
| session 跨 workspace 移动被误删 | 阻塞 P1 | **第 1 轮的修复引入的新问题**：tombstone 按路径排序处理，新路径在前时删掉刚重建的 session。实测 `sessions=[]` |
| inventory 不完整仍提交破坏性 tombstone | 阻塞 P1 | `complete=false` 但数据已被删。修复：changedPaths 只作路由 hint，不作删除证明 |
| discovery 期间新增 member 漏检（TOCTOU） | 阻塞 P1 | 复现脚本证实；修复为前后两次枚举 + 拒绝不稳定快照 |
| census 把 basename 当全局 identity | **撤回** | 用户质疑后，reviewer 查上游源码（session ID 是全局随机 UUID）+ 统计本机 419 个真实 session 无重名 → **前提不成立，主动撤回 finding** |

**特点**：四个场景（删除/移动/竞态/数据源不可用）各写一个 repro 脚本直接驱动真实 provider 代码；
修复即新攻击面，逐轮复审增量 head。

### 1.9 PR #137 Claude custom session titles（kimi，344 msgs，MERGED）

阻塞项为 0，但过程有示范价值：

- fixture 是手写 JSONL 违反 verification contract → **reviewer 用本机 Claude 实跑 capture 真实记录**
  （隔离 `CLAUDE_CONFIG_DIR`），补 commit 推到 fork 分支随 PR 合入；意外捕获"Claude 命名时同时写
  `custom-title` 和 `agent-name` 两条记录"这一无人记录的事实。
- 用户一句"其他 provider 是否也有同样问题？"→ 4 个并行子代理按统一框架排查 Codex/Kimi/DeepSeek/Pi，
  发现 Claude 是唯一有病的 adapter（full-reparse/snapshot/append-only-frames 架构天然免疫）。
- 标题类字段审查三连：写已存 canonical 行 → 必须 bump `indexVersionMarker` + 模拟旧版 DB 的 replay
  回填测试；persist 层 null 合并语义不丢已存值；测试里模拟旧 marker 必须用字面量而非常量。

### 1.10 PR #140 marker replay 中断恢复 + PR #142 guardian discovery 线性化（kimi，171+124 msgs，均 MERGED）

- 均无阻塞项；建议级 finding（重复 SQL、误导命名、双处字面量）由 **reviewer 在隔离 worktree 当场
  修复并推回 contributor 分支**，CI 绿后合并 —— review 意见变成 commit 而不是评论里烂掉。
- #142 的示范动作：对 perf/等价性 PR 做**差分 fuzz**（11 种行型全枚举 + 20 万随机序列共 216,105 条
  验证新旧实现零分歧）+ 自造 fixture 复测 benchmark（p50 394.7ms→7.1ms，与 PR 宣称同量级）——
  不轻信 PR 自述数字。
- 红测试先做环境归因（worktree 缺 `app/node_modules`），排除后才算 PR 的账。

### 1.11 PR #175 GitHub Copilot provider 可行性评审（kimi，71 msgs，OPEN）

无阻塞项；价值在逐个排除高危存疑点：

- 上游 `vscode-copilot-chat` 源码里找不到 `session-store.db` 写入方 → 查发现**上游仓库已归档**，
  活跃代码迁至 `microsoft/vscode`，在其中找到 Chronicle 实现且 `SCHEMA_VERSION=3` 与 PR 吻合。
- 本机不存在 PR 假设的 transcripts 目录 → 上游源码确认写入逻辑属实，**本机缺失 ≠ 假设错误**。
- WAL 只读打开边角、活跃会话竞态：失败模式推演 + 与兄弟 adapter 模式对照后判定可接受。

### 1.12 DSH adapter 上游兼容性评估（codex ~9000 msgs + kimi ~1290 msgs，产出 #126/#129/#131 与 #182）

- Session A（v0.1.2-alpha2）：实测解析最新真实 session + 37 测试全过 → 兼容；但顺带暴露性能问题，
  产出三个修复 PR。
- Session B（v3）：**不能沿用**，三层断点 ——
  - 发现层：只探测 `session.jsonl[.zstd]`，`session.v2/v3.jsonl.zstd` 完全不可见；
  - 静默层：上游"不可变 generation + write-open 迁移"留下冻结旧文件，adapter 不报错但**会话静默
    停止更新**（最危险）；
  - 显式层：版本门 `version !== 0` fail-closed 压制整个 project。
- #182 review 的代表卡点：`seededPrefix: 0` 粘滞 → 父会话事件以子会话 uuid 泄漏进 sidechain
  （header-only 是合法中间态；修复为 fail-closed 保留 last-good cursor）；checkpoint 六个平行 map
  的 data clump（wire 格式版本纪律：严格判废自愈，蹭 marker bump 的全量 reindex 窗口把迁移成本摊为零）。

### 1.13 dimagent/dimcode adapter 设计评审（kimi，157 msgs，纯设计，未落地）

实现前的方案评审（用户两次拦下"别直接写代码"）：

- **内部审批会话 45:1 污染**：本机库 46 个会话中 45 个是权限审批的隐藏 reviewer 会话 —— 对真实
  数据做分布体检才发现；方案级过滤。
- **"本机零行"不构成跳过 `session_relations` 的理由**（ADR 对照）：上游 migration 后过滤会静默失效。
- 发现存量 bug：`deleteSession` 不清 `index_state` → tombstone 无限重放（cursor 收敛性走查）。

---

## 2. 卡点分类学：adapter review 的高频问题模式

跨 13 组 session 归纳，按出现频率/危害排序：

| # | 问题模式 | 典型实例 |
|---|---|---|
| P1 | **身份/key 不一致**：cursor key、session id、unit key 在 discover/parse/persist/删除路径上不对称 | #35 kimi replay 永远 DELETE 不到；#4 跨项目 ID 碰撞覆盖；#82 家族参数化时身份 hash 需逐字节不变 |
| P2 | **删除/移动/tombstone 误删数据**：破坏性操作在 inventory 不完整、move、rename、symlink 时误伤 last-good 数据 | #74 root shrink 级联删；#129 跨 workspace move 误删；#113 EACCES 变 tombstone |
| P3 | **cursor/marker 迁移不收敛**：旧格式库、已迁移库、tombstone 无限重放 | #122 存量库永不升级；dimagent 评审发现 tombstone cursor 为 null 无限重放 |
| P4 | **测试声称 ≠ 测试所证**：手写 fixture 冒充真实输出、mock 掩盖生产路径、测试循环验证、新测试没进 CI、注释前提被证伪 | #121/123 CI 清单漏新文件 ×2；#113 用 mock 掩盖 + discover 验证 discover；#4 fixture 名不副实；#82 fixture 全带 session_id 测不到 NULL |
| P5 | **对既有路径的未声明语义变更**：diff 里藏着的行为改动，PR body 只字未提 | #65 `!fileChanged`；#113 共享契约改动缺 ADR 决策 |
| P6 | **上游事实性假设错误**：文件布局、字段名大小写、版本常量、ID 生成方式、环境变量 | #4 Pi 平铺布局；#74 小写工具名/`$DSH_HOME`；#129 撤回（UUID 全局唯一）；#175 上游仓库已归档 |
| P7 | **增量/fast path 的正确性债**：补丁循环不收敛，正确性不变量横跨的状态范围大于优化假设的范围 | #74 三轮补丁后诊断"架构位置错了"→ ADR-0011 树级重写 |
| P8 | **错误处理吞错**：`existsSync` 折叠错误类型、try/finally 无 catch、失败静默提交残缺状态 | #113 ENOENT/EACCES；#35 renderer 静默复位；#129 root 不可用仍 tombstone |
| P9 | **SQL/状态组合边界**：三值逻辑、call/result visibility 交叉组合、升级窗口 | #82 NULL 过滤；#35 failures() 标签与准入不一致 |
| P10 | **流程/卫生**：PR 范围混杂、PR 描述与 diff 漂移、issue 关联错误、fixture 泄露本机路径、commit 语言 | #82 拆 PR；#182 PR body 重写；#74 fixture 256 处路径泄露 |

---

## 3. 发现角度：从什么角度 review 会发现这些问题

每个角度标注它在历史中抓到的代表卡点：

### A. Spec 合规对账（对照 issue / PR body / 上游 spec 逐条判定 Correct/Partial/Incorrect）
- 抓到：#4 自定义目录形同虚设（PR 声称支持实际索引不到）；#65 未声明的行为变更；#121 issue #104
  验收条件缺端到端回归；#182 PR 描述数字过期。
- 要领：**凡"测试已覆盖 X"的声称，打开 fixture 核对其内容**；PR 描述必须与最终 diff 对齐。

### B. Standards 对账（CONTRIBUTING / ADR / 仓库惯例逐条过）
- 抓到：fixture 真实性（#137、#129）、同步 I/O 禁令（#113 Electron 主进程 statSync）、smell
  基线（死代码、撞名、data clump）。
- 要领：条款引用到行号；区分"局部惯例"与"明文规则"以定级。

### C. 上游 ground truth 对照（读上游源码/真实数据，不信假设）
- 抓到：#4 Pi 平铺布局、#69 上游 `computeUndoCut` 回拉语义、#74 `$DSH_HOME` 与小写工具名、
  #129 撤回（419 个真实 session 无重名）、DSH v3 的 generation 迁移机制、#175 上游仓库归档迁移。
- 要领：clone 上游仓库读真实落盘/写入代码；本机真实数据取证（sqlite3 探查、统计分布）；
  **"本机没有" ≠ "源不存在"**；注意上游可能已归档/迁移。

### D. 失败模式推演（中间态、TOCTOU、崩溃残留、权限错误、平台差异）
- 抓到：header-only 中间态的 `seededPrefix: 0` 粘滞（#182）、discovery 枚举竞态（#129）、
  EACCES vs ENOENT（#113）、Windows ctime 语义（#123）、WAL 崩溃残留（#175）。
- 要领：对每条写入/删除/跳过路径问"如果这一步中断/被拒/在 Windows 上会怎样"。

### E. 实证构造数据验证（repro 脚本、差分 fuzz、benchmark，不轻信声明）
- 抓到：几乎所有 P1 级卡点都附实测 —— `sessions=[]`、`sessions 1→0`、token 210 vs 150、
  `NULL != 'x'` 内存库 repro、216,105 条差分 fuzz 零分歧、benchmark 复测。
- 要领：**每个 blocker 必须给出固定 commit 上的可复现构造**；PR 自述数字必须独立复测；
  声明的 CI 状态与 `gh` 实际状态核对。

### F. 兄弟 adapter 对称性比较
- 抓到：#65 `!fileChanged` 定性（对照 pi/kimi/claude 的 cursor 守卫约定）；#137 修一个 bug 后扫全部
  provider 的同类缺口；#74 用"codex 全量重解析仅 25-41ms"否定逐帧增量必要性；#129 修复对齐
  Pi identity census / DeepSeek tombstone 范式。
- 要领：同一契约点（cursor 守卫、删除语义、标题来源、身份生成）在所有 adapter 间摆成一行比较。

### G. 测试本身受审
- 抓到：CI 显式清单漏新测试文件（两次复发）、mock 掩盖生产路径、循环验证（discover 验证 discover）、
  `writeFileSync` 不是真 replacement、fixture 覆盖盲区（全带 session_id）。
- 要领：测试名/注释声称的场景对照实际系统调用语义；新增测试文件 ↔ CI 清单双向核对；
  回退被改代码确认新测试如期失败（回归有效性）。

### H. git 考古归因
- 抓到：#35 把"PR 引入 / 旧 bug 被放大 / 纯旧 bug"分开定级，避免错怪 PR；#65 收回错误的删除建议。
- 要领：`git show <base>:<file>` / `git log -S` 定位引入点；结论定级前先归因。

### I. 架构分层 / seam 检查（ADR 一致性）
- 抓到：#122 关闭重做（fail-closed 谓词应 Codex-local 而非共享 helper）；#35 契约字段无消费者
  （`retractSessionIds`）；dimagent 评审"本机零表不构成跳过理由"。
- 要领：对 ADR/类型注释里的每个承诺性字段，grep 全部消费者验证承诺兑现。

### J. 流程与卫生
- 抓到：PR 范围混杂（#82 拆出 commit 4）、`git merge-tree` 预演冲突、PR 必须源于既有 issue（#182）、
  fixture 脱敏（256→111 处路径）、range-diff 防"审完又偷改"。

---

## 4. SOP：Agent Adapter Review 标准作业程序

以下程序可直接被 agent 执行。每个阶段标注它对应的历史教训（§1/§2/§3 交叉引用）。

### 阶段 0：定位与基线锁定

1. 取 PR 元数据与关联 issue：`gh pr view N --json title,body,commits,reviews` + `gh issue view`。
   功能 PR 必须能追溯到既有 issue 讨论（§1.12 B5）。
2. 锁定审查基点：fetch PR head 到本地 ref / 建隔离 worktree（+ symlink node_modules），
   记录 merge-base 与 head SHA；所有 finding 引用固定 SHA。（§1.2、§1.5）
3. 定 review 轴：Standards（CONTRIBUTING/ADR/仓库惯例）与 Spec（issue 验收 + PR body + 上游 spec）
   双轴并行；两者独立命中同一处的问题优先级最高（§1.3、§1.1）。
4. `git merge-tree` 预演与 main 的冲突；`git log <base>..origin/main -- <改动文件>` 确认分支未过时。

### 阶段 1：Spec 对账

5. 把 PR body / issue 验收条件的**每条声称**列成清单，逐条判定 Correct / Partial / Incorrect；
   每条"已测试/已覆盖"的声称必须打开对应 fixture/测试核对实际内容。（§1.2 #4、§1.7 F8）
6. 把 diff 分成两堆：**新功能** vs **对既有路径的语义改动**。后者每一行都要能在 PR body/commit
   message 里找到声明；找不到即是必提卡点。（§1.3）
7. 上游事实核查：clone/读取上游宿主 agent 的真实源码（注意其可能已归档迁移），核对 PR 的全部
   格式假设 —— 路径布局、字段名大小写、版本常量、ID 生成方式、环境变量、保留策略。（§1.2、§1.5、§1.11）

### 阶段 2：Standards / ADR 对账

8. 逐条过适用条款（本项目：CONTRIBUTING 的 provider adapters / verification contract、
   ADR-0001/0002/0006/0007 等）；引用到行号定级。（§1.3、§1.7）
9. 契约字段 consumer 反向审计：对类型注释/ADR 里每个承诺性字段，grep 全部消费者验证承诺兑现；
   发现违约先 `git show base:file` 归因再定级。（§1.1、§3-H/I）
10. seam 检查：共享 helper 的语义改动是否会意外波及兄弟 adapter？fail-open/fail-closed 谓词是否
    放在正确的 adapter-local 位置？（§1.7 #122→#123）

### 阶段 3：正确性深查（adapter 特有）

11. **身份/key 一致性追踪**：把 cursor key、session id、unit key 在 discover/parse/persist/删除四条
    路径上的取值摆在一起比对；家族参数化时持久化身份（hash 前缀/kind 字符串）必须逐字节不变；
    检查测试 fake 的对称性是否掩盖了真实 adapter 的不对称。（§1.1 #1、§1.6、§2-P1）
12. **删除/移动收敛走查**：对 tombstone/retract/删除路径强制推演四个场景 —— 整目录删除、跨
    workspace 移动、枚举期间并发变更、数据源不可用（区分 ENOENT vs EACCES）。破坏性操作必须要求
    完整 inventory，changedPaths 只当路由 hint 不当删除证据。（§1.8、§2-P2）
13. **cursor/marker 迁移三态推演**：全新库 / 旧格式库 / 已跑过上一版迁移的库 × 迁移触发条件，
    确认每条路径都收敛；tombstone 必须留非空 cursor 防无限重放；wire 格式变更 bump 版本 +
    严格判废自愈，尽量蹭已有 marker bump 的全量 reindex 窗口。（§1.7 F7、§1.12 B1、§1.13 #3）
14. **失败模式穷举**：中间态（header-only、torn frame）、崩溃残留（WAL）、平台差异（Windows
    ctime/inode/chmod）、symlink/realpath 别名。SQL 注意三值逻辑与组合状态交叉。（§1.6 #1、§1.11）
15. **增量/fast path 熔断器**：若连续数轮 findings 共享同一根因，停止打补丁，升级为
    "fast path / correctness fallback"结构，并用"fast path 输出 ≡ 全量输出"的属性测试兜底；
    增量优化的收益必须先量化证明配得上它的状态机。（§1.5 阶段 C）

### 阶段 4：实证验证（不轻信任何声明）

16. 每个 blocker 给出固定 commit 上的**可复现构造**（最小 fixture / repro 脚本直接驱动真实 provider
    代码），输出决定性证据（`sessions=[]`、计数差异）。（§1.5、§1.8）
17. 独立复测 PR 自述数字：跑测试套件、benchmark 复测、`gh pr checks` 核对声明的 CI 状态；
    红测试先做环境归因（缺 node_modules/未 build）再算 PR 的账。（§1.10、§1.5 R11）
18. 对等价性/perf PR 做差分 fuzz（小输入全枚举 + 大量随机序列，覆盖坏行/乱序/重复头）验证新旧
    实现零分歧。（§1.10 #142）
19. 对本机真实数据跑一次端到端 discover/parse；新 adapter 先做数据源构成体检（行数、类型分布、
    异常会话分类），让污染类问题在设计期暴露。（§1.11、§1.13 #1）
20. 验证对抗构造不超出真实威胁模型 —— 与真实落盘顺序冲突的构造应降级，不当 blocker。（§1.5）

### 阶段 5：测试与 CI 审查

21. **CI 清单 ↔ 新增测试文件双向核对**：显式文件列表的 workflow 必须 grep 确认新测试真会进 CI。
    （§1.7 F1/F13、§1.5 R10）
22. **测试声称 ≠ 测试所证**：测试名/注释声称的场景对照实际系统调用语义（writeFileSync≠replacement、
    Windows skip 前提可被一手文档证伪）；检查 mock 是否掩盖生产路径、是否存在循环验证（用 X 验证 X）。
    （§1.7、§1.5 R13）
23. **fixture 审查**：优先真实 provider 输出（隔离环境实跑 capture + provenance README）；手写
    fixture 只算局部惯例保底；扫描 fixture 是否泄露本机绝对路径；检查 fixture 的排序/字段是否恰好
    绕过了要修的场景。（§1.9、§1.4、§1.5 R2）
24. **回归有效性**：把被改文件回退到旧实现，确认新测试如期失败且失败内容符合预期。（§1.4）
25. 字段写已存 canonical 行的三连查：bump `indexVersionMarker` + 模拟旧版 DB 的 replay 回填测试；
    persist 层 null 合并语义不丢已存值；测试里模拟旧 marker 用字面量而非常量。（§1.9）

### 阶段 6：归因、定级与闭环

26. **修复即新攻击面**：每轮复审先逐条验证上轮 finding 是否真修（非口头修），再把修复新引入的
    代码路径（尤其破坏性操作）当重点审查对象。（§1.8 #7/#8、§1.5）
27. **range-diff 守门**：作者 push 后先 `git range-diff`，零变化则只审 rebase 适配；合并前最后一步
    确认落地内容与已审版本逐字节一致。（§1.6）
28. **finding 前提校验**：凡依赖"宿主 agent 行为假设"的 finding，落地前用上游源码 + 本机真实数据
    校验；前提不成立就主动撤回并记录。（§1.8 #9）
29. **外部 review 结论先证伪再执行**：逐条最小复现验证真伪，分类为真实缺陷 / 规范缺口 / 过度解读，
    分别处理并记录理由。（§1.12）
30. 定级与归因分离：PR 引入 → 阻塞；旧 bug 被放大 → 视放大程度；纯旧 bug → 开 follow-up issue，
    不阻塞正确代码的合并。文档性质的遗留写进 squash commit message（未来 bisect 看的是 git history）。
    （§1.1、§1.3）
31. 建议级 finding 的闭环：reviewer 可在隔离 worktree 实现小修（helper 抽取/常量命名/补 fixture），
    跑聚焦测试后推回 PR 分支，CI 全平台绿才 squash merge；merge 后清理 worktree，遗留事项显式列出。
    （§1.10、§1.9）
32. 收尾核对：全部验证命令实际跑过（typecheck/lint/全量测试/三平台 CI）；PR body 与最终 diff 对齐；
    issue 关联正确；遗留项开 follow-up 或写明 wontfix 理由。（§1.12 B4/B5）

### 附：一页 checklist

```
[ ] 基点锁定:head SHA / merge-base / worktree 隔离
[ ] Spec 声称逐条对账;"已覆盖"声称打开 fixture 核对
[ ] diff 分堆:新功能 vs 既有路径语义改动,后者必须有声明
[ ] 上游源码核对全部格式假设(路径/字段/版本/ID/env)
[ ] ADR/契约字段 consumer 反向审计 + git 归因
[ ] seam 检查:共享 helper 改动是否波及兄弟 adapter
[ ] 身份/key 在四条路径上一致;fake 对称性≠真实对称性
[ ] 删除四场景推演:整删/移动/竞态/不可用(ENOENT≠EACCES)
[ ] cursor 迁移三态:新库/旧库/已迁移库;tombstone 非空 cursor
[ ] 失败模式:中间态/崩溃残留/Windows/symlink/SQL 三值逻辑
[ ] 连续 findings 同根因 → 熔断打补丁,升级 fast path/fallback 结构
[ ] 每个 blocker 有可复现构造;PR 数字独立复测;CI 状态 gh 核对
[ ] 等价性 PR 差分 fuzz;真实数据端到端跑一遍
[ ] 新测试↔CI 清单双向核对;测试声称≠测试所证;无循环验证
[ ] fixture 真实且脱敏;回归有效性(回退旧实现测试如期失败)
[ ] 复审:上轮 finding 逐条复验;新修复代码当新攻击面
[ ] range-diff 守门;合并前内容与已审版本逐字节一致
[ ] finding 前提用上游+真实数据校验;不成立即撤回
[ ] 定级先归因(PR 引入/旧 bug 放大/纯旧 bug);结论落 git
[ ] 全部验证命令实跑;PR body 与 diff 对齐;issue 关联正确
```

---

## 5. 附录：证据 session 索引

| 分析对象 | session id | 宿主 |
|---|---|---|
| PR #35 provider indexing foundations | `kimi:session_328e2b9a-2de5-4cb1-906c-1698e4fecd73` | kimi |
| PR #4 Pi session provider | `codex:019fa287-0d19-7202-9209-58bebcf775cb` | codex |
| PR #65 codex archived sessions | `kimi:session_3eeb5a98-a94c-4cc4-b326-45e6f374b106` | kimi |
| PR #69 Kimi undo replay | `kimi:session_8b376f67-93b2-40bc-966c-af6f5bb14990` | kimi |
| PR #72/#74/#113 DeepSeek Harness provider | `kimi:session_d245cbee-7079-4a76-b6b3-fea29716e5c2` + `codex:01a038db-1b3f-7440-84de-0edb9ec5b174` | kimi+codex |
| PR #82 OMP session indexing | `kimi:session_cc6750a9-050e-4eff-b767-66f23d0cab9c` | kimi |
| PR #121/#122/#123 Codex guardian cursor | `codex:01a05319-479d-7c22-b2e4-0d179b9e2b02` | codex |
| PR #129 Kimi manifest discovery | `codex:01a058cb-c24b-7b23-a341-e8b62ed64a9d` | codex |
| PR #137 Claude custom titles | `kimi:session_7c4c7ab6-fabb-4bb3-b6d3-36aef92822c4` | kimi |
| PR #140 + PR #142 | `kimi:session_30467c3c-d64b-4f3e-bf47-be0013db8e56` + `kimi:session_8000fc85-83e2-4a01-a661-91c78c81aa9a` | kimi |
| PR #175 Copilot provider | `kimi:session_193878b7-9164-4735-a52f-533a5d3e425d` | kimi |
| DSH 上游兼容性评估 | `codex:01a05431-9484-7a52-83ec-aa46b241c754` + `kimi:session_a89ba3a7-3b75-4c28-8d33-37d8278e31f0` | codex+kimi |
| dimagent/dimcode adapter 设计评审 | `kimi:session_377027cd-bf83-4c1e-9819-3f9720e9289c` | kimi |

范围说明：本文聚焦 provider adapter（Claude/Codex/Kimi/Pi/DeepSeek Harness/OMP/Copilot/dimcode）
的实现与兼容性 review。纯 core persist/search（如 #131/#149/#139）、app UI、打包类 PR 的 review
session 未纳入；#70 readLines、Trajex 抄袭核查等仅与 adapter 有间接关联的 session 也未纳入。
