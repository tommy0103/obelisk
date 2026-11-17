// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import sample from './recap-2026-W24.json';

// JSON imports widen string literals and tuples, so the compiler cannot match
// the sample against Recap by itself.
export const sampleRecap = /** @type {import('../recap').Recap} */ (/** @type {unknown} */ (sample));
