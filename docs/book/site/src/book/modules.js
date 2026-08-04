// The module graph, drawn once and reused everywhere.
//
// This is the book's ASCII module map (第 2 章) turned into coordinates. Both
// readings of that map live here:
//
//   flow  — where a transcript record physically travels
//   deps  — who imports whom (all arrows converge on providers/types.ts)
//
// Chapters declare which node ids they cover (src/book/manifest.js); the rail
// minimap lights those up, so by the last chapter the whole map has been lit.

// Layout space. Every rect below is in this coordinate system.
export const VIEW = { w: 1000, h: 610 };

export const LAYERS = {
  source: { label: '外部转写', tone: 'source' },
  provider: { label: 'Provider 轴', tone: 'provider' },
  pivot: { label: '共同语言', tone: 'pivot' },
  consumer: { label: '记录的消费者', tone: 'consumer' },
  infra: { label: '基础设施', tone: 'infra' },
  store: { label: '索引文件', tone: 'store' },
  shell: { label: '外壳', tone: 'shell' },
  side: { label: '横向', tone: 'infra' },
};

export const NODES = [
  {
    id: 'orchestration',
    layer: 'side',
    label: '编排',
    sub: 'indexer.ts\nprovider-indexing.ts',
    x: 16, y: 112, w: 118, h: 250,
    chapter: '09-orchestration',
    blurb: '一次 build 的完整生命周期：制定计划、逐单元执行、收尾。它是唯一同时认识适配器和 persist 的地方。',
  },
  {
    id: 'registry',
    layer: 'side',
    label: '注册与纯解析',
    sub: 'providers/registry.ts\nparsing.ts',
    x: 866, y: 112, w: 118, h: 250,
    chapter: '06-provider-contract',
    blurb: 'registry 在启动时就把重复 id、缺失方法这类错误挡住。parsing.ts 一行 SQLite 都不 import —— 因为 Electron 的运行时里没有 node:sqlite。',
  },

  {
    id: 'src-claude',
    layer: 'source',
    label: '~/.claude',
    sub: 'projects/<p>/<id>.jsonl',
    x: 250, y: 24, w: 180, h: 44,
    chapter: '07-three-adapters',
    source: 'claude',
    blurb: 'Claude Code 的转写：一个 session 一个 JSONL 文件，只会在末尾追加。',
  },
  {
    id: 'src-codex',
    layer: 'source',
    label: '~/.codex',
    sub: 'sessions/YYYY/MM/DD/*.jsonl',
    x: 450, y: 24, w: 180, h: 44,
    chapter: '07-three-adapters',
    source: 'codex',
    blurb: 'Codex 的转写：按日期分桶，去重逻辑需要整个文件的双向视野。',
  },
  {
    id: 'src-kimi',
    layer: 'source',
    label: '~/.kimi-code',
    sub: 'session 目录 / wire.jsonl',
    x: 650, y: 24, w: 180, h: 44,
    chapter: '07-three-adapters',
    source: 'kimi',
    blurb: 'Kimi Code：一个目录就是一个工作单元，wire.jsonl 是操作日志而不是消息列表。',
  },

  {
    id: 'p-claude',
    layer: 'provider',
    label: 'providers/claude.ts',
    sub: '行增量',
    x: 250, y: 104, w: 180, h: 52,
    chapter: '07-three-adapters',
    source: 'claude',
    blurb: '只解析文件里新增的那些行，游标编码「mtime + 已处理行数」，报 countMode: delta。',
  },
  {
    id: 'p-codex',
    layer: 'provider',
    label: 'providers/codex.ts',
    sub: '全量重解析',
    x: 450, y: 104, w: 180, h: 52,
    chapter: '07-three-adapters',
    source: 'codex',
    blurb: '每次把整个文件读进来，因此报 countMode: total，让 persist 直接替换而不是累加。',
  },
  {
    id: 'p-kimi',
    layer: 'provider',
    label: 'providers/kimi.ts',
    sub: '目录投影',
    x: 650, y: 104, w: 180, h: 52,
    chapter: '07-three-adapters',
    source: 'kimi',
    blurb: '把一份操作日志折叠回消息，整目录聚合成一个游标，全量替换。接进来时的硬约束是不改 schema。',
  },

  {
    id: 'types',
    layer: 'pivot',
    label: 'providers/types.ts',
    sub: 'TranscriptRecord —— 全书的支点',
    x: 250, y: 196, w: 580, h: 76,
    chapter: '04-the-pivot',
    blurb: '十种记录构成的共同语言。划在「所有来源特有的解释都已完成，所有存储特有的取舍都还没发生」的那一层。',
  },

  {
    id: 'persist',
    layer: 'consumer',
    label: 'persist.ts',
    sub: '唯一碰数据库的层',
    x: 190, y: 300, w: 200, h: 54,
    chapter: '08-persist',
    blurb: '按 record.kind 分派成 SQL。整个文件里没有一个分支是按 source 分的 —— 加一个新来源，它一个字都不用改。',
  },
  {
    id: 'session-detail',
    layer: 'consumer',
    label: 'session-detail.ts',
    sub: '记录 → 时间线',
    x: 400, y: 300, w: 200, h: 54,
    chapter: '12-presentation',
    blurb: '从不检查 source。它做的只是确定性的排序、分组和配对 —— 来源语义在解析时就被消化掉了。',
  },
  {
    id: 'query',
    layer: 'consumer',
    label: 'query.ts',
    sub: '16 个 helper',
    x: 610, y: 300, w: 200, h: 54,
    chapter: '10-codeact-runtime',
    blurb: 'FTS5 与结构化 JOIN。过滤和裁剪发生在数据这一侧，不在 agent 的 context 里。',
  },

  {
    id: 'write-infra',
    layer: 'infra',
    label: 'db · tx · writer-lease',
    sub: '连接 · 事务 · 单写者租约',
    x: 190, y: 378, w: 200, h: 48,
    chapter: '13-concurrency',
    blurb: '五种写者抢一个文件。租约决定谁有资格写，事务原语决定写坏了怎么退回去。',
  },
  {
    id: 'core',
    layer: 'infra',
    label: 'core.ts',
    sub: '四个动词 + 沙箱',
    x: 610, y: 378, w: 200, h: 48,
    chapter: '10-codeact-runtime',
    blurb: '八行的 node:vm 沙箱。没有 require、没有 fs、没有 fetch —— 脚本能读能算，但带不走任何东西。',
  },

  {
    id: 'sqlite',
    layer: 'store',
    label: '~/.obelisk/obelisk.sqlite',
    sub: '证据表 · 记忆表 · 簿记表',
    x: 310, y: 452, w: 380, h: 52,
    chapter: '05-data-layer',
    blurb: '一个本地文件，三类性质完全不同的表。数据库是序列化适配器，不是转写语义的来源。',
  },

  {
    id: 'cli',
    layer: 'shell',
    label: 'packages/cli',
    sub: '71 行，全是转发',
    x: 190, y: 534, w: 200, h: 50,
    chapter: '01-what-it-is',
    blurb: '--build / --search / --query / --attune。除去 install，四个动词就是全部的运行时契约。',
  },
  {
    id: 'app',
    layer: 'shell',
    label: 'app/',
    sub: 'Electron 桌面应用',
    x: 400, y: 534, w: 200, h: 50,
    chapter: '12-presentation',
    blurb: '第二个消费者。它自己贡献的只有一样东西：一个 better-sqlite3 的 handle。',
  },
  {
    id: 'skill',
    layer: 'shell',
    label: 'skill-doc/',
    sub: '纯文档，无可执行代码',
    x: 610, y: 534, w: 200, h: 50,
    chapter: '01-what-it-is',
    blurb: '不连任何东西。npm 装运行时，skills 装指引 —— 运行时的归属毫不含糊。',
  },
];

