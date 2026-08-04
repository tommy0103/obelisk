<script setup>
// Why the live-refresh fingerprint includes position.
//
// Turn position off and insert a row: the patch comes back empty even though
// every row moved. That is the failure mode the second half of the fingerprint
// exists to prevent — the rendered order silently goes wrong.

import { computed, ref } from 'vue';

const START = [
  { uuid: 'm-0001', text: 'auth token 在并发刷新时会拿到过期的那一份' },
  { uuid: 'm-0002', text: 'refreshToken() 在读取和写入之间没有任何互斥' },
  { uuid: 'm-0003', text: '改成把整个 refresh 收敛到一个 in-flight promise 上' },
  { uuid: 'm-0004', text: '那如果第一个请求失败了呢' },
];

// Not a cryptographic hash — this only needs to detect change. The real one is
// a double FNV variant with the serialized length prefixed.
function rowHash(row) {
  const s = JSON.stringify(row);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${s.length.toString(16)}:${(h >>> 0).toString(16).padStart(8, '0')}`;
}

const withPosition = ref(true);
const rows = ref(START.map((r) => ({ ...r })));
const previous = ref(null);
const patch = ref(null);

const fingerprint = (row, i) =>
  withPosition.value ? `${i.toString(36)}@${rowHash(row)}` : rowHash(row);

const current = computed(() => rows.value.map((r, i) => ({ ...r, fp: fingerprint(r, i) })));

function snapshot() {
  const prev = previous.value;
  const now = Object.fromEntries(current.value.map((r) => [r.uuid, r.fp]));
  if (!prev) {
    previous.value = now;
    patch.value = { changed: current.value.map((r) => r.uuid), removed: [], first: true };
    return;
  }
  const changed = current.value.filter((r) => prev[r.uuid] !== r.fp).map((r) => r.uuid);
  const removed = Object.keys(prev).filter((id) => !(id in now));
  previous.value = now;
  patch.value = { changed, removed, first: false };
}

function edit() {
  rows.value = rows.value.map((r) =>
    r.uuid === 'm-0002' ? { ...r, text: `${r.text}（改过）` } : r,
  );
}

function insert() {
  rows.value = [{ uuid: 'm-0000', text: '（新到达的一条，排在最前面）' }, ...rows.value];
}

function reset() {
  rows.value = START.map((r) => ({ ...r }));
  previous.value = null;
  patch.value = null;
}

function toggleFingerprint() {
  withPosition.value = !withPosition.value;
  reset();
}

const inPatch = (uuid) => patch.value?.changed.includes(uuid);

const broken = computed(
  () => !withPosition.value && patch.value && !patch.value.first && patch.value.changed.length <= 1
    && rows.value.length > START.length,
);
</script>

<template>
  <div class="patch">
    <div class="controls">
      <button class="btn fp-toggle" type="button" :class="withPosition ? 'primary' : 'danger'" @click="toggleFingerprint">
        指纹 = {{ withPosition ? '位置 + 内容' : '只有内容' }}
      </button>
      <div class="btn-row acts">
        <button class="btn" type="button" @click="edit">改一条的内容</button>
        <button class="btn" type="button" @click="insert">在最前面插入一条</button>
        <button class="btn primary" type="button" @click="snapshot">重新取快照 → 算补丁</button>
        <button class="btn quiet" type="button" @click="reset">重置</button>
      </div>
    </div>

    <table>
      <thead>
        <tr><th>#</th><th>uuid</th><th>内容</th><th>指纹</th></tr>
      </thead>
      <tbody>
        <tr v-for="(r, i) in current" :key="r.uuid" :class="{ hit: inPatch(r.uuid) }">
          <td class="n">{{ i }}</td>
          <td><code>{{ r.uuid }}</code></td>
          <td class="tx">{{ r.text }}</td>
          <td><code class="fp">{{ r.fp }}</code></td>
        </tr>
      </tbody>
    </table>

    <div v-if="patch" class="result" :class="{ broken }">
      <p class="line">
        补丁：<b>{{ patch.changed.length }}</b> 行重传<span v-if="patch.removed.length">，{{ patch.removed.length }} 行删除</span>
        <span v-if="patch.first" class="first">（第一次快照，全部算新增）</span>
      </p>
      <p v-if="broken" class="warn">
        每一行都前移了一位，但内容没变——所以补丁是空的，渲染层不知道顺序变了。
        <b>界面上的顺序会错。</b>这就是位置必须进指纹的原因。
      </p>
      <p v-else-if="!patch.first" class="ok">
        位置和内容都进指纹：行内容变了要重传，行位置变了也要重传。
      </p>
    </div>
    <p v-else class="idle">先点「重新取快照」建立基线，再改点什么，然后再取一次。</p>
  </div>
</template>

<style scoped>
.controls {
  display: flex;
  gap: 0.9rem;
  flex-wrap: wrap;
  align-items: center;
  margin-bottom: 0.9rem;
}

table {
  width: 100%;
  border-collapse: collapse;
  border: 1px solid var(--edge);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

th {
  padding: 0.4rem 0.6rem;
  text-align: left;
  background: rgba(255, 255, 255, 0.02);
  font: 600 0.64rem/1.7 var(--mono);
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--faint);
}

td {
  padding: 0.4rem 0.6rem;
  border-top: 1px solid var(--edge);
  font-size: 0.76rem;
  color: var(--muted);
  vertical-align: top;
}

td.n {
  font: 0.7rem/1.6 var(--mono);
  color: var(--dim);
}

td code {
  font: 0.69rem/1.6 var(--mono);
  color: var(--muted);
}

td .fp {
  color: var(--accent);
}

td.tx {
  line-height: 1.55;
}

tr.hit td {
  background: rgba(167, 139, 250, 0.1);
}

tr.hit td .fp {
  color: var(--fg);
}

.result {
  margin-top: 0.9rem;
  padding: 0.7rem 0.9rem;
  border-left: 2px solid var(--accent);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  background: rgba(167, 139, 250, 0.06);
}

.result.broken {
  border-left-color: var(--red);
  background: var(--red-soft);
}

.line {
  font: 0.82rem/1.6 var(--mono);
  color: var(--fg);
}

.line b {
  color: var(--accent);
}

.first {
  color: var(--dim);
}

.warn,
.ok {
  margin-top: 0.35rem;
  font-size: 0.83rem;
  line-height: 1.75;
}

.warn {
  color: var(--red);
}

.warn b {
  color: var(--fg);
}

.ok {
  color: var(--fg-soft);
}

.idle {
  margin-top: 0.9rem;
  font-size: 0.82rem;
  color: var(--dim);
}
</style>
