// The book, assembled: markdown blocks (build-time) + site metadata + the
// per-chapter Vue component that owns its interactives.

import { chapters as rawChapters, parts } from 'virtual:book';

import { chapterMeta } from './manifest.js';

// One SFC per chapter, filename === slug. A missing file is a hard error rather
// than a silently blank page.
const chapterModules = import.meta.glob('../chapters/*.vue');

const componentFor = (slug) => {
  const key = `../chapters/${slug}.vue`;
  const loader = chapterModules[key];
  if (!loader) throw new Error(`[book] no chapter component at src/chapters/${slug}.vue`);
  return loader;
};

export const CHAPTERS = rawChapters.map((c) => {
  const meta = chapterMeta(c.slug);
  return {
    ...c,
    covers: meta.covers,
    hook: meta.hook,
    quiz: meta.quiz,
    load: componentFor(c.slug),
  };
});

export const PARTS = parts;

export const BY_SLUG = Object.fromEntries(CHAPTERS.map((c) => [c.slug, c]));

export const chapterAt = (slug) => BY_SLUG[slug] || null;

export const neighbours = (slug) => {
  const i = CHAPTERS.findIndex((c) => c.slug === slug);
  return {
    prev: i > 0 ? CHAPTERS[i - 1] : null,
    next: i >= 0 && i < CHAPTERS.length - 1 ? CHAPTERS[i + 1] : null,
  };
};

// Grouped for the rail: front matter, three parts, back matter.
export const SECTIONS = (() => {
  const out = [];
  let current = null;
  for (const c of CHAPTERS) {
    const key = c.part ?? c.kind;
    if (!current || current.key !== key) {
      current = {
        key,
        label: c.part ? PARTS[c.part].label : c.kind === 'front' ? '开篇' : '附录',
        hint: c.part ? PARTS[c.part].hint : '',
        chapters: [],
      };
      out.push(current);
    }
    current.chapters.push(c);
  }
  return out;
})();

export const TOTAL_MINUTES = CHAPTERS.reduce((n, c) => n + c.minutes, 0);
export const TOTAL_NOTES = CHAPTERS.reduce((n, c) => n + c.notes, 0);
