<script setup>
import { ref, onMounted, nextTick } from 'vue';

defineOptions({ name: 'Settings' });

const sources = ref([]);
const dbPath = ref('');
const recapPath = ref('');
const autoRefresh = ref(true);
const editorScheme = ref('vscode');
const editorSchemes = ['vscode', 'vscode-insiders', 'cursor', 'windsurf', 'zed'];
const memoryCount = ref(0);
const rebuilding = ref(false);
const version = ref('');

onMounted(async () => {
  await loadSettings();
});

async function loadSettings() {
  if (!window.obelisk?.getSettings) return;
  const s = await window.obelisk.getSettings();
  sources.value = s.sources || [];
  dbPath.value = s.dbPath || '';
  recapPath.value = s.recapDir || '~/.obelisk/recap';
  autoRefresh.value = s.autoRefresh !== false;
  editorScheme.value = s.editorScheme || 'vscode';
  memoryCount.value = s.memoryCount || 0;
  version.value = s.version || '';
}

async function saveEditorScheme(value) {
  editorScheme.value = value;
  await saveSetting('editorScheme', value);
}

async function browseSourcePath(source) {
  if (!window.obelisk?.browseFolder) return;
  const result = await window.obelisk.browseFolder();
  if (result) {
    await saveSetting(source.settingKey || `providerRoots.${source.id}`, result);
    await loadSettings();
  }
}

async function browseRecapPath() {
  if (!window.obelisk?.browseFolder) return;
  const result = await window.obelisk.browseFolder();
  if (result) {
    recapPath.value = result;
    await saveSetting('recapDir', result);
  }
}

async function toggleAutoRefresh() {
  autoRefresh.value = !autoRefresh.value;
  await saveSetting('autoRefresh', autoRefresh.value);
}

async function saveSetting(key, value) {
  if (window.obelisk?.setSetting) {
    await window.obelisk.setSetting(key, value);
  }
}

async function commitRecapPath() {
  await saveSetting('recapDir', recapPath.value);
}

async function rebuildIndex() {
  if (rebuilding.value || !window.obelisk?.rebuildIndex) return;
  rebuilding.value = true;
  await nextTick();
  await new Promise(resolve => requestAnimationFrame(resolve));
  try {
    await window.obelisk.rebuildIndex();
    await loadSettings();
  } finally {
    rebuilding.value = false;
  }
}

async function revealDb() {
  if (window.obelisk?.revealPath) {
    window.obelisk.revealPath(dbPath.value);
  }
}

function fmtRelative(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}
</script>

