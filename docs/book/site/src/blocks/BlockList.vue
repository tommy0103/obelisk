<script setup>
// Renders a list of parsed markdown blocks. Recurses into itself for the
// contents of quotes and 「当时」 sidebars.

import AsciiDiagram from './AsciiDiagram.vue';
import CodeBlock from './CodeBlock.vue';
import DataTable from './DataTable.vue';
import InlineSpans from './InlineSpans.js';
import SidebarNote from './SidebarNote.vue';

defineProps({
  blocks: { type: Array, required: true },
});
</script>

<template>
  <template v-for="(b, i) in blocks" :key="i">
    <component
      :is="`h${b.level}`"
      v-if="b.t === 'h'"
      :id="b.id"
    >
      <a class="anchor" :href="`#${b.id}`" aria-hidden="true">#</a>
      <InlineSpans :spans="b.c" plain />
    </component>

    <p v-else-if="b.t === 'p'"><InlineSpans :spans="b.c" /></p>

    <CodeBlock
      v-else-if="b.t === 'code' && !b.diagram"
      :lang="b.lang"
      :raw="b.raw"
      :tokens="b.tokens"
    />

    <AsciiDiagram v-else-if="b.t === 'code'" :raw="b.raw" />

    <DataTable v-else-if="b.t === 'table'" :head="b.head" :rows="b.rows" />

    <component :is="b.ordered ? 'ol' : 'ul'" v-else-if="b.t === 'list'">
      <li v-for="(item, n) in b.items" :key="n"><InlineSpans :spans="item" /></li>
    </component>

    <blockquote v-else-if="b.t === 'quote'"><BlockList :blocks="b.c" /></blockquote>

    <SidebarNote v-else-if="b.t === 'note'"><BlockList :blocks="b.c" /></SidebarNote>

    <hr v-else-if="b.t === 'hr'" />
  </template>
</template>

<style scoped>
.anchor {
  position: absolute;
  margin-left: -1.1em;
  border: 0;
  color: var(--dim);
  font-family: var(--mono);
  font-weight: 400;
  opacity: 0;
  transition: opacity 0.15s var(--ease);
}

h2,
h3 {
  position: relative;
}

h2:hover .anchor,
h3:hover .anchor,
.anchor:focus-visible {
  opacity: 1;
}

@media (max-width: 900px) {
  .anchor {
    display: none;
  }
}
</style>
