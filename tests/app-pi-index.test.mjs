import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildIndex } from '../app/src/main/indexer.ts';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

class TestDatabase {
  constructor(dbPath) { this.db = new DatabaseSync(dbPath); }
  pragma(statement) { this.db.exec(`PRAGMA ${statement}`); }
  exec(sql) { return this.db.exec(sql); }
  prepare(sql) { return this.db.prepare(sql); }
  close() { return this.db.close(); }
}

test('app indexes configured Pi root sessions through the provider registry', () => {
  const home = mkdtempSync(join(tmpdir(), 'obelisk-app-pi-'));
  const piRoot = join(home, 'pi-sessions');
  const sessionPath = join(piRoot, '--tmp-app-pi--', 'fixture.jsonl');
  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');
  mkdirSync(join(piRoot, '--tmp-app-pi--'), { recursive: true });
  writeFileSync(sessionPath, [
    { type: 'session', version: 3, id: 'app-pi-session', timestamp: '2026-07-20T10:00:00.000Z', cwd: '/tmp/app-pi' },
    { type: 'message', id: 'user1', parentId: null, timestamp: '2026-07-20T10:00:01.000Z', message: { role: 'user', content: 'app Pi index needle' } },
  ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');

  const first = buildIndex({
    claudeDir: join(home, 'empty-claude'),
    codexDir: join(home, 'empty-codex'),
    providerRoots: {
      kimi: join(home, 'empty-kimi'),
      pi: piRoot,
    },
    dbPath,
    DatabaseImpl: TestDatabase,
  });
  assert.deepEqual(first.affectedSessionIds, ['pi:app-pi-session']);

  const db = new TestDatabase(dbPath);
  assert.deepEqual(
    db.prepare('SELECT id,title,source,message_count FROM sessions').all().map((row) => ({ ...row })),
    [{ id: 'pi:app-pi-session', title: 'app Pi index needle', source: 'pi', message_count: 1 }],
  );
  assert.equal(db.prepare('SELECT text FROM messages').get().text, 'app Pi index needle');
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'").get().sql;
  assert.doesNotMatch(schema, /\bpi\b/i);
  db.close();

  const second = buildIndex({
    claudeDir: join(home, 'empty-claude'),
    codexDir: join(home, 'empty-codex'),
    providerRoots: { kimi: join(home, 'empty-kimi'), pi: piRoot },
    dbPath,
    DatabaseImpl: TestDatabase,
  });
  assert.deepEqual(second.affectedSessionIds, []);
});
