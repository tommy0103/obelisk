<script setup>
// Two write-semantics experiments from 第 8 章.
//
// (1) The column that must NOT be in the messages upsert. Run a second index
//     pass with INSERT OR REPLACE and watch turn_duration_ms go to NULL —
//     silently, with no error, on every full re-parse.
// (2) Why COALESCE makes arrival order irrelevant. Swap the two contributing
//     units; the merged row comes out identical.

import { computed, ref } from 'vue';

import TabBar from '@/components/TabBar.vue';

const TABS = [
  { id: 'duration', label: 'messages 的那一列', sub: '故意漏掉的那个列名' },
  { id: 'coalesce', label: 'COALESCE 与顺序无关', sub: '两个单元，任意顺序' },
];

const SEMANTICS = [
  { id: 'upsert', label: 'ON CONFLICT DO UPDATE', sub: '只更新显式列出的列' },
  { id: 'replace', label: 'INSERT OR REPLACE', sub: '整行替换，未指定的列归 NULL' },
];

const tab = ref('duration');

/* ---- 1. messages upsert ---- */

const semantic = ref('upsert');
const log = ref([]);
const row = ref({ uuid: 'm-0003', text: '改成把整个 refresh 收敛到…', turn_duration_ms: null });

function reset() {
  row.value = { uuid: 'm-0003', text: '改成把整个 refresh 收敛到…', turn_duration_ms: null };
  log.value = [];
}

function chooseSemantic(next) {
  semantic.value = next;
  reset();
}

function step(kind) {
  if (kind === 'index') {
    const replacing = semantic.value === 'replace';
    row.value = {
      uuid: 'm-0003',
      text: '改成把整个 refresh 收敛到…',
      // The whole lesson: REPLACE writes every column, so a column no INSERT
      // ever supplies goes back to NULL.
      turn_duration_ms: replacing ? null : row.value.turn_duration_ms,
    };
    log.value.push({
      sql: replacing ? 'INSERT OR REPLACE INTO messages (18 列) VALUES (…)' : 'INSERT … ON CONFLICT(uuid) DO UPDATE SET (18 列)',
      effect: replacing
        ? 'turn_duration_ms 未被指定 → 归 NULL'
        : 'turn_duration_ms 不在列清单里 → 原样保留',
      bad: replacing && row.value.turn_duration_ms === null,
    });
  } else {
    row.value = { ...row.value, turn_duration_ms: 4820 };
    log.value.push({
      sql: 'UPDATE messages SET turn_duration_ms=? WHERE uuid=?',
      effect: 'message-turn-duration 记录：一条定点更新，只碰一列',
      bad: false,
    });
  }
}

const lost = computed(() => log.value.some((l) => l.bad));

/* ---- 2. COALESCE merge ---- */

const swapped = ref(false);

const UNIT_A = {
  name: 'subagents/agent-7f3.jsonl',
  what: 'subagent 的转写文件',
  gives: { agent_type: 'Explore', description: '找出所有 writer lease 的调用点', phase: null, model: null, tokens: null },
};
const UNIT_B = {
  name: 'workflows/wf_019fc6.json',
  what: 'workflow 的运行记录',
  gives: { agent_type: null, description: null, phase: 'Verify', model: 'claude-opus-5', tokens: 18422 },
};

const order = computed(() => (swapped.value ? [UNIT_B, UNIT_A] : [UNIT_A, UNIT_B]));

const merged = computed(() => {
  const out = { agent_type: null, description: null, phase: null, model: null, tokens: null };
  for (const unit of order.value) {
    for (const [k, v] of Object.entries(unit.gives)) {
      // COALESCE(excluded.col, workflow_agents.col)
      out[k] = v ?? out[k];
    }
  }
  return out;
});
</script>

<template>
  <div class="lab">
    <TabBar v-model="tab" :tabs="TABS" label="实验" class="tabs" />

    <!-- ---------------------------------------------------------- 1 -->
    <section v-if="tab === 'duration'">
      <TabBar
        :model-value="semantic"
        :tabs="SEMANTICS"
        label="写语义"
        class="semantics"
        @update:model-value="chooseSemantic"
      />

      <div class="btn-row acts">
        <button class="btn primary" type="button" @click="step('index')">索引一轮</button>
        <button class="btn" type="button" @click="step('duration')">耗时记录到达</button>
        <button class="btn quiet" type="button" :disabled="!log.length" @click="reset">重置</button>
      </div>

      <div class="row" :class="{ lost }">
        <span class="rk">messages</span>
        <code>uuid = {{ row.uuid }}</code>
        <span class="col">
          turn_duration_ms =
          <b :class="{ null: row.turn_duration_ms === null }">
            {{ row.turn_duration_ms === null ? 'NULL' : row.turn_duration_ms }}
          </b>
        </span>
      </div>

      <ol v-if="log.length" class="log">
        <li v-for="(l, i) in log" :key="i" :class="{ bad: l.bad }">
          <code>{{ l.sql }}</code>
          <span>{{ l.effect }}</span>
        </li>
      </ol>
      <p v-else class="idle">
        试试这个顺序：<b>索引一轮 → 耗时记录到达 → 索引一轮</b>，两种写法各来一遍。
      </p>

      <p class="verdict" :class="{ bad: lost }">
        {{
          lost
            ? '耗时没了——而且没有任何报错。Codex 和 Kimi 都是全量重解析，每一次索引都会重演这次覆盖。'
            : '18 列插入、18 列更新，而 messages 表有 19 列。漏掉的那一列不是遗漏，是这条语句存在的全部理由。'
        }}
      </p>
    </section>

    <!-- ---------------------------------------------------------- 2 -->
    <section v-else>
      <p class="intro">
        一个 workflow agent 的信息散在两个地方，它们是两个独立的工作单元，可能在不同的运行里被处理，顺序不定。
      </p>

      <div class="units">
        <article v-for="(u, i) in order" :key="u.name" class="unit">
          <header>
            <span class="seq">{{ i + 1 }}</span>
            <code>{{ u.name }}</code>
          </header>
          <p class="what">{{ u.what }}</p>
          <ul>
            <li v-for="(v, k) in u.gives" :key="k" :class="{ null: v === null }">
              {{ k }} = {{ v === null ? 'null' : v }}
            </li>
          </ul>
        </article>
      </div>

      <button class="btn swap" type="button" @click="swapped = !swapped">交换到达顺序 ⇅</button>

      <pre class="code-face sql"><code>ON CONFLICT(agent_id) DO UPDATE SET
  agent_type  = COALESCE(excluded.agent_type,  workflow_agents.agent_type),
  description = COALESCE(excluded.description, workflow_agents.description),
  phase       = COALESCE(excluded.phase,       workflow_agents.phase),
  ...</code></pre>

      <div class="merged">
        <span class="rk">workflow_agents</span>
        <ul>
          <li v-for="(v, k) in merged" :key="k">
            {{ k }} = <b>{{ v === null ? 'null' : v }}</b>
          </li>
        </ul>
      </div>

      <p class="verdict">
        两种顺序，同一个结果。<b>顺序无关性不是靠约定，是靠 SQL 语义保证的。</b>
        注意 key 之外的 <code>run_id</code> / <code>session_id</code> 没有包 COALESCE——它们是必填的，
        任何一个贡献者都知道。<b>哪些列合并、哪些列覆盖，是按「谁一定知道它」划分的。</b>
      </p>
    </section>
  </div>
