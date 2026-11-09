// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { repoRoot, runCli } from './cli-test-helpers.mjs';
import { makeTempDir } from './temp-dirs.mjs';

const sourceId = 'codexhost-antigravity';
const marker = '__codexhost_antigravity_canonical_transcript_v2__';
const mappingFixture = JSON.parse(readFileSync(new URL('./fixtures/codexhost-antigravity/mapping-v1.json', import.meta.url), 'utf8'));
const historyFixture = JSON.parse(readFileSync(new URL('./fixtures/codexhost-antigravity/history-v1.json', import.meta.url), 'utf8'));

for (const runtime of ['Core', 'App', 'built CLI']) for (const nested of [false, true]) {
  test(`${runtime}: selected-root census retains excluded ${nested ? 'nested' : 'separate'} history until explicit rebuild`, () => {
    const home = makeTempDir('obelisk-antigravity-root-selection-');
    const rootB = join(home, 'selected-b');
    const mappingRootB = join(rootB, 'mapping-store', 'threads');
    mkdirSync(mappingRootB, { recursive: true });
    const rootA = nested ? join(mappingRootB, 'excluded-a') : join(home, 'excluded-a');
    const config = join(home, 'config', 'obelisk', 'settings.json');
    const dbPath = join(home, 'data', 'obelisk', 'obelisk.sqlite');
    const roots = Object.fromEntries(['claude', 'codex', 'copilot', 'deepseek', 'hermes', 'kimi', 'kiro', 'omp', 'opencode', 'pi', 'zcode']
      .map(id => [id, '']));
    roots[sourceId] = rootA;
    const settings = { providerRoots: roots };
    mkdirSync(dirname(config), { recursive: true });
    const saveSettings = () => writeFileSync(config, JSON.stringify(settings));
    saveSettings();
    const env = { ...process.env, HOME: home, USERPROFILE: home, OBELISK_USE_XDG: '1',
      XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'),
      XDG_CACHE_HOME: join(home, 'cache'), XDG_RUNTIME_DIR: join(home, 'runtime'),
      CODEXHOST_DATA_DIR: join(home, 'unused-env-root'), DSH_HOME: join(home, 'dsh'), HERMES_HOME: join(home, 'hermes') };
    delete env.OBELISK_HOME;
    const seed = (root, cwd) => {
      const mapping = structuredClone(mappingFixture);
      const history = structuredClone(historyFixture);
      mapping.cwd = cwd;
      history.turns[0].items[0].item.cwd = cwd;
      const mappingPath = join(root, 'mapping-store', 'threads', `${mapping.hostThreadId}.json`);
      const historyPath = join(root, 'antigravity-history', `${mapping.hostThreadId}.json`);
      mkdirSync(dirname(mappingPath), { recursive: true });
      mkdirSync(dirname(historyPath), { recursive: true });
      writeFileSync(mappingPath, JSON.stringify(mapping));
      writeFileSync(historyPath, JSON.stringify(history));
      return { mappingPath, historyPath };
    };
    seed(rootA, join(home, 'project-a'));
    const inspect = work => { const db = new DatabaseSync(dbPath); try { return work(db); } finally { db.close(); } };
    const messages = () => inspect(db => db.prepare('SELECT uuid,session_id,role,text,visibility FROM messages ORDER BY uuid').all());
    const build = (force = false) => {
      if (!force) inspect(db => db.exec("DELETE FROM index_state WHERE jsonl_path='__last_build__'"));
      if (runtime === 'built CLI') {
        const query = join(home, 'query.mjs');
        writeFileSync(query, `return sessions({source:'${sourceId}'});`);
        const result = runCli(force ? ['--build'] : ['--query', query], { home, env });
        assert.equal(result.status, 0, result.stderr + result.stdout);
      } else {
        const coreUrl = pathToFileURL(join(repoRoot, 'packages/core/src/indexer.ts')).href;
        const appUrl = pathToFileURL(join(repoRoot, 'app/src/main/indexer.ts')).href;
        const code = runtime === 'Core'
          ? `const {buildIndex}=await import(${JSON.stringify(coreUrl)}); console.log(JSON.stringify(buildIndex({force:${force},ignoreRecentBuild:true})));`
          : `const {readFileSync}=await import('node:fs'); const {buildIndex}=await import(${JSON.stringify(appUrl)}); console.log(JSON.stringify(buildIndex({force:${force},providerSettings:JSON.parse(readFileSync(${JSON.stringify(config)},'utf8')),dbPath:${JSON.stringify(dbPath)},claudeDir:${JSON.stringify(join(home,'.claude'))}})));`;
        const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { env, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr + result.stdout);
        assert.equal(JSON.parse(result.stdout).complete, true, result.stdout);
      }
    };
    build(true);
    const original = messages();
    assert.equal(original.length, 4);
    settings.providerRoots[sourceId] = rootB;
    saveSettings();
    rmSync(rootA, { recursive: true });
    build();
    assert.deepEqual(messages(), original, 'ordinary refresh cannot delete history from an excluded unavailable root');
    build();
    assert.deepEqual(messages(), original, 'repeated refresh converges without touching excluded history');
    inspect(db => db.prepare('DELETE FROM index_state WHERE jsonl_path=?').run(marker));
    build();
    assert.deepEqual(messages(), original, 'marker replay is not deletion evidence for excluded roots');
    const current = seed(rootB, join(home, 'project-b'));
    build();
    assert.equal(messages().length, 8, 'the selected root still makes independent progress');
    rmSync(current.mappingPath);
    rmSync(current.historyPath);
    build();
    assert.deepEqual(messages(), original, 'a proved deletion in the selected root retracts only that root');
    build();
    assert.deepEqual(messages(), original, 'completed tombstones do not replay destructive work');
    build(true);
    assert.deepEqual(messages(), [], 'a deliberate rebuild with a complete census keeps only the current selection');
    build(true);
    assert.deepEqual(messages(), [], 'the selected-source rebuild is idempotent');
  });
}
