// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Vue 3 application entry point for Obelisk.

import { createApp } from 'vue';
import App from './App.vue';
import router from './router.js';
import { commitInitialData, fetchInitialData } from './data.js';
import { noteSessionUpdated, sessionLiveState } from './session-live.mjs';
import { createGlobalDataRefreshCoordinator } from './session-global-refresh.mjs';
import { registerSessionImageElement } from './session-image-element.js';
import { configureMarkdownImages } from './markdown-image-renderer.js';
import { installFileReferenceHandler } from './file-references.mjs';

// Import shared renderer CSS globally
import '../styles/base.css';
import '../styles/sidebar.css';
import '../styles/toolbar.css';
import '../styles/list.css';
import '../styles/detail.css';

registerSessionImageElement();
// marked is loaded globally via CDN in index.html, ahead of this module.
configureMarkdownImages(window.marked);

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

installFileReferenceHandler();

app.mount('#app');
