// Per-chapter site metadata: which modules a chapter covers (drives the rail
// minimap) and its end-of-chapter self-check.
//
// Prose, titles and headings come from the markdown (virtual:book). Nothing
// here duplicates that — this file only holds what the site adds.
//
// Questions are drawn from each chapter's own 「你应该带走的」 recap. They are
// not trivia: each one targets a claim a reader could plausibly get backwards.

export const CHAPTER_META = {
  intro: {
    covers: ['types', 'cli', 'app', 'skill'],
    hook: '这本书讲什么、怎么读、基线是哪个版本。',
    quiz: [],
  },

  '01-what-it-is': {
    covers: ['cli', 'app', 'skill', 'sqlite'],
    hook: '四个动词、显式记忆，以及它明确拒绝做的那一层。',
    quiz: [
      {
        q: 'Obelisk 明确**不做**三层记忆里的哪一层？',
        options: [
          '第一层 · 隐式记忆——自动注入上下文、静默影响 agent 行为',
          '第二层 · 可查询的会话记忆——agent 主动查询原始证据',
          '第三层 · 人类批准的长期记忆——markdown + 注册表',
        ],
        answer: 0,
        why: '这不是"少做了一层"，是一个立场：coding agent 的记忆不应该默认是黑盒。代价被摆到明处——查询要花当前 agent 的 context，这个成本变成可见成本。',
      },
      {
        q: '`search()`、`overview()`、`memories()` 这些 helper 属于公共接口吗？',
        options: [
          '不属于——它们只存在于 `query(code)` 的沙箱内部，从不被提升为对外的工具',
          '属于——它们和四个动词一样是公共 API',
          '部分属于——`search()` 是公共的，其余不是',
        ],
        answer: 0,
        why: '一旦把 helper 摊开成一组外部 tool，Obelisk 就从"记忆运行时"退化成"普通检索插件"。`--search` 是 `query` 的一个便捷特例，不是独立能力。',
      },
    ],
  },

  '02-module-map': {
    covers: ['types', 'p-claude', 'p-codex', 'p-kimi', 'persist', 'session-detail', 'query', 'cli', 'app', 'skill'],
    hook: '四个产物、六组模块、三条不可越界的依赖规则。',
    quiz: [
      {
        q: '为什么 provider 适配器绝对不能 `import { DatabaseSync } from "node:sqlite"`？',
        options: [
          'Electron 打包的 Node 运行时里没有 `node:sqlite`，App 会在运行时崩',
          '会造成循环依赖',
          '性能问题——SQLite 的初始化很慢',
        ],
        answer: 0,
        why: '这条约束没有类型系统保护，全靠人守。违反它之后 CLI 一切正常，只有 App 侧在运行时炸——而且测试如果不覆盖 Electron 环境也发现不了。',
      },
      {
        q: 'App 用的是 better-sqlite3，Core 用的是 node:sqlite。这个差异是怎么被抹平的？',
        options: [
          'Core 不选 binding，它**接收** binding——调用方传进一个 handle',
          'Core 里有两份实现，按运行环境分派',
          'App 自己重新实现了一遍索引逻辑',
        ],
        answer: 0,
        why: '两个 binding 的 `prepare / run / get / all` 是同一套形状。关键在于这是"一个实现 + 两个薄适配器"，不是"两个实现"——写语义只有一份，不可能再次分叉。',
      },
    ],
  },

  '03-three-paths': {
    covers: ['p-claude', 'p-codex', 'p-kimi', 'types', 'persist', 'session-detail', 'query', 'sqlite'],
    hook: '写入、检索、展示三条路径穿过同一张图，交在同一个点上。',
    quiz: [
      {
        q: '"同步索引"是一个独立的动作吗？',
        options: [
          '不是——索引新鲜度是查询的副作用，三个动词的入口第一句都是 `buildIndex()`',
          '是——需要先跑 `--build` 再查询',
          '是——App 在后台单独跑同步',
        ],
        answer: 0,
        why: '写入和检索两条路径是**嵌套的**，不是并列的。检索路径每次都会先把写入路径跑一遍。',
      },
      {
        q: '`assembleSessionDetail` 怎么知道一条消息该不该显示？',
        options: [
          '读适配器已经算好的 `visibility` 字段——它一次都不检查 `source`',
          '用正则匹配文本特征判断',
          '按 `source` 分支，每个来源一套规则',
        ],
        answer: 0,
        why: '所有来源特有的语义在解析阶段就已经被适配器消化掉了。展示层不需要猜，也不允许猜——出现 `if (source === ...)` 就是从展示侧向 provider 轴画了一条回边。',
      },
    ],
  },

  '04-the-pivot': {
    covers: ['types'],
    hook: '一个没有运行逻辑的类型定义，决定了整个系统的形状。',
    quiz: [
      {
        q: '`MessageTurnDurationRecord` 和 `DeleteSessionRecord` 为什么不对应任何一张表？',
        options: [
          '它们不是"有什么"，是"发生了什么变化"——一次定点更新和一次撤回',
          '它们是历史遗留，已经废弃',
          '它们对应的表还没实现',
        ],
        answer: 0,
        why: '如果共同语言只能表达"这里有一条消息"，那么"耗时后来才知道"和"这段历史被撤销了"就只能靠适配器自己去动数据库——而那正是规则一禁止的。',
      },
      {
        q: '加一个来源、加一个消费者，工作量是多少？',
        options: [
          'N + M —— 两条轴正交，加来源不影响消费者，加消费者不影响适配器',
          'N × M —— 每个消费者都要认识每个来源',
          '取决于来源的复杂度',
        ],
        answer: 0,
        why: '这不是理论上的漂亮话：接第三个来源 Kimi 时的硬约束是"不改 schema、不加 record 类型"，而 App 作为第二个消费者接进来时，`persist.ts` 一行没改。',
      },
    ],
  },

  '05-data-layer': {
    covers: ['sqlite', 'persist'],
    hook: '十张表按"能不能重建"分成三类，这个分法有执行后果。',
    quiz: [
      {
        q: 'force rebuild 清哪些表？',
        options: [
          '只清八张证据表——`memories` 是人批准的产物，连重建索引都不许动它',
          '清全部十张表',
          '只清 `index_state`',
        ],
        answer: 0,
        why: '强制重建的语义是精确的：把所有能从源文件重新算出来的东西扔掉重算，绝不碰那些算不出来的东西。',
      },
      {
        q: '93 行 schema 里一个 `FOREIGN KEY` 都没有，为什么？',
        options: [
          '因为"部分到达"是常态——一行可能由两个独立单元在任意顺序下拼成',
          '因为 SQLite 默认不启用外键',
          '因为性能考虑',
        ],
        answer: 0,
        why: '这是个明确的取舍：放弃数据库层的完整性保证，换取乱序写入的能力。代价是 `deleteSession()` 要用八条 DELETE 手写级联。',
      },
    ],
  },

  '06-provider-contract': {
    covers: ['p-claude', 'p-codex', 'p-kimi', 'registry', 'types'],
    hook: '六个成员、一个不透明的游标，以及"纯"的三层含义。',
    quiz: [
      {
        q: '`parse` 为什么被设计成"返回游标的生成器"而不是返回数组的函数？',
        options: [
          '记录边产出边写入，而且游标和记录天然在同一个事务里',
          '为了支持异步解析',
          '为了让代码更短',
        ],
        answer: 0,
        why: 'TypeScript 的 `Generator<T, TReturn>` 正好表达这件事。于是不可能出现"记录写了一半但游标已经前进"的状态——这个原子性由类型保证，不靠约定。',
      },
      {
        q: '游标"完全不透明"这句话有折扣吗？',
        options: [
          '有——编排层假设它是 `"数字:数字"`，因为要拆进 `index_state` 的两个数值列',
          '没有，编排层完全不碰它的内容',
          '有——编排层会解析出 mtime 来做比较',
        ],
        answer: 0,
        why: '真实的约束是"内容语义不透明，但格式是一对数字"。知道抽象在哪里有折扣，比假装它没有折扣更有用。',
      },
    ],
  },

  '07-three-adapters': {
    covers: ['src-claude', 'src-codex', 'src-kimi', 'p-claude', 'p-codex', 'p-kimi'],
    hook: '同一份契约，三种对"增量"完全不同的理解。',
    quiz: [
      {
        q: 'Codex 为什么不能做行增量？',
        options: [
          '`event_msg` ↔ `response_item` 的去重需要整个文件的双向视野',
          'Codex 的文件太小，增量没意义',
          'Codex 的记录没有行号',
        ],
        answer: 0,
        why: '配对的两条挨着但顺序不定。如果被切在增量边界的两侧，去重就失效，同一条消息会入库两次。ID 用行号合成也和全量重解析互为前提。',
      },
      {
        q: 'Kimi 每次 parse 的第一条产出是什么？',
        options: [
          '`delete-session` —— 先把这个 session 在库里的一切删掉，再重新写一遍',
          '`session` 记录',
          '第一条消息',
        ],
        answer: 0,
        why: '这是"全量替换"在共同语言里的表达方式，而它之所以安全，是因为解析、删除、重写、写游标全在同一个事务里。`DeleteSessionRecord` 的注释只提到撤回场景——Kimi 用它实现了更强的语义：幂等的整体替换。',
      },
    ],
  },

  '08-persist': {
    covers: ['persist', 'sqlite', 'types'],
    hook: '153 行，唯一碰数据库、唯一知道 schema 的层。',
    quiz: [
      {
        q: '`messages` 的 upsert 列清单里为什么故意漏掉 `turn_duration_ms`？',
        options: [
          '否则 Codex / Kimi 的每次全量重解析都会把已经写入的耗时清成 NULL',
          '因为那一列已经废弃',
          '因为它是自动计算的',
        ],
        answer: 0,
        why: '一条 SQL 语句的列清单，编码了"这张表的某一列由另一种记录负责"这个事实。这种知识没有类型系统保护——手滑加上它，耗时数据会开始莫名其妙地丢。',
      },
      {
        q: 'persist 自己开事务吗？',
        options: [
          '不开——它假设调用方已经在事务里了',
          '开——每个 record 一个事务',
          '开——每个 unit 一个事务',
        ],
        answer: 0,
        why: '职责分离得很干净：persist 管写什么，调用方管什么时候提交。`provider-indexing.ts` 把 `parse` + `persist` 整个包在一次 `runTransaction` 里。',
      },
    ],
  },

  '09-orchestration': {
    covers: ['orchestration', 'p-claude', 'p-codex', 'p-kimi', 'persist', 'sqlite'],
    hook: '七步、三档失败降级，以及唯一不许失败的那一步。',
    quiz: [
      {
        q: '某个单元解析失败了，会发生什么？',
        options: [
          '记下来、警告一句、继续下一个——它的游标没前进，下次自然重来',
          '整次构建失败',
          '进入一个重试队列，稍后重试',
        ],
        answer: 0,
        why: '不需要独立的重试队列、失败列表或退避表：失败自然导致游标停滞，游标停滞自然导致重试。**游标本身就是重试机制。**',
      },
      {
        q: '收尾（finalize）失败会被降级成"跳过"吗？',
        options: [
          '不会——半完成的收尾意味着不一致的索引，宁可整次构建报失败',
          '会，和逐单元阶段一样',
          '会，但会打一条警告',
        ],
        answer: 0,
        why: '收尾做的是全局性的工作：FTS 重建到一半、项目路径回填到一半，索引就处于自相矛盾的状态。逐单元阶段容忍失败，收尾阶段不容忍。',
      },
    ],
  },

  '10-codeact-runtime': {
    covers: ['core', 'query', 'sqlite'],
    hook: '八行沙箱、16 个 helper，以及为什么不是一组工具。',
    quiz: [
      {
        q: '沙箱白名单里没有 `fs`、没有 `fetch`、没有 `process`。这主要是为了防恶意吗？',
        options: [
          '不是——脚本是 agent 自己写的。它把"查询"这个动作钉死成一个纯函数',
          '是——防止 agent 读取敏感文件',
          '是——防止脚本把数据发到外部',
        ],
        answer: 0,
        why: 'agent 本来就有 shell 权限。净效果是：重跑一定得到相同结果，不可能有副作用，出问题时可能性空间只有"这段 SQL 写错了"。',
      },
      {
        q: '`--attune` 的沙箱里为什么连 `search()` 都没有？',
        options: [
          '记忆写入需要人批准，脚本必须短到人能一眼看完',
          '技术限制——两套 API 不能共存',
          '疏忽，还没来得及加',
        ],
        answer: 0,
        why: '这个不便是刻意的。如果 attune 沙箱里有完整的检索能力，一段"写记忆"的脚本可以长成任意复杂的程序，人就没法审了。要查就先用 `--query` 查出 ID，再用 `--attune` 提交一段窄脚本。',
      },
    ],
  },

  '11-memory-layer': {
    covers: ['core', 'query', 'sqlite'],
    hook: '记忆 = markdown 文件 + 注册记录；忘记是归档，不是删除。',
    quiz: [
      {
        q: '`remember()` 要求 markdown 文件必须**已经存在**，为什么？',
        options: [
          '因为 attune 沙箱不能写文件——于是内容批准被强制发生在一次普通的文件写入上',
          '为了避免竞态',
          '为了校验文件格式',
        ],
        answer: 0,
        why: '沙箱不给 `fs`，不只是安全考虑，也是产品设计：内容以用户已经熟悉的批准界面呈现。如果 attune 能自己写文件，记忆正文就会藏在一段 JS 字符串里，审查体验会差很多。',
      },
      {
        q: '为什么没有 `update()`？',
        options: [
          '更新 = `forget()` 归档 + `remember()` 新写，让认知的演变留痕',
          '还没实现',
          '因为 markdown 文件可以直接改',
        ],
        answer: 0,
        why: '原地更新会抹掉"曾经我们认为是 X，后来改成了 Y，理由是 Z"这条线索。对一个专门做"记录结论"的系统来说，它自己对结论变更的处理方式，应该和它推荐给用户的一样。',
      },
    ],
  },

  '12-presentation': {
    covers: ['session-detail', 'types', 'app', 'sqlite'],
    hook: '同一份记录如何走向人眼，以及为什么数据库行要先转回记录语言。',
    quiz: [
      {
        q: '从 SQLite 查回来的行为什么要先被转回 `TranscriptRecord`，而不是直接组装？',
        options: [
          '为了让两条路径在类型上就是同一条，不可能漂移',
          '为了代码复用',
          '为了类型安全',
        ],
        answer: 0,
        why: '如果各走一套组装逻辑，某个 bug 只在其中一条上被修复，从此就分家了——而且很难发现，因为两条路径通常不会被同时用来渲染同一个会话。',
      },
      {
        q: '实时补丁的指纹为什么要把**位置**也算进去？',
        options: [
          '一条消息因为新数据插入而前移时，渲染层必须知道——只比内容的话界面顺序会错',
          '为了防止哈希碰撞',
          '为了排序稳定',
        ],
        answer: 0,
        why: '指纹是 `位置 + 内容哈希`。内容哈希用的是双 FNV 变体，不是加密哈希——这里只需要检测变化，不需要抗碰撞。',
      },
    ],
  },

  '13-concurrency': {
    covers: ['write-infra', 'persist', 'sqlite', 'app', 'cli'],
    hook: '五种写者抢一个文件；心跳表达政策，租约保证互斥。',
    quiz: [
      {
        q: '把 `busy_timeout` 调大能解决并发问题吗？',
        options: [
          '不能——`SQLITE_BUSY_SNAPSHOT` 是"快照过期"，等再久也不会自己更新',
          '能，这是最简单的修复',
          '能，但会影响性能',
        ],
        answer: 0,
        why: '还有第二个理由：只重试失败的那条语句会重放事务的一部分，得到一个谁也没设想过的中间状态。正确解法是整个事务重来。',
      },
      {
        q: '拿到写者租约之后，为什么还要**再检查一次**心跳？',
        options: [
          '关闭 TOCTOU 窗口——在"判断没有 daemon"和"真的拿到锁"之间，App 可能刚好启动了',
          '为了确认租约有效',
          '为了记录日志',
        ],
        answer: 0,
        why: '这个模式在 `buildIndex` 和 `executeAttune` 两个写入口各实现了一遍，因为它们的后续动作不同，但检查顺序必须一致。',
      },
    ],
  },

  '14-incremental-replay': {
    covers: ['orchestration', 'p-claude', 'p-codex', 'p-kimi', 'sqlite'],
    hook: '三层"重新来过"，代价递增、覆盖递增，前两层全自动。',
    quiz: [
      {
        q: '改了某个适配器的解析语义，正确的动作是什么？',
        options: [
          '把 `indexVersionMarker` 的版本号 +1，触发这个来源的整源重放',
          '写一个数据迁移脚本，把旧行按新语义转换',
          '让用户手动 force rebuild',
        ],
        answer: 0,
        why: '源文件还在，索引只是投影——所以正确的动作不是修改数据，而是扔掉重算。这是"索引可完全重建"这个立场带来的直接红利。Kimi 已经用到 v4，另外两个还停在 v2。',
      },
      {
        q: 'force rebuild 为什么必须清表，而不能只清游标？',
        options: [
          '只清游标解决不了幽灵行——源文件已经消失的 session，它的行再也不会被任何单元覆盖到',
          '因为清游标太慢',
          '因为游标和表数据不同步',
        ],
        answer: 0,
        why: '这是增量索引的固有盲区：它只能表达"更新"和"新增"，表达不了"这个东西不在了"。',
      },
    ],
  },

  '15-extension-and-limits': {
    covers: ['registry', 'p-claude', 'p-codex', 'p-kimi', 'types'],
    hook: '加一个来源要动两个文件；以及这套架构现在已知的不足。',
    quiz: [
      {
        q: '接一个新来源，需要改动哪些文件？',
        options: [
          '两个：新建 `providers/<name>.ts`，在 `builtins.ts` 里加一行',
          '大约十个，包括 schema 和 persist',
          '五个：适配器、schema、persist、session-detail、query',
        ],
        answer: 0,
        why: '这不是理论承诺，是第 7 章那次验证的结论——Kimi 是一个数据模型完全不同的来源，接入时的硬约束就是"不改 schema、不加 record 类型"，而它做到了。',
      },
      {
        q: '这份代码里最脆的地方是什么？',
        options: [
          '三条没有类型保护的约束：SQLite-free、upsert 列清单、`fullReindex` 时清空 `changedPaths`',
          '并发写入的性能瓶颈',
          '游标格式的折扣',
        ],
        answer: 0,
        why: '违反它们不会有编译错误，只会静默地出错：App 在运行时崩、耗时数据莫名其妙地丢、完整重放悄悄退化成增量更新。它们现在靠注释和人的记忆维持。',
      },
    ],
  },

  'appendix-a': {
    covers: ['cli', 'core', 'query'],
    hook: '装起来、跑第一条查询、带着问题查表。',
    quiz: [],
  },
};

export const chapterMeta = (slug) => CHAPTER_META[slug] || { covers: [], hook: '', quiz: [] };
