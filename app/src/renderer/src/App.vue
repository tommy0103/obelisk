<!-- Copyright (C) 2026 tommy0103 and contributors. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

<script setup>
import { computed, watch, ref, provide, onMounted, onUnmounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import {
  state,
  getSessionSummary,
  FOLDER_SVG,
  resetListState,
  setView,
  setProject,
  clearSelection,
  setQuery,
  setProjectSearch,
  toggleSort,
  toggleIncludeMessageBodies
} from './store.js';
import { formatProjectLabel } from './utils.js';
import { buildSidebarProjects } from './sidebar-projects.mjs';
import { resolveGlobalShortcut } from './keyboard-shortcuts.mjs';
import { sourceLabel } from './source-catalog.mjs';

const router = useRouter();
const route = useRoute();
let searchTimer = null;
let stopSourceUpdates = null;

const routeSession = computed(() => {
  return getSessionSummary(route.params.id);
});

// --- Sidebar data ---

const activeCount = computed(() => state.memories.filter(m => !m.archived).length);
const archivedCount = computed(() => state.memories.filter(m => m.archived).length);
const totalMemoryCount = computed(() => state.memories.length);
const sessionCount = computed(() => state.sessions.length);

const currentRouteType = computed(() => {
  const name = route.name;
  if (name === 'SessionList' || name === 'SessionDetail' || name === 'SubagentDetail') return 'sessions';
  if (name === 'Activity') return 'activity';
  if (name === 'Recap' || name === 'RecapDetail') return 'recap';
  if (name === 'Settings') return 'settings';
  return 'memory';
});

const sidebarProjectsForCurrentScope = (search = state.projectSearch) => buildSidebarProjects({
  routeType: currentRouteType.value,
  sessions: state.sessions,
  memories: state.memories,
  projects: state.projects,
  view: state.view,
  search,
  formatProjectLabel,
});

const sidebarProjects = computed(() => sidebarProjectsForCurrentScope());

const NOISE_PROJECT_RE = /^(od-conn-test|[0-9a-f]{6,})/i;
const normalProjects = computed(() => sidebarProjects.value.filter(p => p.count > 1 || !NOISE_PROJECT_RE.test(p.label)));
const noiseProjects = computed(() => sidebarProjects.value.filter(p => p.count <= 1 && NOISE_PROJECT_RE.test(p.label)));
const showNoiseProjects = ref(false);

const totalProjectCount = computed(() => {
  return sidebarProjectsForCurrentScope('').length;
});

// --- Toolbar visibility ---

const showToolbar = computed(() => {
  const r = route.name;
  return r === 'SessionList' || r === 'MemoryList';
});

const showSearchMsgsToggle = computed(() => {
  return route.name === 'SessionList';
});

// --- Window title ---

const windowTitle = computed(() => {
  const appName = 'Obelisk';
  let scopeText = '';
  if (route.name === 'Activity') {
    scopeText = 'Activity';
  } else if (route.name === 'Recap') {
    scopeText = 'Recap';
  } else if (route.name === 'RecapDetail') {
    scopeText = `Recap · ${route.params.id}`;
  } else if (route.name === 'Settings') {
    scopeText = 'Settings';
  } else if (route.name?.startsWith('Session')) {
    if (route.name === 'SessionDetail' || route.name === 'SubagentDetail') {
      const s = routeSession.value;
      scopeText = s ? `Sessions · ${s.title}` : 'Sessions';
    } else {
      const proj = state.projectFilter !== 'all' ? ` · ${formatProjectLabel(state.projectFilter)}` : '';
      scopeText = `Sessions${proj}`;
    }
  } else {
    if (route.name === 'MemoryDetail') {
      const m = state.memories.find(x => x.id === route.params.id);
      scopeText = m ? `Memory · ${m.path.split('/').pop()}` : 'Memory';
    } else {
      const viewLabel = state.view === 'archived' ? 'Archived' : 'Active';
      const proj = state.projectFilter !== 'all' ? ` · ${formatProjectLabel(state.projectFilter)}` : '';
      scopeText = `Memory · ${viewLabel}${proj}`;
    }
  }
  return { appName, scopeText };
});

watch(() => windowTitle.value.scopeText, (scopeText) => {
  document.title = `${windowTitle.value.appName} — ${scopeText}`;
}, { immediate: true });

// --- Navigation helpers ---

function handleSidebarRoute(routeName) {
  clearTimeout(searchTimer);
  resetListState();
  if (routeName === 'sessions') {
    router.push('/sessions');
  } else if (routeName === 'activity') {
    router.push('/activity');
  } else if (routeName === 'recap') {
    router.push('/recap');
  } else {
    router.push('/memory');
  }
}

function handleSidebarView(view) {
  setView(view);
  router.push('/memory');
}

function handleClearProject() {
  setProject('all');
}

function handleSidebarProject(slug) {
  setProject(slug);
  if (currentRouteType.value === 'sessions') router.push('/sessions');
  else router.push('/memory');
}

function handleProjectSearch(e) {
  setProjectSearch(e.target.value);
}

// --- Search ---

const searchInputRef = ref(null);
function handleSearch(e) {
  const value = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    setQuery(value);
  }, 200);
}

