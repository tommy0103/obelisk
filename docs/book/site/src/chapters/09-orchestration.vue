<script setup>
import { BUILD_FLOW } from '@/book/flows.js';
import ChapterBody from '@/components/ChapterBody.vue';
import StepFlow from '@/interactives/StepFlow.vue';

const SLUG = '09-orchestration';

defineProps({ chapter: { type: Object, required: true } });

const ANCHORS = [
  {
    afterHeading: '骨架',
    widget: StepFlow,
    props: { flow: BUILD_FLOW },
    tag: 'PLAY',
    title: '一次 build，四种走法',
    hint: '先看「一切正常」，再挨个注入三种失败。三条降级分支按严重程度递减排列——这个顺序本身就是策略。',
  },
];
</script>

<template>
  <ChapterBody :chapter="chapter" :anchors="ANCHORS" />
</template>
