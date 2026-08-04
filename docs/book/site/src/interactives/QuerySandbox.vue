<script setup>
// A real CodeAct sandbox, running against a miniature in-page index.
//
// The point is not the toy data — it is the byte meter. `search(...)` returns
// whole messages; `search(...).map(h => ({ uuid, snippet }))` returns a
// fraction of that. In the real system those bytes are the agent's context
// window, and the difference is the entire argument for CodeAct over a set of
// retrieval tools. Here you can watch the number drop.
//
// `sql()` throws on purpose: there is no SQLite in a browser, and pretending
// otherwise would teach the wrong shape.

import { computed, ref } from 'vue';

import { createSandboxApi, HELPER_NAMES, MEMORIES, MESSAGES, SESSIONS } from '@/book/fixtures.js';
import TabBar from '@/components/TabBar.vue';

const SIZES = {
  sessions: SESSIONS.length,
  messages: MESSAGES.length,
  memories: MEMORIES.length,
  archived: MEMORIES.filter((m) => m.deleted_at).length,
};

const PRESETS = [
  {
    id: 'first',
    label: '第一条查询',
    note: '附录 A 那条。先问「我现在在哪」。',
    code: `const map = overview({ limit: 5 });
return {
  cwd: map.current.cwd,
  project: map.current.project,   // 注意 confidence 字段
  totals: map.totals,
};`,
  },
  {
    id: 'both',
    label: '同时问两层',
    note: '记忆层给先前的结论，证据层给原始现场。这一版不裁剪。',
    code: `const project = overview().current.project.project;

return {
  prior_memories: memories({ project, query: 'auth token refresh', limit: 5 }),
  evidence: search('auth token refresh', { project, limit: 8 }),
};`,
  },
  {
    id: 'trimmed',
    label: '裁剪之后',
    note: '同一个问题，加一行 .map()。看右上角的字节数。',
    code: `const project = overview().current.project.project;

return {
  prior_memories: memories({ project, query: 'auth token refresh', limit: 5 })
    .map(m => ({ id: m.id, path: m.path, summary: m.summary.slice(0, 120) })),
  evidence: search('auth token refresh', { project, limit: 8 }).map(h => ({
    session_id: h.session.id,
    uuid: h.message.uuid,
    snippet: h.message.text?.slice(0, 240),
  })),
};`,
  },
  {
    id: 'chase',
    label: '顺着一条命中往上追',
    note: '多步检索在 CodeAct 里是一个脚本、一次调用、一份结果。',
    code: `const hits = search('rollback transaction', { limit: 3 });

return hits.map(h => ({
  title: h.session.title,
  quote: h.message.text.slice(0, 90),
  // 父链——注意这和 search() 返回的 context（时间邻居）不是一回事
  chain: trace(h.message.uuid).map(p => p.text.slice(0, 60)),
}));`,
  },
  {
    id: 'gate',
    label: '记忆层的语言闸',
    note: '检测到 CJK 直接抛错，而不是静默翻译。',
    code: `// 记忆索引统一用英文，才能被跨语言稳定命中。
return memories({ query: '认证 token 刷新' });`,
  },
];

const activePreset = ref(PRESETS[0].id);
const code = ref(PRESETS[0].code);
const result = ref(null);
const error = ref(null);
const bytes = ref(0);
const peak = ref(0);
const ran = ref(false);

const api = createSandboxApi();

const preset = computed(() => PRESETS.find((p) => p.id === activePreset.value));

const barPct = computed(() => (peak.value ? Math.max(3, (bytes.value / peak.value) * 100) : 0));

const pretty = computed(() => {
  if (result.value === undefined) return 'undefined';
  try {
    return JSON.stringify(result.value, null, 2);
  } catch {
    return String(result.value);
  }
});

function usePreset(id) {
  const next = PRESETS.find((p) => p.id === id);
  if (!next) return;
  activePreset.value = id;
  code.value = next.code;
  result.value = null;
  error.value = null;
  ran.value = false;
}

async function run() {
  error.value = null;
  ran.value = true;
  try {
    // The real runtime wraps the script in an async IIFE inside a fresh vm
    // context. new Function is the closest honest analogue in a browser: the
    // script sees exactly the helpers passed in, and nothing of this module.
    const fn = new Function(...HELPER_NAMES, `"use strict"; return (async () => {\n${code.value}\n})();`);
    const value = await fn(...HELPER_NAMES.map((n) => api[n]));
    result.value = value;
    const size = new TextEncoder().encode(JSON.stringify(value ?? null)).length;
    bytes.value = size;
    peak.value = Math.max(peak.value, size);
  } catch (e) {
    result.value = null;
    bytes.value = 0;
    error.value = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
}

function onKeydown(event) {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    run();
  }
}
</script>

