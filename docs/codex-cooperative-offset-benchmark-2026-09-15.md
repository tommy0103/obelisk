# Codex cooperative-offset：本机 Top 5 rollout 性能结果

> **注**：本文是一次 warm-cache 单次运行的结果，未包含测量波动性与 main 基线。完整的重复采样协议、离散度统计与 main（改动前）对比见 `docs/codex-cooperative-offset-benchmark-2026-09-17.md`；本文的 "31.9×" 在该协议下修正为 cooperative vs verified 中位数比 43–67×、cooperative vs main 中位数比 240–481×。

- **日期**：2026-09-15
- **输入**：本机按文件大小排序的前 5 个真实 Codex rollout；输入仅被复制到系统临时目录进行测试，未上传、未加入 Git，也未在本文记录路径、文件名、thread id 或内容。
- **负载**：每个输入先完整 index 一次；随后追加相同的 262 B 完整 JSONL 行，并各跑一次 cooperative 与 strict（verified）增量 index。
- **运行方式**：

  ```sh
  node --experimental-strip-types scripts/bench-codex-cooperative-offset.mjs \
    --source <top-5-real-rollout> ...
  ```

- **说明**：数字是一次本机内存 SQLite 运行结果，包含 warm-cache 影响；用于验证 I/O 复杂度和两种计划的量级差异，不是跨机器吞吐基准。

| 匿名输入 | 大小 (MiB) | cooperative 读取 (MiB) | cooperative 总耗时 (ms) | verified 读取 (MiB) | verified 总耗时 (ms) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 169.1 | 0.000 | 1.57 | 169.102 | 69.25 |
| 2 | 110.0 | 0.000 | 1.41 | 109.962 | 48.39 |
| 3 | 100.0 | 0.000 | 1.34 | 99.978 | 46.69 |
| 4 | 88.7 | 0.000 | 2.05 | 88.661 | 40.87 |
| 5 | 84.8 | 0.000 | 1.26 | 84.796 | 38.10 |

所有 cooperative case 都选择 `cooperative-append`，所有 strict case 都选择 `verified-append`。每次增量解析均消费相同 262 B suffix：两遍 suffix scan 合计 0.256 KiB、2 条 JSONL、2 个 canonical records。

## 汇总

- cooperative 平均总耗时：**1.53 ms**
- verified 平均总耗时：**48.66 ms**
- 在此固定 262 B suffix 负载下，cooperative 平均总耗时约为 verified 的 **31.9× 更快**。
- cooperative source read 维持在 suffix 两遍扫描的量级；verified source read 随 rollout 历史大小线性增长。
