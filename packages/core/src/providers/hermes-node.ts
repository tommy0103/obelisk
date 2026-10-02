// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { DatabaseSync } from 'node:sqlite';

import type { HermesStoreOpener } from './hermes.ts';

/** CLI-side read-only Hermes store opener; Electron injects better-sqlite3 instead. */
export const openHermesStoreWithNodeSqlite: HermesStoreOpener = path => new DatabaseSync(path, { readOnly: true });
