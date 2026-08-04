<script setup>
import ChapterBody from '@/components/ChapterBody.vue';
import SchemaExplorer from '@/interactives/SchemaExplorer.vue';

const SLUG = '05-data-layer';

defineProps({ chapter: { type: Object, required: true } });

const ANCHORS = [
  {
    afterHeading: '三类表，性质完全不同',
    widget: SchemaExplorer,
    title: '十张表，按「能不能重建」分',
    hint: '按下「模拟一次 force rebuild」——八张表清空重来，一张纹丝不动，一张全清但留一个 key。这个分类是有执行后果的。',
  },
];
</script>

<template>
  <ChapterBody :chapter="chapter" :anchors="ANCHORS" />
</template>
