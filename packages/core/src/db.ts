// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

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
// fails honestly when the memory layer is not there yet. The expected layer
// shape is derived from the shared schema.sql, not restated, so the two can
// never drift apart.
const ATTUNE_MEMORY_COLUMNS = Object.freeze(
  (/CREATE TABLE IF NOT EXISTS memories \(([^;]+)\);/s.exec(SCHEMA)?.[1] ?? '')
    .split(',').map(part => part.trim().split(/\s+/)[0]).filter(Boolean),
);

const ATTUNE_MEMORY_TRIGGERS = Object.freeze(
  [...SCHEMA.matchAll(/CREATE TRIGGER IF NOT EXISTS (memories_fts_\w+)/g)].map(match => match[1]),
);

function openAttuneDb(): NodeSqliteDb {
  if (!existsSync(DB_PATH)) {
    throw new Error('Obelisk index is not initialized; run an index build (obelisk --build) before writing memories');
  }
  const db = new DatabaseSync(DB_PATH);
  // Kept short on purpose: lock waiting is owned by the retry layer in
  // executeAttune (ADR 0006 uses the same 250 ms for index-writer/CLI
  // connections), so each BEGIN fails fast and retries within that budget.
  db.exec('PRAGMA busy_timeout=250');
  const columns = new Set(
    db.prepare('PRAGMA table_info(memories)').all().map((row) => String(row.name)),
  );
  const columnsOk = ATTUNE_MEMORY_COLUMNS.length > 0
    && ATTUNE_MEMORY_COLUMNS.every((column) => columns.has(column));
  if (!columnsOk) {
    db.close();
    throw new Error('Obelisk index predates the memory layer; run an index build (obelisk --build) before writing memories');
  }
  return db;
}

// The FTS table and its maintenance triggers are the recall half of the
// memory layer: without them a write "succeeds" but can never be found.
// Names and SQL text prove nothing — a trigger's own name contains
// 'memories_fts', and a lookalike table can borrow the right DDL — so
// validate to executability instead. Must run inside a write transaction
// (executeAttune's retryable mutation wrapper): the probe writes and deletes
// one row, so a committed probe is net-zero and a failed probe rolls back.
function probeAttuneMemoryLayer(db: SqliteDb): void {
  try {
    db.prepare("INSERT INTO memories (id, path, summary, created_at) VALUES ('__attune_probe__', '/probe', 'attuneprobetoken marker', '1970-01-01T00:00:00Z')").run();
    const visible = db.prepare("SELECT id FROM memories_fts WHERE memories_fts MATCH 'attuneprobetoken'").get();
    db.prepare("DELETE FROM memories WHERE id='__attune_probe__'").run();
    const gone = db.prepare("SELECT id FROM memories_fts WHERE memories_fts MATCH 'attuneprobetoken'").get();
    if (!visible || gone) throw new Error('probe mismatch');
  } catch {
    // Lock errors cannot occur here: BEGIN IMMEDIATE already holds the write
    // lock before this probe runs, so any failure is a broken layer, not
    // contention. Report honestly and let the transaction roll back.
    throw new Error('Obelisk index predates the memory layer; run an index build (obelisk --build) before writing memories');
  }
}

function openWriterLeaseDb(lockPath: string): NodeSqliteDb {
  return new DatabaseSync(lockPath);
}

function rebuildMemoryFts(db: SqliteDb): void {
  db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
}


export { CLAUDE_DIR, CODEX_DIR, OBELISK_DIR, DB_PATH, TEXT_LIMIT, ATTUNE_MEMORY_COLUMNS, ATTUNE_MEMORY_TRIGGERS, openDb, openReadDb, openAttuneDb, probeAttuneMemoryLayer, openWriterLeaseDb, rebuildMemoryFts, trunc, truncJson, extractText, extractContentType, extractMessageIsMeta, filePath, isDir, readLines };
