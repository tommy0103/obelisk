import type { SqliteDb } from './sqlite-types.ts';

const COLUMN_MIGRATIONS = [
  ['sessions', 'source', "TEXT DEFAULT 'claude'"],
  ['messages', 'content_type', 'TEXT'],
  ['messages', 'is_meta', 'INTEGER DEFAULT 0'],
  ['messages', 'visibility', "TEXT DEFAULT 'visible'"],
  ['messages', 'source', "TEXT DEFAULT 'claude'"],
  ['tool_calls', 'presentation', "TEXT DEFAULT 'default'"],
  ['workflows', 'parent_tool_use_id', 'TEXT'],
  ['index_state', 'cursor', 'TEXT'],
  ['summaries', 'visibility', "TEXT DEFAULT 'visible'"],
  ['summaries', 'input_tokens', 'INTEGER'],
  ['summaries', 'output_tokens', 'INTEGER'],
  ['memories', 'anchors', 'TEXT'],
  ['memories', 'deleted_at', 'TEXT'],
  ['memories', 'deleted_reason', 'TEXT'],
] as const;

function tableExists(db: SqliteDb, table: string): boolean {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
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