</template>

<style scoped>
.tabs {
  margin-bottom: 1.1rem;
}

.semantics {
  margin-bottom: 1rem;
}

.acts {
  margin-bottom: 1rem;
}

.row {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  flex-wrap: wrap;
  padding: 0.65rem 0.85rem;
  border: 1px solid var(--edge);
  border-radius: var(--radius-sm);
  background: var(--bg-sunk);
  transition: all 0.2s var(--ease);
}

.row.lost {
  border-color: rgba(248, 113, 113, 0.45);
  background: var(--red-soft);
}

.rk {
  padding: 0.08em 0.45em;
  border-radius: 4px;
  background: rgba(236, 72, 153, 0.12);
  font: 600 0.66rem/1.7 var(--mono);
  color: #f0a5c8;
}

.row code,
.col {
  font: 0.76rem/1.6 var(--mono);
  color: var(--muted);
}

.col {
  margin-left: auto;
}

.col b {
  color: var(--green);
  font-variant-numeric: tabular-nums;
}

.col b.null {
  color: var(--dim);
}

.row.lost .col b.null {
  color: var(--red);
}

.log {
  margin: 0.85rem 0 0;
  padding: 0;
  list-style: none;
}

.log li {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  padding: 0.35rem 0.6rem;
  margin-bottom: 0.25rem;
  border-left: 2px solid var(--edge-hi);
  background: rgba(255, 255, 255, 0.015);
}

.log li.bad {
  border-left-color: var(--red);
  background: var(--red-soft);
}

.log code {
  font: 0.7rem/1.6 var(--mono);
  color: var(--fg-soft);
}

.log span {
  font-size: 0.75rem;
  color: var(--faint);
}

.log li.bad span {
  color: var(--red);
}

.idle,
.intro {
  margin-top: 0.85rem;
  font-size: 0.84rem;
  line-height: 1.75;
  color: var(--muted);
}

.verdict {
  margin-top: 1rem;
  padding-top: 0.85rem;
  border-top: 1px solid var(--edge);
  font-size: 0.86rem;
  line-height: 1.8;
  color: var(--fg-soft);
}

.verdict.bad {
  color: var(--red);
}

.verdict b {
  color: var(--fg);
}

.verdict code {
  padding: 0.05em 0.35em;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.05);
  font-family: var(--mono);
  font-size: 0.85em;
  color: var(--accent);
}

/* ---- coalesce ---- */
.units {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.6rem;
  margin: 0.9rem 0 0.7rem;
}

.unit {
  padding: 0.65rem 0.8rem;
  border: 1px solid var(--edge);
  border-radius: var(--radius-sm);
  background: var(--bg-sunk);
}

.unit header {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  margin-bottom: 0.25rem;
}

.seq {
  width: 1.15rem;
  height: 1.15rem;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--accent-soft);
  font: 600 0.65rem/1 var(--mono);
  color: var(--accent);
}

.unit header code {
  font: 0.71rem/1.5 var(--mono);
  color: var(--fg);
  word-break: break-all;
}

.what {
  font-size: 0.74rem;
  color: var(--faint);
}

.unit ul,
.merged ul {
  margin: 0.45rem 0 0;
  padding: 0;
  list-style: none;
}

.unit li,
.merged li {
  font: 0.7rem/1.75 var(--mono);
  color: var(--muted);
}

.unit li.null {
  color: var(--dim);
}


.sql {
  margin: 0.8rem 0;
  padding: 0.7rem 0.85rem;
  border: 1px solid var(--edge);
  border-radius: var(--radius-sm);
  background: var(--bg-sunk);
  overflow-x: auto;
}

.sql code {
  font: inherit;
  color: var(--fg-soft);
  white-space: pre;
}

.merged {
  padding: 0.65rem 0.85rem;
  border: 1px solid var(--accent-line);
  border-radius: var(--radius-sm);
  background: rgba(167, 139, 250, 0.06);
}

.merged li b {
  color: var(--accent);
}

@media (max-width: 700px) {
  .units {
    grid-template-columns: 1fr;
  }
}
</style>
