<script setup>
// What actually gets re-parsed.
//
// Three adapters, one contract, three completely different answers — and the
// differences are not stylistic, they are forced by the source formats. Move
// the slider and watch Claude touch only the new lines while Codex re-reads the
// whole file and Kimi retracts the session and rebuilds it.

import { computed, ref } from 'vue';

import TabBar from '@/components/TabBar.vue';

const BASE = {
  claude: { lines: 1200, mtime: 1754300000000 },
  codex: { lines: 860, mtime: 1754300000000 },
  kimi: { state: 12, main: 640, sub: 210, mtime: 1754300000000 },
};

const SCENARIOS = [
  { id: 'append', label: '转写末尾追加了 N 行', hint: '最常见的情况：会话还在进行。' },
  { id: 'sidecar', label: '旁路元数据变了，转写的 mtime 没变', hint: '纯 mtime 增量检测扛不住的地方。' },
  { id: 'undo', label: '用户撤回了最近 3 条', hint: '增量追加只能往前加，表达不了「把加过的东西拿掉」。' },
];

const added = ref(180);
const scenario = ref('append');

const kimiTotal = computed(() => BASE.kimi.state + BASE.kimi.main + BASE.kimi.sub);

const claude = computed(() => {
  const before = `${BASE.claude.mtime}:${BASE.claude.lines}`;
  if (scenario.value === 'undo') {
    return {
      changed: false,
      skip: '这个来源没有撤回语义 —— Claude 的转写只会在末尾追加。',
      before,
      after: before,
    };
  }
  if (scenario.value === 'sidecar') {
    return {
      changed: true,
      before,
      after: `${BASE.claude.mtime + 1}:${BASE.claude.lines}`,
      parsed: BASE.claude.lines,
      total: BASE.claude.lines,
      countMode: 'total',
      why: 'subagent 的 .meta.json 变了 → forcedPaths 强制重新处理它对应的转写文件，即使那个文件的 mtime 没变。因为 workflow_agents 的一行由两个单元拼成。',
      emits: ['workflow_agent（补上 agent_type / description）'],
    };
  }
  const changed = added.value > 0;
  return {
    changed,
    before,
    after: changed ? `${BASE.claude.mtime + 1}:${BASE.claude.lines + added.value}` : before,
    parsed: added.value,
    total: BASE.claude.lines + added.value,
    countMode: added.value > 0 ? 'delta' : 'total',
    why: changed
      ? `游标里的行数是「已处理到第几行」，parse 里一句 if (lineNum <= skip) return 就跳过前 ${BASE.claude.lines} 行。`
      : 'mtime 没变，这个文件根本不进计划。',
    emits: changed ? ['session（countMode: delta）', `message × ~${Math.round(added.value / 3)}`] : [],
  };
});

const codex = computed(() => {
  const before = `${BASE.codex.mtime}:${BASE.codex.lines}`;
  if (scenario.value === 'undo') {
    return { changed: false, skip: '这个来源没有撤回语义。（守卫线程是另一回事——它每次都重新处理，为的是每次都发出 delete-session。）', before, after: before };
  }
  if (scenario.value === 'sidecar') {
    return {
      changed: true,
      before,
      after: `${BASE.codex.mtime}:${BASE.codex.lines}`,
      parsed: BASE.codex.lines,
      total: BASE.codex.lines,
      countMode: 'total',
      why: 'session_index.jsonl 提供标题，它变了要触发全体重扫——因为标题可能变在任何一个 session 上。',
      emits: ['session（标题增强）'],
    };
  }
  const changed = added.value > 0;
  return {
    changed,
    before,
    after: changed ? `${BASE.codex.mtime + 1}:${BASE.codex.lines + added.value}` : before,
    parsed: changed ? BASE.codex.lines + added.value : 0,
    total: BASE.codex.lines + added.value,
    countMode: 'total',
    why: changed
      ? 'event_msg ↔ response_item 的去重需要整个文件的双向视野——配对的两条挨着但顺序不定。行增量会让切在边界两侧的配对漏判，同一条消息入库两次。'
      : 'mtime 没变，跳过。',
    emits: changed ? ['session（countMode: total）', `message × 全量`] : [],
  };
});

