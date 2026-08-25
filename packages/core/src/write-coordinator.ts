// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Core's bounded retry policy above the transaction primitive. Callers opt in only for
// idempotent work; an uncertain/live transaction is never retried. BEGIN contention is
// not retried by default — builds defer it to their scheduler — but idempotent callers
// without a scheduler (e.g. attune) may opt in via retryOnBeginBusy.

import { runWriteTransaction, type WriteTxDb, type WriteTxOptions } from './tx.ts';

interface TransactionDiagnostics {
  phase?: string;
  code?: string | null;
  transactionActive?: boolean | null;
  attempts?: number;
}

export interface WriteRetryOptions {
  maxAttempts?: number;
  budgetMs?: number;
  retryDelayMs?: number;
  // BEGIN-busy means the work never ran, so retrying it is safe for idempotent
  // work. It stays opt-in: index builds defer BEGIN contention to their
  // scheduler instead of retrying here (ADR 0006).
  retryOnBeginBusy?: boolean;
  now?: () => number;
  sleep?: (ms: number) => void;
}

function diagnostics(error: unknown): TransactionDiagnostics | null {
  if (!error || typeof error !== 'object') return null;
  return (error as { obelisk?: TransactionDiagnostics }).obelisk ?? null;
}

function isBusyCode(code: unknown): boolean {
  return typeof code === 'string' && code.startsWith('SQLITE_BUSY');
}

function syncSleep(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // Bounded attempts still prevent an infinite retry loop.
  }
}

export function isBeginBusyFailure(error: unknown): boolean {
  const info = diagnostics(error);
  return (
    info?.phase === 'begin' &&
    isBusyCode(info.code) &&
    info.transactionActive === false
  );
}

export function hasUnusableTransaction(error: unknown): boolean {
  const info = diagnostics(error);
  return Boolean(info && info.transactionActive !== false);
}

export function isRetryableWriteFailure(error: unknown): boolean {
  const info = diagnostics(error);
  return (
    (info?.phase === 'work' || info?.phase === 'commit') &&
    isBusyCode(info.code) &&
    info.transactionActive === false
  );
}

export function runWithWriteRetry<T>(operation: () => T, {
  maxAttempts = 3,
  budgetMs = 1000,
  retryDelayMs = 25,
  retryOnBeginBusy = false,
  now = Date.now,
  sleep = syncSleep,
}: WriteRetryOptions = {}): T {
  const startedAt = now();
  for (let attempt = 1; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      const info = diagnostics(error);
      if (info) info.attempts = attempt;
      const retryable = isRetryableWriteFailure(error)
        || (retryOnBeginBusy && isBeginBusyFailure(error));
      if (!retryable || attempt >= maxAttempts) throw error;
      const remaining = budgetMs - (now() - startedAt);
      if (remaining <= 0) throw error;
      sleep(Math.min(retryDelayMs * attempt, remaining));
    }
  }
}

export function runRetryableWriteTransaction<T>(
  db: WriteTxDb,
  work: () => T,
  transactionOptions: WriteTxOptions = {},
  retryOptions: WriteRetryOptions = {},
): T {
  return runWithWriteRetry(
    () => runWriteTransaction(db, work, transactionOptions),
    retryOptions,
  );
}
