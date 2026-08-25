// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Cross-process single-writer lease shared by every Obelisk mutation. The
// lock lives in a dedicated SQLite database so node:sqlite and better-sqlite3
// share identical locking semantics on every supported platform.

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface WriterLeaseDb {
  exec(sql: string): unknown;
  close(): void;
}

export interface WriterLease {
  release(): void;
}

export interface AcquireWriterLeaseOptions {
  lockPath: string;
  openDb: (path: string) => WriterLeaseDb;
  waitMs?: number;
  retryDelayMs?: number;
  now?: () => number;
  sleep?: (ms: number) => void;
}

const BUSY_MESSAGE = /SQLITE_BUSY|database is locked|database is busy/i;

function isBusy(error: unknown): boolean {
  const raw = error as { code?: unknown; errcode?: unknown; message?: unknown } | null;
  const code = raw?.code ?? raw?.errcode;
  return (
    (typeof code === 'string' && code.startsWith('SQLITE_BUSY')) ||
    (typeof raw?.message === 'string' && BUSY_MESSAGE.test(raw.message))
  );
}

function syncSleep(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // If synchronous sleeping is unavailable, the bounded attempt count below
    // still prevents an infinite acquisition loop.
  }
}

export function writerLockPathFor(dbPath: string): string {
  return join(dirname(dbPath), 'writer.lock.sqlite');
}

export function acquireWriterLease({
  lockPath,
  openDb,
  waitMs = 0,
  retryDelayMs = 25,
  now = Date.now,
  sleep = syncSleep,
}: AcquireWriterLeaseOptions): WriterLease | null {
  mkdirSync(dirname(lockPath), { recursive: true });
  const startedAt = now();
  const maxAttempts = waitMs > 0 ? Math.ceil(waitMs / Math.max(1, retryDelayMs)) + 1 : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const db = openDb(lockPath);
    try {
      db.exec('PRAGMA busy_timeout=0');
      db.exec('BEGIN IMMEDIATE');
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          try {
            db.exec('ROLLBACK');
          } catch {
            // Closing the connection releases any remaining SQLite lock.
          } finally {
            db.close();
          }
        },
      };
    } catch (error) {
      db.close();
      if (!isBusy(error)) throw error;
      const remaining = waitMs - (now() - startedAt);
      if (remaining <= 0 || attempt + 1 >= maxAttempts) return null;
      sleep(Math.min(retryDelayMs, remaining));
    }
  }
  return null;
}
