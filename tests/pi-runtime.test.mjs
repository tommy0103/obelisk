// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { piSessionId } from '../packages/core/src/providers/pi.ts';
import { runCli } from './cli-test-helpers.mjs';
import { makeTempDir } from './temp-dirs.mjs';

test('passive-pull runtime indexes Pi sessions from the default home', () => {
  const home = makeTempDir('obelisk-pi-runtime-');
  const sessionPath = join(
    home,
    '.pi',
    'agent',
    'sessions',
    '--tmp-pi-project--',
    'runtime.jsonl',
  );
  mkdirSync(dirname(sessionPath), { recursive: true });
  writeFileSync(
    sessionPath,
    readFileSync(new URL('./fixtures/pi/tool-session.jsonl', import.meta.url)),
  );

  const coreUrl = pathToFileURL(join(process.cwd(), 'packages/core/src/core.ts')).href;
  const script = `
    import { executeQuery } from ${JSON.stringify(coreUrl)};
    const result = await executeQuery("return sessions({ source: 'pi', limit: 5 });");
    process.stdout.write(JSON.stringify(result));
  `;
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.PI_CODING_AGENT_DIR;
  delete env.PI_CODING_AGENT_SESSION_DIR;
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });

  assert.equal(run.status, 0, run.stderr);
  const sessions = JSON.parse(run.stdout);
  assert.equal(sessions.length, 1);
  const fixtureHeader = JSON.parse(
    readFileSync(new URL('./fixtures/pi/tool-session.jsonl', import.meta.url), 'utf8').split('\n')[0],
  );
  assert.equal(sessions[0].id, piSessionId(fixtureHeader));
  assert.deepEqual(
    (({ title, source, message_count }) => ({ title, source, message_count }))(sessions[0]),
    { title: 'Tool probe', source: 'pi', message_count: 4 },
  );
});

test('passive-pull runtime honors the same persisted Pi root as the app', () => {
  const home = makeTempDir('obelisk-pi-custom-runtime-');
  const defaultRoot = join(home, '.pi', 'agent', 'sessions');
  const customRoot = join(home, 'custom-pi-sessions');
  const sessionPath = join(customRoot, '--tmp-pi-real-tool--', 'session.jsonl');
  mkdirSync(defaultRoot, { recursive: true });
  mkdirSync(dirname(sessionPath), { recursive: true });
  writeFileSync(
    sessionPath,
    readFileSync(new URL('./fixtures/pi/tool-session.jsonl', import.meta.url)),
  );
  const settingsPath = join(home, '.obelisk', 'settings.json');
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({
    providerRoots: { pi: customRoot },
  }));

  const coreUrl = pathToFileURL(join(process.cwd(), 'packages/core/src/core.ts')).href;
  const script = `
    import { executeQuery } from ${JSON.stringify(coreUrl)};
    const result = await executeQuery("return sessions({ source: 'pi', limit: 5 });");
    process.stdout.write(JSON.stringify(result));
  `;
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.PI_CODING_AGENT_DIR;
  delete env.PI_CODING_AGENT_SESSION_DIR;
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });

  assert.equal(run.status, 0, run.stderr);
  const sessions = JSON.parse(run.stdout);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].source, 'pi');
  assert.equal(sessions[0].title, 'Tool probe');
});

