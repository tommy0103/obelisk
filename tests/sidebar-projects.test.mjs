// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSidebarProjects } from '../app/src/renderer/src/sidebar-projects.mjs';

test('session sidebar projects follow database recency order instead of label order', () => {
  const sessions = [
    { project: '-Users-dev-Code-sample-cli-' },
    { project: '-Users-dev-Code-quiet-zero' },
    { project: '-Users-dev-Code-quiet-zero' },
    { project: '-Users-dev-Library-Application-Support-Example-App-namespaces-release-stable-data-projects-00000000-1111-2222-3333-444444444444', session_count: 1 },
  ];
  const projects = [
    { project: '-Users-dev-Code-quiet-zero', session_count: 2 },
    { project: '-Users-dev-Code-sample-cli-', session_count: 1 },
    { project: '-Users-dev-Library-Application-Support-Example-App-namespaces-release-stable-data-projects-00000000-1111-2222-3333-444444444444', session_count: 1 },
  ];
  const labels = {
    '-Users-dev-Code-sample-cli-': 'sample-cli+',
    '-Users-dev-Code-quiet-zero': 'quiet-zero',
    '-Users-dev-Library-Application-Support-Example-App-namespaces-release-stable-data-projects-00000000-1111-2222-3333-444444444444': '00000000-1111-2...',
  };

  const result = buildSidebarProjects({
    routeType: 'sessions',
    sessions,
    projects,
    formatProjectLabel: slug => labels[slug] || slug,
  });

  assert.deepEqual(result.map(project => project.label), [
    'quiet-zero',
    'sample-cli+',
    '00000000-1111-2...',
  ]);
  assert.equal(result[0].count, 2);
});

test('memory sidebar projects filter by archive state and label search', () => {
  const result = buildSidebarProjects({
    routeType: 'memory',
    view: 'active',
    search: 'quiet',
    memories: [
      { project: 'quiet-zero', archived: false },
      { project: 'quiet-zero', archived: true },
      { project: 'sample-lib', archived: false },
    ],
    projects: [
      { project: 'sample-lib' },
      { project: 'quiet-zero' },
    ],
    formatProjectLabel: slug => slug,
  });

  assert.deepEqual(result, [{ slug: 'quiet-zero', label: 'quiet-zero', count: 1 }]);
});

test('session project counts include older-only projects without loaded sessions', () => {
  const result = buildSidebarProjects({ routeType: 'sessions', sessions: [], projects: [
    { project: 'older-only', session_count: 55 }, { project: 'current', session_count: 1050 },
  ] });
  assert.deepEqual(result.map(p => [p.slug, p.count]), [['older-only', 55], ['current', 1050]]);
});
