// node:sqlite lifecycle and migrations for the Core package.
import { createRequire } from 'node:module';
import { CLAUDE_DIR, CODEX_DIR, TEXT_LIMIT, trunc, truncJson, extractText, extractContentType, extractMessageIsMeta, filePath, isDir, readLines } from './parsing.ts';
import { configureConnection } from './tx.ts';
import { migrateCoreSchemaColumns } from './schema-migrations.ts';
import type { NodeSqliteDb, SqliteDb } from './sqlite-types.ts';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const OBELISK_DIR = path.join(os.homedir(), '.obelisk');
const LEGACY_DB_PATH = path.join(CLAUDE_DIR, 'obelisk.sqlite');
const DB_PATH = path.join(OBELISK_DIR, 'obelisk.sqlite');
const SCHEMA = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

function migrateLegacyDbIfNeeded() {
  if (fs.existsSync(DB_PATH)) return;
  if (!fs.existsSync(LEGACY_DB_PATH)) return;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.copyFileSync(LEGACY_DB_PATH, DB_PATH);
}

function openDb(): NodeSqliteDb {
  migrateLegacyDbIfNeeded();
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  configureConnection(db, { busyTimeoutMs: 250 });
  migrateCoreSchemaColumns(db);
  db.exec(SCHEMA);
  migrateCoreSchemaColumns(db);
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

/**
 * Repopulate the failed-tool-result index. This is a full refresh rather than
 * incremental bookkeeping: only `is_error` rows are indexed (a few thousand on a
 * large history), and `tool_results` is written with INSERT OR REPLACE, whose
 * implicit deletes do not fire DELETE triggers unless recursive_triggers is on.
 */
function rebuildToolErrorsFts(db: SqliteDb): void {
  db.exec('DELETE FROM tool_errors_fts');
  db.exec(`INSERT INTO tool_errors_fts (tool_use_id, session_id, content)
    SELECT tool_use_id, session_id, content FROM tool_results WHERE is_error = 1`);
}


export { CLAUDE_DIR, CODEX_DIR, OBELISK_DIR, DB_PATH, TEXT_LIMIT, openDb, openReadDb, openWriterLeaseDb, rebuildMemoryFts, rebuildToolErrorsFts, trunc, truncJson, extractText, extractContentType, extractMessageIsMeta, filePath, isDir, readLines, fs, path, os };