<template>
  <div class="settings-wrap">
    <div class="settings-content">

      <!-- Data Sources -->
      <section class="settings-section">
        <div class="settings-section-head">
          <h2>Data Sources</h2>
          <p>Where Obelisk reads your agent session history.</p>
        </div>

        <div
          v-for="src in sources" :key="src.id"
          class="source-card"
          :class="{ error: src.status === 'error', warn: src.status === 'warn' }"
        >
          <div class="source-card-head">
            <div class="source-card-mark">
              <span class="mark-dot" :style="{ background: src.color, boxShadow: `0 0 6px ${src.color}80` }"></span>
            </div>
            <div class="source-card-info">
              <div class="source-card-name">
                {{ src.name }}
                <span class="vendor">by {{ src.vendor }}</span>
              </div>
              <div class="source-card-status">
                <span class="stat-dot" :class="src.status"></span>
                <span class="stat-text" :class="src.status">{{ src.statusText }}</span>
                <template v-if="src.lastIndexed">
                  <span class="sep">·</span>
                  <span>last read <strong>{{ fmtRelative(src.lastIndexed) }}</strong></span>
                </template>
                <template v-if="src.sessionCount">
                  <span class="sep">·</span>
                  <span><strong>{{ src.sessionCount }}</strong> sessions</span>
                </template>
              </div>
            </div>
          </div>
          <div class="source-card-body">
            <div class="path-input">
              <input class="path-field" :class="{ error: src.status === 'error' }" type="text" :value="src.path" spellcheck="false" readonly/>
              <button class="btn" @click="browseSourcePath(src)">
                <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">
                  <path d="M2.5 3.5h3.5l1.2 1.2h4.3a1 1 0 0 1 1 1V11a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/>
                </svg>
                Browse…
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- Index -->
      <section class="settings-section">
        <div class="settings-section-head">
          <h2>Index location</h2>
          <p>SQLite database where Obelisk caches the unified session index.</p>
        </div>
        <div class="path-input" style="max-width: 480px;">
          <input class="path-field" type="text" :value="dbPath" spellcheck="false" readonly/>
          <button class="btn" @click="revealDb">Reveal</button>
        </div>
      </section>

      <!-- Auto-refresh -->
      <section class="settings-section">
        <div class="settings-section-head">
          <h2>Auto-refresh</h2>
          <p>Obelisk re-reads when new session files appear.</p>
        </div>
        <label class="toggle-label" @click.prevent="toggleAutoRefresh">
          <span class="toggle-track" :class="{ on: autoRefresh }">
            <span class="toggle-thumb"></span>
          </span>
          <span class="toggle-text">Watch data sources for changes</span>
        </label>
      </section>

      <!-- Editor -->
      <section class="settings-section">
        <div class="settings-section-head">
          <h2>Editor</h2>
          <p>Which editor opens file references found in session transcripts.</p>
        </div>
        <div class="form-row">
          <div>
            <div class="form-label">Editor URL scheme</div>
            <div class="form-label-hint">Clicking <code>src/app.ts:42</code> jumps to that line.</div>
          </div>
          <div class="form-control select-control">
            <select class="path-field select-field" :value="editorScheme" @change="saveEditorScheme($event.target.value)">
              <option v-for="opt in editorSchemes" :key="opt" :value="opt">{{ opt }}</option>
            </select>
          </div>
        </div>
      </section>

      <!-- Recap -->
      <section class="settings-section">
        <div class="settings-section-head">
          <h2>Recap</h2>
          <p>Where generated weekly and monthly recap files live.</p>
        </div>
        <div class="form-row">
          <div>
            <div class="form-label">Recap output directory</div>
            <div class="form-label-hint">Watched by Obelisk for new <code>recap-*.json</code> files.</div>
          </div>
          <div class="form-control">
            <div class="path-input">
              <input
                class="path-field"
                type="text"
                v-model="recapPath"
                spellcheck="false"
                @keydown.enter="commitRecapPath"
                @blur="commitRecapPath"
              />
              <button class="btn" @click="browseRecapPath">Browse…</button>
            </div>
          </div>
        </div>
      </section>

      <!-- About -->
      <section class="settings-section last">
        <div class="settings-section-head">
          <h2>About</h2>
          <p>The kind of details you don't usually need.</p>
        </div>
        <div class="form-row">
          <div class="form-label">Version</div>
          <div class="form-control version-text">
            Obelisk {{ version }}
          </div>
        </div>
        <div class="form-row">
          <div class="form-label">Reset</div>
          <div class="form-control">
            <div class="reset-actions">
              <button class="btn" :disabled="rebuilding" @click="rebuildIndex">
                {{ rebuilding ? 'Rebuilding…' : 'Rebuild index' }}
              </button>
            </div>
            <div class="reset-hint">
              Rebuilding re-reads your coding agent session data. It does not delete memories or recaps.
            </div>
          </div>
        </div>
      </section>

    </div>
  </div>
</template>

<style scoped>
.settings-wrap { flex: 1; overflow-y: auto; min-height: 0; }
.settings-content { max-width: 720px; margin: 0 auto; padding: 36px 32px 80px; }

.settings-section { margin-bottom: 44px; }
.settings-section.last { margin-bottom: 0; }
.settings-section-head {
  margin-bottom: 16px; padding-bottom: 10px;
  border-bottom: 1px solid var(--hairline);
}
.settings-section-head h2 {
  font-size: 18px; font-weight: 600;
  color: var(--fg); letter-spacing: -0.01em; margin-bottom: 2px;
}
.settings-section-head p {
  font-size: 13px; color: var(--muted);
}