<template>
  <div class="sandbox">
    <TabBar :model-value="activePreset" :tabs="PRESETS" label="示例查询" @update:model-value="usePreset" />
    <p class="preset-note">{{ preset?.note }}</p>

    <div class="split">
      <div class="editor">
        <div class="bar">
          <span class="who">你的脚本</span>
          <span class="globals">{{ HELPER_NAMES.join(' · ') }}</span>
        </div>
        <textarea
          v-model="code"
          class="code-face"
          spellcheck="false"
          aria-label="查询脚本"
          @keydown="onKeydown"
        />
        <div class="run-row">
          <button class="btn primary run" type="button" @click="run">运行</button>
          <span class="hint"><span class="kbd">⌘</span><span class="kbd">↵</span></span>
        </div>
      </div>

      <div class="out">
        <div class="bar">
          <span class="who">返回值</span>
          <span v-if="ran && !error" class="meter">
            回到 context 的 <b>{{ bytes.toLocaleString() }}</b> 字节
          </span>
        </div>
        <div v-if="peak && ran && !error" class="gauge">
          <div class="fill" :style="{ width: `${barPct}%` }" />
          <span class="gauge-cap">本次会话峰值 {{ peak.toLocaleString() }}</span>
        </div>
        <pre v-if="error" class="code-face err">{{ error }}</pre>
        <pre v-else-if="ran" class="code-face"><code>{{ pretty }}</code></pre>
        <p v-else class="idle">按「运行」看结果。脚本在浏览器里真的执行，helper 是真实现。</p>
      </div>
    </div>

    <p class="caveat">
      这个页内索引只有 {{ SIZES.sessions }} 个 session、{{ SIZES.messages }} 条消息、{{ SIZES.memories }} 条记忆（其中
      {{ SIZES.archived }} 条已归档）。
      <code>sql()</code> 在这里会抛错——浏览器里没有 SQLite，其余 helper 全部可用。
    </p>
  </div>
</template>

<style scoped>
.preset-note {
  margin: 0.65rem 0 0.95rem;
  font-size: 0.79rem;
  line-height: 1.6;
  color: var(--faint);
}

.split {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.8rem;
}

.editor,
.out {
  min-width: 0;
  border: 1px solid var(--edge);
  border-radius: var(--radius-sm);
  background: var(--bg-sunk);
  overflow: hidden;
}

.bar {
  display: flex;
  align-items: baseline;
  gap: 0.7rem;
  padding: 0.42rem 0.75rem;
  border-bottom: 1px solid var(--edge);
  background: rgba(255, 255, 255, 0.018);
}

.who {
  font: 600 0.64rem/1.7 var(--mono);
  letter-spacing: 0.13em;
  text-transform: uppercase;
  color: var(--faint);
}

.globals {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: 0.63rem/1.7 var(--mono);
  color: var(--dim);
}

.meter {
  margin-left: auto;
  font: 0.68rem/1.7 var(--mono);
  color: var(--muted);
  white-space: nowrap;
}

.meter b {
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.gauge {
  position: relative;
  height: 3px;
  background: rgba(255, 255, 255, 0.05);
}

.fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent-deep), var(--pink));
  transition: width 0.35s var(--ease);
}

.gauge-cap {
  position: absolute;
  right: 0.55rem;
  top: 6px;
  font: 0.6rem/1 var(--mono);
  color: var(--dim);
}

textarea {
  display: block;
  width: 100%;
  min-height: 15rem;
  padding: 0.85rem 0.95rem;
  border: 0;
  background: none;
  color: var(--fg-soft);
  resize: vertical;
  outline: none;
}

.run-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.5rem 0.75rem;
  border-top: 1px solid var(--edge);
}

.hint {
  display: flex;
  gap: 0.2rem;
  opacity: 0.6;
}

.out pre {
  max-height: 19rem;
  margin: 0;
  padding: 0.85rem 0.95rem;
  overflow: auto;
}

.out code {
  font: inherit;
  color: var(--fg-soft);
  white-space: pre;
}

.err {
  color: var(--red);
  white-space: pre-wrap;
}

.idle {
  padding: 1.4rem 0.9rem;
  font-size: 0.8rem;
  line-height: 1.7;
  color: var(--dim);
}

.caveat {
  margin-top: 0.85rem;
  font-size: 0.76rem;
  line-height: 1.7;
  color: var(--dim);
}

.caveat code {
  padding: 0.05em 0.35em;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.05);
  font-family: var(--mono);
}

@media (max-width: 820px) {
  .split {
    grid-template-columns: 1fr;
  }
}
</style>
