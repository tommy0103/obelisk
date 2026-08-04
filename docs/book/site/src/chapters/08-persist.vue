<script setup>
import ChapterBody from '@/components/ChapterBody.vue';
import UpsertLab from '@/interactives/UpsertLab.vue';

const SLUG = '08-persist';

defineProps({ chapter: { type: Object, required: true } });

const ANCHORS = [
  {
    afterHeading: '三种写语义，各有各的理由',
    widget: UpsertLab,
    title: '那一列，和那个 COALESCE',
    hint: '第一个标签页：用 INSERT OR REPLACE 跑「索引一轮 → 耗时到达 → 索引一轮」，看耗时怎么静默消失。第二个：交换两个单元的到达顺序，看结果为什么一样。',
  },
];
</script>

<template>
  <ChapterBody :chapter="chapter" :anchors="ANCHORS" />
</template>
