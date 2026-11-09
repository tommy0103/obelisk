// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSessionDisclosureState } from '../app/src/renderer/src/session-disclosures.mjs';

test('disclosure state survives virtual row unmounts without depending on DOM nodes', () => {
  const disclosures = createSessionDisclosureState();

  disclosures.toggleOpen('tool:call-1', 'message-1');
  disclosures.toggleRaw('tool:call-1', 'message-1');

  assert.equal(disclosures.isOpen('tool:call-1'), true);
  assert.equal(disclosures.isRaw('tool:call-1'), true);

  disclosures.toggleRaw('tool:call-1', 'message-1');
  disclosures.toggleOpen('tool:call-1', 'message-1');

  assert.equal(disclosures.isOpen('tool:call-1'), false);
  assert.equal(disclosures.isRaw('tool:call-1'), false);
});

test('disclosure state forgets entries owned by removed messages', () => {
  const disclosures = createSessionDisclosureState();
  disclosures.toggleOpen('tool:call-1', 'message-1');
  disclosures.toggleOpen('tool:call-2', 'message-2');

  disclosures.retainMessages(new Set(['message-2']));

  assert.equal(disclosures.isOpen('tool:call-1'), false);
  assert.equal(disclosures.isOpen('tool:call-2'), true);
});

test('disclosure state restores a serializable snapshot for retained messages', () => {
  const source = createSessionDisclosureState();
  source.toggleOpen('tool:call-1', 'message-1');
  source.toggleRaw('tool:call-1', 'message-1');
  source.toggleOpen('tool:call-2', 'message-2');

  const restored = createSessionDisclosureState();
  restored.restore(source.snapshot(), new Set(['message-1']));

  assert.equal(restored.isOpen('tool:call-1'), true);
  assert.equal(restored.isRaw('tool:call-1'), true);
  assert.equal(restored.isOpen('tool:call-2'), false);
  assert.deepEqual(restored.snapshot(), [
    { key: 'tool:call-1', messageUuid: 'message-1', open: true, raw: true },
  ]);
});
