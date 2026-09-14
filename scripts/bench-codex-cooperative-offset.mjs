// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Cooperative-offset rollout benchmark. It never mutates its input files: each
// source is copied to a temporary JSONL, indexed once, then given the same
// fixed suffix and incrementally indexed. Use real Codex transcripts:
//
// node --experimental-strip-types scripts/bench-codex-cooperative-offset.mjs \
//   --source /path/to/30mb-rollout.jsonl --source /path/to/177mb-rollout.jsonl
//
// The script reports parse/persist time plus the parser's source-byte, suffix-
// byte, JSON-line, and emitted-record observations. It fails if an input cannot
// take the cooperative plan or if its source I/O grows beyond two suffix passes.

import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { persist } from '../packages/core/src/persist.ts';
import { createCodexParseMetrics, parse } from '../packages/core/src/providers/codex.ts';

const args = process.argv.slice(2);
const sources = args.flatMap((arg, index) => arg === '--source' ? [args[index + 1]] : []).filter(Boolean);
const mode = args.includes('--verified') ? 'verified' : 'both';
if (sources.length === 0) throw new Error('usage: add one or more --source <rollout.jsonl> arguments');
if (args.includes('--cooperative-only')) throw new Error('--cooperative-only is obsolete; benchmark both cooperative and verified paths');
const MIN_SMALL_SOURCE_BYTES = 30_000_000;
const MIN_LARGE_SOURCE_BYTES = 177_000_000;
const sourceStats = sources.map(source => ({ source, stat: statSync(source) }));
if (mode === 'both'
  && (!sourceStats.some(({ stat }) => stat.size >= MIN_SMALL_SOURCE_BYTES)
    || !sourceStats.some(({ stat }) => stat.size >= MIN_LARGE_SOURCE_BYTES))) {
  throw new Error('real benchmark requires sources of at least 30 MB and 177 MB; use --verified for a single-path diagnostic');
}

const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');
const suffix = `${JSON.stringify({
  type: 'event_msg', timestamp: '2099-01-01T00:00:00Z', payload: { type: 'user_message', message: 'cooperative benchmark suffix' },
})}\n`;
const suffixBytes = Buffer.byteLength(suffix);

function ms(fn) {
  const start = performance.now();
  const value = fn();
  return { value, elapsed: performance.now() - start };
}

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}

function drain(gen) {
  const values = [];
  let step = gen.next();
  while (!step.done) { values.push(step.value); step = gen.next(); }
  return { values, cursor: step.value };
}

function* replay(values, cursor) {
  yield* values;
  return cursor;
}

console.log('source\tmode\tsizeMiB\tplan\treadMiB\tsuffixKiB\tjsonLines\temitted\tparseMs\tpersistMs\ttotalMs');
for (const source of sources) {
  const sourceStat = statSync(source);
  const modes = mode === 'verified' ? ['verified'] : ['cooperative', 'verified'];
  for (const benchmarkMode of modes) {
    const dir = mkdtempSync(join(tmpdir(), 'obelisk-codex-bench-'));
    const path = join(dir, basename(source));
    const db = makeDb();
    try {
      copyFileSync(source, path);
      const unit = { key: path, sessionId: '', meta: { source: 'codex', guardian: false } };
      const initial = ms(() => persist(db, unit, parse(unit, null)));
      const cursor = initial.value;
      if (cursor === null) throw new Error(`${basename(source)} did not produce a resumable Codex cursor`);

      appendFileSync(path, suffix);
      const metrics = createCodexParseMetrics();
      const parseUnit = benchmarkMode === 'verified'
        ? { ...unit, meta: { ...unit.meta, readMode: 'strict' } }
        : unit;
      const parsed = ms(() => drain(parse(parseUnit, cursor, metrics)));
      const persisted = ms(() => persist(db, parseUnit, replay(parsed.value.values, parsed.value.cursor)));
      const expectedPlan = benchmarkMode === 'verified' ? 'verified-append' : 'cooperative-append';
      if (metrics.plan !== expectedPlan) throw new Error(`${basename(source)} selected ${metrics.plan}, not ${expectedPlan}`);
      if (benchmarkMode === 'cooperative' && metrics.sourceBytesRead > suffixBytes * 2) {
        throw new Error(`${basename(source)} read ${metrics.sourceBytesRead} bytes for a ${suffixBytes}-byte suffix`);
      }
      console.log([
        basename(source),
        benchmarkMode,
        (sourceStat.size / 1024 / 1024).toFixed(1),
        metrics.plan,
        (metrics.sourceBytesRead / 1024 / 1024).toFixed(3),
        (metrics.suffixBytesRead / 1024).toFixed(3),
        metrics.jsonLinesParsed,
        metrics.emittedRecords,
        parsed.elapsed.toFixed(2),
        persisted.elapsed.toFixed(2),
        (parsed.elapsed + persisted.elapsed).toFixed(2),
      ].join('\t'));
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
