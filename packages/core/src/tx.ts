// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Binding-agnostic SQLite write plumbing shared from the Core package
// (docs/adr/0006). The injected db must expose `exec(sql)`; this works for both
// node:sqlite (CLI) and better-sqlite3 (app), same injection model as
// `persist`.

export interface WriteTxDb {
  exec(sql: string): unknown;
  inTransaction(): boolean;
}

export interface SqliteConnection {
  exec(sql: string): unknown;
}

type Phase = 'begin' | 'work' | 'commit' | 'rollback';

export interface WriteTxDiagnostics {
  phase: Phase;
  code: string | null;
  label?: string;
  rollbackSucceeded: boolean | null;
  rollbackError: string | null;
  transactionActive: boolean | null;
  attempts: number;
}

export interface WriteTxOptions {
  // Diagnostic label for this transaction (e.g. a file path or 'finalize').
  label?: string;
}

const BUSY_MESSAGE = /SQLITE_BUSY|database is locked|database is busy/i;

function busyCode(error: unknown): string | null {
  const raw = error as { code?: unknown; errcode?: unknown; message?: unknown } | null;
  const code = (raw?.code ?? raw?.errcode);
  if (typeof code === 'string' && code.startsWith('SQLITE_BUSY')) return code;
  if (typeof raw?.message === 'string' && BUSY_MESSAGE.test(raw.message)) return 'SQLITE_BUSY';
  return null;
}

function errorCode(error: unknown): string | null {
  const raw = error as { code?: unknown } | null;
  return typeof raw?.code === 'string' ? raw.code : null;
}

interface BetterSqliteHandle {
  exec(sql: string): unknown;
  readonly inTransaction: boolean;
}

interface NodeSqliteHandle {
  exec(sql: string): unknown;
  readonly isTransaction: boolean;
}

export function betterSqliteTransactionAdapter(db: BetterSqliteHandle): WriteTxDb {
  return {
    exec: sql => db.exec(sql),
    inTransaction: () => db.inTransaction,
  };
}

export function nodeSqliteTransactionAdapter(db: NodeSqliteHandle): WriteTxDb {
  return {
    exec: sql => db.exec(sql),
    inTransaction: () => db.isTransaction,
  };
}

function transactionState(db: WriteTxDb): boolean | null {
  try {
    return db.inTransaction();
  } catch {
    return null;
  }
}

function attachDiagnostics(error: unknown, diagnostics: WriteTxDiagnostics): void {
  if (!error || typeof error !== 'object') return;
  try {
    (error as { obelisk?: WriteTxDiagnostics }).obelisk = diagnostics;
  } catch {
    // Frozen/native errors must still be rethrown unchanged.
  }
}

// Runs `work` exactly once inside a transaction and returns its value. Retry and
// scheduling policy belongs to the build coordinator, which knows the operation's
// idempotency and total time budget. Cleanup never masks the primary exception.
export function runWriteTransaction<T>(db: WriteTxDb, work: () => T, options: WriteTxOptions = {}): T {
  const { label } = options;
  let phase: Phase = 'begin';
  try {
    db.exec('BEGIN IMMEDIATE');
    phase = 'work';
    const value = work();
    phase = 'commit';
    db.exec('COMMIT');
    return value;
  } catch (error) {
    let rollbackSucceeded: boolean | null = null;
    let rollbackError: string | null = null;
    const activeBeforeRollback = transactionState(db);
    if (activeBeforeRollback !== false) {
      try {
        db.exec('ROLLBACK');
        rollbackSucceeded = true;
      } catch (rollbackFailure) {
        rollbackSucceeded = false;
        rollbackError = rollbackFailure instanceof Error ? rollbackFailure.message : String(rollbackFailure);
      }
    }
    const busy = busyCode(error);
    const diagnostics: WriteTxDiagnostics = {
      phase,
      code: busy ?? errorCode(error),
      label,
      rollbackSucceeded,
      rollbackError,
      transactionActive: transactionState(db),
      attempts: 1,
    };
    attachDiagnostics(error, diagnostics);
    throw error;
  }
}

// Applies the connection-level pragmas used by every Obelisk writer/reader. Uses
// exec (not better-sqlite3's .pragma) so one implementation covers both bindings.
// busy_timeout is a real behavior change for node:sqlite (no default); it is set
// explicitly for better-sqlite3 too, whose own default already happens to be
// 5000ms. It is NOT the concurrency fix — see docs/adr/0006.
export function configureConnection(db: SqliteConnection, { busyTimeoutMs = 5000 } = {}): void {
  db.exec(`PRAGMA busy_timeout=${busyTimeoutMs}`);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA synchronous=NORMAL');
}
