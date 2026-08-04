<script setup>
// Type a global name; find out whether the sandbox has it.
//
// Eight lines of `runInNewContext` decide the entire capability boundary of a
// query script. Reading that list is one thing; failing to find `fs` in it is
// another.

import { computed, ref } from 'vue';

const HELPERS = [
  'sql', 'search', 'context', 'trace', 'thread', 'subagents', 'workflows', 'workflowTree',
  'fileHistory', 'failures', 'sessions', 'recent', 'summaries', 'raw', 'memories', 'overview',
];

const BUILTINS = [
  'JSON', 'Math', 'Array', 'Object', 'Set', 'Map', 'Date', 'RegExp',
  'parseInt', 'parseFloat', 'String', 'Number', 'Boolean', 'Error', 'Promise', 'console', 'setTimeout',
];

const ABSENT = {
  require: '加载不了任何模块。',
  import: '同上——而且 vm 上下文里本来就没有模块系统。',
  fs: '读不了文件、写不了文件。这也是 remember() 必须要求 markdown 文件「已经存在」的原因。',
  fetch: '发不出网络请求。',
  http: '发不出网络请求。',
  https: '发不出网络请求。',
  process: '拿不到环境变量、命令行，也退不出进程。',
  Buffer: '摸不到原始内存。',
  globalThis: '不在白名单里——上下文就是那个对象字面量本身。',
  eval: '不在白名单里。',
  remember: '这是 attune 沙箱的 API。两套 API 没有交集：--query 的脚本调不到它。',
  forget: '这是 attune 沙箱的 API。两套 API 没有交集。',
};

const probe = ref('fs');

const verdict = computed(() => {
  const name = probe.value.trim();
  if (!name) return null;
  if (HELPERS.includes(name)) {
    return { state: 'helper', text: '在白名单里 —— 这是 16 个 helper 之一。', extra: '它只存在于沙箱内部，从不被提升为对外的工具。' };
  }
  if (BUILTINS.includes(name)) {
    return { state: 'builtin', text: '在白名单里 —— 内置对象。', extra: '能算，但不带任何 I/O。' };
  }
  if (name in ABSENT) {
    return { state: 'absent', text: '不在白名单里。', extra: ABSENT[name] };
  }
  return {
    state: 'absent',
    text: '不在白名单里。',
    extra: '沙箱里能访问的全局，就是那个对象字面量的键——没列进去的一律没有，会抛 ReferenceError。',
  };
});

const SOURCE = `const sandbox = {
  ...api, JSON, Math, Array, Object, Set, Map, Date, RegExp,
  parseInt, parseFloat, String, Number, Boolean, Error, Promise, console, setTimeout,
};
const ctx = createContext(sandbox);
return runInNewContext(\`(async()=>{\${scriptContent}})()\`, ctx, { timeout: 30000 });`;

const TRY = ['fs', 'require', 'process', 'fetch', 'JSON', 'search', 'remember', 'globalThis'];
</script>

<template>
  <div class="wl">
    <pre class="code-face src"><code>{{ SOURCE }}</code></pre>

    <div class="probe">
      <label>
        <span>沙箱里有</span>
        <input v-model="probe" spellcheck="false" placeholder="fs" aria-label="要查的全局名" />
        <span>吗？</span>
      </label>
      <div class="quick">
        <button v-for="t in TRY" :key="t" type="button" @click="probe = t">{{ t }}</button>
      </div>
    </div>

    <div v-if="verdict" class="verdict" :class="verdict.state">
      <p class="line"><code>{{ probe }}</code> — {{ verdict.text }}</p>
      <p class="extra">{{ verdict.extra }}</p>
    </div>

    <p class="closing">
      净效果：<b>脚本能读数据库、能算，但带不走任何东西。</b>
      它唯一的输出通道是返回值。这不是防恶意——脚本是 agent 自己写的，而且 agent 本来就有 shell 权限——
      它的作用是把「查询」这个动作的能力边界钉死成一个纯函数。
    </p>
  </div>
</template>

<style scoped>
.src {
  margin: 0 0 1rem;
  padding: 0.8rem 0.95rem;
  border: 1px solid var(--edge);
  border-radius: var(--radius-sm);
  background: var(--bg-sunk);
  overflow-x: auto;
}

.src code {
  font: inherit;
  color: var(--fg-soft);
  white-space: pre;
}

.probe label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font: 0.86rem/1.6 var(--sans);
  color: var(--fg-soft);
}

.probe input {
  width: 9rem;
  padding: 0.24rem 0.6rem;
  border: 1px solid var(--edge-hi);
  border-radius: var(--radius-sm);
  background: var(--bg-sunk);
  font: 0.82rem/1.6 var(--mono);
  color: var(--accent);
  outline: none;
}

.probe input:focus {
  border-color: var(--accent);
}

.quick {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin-top: 0.6rem;
}

.quick button {
  padding: 0.14rem 0.5rem;
  border: 1px solid var(--edge);
  border-radius: 4px;
  font: 0.69rem/1.6 var(--mono);
  color: var(--faint);
  transition: all 0.15s var(--ease);
}

.quick button:hover {
  border-color: var(--accent-line);
  color: var(--accent);
}

.verdict {
  margin-top: 0.9rem;
  padding: 0.75rem 0.95rem;
  border-left: 2px solid var(--edge-hi);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  background: rgba(255, 255, 255, 0.02);
}

.verdict.helper,
.verdict.builtin {
  border-left-color: var(--green);
  background: var(--green-soft);
}

.verdict.absent {
  border-left-color: var(--red);
  background: var(--red-soft);
}

.line {
  font: 0.86rem/1.6 var(--sans);
  color: var(--fg);
}

.line code {
  padding: 0.08em 0.4em;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.07);
  font-family: var(--mono);
  font-size: 0.88em;
}

.extra {
  margin-top: 0.3rem;
  font-size: 0.83rem;
  line-height: 1.7;
  color: var(--fg-soft);
}

.closing {
  margin-top: 1rem;
  font-size: 0.86rem;
  line-height: 1.8;
  color: var(--fg-soft);
}

.closing b {
  color: var(--fg);
}
</style>
