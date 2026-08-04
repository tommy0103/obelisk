<script setup>
import ChapterBody from '@/components/ChapterBody.vue';
import PatchLab from '@/interactives/PatchLab.vue';

const SLUG = '12-presentation';

defineProps({ chapter: { type: Object, required: true } });

const ANCHORS = [
  {
    afterHeading: '实时刷新：快照 + 补丁',
    widget: PatchLab,
    title: '为什么位置也要进指纹',
    hint: '把指纹切成「只有内容」，然后在最前面插入一条——补丁会是空的，尽管每一行都移动了。这就是那半个指纹存在的理由。',
  },
];
</script>

<template>
  <ChapterBody :chapter="chapter" :anchors="ANCHORS" />
</template>
