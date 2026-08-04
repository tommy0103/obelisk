<script setup>
// End-of-chapter self-check. Two questions, drawn from the chapter's own recap.
//
// Answering is what marks a chapter read — scrolling to the bottom does not
// prove anything, and the questions are chosen so that a wrong answer is a real
// signal rather than a trick.

import { computed, ref } from 'vue';

import { answered, markRead, recordAnswer } from '@/book/progress.js';

const props = defineProps({
  slug: { type: String, required: true },
  quiz: { type: Array, required: true },
});

const picked = ref({});

const settled = (i) => picked.value[i] !== undefined;
const isRight = (i) => picked.value[i] === props.quiz[i].answer;

const done = computed(() => props.quiz.every((_, i) => settled(i)));
const rightCount = computed(() => props.quiz.filter((_, i) => settled(i) && isRight(i)).length);
const previously = computed(() => props.quiz.map((_, i) => answered(props.slug, i)));

function choose(qi, oi) {
  if (settled(qi)) return;
  picked.value = { ...picked.value, [qi]: oi };
  recordAnswer(props.slug, qi, oi === props.quiz[qi].answer);
  if (props.quiz.every((_, i) => picked.value[i] !== undefined)) markRead(props.slug);
}

function retry() {
  picked.value = {};
}
</script>

<template>
  <section class="check">
    <header>
      <span class="tag">CHECK</span>
      <h4>合上书，还答得上来吗</h4>
      <span v-if="previously.every(Boolean)" class="before">之前全答对过</span>
    </header>

    <ol>
      <li v-for="(q, qi) in quiz" :key="qi">
        <p class="q">{{ q.q }}</p>
        <div class="opts">
          <button
            v-for="(opt, oi) in q.options"
            :key="oi"
            type="button"
            :disabled="settled(qi)"
            :class="{
              right: settled(qi) && oi === q.answer,
              wrong: settled(qi) && picked[qi] === oi && oi !== q.answer,
              muted: settled(qi) && oi !== q.answer && picked[qi] !== oi,
            }"
            @click="choose(qi, oi)"
          >
            {{ opt }}
          </button>
        </div>
        <transition name="reveal">
          <p v-if="settled(qi)" class="why" :class="isRight(qi) ? 'ok' : 'no'">{{ q.why }}</p>
        </transition>
      </li>
    </ol>

    <footer v-if="done">
      <span class="tally" :class="{ perfect: rightCount === quiz.length }">
        {{ rightCount }} / {{ quiz.length }} —— {{ rightCount === quiz.length ? '这一章过了' : '有一条值得回去再看一眼' }}
      </span>
      <button class="btn quiet" type="button" @click="retry">再来一次</button>
    </footer>
  </section>
</template>

<style scoped>
.check {
  margin: 3rem 0 0;
  padding: 1.2rem 1.4rem 1.3rem;
  border: 1px solid var(--edge-hi);
  border-radius: var(--radius);
  background:
    radial-gradient(110% 100% at 100% 0%, rgba(110, 231, 183, 0.06), transparent 55%),
    var(--bg-lift);
}

header {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  margin-bottom: 1.1rem;
}

.tag {
  padding: 0.13em 0.36em 0.13em 0.5em;
  border: 1px solid rgba(110, 231, 183, 0.4);
  border-radius: 4px;
  font: 700 0.63rem/1.7 var(--mono);
  letter-spacing: 0.14em;
  color: var(--green);
}

h4 {
  font: 600 0.95rem/1.5 var(--sans);
  color: var(--fg);
}

.before {
  margin-left: auto;
  font: 0.68rem/1.6 var(--mono);
  color: var(--dim);
}

ol {
  margin: 0;
  padding: 0;
  list-style: none;
}

li + li {
  margin-top: 1.5rem;
  padding-top: 1.4rem;
  border-top: 1px solid var(--edge);
}

.q {
  font-size: 0.92rem;
  line-height: 1.7;
  color: var(--fg);
}

.opts {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  margin-top: 0.7rem;
}

.opts button {
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--edge);
  border-radius: var(--radius-sm);
  font-size: 0.85rem;
  line-height: 1.6;
  text-align: left;
  color: var(--fg-soft);
  transition: all 0.15s var(--ease);
}

.opts button:hover:not(:disabled) {
  border-color: var(--accent-line);
  background: var(--accent-soft);
}

.opts button:disabled {
  opacity: 1;
}

.opts button.right {
  border-color: var(--green);
  background: var(--green-soft);
  color: var(--fg);
}

.opts button.wrong {
  border-color: var(--red);
  background: var(--red-soft);
}

.opts button.muted {
  opacity: 0.38;
}

.why {
  margin-top: 0.7rem;
  padding-left: 0.85rem;
  border-left: 2px solid var(--edge-hi);
  font-size: 0.855rem;
  line-height: 1.8;
  color: var(--fg-soft);
}

.why.ok {
  border-left-color: var(--green);
}

.why.no {
  border-left-color: var(--red);
}

footer {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-top: 1.3rem;
  padding-top: 1rem;
  border-top: 1px solid var(--edge);
}

.tally {
  font: 0.8rem/1.6 var(--mono);
  color: var(--muted);
}

.tally.perfect {
  color: var(--green);
}

footer button {
  margin-left: auto;
}

.reveal-enter-active {
  transition: opacity 0.2s var(--ease), transform 0.2s var(--ease);
}

.reveal-enter-from {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
