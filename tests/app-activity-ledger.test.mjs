// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  activityGroupHasMixedSources,
  activitySessionMetaParts,
  activitySourceLabel,
} from '../app/src/renderer/src/activity-ledger.mjs';

const claudeSession = {
  source: 'claude',
  project: '-Users-tomiya-Code-quiet-zero',
  message_count: 2716,
};
const codexSession = {
  source: 'codex',
  project: '-Users-tomiya-Code-quiet-zero',
  message_count: 2052,
};
const sourceCatalog = [
  { id: 'claude', name: 'Claude Code', color: '#d97757' },
  { id: 'codex', name: 'Codex', color: '#10a37f' },
];

test('single-source activity groups omit provider provenance', () => {
  const split = { normal: [codexSession], noise: [{ ...codexSession, message_count: 12 }] };

  assert.equal(activityGroupHasMixedSources(split), false);
  assert.deepEqual(
    activitySessionMetaParts(codexSession, {
      mixedSources: false,
      projectLabel: 'quiet-zero',
    }),
    [
      { kind: 'project', text: 'quiet-zero' },
      { kind: 'count', text: '2,052 msg' },
    ],
  );
});

test('mixed activity groups expose provider before project and count', () => {
  const split = { normal: [codexSession], noise: [claudeSession] };

  assert.equal(activityGroupHasMixedSources(split), true);
  assert.deepEqual(
    activitySessionMetaParts(claudeSession, {
      mixedSources: true,
      projectLabel: 'quiet-zero',
      sourceCatalog,
    }),
    [
      { kind: 'source', text: 'Claude Code' },
      { kind: 'project', text: 'quiet-zero' },
      { kind: 'count', text: '2,716 msg' },
    ],
  );
});

test('workspace activity omits redundant project scope', () => {
  assert.deepEqual(
    activitySessionMetaParts(codexSession, {
      mixedSources: false,
      projectLabel: 'quiet-zero',
      includeProject: false,
    }),
    [{ kind: 'count', text: '2,052 msg' }],
  );
});

test('unknown providers retain their own provenance label', () => {
  assert.equal(activitySourceLabel({ source: 'opencode' }), 'Opencode');
});
