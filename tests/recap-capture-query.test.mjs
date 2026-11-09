// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
import { buildRecapExportQuery, cleanRecapFilename } from '../app/src/main/recap-capture-query.ts';

test('recap export query includes the selected recap filename', () => {
  const query = buildRecapExportQuery({
    cardIdx: 3,
    archetype: 'shipper',
    filename: 'recap-2026-06.json',
  });

  assert.equal(query, 'card=3&arch=shipper&file=recap-2026-06.json');
});

test('recap export query strips paths before passing filename to renderer', () => {
  assert.equal(cleanRecapFilename('/tmp/recap-2026-W24.json'), 'recap-2026-W24.json');
  assert.equal(
    buildRecapExportQuery({
      cardIdx: '2',
      archetype: 'architect',
      filename: '/Users/dev/.obelisk/recap/recap-2026-W24.json',
    }),
    'card=2&arch=architect&file=recap-2026-W24.json',
  );
});
