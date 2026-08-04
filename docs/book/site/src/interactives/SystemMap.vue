<script setup>
// The module map, drawn from src/book/modules.js.
//
// Two readings of the same graph, because the book asks you to hold both:
//   flow — where a transcript record travels
//   deps — who imports whom (every arrow converges on providers/types.ts)
//
// The same component is the chapter figure, the standalone /map page, and —
// with `compact` — the rail minimap that lights up as you read.

import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import { EDGES, NODES, NODE_BY_ID, VIEW } from '@/book/modules.js';
import TabBar from '@/components/TabBar.vue';

const MODES = [
  { id: 'flow', label: '数据流向' },
  { id: 'deps', label: '依赖方向' },
];

const props = defineProps({
  mode: { type: String, default: 'flow' },
  compact: { type: Boolean, default: false },
  interactive: { type: Boolean, default: true },
  // Node ids to light up (the current chapter's coverage, or a flow step).
  lit: { type: Array, default: () => [] },
  // Node ids to mark as forbidden — used when a rule is being demonstrated.
  forbid: { type: Array, default: () => [] },
  showLegend: { type: Boolean, default: true },
});

const router = useRouter();
const mode = ref(props.mode);
watch(() => props.mode, (m) => (mode.value = m));

const selected = ref(null);
const hovered = ref(null);

const litSet = computed(() => new Set(props.lit));
const forbidSet = computed(() => new Set(props.forbid));
const dimming = computed(() => litSet.value.size > 0 || forbidSet.value.size > 0);

const edges = computed(() => EDGES[mode.value] || []);

const focus = computed(() => (selected.value ? NODE_BY_ID[selected.value] : null));

// Which edges touch the hovered/selected node — used to keep the arrow set
// legible on a graph this dense.
const activeId = computed(() => hovered.value || selected.value);

const cx = (n) => n.x + n.w / 2;
const cy = (n) => n.y + n.h / 2;

function edgeGeometry(fromId, toId) {
  const a = NODE_BY_ID[fromId];
  const b = NODE_BY_ID[toId];
  if (!a || !b) return null;

  const vertical = b.y > a.y + a.h - 1 || a.y > b.y + b.h - 1;
  if (vertical) {
    const down = b.y > a.y;
    const x1 = cx(a);
    const y1 = down ? a.y + a.h : a.y;
    const x2 = cx(b);
    const y2 = down ? b.y : b.y + b.h;
    const bow = Math.max(18, Math.abs(y2 - y1) * 0.45);
    const d = `M ${x1} ${y1} C ${x1} ${y1 + (down ? bow : -bow)}, ${x2} ${y2 - (down ? bow : -bow)}, ${x2} ${y2}`;
    return { d, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 };
  }

  const right = b.x > a.x;
  const x1 = right ? a.x + a.w : a.x;
  const y1 = cy(a);
  const x2 = right ? b.x : b.x + b.w;
  const y2 = cy(b);
  const bow = Math.max(20, Math.abs(x2 - x1) * 0.4);
  const d = `M ${x1} ${y1} C ${x1 + (right ? bow : -bow)} ${y1}, ${x2 - (right ? bow : -bow)} ${y2}, ${x2} ${y2}`;
  return { d, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 };
}

const drawnEdges = computed(() =>
  edges.value
    .map(([from, to, opts = {}], i) => {
      const geo = edgeGeometry(from, to);
      if (!geo) return null;
      const touched = activeId.value === from || activeId.value === to;
      return { key: `${from}->${to}-${i}`, from, to, ...geo, ...opts, touched };
    })
    .filter(Boolean),
);

function nodeState(node) {
  if (forbidSet.value.has(node.id)) return 'forbid';
  if (litSet.value.has(node.id)) return 'lit';
  if (selected.value === node.id) return 'selected';
  if (dimming.value) return 'dim';
  return 'idle';
}

function pick(node) {
  if (!props.interactive) return;
  selected.value = selected.value === node.id ? null : node.id;
}

function openChapter(slug) {
  router.push(`/ch/${slug}`);
}

const modeCopy = {
  flow: '箭头是一条记录实际走过的路。',
  deps: '箭头是「谁 import 谁」。所有箭头单向，没有回边——出现回边就是在破坏规则。',
};
</script>

<template>
  <figure class="map" :class="{ compact }">
    <div v-if="interactive && !compact" class="modes">
      <TabBar v-model="mode" :tabs="MODES" label="读法" />
      <p class="mode-copy">{{ modeCopy[mode] }}</p>
    </div>

    <svg
      :viewBox="`0 0 ${VIEW.w} ${VIEW.h}`"
      role="img"
      :aria-label="`Obelisk 模块地图（${mode === 'flow' ? '数据流向' : '依赖方向'}）`"
      @mouseleave="hovered = null"
    >
      <defs>
        <marker
          id="arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" />
        </marker>
      </defs>

      <g class="edges">
        <path
          v-for="e in drawnEdges"
          :key="e.key"
          :d="e.d"
          :class="{ dashed: e.dashed, touched: e.touched, faded: activeId && !e.touched }"
          marker-end="url(#arrow)"
        />
      </g>

      <g class="nodes">
        <g
          v-for="n in NODES"
          :key="n.id"
          :class="['node', `layer-${n.layer}`, `state-${nodeState(n)}`, { clickable: interactive }]"
          @mouseenter="hovered = n.id"
          @click="pick(n)"
        >
          <rect :x="n.x" :y="n.y" :width="n.w" :height="n.h" rx="9" />
          <text
            v-if="!compact"
            :x="n.x + n.w / 2"
            :y="n.sub ? n.y + n.h / 2 - (n.sub.includes('\n') ? 14 : 5) : n.y + n.h / 2 + 4"
            class="label"
          >{{ n.label }}</text>
          <text
            v-for="(line, li) in (compact || !n.sub ? [] : n.sub.split('\n'))"
            :key="li"
            :x="n.x + n.w / 2"
            :y="n.y + n.h / 2 + 11 + li * 13"
            class="sub"
          >{{ line }}</text>
          <title>{{ n.label }} — {{ n.blurb }}</title>
        </g>
      </g>
    </svg>

    <transition name="fade">
      <div v-if="focus && !compact" class="detail">
        <div class="detail-head">
          <span class="pill">{{ focus.label }}</span>
          <button class="close" type="button" @click="selected = null">关闭</button>
        </div>
        <p>{{ focus.blurb }}</p>
        <button v-if="focus.chapter" class="jump" type="button" @click="openChapter(focus.chapter)">
          去读这一章 →
        </button>
      </div>
    </transition>

    <p v-if="showLegend && !compact" class="legend">
      <span class="dot src" /> 外部转写
      <span class="dot prov" /> Provider 轴
      <span class="dot pivot" /> 共同语言
      <span class="dot cons" /> 消费者
      <span class="dot store" /> 索引文件
      <span class="hint">点任意部件看它做什么。</span>
    </p>
  </figure>
