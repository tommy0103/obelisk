import { createRouter, createWebHashHistory } from 'vue-router';

import { CHAPTERS } from './book/index.js';

// Hash history: the built site has to work from a plain static host (and from
// file://) with no server rewrites. Same choice the desktop app makes.
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'cover', component: () => import('./views/Cover.vue') },
    { path: '/map', name: 'map', component: () => import('./views/MapView.vue') },
    {
      path: '/ch/:slug',
      name: 'chapter',
      component: () => import('./views/Chapter.vue'),
      props: true,
      beforeEnter: (to) => (CHAPTERS.some((c) => c.slug === to.params.slug) ? true : { name: 'cover' }),
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
  scrollBehavior(to, from, saved) {
    if (to.hash) return { el: to.hash, top: 88, behavior: 'smooth' };
    if (saved) return saved;
    return { top: 0 };
  },
});

export default router;
