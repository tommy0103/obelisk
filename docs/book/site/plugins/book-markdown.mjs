// Build-time Markdown → block tree, exposed as the virtual module `virtual:book`.
//
// The 17 chapters in docs/book/*.md are the single source of truth for prose and
// they are never modified by this site — they also have to stay readable on
// GitHub. So parsing happens here, at build time, and the browser only ever sees
// a structured tree. No Markdown parser ships to the client.
//
// This is deliberately not a general Markdown implementation. It covers exactly
// the subset the book uses, verified against the sources:
//   headings h1-h3 · fenced code · flat lists · blockquotes (one nesting level) ·
//   pipe tables · hr · inline **bold** `code` [link](x.md)
// Anything outside that subset is emitted as escaped text rather than silently
// mangled, which is the right failure mode for a book about a codebase.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOK_DIR = resolve(HERE, '..', '..');

const VIRTUAL_ID = 'virtual:book';
const RESOLVED_ID = '\0virtual:book';

// Where `file:line` chips point. Chapters cite real repository locations.
const REPO_BLOB = 'https://github.com/tommy0103/obelisk/blob/main/';

// ---------------------------------------------------------------- chapter ids

// Route slug + part, keyed by markdown basename. Anything not listed here is a
// build error: a new chapter must be given a home explicitly.
const CHAPTER_INDEX = [
  { file: 'README.md', slug: 'intro', part: null, kind: 'front' },
  { file: '01-what-it-is.md', slug: '01-what-it-is', part: 'whole', kind: 'chapter' },
  { file: '02-module-map.md', slug: '02-module-map', part: 'whole', kind: 'chapter' },
  { file: '03-three-paths.md', slug: '03-three-paths', part: 'whole', kind: 'chapter' },
  { file: '04-the-pivot.md', slug: '04-the-pivot', part: 'whole', kind: 'chapter' },
  { file: '05-data-layer.md', slug: '05-data-layer', part: 'parts', kind: 'chapter' },
  { file: '06-provider-contract.md', slug: '06-provider-contract', part: 'parts', kind: 'chapter' },
  { file: '07-three-adapters.md', slug: '07-three-adapters', part: 'parts', kind: 'chapter' },
  { file: '08-persist.md', slug: '08-persist', part: 'parts', kind: 'chapter' },
  { file: '09-orchestration.md', slug: '09-orchestration', part: 'parts', kind: 'chapter' },
  { file: '10-codeact-runtime.md', slug: '10-codeact-runtime', part: 'parts', kind: 'chapter' },
  { file: '11-memory-layer.md', slug: '11-memory-layer', part: 'parts', kind: 'chapter' },
  { file: '12-presentation.md', slug: '12-presentation', part: 'parts', kind: 'chapter' },
  { file: '13-concurrency.md', slug: '13-concurrency', part: 'cross', kind: 'chapter' },
  { file: '14-incremental-replay.md', slug: '14-incremental-replay', part: 'cross', kind: 'chapter' },
  { file: '15-extension-and-limits.md', slug: '15-extension-and-limits', part: 'cross', kind: 'chapter' },
  { file: 'appendix-a-hands-on.md', slug: 'appendix-a', part: null, kind: 'back' },
];

export const PARTS = {
  whole: { label: '第一部分 · 整体', hint: '读完这四章，你应该能凭记忆把这个系统画出来。' },
  parts: { label: '第二部分 · 局部', hint: '逐个部件展开，顺序是依赖顺序。' },
  cross: { label: '第三部分 · 横切', hint: '不属于任何单一部件的问题。' },
};

// ---------------------------------------------------------------- highlight

const KEYWORDS = {
  ts: /\b(?:import|export|from|type|interface|const|let|function|return|if|else|for|while|switch|case|break|continue|throw|try|catch|finally|new|await|async|class|extends|implements|readonly|null|undefined|true|false|void|typeof|in|of|as|default|yield)\b/,
  sql: /\b(?:SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|VIRTUAL|TRIGGER|INDEX|IF|NOT|EXISTS|PRIMARY|KEY|TEXT|INTEGER|REAL|DEFAULT|ON|CONFLICT|DO|NOTHING|REPLACE|ORDER|BY|GROUP|LIMIT|JOIN|LEFT|INNER|AND|OR|AS|NULL|IS|LIKE|ESCAPE|MATCH|COALESCE|COUNT|MAX|MIN|SUBSTR|BEGIN|END|USING|WITH|DESC|ASC|PRAGMA|ATTACH|DATABASE|EXCLUDED|IMMEDIATE|COMMIT|ROLLBACK)\b/i,
  bash: /\b(?:cat|cd|echo|export|npm|npx|node|git|obelisk|curl|grep|rm|mkdir|ls|EOF)\b/,
};
KEYWORDS.js = KEYWORDS.ts;
KEYWORDS.mjs = KEYWORDS.ts;

