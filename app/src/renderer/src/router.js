// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Vue Router configuration for Obelisk.
// Routes map to the main content views; sidebar navigation drives route changes.

import { createRouter, createWebHashHistory } from 'vue-router';

// Lazy-loaded view components (will be created as Vue SFCs later)
const SessionList = () => import('./views/SessionList.vue');
const SessionDetail = () => import('./views/SessionDetail.vue');
const SubagentDetail = () => import('./views/SubagentDetail.vue');
const MemoryList = () => import('./views/MemoryList.vue');
const Activity = () => import('./views/Activity.vue');
const Recap = () => import('./views/RecapList.vue');
const RecapDetail = () => import('./views/RecapDetail.vue');
const RecapExport = () => import('./views/RecapExport.vue');
const Settings = () => import('./views/Settings.vue');

const routes = [
  {
    path: '/sessions',
    name: 'SessionList',
    component: SessionList
  },
  {
    path: '/sessions/:id',
    name: 'SessionDetail',
    component: SessionDetail,
    props: true
  },
  {
    path: '/sessions/:id/agent/:agentId',
    name: 'SubagentDetail',
    component: SubagentDetail,
    props: true
  },
  {
    path: '/memory',
    name: 'MemoryList',
    component: MemoryList
  },
  {
    path: '/memory/:id',
    name: 'MemoryDetail',
    component: MemoryList,
    props: true
  },
  {
    path: '/activity',
    name: 'Activity',
    component: Activity
  },
  {
    path: '/recap',
    name: 'Recap',
    component: Recap
  },
  {
    path: '/recap/:id',
    name: 'RecapDetail',
    component: RecapDetail,
    props: true
  },
  {
    path: '/recap-export',
    name: 'RecapExport',
    component: RecapExport
  },
  {
    path: '/settings',
    name: 'Settings',
    component: Settings
  },
  {
    path: '/',
    redirect: '/memory'
  },
  {
    // Catch-all redirect
    path: '/:pathMatch(.*)*',
    redirect: '/memory'
  }
];

const router = createRouter({
  history: createWebHashHistory(),
  routes
});

export default router;
