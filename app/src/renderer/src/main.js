// Vue 3 application entry point for Obelisk.

import { createApp } from 'vue';
import App from './App.vue';
import router from './router.js';
import { commitInitialData, fetchInitialData } from './data.js';
import { noteSessionUpdated, sessionLiveState } from './session-live.mjs';
import { createGlobalDataRefreshCoordinator } from './session-global-refresh.mjs';
import { installLocalMarkdownLinkHandlers } from './local-markdown-links.js';

// Import shared renderer CSS globally
import '../styles/base.css';
import '../styles/sidebar.css';
import '../styles/toolbar.css';
import '../styles/list.css';
import '../styles/detail.css';

const app = createApp(App);

app.use(router);

const globalDataRefresh = createGlobalDataRefreshCoordinator({
  isDeferred: () => {
    const routeName = router.currentRoute.value.name;
    return routeName === 'SessionDetail';
  },
  load: fetchInitialData,
  commit: commitInitialData,
});

function reportGlobalRefreshFailure(request) {
  void request.catch(error => {
    console.error('Failed to refresh Obelisk catalogues:', error);
  });
}

// Load data on startup
router.isReady().then(() => {
  reportGlobalRefreshFailure(globalDataRefresh.initialize());
});

router.afterEach(() => {
  reportGlobalRefreshFailure(globalDataRefresh.flush());
});

// Refresh data when window regains focus
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    reportGlobalRefreshFailure(globalDataRefresh.invalidate());
  }
});

window.obelisk?.onIndexUpdated?.(() => {
  reportGlobalRefreshFailure(globalDataRefresh.invalidate());
});

window.obelisk?.onSessionUpdated?.(({ sessionId } = {}) => {
  const route = router.currentRoute.value;
  const currentSessionId = route.name === 'SessionDetail' ? String(route.params.id || '') : null;
  noteSessionUpdated(sessionLiveState, sessionId, currentSessionId);
});

installLocalMarkdownLinkHandlers();

app.mount('#app');
