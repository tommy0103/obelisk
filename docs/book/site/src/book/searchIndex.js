// Flat search index over the whole book, built once on first use.
//
// Everything the reader might type is in here: chapter titles, section
// headings, paragraph text, code, table cells, and the glossary. Each hit
// carries the nearest heading id so ⌘K can land you at the right place in a
// 500-line chapter rather than at its top.

import { CHAPTERS } from './index.js';
import { GLOSSARY } from './glossary.js';

const spanText = (spans) => spans.map((s) => (s.c ? spanText(s.c) : s.v || '')).join('');

function walk(blocks, push, anchor) {
  let at = anchor;
  for (const b of blocks) {
    switch (b.t) {
      case 'h':
        at = b.id;
        push('heading', b.text, at, 3);
        break;
      case 'p':
        push('text', spanText(b.c), at, 1);
        break;
      case 'list':
        for (const item of b.items) push('text', spanText(item), at, 1);
        break;
      case 'code':
        push('code', b.raw, at, 0.6);
        break;
      case 'table':
        for (const row of b.rows) push('text', row.map(spanText).join(' · '), at, 1);
        break;
      case 'quote':
      case 'note':
        at = walk(b.c, push, at);
        break;
      default:
        break;
    }
  }
  return at;
}

let cache = null;

export function searchIndex() {
  if (cache) return cache;
  const entries = [];

  for (const chapter of CHAPTERS) {
    entries.push({
      kind: 'chapter',
      label: chapter.title,
      detail: chapter.hook,
      slug: chapter.slug,
      anchor: null,
      weight: 6,
      hay: `${chapter.title} ${chapter.hook}`.toLowerCase(),
    });

    walk(chapter.blocks, (kind, text, anchor, weight) => {
      const trimmed = text.trim();
      if (trimmed.length < 4) return;
      entries.push({
        kind,
        label: trimmed.length > 150 ? `${trimmed.slice(0, 150)}…` : trimmed,
        detail: chapter.shortTitle,
        slug: chapter.slug,
        anchor,
        weight,
        hay: trimmed.toLowerCase(),
      });
    }, null);
  }

  for (const g of GLOSSARY) {
    entries.push({
      kind: 'term',
      label: g.term,
      detail: g.short,
      slug: g.chapter,
      anchor: null,
      weight: 5,
      hay: `${g.term} ${g.match.join(' ')} ${g.short} ${g.def}`.toLowerCase(),
    });
  }

  cache = entries;
  return entries;
}

export function runSearch(query, limit = 40) {
  const q = query.trim().toLowerCase();
  if (q.length < 1) return [];
  // Every whitespace-separated term must appear; ranking favours titles,
  // headings and terms over body text, then earlier matches.
  const terms = q.split(/\s+/).filter(Boolean);
  const scored = [];
  for (const e of searchIndex()) {
    let score = 0;
    let ok = true;
    for (const t of terms) {
      const at = e.hay.indexOf(t);
      if (at === -1) {
        ok = false;
        break;
      }
      score += e.weight * (at === 0 ? 2 : 1) + Math.max(0, 30 - at) / 30;
    }
    if (ok) scored.push({ ...e, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
