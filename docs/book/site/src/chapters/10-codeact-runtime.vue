<script setup>
import ChapterBody from '@/components/ChapterBody.vue';
import QuerySandbox from '@/interactives/QuerySandbox.vue';
import SandboxWhitelist from '@/interactives/SandboxWhitelist.vue';
import TwoApis from '@/interactives/TwoApis.vue';

const SLUG = '10-codeact-runtime';

defineProps({ chapter: { type: Object, required: true } });

const ANCHORS = [
  {
    afterHeading: '白名单里没有什么',
    widget: SandboxWhitelist,
    title: '沙箱里有这个吗',
    hint: '八行代码定下了一段查询脚本的全部能力边界。读那份列表是一回事，在里面找不到 fs 是另一回事。',
  },
  {
    afterHeading: '两套 API 不相交',
    widget: TwoApis,
    title: '空交集',
    hint: '--attune 连 memories() 都调不到。这读起来像设计缺陷，直到你想起一次记忆写入必须短到人能一眼审完。',
  },
  {
    afterHeading: '为什么是 CodeAct 而不是一组工具',
    widget: QuerySandbox,
    title: '把上面四条理由跑一遍',
    hint: '「同时问两层」和「裁剪之后」是同一个问题的两种写法，差别只有一行 .map()。「顺着一条命中往上追」是多步检索——在工具形态下它要花三到四个回合。',
  },
];
</script>

<template>
  <ChapterBody :chapter="chapter" :anchors="ANCHORS" />
</template>