</template>

<style scoped>
.map {
  position: relative;
  margin: 0;
}

svg {
  display: block;
  width: 100%;
  height: auto;
  overflow: visible;
}

/* ---- modes ---- */
.modes {
  margin-bottom: 1.1rem;
}

.mode-copy {
  margin-top: 0.6rem;
  font-size: 0.78rem;
  line-height: 1.6;
  color: var(--faint);
}

/* ---- edges ---- */
.edges path {
  fill: none;
  stroke: rgba(255, 255, 255, 0.17);
  stroke-width: 1.4;
  transition: stroke 0.18s var(--ease), opacity 0.18s var(--ease);
}

.edges path.dashed {
  stroke-dasharray: 4 4;
}

.edges path.touched {
  stroke: var(--accent);
  stroke-width: 2;
}

.edges path.faded {
  opacity: 0.25;
}

marker path {
  fill: rgba(255, 255, 255, 0.3);
}

/* ---- nodes ---- */
.node rect {
  fill: rgba(255, 255, 255, 0.035);
  stroke: var(--edge-hi);
  stroke-width: 1;
  transition: all 0.2s var(--ease);
}

.node.clickable {
  cursor: pointer;
}

.label {
  fill: var(--fg);
  font: 600 12.5px var(--mono);
  text-anchor: middle;
  pointer-events: none;
}

.sub {
  fill: var(--faint);
  font: 10.5px var(--sans);
  text-anchor: middle;
  pointer-events: none;
}

.compact .node rect {
  stroke-width: 0.8;
}

/* layer tints */
.layer-source rect { fill: rgba(255, 255, 255, 0.02); stroke-dasharray: 3 3; }
.layer-provider rect { fill: rgba(167, 139, 250, 0.06); }
.layer-pivot rect {
  fill: rgba(167, 139, 250, 0.13);
  stroke: var(--accent-line);
  stroke-width: 1.6;
}
.layer-consumer rect { fill: rgba(99, 102, 241, 0.08); }
.layer-store rect { fill: rgba(236, 72, 153, 0.08); stroke: rgba(236, 72, 153, 0.28); }
.layer-shell rect { fill: rgba(255, 255, 255, 0.028); }
.layer-side rect { fill: rgba(255, 255, 255, 0.02); stroke-dasharray: 2 4; }

/* states */
.node.state-dim { opacity: 0.28; }
.node.state-lit rect {
  fill: rgba(167, 139, 250, 0.2);
  stroke: var(--accent);
  stroke-width: 1.8;
}
.node.state-selected rect {
  stroke: var(--accent);
  stroke-width: 2;
}
.node.state-forbid rect {
  fill: rgba(248, 113, 113, 0.12);
  stroke: var(--red);
  stroke-dasharray: 5 3;
}
.node:hover rect {
  fill: rgba(255, 255, 255, 0.09);
  stroke: var(--accent);
}

/* ---- detail ---- */
.detail {
  margin-top: 1rem;
  padding: 0.9rem 1rem;
  border: 1px solid var(--accent-line);
  border-radius: var(--radius-sm);
  background: rgba(167, 139, 250, 0.06);
}

.detail-head {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-bottom: 0.5rem;
}

.detail .pill {
  font-family: var(--mono);
  text-transform: none;
  color: var(--accent);
}

.close,
.jump {
  font: 0.72rem/1.6 var(--mono);
  color: var(--faint);
}

.close {
  margin-left: auto;
}

.close:hover {
  color: var(--fg);
}

.detail p {
  font-size: 0.87rem;
  line-height: 1.7;
  color: var(--fg-soft);
}

.jump {
  margin-top: 0.6rem;
  color: var(--accent);
}

.jump:hover {
  text-decoration: underline;
}

/* ---- legend ---- */
.legend {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  flex-wrap: wrap;
  margin-top: 0.9rem;
  font: 0.72rem/1.8 var(--mono);
  color: var(--faint);
}

.dot {
  width: 9px;
  height: 9px;
  margin-left: 0.7rem;
  border: 1px solid var(--edge-hi);
  border-radius: 3px;
}

.dot:first-child {
  margin-left: 0;
}

.dot.src { background: rgba(255, 255, 255, 0.06); }
.dot.prov { background: rgba(167, 139, 250, 0.35); }
.dot.pivot { background: rgba(167, 139, 250, 0.7); }
.dot.cons { background: rgba(99, 102, 241, 0.5); }
.dot.store { background: rgba(236, 72, 153, 0.5); }

.hint {
  margin-left: auto;
  color: var(--dim);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.16s var(--ease);
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
