// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Under the trigram tokenizer, a query term shorter than three code points
// emits no tokens: alone it can only match nothing, and next to longer terms
// it becomes an empty phrase that constrains nothing — search('quick ok')
// silently returned rows without 'ok' in them. These tests pin the guard
// (post-filter short terms, LIKE-scan all-short queries), prove the default
// unicode61 behavior is untouched, and pin the hit-centered snippet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

import { createQueryApi } from '../packages/core/src/query.ts';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');

function seed(db) {
  db.prepare("INSERT INTO sessions (id, title, project, started_at) VALUES ('s1','Guard tests','proj','2026-06-10T10:00:00Z')").run();
  const ins = db.prepare('INSERT INTO messages (uuid, session_id, role, text, timestamp) VALUES (?,?,?,?,?)');
  ins.run('m-quick-only', 's1', 'user', 'the quick brown fox jumped over the lazy dog', '2026-06-10T10:00:01Z');
  ins.run('m-quick-ok', 's1', 'user', 'quick check says ok to proceed', '2026-06-10T10:00:02Z');
  ins.run('m-ok-only', 's1', 'user', 'all fine and ok over here', '2026-06-10T10:00:03Z');
  ins.run('m-cjk-fix', 's1', 'user', '悬空引用的问题已经彻底修复', '2026-06-10T10:00:04Z');
  ins.run('m-cjk-fix-ok', 's1', 'user', '修复完了，ok 可以合并', '2026-06-10T10:00:05Z');
  ins.run('m-hyphen-ok', 's1', 'user', 'running gen-itgc ok now', '2026-06-10T10:00:06Z');
  ins.run('m-hyphen-only', 's1', 'user', 'gen-itgc failed with an error', '2026-06-10T10:00:07Z');
}

// Same shape as the tokenizer migration: dropping an external-content FTS
// table leaves the content table and its triggers intact, and 'rebuild'
// repopulates the new one.
function trigramDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.exec('DROP TABLE messages_fts');
  db.exec("CREATE VIRTUAL TABLE messages_fts USING fts5(uuid UNINDEXED, session_id UNINDEXED, text, content=messages, content_rowid=rowid, tokenize='trigram')");
  seed(db);
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
  return db;
}

function unicodeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  seed(db);
  return db;
}

test('trigram: a short term next to a long one filters instead of silently matching everything', () => {
  const api = createQueryApi(trigramDb());
  const hits = api.search('quick ok');
  assert.deepEqual(hits.map((h) => h.message.uuid), ['m-quick-ok'],
    "rows without 'ok' must not match a query that asks for it");
  assert.equal(hits[0].degraded, 'short-token-post-filter');
  assert.equal(typeof hits[0].rank, 'number', 'the long-term MATCH keeps relevance ranking');
});

test('trigram: an all-short query falls back to a LIKE scan instead of zero hits', () => {
  const api = createQueryApi(trigramDb());
  const hits = api.search('ok');
  assert.deepEqual(new Set(hits.map((h) => h.message.uuid)),
    new Set(['m-quick-ok', 'm-ok-only', 'm-cjk-fix-ok', 'm-hyphen-ok']));
  assert.equal(hits[0].degraded, 'like-scan');
  assert.equal(hits[0].rank, null, 'a scan has no FTS rank; recency orders it');
});

test('trigram: a two-code-point CJK word plus a short ASCII word both survive', () => {
  const api = createQueryApi(trigramDb());
  const hits = api.search('修复 ok');
  assert.deepEqual(hits.map((h) => h.message.uuid), ['m-cjk-fix-ok'],
    'only the row containing both short terms matches');
});

test('trigram: the punctuation fallback path routes through the same guard', () => {
  const api = createQueryApi(trigramDb());
  // 'gen-itgc ok' throws as raw FTS5 (column filter syntax), falls back to
  // token quoting — where 'ok' must still be enforced, not dropped.
  const hits = api.search('gen-itgc ok');
  assert.deepEqual(hits.map((h) => h.message.uuid), ['m-hyphen-ok']);
});

test('trigram: raw FTS5 syntax is honored untouched', () => {
  const api = createQueryApi(trigramDb());
  const hits = api.search('"quick" OR "fine"');
  assert.deepEqual(new Set(hits.map((h) => h.message.uuid)),
    new Set(['m-quick-only', 'm-quick-ok', 'm-ok-only']));
  assert.equal(hits[0].degraded, undefined, 'operator queries bypass the guard');
});

test('unicode61 default: short terms are real tokens and the guard stays out of the way', () => {
  const api = createQueryApi(unicodeDb());
  const hits = api.search('quick ok');
  assert.deepEqual(hits.map((h) => h.message.uuid), ['m-quick-ok']);
  assert.equal(hits[0].degraded, undefined);
  assert.equal(typeof hits[0].rank, 'number');
});

test('snippet centers on the hit that head truncation would miss', () => {
  const db = unicodeDb();
  const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor. '.repeat(8);
  db.prepare('INSERT INTO messages (uuid, session_id, role, text, timestamp) VALUES (?,?,?,?,?)')
    .run('m-deep', 's1', 'user', `${filler}the elusive needleword appears only here${filler}`, '2026-06-10T10:00:08Z');
  const api = createQueryApi(db);
  const hits = api.search('needleword');
  assert.equal(hits.length, 1);
  assert.ok(!hits[0].message.text.slice(0, 240).includes('needleword'),
    'precondition: head truncation alone would miss this hit');
  assert.ok(hits[0].snippet.includes('needleword'), 'the snippet window contains the hit');
  assert.ok(hits[0].snippet.startsWith('…') && hits[0].snippet.endsWith('…'));
  assert.ok(hits[0].snippet.length <= 200, 'the snippet stays a window, not the whole message');
});
