<script setup>
import InlineSpans from './InlineSpans.js';

defineProps({
  head: { type: Array, required: true },
  rows: { type: Array, required: true },
});
</script>

<template>
  <div class="wrap">
    <table>
      <thead>
        <tr>
          <th v-for="(cell, i) in head" :key="i"><InlineSpans :spans="cell" plain /></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, r) in rows" :key="r">
          <td v-for="(cell, c) in row" :key="c"><InlineSpans :spans="cell" /></td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.wrap {
  margin: 1.7rem 0;
  border: 1px solid var(--edge);
  border-radius: var(--radius);
  overflow-x: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}

th,
td {
  padding: 0.62rem 0.9rem;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid var(--edge);
}

th {
  background: rgba(255, 255, 255, 0.02);
  font: 600 0.68rem/1.7 var(--mono);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--faint);
  white-space: nowrap;
}

tbody tr:last-child td {
  border-bottom: 0;
}

tbody tr:hover td {
  background: rgba(255, 255, 255, 0.018);
}

td :deep(code) {
  font-size: 0.8em;
}
</style>
