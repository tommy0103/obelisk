# Codex cooperative-offset：完整性能测量（重复采样 + 离散度 + main 基线）

- **日期**：2026-09-17
- **目的**：补齐 2026-09-15 单次运行报告所缺的测量波动性与改动前（main）对比。CONTRIBUTING 性能章节要求报告 workload 大小与测量波动性并对比改动前后；RFC #172 的证据清单同样要求 variability。
- **输入**：本机按文件大小排序的前 5 个真实 Codex rollout；输入仅被复制到系统临时目录进行测试，未上传、未加入 Git，也未在本文记录路径、文件名、thread id 或内容。
- **负载**：每个（输入 × 模式）先完整 index 一次建立 checkpoint；随后连续追加 8 次相同的 262 B 完整 JSONL 行。第 1 次作为预热丢弃，后 7 次为采样；每次采样分别计时 parse 与 persist（内存 SQLite）。
- **模式**：
  - `cooperative`：normal read mode，本 PR 的快路径；
  - `verified`：strict read mode，#148 的验证路径；
  - `snapshot`：本构建上以无状态的 legacy cursor 强制全量重放，即本 PR 的回退路径；
  - `main`：在 origin/main worktree（`3b227ab`；`codex.ts`/`persist.ts`/`schema.sql` 与本 PR 的 rebase 基准 `99880d7` 完全一致）中运行同一脚本的 `--main-compat` 模式，测量未改动 adapter 的行为：每次 append 全量读取并全量重发。
- **统计**：对 7 个采样报告中位数、均值±样本标准差、CV（标准差/均值）、min/max。
- **环境声明**：单机、warm-cache、内存 SQLite；只计时 parse+persist，不含 discovery、watcher、FTS finalize 等端到端成本；`main` 的读取字节数未插桩（其代码路径固定为每次完整读取一遍）。测量协议代码在 `scripts/bench-codex-cooperative-offset.mjs`（`--samples`、`--main-compat`）。

## 结果：每次 append 的总耗时（parse + persist）

| 匿名输入 | 大小 (MiB) | main (ms) | cooperative (ms) | verified (ms) | snapshot 本构建回退 (ms) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 169.1 | 466.22 | 0.97 | 64.78 | 847.25 |
| 2 | 110.0 | 298.74 | 0.75 | 49.27 | 548.30 |
| 3 | 100.0 | 303.60 | 0.75 | 44.75 | 1182.66 |
| 4 | 88.7 | 187.78 | 0.72 | 37.32 | 834.76 |
| 5 | 84.8 | 211.34 | 0.88 | 37.78 | 419.23 |

（表中为中位数。）

## 离散度

| 匿名输入 | main CV% | cooperative CV% | verified CV% | snapshot CV% |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 3.9 | 59.3 | 4.0 | 9.0 |
| 2 | 6.3 | 13.7 | 4.6 | 3.3 |
| 3 | 1.2 | 32.0 | 7.9 | 1.3 |
| 4 | 2.9 | 12.2 | 3.6 | 4.5 |
| 5 | 2.8 | 6.9 | 7.4 | 3.9 |

cooperative 均值±标准差依次为 1.28±0.76、0.80±0.11、0.83±0.27、0.75±0.09、0.91±0.06 ms：亚毫秒测量的固有噪声使 CV 偏高（最大单次离群 2.99 ms），中位数稳定在 0.72–0.97 ms。verified 均值±标准差为 65.43±2.58、49.89±2.31、45.91±3.63、37.86±1.36、38.84±2.89 ms。main 均值±标准差为 465.10±18.22、305.09±19.32、304.44±3.54、187.97±5.46、213.73±5.97 ms。

## 读取量与产出

- cooperative：每次采样只读 suffix 两遍（合计 0.256 KiB）、解析 2 条 JSONL、产出 2 条 canonical records（1 条 message + 1 条 session 聚合），与 rollout 历史大小无关。
- verified：每次采样读取完整 prefix 一遍做指纹校验（读取量 ≈ 文件大小），产出同上。
- snapshot：每次采样读取完整文件 **3 遍**（fingerprint 一遍 + 预扫描一遍 + 发射一遍），并全量重发整个 canonical 流（含 delete-session），读取量 ≈ 3× 文件大小。
- main：每次采样完整读取一遍（代码路径确定，未插桩）并全量重发整个 canonical 流。

## 对比

- **cooperative vs main（真正的 before/after）**：中位数比值 **240–481×**。
- **cooperative vs verified（两条新路径之间）**：中位数比值 **43–67×**。
- 2026-09-15 报告中的 "31.9×" 是单次 warm-cache 运行下 cooperative 与 verified 的均值比；在重复采样下，同一对比的中位数比为 43–67×，而以 main 为基线的改动前后对比为 240–481×。后者才是本 PR 对默认行为的影响幅度。

## 诚实的负面发现

1. **本构建的 snapshot 回退路径比 main 的全量重扫更贵**（中位数 1.8–4.4×）。原因有二：读取上是 3 遍全量（fingerprint、预扫描、发射）对比 main 的 1 遍；持久化上 snapshot 先发 `delete-session` 再全量重插，代价随文本量增长（同记录量下 persist 中位数最高 533 ms，而 main 为 44 ms；main 的 upsert 语义更便宜）。该路径只在回退场景（首次索引、重写/替换、修复）执行，普通 append 不经过它；但它意味着本 PR 修好前的"最坏情况"比 main 的最坏情况更慢，值得后续单独优化（例如 snapshot 时跳过 fingerprint，或合并预扫描与发射遍）。
2. cooperative 的亚毫秒测量噪声高（CV 最高 59.3%）：报告以中位数为准，单次采样不适合作为结论依据——这正是 09-15 单次运行报告的问题所在。

## 局限

- 单机、warm-cache；cold-cache 与跨机器测量仍开放（RFC #172 open question 4）。
- 不含 daemon/discovery/FTS finalize/事务重试等端到端成本。
- `main` 的读取字节数未插桩，按代码路径陈述。
