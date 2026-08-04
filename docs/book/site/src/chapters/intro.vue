<script setup>
import ChapterBody from '@/components/ChapterBody.vue';
import SystemMap from '@/interactives/SystemMap.vue';

const SLUG = 'intro';

defineProps({ chapter: { type: Object, required: true } });

const ANCHORS = [
  {
    afterHeading: '组织方式',
    widget: SystemMap,
    tag: 'MAP',
    title: '这本书要讲的东西，一张图',
    hint: '现在看不懂是正常的——第一部分的四章就是为了让你能凭记忆把它画出来。点任意部件可以直接跳到讲它的那一章。',
  },
];
</script>

<template>
  <ChapterBody :chapter="chapter" :anchors="ANCHORS" />
</template>