test('passive CLI operations report an incomplete Pi inventory without hiding partial results', () => {
  // --attune is deliberately absent: memory writes no longer run an index
  // build, so there is no inventory to report on that path.
  for (const command of ['search', 'query']) {
    const home = makeTempDir(`obelisk-pi-partial-${command}-`);
    const piRoot = join(home, '.pi', 'agent', 'sessions');
    mkdirSync(dirname(piRoot), { recursive: true });
    writeFileSync(piRoot, 'not a directory');
    const queryPath = join(home, 'query.mjs');
    writeFileSync(queryPath, "return sessions({ source: 'pi', limit: 5 });");
    const args = command === 'search'
      ? ['--search', 'partial-probe']
      : [`--${command}`, queryPath];

    const result = runCli(args, {
      home,
      env: { PI_CODING_AGENT_DIR: '', PI_CODING_AGENT_SESSION_DIR: '' },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), []);
    assert.match(result.stderr, /Warning: incomplete pi source inventory/);
    assert.match(
      result.stderr,
      new RegExp(piRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
    assert.match(result.stderr, /ENOTDIR|not a directory/i);
  }
});

test('CLI force rebuild rejects a structurally invalid Pi snapshot and preserves the last good index', () => {
  const home = makeTempDir('obelisk-pi-cli-force-');
  const sessionPath = join(home, '.pi', 'agent', 'sessions', 'project', 'session.jsonl');
  mkdirSync(dirname(sessionPath), { recursive: true });
  const fixture = readFileSync(new URL('./fixtures/pi/tool-session.jsonl', import.meta.url), 'utf8');
  writeFileSync(sessionPath, fixture);
  const env = { PI_CODING_AGENT_DIR: '', PI_CODING_AGENT_SESSION_DIR: '' };

  const first = runCli(['--build'], { home, env });
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
  let db = new DatabaseSync(dbPath, { readOnly: true });
  const before = {
    sessions: db.prepare("SELECT id,title,message_count,jsonl_path FROM sessions WHERE source='pi'").all()
      .map(row => ({ ...row })),
    messages: db.prepare("SELECT uuid,text FROM messages WHERE source='pi' ORDER BY uuid").all()
      .map(row => ({ ...row })),
  };
  db.close();

  writeFileSync(sessionPath, [
    fixture.split('\n')[0],
    JSON.stringify({
      type: 'message',
      id: 'invalid-message',
      parentId: null,
      timestamp: '2026-08-02T10:00:01.000Z',
      message: null,
    }),
    '',
  ].join('\n'));
  const failed = runCli(['--build'], { home, env });
  assert.equal(failed.status, 1, failed.stderr || failed.stdout);
  assert.match(JSON.parse(failed.stdout).error, /provider_failure/);

  db = new DatabaseSync(dbPath, { readOnly: true });
  const after = {
    sessions: db.prepare("SELECT id,title,message_count,jsonl_path FROM sessions WHERE source='pi'").all()
      .map(row => ({ ...row })),
    messages: db.prepare("SELECT uuid,text FROM messages WHERE source='pi' ORDER BY uuid").all()
      .map(row => ({ ...row })),
  };
  db.close();
  assert.deepEqual(after, before);
});

test('CLI force rebuild rejects an incomplete provider inventory and preserves the last good index', () => {
  const home = makeTempDir('obelisk-pi-cli-incomplete-force-');
  const piRoot = join(home, '.pi', 'agent', 'sessions');
  const sessionPath = join(piRoot, 'project', 'session.jsonl');
  mkdirSync(dirname(sessionPath), { recursive: true });
  writeFileSync(
    sessionPath,
    readFileSync(new URL('./fixtures/pi/tool-session.jsonl', import.meta.url)),
  );
  const env = { PI_CODING_AGENT_DIR: '', PI_CODING_AGENT_SESSION_DIR: '' };
  const first = runCli(['--build'], { home, env });
  assert.equal(first.status, 0, first.stderr || first.stdout);

  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
  let db = new DatabaseSync(dbPath, { readOnly: true });
  const before = {
    sessions: db.prepare("SELECT id,title,message_count,jsonl_path FROM sessions WHERE source='pi'").all()
      .map(row => ({ ...row })),
    messages: db.prepare("SELECT uuid,text FROM messages WHERE source='pi' ORDER BY uuid").all()
      .map(row => ({ ...row })),
  };
  db.close();

  rmSync(piRoot, { recursive: true, force: true });
  writeFileSync(piRoot, 'not a directory');
  const failed = runCli(['--build'], { home, env });
  assert.equal(failed.status, 1, failed.stderr || failed.stdout);
  assert.match(JSON.parse(failed.stdout).error, /incomplete_snapshot/);

  db = new DatabaseSync(dbPath, { readOnly: true });
  const after = {
    sessions: db.prepare("SELECT id,title,message_count,jsonl_path FROM sessions WHERE source='pi'").all()
      .map(row => ({ ...row })),
    messages: db.prepare("SELECT uuid,text FROM messages WHERE source='pi' ORDER BY uuid").all()
      .map(row => ({ ...row })),
  };
  db.close();
  assert.deepEqual(after, before);
});

test('malformed official Pi settings use Pi 0.83 default-root fallback', () => {
  const home = makeTempDir('obelisk-pi-cli-settings-');
  const agentDir = join(home, '.pi', 'agent');
  const customRoot = join(home, 'custom-pi-sessions');
  const customPath = join(customRoot, 'project', 'custom.jsonl');
  const defaultPath = join(agentDir, 'sessions', 'project', 'default.jsonl');
  const settingsPath = join(agentDir, 'settings.json');
  const fixture = readFileSync(new URL('./fixtures/pi/tool-session.jsonl', import.meta.url), 'utf8');
  mkdirSync(dirname(customPath), { recursive: true });
  mkdirSync(dirname(defaultPath), { recursive: true });
  writeFileSync(customPath, fixture);
  writeFileSync(settingsPath, JSON.stringify({ sessionDir: customRoot }));
  const env = { PI_CODING_AGENT_DIR: '', PI_CODING_AGENT_SESSION_DIR: '' };
  assert.equal(runCli(['--build'], { home, env }).status, 0);

  const lure = fixture.trim().split('\n').map(line => JSON.parse(line));
  lure[0] = { ...lure[0], id: 'default-lure', cwd: '/tmp/default-lure' };
  writeFileSync(defaultPath, `${lure.map(record => JSON.stringify(record)).join('\n')}\n`);
  writeFileSync(settingsPath, '{broken');
  const rebuilt = runCli(['--build'], { home, env });
  assert.equal(rebuilt.status, 0, rebuilt.stderr || rebuilt.stdout);

  const db = new DatabaseSync(join(home, '.obelisk', 'obelisk.sqlite'), { readOnly: true });
  assert.deepEqual(
    db.prepare("SELECT jsonl_path FROM sessions WHERE source='pi'").all().map(row => row.jsonl_path),
    [defaultPath],
  );
  db.close();
});
