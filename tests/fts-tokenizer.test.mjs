import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { ftsTokenizerMigrationPending, migrateFtsTokenizer, resolveFtsTokenizer } from '../packages/core/src/schema-migrations.ts';
import { shouldSkipBuild } from '../packages/core/src/indexer.ts';

const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');

function openSchemaDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}

function insertMessage(db, uuid, text) {
  db.prepare('INSERT INTO messages (uuid, session_id, text) VALUES (?,?,?)').run(uuid, 'session-1', text);
}

function ftsHits(db, query) {
  return db.prepare('SELECT COUNT(*) c FROM messages_fts WHERE text MATCH ?').get(query).c;
}

function createSqlFor(db, table) {
  return db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table).sql;
}

test('resolveFtsTokenizer keeps the schema default when unset', () => {
  assert.equal(resolveFtsTokenizer({}), null);
  assert.equal(resolveFtsTokenizer({ OBELISK_FTS_TOKENIZER: '' }), null);
  assert.equal(resolveFtsTokenizer({ OBELISK_FTS_TOKENIZER: '  ' }), null);
});

test('resolveFtsTokenizer accepts FTS5 tokenizers and their word arguments', () => {
  assert.equal(resolveFtsTokenizer({ OBELISK_FTS_TOKENIZER: 'trigram' }), 'trigram');
  assert.equal(resolveFtsTokenizer({ OBELISK_FTS_TOKENIZER: ' trigram ' }), 'trigram');
  assert.equal(
    resolveFtsTokenizer({ OBELISK_FTS_TOKENIZER: 'unicode61 remove_diacritics 1' }),
    'unicode61 remove_diacritics 1',
  );
});

test('resolveFtsTokenizer rejects values that could break out of the DDL', () => {
  for (const value of ["trigram'); DROP TABLE messages; --", 'bogus', "unicode61'", 'trigram; VACUUM']) {
    assert.throws(() => resolveFtsTokenizer({ OBELISK_FTS_TOKENIZER: value }), /OBELISK_FTS_TOKENIZER/);
  }
});

test('migrateFtsTokenizer is a no-op without configuration', () => {
  const db = openSchemaDb();
  try {
    const before = createSqlFor(db, 'messages_fts');
    migrateFtsTokenizer(db, null);
    assert.equal(createSqlFor(db, 'messages_fts'), before);
  } finally {
    db.close();
  }
});

test('migrateFtsTokenizer switches both FTS tables and repopulates existing rows', () => {
  const db = openSchemaDb();
  try {
    // Indexed before the migration: a CJK phrase glued into a longer run of CJK,
    // which unicode61 indexes as a single token and cannot match on a sub-phrase.
    insertMessage(db, 'msg-1', '步2 重跑gen-itgc后50条悬空引用清零，修复已验证');
    assert.equal(ftsHits(db, '悬空引用'), 0, 'unicode61 should miss the sub-phrase');

    migrateFtsTokenizer(db, 'trigram');

    for (const table of ['messages_fts', 'memories_fts']) {
      assert.match(createSqlFor(db, table), /tokenize='trigram'/);
    }
    assert.equal(ftsHits(db, '悬空引用'), 1, 'rebuild should reindex rows written before the switch');
    assert.equal(ftsHits(db, 'itgc'), 1, 'ASCII glued to CJK should match too');
  } finally {
    db.close();
  }
});

test('migrateFtsTokenizer keeps the content triggers working after the swap', () => {
  const db = openSchemaDb();
  try {
    migrateFtsTokenizer(db, 'trigram');

    insertMessage(db, 'msg-2', '额度调整链在这里被提到');
    assert.equal(ftsHits(db, '额度调整链'), 1, 'insert trigger should feed the rebuilt table');

    db.prepare('UPDATE messages SET text=? WHERE uuid=?').run('所有权制度改写后的正文', 'msg-2');
    assert.equal(ftsHits(db, '额度调整链'), 0, 'update trigger should retract the old text');
    assert.equal(ftsHits(db, '所有权制度'), 1, 'update trigger should index the new text');

    db.prepare('DELETE FROM messages WHERE uuid=?').run('msg-2');
    assert.equal(ftsHits(db, '所有权制度'), 0, 'delete trigger should retract the row');
  } finally {
    db.close();
  }
});

test('ftsTokenizerMigrationPending reports only a real mismatch', () => {
  const db = openSchemaDb();
  try {
    assert.equal(ftsTokenizerMigrationPending(db, null), false, 'unconfigured means nothing to do');
    assert.equal(ftsTokenizerMigrationPending(db, 'trigram'), true);
    assert.equal(ftsTokenizerMigrationPending(db, 'unicode61'), true, 'memories_fts still carries arguments');

    migrateFtsTokenizer(db, 'trigram');
    assert.equal(ftsTokenizerMigrationPending(db, 'trigram'), false);
  } finally {
    db.close();
  }
});

test('the build debounce yields to a pending tokenizer switch', () => {
  const db = openSchemaDb();
  try {
    db.prepare('INSERT INTO index_state (jsonl_path, mtime, lines_processed) VALUES (?, ?, 0)').run('__last_build__', 100000);

    assert.deepEqual(
      shouldSkipBuild(db, { now: 110000, ftsTokenizer: null }),
      { skip: true, reason: 'recent_build' },
      'an unconfigured tokenizer keeps the debounce intact',
    );
    assert.equal(
      shouldSkipBuild(db, { now: 110000, ftsTokenizer: 'trigram' }).skip,
      false,
      'a pending switch needs the write path the build owns',
    );

    migrateFtsTokenizer(db, 'trigram');
    assert.deepEqual(
      shouldSkipBuild(db, { now: 110000, ftsTokenizer: 'trigram' }),
      { skip: true, reason: 'recent_build' },
      'once migrated the debounce applies again',
    );
  } finally {
    db.close();
  }
});

test('daemon ownership still wins over a pending tokenizer switch', () => {
  const db = openSchemaDb();
  try {
    db.prepare('INSERT INTO index_state (jsonl_path, mtime, lines_processed) VALUES (?, ?, 0)').run('__app_heartbeat__', 100000);

    assert.deepEqual(
      shouldSkipBuild(db, { now: 110000, ftsTokenizer: 'trigram' }),
      { skip: true, reason: 'daemon_active' },
      'the app owns writes and runs the same migration itself',
    );
  } finally {
    db.close();
  }
});

test('migrateFtsTokenizer is idempotent and reversible', () => {
  const db = openSchemaDb();
  try {
    insertMessage(db, 'msg-3', '悬空清零');

    migrateFtsTokenizer(db, 'trigram');
    const afterFirst = createSqlFor(db, 'messages_fts');
    migrateFtsTokenizer(db, 'trigram');
    assert.equal(createSqlFor(db, 'messages_fts'), afterFirst, 'second run should not rewrite the table');

    migrateFtsTokenizer(db, 'unicode61');
    assert.match(createSqlFor(db, 'messages_fts'), /tokenize='unicode61'/);
    assert.equal(ftsHits(db, '悬空清零'), 1, 'switching back should keep the row searchable');
  } finally {
    db.close();
  }
});
