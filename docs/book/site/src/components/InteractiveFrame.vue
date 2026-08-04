<script setup>
// The frame every interactive sits in.
//
// Interactives are wider than the prose measure on purpose: stepping outside
// the text column is the signal that you have stopped reading and started
// poking at the thing. The header says what the device is for, so a reader
// skimming can decide to skip it without losing the argument.
//
// `tag` is deliberately English — it labels the kind of block, which is chrome
// rather than prose. Keep the set small: TRY IT / MAP / PLAY.

defineProps({
  title: { type: String, required: true },
  hint: { type: String, default: '' },
  tag: { type: String, default: 'TRY IT' },
});
</script>

<template>
  <section class="frame">
    <header>
      <span class="tag">{{ tag }}</span>
      <div class="text">
        <h4>{{ title }}</h4>
        <p v-if="hint">{{ hint }}</p>
      </div>
    </header>
    <div class="body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.frame {
  margin: 2.6rem 0;
  /* Break out of the prose measure without breaking out of the page. */
  width: min(calc(100vw - 4rem), calc(var(--measure) + 7rem));
  border: 1px solid var(--edge-hi);
  border-radius: var(--radius);
  background:
    radial-gradient(120% 100% at 0% 0%, rgba(167, 139, 250, 0.07), transparent 55%),
    var(--bg-lift);
  overflow: hidden;
}

header {
  display: flex;
  gap: 0.85rem;
  padding: 0.95rem 1.15rem 0.85rem;
  border-bottom: 1px solid var(--edge);
}

.tag {
  flex: none;
  align-self: flex-start;
  margin-top: 0.15rem;
  padding: 0.14em 0.36em 0.14em 0.5em;
  border: 1px solid var(--accent-line);
  border-radius: 4px;
  font: 700 0.63rem/1.7 var(--mono);
  letter-spacing: 0.14em;
  color: var(--accent);
}

.text {
  min-width: 0;
}

h4 {
  font: 600 0.98rem/1.5 var(--sans);
  color: var(--fg);
}

.text p {
  margin-top: 0.15rem;
  font-size: 0.83rem;
  line-height: 1.6;
  color: var(--muted);
}

.body {
  padding: 1.15rem;
}

@media (max-width: 900px) {
  .frame {
    width: 100%;
  }

  .body {
    padding: 0.9rem;
  }
}
</style>
