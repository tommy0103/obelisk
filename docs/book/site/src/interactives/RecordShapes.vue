<script setup>
// The ten record kinds, as things you can pick up and turn over.
//
// The toggle is the point: flip to 「如果没有这一层」 and each explicit field is
// replaced by the guess it exists to eliminate. That is the argument of 第 4 章
// in one control — canonical record's job is to give 猜 a replacement.

import { computed, ref } from 'vue';

import TabBar from '@/components/TabBar.vue';

const MODES = [
  { id: 'now', label: '现在的样子', sub: '语义是显式字段' },
  { id: 'without', label: '如果没有这一层', sub: '语义只能靠猜' },
];

const RECORDS = [
  {
    kind: 'session',
    group: '表',
    table: 'sessions',
    fields: ['id', 'title', 'project', 'started_at', 'ended_at', 'message_count', 'countMode', 'source'],
    note: '唯一需要 persist 先读后写的记录：四种合并策略并存（MIN / MAX / 累加或替换 / 有新值才覆盖）。',
    star: 'countMode',
    starWhy: '适配器明说这一批是「新增了多少」还是「一共多少」。让抽象承接差异，而不是让 persist 去猜 source。',
  },
  {
    kind: 'message',
    group: '表',
    table: 'messages',
    fields: ['uuid', 'role', 'text', 'content_type', 'is_meta', 'visibility', 'agent_id', 'cwd', 'source'],
    note: '主表。注意 turn_duration_ms 不在这里——它由另一种记录负责。',
    star: 'visibility',
    starWhy: '「要不要显示」和「是不是控制面材料」是两个正交的问题。混成一个布尔值，隐藏的传输上下文和该显示的 Skill 指令就没法区分了。',
    guess: '展示层用正则猜哪条是注入的：/^\\s*<environment_context/。每加一个来源，猜错的方式就多一种。',
  },
  {
    kind: 'tool_call',
    group: '表',
    table: 'tool_calls',
    fields: ['id', 'message_uuid', 'name', 'presentation', 'input_json', 'file_path'],
    note: '这张表没有时间戳——要排序必须 JOIN 回 messages。',
    star: 'presentation',
    starWhy: '直接说明这次调用该怎么呈现。它唯一的用处是让「只调用了一次 Skill 的消息」不参与工具调用合并。',
    guess: '展示层按工具名和文本特征猜这是不是一次 Skill 调用。',
  },
  {
    kind: 'tool_result',
    group: '表',
    table: 'tool_results',
    fields: ['tool_use_id', 'message_uuid', 'content', 'is_error'],
    note: '靠 tool_use_id 和调用配对，纯 ID 匹配，没有启发式。',
  },
  {
    kind: 'summary',
    group: '表',
    table: 'summaries',
    fields: ['id', 'session_id', 'text', 'timestamp'],
    note: '压缩/摘要事件。没有这个概念的来源留空即可。',
  },
  {
    kind: 'subagent',
    group: '表',
    table: 'subagents',
    fields: ['agent_id', 'session_id', 'agent_type', 'description'],
    note: '只有元数据。subagent 说的话在 messages 里，靠 agent_id 归属——所以「这个 subagent 说了什么」是一次普通查询。',
    star: 'agent_id',
    starWhy: 'Codex 的子线程被投影进这张原本为 Claude 设计的表：有父线程就带 agent_id，没有就自己是一个 session。',
  },
  {
    kind: 'workflow',
    group: '表',
    table: 'workflows',
    fields: ['run_id', 'session_id', 'parent_tool_use_id', 'script', 'agent_count'],
    star: 'parent_tool_use_id',
    starWhy: '直接说明它挂在哪次调用下面。',
    guess: '展示层按时间顺序猜哪个 workflow 属于哪次工具调用。',
  },
  {
    kind: 'workflow_agent',
    group: '表',
    table: 'workflow_agents',
    fields: ['agent_id', 'run_id', 'session_id', 'agent_type?', 'phase?', 'model?', 'tokens?'],
    note: '除了三个 ID 全是可选的——一行由两个独立单元在任意顺序下拼成，落库时用 COALESCE 按列合并。',
    star: '几乎全部可选',
    starWhy: '「你不知道的字段就别写」。COALESCE 保证「我不知道」永远不会覆盖掉「别人已经知道的」。这不是防御性编程，是这个数据模型的直接后果。',
  },
  {
    kind: 'message-turn-duration',
    group: '操作',
    table: 'UPDATE messages SET turn_duration_ms',
    fields: ['uuid', 'turn_duration_ms'],
    note: '一次定点更新。目标消息还没入库就影响 0 行，静默通过——耗时是锦上添花的信息。',
    star: '它不是一张表',
    starWhy: '一条消息的耗时可能出现在另一行、甚至另一次运行里。共同语言里说的不只是「有什么」，还有「发生了什么变化」。',
  },
  {
    kind: 'delete-session',
    group: '操作',
    table: '八条手写 DELETE 级联',
    fields: ['sessionId'],
    note: '适配器不去操作数据库，它只是「说」这个 session 应该消失。',
    star: '撤回是一等公民',
    starWhy: '设计意图是 Codex 的守卫线程。Kimi 用它实现了更强的语义——每次 parse 先删自己再重建，也就是幂等的整体替换。这是共同语言比它的设计者想象得更通用的一个例子。',
  },
];

