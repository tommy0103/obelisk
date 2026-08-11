import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { nodeSqliteTransactionAdapter, runWriteTransaction } from '../packages/core/src/tx.ts';
import { hasUnusableTransaction, isBeginBusyFailure, isRetryableWriteFailure } from '../packages/core/src/write-coordinator.ts';
import { makeTempDir } from './temp-dirs.mjs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

test('a failed rollback with an active transaction never retries or masks the primary error', () => {
  const primary = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
  let active = false;
  let workCalls = 0;

  const db = {
    exec(sql) {
      if (sql.startsWith('BEGIN')) {
        if (active) throw new Error('cannot start a transaction within a transaction');
        active = true;
      } else if (sql === 'ROLLBACK') {
        throw new Error('rollback failed with I/O error');
      } else if (sql === 'COMMIT') {
        active = false;
      }
    },
    inTransaction() {
      return active;
    },
  };

  assert.throws(
    () => runWriteTransaction(db, () => {
      workCalls += 1;
      throw primary;
    }),
    error => error === primary,
  );
  assert.equal(workCalls, 1);
  assert.equal(active, true);
});

test('an automatic rollback rethrows the primary error without issuing another rollback', () => {
  const primary = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
  let active = false;
  let rollbackCalls = 0;
  const db = {
    exec(sql) {
      if (sql.startsWith('BEGIN')) active = true;
      if (sql === 'ROLLBACK') rollbackCalls += 1;
    },
    inTransaction() {
      return active;
    },
  };

  assert.throws(
    () => runWriteTransaction(db, () => {
      active = false;
      throw primary;
    }),
    error => error === primary,
  );
  assert.equal(rollbackCalls, 0);
  assert.equal(primary.obelisk.transactionActive, false);
});

test('an active transaction is rolled back once before the primary error is rethrown', () => {
  const primary = new Error('persist failed');
  let active = false;
  let rollbackCalls = 0;
  const db = {
    exec(sql) {
      if (sql.startsWith('BEGIN')) active = true;
      if (sql === 'ROLLBACK') {
        rollbackCalls += 1;
        active = false;
      }
    },
    inTransaction() {
      return active;
    },
  };

  assert.throws(() => runWriteTransaction(db, () => { throw primary; }), error => error === primary);
  assert.equal(rollbackCalls, 1);
  assert.equal(primary.obelisk.rollbackSucceeded, true);
  assert.equal(primary.obelisk.transactionActive, false);
});

test('an unknown post-error transaction state is unsafe for the next file', () => {
  const primary = new Error('transaction state unavailable');
  const db = {
    exec() {},
    inTransaction() {
      throw new Error('binding cannot report transaction state');
    },
  };

  assert.throws(() => runWriteTransaction(db, () => { throw primary; }), error => error === primary);
  assert.equal(primary.obelisk.transactionActive, null);
  assert.equal(hasUnusableTransaction(primary), true);
});

test('node:sqlite generic error codes preserve BUSY classification from the message', () => {
  const primary = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' });
  let active = false;
  const db = {
    exec(sql) {
      if (sql === 'BEGIN IMMEDIATE') active = true;
    },
    inTransaction() { return active; },
  };

  assert.throws(() => runWriteTransaction(db, () => {
    active = false;
    throw primary;
  }), error => error === primary);
  assert.equal(primary.obelisk.code, 'SQLITE_BUSY');
  assert.equal(isRetryableWriteFailure(primary), true);
});

test('a real node:sqlite BEGIN lock is classified as a deferrable BUSY', () => {
  const dbPath = join(makeTempDir('obelisk-node-sqlite-busy-'), 'index.sqlite');
  const holder = new DatabaseSync(dbPath);
  const contender = new DatabaseSync(dbPath);
  holder.exec('PRAGMA busy_timeout=0; CREATE TABLE test (value TEXT); BEGIN IMMEDIATE');
  contender.exec('PRAGMA busy_timeout=0');

  try {
    assert.throws(
      () => runWriteTransaction(nodeSqliteTransactionAdapter(contender), () => {}),
      error => isBeginBusyFailure(error) && error.obelisk.code === 'SQLITE_BUSY',
    );
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
    contender.close();
  }
});

test('a BEGIN failure with an active transaction is not deferrable', () => {
  const primary = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
  let rollbackCalls = 0;
  const db = {
    exec(sql) {
      if (sql === 'BEGIN IMMEDIATE') throw primary;
      if (sql === 'ROLLBACK') {
        rollbackCalls += 1;
        throw new Error('rollback failed with I/O error');
      }
    },
    inTransaction() {
      return true;
    },
  };

  assert.throws(() => runWriteTransaction(db, () => {}), error => error === primary);
  assert.equal(rollbackCalls, 1);
  assert.equal(primary.obelisk.transactionActive, true);
  assert.equal(hasUnusableTransaction(primary), true);
  assert.equal(isBeginBusyFailure(primary), false);
});
