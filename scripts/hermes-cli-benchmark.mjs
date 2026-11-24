#!/usr/bin/env node
// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Real built CLI processes over an isolated, generated large Hermes source.
// Same generated source workload and commands; the indexed invocation path is checkout-local.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, freemem, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const positive = (key, fallback) => { const value = Number(args.get(key) ?? fallback); assert.ok(Number.isSafeInteger(value) && value > 0, key); return value; };
const sessions = positive('--sessions', 2500), perSession = positive('--messages-per-session', 64);
const contentBytes = positive('--content-bytes', 9000), runs = positive('--runs', 3);
assert.ok(sessions >= 2 && contentBytes >= 128);
const nonce = 'benchinvocationnonce254';
const home = mkdtempSync(join(tmpdir(), 'obelisk-hermes-cli-benchmark-'));
const source = join(home, 'seed.db');
const dataset = new DatabaseSync(source, { enableForeignKeyConstraints: false });
dataset.exec(readFileSync(join(root, 'tests/fixtures/hermes/store-schema.sql'), 'utf8'));
// Match the source's ordinary lookup indexes. No new source index is installed
// by Obelisk; these belong only to the disposable generator.
dataset.exec('CREATE INDEX idx_messages_session ON messages(session_id,timestamp); CREATE INDEX idx_messages_session_id ON messages(session_id,id);');
dataset.prepare('INSERT INTO schema_version(version) VALUES(32)').run();
const sessionInsert = dataset.prepare("INSERT INTO sessions(id,source,model,title,started_at,ended_at,message_count,cwd) VALUES(?,'cli','benchmark',?,1767225600,1767229000,?,'/benchmark/project')");
const messageInsert = dataset.prepare('INSERT INTO messages(session_id,role,content,timestamp) VALUES(?,?,?,?)');
const id = n => `bench_${String(n).padStart(6, '0')}`;
const content = prefix => prefix + 'x'.repeat(contentBytes - Buffer.byteLength(prefix));
let lastRow;
const generatedAt = performance.now();
dataset.exec('BEGIN');
for (let s = 0; s < sessions; s++) {
  sessionInsert.run(id(s), id(s), perSession);
  for (let m = 0; m < perSession; m++) {
    const row = messageInsert.run(id(s), m % 2 ? 'assistant' : 'user', content(s === 0 && m === 0 ? nonce + ' ' : 'originalpayload '), 1767225600 + m);
    if (s === sessions - 1 && m === 0) lastRow = Number(row.lastInsertRowid);
  }
}
dataset.exec('COMMIT');
dataset.close();
console.error(`Generated ${sessions * perSession} messages in ${(performance.now() - generatedAt).toFixed(0)}ms`);
const variants = [];
const report = { node: process.version, sqlite: process.versions.sqlite,
  machine: { platform: platform(), release: release(), cpu: cpus()[0]?.model, cores: cpus().length, totalMemory: totalmem(), freeMemory: freemem() },
  workload: { sessions, messages: sessions * perSession, contentBytes, sourceBytes: statSync(source).size, runs, schema: 'checked-in Hermes store shape, version32; generated content' },
  method: 'Real built CLI process wall time, known indexed invocation nonce. A private __last_build__ row is removed before due-refresh samples to exercise refresh rather than the baseline30s debounce. Immediate-repeat samples leave it intact. No production store/index is used. Normal-worker results are separate compiled Core API calls, not CLI timing claims.', variants: [] };
