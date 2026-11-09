// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { DatabaseSync } from 'node:sqlite';

import type { CopilotChronicleOpener } from './copilot.ts';

/** CLI-side read-only Chronicle opener; Electron injects better-sqlite3 instead. */
export const openCopilotChronicleWithNodeSqlite: CopilotChronicleOpener = (path) => (
  new DatabaseSync(path, { readOnly: true })
);
