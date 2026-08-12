// Lock-contention test for the attune memory carve-out, exercising the real
// openAttuneDb + executeAttune combination: the connection busy_timeout is
// deliberately short (250 ms), so a contended BEGIN IMMEDIATE fails fast and
// the retry layer (budgetMs: 5000, retryOnBeginBusy) owns the waiting. Without
// that layering the first BEGIN would fail at ~250 ms and the mutation would
// error out while the lock is still held.
//
// HOME must point at the fixture root BEFORE any core module is imported: the
// core db path is derived from homedir() at module load time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from './temp-dirs.mjs';

const home = makeTempDir('obelisk-attune-contention-');
process.env.HOME = home;
process.env.USERPROFILE = home;

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const { executeAttune } = await import('../packages/core/src/core.ts');

test('attune mutation succeeds through real lock contention via the retry budget', async () => {
  const obeliskDir = join(home, '.obelisk');
  mkdirSync(obeliskDir, { recursive: true });
  const dbPath = join(obeliskDir, 'obelisk.sqlite');
  const schema = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');

  const setup = new DatabaseSync(dbPath);
  setup.exec(schema);
  setup.close();

  const memoryPath = join(home, 'memory.md');
  writeFileSync(memoryPath, '# Contended memory\n');

  // A child process holds the write lock well past the 250 ms connection
  // busy_timeout. It must be a separate process: the retry layer's backoff
  // sleep blocks this thread's event loop, so an in-process timer could not
  // fire between attempts.
  const holder = spawn(process.execPath, ['-e', `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
    setTimeout(() => { db.exec('ROLLBACK'); db.close(); }, 800);
  `, dbPath]);
  const holderExit = new Promise(resolve => holder.on('exit', resolve));
  // Give the child a moment to acquire the lock before contending.
  await new Promise(resolve => setTimeout(resolve, 150));

  try {
    const result = await executeAttune(`
      return remember({
        path: ${JSON.stringify(memoryPath)},
        project: 'contention-test',
        summary: 'Decision: attune waits out a bounded lock hold and still writes.'
      });
    `);
    assert.ok(result.id);
    assert.equal(result.project, 'contention-test');
  } finally {
    holder.kill();
    await holderExit;
  }

  const check = new DatabaseSync(dbPath, { readOnly: true });
  const row = check.prepare("SELECT summary FROM memories WHERE project='contention-test'").get();
  assert.match(row.summary, /waits out a bounded lock hold/);
  check.close();
});
