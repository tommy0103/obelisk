<script setup>
import ChapterBody from '@/components/ChapterBody.vue';
import CountModeDemo from '@/interactives/CountModeDemo.vue';
import OrthogonalAxes from '@/interactives/OrthogonalAxes.vue';
import RecordShapes from '@/interactives/RecordShapes.vue';

const SLUG = '04-the-pivot';

defineProps({ chapter: { type: Object, required: true } });

const ANCHORS = [
  {
    afterHeading: '它是什么',
    widget: RecordShapes,
    title: '十种记录，一个一个拿起来看',
    hint: '右边那个开关是这一章的论证：切到「如果没有这一层」，每个显式字段都会被换成它当初要消灭的那次猜测。',
  },
  {
    afterHeading: '两条正交轴',
    widget: OrthogonalAxes,
    title: 'N + M，还是 N × M',
    hint: '这是个算术问题，所以直接把数字交给你。',
  },
  {
    afterHeading: '记录本身的三个设计特征',
    widget: CountModeDemo,
    title: 'countMode：让抽象承接差异',
    hint: '选错模式，跑到第二轮就对不上了。注意第一轮为什么不会暴露问题。',
  },
];
</script>

<template>
  <ChapterBody :chapter="chapter" :anchors="ANCHORS" />
</template>
