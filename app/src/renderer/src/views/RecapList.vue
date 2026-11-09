<!-- Copyright (C) 2026 tommy0103 and contributors. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

<script setup>
import { ref, computed, onMounted, onUnmounted, inject } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { PALETTES, ARCH_KEYS } from '../components/recap/archetypes.js';
import { CORNER_SEALS } from '../components/recap/seals.js';

defineOptions({ name: 'RecapList' });

const router = useRouter();
const route = useRoute();
const recaps = ref([]);
const recapsLoaded = ref(false);
const kind = computed(() => route.query.kind || 'weekly');
const showGenerate = inject('recapGenerateOpen', ref(false));

const filtered = computed(() => recaps.value.filter(r => r.kind === kind.value));
const byYear = computed(() => {
  const map = {};
  for (const r of filtered.value) {
    const y = r.period?.start?.slice(0, 4) || '?';
    if (!map[y]) map[y] = [];
    map[y].push(r);
  }
  return Object.entries(map).sort((a, b) => b[0] - a[0]);
});

function glowColor(arch) {
  return PALETTES[arch]?.glow || PALETTES.architect.glow;
}
function sealSvg(arch) {
  return CORNER_SEALS[arch] || CORNER_SEALS.architect;
}
function formatDateRange(r) {
  if (!r.period) return '';
  const s = new Date(r.period.start);
  const e = new Date(r.period.end);
  const mo = s.toLocaleString('en', { month: 'short' });
  return `${mo} ${s.getDate()} – ${e.getDate()}`;
}
function formatTokens(n) {
  if (!n) return '';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(n);
}

function openRecap(filename) {
  router.push(`/recap/${encodeURIComponent(filename)}`);
}

const generateOptions = [
  { key: 'this-week', label: 'This week' },
  { key: 'last-week', label: 'Last week' },
  { key: 'this-month', label: 'This month' },
  { key: 'last-month', label: 'Last month' },
];
const CMDS = {
  'this-week': '/obelisk recap this week',
  'last-week': '/obelisk recap last week',
  'this-month': '/obelisk recap this month',
  'last-month': '/obelisk recap last month',
};
const generateWindow = ref('this-week');
const generateCmd = computed(() => CMDS[generateWindow.value]);
const cmdCopied = ref(false);
async function copyCmd() {
  try {
    await navigator.clipboard.writeText(generateCmd.value);
    cmdCopied.value = true;
    setTimeout(() => { cmdCopied.value = false; }, 1600);
  } catch {}
}

async function loadRecaps() {
  if (!window.obelisk?.recapList) return;
  const files = await window.obelisk.recapList();
  const results = [];
  for (const f of files) {
    const data = await window.obelisk.recapRead(f);
    if (data?.cards) results.push({ ...data, _filename: f });
  }
  recaps.value = results;
  recapsLoaded.value = true;
}

let unsub;
onMounted(async () => {
  await loadRecaps();
  if (window.obelisk?.onRecapUpdated) {
    unsub = window.obelisk.onRecapUpdated(() => loadRecaps());
  }
});
onUnmounted(() => { unsub?.(); });
</script>