// Conservative single-pass tokenizer: only comments, strings and a small keyword
// set are coloured. `text` fences hold ASCII diagrams and are never touched.
function tokenize(code, lang) {
  if (!lang || lang === 'text' || lang === 'json') return [{ v: code }];
  const kw = KEYWORDS[lang];
  const rx = new RegExp(
    [
      '(\\/\\/[^\\n]*)', // line comment
      '(--[^\\n]*)', // sql comment
      '(#[^\\n]*)', // shell comment
      '(\\/\\*[\\s\\S]*?\\*\\/)', // block comment
      "('(?:[^'\\\\\\n]|\\\\.)*')",
      '("(?:[^"\\\\\\n]|\\\\.)*")',
      '(`(?:[^`\\\\]|\\\\.)*`)',
      kw ? `(${kw.source})` : '(\\u0000)',
    ].join('|'),
    kw?.flags?.includes('i') ? 'gi' : 'g',
  );
  const out = [];
  let last = 0;
  for (const m of code.matchAll(rx)) {
    if (m.index > last) out.push({ v: code.slice(last, m.index) });
    const [full, lineC, sqlC, shC, blockC, s1, s2, s3] = m;
    const isComment = lineC || sqlC || shC || blockC;
    // A `#` in a non-shell language is nearly always a real character inside a
    // string or a private field, not a comment.
    if (isComment && shC && lang !== 'bash') out.push({ v: full });
    else if (isComment) out.push({ t: 'c', v: full });
    else if (s1 || s2 || s3) out.push({ t: 's', v: full });
    else out.push({ t: 'k', v: full });
    last = m.index + full.length;
  }
  if (last < code.length) out.push({ v: code.slice(last) });
  return out;
}

// ---------------------------------------------------------------- numerals

// The book numbers its steps with ①②③. They read badly on screen: U+2460 is
// East Asian Ambiguous width, so it renders at one cell in a Latin context and
// two in a CJK one — tiny and misaligned, depending on the font that answers
// for it. The markdown keeps them (it has to stay readable on GitHub); the site
// converts them at build time.
//
// Two different substitutions, because the constraints differ:
//   diagrams — `1.`, which is exactly two cells in any monospace font, so the
//              hand-aligned columns keep lining up
//   prose    — a real digit in a CSS-drawn ring, which stays a "step N"
//              reference without depending on an exotic glyph
const circledValue = (ch) => {
  const code = ch.codePointAt(0);
  return code >= 0x2460 && code <= 0x2473 ? code - 0x245f : null;
};
const CIRCLED_RX = /[①-⑳]/g;

const deCircleDiagram = (text) =>
  text.replace(/[①-⑳]+/g, (run) => {
    const digits = [...run].map(circledValue);
    // 10+ would widen the line and break hand-aligned columns; leave those.
    if (digits.some((n) => n === null || n > 9)) return run;
    // A run like ①② is prose inside the diagram ("the window between 1 and 2"),
    // not a list marker — `1.2.` there reads as garbage. Only a lone numeral,
    // which is what labels a step, takes the trailing dot.
    return digits.length === 1 ? `${digits[0]}.` : digits.join('');
  });

// ---------------------------------------------------------------- inline

// `packages/core/src/query.ts:120` and friends become clickable source chips.
const REF_RX = /^([\w.-]+(?:\/[\w.-]+)+\.(?:ts|tsx|js|mjs|cjs|sql|json|md|sh|yml))(?::(\d+(?:-\d+)?))?$/;