export const NODE_BY_ID = Object.fromEntries(NODES.map((n) => [n.id, n]));

// `flow` — where a record travels. `deps` — who imports whom.
export const EDGES = {
  flow: [
    ['src-claude', 'p-claude'],
    ['src-codex', 'p-codex'],
    ['src-kimi', 'p-kimi'],
    ['p-claude', 'types'],
    ['p-codex', 'types'],
    ['p-kimi', 'types'],
    ['types', 'persist'],
    ['types', 'session-detail'],
    ['types', 'query', { dashed: true, note: '经 SQLite 往返' }],
    ['persist', 'write-infra'],
    ['write-infra', 'sqlite'],
    ['sqlite', 'core', { dashed: true }],
    ['core', 'cli'],
    ['sqlite', 'app', { dashed: true }],
    ['session-detail', 'app', { curve: 'right' }],
  ],
  deps: [
    ['p-claude', 'types'],
    ['p-codex', 'types'],
    ['p-kimi', 'types'],
    ['persist', 'types'],
    ['session-detail', 'types'],
    ['query', 'types'],
    ['orchestration', 'types'],
    ['write-infra', 'persist'],
    ['core', 'query'],
    ['cli', 'core'],
    ['app', 'persist'],
    ['app', 'session-detail'],
  ],
};

// The three rules of 第 2 章, as things you can point at on the map.
export const RULES = [
  {
    id: 'r1',
    title: '适配器从不打开数据库',
    detail:
      'Electron 打包的 Node 运行时里没有 node:sqlite。适配器里只要有一行 import，App 就再也无法复用它。',
    highlight: ['p-claude', 'p-codex', 'p-kimi', 'registry'],
    forbid: ['sqlite'],
    chapter: '02-module-map',
  },
  {
    id: 'r2',
    title: 'persist 从不知道 provider 是谁',
    detail:
      'persist.ts 里那个 switch 分派的是 record.kind，没有一个分支是按 source 分的。source 只作为列值出现。',
    highlight: ['persist'],
    forbid: ['p-claude', 'p-codex', 'p-kimi'],
    chapter: '02-module-map',
  },
  {
    id: 'r3',
    title: 'CLI 和 App 从不实现检索',
    detail:
      'App 有充分的理由自己写一套 —— 它用的是另一个 SQLite binding。但它直接 import Core 的源码，只贡献一个 handle。',
    highlight: ['cli', 'app'],
    forbid: ['query', 'persist'],
    chapter: '02-module-map',
  },
];
