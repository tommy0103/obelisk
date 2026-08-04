<script setup>
import ChapterBody from '@/components/ChapterBody.vue';
import TwoApis from '@/interactives/TwoApis.vue';

const SLUG = '01-what-it-is';

defineProps({ chapter: { type: Object, required: true } });

const ANCHORS = [
  {
    afterHeading: '四个动词',
    widget: TwoApis,
    title: '整个公共面，一屏放得下',
    hint: '四个动词，两套不相交的沙箱 API。点一个动词看它拿到哪一套。',
  },
];
</script>

<template>
  <ChapterBody :chapter="chapter" :anchors="ANCHORS" />
</template>
