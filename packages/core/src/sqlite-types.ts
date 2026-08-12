// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Minimal structural types shared by node:sqlite and better-sqlite3 consumers.
// SQLite rows and bindings are dynamic at this boundary; domain records become
// strongly typed after parsing, in providers/types.ts.

export type SqliteRow = Record<string, any>;

export interface SqliteStatement {
  all(...bindings: any[]): SqliteRow[];
  get(...bindings: any[]): SqliteRow | undefined;
  run(...bindings: any[]): unknown;
}

export interface SqliteDb {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface NodeSqliteDb extends SqliteDb {
  readonly isTransaction: boolean;
}
