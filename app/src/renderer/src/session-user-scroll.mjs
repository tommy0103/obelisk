// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

export function createSessionUserScroll({
  quietMs = 450,
  scrollEndGraceMs = 100,
  setTimeout: schedule = globalThis.setTimeout.bind(globalThis),
  clearTimeout: cancel = globalThis.clearTimeout.bind(globalThis),
  onEnd = () => {},
} = {}) {
  let element = null;
  let active = false;
  let upwardIntent = false;
  let quietTimer = null;

  function clearQuietTimer() {
    if (quietTimer === null) return;
    cancel(quietTimer);
    quietTimer = null;
  }

  function finish({ notify = true } = {}) {
    clearQuietTimer();
    if (!active) return;
    active = false;
    if (notify) onEnd();
  }

  function scheduleFallback(delay = quietMs) {
    clearQuietTimer();
    quietTimer = schedule(() => {
      quietTimer = null;
      finish();
    }, delay);
  }

  function begin() {
    active = true;
    scheduleFallback();
  }

  function recordDirection(delta) {
    if (delta < 0) upwardIntent = true;
    else if (delta > 0) upwardIntent = false;
  }

  function handleWheel(event) {
    recordDirection(Number(event.deltaY) || 0);
    begin();
  }

  function handleScroll() {
    if (!active) return;
    scheduleFallback();
  }

  function handleScrollEnd() {
    // Chromium can emit scrollend between wheel packets even though the user
    // is still in one physical trackpad gesture. A short grace period lets the
    // next packet keep ownership without waiting for the full watchdog.
    scheduleFallback(scrollEndGraceMs);
  }

  function detach() {
    if (element) {
      element.removeEventListener('wheel', handleWheel);
      element.removeEventListener('scroll', handleScroll);
      element.removeEventListener('scrollend', handleScrollEnd);
    }
    finish({ notify: false });
    element = null;
  }

  return {
    attach(nextElement) {
      if (nextElement === element) return;
      detach();
      element = nextElement;
      if (!element) return;
      element.addEventListener('wheel', handleWheel, { passive: true });
      element.addEventListener('scroll', handleScroll, { passive: true });
      element.addEventListener('scrollend', handleScrollEnd, { passive: true });
    },
    detach,
    isActive() {
      return active;
    },
    hasUpwardIntent() {
      return upwardIntent;
    },
    clearUpwardIntent() {
      upwardIntent = false;
    },
  };
}
