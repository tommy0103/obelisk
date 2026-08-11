// Tests create throwaway directories with mkdtempSync but never deleted them,
// leaking hundreds of MB into $TMPDIR over repeated runs (this caused ENOSPC).
// makeTempDir records every directory it creates and removes them all when the
// test-file process exits (node --test spawns one process per file).
import { mkdtempSync, rmSync } from 'node:fs';
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
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.add(dir);
  return dir;
}
