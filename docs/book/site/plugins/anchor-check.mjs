// Build-time gate for interactive placement.
//
// Widgets are placed by quoting a real heading from the markdown:
//
//   const SLUG = '04-the-pivot';
//   const ANCHORS = [{ afterHeading: '两条正交轴', widget: OrthogonalAxes }];
//
// The chapters are the source of truth and can be re-edited freely, so a
// stale quote must not silently drop a widget on the floor. This plugin reads
// every `src/chapters/*.vue`, extracts the SLUG and the quoted headings, and
// fails the build when one of them no longer exists in that chapter.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadBook } from './book-markdown.mjs';

const SLUG_RX = /^const SLUG = '([^']+)';$/m;
const ANCHOR_RX = /afterHeading:\s*'([^']+)'/g;

export function checkAnchors(chaptersDir) {
  const book = new Map(loadBook().map((c) => [c.slug, c]));
  const problems = [];
  let checked = 0;

  for (const file of readdirSync(chaptersDir).filter((f) => f.endsWith('.vue'))) {
    const src = readFileSync(join(chaptersDir, file), 'utf8');
    const slug = SLUG_RX.exec(src)?.[1];
    if (!slug) {
      problems.push(`${file}: no \`const SLUG = '…'\` declaration`);
      continue;
    }
    const chapter = book.get(slug);
    if (!chapter) {
      problems.push(`${file}: SLUG '${slug}' matches no chapter in docs/book/`);
      continue;
    }
    // Only headings in the body are anchorable: the recap section is lifted out
    // into its own card, so a widget quoting a heading inside it would be
    // dropped at render time.
    const bodyBlocks = chapter.recapAt == null
      ? chapter.blocks
      : chapter.blocks.slice(0, chapter.recapAt);
    const headings = new Set(bodyBlocks.filter((b) => b.t === 'h').map((b) => b.text));

    for (const m of src.matchAll(ANCHOR_RX)) {
      checked++;
      if (!headings.has(m[1])) {
        const inRecap = chapter.headings.some((h) => h.text === m[1]);
        problems.push(
          inRecap
            ? `${file}: afterHeading '${m[1]}' is inside the recap section of ${chapter.file}, which renders separately — pick a heading from the body`
            : `${file}: afterHeading '${m[1]}' is not a body heading in ${chapter.file}\n`
              + `    available: ${[...headings].join(' · ')}`,
        );
      }
    }
  }

  return { problems, checked };
}

export default function anchorCheck(chaptersDir) {
  return {
    name: 'obelisk-book-anchor-check',
    buildStart() {
      const { problems, checked } = checkAnchors(chaptersDir);
      if (problems.length) {
        this.error(
          `[book] ${problems.length} interactive anchor(s) do not match any heading:\n  `
          + problems.join('\n  '),
        );
      }
      this.info?.(`[book] ${checked} interactive anchors resolved`);
    },
  };
}
