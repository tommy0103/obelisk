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
  /** better-sqlite3 only: true when the statement has no write effects. */
  readonly readonly?: boolean;
  /**
   * node:sqlite only: the compiled statement text. Trailing text SQLite did
   * not compile (a second statement) is excluded, which makes multi-statement
   * detection possible.
   */
  readonly sourceSQL?: string;
}

// Signature shared with node:sqlite's DatabaseSync.setAuthorizer callback.
export type SqliteAuthorizer = (
  action: number,
  p1: string | null,
  p2: string | null,
  dbName: string | null,
  triggerOrView: string | null,
) => number;

export interface SqliteDb {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
  close(): void;
  /** node:sqlite only; better-sqlite3 does not expose an authorizer. */
  setAuthorizer?(callback: SqliteAuthorizer): void;
}

export interface NodeSqliteDb extends SqliteDb {
  readonly isTransaction: boolean;
}