function handleToggleSort() {
  toggleSort();
}

function handleToggleSearchMsgs() {
  toggleIncludeMessageBodies();
}

function handleGlobalKeydown(event) {
  const tagName = event.target?.tagName;
  const command = resolveGlobalShortcut(event, {
    isTextInput: tagName === 'INPUT' || tagName === 'TEXTAREA' || event.target?.isContentEditable,
    isListRoute: showToolbar.value,
    hasSelection: state.selection.size > 0,
    hasQuery: Boolean(state.query),
  });
  if (!command) return;

  event.preventDefault();
  if (command === 'open-sessions') handleSidebarRoute('sessions');
  else if (command === 'open-active-memories') handleSidebarView('active');
  else if (command === 'open-archived-memories') handleSidebarView('archived');
  else if (command === 'focus-search') {
    searchInputRef.value?.focus();
    searchInputRef.value?.select();
  } else if (command === 'blur-input') event.target?.blur?.();
  else if (command === 'toggle-sort') handleToggleSort();
  else if (command === 'clear-selection') clearSelection();
  else if (command === 'clear-query') {
    clearTimeout(searchTimer);
    setQuery('');
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleGlobalKeydown);
  stopSourceUpdates = window.obelisk?.onIndexUpdated?.(() => loadSourceDots()) ?? null;
});
onUnmounted(() => {
  window.removeEventListener('keydown', handleGlobalKeydown);
  stopSourceUpdates?.();
  stopSourceUpdates = null;
  clearTimeout(searchTimer);
});

const isExportRoute = computed(() => route.name === 'RecapExport');

// --- Source health dots ---
const sourceDots = ref([]);
const sourceDetails = ref([]);
const showSourcePopover = ref(false);
async function loadSourceDots() {
  if (!window.obelisk?.getSettings) return;
  const s = await window.obelisk.getSettings();
  sourceDots.value = (s.sources || []).map(src => ({ id: src.id, status: src.status, color: src.color }));
  sourceDetails.value = s.sources || [];
  state.sources = s.sources || [];
}
loadSourceDots();

// --- Recap ---
const recapGenerateOpen = ref(false);
function setRecapKind(k) {
  router.replace({ path: '/recap', query: { kind: k } });
}

// --- Source filter ---
const showSourceFilter = ref(false);
const sourceFilterActive = computed(() => state.sourceFilter !== 'all' && state.sourceFilter !== undefined);
const sourceFilterLabel = computed(() => {
  if (!state.sourceFilter || state.sourceFilter === 'all') return 'All sources';
  return sourceLabel(state.sourceFilter, state.sources);
});
function toggleSourceFilter() { showSourceFilter.value = !showSourceFilter.value; }
function setSourceFilter(id) {
  state.sourceFilter = id;
  showSourceFilter.value = false;
}
provide('recapGenerateOpen', recapGenerateOpen);
</script>

