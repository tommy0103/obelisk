<script setup>
// Ten tables, sorted by the only question that matters in a failure: can this
// be recomputed? The 「强制重建」 toggle plays that classification out — eight
// tables vanish and come back, one survives untouched, one is reset except for
// a single key.

import { computed, ref } from 'vue';

const TABLES = [
  { name: 'sessions', cls: 'evidence', cols: ['id', 'title', 'project', 'project_path', 'started_at', 'ended_at', 'message_count', 'jsonl_path', 'source'], by: 'session', note: 'project_path 不由适配器决定——权威值是收尾阶段从已入库消息的 cwd 统计出来的。' },
  { name: 'messages', cls: 'evidence', cols: ['uuid', 'session_id', 'role', 'text', 'content_type', 'is_meta', 'visibility', 'agent_id', 'cwd', 'turn_duration_ms', 'source'], by: 'message · message-turn-duration', note: '19 列，但 upsert 只写 18 列——turn_duration_ms 由另一种记录负责。' },
  { name: 'tool_calls', cls: 'evidence', cols: ['id', 'message_uuid', 'session_id', 'name', 'presentation', 'input_json', 'file_path'], by: 'tool_call', note: '这张表没有时间戳，排序必须 JOIN 回 messages。' },
  { name: 'tool_results', cls: 'evidence', cols: ['tool_use_id', 'message_uuid', 'session_id', 'content', 'is_error'], by: 'tool_result' },
  { name: 'subagents', cls: 'evidence', cols: ['agent_id', 'session_id', 'agent_type', 'description', 'duration_ms', 'tokens'], by: 'subagent', note: '只有元数据。对话内容在 messages 里靠 agent_id 归属。' },
  { name: 'workflows', cls: 'evidence', cols: ['run_id', 'session_id', 'parent_tool_use_id', 'script', 'agent_count'], by: 'workflow' },
  { name: 'workflow_agents', cls: 'evidence', cols: ['agent_id', 'run_id', 'session_id', 'agent_type', 'description', 'phase', 'model', 'state', 'tokens'], by: 'workflow_agent', note: '一行由两个独立单元拼成，所以除三个 ID 外全部可选，靠 COALESCE 按列合并。' },
  { name: 'summaries', cls: 'evidence', cols: ['id', 'session_id', 'text', 'timestamp'], by: 'summary' },
  { name: 'memories', cls: 'memory', cols: ['id', 'session_id', 'project', 'message_start', 'message_end', 'path', 'anchors', 'summary', 'created_at', 'deleted_at', 'deleted_reason'], by: 'remember() / forget()', note: '正文不在这里——数据库存的是一条指向 markdown 文件的注册记录。deleted_at 让「忘记」成为归档而不是删除。' },
  { name: 'index_state', cls: 'ledger', cols: ['jsonl_path', 'mtime', 'lines_processed'], by: '游标 · 心跳 · 版本标记', note: '列名叫 jsonl_path，存的却可能是 __app_heartbeat__；列名叫 mtime，存的却是心跳时间戳。一张被当信令板用的表。' },
];

const FTS = [
  { name: 'messages_fts', note: '默认分词器。外部内容表（content=messages），只存倒排索引，正文仍只存一份。' },
  { name: 'memories_fts', note: "tokenize='unicode61 remove_diacritics 1'。配合运行时那道英文闸，记忆层是一个刻意保持单语言的检索面。" },
];

const CLASSES = {
  evidence: { label: '证据表', sub: '源文件的投影，可以完全重建', tone: 'ev' },
  memory: { label: '记忆表', sub: '人批准的产物，无法重建', tone: 'mem' },
  ledger: { label: '簿记表', sub: '索引器自己的状态', tone: 'led' },
};

const picked = ref('messages');
const rebuilt = ref(false);

const item = computed(() => TABLES.find((t) => t.name === picked.value));

const fate = (t) => {
  if (!rebuilt.value) return '';
  if (t.cls === 'evidence') return '清空 → 从当前文件重新索引';
  if (t.cls === 'memory') return '不清';
  return "全清，只保留 __last_build__";
};
</script>

