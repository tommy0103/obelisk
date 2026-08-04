// Data for the StepFlow player.
//
// One component, three flows. Each track is a sequence of steps; `lit` names
// module nodes (src/book/modules.js) so the map beside the steps lights up as
// you advance. Step text is condensed from the chapter it sits in — the flow is
// a way to *watch* the argument, not a replacement for reading it.

export const PATHS_FLOW = {
  intro: '三条路径共用一张图，但走的是不同的边。看完你会发现它们交在同一个点上。',
  tracks: [
    {
      id: 'write',
      label: '路径一 · 写入',
      sub: '从别人的文件到你的索引',
      steps: [
        {
          title: '发现 discover',
          lit: ['src-claude', 'src-codex', 'src-kimi', 'p-claude', 'p-codex', 'p-kimi'],
          detail:
            '适配器扫自己的根目录，对比「上次处理到哪儿」的游标，列出需要重新索引的工作单元 IndexUnit。什么算「变了」是格式相关的，所以编排层完全放手。',
        },
        {
          title: '解析 parse',
          lit: ['p-claude', 'p-codex', 'p-kimi', 'types'],
          detail:
            '针对一个单元，适配器从游标处恢复，产出一串 canonical record。这是个生成器：一边产出记录，最后 return 新游标。',
          code: 'parse(unit, cursor): Generator<TranscriptRecord, Cursor>',
        },
        {
          title: '落库 persist',
          lit: ['types', 'persist', 'write-infra', 'sqlite'],
          detail:
            'persist 消费这串记录，按 kind 分派成 SQL，写进注入的数据库 handle。生成器 return 的新游标，也在同一个事务里写进 index_state。',
          note: '一个单元一个事务。解析、写记录、写游标，同生共死。',
        },
        {
          title: '收尾 finalize',
          lit: ['orchestration', 'sqlite'],
          detail:
            '全部单元处理完，一个事务内：回填 project_path、重建 FTS 索引、写时间戳标记。',
          note: '逐单元阶段容忍失败，收尾阶段不容忍——半完成的收尾会让索引处于不一致状态。',
        },
      ],
    },
    {
      id: 'query',
      label: '路径二 · 检索',
      sub: '从一句提问到一份 JSON',
      steps: [
        {
          title: 'skill 层',
          lit: ['skill'],
          detail:
            '纯文档的 skill 指引 agent：先 overview() 拿地图，把中文问题翻成英文检索意图，同时问记忆层和证据层。agent 把这些写成一小段 JS，落到临时文件。',
        },
        {
          title: 'CLI',
          lit: ['cli'],
          detail: '读文件 → 交给 Core → 结果 JSON 打到 stdout。全程不含检索逻辑。',
          code: 'obelisk --query /tmp/q.mjs',
        },
        {
          title: '刷新索引',
          lit: ['orchestration', 'p-claude', 'p-codex', 'p-kimi', 'persist', 'sqlite'],
          detail:
            'executeQuery() 的第一句是 buildIndex()——就是路径一。检索顺手把写入路径跑了一遍。',
          note: '两条路径是嵌套的，不是并列的。没有「同步」这个独立动作。',
        },
        {
          title: '只读连接',
          lit: ['sqlite', 'core'],
          detail: 'openReadDb()：readOnly 打开，不建表、不迁移、不设 PRAGMA。',
        },
        {
          title: '沙箱',
          lit: ['core'],
          detail:
            'node:vm 新上下文，脚本被包成异步 IIFE，30 秒超时。白名单里有 16 个 helper 和一批内置对象——没有 require、没有 fs、没有 fetch、没有 process。',
          note: '能读，但带不走。脚本唯一的输出通道是它的返回值。',
        },
        {
          title: '执行与返回',
          lit: ['query', 'sqlite'],
          detail:
            'helper 走 FTS5 和结构化 JOIN，在数据这一侧完成过滤和裁剪。脚本 return 的值序列化成 JSON，agent 读它，可能再追一轮。',
        },
      ],
    },
    {
      id: 'present',
      label: '路径三 · 展示',
      sub: '从索引到人眼',
      steps: [
        {
          title: '取快照',
          lit: ['sqlite', 'app'],
          detail:
            '主进程按 session_id 从 SQLite 拉六张表：messages / toolCalls / toolResults / subagents / workflows / summaries。六条平铺直叙的 SELECT，没有逻辑。',
        },
        {
          title: '转回记录语言',
          lit: ['types', 'session-detail'],
          detail:
            'sessionDetailRecordsFromRows 把宽松的数据库行重新收紧成严格的记录类型。适配器一次全新解析的产出也走同一个入口。',
          note: '不是为了代码复用，是为了让两条路径在类型上就是同一条，不可能漂移。',
        },
        {
          title: '组装',
          lit: ['session-detail'],
          detail:
            '分拣与关联：按 visibility 过滤、工具调用配对结果、subagent 挂到发起它的调用上、workflow 挂到父调用上。全靠 ID 匹配，没有一处启发式。',
          note: 'assembleSessionDetail 从不检查 source。',
        },
        {
          title: '合并成卡片',
          lit: ['session-detail'],
          detail:
            'thinking 块并入后续消息、连续工具调用聚合、Skill 指令并入它的调用。三类合并全部基于 content_type 和 presentation 两个显式字段。',
        },
        {
          title: '补丁与渲染',
          lit: ['app'],
          detail:
            '会话还在进行时，重新取快照、按「位置 + 内容哈希」算出与上一版的差异，只把增量补丁送过去。Vue 把时间线画成卡片。',
        },
      ],
    },
  ],
};

