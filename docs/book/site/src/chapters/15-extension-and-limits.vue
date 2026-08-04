<script setup>
import ChapterBody from '@/components/ChapterBody.vue';
import RuleQuiz from '@/interactives/RuleQuiz.vue';
import SystemMap from '@/interactives/SystemMap.vue';

const SLUG = '15-extension-and-limits';

defineProps({ chapter: { type: Object, required: true } });

const ANCHORS = [
  {
    afterHeading: '六个容易踩的坑',
    widget: RuleQuiz,
    props: { set: 'pitfalls' },
    title: '接一个新来源，这么做会出事吗',
    hint: '五个场景。会出事的那几个都有同一个共同点——不会报错。',
  },
  {
    afterHeading: '尚未完成的方向',
    widget: SystemMap,
    tag: 'MAP',
    title: '最后再看一遍这张图',
    hint: '现在你应该能不看它把它画出来了：中间那个方块是一个没有一行运行代码的类型定义，而它被三种范式各异的数据源、两种 SQLite binding、两个使用面、五种并发写者各撑过一遍。',
  },
];
</script>

<template>
  <ChapterBody :chapter="chapter" :anchors="ANCHORS" />
</template>