<template>
  <router-view v-if="isExportRoute" />
  <div class="app" v-else>
    <div class="titlebar">
      <div class="titlebar-text" id="titlebar-text">
        <span class="app-name">{{ windowTitle.appName }}</span>
        <span class="sep">—</span>
        <span class="scope">{{ windowTitle.scopeText }}</span>
      </div>
    </div>

    <div class="columns">
      <aside class="sidebar">
        <div class="sidebar-brand">
          <svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <defs>
              <radialGradient id="icon-aurora" cx="50%" cy="62%" r="55%">
                <stop offset="0%"  stop-color="#ec4899" stop-opacity="0.8"/>
                <stop offset="45%" stop-color="#a855f7" stop-opacity="0.7"/>
                <stop offset="100%" stop-color="#6366f1" stop-opacity="0"/>
              </radialGradient>
              <linearGradient id="icon-stone-lit" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"  stop-color="#cbd5e1"/>
                <stop offset="100%" stop-color="#475569"/>
              </linearGradient>
            </defs>
            <ellipse cx="20" cy="22" rx="15" ry="11" fill="url(#icon-aurora)"/>
            <ellipse cx="20" cy="21" rx="9"  ry="7"  fill="url(#icon-aurora)" opacity="0.7"/>
            <circle cx="8"  cy="13" r="0.7" fill="#fff" opacity="0.9"/>
            <circle cx="32" cy="11" r="0.9" fill="#fff" opacity="0.95"/>
            <circle cx="34" cy="22" r="0.5" fill="#fff" opacity="0.7"/>
            <polygon points="20,7 16.5,12 23.5,12" fill="url(#icon-stone-lit)"/>
            <polygon points="20,12 16.5,12 17.5,33 20,33" fill="url(#icon-stone-lit)"/>
            <polygon points="20,12 23.5,12 22.5,33 20,33" fill="#1e293b"/>
            <rect x="15.5" y="33" width="9" height="1.6" rx="0.3" fill="#0f172a"/>
          </svg>
          <span class="name">Obelisk</span>
          <button class="source-health" title="Connected sources" @click="showSourcePopover = !showSourcePopover">
            <span v-for="src in sourceDots" :key="src.id" class="h-dot" :class="src.status" :style="{ '--source-color': src.color }"></span>
          </button>
          <div class="sources-popover" :class="{ show: showSourcePopover }">
            <div class="sp-head">Connected sources</div>
            <div class="sp-list">
              <button v-for="src in sourceDetails" :key="src.id" class="sp-row" @click="router.push('/settings')">
                <span class="sp-dot" :style="{ '--source-color': src.color }"></span>
                <div class="sp-body">
                  <div class="sp-name">{{ src.name }} <span class="sp-count" v-if="src.sessionCount">{{ src.sessionCount }} sessions</span></div>
                  <div class="sp-meta" :class="src.status">{{ src.statusText }}</div>
                </div>
              </button>
            </div>
            <div class="sp-foot">
              <button @click="router.push('/settings'); showSourcePopover = false">Manage in Settings →</button>
            </div>
          </div>
        </div>

        <div class="sidebar-section">
          <div class="sidebar-section-title"><span>Library</span></div>
          <button
            class="sidebar-item"
            :class="{ active: currentRouteType === 'sessions' && state.projectFilter === 'all' }"
            @click="handleSidebarRoute('sessions')"
          >
            <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M3 4h10v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4z" stroke-linejoin="round"/>
              <path d="M5.5 7h5M5.5 9.5h3" stroke-linecap="round"/>
            </svg>
            <span class="label">Sessions</span>
            <span class="badge">{{ sessionCount }}</span>
          </button>
          <button
            class="sidebar-item"
            :class="{ active: currentRouteType === 'memory' && state.view === 'active' && state.projectFilter === 'all' }"
            @click="handleSidebarView('active')"
          >
            <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="2.5" y="2.5" width="11" height="11" rx="2"/>
              <path d="M5 8h6M5 5.5h6M5 10.5h4" stroke-linecap="round"/>
            </svg>
            <span class="label">Memory</span>
            <span class="badge">{{ totalMemoryCount }}</span>
          </button>
          <button
            class="sidebar-item sub"
            :class="{ active: currentRouteType === 'memory' && state.view === 'active' && state.projectFilter === 'all' }"
            @click="handleSidebarView('active')"
          >
            <svg class="icon" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="6" cy="6" r="2" fill="currentColor"/>
            </svg>
            <span class="label">Active</span>
            <span class="badge">{{ activeCount }}</span>
          </button>
          <button
            class="sidebar-item sub"
            :class="{ active: currentRouteType === 'memory' && state.view === 'archived' && state.projectFilter === 'all' }"
            @click="handleSidebarView('archived')"
          >
            <svg class="icon" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="6" cy="6" r="2"/>
            </svg>
            <span class="label">Archived</span>
            <span class="badge">{{ archivedCount }}</span>
          </button>
        </div>

        <div class="sidebar-section">
          <div class="sidebar-section-title"><span>Stats</span></div>
          <button
            class="sidebar-item"
            :class="{ active: route.name === 'Activity' }"
            @click="handleSidebarRoute('activity')"
          >
            <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="10" width="2.5" height="4"/>
              <rect x="6" y="6" width="2.5" height="8"/>
              <rect x="10" y="3" width="2.5" height="11"/>
            </svg>
            <span class="label">Activity</span>
          </button>
          <button
            class="sidebar-item"
            :class="{ active: route.name === 'Recap' }"
            @click="handleSidebarRoute('recap')"
          >
            <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 2h10v12H3z"/>
              <path d="M6 5h4M6 8h4M6 11h2"/>
            </svg>
            <span class="label">Recap</span>
          </button>
        </div>

        <div class="sidebar-section projects" v-if="currentRouteType === 'sessions' || currentRouteType === 'memory'">
          <div class="sidebar-section-title">
            <span>Projects</span>
            <button v-if="noiseProjects.length" class="filter-toggle" :class="{ active: showNoiseProjects }" @click.stop="showNoiseProjects = !showNoiseProjects">
              <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                <path d="M2 6h8M2 3h8M2 9h5"/>
              </svg>
              {{ showNoiseProjects ? 'hide noise' : 'show all' }}
            </button>
          </div>
          <div class="sidebar-search" v-if="totalProjectCount >= 6">
            <svg class="sidebar-search-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
              <circle cx="7" cy="7" r="5"/>
              <path d="M11 11l3 3" stroke-linecap="round"/>
            </svg>
            <input
              type="text"
              placeholder="Filter projects…"
              autocomplete="off"
              :value="state.projectSearch"
              @input="handleProjectSearch"
            />
          </div>
          <div class="sidebar-list" id="sidebar-projects">
            <button
              v-for="p in normalProjects"
              :key="p.slug"
              class="sidebar-item"
              :class="{ active: state.projectFilter === p.slug }"
              @click="handleSidebarProject(p.slug)"
            >
              <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">
                <path d="M2 5.5V12a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 14 12V6.5A1.5 1.5 0 0 0 12.5 5H8.3L7 3.5H3.5A1.5 1.5 0 0 0 2 5z"/>
              </svg>
              <span class="label">{{ p.label }}</span>
              <span class="badge">{{ p.count }}</span>
            </button>

            <!-- Noise projects fold -->
            <button v-if="noiseProjects.length" class="project-fold" :class="{ expanded: showNoiseProjects }" @click="showNoiseProjects = !showNoiseProjects">
              <svg class="chev" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 2.5l3 3.5-3 3.5"/></svg>
              <span class="label">{{ noiseProjects.length }} test projects hidden</span>
              <span class="count">{{ noiseProjects.length }}</span>
            </button>
            <template v-if="showNoiseProjects">
              <button
                v-for="p in noiseProjects"
                :key="p.slug"
                class="sidebar-item noise"
                :class="{ active: state.projectFilter === p.slug }"
                @click="handleSidebarProject(p.slug)"
              >
                <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">
                  <path d="M2 5.5V12a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 14 12V6.5A1.5 1.5 0 0 0 12.5 5H8.3L7 3.5H3.5A1.5 1.5 0 0 0 2 5z"/>
                </svg>
                <span class="label">{{ p.label }}</span>
                <span class="badge">{{ p.count }}</span>
              </button>
            </template>
          </div>
        </div>

        <div class="sidebar-section sidebar-bottom">
          <button
            class="sidebar-item"
            :class="{ active: route.name === 'Settings' }"
            @click="router.push('/settings')"
          >
            <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
              <line x1="3" y1="4" x2="13" y2="4"/>
              <line x1="3" y1="8" x2="13" y2="8"/>
              <line x1="3" y1="12" x2="13" y2="12"/>
              <circle cx="9.5" cy="4" r="1.7" fill="var(--bg)"/>
              <circle cx="5.5" cy="8" r="1.7" fill="var(--bg)"/>
              <circle cx="11" cy="12" r="1.7" fill="var(--bg)"/>
            </svg>
            <span class="label">Settings</span>
          </button>
        </div>
      </aside>

      <main class="main">
        <div class="toolbar">
          <div class="breadcrumb" id="breadcrumb">
            <template v-if="showToolbar">
              <template v-if="state.projectFilter !== 'all'">
                <button class="crumb" @click="handleClearProject">
                  {{ currentRouteType === 'sessions' ? 'Sessions' : 'Memory' }}
                </button>
                <span class="crumb-sep">/</span>
                <span
                  class="crumb terminal project-crumb"
                  :title="formatProjectLabel(state.projectFilter)"
                >
                  {{ formatProjectLabel(state.projectFilter) }}
                </span>
              </template>
              <template v-else>
                <span class="crumb terminal">
                  {{ currentRouteType === 'sessions' ? 'Sessions' : 'Memory' }}
                </span>
              </template>
            </template>
            <template v-else>
              <router-link class="crumb" to="/sessions" v-if="route.name === 'SessionDetail' || route.name === 'SubagentDetail'">
                Sessions
              </router-link>
              <template v-if="route.name === 'SubagentDetail'">
                <span class="crumb-sep">/</span>
                <router-link class="crumb" :to="`/sessions/${route.params.id}`">
                  {{ (routeSession?.title || '').slice(0, 30) || route.params.id }}
                </router-link>
              </template>
              <template v-if="route.name === 'SessionDetail'">
                <span class="crumb-sep">/</span>
                <span class="crumb terminal">
                  {{ routeSession?.title || route.params.id }}
                </span>
              </template>
              <template v-if="route.name === 'SubagentDetail'">
                <span class="crumb-sep">/</span>
                <span class="crumb terminal">{{ route.params.agentId }}</span>
              </template>
              <router-link class="crumb" to="/memory" v-if="route.name === 'MemoryDetail'">
                Memory
              </router-link>
              <template v-if="route.name === 'MemoryDetail'">
                <span class="crumb-sep">/</span>
                <span class="crumb terminal filename">
                  {{ (state.memories.find(m => m.id === route.params.id)?.path || '').split('/').pop() }}
                </span>
              </template>
              <span v-if="route.name === 'Activity'" class="crumb terminal">Activity</span>
              <span v-if="route.name === 'Recap'" class="crumb terminal">Recap</span>
              <span v-if="route.name === 'Settings'" class="crumb terminal">Settings</span>
              <router-link v-if="route.name === 'RecapDetail'" class="crumb" to="/recap">Recap</router-link>
              <template v-if="route.name === 'RecapDetail'">
                <span class="crumb-sep">/</span>
                <span class="crumb terminal">{{ route.params.id }}</span>
              </template>
            </template>
          </div>
          <div class="toolbar-spacer"></div>

          <!-- Recap toolbar actions -->
          <template v-if="route.name === 'Recap'">
            <div class="tab-group">
              <button :class="{ active: (route.query.kind || 'weekly') === 'weekly' }" @click="setRecapKind('weekly')">Weekly</button>
              <button :class="{ active: route.query.kind === 'monthly' }" @click="setRecapKind('monthly')">Monthly</button>
            </div>
            <button class="toolbar-action-primary" @click="recapGenerateOpen = true">
              <span class="plus">+</span>
              <span>Generate</span>
            </button>
          </template>

          <!-- Source filter (session list only, multi-source) -->
          <div v-if="showToolbar && route.name === 'SessionList' && sourceDots.length > 1" class="source-filter-wrap">
            <button class="filter-btn" :class="{ active: sourceFilterActive }" @click="toggleSourceFilter">
              <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                <path d="M2 3h8M3.5 6h5M5 9h2"/>
              </svg>
              <span class="filter-label">{{ sourceFilterLabel }}</span>
            </button>
            <div class="filter-dropdown" :class="{ show: showSourceFilter }">
              <div
                v-for="src in sourceDots" :key="src.id"
                class="fd-row" :class="{ checked: state.sourceFilter === 'all' || state.sourceFilter === src.id }"
                @click.stop="setSourceFilter(src.id)"
              >
                <div class="fd-check">
                  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6l2.5 2.5 4.5-5"/></svg>
                </div>
                <span class="fd-name">{{ sourceLabel(src.id, sourceDetails) }}</span>
              </div>
              <div class="fd-divider"></div>
              <div class="fd-row" :class="{ checked: state.sourceFilter === 'all' }" @click.stop="setSourceFilter('all')">
                <div class="fd-check">
                  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6l2.5 2.5 4.5-5"/></svg>
                </div>
                <span class="fd-name" style="color: var(--accent-2);">All sources</span>
              </div>
            </div>
          </div>

          <div class="toolbar-search" id="search-wrap" v-if="showToolbar">
            <svg class="toolbar-search-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
              <circle cx="7" cy="7" r="5"/>
              <path d="M11 11l3 3" stroke-linecap="round"/>
            </svg>
            <input
              ref="searchInputRef"
              id="search"
              type="text"
              placeholder="Search…"
              autocomplete="off"
              :value="state.query"
              @input="handleSearch"
            />
            <span class="toolbar-search-kbd">/</span>
          </div>
          <button
            v-if="showToolbar"
            class="sort-group"
            :class="{ desc: state.sortDesc, asc: !state.sortDesc }"
            @click="handleToggleSort"
            id="sort-toggle"
            title="Toggle sort (S)"
          >
            <span class="label" id="sort-label">{{ state.sortDesc ? 'newest' : 'oldest' }}</span>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path class="arrow-up"   d="M5 6l3-3 3 3"/>
              <path class="arrow-down" d="M5 10l3 3 3-3"/>
            </svg>
          </button>
        </div>

        <router-view v-slot="{ Component }">
          <component
            :is="Component"
            :key="route.name === 'SessionDetail' ? `session:${route.params.id}` : undefined"
          />
        </router-view>
      </main>
    </div>
  </div>
</template>
