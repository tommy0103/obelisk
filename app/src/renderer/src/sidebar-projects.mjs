// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

function countByProject(items) {
  const counts = {};
  for (const item of items) {
    if (item.project) counts[item.project] = (counts[item.project] || 0) + 1;
  }
  return counts;
}

function orderedProjectSlugs(projectCounts, projects, formatProjectLabel) {
  const seen = new Set();
  const ordered = [];

  for (const project of projects || []) {
    const slug = project?.project;
    if (!slug || !projectCounts[slug] || seen.has(slug)) continue;
    seen.add(slug);
    ordered.push(slug);
  }

  const missing = Object.keys(projectCounts)
    .filter(slug => !seen.has(slug))
    .sort((a, b) => formatProjectLabel(a).localeCompare(formatProjectLabel(b)));

  return ordered.concat(missing);
}

export function buildSidebarProjects({
  routeType,
  sessions = [],
  memories = [],
  projects = [],
  view = 'active',
  search = '',
  formatProjectLabel = slug => slug,
} = {}) {
  const items = routeType === 'sessions'
    ? sessions
    : memories.filter(memory => view === 'archived' ? memory.archived : !memory.archived);
  const counts = countByProject(items);
  const q = search.trim().toLowerCase();

  return orderedProjectSlugs(counts, projects, formatProjectLabel)
    .filter(slug => {
      if (!q) return true;
      return formatProjectLabel(slug).toLowerCase().includes(q);
    })
    .map(slug => ({
      slug,
      label: formatProjectLabel(slug),
      count: counts[slug] || 0,
    }));
}
