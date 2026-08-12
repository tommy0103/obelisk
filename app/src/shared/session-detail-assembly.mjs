// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { assembleSessionDetail } from '../../../packages/core/src/session-detail.ts';

export { assembleSessionDetail };

// Compatibility for local/generated app tooling; production callers use the
// single Core assembleSessionDetail seam.
export function assembleSessionMessages(input) {
  return assembleSessionDetail(input).messages;
}
