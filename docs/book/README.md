# Obelisk 架构解读

给 coding agent 造一层可查询的记忆。

这本书从代码出发，讲清楚 Obelisk 这套东西是怎么搭起来的：它承诺什么、拒绝什么、支点在哪里、被什么力量反复挤压。

> **基线：v0.2.2**
>
> 全书对应 v0.2.2 的三源架构（Claude Code / Codex / Kimi Code）。v0.2.2 之后 main 上合入了第四个 provider（Pi，PR #23），以及一次把 `createRequire` 换成具名 ESM import 的重构（PR #31）——**这两项都不在本书覆盖范围内**。
>
> 因此读到"三个来源""三个适配器"时，请理解为"截至 v0.2.2 的三个"。第 15 章那句"加第四个来源，这里加一行"在 main 上已经被真实兑现了一次，可以拿 `packages/core/src/providers/pi.ts` 对照阅读。

## 读者假设

你会读 TypeScript，知道 SQLite 是什么，用过至少一个 coding agent（Claude Code、Codex、Kimi Code 之类）。你不需要事先了解本仓库。

## 组织方式

**整体 → 局部 → 横切。**

第一部分建立对整个系统的正确认知，不碰实现。第二部分逐个部件展开，顺序是依赖顺序——每章只依赖它前面的章。第三部分处理那些不属于任何单一部件的问题。

### 第一部分 · 整体

读完这四章，你应该能凭记忆把这个系统画出来。

1. [它是什么：显式记忆与四个动词](01-what-it-is.md)
2. [系统由什么组成：模块地图与依赖方向](02-module-map.md)
3. [三条路径：写入、检索、展示](03-three-paths.md)
4. [支点：canonical record 与两条正交轴](04-the-pivot.md)

### 第二部分 · 局部

5. [数据层：schema 与三类表](05-data-layer.md)
6. [Provider 契约：discover / parse / cursor](06-provider-contract.md)
7. [三个适配器：行增量、全量重解析、目录投影](07-three-adapters.md)
8. [persist：唯一碰数据库的层](08-persist.md)
9. [编排：一次 build 的完整生命周期](09-orchestration.md)
10. [CodeAct 运行时：沙箱、helper 与只读边界](10-codeact-runtime.md)
11. [记忆层：attune、remember、forget](11-memory-layer.md)
12. [展示轴：session-detail 与桌面 App](12-presentation.md)

### 第三部分 · 横切

13. [并发与所有权：心跳、租约、事务](13-concurrency.md)
14. [增量与重放：游标、版本标记、force rebuild](14-incremental-replay.md)
15. [扩展与边界：加一个 provider、尚未完成的部分](15-extension-and-limits.md)

**[附录 A · 动手与代码导航](appendix-a-hands-on.md)** — 装起来、跑第一条查询、带着问题查表、以及三条不会被编译器拦住的规矩。

## 体例

正文只讲从代码里能读出来的东西。每章末尾可能有一个 **「当时」** 方块，用真实的历史会话记录回答"这里为什么不写得更简单一点"。它是脚注，不是主线；没有可靠史料的章节不放。

代码引用统一写成 `文件:行号` 的形式，指向仓库中的真实位置。行号会随代码演进漂移，以文件内容为准。