export const BUILD_FLOW = {
  intro:
    '一次 buildIndex 的七步。切换右上角的场景，看同一条流程在不同失败下怎么降级——失败按严重程度分三档，这个顺序本身就是策略。',
  tracks: [
    {
      id: 'ok',
      label: '一切正常',
      sub: '七步走完',
      steps: [
        { title: '第 1 步 · 所有权检查', lit: ['sqlite'], detail: '只读连接查心跳：daemon 活着吗？30 秒内构建过吗？两者之一成立就直接返回。' },
        { title: '第 2 步 · 拿写者租约', lit: ['write-infra'], detail: '一个独立的 writer.lock.sqlite，持有一个 BEGIN IMMEDIATE 事务。拿不到就返回 writer_busy。' },
        { title: '第 3 步 · 再查一次所有权', lit: ['sqlite'], detail: '关掉第 1、2 步之间的 TOCTOU 窗口——就在你决定「没有 daemon」到真的拿到锁之间，App 可能刚好启动了。', note: '这一步是整套流程的核心。' },
        { title: '第 5 步 · 制定计划', lit: ['orchestration', 'p-claude', 'p-codex', 'p-kimi'], detail: '每个 provider 各 discover 一遍，产出 (provider, unit, cursor) 三元组的数组，外加一份待写的版本标记。计划是纯数据。', note: '执行阶段没有决策。' },
        { title: '第 6 步 · 逐单元执行', lit: ['p-claude', 'p-codex', 'p-kimi', 'types', 'persist', 'sqlite'], detail: '每个单元一个事务：parse → persist → 写游标。全部成功。' },
        { title: '第 7 步 · 收尾', lit: ['orchestration', 'sqlite'], detail: '一个事务：回填 project_path、重建两张 FTS、写 __last_build__、给全部成功的来源写版本标记。' },
        { title: 'finally', lit: ['write-infra'], detail: '关连接、放租约。中间有五处 return，任何一处都不会漏掉清理。', done: true },
      ],
    },
    {
      id: 'unit-fails',
      label: '一个文件解析炸了',
      sub: '→ skip',
      steps: [
        { title: '逐单元执行：第 37 个抛错', lit: ['p-codex'], detail: '格式坏了、磁盘读错了、或者适配器有 bug。' },
        { title: '事务回滚', lit: ['persist', 'sqlite'], detail: '这个单元的记录和游标在同一个事务里，一起回滚。游标停在原处。' },
        { title: '判定：skip', lit: ['orchestration'], detail: '不是 BEGIN 忙、事务状态也确认已结束 → 记进 skippedFiles、往 stderr 打一行警告、继续下一个单元。', note: '一个坏文件不该让整个索引不可用。' },
        { title: '第 7 步 · 收尾照常', lit: ['sqlite'], detail: '但 Codex 这个来源进了 failedProviders，所以**不给它写版本标记**。' },
        { title: '下次构建', lit: ['orchestration'], detail: '这个文件的 mtime 仍然 > 旧游标，它再次出现在计划里。**游标本身就是重试机制**——不需要重试队列。', done: true },
      ],
    },
    {
      id: 'begin-busy',
      label: '连事务都开不起来',
      sub: '→ stop',
      steps: [
        { title: '逐单元执行：BEGIN 失败', lit: ['write-infra'], detail: 'SQLITE_BUSY，而且 phase === "begin"、transactionActive === false。' },
        { title: '判定：stop', lit: ['orchestration'], detail: '数据库正被别的进程占着。继续遍历剩下几百个单元只会重复失败。', note: '这不是错误，是「现在不是时候」。' },
        { title: '整次构建停下', lit: ['cli'], detail: '返回 { skip: true, reason: "database_busy" }。收尾不执行，版本标记不写。' },
        { title: '调用方区分处理', lit: ['cli'], detail: 'attune 会说「index writer is busy; attune was not applied」——和 daemon_active 那句「你得先关掉 App」是完全不同的意思。', done: true },
      ],
    },
    {
      id: 'unusable',
      label: '事务状态问不出来',
      sub: '→ throw',
      steps: [
        { title: '逐单元执行：某个单元抛错', lit: ['persist'], detail: '而且 transactionActive !== false——可能还开着，可能回滚失败了。' },
        { title: '判定：直接抛', lit: ['orchestration'], detail: '不降级、不吞掉。任何后续操作都可能建立在一个悬空的事务上。', note: '这一条是第 13 章那个 rollback 事故的直接产物。' },
        { title: '向上传播', lit: ['cli'], detail: '整个 buildIndex 抛出原始异常，诊断信息挂在 error.obelisk 上：phase、code、label、rollbackSucceeded、attempts。' },
        { title: '原则', lit: [], detail: '信息不确定时选择「少做」。因为失败代价不对称：漏掉一次索引下次会补上，两个进程同时写可能损坏索引。', done: true },
      ],
    },
  ],
};

