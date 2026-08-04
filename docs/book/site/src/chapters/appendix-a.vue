<script setup>
import ChapterBody from '@/components/ChapterBody.vue';
import QuerySandbox from '@/interactives/QuerySandbox.vue';

const SLUG = 'appendix-a';

defineProps({ chapter: { type: Object, required: true } });

const ANCHORS = [
  {
    afterHeading: '二、第一条查询',
    widget: QuerySandbox,
    title: '不装也能先跑一条',
    hint: '和上面那段 /tmp/q.mjs 一样的写法，只是索引换成了一个页内的迷你库。装好之后把同一段脚本贴进 obelisk --query，形状完全一致。',
  },
];
</script>

<template>
  <ChapterBody :chapter="chapter" :anchors="ANCHORS" />
</template>
