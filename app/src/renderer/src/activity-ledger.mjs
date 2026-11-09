// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { sourceLabel } from './source-catalog.mjs';

export function activitySourceKey(session) {
  const source = typeof session?.source === 'string' ? session.source.trim().toLowerCase() : '';
  return source || 'claude';
}

export function activitySourceLabel(session, sourceCatalog = []) {
  return sourceLabel(activitySourceKey(session), sourceCatalog);
}

export function activityGroupSessions(split) {
  return [...(split?.normal || []), ...(split?.noise || [])];
}

export function activityGroupHasMixedSources(split) {
  return new Set(activityGroupSessions(split).map(activitySourceKey)).size > 1;
}

export function activitySessionMetaParts(session, {
  mixedSources = false,
  projectLabel = '',
  includeProject = true,
  sourceCatalog = [],
} = {}) {
  const parts = [];
  if (mixedSources) parts.push({ kind: 'source', text: activitySourceLabel(session, sourceCatalog) });
  if (includeProject && projectLabel) parts.push({ kind: 'project', text: projectLabel });
  parts.push({
    kind: 'count',
    text: `${Number(session?.message_count || 0).toLocaleString('en-US')} msg`,
  });
  return parts;
}
