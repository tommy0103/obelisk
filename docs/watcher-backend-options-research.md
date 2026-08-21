# Obelisk watcher 后端方案研究

日期：2026-08-21  
范围：解决 macOS 上“文件在订阅前已打开、持续 append、长期不 close”时实时索引不更新，同时避免对约 23k 路径逐项持有 watcher 资源。

## 结论

不建议写一个通用的 “better chokidar”，也不建议为了这个问题立即引入 Watchman、Rust sidecar 或自研 native daemon。

适合 Obelisk 的方案是一个**领域专用的 hybrid watcher coordinator**：

1. 保留 `@parcel/watcher` 的递归目录订阅，负责发现目录/文件的 create、delete、rename，以及大部分普通 update。
2. 对数量有硬上限的“热 transcript”做异步 `stat` 轮询，以 `size`、`mtimeMs`、文件 identity 和存在性变化补上 macOS FSEvents 的实时缺口。
3. `history.jsonl`、`session_index.jsonl` 这类 provider 声明的**精确文件目标**永久进入小型轮询集合，不能作为 Parcel 的订阅 root。
4. 保留 5 分钟 full reconcile，作为事件丢失、热集合淘汰以及平台差异的最终一致性兜底。

这不是重新发明 chokidar，而是利用 Obelisk 已知的工作集：全树约 23k 路径，但同时活跃写入的 session 很少。资源应是 `O(目录 roots + 热 session 数)`，而不是 `O(全树路径数)`。

## 已确认事实与边界

本次本机验证已经确认：

