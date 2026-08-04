<script setup>
import ChapterBody from '@/components/ChapterBody.vue';
import LeaseTimeline from '@/interactives/LeaseTimeline.vue';

const SLUG = '13-concurrency';

defineProps({ chapter: { type: Object, required: true } });

const ANCHORS = [
  {
    afterHeading: '第三层：谁有资格写',
    widget: LeaseTimeline,
    title: '同样的六个时刻，跑两遍',
    hint: '开着租约先看一遍，然后把它关掉——那条 cannot rollback 的报错会自己出现，而且你能看到它盖掉了什么。',
  },
];
</script>

<template>
  <ChapterBody :chapter="chapter" :anchors="ANCHORS" />
</template>
