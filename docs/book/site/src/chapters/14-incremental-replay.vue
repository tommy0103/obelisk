<script setup>
import ChapterBody from '@/components/ChapterBody.vue';
import CursorLab from '@/interactives/CursorLab.vue';
import SchemaExplorer from '@/interactives/SchemaExplorer.vue';

const SLUG = '14-incremental-replay';

defineProps({ chapter: { type: Object, required: true } });

const ANCHORS = [
  {
    afterHeading: '第一层：游标',
    widget: CursorLab,
    title: '游标一圈的生命，三种走法',
    hint: '换到「旁路元数据变了，转写文件的 mtime 没变」——这正是纯 mtime 增量扛不住、需要 forcedPaths 补偿的那个盲区。',
  },
  {
    afterHeading: '第三层：force rebuild',
    widget: SchemaExplorer,
    title: '清得干净，但不碰记忆',
    hint: '按下按钮：八张证据表清空重来，memories 纹丝不动。正因为最坏情况下的损失有界，才敢把「清空重建」做成一个用户随手能点的按钮。',
  },
];
</script>

<template>
  <ChapterBody :chapter="chapter" :anchors="ANCHORS" />
</template>