const kimi = computed(() => {
  const before = `${BASE.kimi.mtime}:${kimiTotal.value}`;
  if (scenario.value === 'undo') {
    return {
      changed: true,
      before,
      after: `${BASE.kimi.mtime + 1}:${kimiTotal.value + 1}`,
      parsed: kimiTotal.value + 1,
      total: kimiTotal.value + 1,
      countMode: 'total',
      why: 'wire.jsonl 里多了一条 context.undo。撤回不是删行——日志只增不减，是重放时在内存里算出撤回之后的最终状态。这一条彻底否决了行增量。',
      emits: ['delete-session（先撤回自己）', 'session', 'message × 撤回之后剩下的'],
      retract: true,
    };
  }
  if (scenario.value === 'sidecar') {
    return {
      changed: true,
      before,
      after: `${BASE.kimi.mtime + 1}:${kimiTotal.value}`,
      parsed: kimiTotal.value,
      total: kimiTotal.value,
      countMode: 'total',
      why: '游标是整个目录下所有文件的最大 mtime + 总行数之和。state.json 变了，聚合 mtime 就变，判断是相等比较——不等就整个目录重来。',
      emits: ['delete-session', 'session', 'message × 全量'],
      retract: true,
    };
  }
  const changed = added.value > 0;
  return {
    changed,
    before,
    after: changed ? `${BASE.kimi.mtime + 1}:${kimiTotal.value + added.value}` : before,
    parsed: changed ? kimiTotal.value + added.value : 0,
    total: kimiTotal.value + added.value,
    countMode: 'total',
    why: changed
      ? '「总行数」在这里不是「读到第几行」，是一个变更检测的指纹。任何一个 wire 文件多一行，总和就变。'
      : '聚合游标和上次完全相等，continue。',
    emits: changed ? ['delete-session（先撤回自己）', 'session', 'message × 全量'] : [],
    retract: changed,
  };
});

const lanes = computed(() => [
  { id: 'claude', name: 'Claude Code', strategy: '行增量', unit: '一个文件', data: claude.value },
  { id: 'codex', name: 'Codex', strategy: '全量重解析', unit: '一个文件', data: codex.value },
  { id: 'kimi', name: 'Kimi Code', strategy: '目录投影 + 全量替换', unit: '一整个目录', data: kimi.value },
]);

const pct = (lane) => {
  const d = lane.data;
  if (!d.changed || !d.total) return 0;
  return Math.max(2, Math.round((d.parsed / d.total) * 100));
};
</script>

<template>
  <div class="lab">
    <div class="controls">
      <TabBar v-model="scenario" :tabs="SCENARIOS" label="场景" />
      <p class="hint">{{ SCENARIOS.find((s) => s.id === scenario)?.hint }}</p>

      <label v-if="scenario === 'append'" class="slider">
        <span>追加了</span>
        <input v-model.number="added" type="range" min="0" max="400" step="10" />
        <b>{{ added }}</b>
        <span>行</span>
      </label>
    </div>

    <div class="lanes">
      <article v-for="lane in lanes" :key="lane.id" class="lane" :class="[lane.id, { idle: !lane.data.changed }]">
        <header>
          <span class="name">{{ lane.name }}</span>
          <span class="strategy">{{ lane.strategy }}</span>
        </header>

        <p v-if="lane.data.skip" class="skip">{{ lane.data.skip }}</p>

        <template v-else>
          <div class="bar" :title="`重新解析 ${lane.data.parsed} / ${lane.data.total} 行`">
            <div class="fill" :style="{ width: `${pct(lane)}%` }" />
          </div>
          <p class="numbers">
            重新解析 <b>{{ lane.data.parsed.toLocaleString() }}</b> / {{ lane.data.total.toLocaleString() }} 行
            <span class="mode">countMode: {{ lane.data.countMode }}</span>
          </p>

          <ul v-if="lane.data.emits?.length" class="emits">
            <li v-for="e in lane.data.emits" :key="e" :class="{ retract: e.startsWith('delete-session') }">
              {{ e }}
            </li>
          </ul>

          <p class="why">{{ lane.data.why }}</p>

          <div class="cursor">
            <span class="c-label">游标</span>
            <code class="old">{{ lane.data.before }}</code>
            <span class="to">→</span>
            <code :class="{ same: lane.data.before === lane.data.after }">{{ lane.data.after }}</code>
          </div>
        </template>
      </article>
    </div>

    <p class="closing">
      三条泳道里的游标全都是 <code>"数字:数字"</code>，而且中间没有任何人解释它的含义——
      编排层只负责拆成两列存进 <code>index_state</code>，下次原样拼回来递回去。
      <b>同一个格式，三种语义。</b>
    </p>
  </div>