<template>
  <div class="recap-list">
    <div class="content-wrap">
      <div class="content" v-if="filtered.length">
        <section v-for="[year, items] in byYear" :key="year" class="tl-section">
          <div class="tl-section-head">
            <span class="year">{{ year }}</span>
            <span class="span">{{ items.length }} {{ items.length === 1 ? 'recap' : 'recaps' }}</span>
          </div>
          <div class="timeline">
            <div
              v-for="r in items" :key="r._filename"
              class="recap-row"
              :style="{ '--node-glow': glowColor(r.persona?.archetype) }"
              @click="openRecap(r._filename)"
            >
              <div class="recap-node" v-html="sealSvg(r.persona?.archetype)"></div>
              <div class="recap-card">
                <div class="recap-body">
                  <div class="recap-period">
                    <span>{{ r.period?.label }}</span>
                    <span class="dot"></span>
                    <span>{{ formatDateRange(r) }}</span>
                  </div>
                  <div class="recap-archetype">{{ r.persona?.title }}</div>
                  <div class="recap-subtitle">{{ r.persona?.claim || r.persona?.subtitle }}</div>
                  <div class="recap-stats">
                    <span>{{ r.metrics?.sessions || 0 }} sessions</span>
                    <span class="sep">·</span>
                    <span>{{ formatTokens(r.metrics?.tokens) }} tokens</span>
                  </div>
                </div>
                <div class="recap-right">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M6 4l4 4-4 4"/>
                  </svg>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>

      <div class="content empty-content" v-else-if="recapsLoaded">
        <section class="tl-section">
          <div class="tl-section-head">
            <span class="year">No {{ kind }} recaps yet</span>
            <span class="span">the timeline is waiting</span>
          </div>

          <div class="empty-timeline">
            <div class="empty-row placeholder">
              <div class="empty-node"></div>
              <div class="empty-card"></div>
            </div>
            <div class="empty-row placeholder">
              <div class="empty-node"></div>
              <div class="empty-card"></div>
            </div>
            <div class="empty-row">
              <div class="empty-node"></div>
              <div class="empty-cta">
                <div class="empty-eyebrow">
                  <span class="diamond"></span>
                  <span>Nothing carved yet</span>
                </div>
                <div class="empty-title">A recap is something you carve at the end of a stretch of work.</div>
                <div class="empty-body">
                  Obelisk doesn't generate one for you automatically — it waits until you ask. Run <code>/obelisk recap this week</code> in Claude Code, and the result will land here as the first marker on this line.
                </div>
                <div class="empty-actions">
                  <button class="toolbar-action primary" @click="showGenerate = true">
                    <span class="plus">+</span>
                    <span>Generate {{ kind }} recap</span>
                  </button>
                </div>
              </div>
            </div>
            <div class="empty-row placeholder">
              <div class="empty-node"></div>
              <div class="empty-card"></div>
            </div>
            <div class="empty-row placeholder">
              <div class="empty-node"></div>
              <div class="empty-card"></div>
            </div>
          </div>
        </section>
      </div>
    </div>

    <!-- Generate modal -->
    <div class="modal-backdrop" v-if="showGenerate" @click.self="showGenerate = false">
      <div class="modal">
        <div class="modal-head">
          <span class="diamond"></span>
          <span class="title">Generate a new recap</span>
          <button class="modal-close" @click="showGenerate = false">
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
              <path d="M3 3l6 6M9 3l-6 6"/>
            </svg>
          </button>
        </div>
        <div class="modal-body">
          <p>Recaps are generated by Claude Code. Run the command below in your terminal — Obelisk will pick it up automatically.</p>
          <div class="modal-options">
            <button
              v-for="opt in generateOptions" :key="opt.key"
              class="modal-option" :class="{ active: generateWindow === opt.key }"
              @click="generateWindow = opt.key"
            >
              <span class="modal-option-radio"></span>
              <span class="modal-option-label">{{ opt.label }}</span>
            </button>
          </div>
          <div class="cmd-block">
            <code><span class="prompt">$</span> {{ generateCmd }}</code>
            <button class="cmd-copy" :class="{ copied: cmdCopied }" @click="copyCmd">
              <svg v-if="!cmdCopied" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">
                <rect x="3" y="3" width="9" height="9" rx="1.5"/>
                <path d="M5 3V2a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-1"/>
              </svg>
              <svg v-else viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 8l3 3 7-7"/>
              </svg>
            </button>
          </div>
          <div class="modal-hint">Generation takes ~30s. New recaps appear in this list automatically.</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.recap-list {
  --font-mono: ui-monospace, 'JetBrains Mono', 'IBM Plex Mono', 'SF Mono', Menlo, monospace;
  --font-serif: 'Iowan Old Style', 'Charter', 'Source Serif Pro', Georgia, serif;
  --bg: #0a0b14;
  --hairline: rgba(255,255,255,0.05);
  --hairline-strong: rgba(255,255,255,0.10);
  --hairline-vivid: rgba(255,255,255,0.16);
  --surface: rgba(255,255,255,0.03);
  --surface-strong: rgba(255,255,255,0.06);
  --fg: rgba(255,255,255,0.94);
  --fg-2: rgba(255,255,255,0.74);
  --fg-3: rgba(255,255,255,0.55);
  --muted: rgba(255,255,255,0.48);
  --muted-2: rgba(255,255,255,0.28);
  --muted-3: rgba(255,255,255,0.16);
  flex: 1; display: flex; flex-direction: column; min-height: 0;
}

.content-wrap { flex: 1; overflow-y: auto; min-height: 0; }
.content { max-width: 720px; margin: 0 auto; padding: 32px 32px 80px; }

.tl-section { margin-bottom: 36px; }
.tl-section:last-child { margin-bottom: 0; }
.tl-section-head {
  display: flex; align-items: baseline; gap: 12px;
  margin-bottom: 20px; padding-bottom: 10px;
  border-bottom: 1px solid var(--hairline);
}
.tl-section-head .year {
  font-family: var(--font-serif); font-size: 22px;
  font-weight: 500; color: var(--fg-2); letter-spacing: -0.005em;
}
.tl-section-head .span {
  font-family: var(--font-mono); font-size: 12px;
  color: var(--muted); letter-spacing: 0.02em;
}

.timeline { position: relative; }
.timeline::before {
  content: ''; position: absolute;
  left: 32px; top: 32px; bottom: 32px;
  width: 1px; margin-left: -0.5px;
  background: linear-gradient(to bottom,
    rgba(167,139,250,0.55) 0%, rgba(167,139,250,0.35) 8%,
    rgba(255,255,255,0.12) 30%, rgba(255,255,255,0.06) 100%);
  z-index: 0;
}

