// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import type { NodeSqliteDb, SqliteDb } from './sqlite-types.ts';
import { betterSqliteTransactionAdapter, nodeSqliteTransactionAdapter, runWriteTransaction } from './tx.ts';

const COLUMN_MIGRATIONS = [
  ['sessions', 'source', "TEXT DEFAULT 'claude'"],
  ['messages', 'content_type', 'TEXT'],
  ['messages', 'is_meta', 'INTEGER DEFAULT 0'],
  ['messages', 'visibility', "TEXT DEFAULT 'visible'"],
  ['messages', 'source', "TEXT DEFAULT 'claude'"],
  ['tool_calls', 'presentation', "TEXT DEFAULT 'default'"],
  ['workflows', 'parent_tool_use_id', 'TEXT'],
  ['index_state', 'cursor', 'TEXT'],
  ['index_state', 'replay_required', 'INTEGER NOT NULL DEFAULT 0'],
  ['summaries', 'visibility', "TEXT DEFAULT 'visible'"],
  ['summaries', 'input_tokens', 'INTEGER'],
  ['summaries', 'output_tokens', 'INTEGER'],
  ['memories', 'anchors', 'TEXT'],
  ['memories', 'deleted_at', 'TEXT'],
  ['memories', 'deleted_reason', 'TEXT'],
] as const;

const FTS_TABLES = ['messages_fts', 'memories_fts'] as const;

// FTS5 built-in tokenizers plus their word-only arguments. The configured value is
// interpolated into DDL, so the grammar is a whitelist: no quotes, no separators.
const TOKENIZER_PATTERN = /^(unicode61|ascii|porter|trigram)(?: [A-Za-z0-9_=]+)*$/;

function tableExists(db: SqliteDb, table: string): boolean {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

/**
 * Read the configured FTS5 tokenizer, or null to keep whatever `schema.sql` declares.
 * `trigram` makes CJK transcripts searchable (unicode61 indexes a run of CJK as one
 * token); it costs a larger index and cannot match queries shorter than 3 characters.
 */
export function resolveFtsTokenizer(env: Record<string, string | undefined> = process.env): string | null {
  const configured = String(env.OBELISK_FTS_TOKENIZER || '').trim();
  if (!configured) return null;
  if (!TOKENIZER_PATTERN.test(configured)) {
    throw new Error(`OBELISK_FTS_TOKENIZER must be an FTS5 tokenizer (unicode61|ascii|porter|trigram) with word arguments, got: ${configured}`);
  }
  return configured;
}

function currentTokenizer(createSql: string): string {
  const match = /tokenize\s*=\s*(['"])(.*?)\1/i.exec(createSql);
  // FTS5 defaults to unicode61 when the clause is absent.
  return match ? match[2].trim() : 'unicode61';
}

function withTokenizer(createSql: string, tokenizer: string): string {
  const clause = `tokenize='${tokenizer}'`;
  if (/tokenize\s*=\s*(['"])(.*?)\1/i.test(createSql)) {
    return createSql.replace(/tokenize\s*=\s*(['"])(.*?)\1/i, clause);
  }
  const close = createSql.lastIndexOf(')');
  return `${createSql.slice(0, close)}, ${clause}${createSql.slice(close)}`;
}

/**
 * Whether any FTS table still uses a tokenizer other than the configured one.
 * The build debounce consults this so a newly configured tokenizer takes effect on the
 * next command instead of waiting for the next unthrottled build.
 */
export function ftsTokenizerMigrationPending(db: SqliteDb, tokenizer: string | null): boolean {
  if (!tokenizer) return false;
  return FTS_TABLES.some(table => {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql?: string } | undefined;
    if (!row?.sql) return false;
    return currentTokenizer(row.sql) !== tokenizer;
  });
}

/**
 * Binding-agnostic FTS tokenizer migration shared by the CLI and desktop app.
 *
 * `schema.sql` is `CREATE VIRTUAL TABLE IF NOT EXISTS`, so an existing FTS table keeps
 * its original tokenizer forever; switching requires dropping and repopulating it. The
 * table definition is rewritten from `sqlite_master` rather than restated here, so
 * `schema.sql` stays the single source of truth for the columns.
 *
 * Validate SQLite's actual tokenizer grammar before dropping either index, then
 * replace and rebuild both in one transaction. A caller-owned transaction keeps
 * ownership of rollback; otherwise use the shared write transaction primitive.
 */
export function migrateFtsTokenizer(db: SqliteDb, tokenizer: string | null): void {
  if (!tokenizer) return;
  const configured = resolveFtsTokenizer({ OBELISK_FTS_TOKENIZER: tokenizer });
  if (!configured) return;
  const replacements: { table: string; sql: string }[] = [];
  for (const table of FTS_TABLES) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql?: string } | undefined;
    if (!row?.sql) continue;
    if (currentTokenizer(row.sql) === configured) continue;
    replacements.push({ table, sql: withTokenizer(row.sql, configured) });
  }
  if (replacements.length === 0) return;
  const state = db as SqliteDb & { readonly isTransaction?: boolean; readonly inTransaction?: boolean };
  const txDb = typeof state.isTransaction === 'boolean'
    ? nodeSqliteTransactionAdapter(db as NodeSqliteDb)
    : betterSqliteTransactionAdapter(db as SqliteDb & { readonly inTransaction: boolean });
  const migrate = () => {
    // The lexical allowlist prevents DDL injection; this probe also rejects
    // tokenizer arguments SQLite cannot execute, while both real indexes exist.
    db.exec(`CREATE VIRTUAL TABLE temp.obelisk_fts_tokenizer_probe USING fts5(text, tokenize='${configured}')`);
    db.exec('DROP TABLE temp.obelisk_fts_tokenizer_probe');
    for (const { table, sql } of replacements) {
      db.exec(`DROP TABLE ${table}`);
      db.exec(sql);
      db.exec(`INSERT INTO ${table}(${table}) VALUES('rebuild')`);
    }
  };
  if (txDb.inTransaction()) migrate();
  else runWriteTransaction(txDb, migrate, { label: 'fts-tokenizer-migration' });
}

export function coreSchemaNeedsMigration(db: SqliteDb): boolean {
  const columnsByTable = new Map<string, Set<string>>();
  for (const [table, column] of COLUMN_MIGRATIONS) {
    if (!tableExists(db, table)) return true;
    let columns = columnsByTable.get(table);
    if (!columns) {
      columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name)));
      columnsByTable.set(table, columns);
    }
    if (!columns.has(column)) return true;
  }
  return false;
}

/** Binding-agnostic additive migrations shared by the CLI and desktop app. */
export function migrateCoreSchemaColumns(db: SqliteDb): void {
  const columnsByTable = new Map<string, Set<string>>();
  for (const [table, column, definition] of COLUMN_MIGRATIONS) {
    if (!tableExists(db, table)) continue;
    let columns = columnsByTable.get(table);
    if (!columns) {
      columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name)));
      columnsByTable.set(table, columns);
    }
    if (columns.has(column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    columns.add(column);
  }
}
