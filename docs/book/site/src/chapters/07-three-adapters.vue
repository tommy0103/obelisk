<script setup>
import ChapterBody from '@/components/ChapterBody.vue';
import CountModeDemo from '@/interactives/CountModeDemo.vue';
import CursorLab from '@/interactives/CursorLab.vue';

const SLUG = '07-three-adapters';

defineProps({ chapter: { type: Object, required: true } });

const ANCHORS = [
  {
    afterHeading: 'Claude：行增量',
    widget: CountModeDemo,
    title: 'skip > 0 ? delta : total',
    hint: '同一个适配器在两种模式之间切换。先用 delta 跑三轮，再切到 total 跑三轮，看哪一种和真实条数对得上。',
  },
  {
    afterHeading: 'Kimi：目录投影 + 全量替换',
    widget: CursorLab,
    title: '三种增量策略，并排跑一遍',
    hint: '换到「用户撤回了最近 3 条」——这一条彻底否决了行增量，也解释了为什么 Kimi 每次 parse 的第一条产出是 delete-session。',
  },
];
</script>

<template>
  <ChapterBody :chapter="chapter" :anchors="ANCHORS" />
</template>
