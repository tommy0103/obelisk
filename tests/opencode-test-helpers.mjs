// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createOpencodeProvider } from '../packages/core/src/providers/opencode.ts';
import { openOpencodeDatabaseWithNodeSqlite as openDb } from '../packages/core/src/providers/opencode-node.ts';
import { makeTempDir } from './temp-dirs.mjs';

// These stores use SQL extracted from the pinned upstream generated schema,
// including foreign keys and indexes, rather than OPENCODE_DDL above.
export function upstreamStore(version = 'v1.19.3', filename = 'opencode.db', directory) {
  const dir = directory ?? makeTempDir('opencode-upstream-');
  const path = join(dir, filename);
  const db = new DatabaseSync(path);
  db.exec(readFileSync(new URL(`./fixtures/opencode/upstream-${version}.sql`, import.meta.url), 'utf8'));
  db.prepare('INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?)')
    .run('p', '/workspace/synthetic', 1000, 1000, '[]');
  return { dir, path, db, provider: createOpencodeProvider({ rootDir: dir, openDatabase: openDb }) };
}

export function upstreamSession(db, id, table = 'session', parent = null) {
  db.prepare(`INSERT INTO ${table} (id, project_id, slug, directory, title, version, time_created, time_updated, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, 'p', id, '/workspace/synthetic', id, table === 'session' ? '1.19.3' : '2.0.32', 1000, 1000, parent);
}

export function upstreamMessage(db, sessionId, id, type, seq, data) {
  db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, sessionId, type, seq, 1000, 1000, JSON.stringify(data));
}
