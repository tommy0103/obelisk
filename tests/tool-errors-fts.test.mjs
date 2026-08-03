import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { rebuildToolErrorsFts } from '../packages/core/src/db.ts';

const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');

function openSchemaDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}

function insertResult(db, { id, session = 'session-1', content, isError }) {
  db.prepare('INSERT OR REPLACE INTO tool_results (tool_use_id, message_uuid, session_id, content, is_error) VALUES (?,?,?,?,?)')
    .run(id, 'msg-' + id, session, content, isError);
}

const hits = (db, query) =>
  db.prepare('SELECT COUNT(*) c FROM tool_errors_fts WHERE tool_errors_fts MATCH ?').get(query).c;
const rows = db => db.prepare('SELECT COUNT(*) c FROM tool_errors_fts').get().c;

test('schema declares the failed-tool-result index', () => {
  assert.match(SCHEMA, /CREATE VIRTUAL TABLE IF NOT EXISTS tool_errors_fts USING fts5/);
});

test('only failed tool results are indexed', () => {
  const db = openSchemaDb();
  try {
    insertResult(db, { id: 'a', content: 'ENOENT: no such file or directory', isError: 1 });
    insertResult(db, { id: 'b', content: 'ENOENT appears here but the call succeeded', isError: 0 });

    rebuildToolErrorsFts(db);

    assert.equal(rows(db), 1, 'successful results stay out of the index');
    assert.equal(hits(db, 'ENOENT'), 1);
  } finally {
    db.close();
  }
});

test('error text is searchable and carries its session back', () => {
  const db = openSchemaDb();
  try {
    insertResult(db, { id: 'a', session: 'session-42', content: 'TypeError: cannot read property length of undefined', isError: 1 });
    rebuildToolErrorsFts(db);

    const row = db.prepare('SELECT session_id, tool_use_id FROM tool_errors_fts WHERE tool_errors_fts MATCH ?').get('TypeError');
    assert.equal(row.session_id, 'session-42');
    assert.equal(row.tool_use_id, 'a');
  } finally {
    db.close();
  }
});

test('a rebuild is idempotent', () => {
  const db = openSchemaDb();
  try {
    insertResult(db, { id: 'a', content: 'ENOENT', isError: 1 });
    rebuildToolErrorsFts(db);
    rebuildToolErrorsFts(db);
    assert.equal(rows(db), 1, 'repeated rebuilds must not duplicate rows');
  } finally {
    db.close();
  }
});

// The reason this table is refreshed wholesale instead of by trigger: the persist
// layer writes tool_results with INSERT OR REPLACE, and REPLACE only fires DELETE
// triggers when recursive_triggers is on. A trigger pair would leave the old text
// behind on every re-index of the same tool call.
test('re-indexing the same tool call leaves no stale text behind', () => {
  const db = openSchemaDb();
  try {
    insertResult(db, { id: 'a', content: 'ENOENT: original failure text', isError: 1 });
    rebuildToolErrorsFts(db);
    assert.equal(hits(db, 'original'), 1);

    insertResult(db, { id: 'a', content: 'EACCES: replaced failure text', isError: 1 });
    rebuildToolErrorsFts(db);

    assert.equal(rows(db), 1);
    assert.equal(hits(db, 'original'), 0, 'the superseded text must not remain searchable');
    assert.equal(hits(db, 'EACCES'), 1);
  } finally {
    db.close();
  }
});

test('a result that stops being an error drops out of the index', () => {
  const db = openSchemaDb();
  try {
    insertResult(db, { id: 'a', content: 'ENOENT: transient failure', isError: 1 });
    rebuildToolErrorsFts(db);
    assert.equal(rows(db), 1);

    insertResult(db, { id: 'a', content: 'ENOENT: transient failure', isError: 0 });
    rebuildToolErrorsFts(db);
    assert.equal(rows(db), 0);
  } finally {
    db.close();
  }
});

test('clearing tool_results clears the index on the next rebuild', () => {
  const db = openSchemaDb();
  try {
    insertResult(db, { id: 'a', content: 'ENOENT', isError: 1 });
    rebuildToolErrorsFts(db);

    db.exec('DELETE FROM tool_results');   // what a force build does
    rebuildToolErrorsFts(db);

    assert.equal(rows(db), 0);
  } finally {
    db.close();
  }
});
