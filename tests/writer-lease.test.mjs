// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { acquireWriterLease } from '../packages/core/src/writer-lease.ts';
import { makeTempDir } from './temp-dirs.mjs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

test('a writer lease excludes another writer until it is released', () => {
  const lockPath = join(makeTempDir('obelisk-writer-lease-'), 'writer.lock.sqlite');
  const openDb = path => new DatabaseSync(path);

  const first = acquireWriterLease({ lockPath, openDb });
  assert.ok(first);
  assert.equal(acquireWriterLease({ lockPath, openDb }), null);

  first.release();
  const afterRelease = acquireWriterLease({ lockPath, openDb });
  assert.ok(afterRelease);
  afterRelease.release();
});
