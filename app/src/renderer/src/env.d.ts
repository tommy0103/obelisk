// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ObeliskApi } from '../../preload/obelisk-api.ts';

declare global {
  interface Window {
    obelisk: ObeliskApi;
    // RecapExport sets this once a card has painted, for the capture window.
    __OBELISK_RECAP_EXPORT_READY__?: boolean;
  }
}
