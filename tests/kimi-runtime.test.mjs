import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { makeTempDir } from './temp-dirs.mjs';

test('passive-pull runtime indexes Kimi sessions from the default home', () => {
  const home = makeTempDir('obelisk-kimi-runtime-');
  const sessionDir = join(home, '.kimi-code', 'sessions', 'workspace-1', 'session-runtime-1');
  const mainDir = join(sessionDir, 'agents', 'main');
  mkdirSync(mainDir, { recursive: true });
  writeFileSync(join(sessionDir, 'state.json'), JSON.stringify({
    title: 'Runtime Kimi session',
    workDir: '/tmp/runtime-kimi',
    createdAt: '2026-07-20T10:00:00.000Z',
    updatedAt: '2026-07-20T10:01:00.000Z',
    agents: { main: { type: 'main' } },
  }));
  writeFileSync(join(mainDir, 'wire.jsonl'), [
    JSON.stringify({ type: 'metadata', protocol_version: '1.5', created_at: 1753005600000 }),
    JSON.stringify({ type: 'context.append_message', time: 1753005601000, message: { role: 'user', content: [{ type: 'text', text: 'runtime kimi needle' }], toolCalls: [], origin: { kind: 'user' } } }),
    '',
  ].join('\n'));

  const coreUrl = pathToFileURL(join(process.cwd(), 'packages/core/src/core.ts')).href;
  const script = `
    import { executeQuery } from ${JSON.stringify(coreUrl)};
    const result = await executeQuery("return sessions({ source: 'kimi', limit: 5 });");
    process.stdout.write(JSON.stringify(result));
  `;
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
  });

  assert.equal(run.status, 0, run.stderr);
  const sessions = JSON.parse(run.stdout);
  assert.deepEqual(sessions.map(({ id, title, source }) => ({ id, title, source })), [{
    id: 'kimi:session-runtime-1',
    title: 'Runtime Kimi session',
    source: 'kimi',
  }]);
});
