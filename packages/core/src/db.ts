// node:sqlite lifecycle and migrations for the Core package.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CLAUDE_DIR, CODEX_DIR, TEXT_LIMIT, trunc, truncJson, extractText, extractContentType, extractMessageIsMeta, filePath, isDir, readLines } from './parsing.ts';
import { configureConnection } from './tx.ts';
import { migrateCoreSchemaColumns, migrateFtsTokenizer, resolveFtsTokenizer } from './schema-migrations.ts';
import type { NodeSqliteDb, SqliteDb } from './sqlite-types.ts';

const OBELISK_DIR = join(homedir(), '.obelisk');
const LEGACY_DB_PATH = join(CLAUDE_DIR, 'obelisk.sqlite');
const DB_PATH = join(OBELISK_DIR, 'obelisk.sqlite');
const SCHEMA = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

function migrateLegacyDbIfNeeded() {
  if (existsSync(DB_PATH)) return;
  if (!existsSync(LEGACY_DB_PATH)) return;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  copyFileSync(LEGACY_DB_PATH, DB_PATH);
}

function openDb(): NodeSqliteDb {
  migrateLegacyDbIfNeeded();
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  configureConnection(db, { busyTimeoutMs: 250 });
  migrateCoreSchemaColumns(db);
  db.exec(SCHEMA);
  migrateCoreSchemaColumns(db);
  migrateFtsTokenizer(db, resolveFtsTokenizer());
  return db;
}

// Queries and daemon-arbitration checks must never migrate/configure the index.
// The caller is responsible for ensuring the database exists first.
function openReadDb(): NodeSqliteDb {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  db.exec('PRAGMA busy_timeout=250');
  return db;
}

function openWriterLeaseDb(lockPath: string): NodeSqliteDb {
  return new DatabaseSync(lockPath);
}

function rebuildMemoryFts(db: SqliteDb): void {
  db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
}


export { CLAUDE_DIR, CODEX_DIR, OBELISK_DIR, DB_PATH, TEXT_LIMIT, openDb, openReadDb, openWriterLeaseDb, rebuildMemoryFts, trunc, truncJson, extractText, extractContentType, extractMessageIsMeta, filePath, isDir, readLines };
