<script setup>
// The cover. Three ways in, because three kinds of reader show up:
// someone who wants the shape in 30 seconds, someone reading it through, and
// someone who came to look up one component.

import { computed } from 'vue';
import { RouterLink } from 'vue-router';

import { CHAPTERS, SECTIONS, TOTAL_MINUTES, TOTAL_NOTES } from '@/book/index.js';
import { progress } from '@/book/progress.js';

import SystemMap from '@/interactives/SystemMap.vue';

const readCount = computed(() => CHAPTERS.filter((c) => progress.read[c.slug]).length);

const resume = computed(() => {
  if (!progress.lastSlug) return null;
  return CHAPTERS.find((c) => c.slug === progress.lastSlug) || null;
});

const firstUnread = computed(
  () => CHAPTERS.find((c) => !progress.read[c.slug] && c.kind === 'chapter') || CHAPTERS[1],
);
</script>

<template>
  <div class="cover">
    <header class="hero">
      <span class="eyebrow">基线 v0.2.2 · 三源架构</span>
      <h1>Obelisk 架构解读</h1>
      <p class="lede">给 coding agent 造一层可查询的记忆。</p>
      <p class="blurb">
        这本书从代码出发，讲清楚 Obelisk 这套东西是怎么搭起来的：它承诺什么、拒绝什么、支点在哪里、被什么力量反复挤压。
        每一章都带着可以动手验证的装置——你不必相信书里的说法，可以自己把它跑一遍。
      </p>

      <div class="doors">
        <RouterLink class="door primary" to="/map">
          <b>30 秒看清形状</b>
          <span>点开模块地图，任意部件都能告诉你它做什么、在哪一章。</span>
        </RouterLink>
        <RouterLink class="door" :to="`/ch/${resume ? resume.slug : 'intro'}`">
          <b>{{ resume ? `继续读：${resume.shortTitle}` : '从头读起' }}</b>
          <span>{{ resume ? `已读 ${readCount} / ${CHAPTERS.length} 章` : `${CHAPTERS.length} 篇，约 ${TOTAL_MINUTES} 分钟` }}</span>
        </RouterLink>
        <RouterLink v-if="resume" class="door" :to="`/ch/${firstUnread.slug}`">
          <b>下一章没读过的</b>
          <span>{{ firstUnread.shortTitle }}</span>
        </RouterLink>
      </div>

      <p class="hint">
        随时按 <span class="kbd">⌘</span><span class="kbd">K</span> 搜全书，
        <span class="kbd">←</span><span class="kbd">→</span> 翻章。
      </p>
    </header>

    <section class="map-block">
      <SystemMap />
    </section>

    <section class="stats">
      <div><b>{{ CHAPTERS.length }}</b><span>篇</span></div>
      <div><b>{{ TOTAL_MINUTES }}</b><span>分钟</span></div>
      <div><b>{{ TOTAL_NOTES }}</b><span>个「当时」方块</span></div>
      <div><b>3</b><span>个来源，一套表</span></div>
    </section>

    <section class="how">
      <h2>怎么读</h2>
      <p>
        <b>整体 → 局部 → 横切。</b>
        第一部分建立对整个系统的正确认知，不碰实现。第二部分逐个部件展开，顺序是依赖顺序——每章只依赖它前面的章。
        第三部分处理那些不属于任何单一部件的问题。
      </p>
      <p class="conv">
        正文只讲从代码里能读出来的东西。章节里那些折叠起来的 <b>「当时」</b> 方块，
        用真实的历史会话记录回答「这里为什么不写得更简单一点」——它是脚注，不是主线，跳过不影响理解。
      </p>
    </section>

    <section v-for="sec in SECTIONS" :key="sec.key" class="part">
      <header class="part-head">
        <h3>{{ sec.label }}</h3>
        <p v-if="sec.hint">{{ sec.hint }}</p>
      </header>
      <div class="cards">
        <RouterLink
          v-for="c in sec.chapters"
          :key="c.slug"
          class="card"
          :class="{ read: progress.read[c.slug] }"
          :to="`/ch/${c.slug}`"
        >
          <span class="c-num">{{ c.num || (c.kind === 'front' ? '开篇' : 'A') }}</span>
          <span class="c-title">{{ c.shortTitle }}</span>
          <span class="c-hook">{{ c.hook }}</span>
          <span class="c-meta">
            {{ c.minutes }} 分钟
            <span v-if="c.notes">· {{ c.notes }} 个「当时」</span>
            <span v-if="progress.read[c.slug]" class="tick">· 已读</span>
          </span>
        </RouterLink>
      </div>
    </section>

    <footer class="foot">
      <p>
        正文由 <code>docs/book/*.md</code> 在构建期解析生成——那 17 个 markdown 文件是唯一的正文源，
        这个站点从不修改它们。
      </p>
    </footer>
  </div>
</template>

<style scoped>
.cover {
  max-width: 62rem;
  margin: 0 auto;
  padding: 5rem 3rem 7rem;
}

.eyebrow {
  font: 600 0.68rem/1.7 var(--mono);
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--accent);
}

h1 {
  margin-top: 0.6rem;
  font: 600 clamp(2.2rem, 5vw, 3.4rem)/1.15 var(--serif);
  letter-spacing: -0.01em;
  color: var(--fg);
}

.lede {
  margin-top: 0.6rem;
  font: 1.1rem/1.6 var(--serif);
  color: var(--accent);
}

.blurb {
  max-width: 40rem;
  margin-top: 1.1rem;
  font-size: 0.98rem;
  line-height: 1.85;
  color: var(--muted);
}

.doors {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  gap: 0.6rem;
  margin-top: 2rem;
}

.door {
  padding: 0.85rem 1rem;
  border: 1px solid var(--edge);
  border-radius: var(--radius);
  background: var(--panel);
  transition: all 0.16s var(--ease);
}

.door:hover {
  border-color: var(--accent-line);
  background: var(--accent-soft);
  transform: translateY(-1px);
}

.door.primary {
  border-color: var(--accent-line);
  background: rgba(167, 139, 250, 0.09);
}

.door b {
  display: block;
  font: 600 0.92rem/1.5 var(--sans);
  color: var(--fg);
}

.door span {
  display: block;
  margin-top: 0.2rem;
  font-size: 0.78rem;
  line-height: 1.6;
  color: var(--faint);
}

.hint {
  margin-top: 1rem;
  font: 0.74rem/1.9 var(--mono);
  color: var(--faint);
}

.map-block {
  margin: 3.5rem 0 3rem;
  padding: 1.3rem;
  border: 1px solid var(--edge);
  border-radius: var(--radius);
  background: var(--bg-lift);
}

.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: 0.6rem;
  margin-bottom: 3.5rem;
}

.stats div {
  padding: 0.75rem 0.9rem;
  border: 1px solid var(--edge);
  border-radius: var(--radius-sm);
}

.stats b {
  display: block;
  font: 700 1.5rem/1.2 var(--mono);
  color: var(--fg);
  font-variant-numeric: tabular-nums;
}

.stats span {
  font: 0.7rem/1.7 var(--mono);
  color: var(--faint);
}

.how {
  max-width: 44rem;
  margin-bottom: 3.5rem;
}

h2 {
  font: 600 1.35rem/1.4 var(--serif);
  color: var(--fg);
  margin-bottom: 0.8rem;
}

.how p {
  font-size: 0.95rem;
  line-height: 1.85;
  color: var(--muted);
}

.how p + p {
  margin-top: 0.9rem;
}

.how b {
  color: var(--fg);
}

.part {
  margin-bottom: 2.6rem;
}

.part-head {
  display: flex;
  align-items: baseline;
  gap: 0.9rem;
  flex-wrap: wrap;
  margin-bottom: 0.85rem;
  padding-bottom: 0.55rem;
  border-bottom: 1px solid var(--edge);
}

h3 {
  font: 600 0.95rem/1.5 var(--sans);
  color: var(--fg);
}

.part-head p {
  font-size: 0.78rem;
  color: var(--faint);
}

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
  gap: 0.55rem;
}

.card {
  display: flex;
  flex-direction: column;
  gap: 0.22rem;
  padding: 0.75rem 0.9rem 0.8rem;
  border: 1px solid var(--edge);
  border-radius: var(--radius-sm);
  transition: all 0.16s var(--ease);
}

.card:hover {
  border-color: var(--accent-line);
  background: var(--accent-soft);
}

.c-num {
  font: 600 0.64rem/1.7 var(--mono);
  letter-spacing: 0.14em;
  color: var(--faint);
}

.card.read .c-num {
  color: var(--green);
}

.c-title {
  font: 600 0.9rem/1.45 var(--sans);
  color: var(--fg);
}

.c-hook {
  font-size: 0.775rem;
  line-height: 1.65;
  color: var(--faint);
}

.c-meta {
  margin-top: 0.25rem;
  font: 0.66rem/1.7 var(--mono);
  color: var(--faint);
}

.tick {
  color: var(--green);
}

.foot {
  margin-top: 3rem;
  padding-top: 1.4rem;
  border-top: 1px solid var(--edge);
  font-size: 0.78rem;
  line-height: 1.8;
  color: var(--faint);
}

.foot code {
  font-family: var(--mono);
  color: var(--muted);
}

@media (max-width: 1080px) {
  .cover {
    padding: 4rem 1.2rem 5rem;
  }

  .map-block {
    padding: 0.7rem;
  }
}
</style>
