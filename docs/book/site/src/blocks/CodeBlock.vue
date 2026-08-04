<script setup>
// A fenced code block from the book. Tokens are produced at build time; this
// component only paints them and adds copy.
//
// No header bar: the language sits in the top-right corner, which is where
// readers of code-heavy docs look for it, and the copy button joins it on
// hover. A full-width bar above every one of the ~190 blocks in this book was
// more chrome than the content deserved.

import { computed, ref } from 'vue';

const props = defineProps({
  lang: { type: String, default: '' },
  raw: { type: String, required: true },
  tokens: { type: Array, required: true },
});

// Spelled out. `TS` reads like an abbreviation the reader is supposed to
// already share with us; the whole book is written the other way around.
const LANG_LABEL = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  js: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  jsx: 'JavaScript',
  sql: 'SQL',
  bash: 'Shell',
  sh: 'Shell',
  json: 'JSON',
  yml: 'YAML',
  yaml: 'YAML',
};

const label = computed(() => LANG_LABEL[props.lang] || props.lang || '');
const copied = ref(false);

async function copy() {
  try {
    await navigator.clipboard.writeText(props.raw);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1400);
  } catch {
    // Clipboard is unavailable (insecure origin, denied permission). Nothing
    // useful to do — the code is selectable either way.
  }
}
</script>

<template>
  <figure class="code" :class="`lang-${lang || 'plain'}`">
    <pre class="code-face"><code><span
      v-for="(tk, i) in tokens"
      :key="i"
      :class="tk.t ? `tk-${tk.t}` : null"
    >{{ tk.v }}</span></code></pre>

    <div class="corner">
      <button class="copy" :class="{ done: copied }" type="button" @click="copy">
        {{ copied ? '已复制' : '复制' }}
      </button>
      <span v-if="label" class="lang">{{ label }}</span>
    </div>
  </figure>
</template>

<style scoped>
.code {
  position: relative;
  margin: 1.6rem 0;
  border: 1px solid var(--edge);
  border-radius: var(--radius);
  background: var(--bg-sunk);
  overflow: hidden;
}

pre {
  margin: 0;
  /* Right padding leaves room for the corner label so a long first line does
     not slide underneath it. */
  padding: 1rem 6.5rem 1.05rem 1.1rem;
  overflow-x: auto;
  /* .code-face carries the shared size/leading; see styles/code.css for why it
     has to live on the block box rather than on the inner `code`. */
}

code {
  /* Reset defensively: this sits inside .prose, where `code` is styled as an
     inline chip. An inline chip that wraps draws one box per line. */
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: var(--fg-soft);
  white-space: pre;
}

.corner {
  position: absolute;
  top: 0.5rem;
  right: 0.65rem;
  display: flex;
  align-items: center;
  gap: 0.45rem;
  pointer-events: none;
}

.lang {
  font: 0.66rem/1.6 var(--mono);
  letter-spacing: 0.04em;
  color: var(--faint);
  user-select: none;
}

.copy {
  padding: 0.1rem 0.5rem;
  border: 1px solid var(--edge-hi);
  border-radius: 5px;
  background: var(--bg-sunk);
  font: 0.66rem/1.6 var(--mono);
  color: var(--faint);
  opacity: 0;
  pointer-events: auto;
  transition: opacity 0.15s var(--ease), color 0.15s var(--ease),
    border-color 0.15s var(--ease);
}

.code:hover .copy,
.copy:focus-visible {
  opacity: 1;
}

.copy:hover {
  border-color: var(--accent-line);
  color: var(--accent);
}

.copy.done {
  opacity: 1;
  border-color: var(--green);
  color: var(--green);
}

.tk-c {
  color: var(--tok-c);
  font-style: italic;
}

.tk-s {
  color: var(--tok-s);
}

.tk-k {
  color: var(--tok-k);
}
</style>
