<!-- Copyright (C) 2026 tommy0103 and contributors. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

<script setup>
import { computed, onUnmounted, ref, watch } from 'vue';
import {
  createFlapState,
  finishFlap,
  flapSlots,
  requestFlap,
} from '../flap-number.mjs';

const props = defineProps({
  value: { type: [Number, String], required: true },
});

const state = ref(createFlapState(props.value));
const motionQuery = typeof window !== 'undefined'
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : null;
let reducedMotion = Boolean(motionQuery?.matches);
let completionVersion = state.value.version;
const completedSlots = new Set();

const slots = computed(() => state.value.animating
  ? flapSlots(state.value.from, state.value.to)
  : flapSlots(state.value.settled, state.value.settled));

function resetCompletionTracking() {
  completionVersion = state.value.version;
  completedSlots.clear();
}

function applyValue(value) {
  const previousVersion = state.value.version;
  state.value = requestFlap(state.value, value, { reducedMotion });
  if (state.value.version !== previousVersion || !state.value.animating) resetCompletionTracking();
}

function handleFlapEnd(index) {
  if (!state.value.animating) return;
  if (completionVersion !== state.value.version) resetCompletionTracking();
  completedSlots.add(index);
  const changedSlots = slots.value.filter(slot => slot.changed).length;
  if (completedSlots.size < changedSlots) return;
  state.value = finishFlap(state.value);
  resetCompletionTracking();
}

function handleMotionPreference(event) {
  reducedMotion = event.matches;
  applyValue(props.value);
}

watch(() => props.value, applyValue);
motionQuery?.addEventListener?.('change', handleMotionPreference);

onUnmounted(() => {
  motionQuery?.removeEventListener?.('change', handleMotionPreference);
});
</script>

<template>
  <span class="flap-number" :aria-label="String(value)">
    <span
      v-for="(slot, index) in slots"
      :key="`${state.version}:${index}`"
      class="flap-slot"
      :class="{ flipping: state.animating && slot.changed }"
      aria-hidden="true"
    >
      <span v-if="!state.animating || !slot.changed" class="flap-digit stable">{{ slot.to }}</span>
      <template v-else>
        <span class="flap-digit flap-new-top">{{ slot.to }}</span>
        <span class="flap-digit flap-old-bottom">{{ slot.from }}</span>
        <span class="flap-digit flap-old-top">{{ slot.from }}</span>
        <span class="flap-digit flap-new-bottom" @animationend.stop="handleFlapEnd(index)">{{ slot.to }}</span>
      </template>
    </span>
  </span>
</template>

<style scoped>
.flap-number {
  display: inline-flex;
  align-items: center;
  height: 1lh;
  line-height: inherit;
  vertical-align: middle;
  white-space: nowrap;
}

.flap-slot {
  position: relative;
  width: 1ch;
  height: 1lh;
  overflow: hidden;
  contain: paint;
}

.flap-digit {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  backface-visibility: hidden;
}

.flap-slot.flipping {
  perspective: 90px;
  transform-style: preserve-3d;
}

.flap-slot.flipping::after {
  content: '';
  position: absolute;
  z-index: 6;
  top: 50%;
  left: 12%;
  right: 12%;
  height: 1px;
  background: rgba(255, 255, 255, .09);
  pointer-events: none;
}

.flap-new-top { z-index: 1; clip-path: inset(0 0 50% 0); }
.flap-old-bottom { z-index: 1; clip-path: inset(50% 0 0 0); }
.flap-old-top {
  z-index: 4;
  clip-path: inset(0 0 50% 0);
  transform-origin: center 50%;
  animation: flap-top-out 110ms cubic-bezier(.55, 0, 1, .45) both;
}
.flap-new-bottom {
  z-index: 5;
  clip-path: inset(50% 0 0 0);
  transform-origin: center 50%;
  animation: flap-bottom-in 120ms cubic-bezier(.22, 1, .36, 1) 100ms both;
}

@keyframes flap-top-out {
  from { transform: rotateX(0); }
  to { transform: rotateX(-90deg); }
}

@keyframes flap-bottom-in {
  from { transform: rotateX(90deg); }
  to { transform: rotateX(0); }
}

@media (prefers-reduced-motion: reduce) {
  .flap-digit { animation: none !important; }
}
</style>