.recap-row {
  position: relative; display: grid;
  grid-template-columns: 64px 1fr;
  column-gap: 18px; align-items: center;
  padding: 12px 0; cursor: pointer;
  transition: transform 0.12s;
}
.recap-row:hover { transform: translateX(2px); }

.recap-node {
  width: 64px; height: 64px;
  position: relative; z-index: 2;
}
.recap-node::before {
  content: ''; position: absolute; inset: -2px;
  border-radius: 50%; background: var(--bg); z-index: -1;
}
.recap-node :deep(svg) {
  width: 100%; height: 100%; display: block;
  filter: drop-shadow(0 0 6px var(--node-glow, rgba(167,139,250,0.3)));
  transition: filter 0.15s;
}
.recap-row:hover .recap-node :deep(svg) {
  filter: drop-shadow(0 0 10px var(--node-glow, rgba(167,139,250,0.5)));
}

.recap-card {
  display: grid; grid-template-columns: 1fr auto;
  gap: 16px; align-items: center;
  padding: 14px 16px;
  border: 1px solid var(--hairline); border-radius: 8px;
  background: rgba(255,255,255,0.02);
  transition: background 0.12s, border-color 0.12s;
}
.recap-row:hover .recap-card {
  background: rgba(255,255,255,0.035);
  border-color: var(--hairline-strong);
}