<template>
  <div class="schema">
    <div class="head">
      <button class="btn rebuild" type="button" :class="rebuilt ? 'danger' : ''" @click="rebuilt = !rebuilt">
        {{ rebuilt ? '正在 force rebuild' : '模拟一次 obelisk --build' }}
      </button>
      <p v-if="rebuilt" class="quote">
        <code>memories</code> is the durable, human-approved layer and is never cleared
      </p>
    </div>

    <div v-for="(meta, cls) in CLASSES" :key="cls" class="class" :class="meta.tone">
      <div class="class-head">
        <span class="c-label">{{ meta.label }}</span>
        <span class="c-sub">{{ meta.sub }}</span>
        <span class="c-count">{{ TABLES.filter((t) => t.cls === cls).length }} 张</span>
      </div>
      <div class="chips">
        <button
          v-for="t in TABLES.filter((x) => x.cls === cls)"
          :key="t.name"
          type="button"
          class="chip"
          :class="{ on: picked === t.name, wiped: rebuilt && t.cls === 'evidence', kept: rebuilt && t.cls === 'memory' }"
          @click="picked = t.name"
        >
          {{ t.name }}
          <span v-if="rebuilt" class="fate">{{ fate(t) }}</span>
        </button>
      </div>
    </div>

    <div class="class fts">
      <div class="class-head">
        <span class="c-label">FTS5 虚拟表</span>
        <span class="c-sub">不是第四类——它们是证据表和记忆表的索引</span>
      </div>
      <div class="chips">
        <span v-for="f in FTS" :key="f.name" class="chip static" :title="f.note">{{ f.name }}</span>
      </div>
    </div>

    <div class="detail">
      <div class="d-head">
        <code>{{ item.name }}</code>
        <span class="writer">由 <b>{{ item.by }}</b> 写入</span>
      </div>
      <ul class="cols">
        <li v-for="c in item.cols" :key="c">{{ c }}</li>
      </ul>
      <p v-if="item.note" class="note">{{ item.note }}</p>
    </div>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  align-items: center;
  gap: 0.9rem;
  flex-wrap: wrap;
  margin-bottom: 1rem;
}

.quote {
  flex: 1 1 16rem;
  font: italic 0.78rem/1.6 var(--serif);
  color: var(--muted);
}

.quote code {
  font-family: var(--mono);
  font-style: normal;
  color: var(--green);
}

.class {
  margin-bottom: 0.9rem;
}

.class-head {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
  margin-bottom: 0.4rem;
}

.c-label {
  font: 600 0.78rem/1.6 var(--mono);
}

.ev .c-label { color: var(--accent); }
.mem .c-label { color: var(--green); }
.led .c-label { color: var(--amber); }
.fts .c-label { color: var(--faint); }

.c-sub {
  font-size: 0.74rem;
  color: var(--faint);
}

.c-count {
  margin-left: auto;
  font: 0.68rem/1.6 var(--mono);
  color: var(--dim);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.chip {
  display: inline-flex;
  flex-direction: column;
  gap: 0.05rem;
  padding: 0.26rem 0.6rem;
  border: 1px solid var(--edge);
  border-radius: var(--radius-sm);
  font: 0.73rem/1.5 var(--mono);
  color: var(--muted);
  transition: all 0.2s var(--ease);
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

.chip.static {
  cursor: help;
}

.chip.wiped {
  opacity: 0.42;
  border-style: dashed;
  border-color: rgba(248, 113, 113, 0.4);
}

.chip.kept {
  border-color: var(--green);
  background: var(--green-soft);
  color: var(--green);
}

.fate {
  font-size: 0.6rem;
  color: var(--faint);
}

.detail {
  margin-top: 1rem;
  padding: 0.85rem 0.95rem;
  border: 1px solid var(--edge);
  border-radius: var(--radius-sm);
  background: var(--bg-sunk);
}

.d-head {
  display: flex;
  align-items: baseline;
  gap: 0.7rem;
  flex-wrap: wrap;
  margin-bottom: 0.6rem;
}

.d-head code {
  padding: 0.1em 0.5em;
  border-radius: 5px;
  background: var(--accent-soft);
  font: 0.8rem/1.6 var(--mono);
  color: var(--accent);
}

.writer {
  font: 0.72rem/1.6 var(--mono);
  color: var(--faint);
}

.writer b {
  color: var(--muted);
}

.cols {
  display: flex;
  flex-wrap: wrap;
  gap: 0.28rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.cols li {
  padding: 0.1rem 0.42rem;
  border: 1px solid var(--edge);
  border-radius: 4px;
  font: 0.69rem/1.6 var(--mono);
  color: var(--muted);
}

.note {
  margin-top: 0.65rem;
  font-size: 0.84rem;
  line-height: 1.75;
  color: var(--fg-soft);
}
</style>
