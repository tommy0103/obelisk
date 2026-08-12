// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

function normalizeFlapValue(value) {
  return String(value ?? '');
}

const MAX_QUEUED_FLAPS = 4;
const MAX_CONSECUTIVE_STEPS = 4;

function normalizeQueue(queued) {
  if (Array.isArray(queued)) return queued;
  return queued === null || queued === undefined ? [] : [normalizeFlapValue(queued)];
}

function numericDirection(from, to) {
  if (!/^(0|[1-9]\d*)$/.test(from) || !/^(0|[1-9]\d*)$/.test(to)) return null;
  const fromNumber = Number(from);
  const toNumber = Number(to);
  if (!Number.isSafeInteger(fromNumber) || !Number.isSafeInteger(toNumber)) return null;
  return Math.sign(toNumber - fromNumber);
}

function targetsBetween(from, to) {
  const direction = numericDirection(from, to);
  if (direction === null) return [to];
  if (direction === 0) return [];
  const distance = Math.abs(Number(to) - Number(from));
  if (distance > MAX_CONSECUTIVE_STEPS) return [to];
  return Array.from(
    { length: distance },
    (_, index) => String(Number(from) + direction * (index + 1)),
  );
}

function boundedQueue(targets) {
  if (targets.length <= MAX_QUEUED_FLAPS) return targets;
  return [...targets.slice(0, MAX_QUEUED_FLAPS - 1), targets.at(-1)];
}

function startFlap(state, targets) {
  const [to, ...queued] = targets;
  if (to === undefined) return state;
  return {
    ...state,
    from: state.settled,
    to,
    animating: true,
    queued: boundedQueue(queued),
    version: state.version + 1,
  };
}

export function createFlapState(value) {
  const settled = normalizeFlapValue(value);
  return {
    settled,
    from: settled,
    to: settled,
    animating: false,
    queued: [],
    version: 0,
  };
}

export function requestFlap(state, value, { reducedMotion = false } = {}) {
  const next = normalizeFlapValue(value);
  if (reducedMotion) return createFlapState(next);
  if (state.animating) {
    const queued = normalizeQueue(state.queued);
    if (next === state.to) return { ...state, queued: [] };
    const queuedIndex = queued.indexOf(next);
    if (queuedIndex >= 0) return { ...state, queued: queued.slice(0, queuedIndex + 1) };

    const tail = queued.at(-1) ?? state.to;
    const activeDirection = numericDirection(state.from, tail);
    const incomingDirection = numericDirection(tail, next);
    const additions = targetsBetween(tail, next);
    if (activeDirection !== null && incomingDirection !== null
      && (activeDirection === 0 || incomingDirection === activeDirection)) {
      return { ...state, queued: boundedQueue([...queued, ...additions]) };
    }
    return { ...state, queued: boundedQueue(targetsBetween(state.to, next)) };
  }
  if (next === state.settled) return state;
  return startFlap(state, targetsBetween(state.settled, next));
}

export function finishFlap(state) {
  if (!state.animating) return state;
  const settled = state.to;
  const queued = normalizeQueue(state.queued);
  const stable = {
    ...state,
    settled,
    from: settled,
    to: settled,
    animating: false,
    queued: [],
  };
  return queued.length ? startFlap(stable, queued) : stable;
}

export function flapSlots(fromValue, toValue) {
  const from = normalizeFlapValue(fromValue);
  const to = normalizeFlapValue(toValue);
  const width = Math.max(from.length, to.length);
  const oldText = from.padStart(width, ' ');
  const newText = to.padStart(width, ' ');
  return Array.from({ length: width }, (_, index) => ({
    from: oldText[index],
    to: newText[index],
    changed: oldText[index] !== newText[index],
  }));
}
