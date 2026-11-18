// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Files behind a manual rebuild: the temp index it builds into, and the swap
// that replaces the live index with it.

import fs from 'node:fs';
import path from 'node:path';

// Unique per call, so a rebuild never starts on another rebuild's leftovers.
export function rebuildTempDbPath(dbPath: string) {
  return path.join(
    path.dirname(dbPath),
    `${path.basename(dbPath)}.rebuild-${process.pid}-${Date.now()}.tmp`,
  );
}

export function cleanupDbFiles(dbPath: string) {
  for (const filePath of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // Rebuild temp names are unique, so a leftover only wastes disk.
    }
  }
}

export function replaceDbWithTemp(tempDbPath: string, dbPath: string) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
    fs.rmSync(sidecar, { force: true });
  }
  fs.renameSync(tempDbPath, dbPath);
  for (const suffix of ['-wal', '-shm']) {
    const tempSidecar = `${tempDbPath}${suffix}`;
    if (!fs.existsSync(tempSidecar)) continue;
    fs.renameSync(tempSidecar, `${dbPath}${suffix}`);
  }
}
