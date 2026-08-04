<script setup>
import ChapterBody from '@/components/ChapterBody.vue';
import RuleQuiz from '@/interactives/RuleQuiz.vue';
import SystemMap from '@/interactives/SystemMap.vue';

const SLUG = '02-module-map';

defineProps({ chapter: { type: Object, required: true } });

const ANCHORS = [
  {
    afterHeading: 'Core 内部：六组模块',
    widget: SystemMap,
    tag: 'MAP',
    title: '同一张图，两种读法',
    hint: '切到「依赖方向」看第二种：所有箭头单向，全部收敛到 providers/types.ts。',
  },
  {
    afterHeading: '三条依赖规则',
    widget: RuleQuiz,
    props: { set: 'deps' },
    title: '这个改动破坏了哪条规则？',
    hint: '八个真实形状的改动，其中三个是完全合规的——规则的边界要靠合规的例子才划得清。',
  },
];
</script>

<template>
  <ChapterBody :chapter="chapter" :anchors="ANCHORS" />
</template>
