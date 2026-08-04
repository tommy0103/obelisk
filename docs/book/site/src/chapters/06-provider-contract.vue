<script setup>
import ChapterBody from '@/components/ChapterBody.vue';
import CursorLab from '@/interactives/CursorLab.vue';
import RuleQuiz from '@/interactives/RuleQuiz.vue';

const SLUG = '06-provider-contract';

defineProps({ chapter: { type: Object, required: true } });

const ANCHORS = [
  {
    afterHeading: 'Cursor：不透明是一种能力',
    widget: CursorLab,
    title: '同一个「数字:数字」，三种语义',
    hint: '拖一下滑块，看三个适配器各自把这串字符解释成了什么。下一章会把这三条泳道拆开讲。',
  },
  {
    afterHeading: '契约禁止什么',
    widget: RuleQuiz,
    props: { set: 'contract' },
    title: '这个适配器可以这么做吗',
    hint: '六个场景，两个是完全正当的用法。最容易犯的是最后两条——不能产出未定义的记录类型，不能依赖被调用的顺序。',
  },
];
</script>

<template>
  <ChapterBody :chapter="chapter" :anchors="ANCHORS" />
</template>
