import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCli } from './cli-test-helpers.mjs';

test('passive-pull runtime indexes Pi sessions from the default home', () => {
  const home = mkdtempSync(join(tmpdir(), 'obelisk-pi-runtime-'));
  const sessionDir = join(home, '.pi', 'agent', 'sessions', '--tmp-runtime-pi--');
  const sessionPath = join(sessionDir, '2026-07-20T10-00-00_runtime-pi.jsonl');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(sessionPath, [
    { type: 'session', version: 3, id: 'runtime-pi', timestamp: '2026-07-20T10:00:00.000Z', cwd: '/tmp/runtime-pi' },
    { type: 'message', id: 'runtime-user', parentId: null, timestamp: '2026-07-20T10:00:01.000Z', message: { role: 'user', content: 'runtime pi needle' } },
    { type: 'session_info', id: 'runtime-info', parentId: 'runtime-user', timestamp: '2026-07-20T10:00:02.000Z', name: 'Runtime Pi session' },
    '',
  ].map((entry) => typeof entry === 'string' ? entry : JSON.stringify(entry)).join('\n'));

  const queryPath = join(home, 'query.mjs');
  writeFileSync(queryPath, "return sessions({ source: 'pi', limit: 5 });");
  const run = runCli(['--query', queryPath], {
    home,
    env: {
      PI_CODING_AGENT_DIR: '',
      PI_CODING_AGENT_SESSION_DIR: '',
    },
  });

  assert.equal(run.status, 0, run.stderr);
  const sessions = JSON.parse(run.stdout);
  assert.deepEqual(sessions.map(({ id, title, source }) => ({ id, title, source })), [{
    id: 'pi:runtime-pi',
    title: 'Runtime Pi session',
    source: 'pi',
  }]);
});