function parseInline(text) {
  const out = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ k: 't', v: buf });
    buf = '';
  };
  let i = 0;
  while (i < text.length) {
    // `code` first, so its contents are never re-parsed
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i) {
        flush();
        const body = text.slice(i + 1, end);
        const ref = REF_RX.exec(body);
        if (ref) {
          out.push({
            k: 'ref',
            v: body,
            href: REPO_BLOB + ref[1] + (ref[2] ? `#L${ref[2].replace('-', '-L')}` : ''),
          });
        } else {
          out.push({ k: 'c', v: body });
        }
        i = end + 1;
        continue;
      }
    }
    if (text.startsWith('**', i)) {
      const end = text.indexOf('**', i + 2);
      if (end > i) {
        flush();
        out.push({ k: 'b', c: parseInline(text.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (text[i] === '[') {
      const close = text.indexOf('](', i);
      if (close > i) {
        const end = text.indexOf(')', close);
        if (end > close) {
          flush();
          out.push({
            k: 'a',
            href: linkTarget(text.slice(close + 2, end)),
            c: parseInline(text.slice(i + 1, close)),
          });
          i = end + 1;
          continue;
        }
      }
    }
    buf += text[i];
    i++;
  }
  flush();
  return out;
}

const inline = (text) => splitSteps(parseInline(text));

// Split a text span so each circled numeral becomes its own {k:'step'} span,
// which the renderer draws as a digit in a ring.
function splitSteps(spans) {
  const out = [];
  for (const span of spans) {
    if (span.k === 'b' || span.k === 'a') {
      out.push({ ...span, c: splitSteps(span.c) });
      continue;
    }
    if (span.k !== 't' || !CIRCLED_RX.test(span.v)) {
      out.push(span);
      continue;
    }
    CIRCLED_RX.lastIndex = 0;
    let last = 0;
    for (const m of span.v.matchAll(CIRCLED_RX)) {
      const n = circledValue(m[0]);
      if (n === null) continue;
      if (m.index > last) out.push({ k: 't', v: span.v.slice(last, m.index) });
      out.push({ k: 'step', v: String(n) });
      last = m.index + m[0].length;
    }
    if (last < span.v.length) out.push({ k: 't', v: span.v.slice(last) });
  }
  return out;
}

// Cross-chapter links in the markdown point at sibling .md files; on the site
// they become in-app routes.
function linkTarget(href) {
  const m = /^([0-9a-zA-Z-]+)\.md(#.*)?$/.exec(href);
  if (!m) return href;
  const entry = CHAPTER_INDEX.find((c) => c.file === `${m[1]}.md`);
  return entry ? `/ch/${entry.slug}${m[2] || ''}` : href;
}

const plainText = (spans) => spans.map((s) => (s.c ? plainText(s.c) : s.v || '')).join('');

// ---------------------------------------------------------------- blocks

function parseBlocks(lines, ctx) {
  const out = [];
  let para = [];
  let i = 0;

  const flush = () => {
    if (para.length) out.push({ t: 'p', c: inline(para.join(' ')) });
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('```')) {
      flush();
      const lang = line.slice(3).trim();
      const body = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i++;
      const code = body.join('\n');
      const diagram = lang === 'text' || lang === '';
      // Only diagrams get the numeral swap: a real code sample must stay
      // byte-for-byte what the repository contains.
      const shown = diagram ? deCircleDiagram(code) : code;
      out.push({
        t: 'code',
        lang,
        diagram,
        raw: shown,
        tokens: tokenize(shown, lang),
      });
      continue;
    }

    const h = /^(#{1,3}) (.*)$/.exec(line);
    if (h) {
      flush();
      const level = h[1].length;
      const spans = inline(h[2].trim());
      const text = plainText(spans);
      if (level === 1) {
        ctx.title = text;
      } else {
        const id = `h${ctx.headings.length + 1}`;
        ctx.headings.push({ level, text, id });
        out.push({ t: 'h', level, id, c: spans, text });
      }
      i++;
      continue;
    }

    if (/^---+$/.test(line)) {
      flush();
      out.push({ t: 'hr' });
      i++;
      continue;
    }

    if (line.startsWith('|') && lines[i + 1] && /^\|[\s:|-]+\|$/.test(lines[i + 1])) {
      flush();
      const cells = (row) =>
        row
          .slice(1, row.endsWith('|') ? -1 : undefined)
          .split('|')
          .map((c) => inline(c.trim()));
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(cells(lines[i++]));
      out.push({ t: 'table', head, rows });
      continue;
    }

    if (line.startsWith('>')) {
      flush();
      const body = [];
      while (i < lines.length && (lines[i].startsWith('>') || lines[i] === '')) {
        if (lines[i] === '' && !(lines[i + 1] || '').startsWith('>')) break;
        body.push(lines[i].replace(/^> ?/, ''));
        i++;
      }
      // The 「当时」 sidebars are the book's historical footnotes — real session
      // records answering "why isn't this simpler". They read as a distinct
      // object, not a generic quote.
      const isNote = /^\*\*当时\*\*/.test(body[0] || '');
      const inner = parseBlocks(isNote ? body.slice(1) : body, ctx);
      if (isNote) ctx.notes += 1;
      out.push({ t: isNote ? 'note' : 'quote', c: inner });
      continue;
    }

    if (/^([-*] |\d+\. )/.test(line)) {
      flush();
      const ordered = /^\d+\. /.test(line);
      const items = [];
      while (i < lines.length && /^([-*] |\d+\. )/.test(lines[i])) {
        items.push(inline(lines[i].replace(/^([-*] |\d+\. )/, '')));
        i++;
      }
      out.push({ t: 'list', ordered, items });
      continue;
    }

    if (line.trim() === '') {
      flush();
      i++;
      continue;
    }

    para.push(line);
    i++;
  }
  flush();
  return out;
}

// ---------------------------------------------------------------- assemble

export function loadBook() {
  const present = new Set(readdirSync(BOOK_DIR).filter((f) => f.endsWith('.md')));
  for (const entry of CHAPTER_INDEX) {
    if (!present.has(entry.file)) {
      throw new Error(`[book] missing chapter source: docs/book/${entry.file}`);
    }
  }
  for (const file of present) {
    if (!CHAPTER_INDEX.some((c) => c.file === file)) {
      throw new Error(
        `[book] docs/book/${file} has no entry in CHAPTER_INDEX — give it a slug and a part.`,
      );
    }
  }

  return CHAPTER_INDEX.map((entry, order) => {
    const raw = readFileSync(join(BOOK_DIR, entry.file), 'utf8').replace(/\r\n/g, '\n');
    const ctx = { title: null, headings: [], notes: 0 };
    const blocks = parseBlocks(raw.split('\n'), ctx);
    if (!ctx.title) throw new Error(`[book] ${entry.file} has no level-1 heading`);

    // 「这一章你应该带走的」 is the book's own recap; the chapter footer renders
    // it separately from the flow, so mark where it starts.
    const recapAt = blocks.findIndex(
      (b) => b.t === 'h' && /你应该带走的|第一部分结束|全书收束/.test(b.text),
    );

    return {
      ...entry,
      order,
      title: ctx.title,
      // 「第 3 章 · 三条路径：写入、检索、展示」 → number / name
      num: (/^第\s*(\d+)\s*章/.exec(ctx.title) || [])[1] || null,
      shortTitle: ctx.title.replace(/^第\s*\d+\s*章\s*·\s*/, '').replace(/^附录\s*A\s*·\s*/, ''),
      headings: ctx.headings,
      notes: ctx.notes,
      chars: raw.length,
      minutes: Math.max(1, Math.round(raw.length / 900)),
      blocks,
      recapAt: recapAt === -1 ? null : recapAt,
    };
  });
}

// ---------------------------------------------------------------- vite plugin

export default function bookMarkdown() {
  return {
    name: 'obelisk-book-markdown',

    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
      return null;
    },

    load(id) {
      if (id !== RESOLVED_ID) return null;
      const chapters = loadBook();
      // Watching the sources keeps `npm run dev` live while editing the book.
      if (this.addWatchFile) {
        for (const c of chapters) this.addWatchFile(join(BOOK_DIR, c.file));
      }
      return [
        `export const chapters = ${JSON.stringify(chapters)};`,
        `export const parts = ${JSON.stringify(PARTS)};`,
        'export default chapters;',
      ].join('\n');
    },

    handleHotUpdate({ file, server }) {
      if (!file.startsWith(BOOK_DIR) || !file.endsWith('.md')) return;
      const mod = server.moduleGraph.getModuleById(RESOLVED_ID);
      if (mod) server.moduleGraph.invalidateModule(mod);
      server.ws.send({ type: 'full-reload' });
    },
  };
}
