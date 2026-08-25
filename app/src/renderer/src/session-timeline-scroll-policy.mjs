// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

export function createSessionTimelineScrollPolicy({
  isUserScrolling,
  writeScroll,
  onSuppressedAdjustment = () => {},
}) {
  let explicitDepth = 0;

  function scrollToFn(offset, options = {}, instance) {
    if (explicitDepth === 0 && isUserScrolling()) {
      if (Number.isFinite(options.adjustments) && options.adjustments !== 0) {
        onSuppressedAdjustment(offset, options, instance);
      }
      return;
    }
    writeScroll(offset, options, instance);
  }

  function runExplicit(action) {
    explicitDepth++;
    try {
      return action();
    } finally {
      explicitDepth--;
    }
  }

  return {
    scrollToFn,
    runExplicit,
  };
}
