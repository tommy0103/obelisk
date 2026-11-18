// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Tests create throwaway directories with mkdtempSync but never deleted them,
// leaking hundreds of MB into $TMPDIR over repeated runs (this caused ENOSPC).
// makeTempDir records every directory it creates and removes them all when the
// test-file process exits (node --test spawns one process per file).
// It returns the realpath: on macOS $TMPDIR sits under /var, a symlink to
// /private/var, and code under test that resolves paths would otherwise not
// match the path the test built. ESLint keeps other tests off tmpdir().
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const created = new Set();

process.on('exit', () => {
  for (const dir of created) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup: keep going so one bad dir does not skip the rest.
    }
  }
});

export function makeTempDir(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  created.add(dir);
  return dir;
}