const picked = ref('message');
const mode = ref('now');

const item = computed(() => RECORDS.find((r) => r.kind === picked.value));
const guessing = computed(() => mode.value === 'without');
const withGuess = computed(() => RECORDS.filter((r) => r.guess));
</script>

<template>
  <div class="records">
    <TabBar v-model="mode" :tabs="MODES" label="对照" class="modes" />

    <p v-if="guessing" class="without-copy">
      适配器直接产出数据库行。行是扁平的，语义在写入时被抹平，展示层只能从行结构反推——
      <b>{{ withGuess.length }}</b> 处需要靠猜。猜就会错，而且每加一个来源，猜错的方式就多一种。
    </p>

    <div class="grid">
      <button
        v-for="r in RECORDS"
        :key="r.kind"
        type="button"
        class="chip"
        :class="{ on: picked === r.kind, op: r.group === '操作', risky: guessing && r.guess }"
        @click="picked = r.kind"
      >
        <span class="k">{{ r.kind }}</span>
        <span v-if="r.group === '操作'" class="tag">操作</span>
        <span v-else-if="guessing && r.guess" class="tag warn">要猜</span>
      </button>
    </div>

    <div class="card">
      <div class="card-head">
        <code class="kind">{{ item.kind }}</code>
        <span class="arrow">→</span>
        <code class="dest">{{ item.table }}</code>
      </div>

      <ul class="fields">
        <li v-for="f in item.fields" :key="f" :class="{ opt: f.endsWith('?') }">{{ f }}</li>
      </ul>

      <p v-if="item.note" class="note">{{ item.note }}</p>

      <div v-if="!guessing && item.star" class="star">
        <span class="star-key">{{ item.star }}</span>
        <p>{{ item.starWhy }}</p>
      </div>

      <div v-else-if="guessing && item.guess" class="star bad">
        <span class="star-key">没有这个字段的话</span>
        <p>{{ item.guess }}</p>
      </div>

      <p v-else-if="guessing" class="flat">
        这一条本来就不依赖显式字段——它的问题在别处：没有中间语言时，撤回和定点更新这两种「变化」根本没法表达，适配器只能自己去动数据库。
      </p>
    </div>
  </div>
</template>

<style scoped>
.modes {
  margin-bottom: 1rem;
}

.without-copy {
  margin-bottom: 0.9rem;
  padding: 0.7rem 0.9rem;
  border-left: 2px solid var(--red);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  background: var(--red-soft);
  font-size: 0.84rem;
  line-height: 1.7;
  color: var(--fg-soft);
}

.without-copy b {
  color: var(--red);
}

.grid {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-bottom: 1rem;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.3rem 0.65rem;
  border: 1px solid var(--edge);
  border-radius: var(--radius-sm);
  font: 0.75rem/1.5 var(--mono);
  color: var(--muted);
  transition: all 0.15s var(--ease);
}

.chip:hover {
  border-color: var(--edge-hi);
  color: var(--fg);
}

.chip.on {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.chip.op {
  border-style: dashed;
}

.chip.risky {
  border-color: rgba(248, 113, 113, 0.45);
}

.tag {
  padding: 0.02em 0.35em;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.07);
  font-size: 0.62rem;
  color: var(--faint);
}

.tag.warn {
  background: var(--red-soft);
  color: var(--red);
}

.card {
  padding: 0.95rem 1.05rem;
  border: 1px solid var(--edge);
  border-radius: var(--radius-sm);
  background: var(--bg-sunk);
}

.card-head {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
  margin-bottom: 0.75rem;
}

.kind,
.dest {
  padding: 0.12em 0.5em;
  border-radius: 5px;
  font: 0.79rem/1.6 var(--mono);
}

.kind {
  background: var(--accent-soft);
  color: var(--accent);
}

.dest {
  background: rgba(236, 72, 153, 0.1);
  color: #f0a5c8;
}

.arrow {
  color: var(--dim);
}

.fields {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin: 0 0 0.75rem;
  padding: 0;
  list-style: none;
}

.fields li {
  padding: 0.12rem 0.45rem;
  border: 1px solid var(--edge);
  border-radius: 4px;
  font: 0.71rem/1.6 var(--mono);
  color: var(--muted);
}

.fields li.opt {
  border-style: dashed;
  color: var(--faint);
}

.note,
.flat {
  font-size: 0.85rem;
  line-height: 1.75;
  color: var(--fg-soft);
}

.star {
  margin-top: 0.85rem;
  padding: 0.7rem 0.9rem;
  border-left: 2px solid var(--accent);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  background: rgba(167, 139, 250, 0.07);
}

.star.bad {
  border-left-color: var(--red);
  background: var(--red-soft);
}

.star-key {
  font: 600 0.75rem/1.7 var(--mono);
  color: var(--accent);
}

.star.bad .star-key {
  color: var(--red);
}

.star p {
  margin-top: 0.3rem;
  font-size: 0.845rem;
  line-height: 1.75;
  color: var(--fg-soft);
}
</style>
