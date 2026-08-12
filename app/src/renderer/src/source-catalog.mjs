// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

const FALLBACK_COLOR = '#8b8b93';

function sourceId(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized || 'claude';
}

function descriptorFor(source, catalog = []) {
  const id = sourceId(source);
  return catalog.find(candidate => candidate?.id === id) || null;
}

function titleCaseId(id) {
  return id
    .split(/[-_]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function sourceLabel(source, catalog = []) {
  const id = sourceId(source);
  return descriptorFor(id, catalog)?.name || titleCaseId(id);
}

export function sourceColor(source, catalog = []) {
  return descriptorFor(source, catalog)?.color || FALLBACK_COLOR;
}