- macOS 上，Parcel 的 `fs-events` 后端和 Node `fs.watch` 对一个订阅前已经打开、持续 append 且不 close 的 Codex JSONL，在 fd close 前均为 0 events。
- 相同写入下，Parcel 的 `kqueue` 后端可立即产生 `update`。
- 单纯降低 FSEvents latency 或启用 file-level flag 不是解法：Parcel 2.6.0 已使用 `0.001s` latency 和 `kFSEventStreamCreateFlagFileEvents`，见本地 [`FSEventsBackend.cc`](../app/node_modules/@parcel/watcher/src/macos/FSEventsBackend.cc#L206-L234) 及[上游同版本源码](https://github.com/parcel-bundler/watcher/blob/v2.6.0/src/macos/FSEventsBackend.cc#L206-L234)。
- 上述“长期 open fd 直到 close 才通知”是本次针对真实 Codex writer 的实测结论；Apple 文档没有承诺或明确描述这个精确时序，因此不把它外推为所有 FSEvents 写入的普遍定律。

Apple 对两套机制的定位与实测结果一致：FSEvents 面向大目录层级，kqueue 更适合单文件的细粒度通知；监控大层级时 kqueue 更消耗资源，而且要为每个文件打开 descriptor。见 [Apple: Kernel Queues—Choosing an Event Mechanism](https://developer.apple.com/library/archive/documentation/Darwin/Conceptual/FSEvents_ProgGuide/KernelQueues/KernelQueues.html#//apple_ref/doc/uid/TP40005289-CH5-SW3) 和 [Using Kernel Queues](https://developer.apple.com/library/archive/documentation/Darwin/Conceptual/FSEvents_ProgGuide/KernelQueues/KernelQueues.html#//apple_ref/doc/uid/TP40005289-CH5-SW4)。Apple 的 `kqueue(2)` 文档也明确说明 `EVFILT_VNODE` 以 fd 为 identifier，并提供 `NOTE_WRITE`、`NOTE_EXTEND`，见 [kqueue(2)](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/kqueue.2.html)。

Apple 同时将 FSEvents 的历史列表描述为 advisory，并建议需要完整性的应用周期性 full sweep；这正是保留 reconcile 的理由，而不是把 watcher 当作唯一真相源。见 [Apple: Using the File System Events API](https://developer.apple.com/library/archive/documentation/Darwin/Conceptual/FSEvents_ProgGuide/UsingtheFSEventsFramework/UsingtheFSEventsFramework.html#//apple_ref/doc/uid/TP40005289-CH4-SW6)。

## 当前代码中的另一个独立问题：file root

当前 provider contract 把目录和文件都表示成 `string[]`：

- Codex 返回 transcript 目录和 `session_index.jsonl`，见 [`codex.ts`](../packages/core/src/providers/codex.ts#L385-L394)。
- Claude 返回 `projects` 目录和 `history.jsonl`，见 [`claude.ts`](../packages/core/src/providers/claude.ts#L437-L446)。
- Kimi 返回 `sessions` 目录和 `session_index.jsonl`，见 [`kimi.ts`](../packages/core/src/providers/kimi.ts#L681-L688)。

但 Parcel 的 FSEvents backend 明确要求 subscription root 是目录；不是目录就抛 `ENOTDIR`，见本地 [`FSEventsBackend.cc`](../app/node_modules/@parcel/watcher/src/macos/FSEventsBackend.cc#L195-L203)。因此把 `session_index.jsonl` 直接传给 `subscribe()` 是类型建模错误，不是 macOS 长期 append 问题的一个表现。

建议把 provider 输出改成有类型的目标，例如：

```ts
type WatchTarget =
  | { kind: 'tree'; path: string }
  | { kind: 'file'; path: string };
```

`tree` 交给 Parcel；`file` 进入 exact-file polling 集合。不要简单订阅文件的 parent：这会无意扩大部分 provider 的递归监听范围，而且仍不能保证 macOS 长期 append 的低延迟。

## 方案比较

| 方案 | 能否解决已复现的 macOS append | 约 23k 路径资源模型 | 集成/部署 | 评价 |
|---|---|---:|---|---|
| Parcel + bounded polling | 能；轮询不依赖 FSEvents 是否产生 callback | `O(roots + hot files)` | 沿用现有依赖 | **推荐** |
| 全树 Parcel kqueue | 能 | `O(all entries)` fd | 只需切 backend | 不可接受 |
| Watchman | 未证明；macOS 主路径仍基于 FSEvents | daemon 管理全树，恢复能力较强 | 新增安装/打包/daemon 生命周期 | 不作为本问题的解法 |
| Rust `notify` / watchexec | 默认仍是 FSEvents；PollWatcher 能解决但通常扫全树 | 取决于 FSEvents、逐路径 kqueue 或全树 polling | 新增 sidecar 与跨平台打包 | 没有语义优势 |
| 自研 exact-file kqueue addon/daemon | 能 | `O(hot files)` fd | native 构建、签名、预编译、恢复协议 | polling 不够时的第二阶段 |
| 通用 “better chokidar” | 只有做成 hybrid 才能 | 取决于 active-set 是否有界 | 需重新承担跨平台 watcher 维护 | 不值得泛化 |

### `@parcel/watcher`

Parcel 在 macOS 默认选 FSEvents，并允许显式选择 `kqueue`，见本地 [`Backend.cc`](../app/node_modules/@parcel/watcher/src/Backend.cc#L30-L68) 和[上游 2.6.0 源码](https://github.com/parcel-bundler/watcher/blob/v2.6.0/src/Backend.cc#L30-L68)。

但是它的 kqueue recursive subscription 会先构建完整目录树，再遍历每个 entry；每个 entry 都 `open(path, O_EVTONLY)` 并注册 `EVFILT_VNODE`，见本地 [`KqueueBackend.cc`](../app/node_modules/@parcel/watcher/src/kqueue/KqueueBackend.cc#L120-L176) 和[上游源码](https://github.com/parcel-bundler/watcher/blob/v2.6.0/src/kqueue/KqueueBackend.cc#L120-L176)。这可以解释为何实测实时，却也准确重现了需要避免的 per-path fd 成本。

Parcel 的 Linux backend 使用一个 inotify instance，但递归树为每个目录注册 watch，并订阅 `IN_MODIFY`；见本地 [`InotifyBackend.cc`](../app/node_modules/@parcel/watcher/src/linux/InotifyBackend.cc#L8-L13) 和 [`InotifyBackend.cc`](../app/node_modules/@parcel/watcher/src/linux/InotifyBackend.cc#L55-L82)。Linux `inotify(7)` 将 `IN_MODIFY` 定义为 `write(2)`/`truncate(2)` 引起的修改，同时明确目录监听不递归、必须为子目录建立额外 watch，并受 `max_user_watches` 限制，见 [Linux inotify(7)](https://man7.org/linux/man-pages/man7/inotify.7.html)。所以 Linux 的长期 append 预期比 macOS 好，但仍应以实测验证，不能只凭 API 名称保证 Obelisk 全链路。

Parcel 的 Windows backend 对一个目录 handle 使用递归 `ReadDirectoryChangesW(..., TRUE, ...)`，并监听 size 和 last-write，见本地 [`WindowsBackend.cc`](../app/node_modules/@parcel/watcher/src/windows/WindowsBackend.cc#L71-L145)。微软文档说明 subtree 可递归监听，但 size/last-write 可能要等缓存充分 flush 才被检测，还明确要求 buffer 丢失后重新枚举，见 [Microsoft: ReadDirectoryChangesW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw)。因此 Windows 也必须跑长期 open writer 测试；不能先验断言完全没有相似延迟。

### Watchman

Watchman 的优势是工程化恢复，不是创造新的 macOS 文件事件语义：

- 当 watcher 失同步时会 recrawl 全树，见 [Watchman troubleshooting: recrawl](https://github.com/facebook/watchman/blob/5a2736bedac5f196cf95acea193b634e0c746d80/website/docs/troubleshooting.md#L26-L43)。
- 旧 clock 或新 daemon 会触发 fresh-instance 语义，保守返回当前文件集合，见 [Watchman query docs](https://github.com/facebook/watchman/blob/5a2736bedac5f196cf95acea193b634e0c746d80/website/docs/cmd/query.md#L89-L95)。

这些能力与 Obelisk 已有 full reconcile 的目标相似，但不保证 FSEvents 没有产生实时事件时仍能低延迟得知 append。

Watchman 确实有 opt-in 的 `kqueue+fsevents` 混合 watcher：root 和 root 的直接文件走 kqueue，子目录走 FSEvents，见 [kqueue_and_fsevents.cpp](https://github.com/facebook/watchman/blob/5a2736bedac5f196cf95acea193b634e0c746d80/watchman/watcher/kqueue_and_fsevents.cpp#L87-L92) 及其[启用条件](https://github.com/facebook/watchman/blob/5a2736bedac5f196cf95acea193b634e0c746d80/watchman/watcher/kqueue_and_fsevents.cpp#L305-L323)。Obelisk 的 transcript 通常位于深层目录，因此这不会自动覆盖目标文件；把大量 session parent 各自提升为 root 又会扩大 watcher 和 fd 数量。Watchman 的纯 kqueue 实现同样为文件 `open(..., O_EVTONLY)`，见 [kqueue.cpp](https://github.com/facebook/watchman/blob/5a2736bedac5f196cf95acea193b634e0c746d80/watchman/watcher/kqueue.cpp#L71-L137)。

因此，除非 Obelisk 未来还需要跨进程共享 watcher、持久 clock 查询或大规模 recrawl 管理，否则仅为本问题新增 Watchman daemon 成本大于收益。

### Rust `notify` / watchexec

换语言不会改变 OS primitive：

- `notify` 默认 macOS feature 是 FSEvents，kqueue 是可选 feature，见 [`notify/Cargo.toml`](https://github.com/notify-rs/notify/blob/9be985bbe6ad978b2669c4a766aa9e6232c4961e/notify/Cargo.toml#L20-L24)。
- recursive kqueue 会 WalkDir 遍历并逐 entry `add_single_watch`，见 [`notify/src/kqueue.rs`](https://github.com/notify-rs/notify/blob/9be985bbe6ad978b2669c4a766aa9e6232c4961e/notify/src/kqueue.rs#L427-L450)。
- `PollWatcher` 可解决事件缺口，但默认模型是按 interval 重扫受监控路径，见 [`notify/src/poll.rs`](https://github.com/notify-rs/notify/blob/9be985bbe6ad978b2669c4a766aa9e6232c4961e/notify/src/poll.rs#L640-L687)。对 Obelisk 应借鉴 polling，而不是全树使用它。
- watchexec 在这里提供的仍是 notify 的 recommended watcher 或 poll watcher，见 [`watchexec/fs.rs`](https://github.com/watchexec/watchexec/blob/f29ce3f2ba128e2c1d22b812b9931292ec69a49a/crates/lib/src/sources/fs.rs#L25-L64)。

引入 Rust sidecar 会增加 Electron 打包、签名、升级和进程生命周期管理，却没有新的后端语义，因而不推荐。

### VS Code 的可借鉴点

VS Code 官方说明其 recursive watcher 使用 Parcel，non-recursive watcher 使用 Node `fs.watch`；只有路径缺失/删除后的恢复等待使用 5 秒 `fs.watchFile`。见 [VS Code File Watcher Internals](https://github.com/microsoft/vscode/wiki/File-Watcher-Internals)。这证明 Parcel + 辅助机制是成熟的组合方式，但 VS Code 的策略没有提供一个针对长期 open append 的现成 overlay，不能直接照搬解决本问题。

## 推荐的具体架构

### 1. Watch target 归一化

在 provider registry 与 watcher 之间保留目标类型：

- `tree`：交给 Parcel，缺失时沿用当前 async access + retry。
- `file`：交给 exact-file poller；缺失是正常状态，出现、替换、删除、增长都产生 changed path。

相同 tree 去重；被某个 tree 覆盖的 file 仍保留在 poller，因为 polling 的目的不是补目录覆盖，而是补 update 时序。

### 2. 有界热文件集合

维护两类条目：

- `pinned`：provider 的精确文件目标，数量固定且很小。
- `hot transcripts`：最多 64 个，可配置但必须有硬上限。

热文件来源：

1. startup/full reconcile 的 build 结果返回最近处理的 transcript `watchHints`；
2. Parcel 的 create/update event 命中 transcript 时立即 promote；
3. polling 命中变化时刷新 LRU；
4. 超过上限只淘汰最久未活动的非 pinned 条目。

不建议只设一个很短的 TTL：真实开发中 session 暂停几十分钟后继续是正常场景。使用有界 LRU，让最近的 64 个条目一直保留；即使极少数条目被淘汰，5 分钟 reconcile 仍提供有界恢复。

### 3. Poll loop

- 间隔先取 1 秒；只允许一个 tick 在途，避免慢磁盘时叠加。
- 使用异步 `stat`，限制并发；不要在 Electron main 调用同步 FS API。
- baseline 至少保存 `{ dev, ino, size, mtimeMs }`；比较 identity 可以识别原路径被替换。
- `ENOENT`/`ENOTDIR` 表示缺失状态，不刷 warning；其他错误沿用当前 per-target 去重告警。
- 变化后只调用已有 `onChange(path)`，继续复用 `changedPaths` 聚合、stability debounce 和增量 cursor，不在 poller 内直接 build。
- 定时器应可停止且不阻止退出；暴露 hot count、tick duration、stat error count，便于生产验证。

在 64 个热文件、1 秒间隔下，每秒最多约 64 次 metadata probe；没有长期持有的 per-file fd。实际阈值仍应通过下面的测试测量，而不是把这个估算当作性能结论。

### 4. Reconcile 仍是 correctness boundary

事件和热轮询负责低延迟，full reconcile 负责最终一致性。遇到 Parcel dropped-event/root recovery、poller 淘汰或无法访问时，不需要创造复杂的全局事件证明，只要请求一次 full inventory。这个模型也符合 Apple 对 FSEvents advisory + periodic sweep 的建议。

### 5. 何时升级到 native exact-file kqueue

只有在真实 workload 证明 64 个/秒的 async stat 成本不可接受，或 1 秒延迟不满足产品要求时，再实现一个**仅监控 hot set** 的 exact-file kqueue addon。它应严格保持 `O(hot files)` fd，并复用同一 coordinator 接口。

不要切换 Parcel 的整个 root 到 kqueue；Parcel 2.6.0 的 API/实现是递归目录 subscription，不提供 exact-file kqueue overlay。

## 验证矩阵

测试 writer 必须显式覆盖“订阅前打开”和“订阅后打开”，不能再用每次 append 都 open/write/close 的 helper 代替真实生产行为。

| 平台/场景 | 写入方式 | 期望 |
|---|---|---|
| macOS APFS，订阅前 open | 单 fd 每秒 append，至少 30 秒不 close | 即使 Parcel 0 events，poller 也在约 2 秒内推进 DB cursor/UI |
| macOS APFS，订阅后 open | 同上 | 同上；无重复 build 风暴 |
| macOS，热文件暂停后恢复 | 暂停超过普通 debounce 后继续用原 fd append | 文件仍在有界 LRU 时约 2 秒内更新 |
| macOS，23k 路径 inventory | 启动、空闲、批量 create/delete | fd 增长不随文件数线性增加；hot set 不超过配置上限；记录 idle CPU/tick duration |
| 精确 file root | `session_index.jsonl` 启动时存在/不存在/后来创建/替换 | 不调用 Parcel file-root subscribe；均能产生 changed path，无 `ENOTDIR` |
| root 删除并重建 | 删除 tree root，数秒后重建并创建 transcript | retry 恢复 subscription，并触发 full inventory |
| 高频 append | 10–50 次短间隔 append，不 close | stability 聚合生效；最终 cursor 完整，无持续重复 rebuild |
| Linux 本地 FS | 长期 open fd append | 验证 Parcel/inotify 是否及时产生 update；polling 去重后最终只形成合理 build 次数 |
| Windows NTFS | 长期 open、分别测试 flush 与不 close | 测量 ReadDirectoryChangesW latency；若系统通知延迟，poller仍满足目标 |
| 支持的 WSL/网络路径 | 正常写入、暂时不可达、恢复 | async probe 不阻塞 UI；错误告警去重；恢复后 full inventory |
| watcher dropped/error 注入 | callback error、overflow 等价信号 | dead subscription 被移除、retry，随后 full inventory 修复状态 |

建议验收指标：

- 本地活跃 transcript 的 p95 可见更新时间不超过 2 秒；
- hot set 永不超过配置上限；
- 23k 路径下 fd 数不随文件总数线性增长；
- 轮询 tick 不重叠，应用退出后无存活 timer/subscription；
- 5 分钟 reconcile 后 DB cursor 与源文件最终一致。

## 实施顺序

1. 先修 `WatchTarget` 类型和 file-root 分流；这是已知正确性问题。
2. 增加 `watchHints` 与 bounded async stat poller，只在 macOS 为 hot transcripts 启用；精确 file targets 可全平台启用。
3. 跑完 Linux/Windows 长期 open writer 矩阵后，再决定是否全平台启用 hot polling。Windows 官方缓存语义意味着保留跨平台开关更稳妥。
4. 保留现有 Parcel retry、changed-path debounce 和 5 分钟 reconcile。
5. 只有测量表明 polling 不达标时，才设计 exact-file kqueue native overlay；不做全树 kqueue。

## 最终判断

“better chokidar”如果仍试图对所有文件提供完全实时、跨平台、递归语义，就无法绕开底层权衡：FSEvents 低资源但本次 workload 有实时缺口；kqueue 精确但每个目标需要 fd；全树 polling 没有 fd 灾难但 I/O 随全树增长。

Obelisk 能做得更好的原因不是写出一个新的通用 watcher，而是它知道哪些文件可能正在写。把这一领域信息变成 bounded hot set，配合 Parcel 的低资源目录覆盖和低频 full reconcile，能以最小改动解决已经实际复现的问题。
