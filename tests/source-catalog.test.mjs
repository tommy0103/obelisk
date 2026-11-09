// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sourceColor, sourceLabel } from '../app/src/renderer/src/source-catalog.mjs';

const catalog = [
  { id: 'alpha', name: 'Alpha Agent', color: '#112233' },
  { id: 'beta', name: 'Beta Code', color: '#445566' },
];

test('renderer source presentation comes from the runtime provider catalog', () => {
  assert.equal(sourceLabel('beta', catalog), 'Beta Code');
  assert.equal(sourceColor('alpha', catalog), '#112233');
  assert.equal(sourceLabel('future-provider', catalog), 'Future Provider');
  assert.equal(sourceColor('future-provider', catalog), '#8b8b93');
});
