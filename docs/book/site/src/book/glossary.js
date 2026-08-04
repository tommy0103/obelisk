// Terms the book uses as if you already know them — because after the chapter
// that introduces them, you do. The reader who jumped straight to 第 13 章 does
// not, so every term gets a hover card and a pointer back to its home chapter.
//
// `match` is what the renderer looks for in prose. First occurrence per chapter
// is annotated; the rest are left alone so the page does not turn into a rash
// of dotted underlines.

export const GLOSSARY = [
  {
    term: 'canonical record',
    match: ['canonical record', 'TranscriptRecord'],
    chapter: '04-the-pivot',
    short: '共同语言',
    def: '十种记录构成的类型联合（`providers/types.ts`）。适配器产出它、persist 消费它、session-detail 也消费它。它划在「所有来源特有的解释都已完成，所有存储特有的取舍都还没发生」的那一层。',
  },
  {
    term: 'IndexUnit',
    match: ['IndexUnit'],
    chapter: '06-provider-contract',
    short: '工作单元',
    def: '适配器发现的一份工作。**它不一定是一个文件**——Claude 是一个转写文件，Kimi 是一整个 session 目录。`meta` 字段是 discover 到 parse 之间的私有通道。',
  },
  {
    term: 'Cursor',
    match: ['游标'],
    chapter: '06-provider-contract',
    short: '不透明的位置标记',
    def: '`string | null`。产出它的适配器是唯一能解释它的人；编排层只负责原样存、原样取。同一个 `"数字:数字"` 在三个适配器里是三种语义。折扣：编排层假设了它是一对数字。',
  },
  {
    term: 'countMode',
    match: ['countMode'],
    chapter: '04-the-pivot',
    short: 'delta 还是 total',
    def: '`SessionRecord` 上的字段，告诉 persist 这一批 `message_count` 是「新增了多少」还是「一共多少」。它的存在是为了让共同语言**承接**差异，而不是消灭差异。',
  },
  {
    term: 'persist',
    match: ['persist'],
    chapter: '08-persist',
    short: '唯一碰数据库的层',
    def: '153 行，唯一碰数据库、唯一知道 schema。它的 switch 分派 `record.kind`，没有一个分支是按 `source` 分的。它自己不开事务——原子性由调用方保证。',
  },
  {
    term: 'writer lease',
    match: ['写者租约', '租约'],
    chapter: '13-concurrency',
    short: '跨进程互斥',
    def: '一个独立的 `writer.lock.sqlite`，靠持有 `BEGIN IMMEDIATE` 事务实现互斥。选 SQLite 而不是 flock，是因为两个 binding 用同一个 C 库、所有平台行为一致，且进程崩溃时操作系统自动释放。',
  },
  {
    term: 'heartbeat',
    match: ['心跳'],
    chapter: '13-concurrency',
    short: '谁应该写',
    def: 'App 每 30 秒往 `index_state` 写一行 `__app_heartbeat__`，CLI 用 60 秒的新鲜窗口判断 daemon 是否活着。**心跳表达政策，租约保证互斥**——两者职责不同，因为政策信息会竞态或过期。',
  },
  {
    term: 'indexVersionMarker',
    match: ['indexVersionMarker', '版本标记'],
    chapter: '14-incremental-replay',
    short: '用重放取代数据迁移',
    def: '一个字符串（如 `__kimi_canonical_transcript_v4__`）。改了解析语义就把版本号 +1，编排层发现标记缺失就把这个来源整个重放一遍。前提是索引可完全重建。',
  },
  {
    term: 'CodeAct',
    match: ['CodeAct'],
    chapter: '10-codeact-runtime',
    short: '提交代码而不是查询条件',
    def: '`query(code)` 的参数是一段 JavaScript，在 `node:vm` 沙箱里跑，返回 JSON。核心优势是**过滤发生在数据这一侧**，以及多步检索只花一个回合。',
  },
  {
    term: 'FTS5',
    match: ['FTS5'],
    chapter: '05-data-layer',
    short: 'SQLite 全文索引',
    def: '两张外部内容表（`content=messages`）：只存倒排索引，正文仍只存一份。触发器保证过程中的一致性，每次构建收尾再整体 `rebuild` 一次保证最终一致性。',
  },
  {
    term: 'is_meta / visibility',
    match: ['visibility'],
    chapter: '04-the-pivot',
    short: '两个正交的问题',
    def: '「要不要显示」和「是不是控制面材料」是两件事。隐藏的传输上下文不该出现在时间线里；可见的系统证据（如 Skill 指令）应该显示成一张元数据卡片。混成一个布尔值，两种材料就没法区分。',
  },
  {
    term: 'force rebuild',
    match: ['force rebuild', '强制重建'],
    chapter: '14-incremental-replay',
    short: '三层重来的最后一层',
    def: '清空八张证据表 + 从当前文件重新索引。必须清表而不只是清游标，否则源文件已消失的 session 会留下永远不被覆盖的幽灵行。`memories` 从不参与。',
  },
  {
    term: 'delete-session',
    match: ['delete-session', 'DeleteSessionRecord'],
    chapter: '04-the-pivot',
    short: '一次撤回',
    def: '适配器不去操作数据库，它只是「说」这个 session 应该消失。设计意图是 Codex 的守卫线程；Kimi 用它实现了更强的语义——幂等的整体替换。',
  },
  {
    term: 'daemon 模式',
    match: ['daemon'],
    chapter: '12-presentation',
    short: 'App 是活跃的索引者',
    def: 'App 在跑的时候，它监听文件变化持续索引，CLI 退回只读。没有 App 的时候，每次 CLI 调用顺手把索引推到最新。两种模式走的是同一套代码。',
  },
];

// Longest first, so `TranscriptRecord` wins over a bare `record` if both are
// ever added.
export const GLOSSARY_MATCHES = GLOSSARY
  .flatMap((entry) => entry.match.map((m) => ({ text: m, entry })))
  .sort((a, b) => b.text.length - a.text.length);

export const glossaryFor = (term) => GLOSSARY.find((g) => g.term === term) || null;
