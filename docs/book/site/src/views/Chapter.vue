<script setup>
import { computed, defineAsyncComponent, onMounted, watch } from 'vue';
import { RouterLink } from 'vue-router';

import { chapterAt, neighbours } from '@/book/index.js';
import { markVisited, progress } from '@/book/progress.js';

import Checkpoint from '@/components/Checkpoint.vue';

const props = defineProps({
  slug: { type: String, required: true },
});

const chapter = computed(() => chapterAt(props.slug));
const around = computed(() => neighbours(props.slug));

const view = computed(() =>
  defineAsyncComponent({
    loader: chapter.value.load,
    delay: 120,
  }),
);

const track = () => markVisited(props.slug);
onMounted(track);
watch(() => props.slug, track);
</script>

<template>
  <article v-if="chapter" class="chapter">
    <header>
      <div class="crumbs">
        <span v-if="chapter.num" class="n">第 {{ chapter.num }} 章</span>
        <span v-else-if="chapter.kind === 'back'" class="n">附录 A</span>
        <span v-else class="n">开篇</span>
        <span class="meta">约 {{ chapter.minutes }} 分钟</span>
        <span v-if="chapter.notes" class="meta">{{ chapter.notes }} 个「当时」</span>
        <span v-if="progress.read[chapter.slug]" class="meta read">已读</span>
      </div>
      <h1>{{ chapter.shortTitle }}</h1>
      <p v-if="chapter.hook" class="hook">{{ chapter.hook }}</p>
    </header>

    <component :is="view" :chapter="chapter" />

    <Checkpoint v-if="chapter.quiz.length" :slug="chapter.slug" :quiz="chapter.quiz" />

    <nav class="turn">
      <RouterLink v-if="around.prev" class="side prev" :to="`/ch/${around.prev.slug}`">
        <span class="dir">← 上一章</span>
        <span class="t">{{ around.prev.shortTitle }}</span>
      </RouterLink>
      <span v-else class="side spacer" />
      <RouterLink v-if="around.next" class="side next" :to="`/ch/${around.next.slug}`">
        <span class="dir">下一章 →</span>
        <span class="t">{{ around.next.shortTitle }}</span>
      </RouterLink>
      <RouterLink v-else class="side next" to="/">
        <span class="dir">读完了 →</span>
        <span class="t">回到封面</span>
      </RouterLink>
    </nav>
  </article>
</template>

<style scoped>
.chapter {
  max-width: calc(var(--measure) + 9rem);
  margin: 0 auto;
  padding: 4.5rem 3rem 7rem;
}

header {
  margin-bottom: 3rem;
  padding-bottom: 1.6rem;
  border-bottom: 1px solid var(--edge);
}

.crumbs {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-bottom: 0.7rem;
}

.n {
  font: 600 0.7rem/1.7 var(--mono);
  letter-spacing: 0.15em;
  color: var(--accent);
}

.meta {
  font: 0.68rem/1.7 var(--mono);
  color: var(--faint);
}

.meta.read {
  color: var(--green);
}

h1 {
  font: 600 2.05rem/1.35 var(--serif);
  letter-spacing: 0.005em;
  color: var(--fg);
}

.hook {
  margin-top: 0.7rem;
  font-size: 0.95rem;
  line-height: 1.75;
  color: var(--muted);
}

.turn {
  display: flex;
  gap: 0.7rem;
  margin-top: 3.5rem;
  padding-top: 1.4rem;
  border-top: 1px solid var(--edge);
}

.side {
  flex: 1;
  padding: 0.75rem 0.95rem;
  border: 1px solid var(--edge);
  border-radius: var(--radius-sm);
  transition: all 0.15s var(--ease);
}

.side:hover {
  border-color: var(--accent-line);
  background: var(--accent-soft);
}

.side.spacer {
  border: 0;
}

.side.next {
  text-align: right;
}

.dir {
  display: block;
  font: 0.66rem/1.7 var(--mono);
  color: var(--faint);
}

.t {
  display: block;
  margin-top: 0.1rem;
  font-size: 0.86rem;
  line-height: 1.5;
  color: var(--fg-soft);
}

@media (max-width: 1080px) {
  .chapter {
    padding: 4rem 1.2rem 5rem;
  }

  h1 {
    font-size: 1.6rem;
  }
}
</style>