/* Source cards */
.source-card {
  padding: 18px; border: 1px solid var(--hairline); border-radius: 8px;
  background: rgba(0,0,0,0.18); margin-bottom: 12px;
  transition: border-color 0.15s;
}
.source-card:hover { border-color: var(--hairline-strong); }
.source-card.error { border-color: rgba(248,113,113,0.25); }
.source-card.warn { border-color: rgba(251,191,36,0.20); }
.source-card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
.source-card-mark {
  width: 28px; height: 28px; border-radius: 6px;
  background: rgba(0,0,0,0.4); border: 1px solid var(--hairline-strong);
  display: grid; place-items: center; flex-shrink: 0;
}
.source-card-mark .mark-dot { width: 8px; height: 8px; border-radius: 50%; }
.source-card-info { flex: 1; min-width: 0; }
.source-card-name {
  font-size: 14px; color: var(--fg); font-weight: 600; letter-spacing: -0.005em;
  display: flex; align-items: baseline; gap: 8px;
}
.source-card-name .vendor { font-size: 11.5px; color: var(--muted); font-weight: 400; }
.source-card-status {
  font-family: var(--font-mono); font-size: 10.5px; color: var(--muted);
  margin-top: 3px; display: flex; align-items: center; gap: 8px;
}
.source-card-status .stat-dot { width: 6px; height: 6px; border-radius: 50%; position: relative; }
.source-card-status .stat-dot.ok { background: #34d399; box-shadow: 0 0 5px rgba(52,211,153,0.5); }
.source-card-status .stat-dot.warn { background: #fbbf24; box-shadow: 0 0 5px rgba(251,191,36,0.5); }
.source-card-status .stat-dot.error { background: #f87171; box-shadow: 0 0 5px rgba(248,113,113,0.5); }
.source-card-status .stat-dot.ok::before {
  content: ''; position: absolute; inset: -2.5px; border-radius: 50%;
  border: 1px solid #34d399; opacity: 0.5; animation: src-pulse 1.6s ease-out infinite;
}
@keyframes src-pulse { 0% { transform: scale(0.8); opacity: 0.5; } 100% { transform: scale(1.8); opacity: 0; } }
.source-card-status .stat-text { color: var(--fg-2); }
.source-card-status .stat-text.ok { color: #34d399; }
.source-card-status .stat-text.warn { color: #fbbf24; }
.source-card-status .stat-text.error { color: #f87171; }
.source-card-status .sep { color: var(--muted-3); }
.source-card-status strong { color: var(--fg-2); font-weight: 500; }
.source-card-body { display: flex; flex-direction: column; gap: 10px; }

.form-row {
  display: grid; grid-template-columns: 180px 1fr;
  gap: 24px; padding: 14px 0; align-items: start;
}
.form-row + .form-row { border-top: 1px solid var(--hairline); }
.form-label { font-size: 13px; color: var(--fg-2); font-weight: 500; padding-top: 6px; }
.form-label-hint {
  font-size: 11.5px; color: var(--muted); margin-top: 4px; font-weight: 400;
}
.form-label-hint code {
  font-family: var(--font-mono); font-style: normal; font-size: 10.5px;
  padding: 1px 4px; background: rgba(0,0,0,0.3); border-radius: 3px; color: var(--muted);
}
.form-control { display: flex; flex-direction: column; gap: 8px; }

.path-input { display: flex; gap: 6px; }
.path-field {
  flex: 1; height: 28px; padding: 0 10px;
  background: rgba(0,0,0,0.3); border: 1px solid var(--hairline-strong);
  border-radius: 5px; font-family: var(--font-mono); font-size: 12px;
  color: var(--fg); min-width: 0; transition: all 0.12s;
}
.path-field:focus { outline: 0; border-color: var(--accent); background: rgba(0,0,0,0.4); box-shadow: 0 0 0 2px rgba(167,139,250,0.12); }
.path-field.error { border-color: rgba(248,113,113,0.4); }
.path-field.error:focus { border-color: #f87171; box-shadow: 0 0 0 2px rgba(248,113,113,0.12); }
.select-control { position: relative; }
.select-control::after {
  content: ''; position: absolute; right: 11px; top: 9px;
  width: 6px; height: 6px; pointer-events: none;
  border-right: 1px solid var(--muted); border-bottom: 1px solid var(--muted);
  transform: rotate(45deg);
}
.select-field {
  width: 100%; padding-right: 30px; cursor: pointer;
  appearance: none; -webkit-appearance: none;
}
.select-field:hover { border-color: var(--hairline-vivid); }
.select-field option { background: var(--surface-strong); color: var(--fg); }
.tz-field { max-width: 240px; }

.btn {
  display: inline-flex; align-items: center; gap: 6px;
  height: 28px; padding: 0 12px;
  border: 1px solid var(--hairline-strong); border-radius: 5px;
  background: var(--surface); color: var(--fg-2);
  font-size: 12px; font-weight: 500; cursor: pointer;
  transition: all 0.12s; white-space: nowrap;
}
.btn:hover { background: var(--surface-strong); color: var(--fg); border-color: var(--hairline-vivid); }
.btn:disabled { opacity: 0.4; cursor: default; }
.btn.subtle { background: transparent; border-color: transparent; color: var(--muted); }
.btn.subtle:hover { background: var(--surface); color: var(--fg-2); }
.btn svg { width: 13px; height: 13px; }

.status-row {
  display: flex; align-items: center; gap: 14px;
  padding: 8px 12px; background: rgba(0,0,0,0.2);
  border: 1px solid var(--hairline); border-radius: 5px;
  font-family: var(--font-mono); font-size: 11.5px; flex-wrap: wrap;
}
.status-row.ok { border-color: rgba(52,211,153,0.20); background: rgba(52,211,153,0.04); }
.status-row.warn { border-color: rgba(251,191,36,0.20); background: rgba(251,191,36,0.04); }
.status-row.error { border-color: rgba(248,113,113,0.20); background: rgba(248,113,113,0.04); }

.status-dot {
  width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
  position: relative;
}
.status-dot.ok { background: #34d399; box-shadow: 0 0 6px rgba(52,211,153,0.5); }
.status-dot.warn { background: #fbbf24; box-shadow: 0 0 6px rgba(251,191,36,0.5); }
.status-dot.error { background: #f87171; box-shadow: 0 0 6px rgba(248,113,113,0.5); }
.status-dot.ok::before {
  content: ''; position: absolute; inset: -3px;
  border-radius: 50%; border: 1px solid #34d399; opacity: 0.5;
  animation: pulse 1.6s ease-out infinite;
}
@keyframes pulse { 0% { transform: scale(0.8); opacity: 0.5; } 100% { transform: scale(1.6); opacity: 0; } }
.status-text { color: var(--fg-2); font-weight: 500; }
.status-text.error { color: #f87171; }
.status-meta { display: flex; gap: 6px; color: var(--muted); align-items: center; flex-wrap: wrap; }
.status-meta strong { color: var(--fg-2); font-weight: 500; }
.status-meta .sep { color: var(--muted-2); }

.toggle-label { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
.toggle-input { position: absolute; opacity: 0; width: 0; height: 0; }
.toggle-track {
  position: relative; width: 30px; height: 16px;
  background: var(--surface-strong); border: 1px solid var(--hairline-strong);
  border-radius: 8px; transition: all 0.15s;
}
.toggle-track.on { background: rgba(167,139,250,0.12); border-color: rgba(167,139,250,0.5); }
.toggle-thumb {
  position: absolute; top: 2px; left: 2px;
  width: 10px; height: 10px; border-radius: 50%;
  background: var(--muted); transition: all 0.15s;
}
.toggle-track.on .toggle-thumb {
  left: 16px; background: #c4b5fd;
  box-shadow: 0 0 6px rgba(167,139,250,0.5);
}
.toggle-text { font-size: 12.5px; color: var(--fg-2); }
.toggle-text code {
  font-family: var(--font-mono); font-size: 11px;
  padding: 1px 4px; background: rgba(0,0,0,0.3); border-radius: 3px;
}

.version-text {
  font-family: var(--font-mono); font-size: 12px; color: var(--fg-2); padding-top: 6px;
}
.reset-actions { display: flex; gap: 8px; }
.reset-hint {
  font-size: 11.5px; color: var(--muted); margin-top: 6px;
}
</style>