.recap-body { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.recap-period {
  font-family: var(--font-mono); font-size: 12px;
  color: var(--muted); letter-spacing: 0.02em;
  display: flex; align-items: center; gap: 8px;
}
.recap-period .dot { width: 2px; height: 2px; background: var(--muted-2); border-radius: 50%; }
.recap-archetype {
  font-family: var(--font-serif); font-size: 20px;
  font-weight: 500; color: var(--fg); letter-spacing: -0.01em;
}
.recap-subtitle {
  font-family: var(--font-serif); font-style: italic;
  font-size: 14.5px; color: var(--fg-3); line-height: 1.4;
  display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden;
}
.recap-stats {
  margin-top: 4px; font-family: var(--font-mono);
  font-size: 11.5px; color: var(--muted-2);
  font-variant-numeric: tabular-nums; letter-spacing: 0.02em;
  display: flex; gap: 10px;
}
.recap-stats .sep { color: var(--muted-3); }

.recap-right {
  display: flex; align-items: center; flex-shrink: 0;
  color: var(--muted-2); transition: color 0.12s;
}
.recap-row:hover .recap-right { color: var(--fg-3); }
.recap-right svg { width: 14px; height: 14px; }

/* Empty state */
.empty-content { padding-top: 32px; }
.empty-timeline { position: relative; padding-top: 8px; }
.empty-timeline::before {
  content: ''; position: absolute;
  left: 15px; top: 24px; bottom: 24px;
  width: 1px; margin-left: -0.5px;
  background: repeating-linear-gradient(
    to bottom, var(--muted-3) 0px, var(--muted-3) 3px,
    transparent 3px, transparent 7px);
  opacity: 0.55;
}
.empty-row {
  display: grid; grid-template-columns: 30px 1fr;
  column-gap: 28px; align-items: center; padding: 14px 0;
}
.empty-node {
  width: 30px; height: 30px; position: relative; z-index: 2;
  display: grid; place-items: center;
}
.empty-node::before {
  content: ''; position: absolute; inset: -3px;
  border-radius: 50%; background: var(--bg); z-index: -1;
}
.empty-node::after {
  content: ''; width: 10px; height: 10px;
  border: 1.5px dashed var(--muted-2);
  transform: rotate(45deg); border-radius: 1px;
}
.empty-row.placeholder .empty-card {
  height: 12px; background: transparent;
  border: 1px dashed var(--muted-3); border-radius: 6px; opacity: 0.4;
}

.empty-cta {
  padding: 28px 22px;
  border: 1px dashed var(--hairline-strong); border-radius: 10px;
  background: rgba(255,255,255,0.015);
  display: flex; flex-direction: column; gap: 16px;
}
.empty-eyebrow {
  font-family: var(--font-mono); font-size: 12px;
  letter-spacing: 0.06em; color: var(--muted);
  display: flex; align-items: center; gap: 8px;
}
.empty-eyebrow .diamond {
  width: 6px; height: 6px; background: var(--muted-2);
  transform: rotate(45deg); flex-shrink: 0;
}
.empty-title {
  font-family: var(--font-serif); font-size: 26px;
  font-weight: 500; color: var(--fg);
  letter-spacing: -0.015em; line-height: 1.3; max-width: 460px;
}
.empty-body {
  font-family: var(--font-serif); font-style: italic;
  font-size: 15px; color: var(--fg-3); line-height: 1.6; max-width: 460px;
}
.empty-body code {
  font-family: var(--font-mono); font-style: normal;
  font-size: 13px; color: var(--accent-2, #c4b5fd);
  background: rgba(167,139,250,0.12); padding: 2px 8px;
  border-radius: 3px; letter-spacing: 0;
}
.empty-actions { display: flex; gap: 8px; margin-top: 4px; }
.empty-actions .toolbar-action { height: 30px; padding: 0 14px; }

/* Modal */
.modal-backdrop {
  position: fixed; inset: 0;
  background: rgba(5, 6, 12, 0.65);
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  z-index: 500;
  display: flex; align-items: center; justify-content: center; padding: 24px;
}
.modal {
  width: 100%; max-width: 480px;
  background: linear-gradient(165deg, rgba(20,22,38,0.95) 0%, rgba(13,15,28,0.95) 100%);
  border: 1px solid var(--hairline-strong); border-radius: 12px;
  box-shadow: 0 30px 80px rgba(0,0,0,0.6), 0 12px 32px rgba(0,0,0,0.4),
    inset 0 1px 0 rgba(255,255,255,0.08);
  overflow: hidden;
}
.modal-head {
  padding: 18px 22px 12px;
  border-bottom: 1px solid var(--hairline);
  display: flex; align-items: baseline; gap: 10px;
}
.modal-head .diamond {
  width: 6px; height: 6px; background: #a78bfa;
  transform: rotate(45deg); box-shadow: 0 0 8px rgba(167,139,250,0.35);
  flex-shrink: 0; align-self: center;
}
.modal-head .title {
  font-family: var(--font-serif); font-size: 17px;
  font-weight: 500; color: var(--fg); flex: 1;
}
.modal-close {
  color: var(--muted); width: 24px; height: 24px;
  display: grid; place-items: center; border-radius: 4px;
  border: none; background: none; cursor: pointer; transition: all 0.1s;
}
.modal-close:hover { color: var(--fg-2); background: var(--surface); }
.modal-close svg { width: 12px; height: 12px; }

.modal-body { padding: 18px 22px 20px; }
.modal-body p {
  font-family: var(--font-serif); font-style: italic;
  font-size: 13.5px; color: var(--fg-2); line-height: 1.6; margin-bottom: 14px;
}

.modal-options {
  display: flex; flex-direction: column; gap: 1px;
  background: var(--hairline); border: 1px solid var(--hairline);
  border-radius: 6px; overflow: hidden; margin-bottom: 14px;
}
.modal-option {
  padding: 10px 14px; background: rgba(0,0,0,0.2);
  display: flex; align-items: center; gap: 10px;
  cursor: pointer; border: none; color: inherit; width: 100%; text-align: left;
  transition: background 0.08s;
}
.modal-option:hover { background: rgba(255,255,255,0.025); }
.modal-option.active { background: rgba(167,139,250,0.12); }
.modal-option-label {
  font-family: var(--font-mono); font-size: 12px;
  color: var(--fg-2); flex: 1;
}
.modal-option.active .modal-option-label { color: #c4b5fd; }
.modal-option-radio {
  width: 12px; height: 12px;
  border: 1.5px solid var(--muted-2); border-radius: 50%;
  position: relative; flex-shrink: 0; transition: all 0.1s;
}
.modal-option.active .modal-option-radio { border-color: #a78bfa; }
.modal-option.active .modal-option-radio::after {
  content: ''; position: absolute; inset: 2px;
  background: #a78bfa; border-radius: 50%;
  box-shadow: 0 0 6px rgba(167,139,250,0.35);
}

.cmd-block {
  position: relative;
  background: rgba(0,0,0,0.4); border: 1px solid var(--hairline-strong);
  border-radius: 6px; padding: 14px 50px 14px 16px; margin-bottom: 14px;
}
.cmd-block code {
  font-family: var(--font-mono); font-size: 12.5px;
  color: var(--fg); letter-spacing: 0.005em; word-break: break-all;
}
.cmd-block code .prompt { color: #c4b5fd; margin-right: 4px; }
.cmd-copy {
  position: absolute; top: 50%; right: 8px; transform: translateY(-50%);
  width: 32px; height: 32px; display: grid; place-items: center;
  color: var(--muted); border-radius: 5px; border: none; background: none;
  cursor: pointer; transition: all 0.1s;
}
.cmd-copy:hover { color: var(--fg); background: var(--surface); }
.cmd-copy.copied { color: #c4b5fd; background: rgba(167,139,250,0.12); }
.cmd-copy svg { width: 14px; height: 14px; }

.modal-hint {
  font-family: var(--font-mono); font-size: 10.5px;
  color: var(--muted-2); letter-spacing: 0.02em; line-height: 1.5;
}
</style>
