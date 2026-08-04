<script setup>
import { MEMORY_FLOW } from '@/book/flows.js';
import ChapterBody from '@/components/ChapterBody.vue';
import StepFlow from '@/interactives/StepFlow.vue';

const SLUG = '11-memory-layer';

defineProps({ chapter: { type: Object, required: true } });

const ANCHORS = [
  {
    afterHeading: '一条记忆的完整生命',
    widget: StepFlow,
    props: { flow: MEMORY_FLOW },
    tag: 'PLAY',
    title: '从头到尾，两个批准点',
    hint: '注意两个橙色标记落在哪儿：写文件是文件写入批准，注册是命令执行批准。没有为记忆层单独发明一套批准机制——这是它能被信任的重要原因。',
  },
];
</script>

<template>
  <ChapterBody :chapter="chapter" :anchors="ANCHORS" />
</template>