export const MEMORY_FLOW = {
  intro:
    '一条记忆的完整生命。注意每一步的批准点都落在人已经熟悉的界面上——没有为记忆层单独发明一套批准机制。',
  tracks: [
    {
      id: 'life',
      label: '一条记忆的一生',
      sub: '六个阶段，两个批准点',
      steps: [
        {
          title: '第 1 步 · 检索产生了一个结论',
          lit: ['query'],
          detail: '值得留下的是：设计决策、项目约定、放弃的备选方案、反复出现的失败原因、跨多个证据点综合出来的判断。agent 简短地提出建议，不擅自动手。',
          note: '不值得记的：一次性查找、不确定的发现、已有记忆已经覆盖的结论。',
        },
        {
          title: '第 2 步 · 用户同意，agent 写文件',
          lit: [],
          detail: 'agent 用普通的 Write 工具写一份 markdown。',
          approval: '人在这里看到内容并批准',
        },
        {
          title: '第 3 步 · 注册',
          lit: ['core', 'sqlite'],
          detail: 'remember() 过四道校验：文件必须已存在、摘要必须是英文、anchors 必须是对象数组、project 没传就从 session 继承。',
          code: "obelisk --attune /tmp/register.mjs",
          approval: '人在这里批准注册动作',
        },
        {
          title: '第 4 步 · 召回',
          lit: ['query', 'sqlite'],
          detail: 'memories() 返回摘要，agent 据此判断相关性；真的相关才去读文件全文。两阶段召回——摘要进上下文的成本很低。',
          note: '记忆是先前的笔记，不是最终权威。正确性依赖它时要拿原始证据核对。',
        },
        {
          title: '第 5 步 · 过期',
          lit: ['sqlite'],
          detail: 'forget({ id, reason })：理由必填、软删除、markdown 文件不动、重复调用幂等。从召回中消失，审计中仍可见。',
          note: '用户说「这条记忆过时了」，这句话本身就是批准——除非多条记忆都可能匹配。',
        },
        {
          title: '第 6 步 · 替换',
          lit: ['sqlite'],
          detail: '没有 update()。更新 = forget() 旧的 + remember() 新的，于是「曾经我们认为是 X，后来改成 Y，理由是 Z」这条线索留在记录里。',
          done: true,
        },
      ],
    },
  ],
};
