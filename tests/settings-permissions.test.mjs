// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { cliEntry, repoRoot, runCli } from './cli-test-helpers.mjs';
import { makeTempDir } from './temp-dirs.mjs';

function fixture() {
  const home = makeTempDir('obelisk-settings-access-');
  const project = join(home, '.claude', 'projects', '-tmp-settings-access');
  mkdirSync(project, { recursive: true });
  const captured = new URL('./fixtures/claude/custom-title-session.jsonl', import.meta.url);
  copyFileSync(captured, join(project, 'cached.jsonl'));
  const warm = runCli(['--build'], { home });
  assert.equal(warm.status, 0, warm.stderr || warm.stdout);
  const configuredRoot = join(home, 'configured-claude');
  mkdirSync(join(configuredRoot, 'projects'), { recursive: true });
  const settingsPath = join(home, '.obelisk', 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({ providerRoots: { claude: configuredRoot } }));
  copyFileSync(captured, join(project, 'not-configured.jsonl'));
  const query = join(home, 'settings-access-query.mjs');
  writeFileSync(query, "return sql('SELECT COUNT(*) AS count FROM messages');\n");
  return { home, settingsPath, configuredRoot, query, dbPath: join(home, '.obelisk', 'obelisk.sqlite') };
}

function snapshot(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      state: db.prepare('SELECT * FROM index_state ORDER BY jsonl_path').all(),
      sessions: db.prepare('SELECT * FROM sessions ORDER BY id').all(),
      messages: db.prepare('SELECT * FROM messages ORDER BY uuid').all(),
    };
  } finally { db.close(); }
}

// Reproduce existsSync's false-for-denial ambiguity without modifying real ACLs.
// Only the disposable settings path is hidden/denied; actual CLI/provider data
// and the SQLite index remain readable and writable.
function invoke(f, fault, { reader = false, args = [] } = {}) {
  const preload = join(f.home, 'settings-access-preload.mjs');
  writeFileSync(preload, `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const settingsPath = ${JSON.stringify(f.settingsPath)};
    const fault = ${JSON.stringify(fault)};
    const exists = fs.existsSync;
    const read = fs.readFileSync;
    fs.existsSync = (path) => String(path) === settingsPath ? false : exists(path);
    fs.readFileSync = (path, ...options) => {
      if (String(path) === settingsPath && fault !== 'readable') {
        throw Object.assign(new Error(fault + ': settings access denied, ' + settingsPath),
          { code: fault, path: settingsPath });
      }
      return read(path, ...options);
    };
    syncBuiltinESMExports();
  `);
  const readerUrl = pathToFileURL(join(repoRoot, 'packages/core/src/provider-settings.ts')).href;
  const command = reader
    ? ['--input-type=module', '--eval', `const { readPersistedProviderSettings } = await import(${JSON.stringify(readerUrl)});
      console.log(JSON.stringify(readPersistedProviderSettings(${JSON.stringify(f.settingsPath)})));`]
    : [cliEntry, ...args];
  const env = { ...process.env, HOME: f.home, USERPROFILE: f.home,
    APPDATA: join(f.home, 'AppData/Roaming'), XDG_CONFIG_HOME: join(f.home, '.config') };
  delete env.DSH_HOME;
  delete env.HERMES_HOME;
  return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning',
    '--experimental-strip-types', '--import', pathToFileURL(preload).href, ...command],
  { cwd: repoRoot, env, encoding: 'utf8', timeout: 30000 });
}

test('a readable settings file is loaded even when its preliminary existence check would say false', () => {
  const f = fixture();
  const result = invoke(f, 'readable', { reader: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true, settings: { providerRoots: { claude: f.configuredRoot } },
  });
});

test('only an ENOENT settings read selects the ordinary no-settings defaults', () => {
  const f = fixture();
  const result = invoke(f, 'ENOENT', { reader: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, settings: {} });
});

for (const code of ['EACCES', 'EPERM', 'EIO', 'EISDIR', 'ENOTDIR']) {
  test(`${code} while reading settings is reported as unavailable, not silently replaced by default roots`, () => {
    const f = fixture();
    const result = invoke(f, code, { reader: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const settings = JSON.parse(result.stdout);
    assert.equal(settings.ok, false);
    assert.deepEqual(settings.settings, {});
    assert.ok(settings.error.includes(code));
    assert.ok(settings.error.includes(f.settingsPath));
  });
}

for (const code of ['EACCES', 'EPERM', 'EIO']) {
  test(`${code} settings denial blocks a force build without publishing default-root transcripts or progress`, () => {
    const f = fixture();
    const before = snapshot(f.dbPath);
    const result = invoke(f, code, { args: ['--build'] });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const failure = JSON.parse(result.stdout);
    assert.match(failure.error, /settings_unavailable/);
    assert.ok(failure.error.includes(code));
    assert.ok(failure.error.includes(f.settingsPath));
    assert.deepEqual(snapshot(f.dbPath), before);
    const recovered = runCli(['--build'], { home: f.home });
    assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
  });
  for (const verb of ['query', 'search']) {
    test(`${code} settings denial keeps warned indexed reads available but nonce freshness cannot index default roots (${verb})`, () => {
      const f = fixture();
      const before = snapshot(f.dbPath);
      assert.ok(before.messages.length > 0, 'real captured records exist in the cached index');
      const args = verb === 'query' ? ['--query', f.query]
        : ['--search', 'needle', '--nonce', 'settings-access-not-yet-indexed'];
      const result = invoke(f, code, { args });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stderr, /index refresh skipped/);
      assert.ok(result.stderr.includes(code));
      assert.ok(result.stderr.includes(f.settingsPath));
      if (verb === 'query') assert.equal(JSON.parse(result.stdout)[0].count, before.messages.length);
      assert.deepEqual(snapshot(f.dbPath), before, 'no freshness build writes without known provider settings');
    });
  }
}