async function processRun(argv, env, timeout = 600_000) {
  const started = performance.now();
  return await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`deadline: ${argv.join(' ')}`)); }, timeout);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 16 * 1024 * 1024) child.kill('SIGTERM'); });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (/Warning: incomplete|Skipping .*artifact/i.test(stderr)) return reject(new Error(`incomplete refresh: ${stderr}`));
      if (code !== 0) return reject(new Error(`exit${code}: ${stderr.slice(-4000)} ${stdout.slice(-2000)}`));
      try { resolveRun({ ms: performance.now() - started, output: JSON.parse(stdout), stderr }); }
      catch (error) { reject(new Error(`invalid JSON: ${error.message}: ${stdout.slice(-1000)}`)); }
    });
  });
}
try {
  for (const [name, repo] of [['baseline', args.get('--baseline')], ['repair', root]]) {
    if (!repo) continue;
    const checkout = resolve(repo), folder = join(home, name), storage = join(folder, 'index'), hermes = join(folder, '.hermes');
    mkdirSync(storage, { recursive: true }); mkdirSync(hermes);
    copyFileSync(source, join(hermes, 'state.db'));
    const roots = Object.fromEntries(['claude', 'codex', 'codexhost-antigravity', 'copilot', 'deepseek', 'hermes', 'kimi', 'kiro', 'omp', 'opencode', 'pi', 'zcode'].map(k => [k, ''])); roots.hermes = hermes;
    writeFileSync(join(storage, 'settings.json'), JSON.stringify({ providerRoots: roots }));
    const env = { ...process.env, HOME: folder, USERPROFILE: folder, OBELISK_HOME: storage };
    delete env.DSH_HOME; delete env.HERMES_HOME; delete env.CODEXHOST_DATA_DIR;
    const cli = join(checkout, 'packages/cli/dist/cli/src/obelisk.js');
    assert.ok(statSync(cli).isFile(), `Build CLI first: ${checkout}`);
    const dbPath = join(storage, 'obelisk.sqlite');
    const query = join(folder, 'query.mjs');
    writeFileSync(query, `return {count:sql("SELECT COUNT(*) n FROM messages WHERE source='hermes'")[0].n,target:sql("SELECT substr(text,1,64) text FROM messages WHERE source='hermes' AND session_id GLOB ? AND uuid GLOB ?",${JSON.stringify('hermes:' + id(sessions - 1) + ':*')},${JSON.stringify('*:message:' + lastRow)})[0]?.text};`);
    const due = () => { const d = new DatabaseSync(dbPath); try { d.exec("DELETE FROM index_state WHERE jsonl_path='__last_build__'"); } finally { d.close(); } };
    // Match a real recent invocation record: --query uses its file path,
    // whereas only --search accepts --nonce. This avoids measuring the
    // unrelated bounded nonce-miss wait as refresh work.
    const invoker = new DatabaseSync(join(hermes, 'state.db'));
    invoker.prepare('UPDATE messages SET content=?,timestamp=? WHERE id=1')
      .run(content(`obelisk --query ${query}; obelisk --search ${nonce} --nonce ${nonce} `), Date.now() / 1000);
    invoker.close();
    const commands = command => processRun([cli, ...command], env);
    const result = { name, checkout, samples: [] }; report.variants.push(result);
    const cold = await commands(['--build']);
    assert.equal(cold.output.ok, true, `${name}: cold build must complete`);
    result.coldBuildMs = cold.ms;
    due(); await commands(['--query', query]);
    due(); await commands(['--query', query]);
    const writer = new DatabaseSync(join(hermes, 'state.db'));
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
    variants.push({ name, checkout, env, storage, hermes, query, due, commands, result, writer });
    console.error(`${name}: cold build ${cold.ms.toFixed(0)}ms`);
  }
  const sample = async (v, phase, run, command, expected = undefined, markDue = true) => {
    if (markDue) v.due();
    const measured = await v.commands(command);
    if (expected !== undefined) assert.ok(measured.output.target?.startsWith(expected), `${v.name}/${phase}: stale target ${measured.output.target}`);
    v.result.samples.push({ phase, run, ms: measured.ms, count: measured.output.count ?? null });
    console.error(`${v.name}/${phase}/${run}: ${measured.ms.toFixed(1)}ms`);
    return measured;
  };
  for (let run = 0; run < runs; run++) {
    // Alternate sample order to reduce warm-cache ordering bias.
    const order = run % 2 ? [...variants].reverse() : variants;
    for (const v of order) {
      await sample(v, 'unchanged_due_query', run, ['--query', v.query]);
      await sample(v, 'immediate_repeat_query', run, ['--query', v.query], undefined, false);
      v.writer.exec('BEGIN');
      v.writer.prepare('INSERT INTO messages(session_id,role,content,timestamp) VALUES(?,?,?,?)').run(id(0), 'user', content('append '), 1767230000 + run);
      const token = `changedneedle${run}`;
      v.writer.prepare('UPDATE messages SET content=? WHERE id=?').run(content(token + ' '), lastRow);
      v.writer.exec('COMMIT');
      await sample(v, 'mixed_append_edit_query', run, ['--query', v.query], token);
      const search = await sample(v, 'real_search', run, ['--search', token, '--nonce', nonce]);
      assert.ok(JSON.stringify(search.output).includes(token), 'actual CLI search finds the updated text');
      v.writer.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      await sample(v, 'checkpoint_only_query', run, ['--query', v.query], token);
    }
  }
  // Exercise normal incrementality through the same compiled Core runtime.
  // This is deliberately separate from real CLI strict-query measurements.
  for (const v of variants) {
    const worker = join(v.storage, 'normal-worker.mjs');
    writeFileSync(worker, `import{DatabaseSync}from'node:sqlite';import{buildIndex}from${JSON.stringify(pathToFileURL(join(v.checkout,'packages/cli/dist/core/src/indexer.js')).href)};import{createHermesProvider}from${JSON.stringify(pathToFileURL(join(v.checkout,'packages/cli/dist/core/src/providers/hermes.js')).href)};import{createProviderRegistry}from${JSON.stringify(pathToFileURL(join(v.checkout,'packages/cli/dist/core/src/providers/registry.js')).href)};let payloadReads=0;const p=createHermesProvider({rootDir:${JSON.stringify(v.hermes)},openStore:path=>{const db=new DatabaseSync(path,{readOnly:true});return new Proxy(db,{get(target,key){if(key==='prepare')return sql=>{if(/FROM messages WHERE session_id = \\? ORDER BY rowid/.test(sql))payloadReads++;return target.prepare(sql)};const val=target[key];return typeof val==='function'?val.bind(target):val}})}});const start=performance.now();const result=buildIndex({providerRegistry:createProviderRegistry([p]),ignoreRecentBuild:true});console.log(JSON.stringify({ms:performance.now()-start,payloadReads,complete:result.complete}));`);
    v.result.normal = [];
    for (let run = 0; run < runs; run++) {
      v.writer.prepare('INSERT INTO messages(session_id,role,content,timestamp) VALUES(?,?,?,?)').run(id(0), 'user', content('normal append '), 1767240000 + run);
      const measured = await processRun([worker], v.env);
      assert.equal(measured.output.complete, true);
      v.result.normal.push({ run, ...measured.output });
      console.error(`${v.name}/normal/${run}: ${measured.output.ms.toFixed(1)}ms,${measured.output.payloadReads} payload reads`);
    }
  }
  for (const v of variants) {
    v.writer.close();
    const d = new DatabaseSync(join(v.storage, 'obelisk.sqlite'), { readOnly: true });
    try { assert.equal(d.prepare("SELECT COUNT(*) n FROM messages WHERE source='hermes'").get().n, sessions * perSession + 2 * runs); } finally { d.close(); }
  }
  if (args.has('--output')) writeFileSync(resolve(args.get('--output')), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const v of variants) { try { v.writer.close(); } catch { /* already closed */ } }
  if (!args.has('--keep')) rmSync(home, { recursive: true, force: true });
}
