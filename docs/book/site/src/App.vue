<script setup>
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { CHAPTERS, neighbours } from './book/index.js';

import BookNav from './components/BookNav.vue';
import CommandPalette from './components/CommandPalette.vue';

const route = useRoute();
const router = useRouter();

const navOpen = ref(false);
const paletteOpen = ref(false);
const scrolled = ref(0);

const slug = computed(() => (route.name === 'chapter' ? route.params.slug : ''));

watch(() => route.fullPath, () => {
  navOpen.value = false;
});

function onScroll() {
  const doc = document.documentElement;
  const max = Math.max(1, doc.scrollHeight - doc.clientHeight);
  scrolled.value = Math.min(100, (window.scrollY / max) * 100);
}

function onKeydown(event) {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName)
    || event.target?.isContentEditable;

  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    paletteOpen.value = !paletteOpen.value;
    return;
  }
  if (typing || paletteOpen.value) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  if (event.key === '/') {
    event.preventDefault();
    paletteOpen.value = true;
    return;
  }

  // Chapter turning. Only meaningful while reading one.
  if (!slug.value) return;
  const { prev, next } = neighbours(slug.value);
  if ((event.key === 'ArrowRight' || event.key === 'j') && next) router.push(`/ch/${next.slug}`);
  if ((event.key === 'ArrowLeft' || event.key === 'k') && prev) router.push(`/ch/${prev.slug}`);
}

onMounted(() => {
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('keydown', onKeydown);
  onScroll();
});

onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScroll);
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div class="shell" :class="{ 'nav-open': navOpen }">
    <div class="scroll-bar" :style="{ width: `${scrolled}%` }" />

    <button class="hamburger" type="button" aria-label="目录" @click="navOpen = !navOpen">
      <span /><span /><span />
    </button>

    <BookNav :open="navOpen" @close="navOpen = false" @palette="paletteOpen = true" />

    <main>
      <RouterView v-slot="{ Component }">
        <transition name="page" mode="out-in">
          <component :is="Component" :key="route.fullPath" />
        </transition>
      </RouterView>
    </main>

    <div v-if="navOpen" class="scrim" @click="navOpen = false" />

    <CommandPalette :open="paletteOpen" @close="paletteOpen = false" />

    <p class="keyhint" aria-hidden="true">
      <span class="kbd">⌘</span><span class="kbd">K</span> 搜索
      <span class="sep">·</span>
      <span class="kbd">←</span><span class="kbd">→</span> 翻章
      <span class="chapters">{{ CHAPTERS.length }} 篇</span>
    </p>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  min-height: 100vh;
}

.scroll-bar {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 60;
  height: 2px;
  background: linear-gradient(90deg, var(--accent-deep), var(--pink));
  transition: width 0.1s linear;
}

main {
  flex: 1;
  min-width: 0;
}

.hamburger {
  display: none;
  position: fixed;
  top: 0.75rem;
  left: 0.75rem;
  z-index: 50;
  flex-direction: column;
  gap: 3px;
  width: 2.2rem;
  height: 2.2rem;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--edge-hi);
  border-radius: 8px;
  background: rgba(10, 11, 20, 0.85);
  backdrop-filter: blur(10px);
}

.hamburger span {
  display: block;
  width: 0.85rem;
  height: 1.2px;
  background: var(--fg-soft);
}

.scrim {
  position: fixed;
  inset: 0;
  z-index: 35;
  background: rgba(4, 5, 10, 0.6);
}

.keyhint {
  position: fixed;
  right: 1rem;
  bottom: 0.85rem;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 0.28rem;
  padding: 0.3rem 0.6rem;
  border: 1px solid var(--edge);
  border-radius: 999px;
  background: rgba(10, 11, 20, 0.8);
  backdrop-filter: blur(10px);
  font: 0.66rem/1.6 var(--mono);
  color: var(--faint);
  pointer-events: none;
}

.sep {
  margin: 0 0.2rem;
}

.chapters {
  margin-left: 0.35rem;
  padding-left: 0.5rem;
  border-left: 1px solid var(--edge);
}

.page-enter-active,
.page-leave-active {
  transition: opacity 0.18s var(--ease), transform 0.18s var(--ease);
}

.page-enter-from {
  opacity: 0;
  transform: translateY(6px);
}

.page-leave-to {
  opacity: 0;
}

@media (max-width: 1080px) {
  .hamburger {
    display: flex;
  }
}

@media (max-width: 640px) {
  .keyhint {
    display: none;
  }
}
</style>
