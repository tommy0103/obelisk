// node:sqlite lifecycle and migrations for the Core package.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CLAUDE_DIR, CODEX_DIR, TEXT_LIMIT, trunc, truncJson, extractText, extractContentType, extractMessageIsMeta, filePath, isDir, readLines } from './parsing.ts';
import { configureConnection } from './tx.ts';
import { migrateCoreSchemaColumns } from './schema-migrations.ts';
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
  return db;
}

// Queries and daemon-arbitration checks must never migrate/configure the index.
// The caller is responsible for ensuring the database exists first.
function openReadDb(): NodeSqliteDb {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  db.exec('PRAGMA busy_timeout=250');
  return db;
}

// Memory mutations (remember/forget) touch only memories/memories_fts, which
// index builds never delete from — so attune is independent of daemon write
// ownership and the writer lease (ADR 0006 amendment). It must still never
// migrate or configure the index: it opens the existing database as-is and
// fails honestly when the memory layer is not there yet.
const ATTUNE_MEMORY_COLUMNS = [
  'id', 'session_id', 'project', 'message_start', 'message_end',
  'path', 'anchors', 'summary', 'created_at', 'deleted_at', 'deleted_reason',
] as const;

const ATTUNE_MEMORY_TRIGGERS = [
  'memories_fts_ai', 'memories_fts_ad', 'memories_fts_au',
] as const;

function openAttuneDb(): NodeSqliteDb {
  if (!existsSync(DB_PATH)) {
    throw new Error('Obelisk index is not initialized; run an index build (obelisk --build) before writing memories');
  }
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout=5000');
  const columns = new Set(
    db.prepare('PRAGMA table_info(memories)').all().map((row) => String(row.name)),
  );
  // The FTS table and its maintenance triggers are part of the memory layer:
  // without them a write "succeeds" but the memory can never be recalled.
  const objects = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE name IN ('memories_fts', 'memories_fts_ai', 'memories_fts_ad', 'memories_fts_au')")
      .all().map((row) => String(row.name)),
  );
  const complete = ATTUNE_MEMORY_COLUMNS.every((column) => columns.has(column))
    && objects.has('memories_fts')
    && ATTUNE_MEMORY_TRIGGERS.every((trigger) => objects.has(trigger));
  if (!complete) {
    db.close();
    throw new Error('Obelisk index predates the memory layer; run an index build (obelisk --build) before writing memories');
  }
  return db;
}

function openWriterLeaseDb(lockPath: string): NodeSqliteDb {
  return new DatabaseSync(lockPath);
}

function rebuildMemoryFts(db: SqliteDb): void {
  db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
}


export { CLAUDE_DIR, CODEX_DIR, OBELISK_DIR, DB_PATH, TEXT_LIMIT, ATTUNE_MEMORY_COLUMNS, ATTUNE_MEMORY_TRIGGERS, openDb, openReadDb, openAttuneDb, openWriterLeaseDb, rebuildMemoryFts, trunc, truncJson, extractText, extractContentType, extractMessageIsMeta, filePath, isDir, readLines };