</template>

<style scoped>
.hint {
  margin: 0.6rem 0 0.75rem;
  font-size: 0.78rem;
  color: var(--faint);
}

.slider {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  font: 0.76rem/1.6 var(--mono);
  color: var(--muted);
}

.slider input {
  width: 12rem;
  accent-color: var(--accent-deep);
}

.slider b {
  min-width: 2.4rem;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.lanes {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.7rem;
  margin-top: 1.1rem;
}

.lane {
  padding: 0.8rem 0.9rem 0.9rem;
  border: 1px solid var(--edge);
  border-radius: var(--radius-sm);
  background: var(--bg-sunk);
  transition: opacity 0.2s var(--ease);
}

.lane.idle {
  opacity: 0.55;
}

.lane header {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  margin-bottom: 0.6rem;
}

.name {
  font: 600 0.82rem/1.5 var(--sans);
  color: var(--fg);
}

.strategy {
  margin-left: auto;
  font: 0.65rem/1.6 var(--mono);
  color: var(--faint);
}

.lane.claude .name { color: var(--claude); }
.lane.codex .name { color: var(--codex); }
.lane.kimi .name { color: var(--kimi); }

.bar {
  height: 6px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.05);
  overflow: hidden;
}

.fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.3s var(--ease);
}

.lane.claude .fill { background: var(--claude); }
.lane.codex .fill { background: var(--codex); }
.lane.kimi .fill { background: var(--kimi); }

.numbers {
  margin-top: 0.45rem;
  font: 0.71rem/1.7 var(--mono);
  color: var(--muted);
}

.numbers b {
  color: var(--fg);
  font-variant-numeric: tabular-nums;
}

.mode {
  display: block;
  color: var(--dim);
}

.emits {
  margin: 0.55rem 0 0;
  padding: 0;
  list-style: none;
}

.emits li {
  padding: 0.1rem 0.4rem;
  margin-bottom: 0.18rem;
  border-left: 2px solid var(--edge-hi);
  font: 0.68rem/1.6 var(--mono);
  color: var(--faint);
}

.emits li.retract {
  border-left-color: var(--red);
  color: #f0a0a0;
}

.why {
  margin-top: 0.6rem;
  font-size: 0.79rem;
  line-height: 1.7;
  color: var(--fg-soft);
}

.skip {
  font-size: 0.79rem;
  line-height: 1.7;
  color: var(--faint);
}

.cursor {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  flex-wrap: wrap;
  margin-top: 0.7rem;
  padding-top: 0.6rem;
  border-top: 1px solid var(--edge);
}

.c-label {
  font: 0.63rem/1.6 var(--mono);
  letter-spacing: 0.1em;
  color: var(--dim);
}

.cursor code {
  font: 0.66rem/1.6 var(--mono);
  color: var(--accent);
}

.cursor code.old {
  color: var(--dim);
  text-decoration: line-through;
}

.cursor code.same {
  color: var(--dim);
  text-decoration: none;
}

.to {
  color: var(--dim);
}

.closing {
  margin-top: 1rem;
  font-size: 0.85rem;
  line-height: 1.8;
  color: var(--fg-soft);
}

.closing code {
  padding: 0.05em 0.35em;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.05);
  font-family: var(--mono);
  font-size: 0.85em;
  color: var(--accent);
}

@media (max-width: 860px) {
  .lanes {
    grid-template-columns: 1fr;
  }
}
</style>
