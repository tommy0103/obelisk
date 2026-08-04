<script setup>
// The whole public surface, in one picture: four verbs, and the two sandbox
// APIs that do not intersect.
//
// The empty intersection is the thing worth seeing. `--attune` cannot even call
// `memories()` — which reads like a design gap until you remember that a memory
// write has to be short enough for a person to approve at a glance.

import { computed, ref } from 'vue';

const VERBS = [
  {
    id: 'build',
    cmd: 'obelisk --build',
    sig: 'build',
    what: '重建索引。发现 → 解析 → 落库 → 收尾。',
    api: null,
    note: '另外三个动词的第一句都是 buildIndex()——没有独立的「同步」动作。',
  },
  {
    id: 'search',
    cmd: 'obelisk --search "text"',
    sig: 'search(text)',
    what: '全文检索。它不走沙箱，因为参数是一个字符串而不是一段代码。',
    api: 'query',
    note: '它是 query 的一个便捷特例，不是独立的能力。',
  },
  {
    id: 'query',
    cmd: 'obelisk --query <file.js>',
    sig: 'query(code)',
    what: '在 node:vm 沙箱里执行一段只读脚本，返回 JSON。',
    api: 'query',
    note: '参数是代码，不是查询条件。这是 Obelisk 最核心的设计选择。',
  },
  {
    id: 'attune',
    cmd: 'obelisk --attune <file.js>',
    sig: 'attune(code)',
    what: '在另一个沙箱里执行一段记忆写入脚本。',
    api: 'attune',
    note: '开的是可写连接，注入的是另一套 API。',
  },
];

const QUERY_API = [
  'sql', 'search', 'context', 'trace', 'thread', 'subagents', 'workflows', 'workflowTree',
  'fileHistory', 'failures', 'sessions', 'recent', 'summaries', 'raw', 'memories', 'overview',
];
const ATTUNE_API = ['remember', 'forget'];

const picked = ref('query');
const verb = computed(() => VERBS.find((v) => v.id === picked.value));
const lit = computed(() => verb.value.api);
</script>

<template>
  <div class="two">
    <div class="verbs">
      <button
        v-for="v in VERBS"
        :key="v.id"
        type="button"
        :class="{ on: picked === v.id }"
        @click="picked = v.id"
      >
        <code>{{ v.sig }}</code>
      </button>
      <span class="aside">还有 <code>obelisk install</code>，它把安装工作转包给 skills 安装器。</span>
    </div>

    <div class="say">
      <code class="cmd">{{ verb.cmd }}</code>
      <p class="what">{{ verb.what }}</p>
      <p class="note">{{ verb.note }}</p>
    </div>

    <div class="apis">
      <section class="api" :class="{ lit: lit === 'query' }">
        <header>
          <code>createQueryApi(db)</code>
          <span>16 个 helper · 只读连接</span>
        </header>
        <div class="chips">
          <span v-for="h in QUERY_API" :key="h" class="chip">{{ h }}</span>
        </div>
      </section>

      <div class="gap">
        <span class="gap-mark">∅</span>
        <span class="gap-label">没有交集</span>
      </div>

      <section class="api" :class="{ lit: lit === 'attune' }">
        <header>
          <code>createAttuneApi(db)</code>
          <span>2 个 API · 可写连接</span>
        </header>
        <div class="chips">
          <span v-for="h in ATTUNE_API" :key="h" class="chip write">{{ h }}</span>
        </div>
      </section>
    </div>

    <p class="closing">
      想写一条记忆，你得先用 <code>--query</code> 查出需要的 ID，再用 <code>--attune</code> 单独提交一段窄脚本。
      <b>这个不便是刻意的</b>——如果 attune 沙箱里有完整的检索能力，一段「写记忆」的脚本可以长成任意复杂的程序，人就没法审了。
    </p>
  </div>
</template>

<style scoped>
.verbs {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.verbs button {
  padding: 0.3rem 0.7rem;
  border: 1px solid var(--edge);
  border-radius: var(--radius-sm);
  transition: all 0.15s var(--ease);
}

.verbs button code {
  font: 0.76rem/1.6 var(--mono);
  color: var(--muted);
}

.verbs button:hover {
  border-color: var(--edge-hi);
}

.verbs button:hover code {
  color: var(--fg);
}

.verbs button.on {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.verbs button.on code {
  color: var(--accent);
}

.aside {
  flex: 1 1 100%;
  margin-top: 0.3rem;
  font-size: 0.74rem;
  color: var(--dim);
}

.aside code {
  font-family: var(--mono);
}

.say {
  margin: 0.9rem 0 1.1rem;
  padding: 0.75rem 0.95rem;
  border-left: 2px solid var(--accent);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  background: rgba(167, 139, 250, 0.06);
}

.cmd {
  font: 0.8rem/1.6 var(--mono);
  color: var(--accent);
}

.what {
  margin-top: 0.35rem;
  font-size: 0.87rem;
  line-height: 1.7;
  color: var(--fg-soft);
}

.note {
  margin-top: 0.25rem;
  font-size: 0.8rem;
  line-height: 1.7;
  color: var(--muted);
}

.apis {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  gap: 0.7rem;
  align-items: stretch;
}

.api {
  padding: 0.75rem 0.85rem 0.85rem;
  border: 1px solid var(--edge);
  border-radius: var(--radius-sm);
  background: var(--bg-sunk);
  transition: all 0.2s var(--ease);
}

.api.lit {
  border-color: var(--accent);
  background: rgba(167, 139, 250, 0.07);
}

.api header {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  margin-bottom: 0.55rem;
}

.api header code {
  font: 600 0.76rem/1.6 var(--mono);
  color: var(--fg);
}

.api header span {
  font: 0.67rem/1.6 var(--mono);
  color: var(--faint);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}

.chip {
  padding: 0.1rem 0.42rem;
  border: 1px solid var(--edge);
  border-radius: 4px;
  font: 0.68rem/1.6 var(--mono);
  color: var(--muted);
}

.chip.write {
  border-color: rgba(245, 158, 11, 0.4);
  color: var(--amber);
}

.gap {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.2rem;
  padding: 0 0.2rem;
}

.gap-mark {
  font: 1.1rem/1 var(--mono);
  color: var(--dim);
}

.gap-label {
  font: 0.62rem/1.4 var(--mono);
  color: var(--dim);
  writing-mode: vertical-rl;
}

.closing {
  margin-top: 1rem;
  font-size: 0.86rem;
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

.closing b {
  color: var(--fg);
}

@media (max-width: 720px) {
  .apis {
    grid-template-columns: 1fr;
  }

  .gap-label {
    writing-mode: horizontal-tb;
  }

  .gap {
    flex-direction: row;
  }
}
</style>
