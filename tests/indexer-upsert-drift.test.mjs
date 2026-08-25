// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Regression test for the message write semantics (formerly the indexJsonl
// INSERT-OR-REPLACE vs ON-CONFLICT drift; now enforced through the shared
// persist layer). Re-indexing a claude session must upsert messages (stable
// rowid, no FTS churn) and, because claude parses fresh from an empty cursor
// (countMode 'total'), must replace message_count rather than accumulate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from '../packages/core/src/providers/claude.ts';
import { persist } from '../packages/core/src/persist.ts';
import { makeTempDir } from './temp-dirs.mjs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');

function fixtureUnit() {
  const dir = makeTempDir('obelisk-drift-');
  const jsonlPath = join(dir, 'sess.jsonl');
  const lines = [
    { uuid: 'u-1', type: 'user', timestamp: '2026-06-10T10:00:00Z', cwd: '/tmp/proj', message: { role: 'user', content: 'first question' } },
    { uuid: 'a-1', type: 'assistant', timestamp: '2026-06-10T10:00:05Z', message: { role: 'assistant', model: 'claude-opus', content: 'first answer' } },
    { uuid: 'u-2', type: 'user', timestamp: '2026-06-10T10:00:10Z', cwd: '/tmp/proj', message: { role: 'user', content: 'second question' } },
  ];
  writeFileSync(jsonlPath, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return { key: jsonlPath, sessionId: 'sid-drift', project: 'quiet-zero' };
}

test('re-indexing upserts messages (stable rowid) and replaces message_count', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const unit = fixtureUnit();

  persist(db, unit, parse(unit, null));
  const countAfterFirst = db.prepare('SELECT message_count FROM sessions WHERE id=?').get('sid-drift').message_count;
  const rowidAfterFirst = db.prepare('SELECT rowid FROM messages WHERE uuid=?').get('u-1').rowid;
  assert.equal(countAfterFirst, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages').get().c, 3);

  // Re-index the same session from scratch (fresh parse → countMode 'total').
  persist(db, unit, parse(unit, null));

  const countAfterSecond = db.prepare('SELECT message_count FROM sessions WHERE id=?').get('sid-drift').message_count;
  const rowidAfterSecond = db.prepare('SELECT rowid FROM messages WHERE uuid=?').get('u-1').rowid;
  assert.equal(countAfterSecond, 3, 'message_count is replaced, not accumulated (would be 6 under the old bug)');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages').get().c, 3, 'no duplicate rows');
  assert.equal(rowidAfterSecond, rowidAfterFirst, 'upsert preserves rowid (INSERT OR REPLACE would churn it)');

  db.close();
});
