// Case sets for the RuleQuiz widget.
//
// Each case is a proposed change to the codebase. The reader picks which rule
// it breaks (or "nothing — this is fine"), and gets the consequence back. The
// cases that are FINE matter as much as the violations: a rule you can only
// apply by refusing everything is not a rule, it is a superstition.

export const QUIZ_SETS = {
  // 第 2 章 · 三条依赖规则
  deps: {
    prompt: '下面每个改动，破坏了哪一条依赖规则？',
    verdicts: [
      { id: 'r1', label: '规则一', text: '适配器从不打开数据库' },
      { id: 'r2', label: '规则二', text: 'persist 从不知道 provider 是谁' },
      { id: 'r3', label: '规则三', text: 'CLI 和 App 从不实现检索' },
      { id: 'ok', label: '没问题', text: '这个改动不破坏任何规则' },
    ],
    cases: [
      {
        code: "// providers/claude.ts\nimport { DatabaseSync } from 'node:sqlite';",
        verdict: 'r1',
        why: 'Electron 打包的 Node 运行时里没有 `node:sqlite`。加上这一行之后 CLI 一切正常，App 侧在运行时崩——而且测试如果不覆盖 Electron 环境也发现不了。',
      },
      {
        code: "// persist.ts\nswitch (r.kind) {\n  case 'message':\n    if (r.source === 'codex') st.msgCodex.run(...);\n    else st.msg.run(...);",
        verdict: 'r2',
        why: '`persist.ts` 的 switch 只能分派 `record.kind`。`source` 在整个文件里只作为一个列值出现，被原样写进表里——这就是"加一个新来源，persist 一个字都不用改"的全部原因。',
      },
      {
        code: "// app/src/main/session-query.ts\nfunction assembleTimeline(rows) {\n  // App 自己的时间线组装，因为它用 better-sqlite3\n  ...\n}",
        verdict: 'r3',
        why: 'App 有充分的理由自己写一套——它用的是另一个 binding。但它直接 import Core 的源码，自己只贡献一个 handle。展示侧那个 shim 一共九行，其中三行是注释。',
      },
      {
        code: "// providers/kimi.ts\nconst meta: KimiSessionUnitMeta = {\n  sessionDir, statePath, wireFiles, currentCursor,\n};\nreturn [{ key: sessionDir, sessionId, meta }];",
        verdict: 'ok',
        why: '这是契约的正常用法：`IndexUnit` 不是文件，`meta` 是 discover 到 parse 的私有通道，编排层原样传回、绝不检查内容。Kimi 以整个目录为单元正是这条克制的兑现。',
      },
      {
        code: "// session-detail.ts\nif (record.source === 'codex' && /^<environment_context/.test(text)) {\n  break;  // 跳过 Codex 注入的环境上下文\n}",
        verdict: 'r2',
        why: '这是一条从展示侧指回 provider 轴的回边。识别信封属于适配器（只有它知道 Codex 用什么信封），展示层拿到的应该是已经判好的 `visibility` 字段。这条回边真实存在过，第 4 章讲了它是怎么被拆掉的。',
      },
      {
        code: "// parsing.ts\nimport { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\nimport { homedir } from 'node:os';",
        verdict: 'ok',
        why: '`parsing.ts` 允许的 import 正好是这些。它一行 SQLite 都不碰——不是"最好不碰"，是"碰了 App 就在运行时炸"。',
      },
      {
        code: "// packages/cli/src/obelisk.ts\nconst rows = db.prepare('SELECT * FROM messages WHERE text LIKE ?').all(q);",
        verdict: 'r3',
        why: 'CLI 是 71 行，全是转发。它读文件、交给 Core、把结果 JSON 打到 stdout——全程不含检索逻辑。',
      },
      {
        code: "// providers/codex.ts\nyield { kind: 'delete-session', sessionId: codexDbId(threadRawId) };",
        verdict: 'ok',
        why: '适配器不去操作数据库，它只是"说"这个 session 应该消失，persist 收到后执行级联删除。撤回因此和插入一样，是共同语言里的一等公民。',
      },
    ],
  },

  // 第 6 章 · 契约禁止什么
  contract: {
    prompt: '一个适配器可以这么做吗？',
    verdicts: [
      { id: 'no', label: '禁止', text: '契约不允许' },
      { id: 'ok', label: '允许', text: '契约允许，甚至鼓励' },
    ],
    cases: [
      {
        code: '// 我的 parse 假设它一定被完整调用，\n// 所以第二个单元可以依赖第一个单元已经写好的行。',
        verdict: 'no',
        why: '单元之间无序，而且任何一个单元都可能失败被跳过、下次从旧游标重来。任何一个单元都必须假设自己可能第一个跑、也可能最后一个跑——这正是"大量可选字段 + `COALESCE` 合并"存在的原因。',
      },
      {
        code: "// 我读一下 Claude 适配器存的游标，\n// 因为我的 session 目录里也有它的转写。\nconst n = Number(claudeCursor.split(':')[1]);",
        verdict: 'no',
        why: '游标语义是私有的：产出它的适配器是唯一能解释它的人。同一个 `"数字:数字"` 在三个适配器里是三种完全不同的含义。',
      },
      {
        code: "yield { kind: 'thinking_block', text: '...' };",
        verdict: 'no',
        why: '共同语言是封闭的。`persist.ts` 的 switch 末尾有一个 `default: throw`——这个单元的事务会回滚、游标不前进、记录到 `skippedFiles`。不会静默丢数据，但也不会成功。',
      },
      {
        code: '// 我的来源没有 workflow 概念，\n// 所以我一条 workflow 记录都不产出。',
        verdict: 'ok',
        why: '没有的概念就不产出。Codex 没有 workflow，那两张表对它就是空的——这是语义映射清单的正常结果，不是缺陷。',
      },
      {
        code: "// discover 的时候把整个目录清单算好，\n// 塞进 unit.meta 里传给 parse。",
        verdict: 'ok',
        why: '`meta` 就是为此存在的逃生口：discover 和 parse 之间的私有通道，编排层对通道里的东西一无所知。',
      },
      {
        code: "// 我的 raw() 直接去 ~/.claude 里找那一行，\n// 因为用户两个 agent 都在用。",
        verdict: 'no',
        why: '`raw()` 按 `source` 分派，每个适配器只负责定位自己的原始行。跨到别人的目录里去，就是把一种来源的目录约定泄漏给了另一个适配器。',
      },
    ],
  },

  // 第 15 章 · 六个容易踩的坑
  pitfalls: {
    prompt: '接一个新来源时，下面哪些做法会出事？',
    verdicts: [
      { id: 'bug', label: '会出事', text: '而且多半是静默地出事' },
      { id: 'ok', label: '没问题', text: '这是正确做法' },
    ],
    cases: [
      {
        code: "// 我的 session id 就用来源里的原始 id，\n// 反正它是个 UUID，不会撞。\nconst sessionId = raw.id;",
        verdict: 'bug',
        why: 'ID 必须带来源前缀（`foo:<id>`）。三个来源共用一个主键空间而不会撞，靠的就是这个前缀——代价只是 ID 里多几个字符。',
      },
      {
        code: '// 解析逻辑改了一版，修好了一类误判。\n// 代码是对的了，直接发布。',
        verdict: 'bug',
        why: '数据库里躺着的还是旧逻辑解析出来的行。改了解析语义就必须升 `indexVersionMarker`，否则老数据不会被重放——而且不会有任何报错。',
      },
      {
        code: "// 这条消息看着像注入的传输上下文，\n// 我先原样写进去，展示层用正则判断一下。",
        verdict: 'bug',
        why: '`visibility` 要自己判断完。展示层里那个正则在适配器里是对的，在展示层就是错的——而且每加一个来源，猜错的方式就多一种。',
      },
      {
        code: "// 我的来源是纯追加的、逐行独立，\n// 所以走行增量，countMode 报 'delta'。",
        verdict: 'ok',
        why: '判据就是"解析某一部分时是否需要看到其他部分"。纯追加、逐行独立 → 可以增量。选定之后 `countMode` 跟着定：增量报 `delta`，全量报 `total`。',
      },
      {
        code: '// 索引里的文本被截断到 10k 了，\n// 需要全文的时候让调用方自己去读文件。',
        verdict: 'bug',
        why: '`raw()` 必须由适配器实现——只有它知道怎么定位那一行。有损索引 + 可回源，合起来才是完整的证据层。',
      },
    ],
  },
};
