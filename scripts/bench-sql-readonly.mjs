// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// #107 merge-gate benchmark: does the semantic read-only validation
// (denylist authorizer + sourceSQL tail check) stay within the agreed budget
// compared to the previous lexical keyword scan?
//
// Methodology:
//   - LEGACY is a frozen inline copy of the pre-#107 validator (regex prefix
//     + blocked-keyword scan + prepare + all, no authorizer).
//   - CURRENT is the real sql() call path from createQueryApi.
//   - Both run against identical in-memory databases so the authorizer that
//     createQueryApi installs on the current path cannot contaminate the
//     legacy baseline.
//   - Five shapes: four light ones isolate the validation cost itself
//     (prepare dominates: stable microsecond-scale deltas), one realistic
//     heavy one (sessions listing over 1k rows) shows materiality at real
//     query scale, where execution noise exceeds the validation cost.
//   - 12 rounds; within each round the two implementations alternate per
//     shape (legacy block, then current block) so machine drift cancels.
//     Per-shape iteration counts keep total runtime under ~10 s.
//   - Reported: per-shape medians plus the workload median (median of the
//     per-shape medians). The gate applies to the workload median; per-shape
//     rows are printed for transparency.
//
// Budget (issue #107): median added latency <= 1 microsecond per sql() call
// AND median relative regression <= 10% for the representative workload.
// Measured overhead is a fixed ~90 ns per authorizer action crossing, and a
// prepare fires 1-12 crossings depending on how many tables/columns/FTS
// shadow tables the statement touches — so the lightest shapes show the
// highest RELATIVE numbers even though their absolute cost is smallest, and
// the FTS shape sits at the boundary on both axes.
//
// Usage: node scripts/bench-sql-readonly.mjs
// Exit code is 1 when either budget limit is exceeded.

import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';

const { createQueryApi } = await import('../packages/core/src/query.ts');

const ROUNDS = 12;
const BUDGET_ABS_NS = 1000; // 1 microsecond
const BUDGET_REL_PCT = 10;

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, project TEXT, started_at TEXT, ended_at TEXT, source TEXT DEFAULT 'claude');
    CREATE TABLE messages (uuid TEXT PRIMARY KEY, session_id TEXT, text TEXT, role TEXT, timestamp TEXT,
                           is_meta INTEGER DEFAULT 0, visibility TEXT DEFAULT 'visible', source TEXT DEFAULT 'claude');
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      uuid UNINDEXED, session_id UNINDEXED, text, content='messages', content_rowid='rowid');
  `);
  const insertSession = db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?)');
  for (let s = 0; s < 1000; s += 1) {
    insertSession.run(`s${s}`, `title${s}`, `proj${s % 5}`, `2026-08-01T00:${String(s % 60).padStart(2, '0')}:00Z`, `2026-08-01T01:${String(s % 60).padStart(2, '0')}:00Z`, 'codex');
  }
  const insertMessage = db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?)');
  for (let i = 0; i < 1000; i += 1) {
    insertMessage.run(`u${i}`, `s${i % 100}`, `message ${i % 50} body with realistic text content`,
      'user', `2026-08-01T00:00:${String(i % 60).padStart(2, '0')}Z`, 0, 'visible', 'kimi');
  }
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
  return db;
}
const legacyDb = makeDb();
const currentDb = makeDb();

const SHAPES = [
  ['trivial', 'SELECT 1', [], 8000],
  ['aggregate', 'SELECT COUNT(*) AS c FROM messages', [], 8000],
  ['fts-join',
    `SELECT m.uuid FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
     WHERE messages_fts MATCH ? LIMIT 5`,
    ['message'], 8000],
  ['cte',
    'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<20) SELECT SUM(x) AS s FROM c',
    [], 8000],
  ['sessions-list',
    'SELECT * FROM sessions s ORDER BY ended_at DESC LIMIT 50',
    [], 1000],
];

// ---- legacy: frozen copy of the pre-#107 lexical validator ----
function legacyAssertReadOnlySql(sql) {
  const text = String(sql || '').trim();
  if (!/^(SELECT|WITH)\b/i.test(text)) {
    throw new Error('sql() only supports read-only SELECT/WITH queries');
  }
  if (/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|VACUUM|ATTACH|DETACH)\b/i.test(text)) {
    throw new Error('sql() only supports read-only SELECT/WITH queries');
  }
}
const legacySql = (sql, ...p) => {
  legacyAssertReadOnlySql(sql);
  return legacyDb.prepare(sql).all(...p);
};

// ---- current: the real post-#107 sql() path ----
const api = createQueryApi(currentDb);
const currentSql = (sql, ...p) => api.sql(sql, ...p);

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function timeBlock(fn, sql, params, iterations) {
  const start = performance.now();
  for (let i = 0; i < iterations; i += 1) fn(sql, ...params);
  return ((performance.now() - start) * 1e6) / iterations; // ns per call
}

console.log(`rounds=${ROUNDS}\n`);
console.log('shape         legacy ns/call  current ns/call  delta ns  delta %');
const shapeDeltas = [];
const shapeRels = [];
for (const [name, sql, params, iterations] of SHAPES) {
  // Warm both paths so JIT effects do not land in the first round.
  legacySql(sql, ...params);
  currentSql(sql, ...params);
  const legacyNs = [];
  const currentNs = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    legacyNs.push(timeBlock(legacySql, sql, params, iterations));
    currentNs.push(timeBlock(currentSql, sql, params, iterations));
  }
  const medLegacy = median(legacyNs);
  const medCurrent = median(currentNs);
  const medDelta = medCurrent - medLegacy;
  const medRel = (medDelta / medLegacy) * 100;
  shapeDeltas.push(medDelta);
  shapeRels.push(medRel);
  console.log(
    `${name.padEnd(13)} ${medLegacy.toFixed(0).padStart(14)} ${medCurrent.toFixed(0).padStart(16)} ${medDelta.toFixed(0).padStart(9)} ${medRel.toFixed(1).padStart(8)}`,
  );
}

const workloadDelta = median(shapeDeltas);
const workloadRel = median(shapeRels);
console.log(`\nworkload median: +${workloadDelta.toFixed(0)} ns/call, +${workloadRel.toFixed(1)}%`);
console.log(`budget:          <= ${BUDGET_ABS_NS} ns/call, <= ${BUDGET_REL_PCT}%`);

const failed = workloadDelta > BUDGET_ABS_NS || workloadRel > BUDGET_REL_PCT;
legacyDb.close();
currentDb.close();
console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS (within both #107 budget limits)');
process.exitCode = failed ? 1 : 0;
