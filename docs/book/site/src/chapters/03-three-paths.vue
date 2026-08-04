<script setup>
import { PATHS_FLOW } from '@/book/flows.js';
import ChapterBody from '@/components/ChapterBody.vue';
import QuerySandbox from '@/interactives/QuerySandbox.vue';
import StepFlow from '@/interactives/StepFlow.vue';

const SLUG = '03-three-paths';

defineProps({ chapter: { type: Object, required: true } });

const ANCHORS = [
  {
    afterHeading: '路径二 · 检索：从一句提问到一份 JSON',
    widget: QuerySandbox,
    title: '过滤发生在数据这一侧',
    hint: '选「同时问两层」跑一遍，再选「裁剪之后」跑一遍——同一个问题，看回到 context 的字节数。',
  },
  {
    afterHeading: '三条路径，一个交点',
    widget: StepFlow,
    props: { flow: PATHS_FLOW },
    tag: 'PLAY',
    title: '让这张图动起来',
    hint: '三条路径分开走一遍。地图上亮起来的是这一步碰到的部件——三条路径最后都会点亮中间那个方块。',
  },
];
</script>

<template>
  <ChapterBody :chapter="chapter" :anchors="ANCHORS" />
</template>
