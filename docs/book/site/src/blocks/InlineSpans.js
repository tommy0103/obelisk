// Inline span renderer for parsed markdown.
//
// Spans come from plugins/book-markdown.mjs and are one of:
//   {k:'t',v}  text        {k:'c',v}  `code`
//   {k:'b',c}  **bold**    {k:'a',href,c}  [link](x)
//   {k:'ref',v,href}       `path/to/file.ts:120` → a clickable source chip
//
// Text spans also get the glossary pass: the FIRST occurrence of a term in a
// chapter becomes a hover card. Only the first — otherwise a chapter about
// cursors turns into a rash of dotted underlines.
//
// Written as a render function rather than a template because it recurses and
// because a template would need a v-if ladder per span kind.

import { h, inject } from 'vue';
import { RouterLink } from 'vue-router';

import { GLOSSARY_MATCHES } from '@/book/glossary.js';
import GlossaryTerm from '@/components/GlossaryTerm.vue';

export const GLOSSARY_CTX = Symbol('glossary-ctx');

const isInternal = (href) => href.startsWith('/');

// Returns an array of children, splitting out at most one glossary term.
function withGlossary(text, ctx) {
  if (!ctx || !text) return [text];

  for (const { text: needle, entry } of GLOSSARY_MATCHES) {
    if (ctx.seen.has(entry.term)) continue;
    // A term is not worth annotating inside the chapter that defines it.
    if (entry.chapter === ctx.slug) continue;
    const at = text.indexOf(needle);
    if (at === -1) continue;
    ctx.seen.add(entry.term);
    return [
      text.slice(0, at),
      h(GlossaryTerm, { entry, text: needle }),
      ...withGlossary(text.slice(at + needle.length), ctx),
    ];
  }
  return [text];
}

function renderSpan(span, ctx) {
  switch (span.k) {
    case 'c':
      return h('code', span.v);

    case 'step':
      // A circled numeral in the markdown. Drawn as a digit in a CSS ring
      // rather than passed through as U+2460 — see plugins/book-markdown.mjs.
      return h('span', { class: 'step-ref' }, span.v);

    case 'ref':
      return h(
        'a',
        {
          class: 'src-ref',
          href: span.href,
          target: '_blank',
          rel: 'noreferrer',
          title: '在 GitHub 上打开这个位置',
        },
        [h('span', { class: 'src-ref-mark', 'aria-hidden': 'true' }, '↗'), span.v],
      );

    case 'b':
      return h('strong', span.c.map((s) => renderSpan(s, ctx)));

    case 'a':
      return isInternal(span.href)
        ? h(RouterLink, { to: span.href }, () => span.c.map((s) => renderSpan(s, ctx)))
        : h(
            'a',
            { href: span.href, target: '_blank', rel: 'noreferrer' },
            span.c.map((s) => renderSpan(s, ctx)),
          );

    default:
      return withGlossary(span.v, ctx);
  }
}

export default {
  name: 'InlineSpans',
  props: {
    spans: { type: Array, required: true },
    // Glossary annotation is for body prose only; headings and widget copy opt
    // out so a term never gets underlined inside a title.
    plain: { type: Boolean, default: false },
  },
  setup(props) {
    const ctx = inject(GLOSSARY_CTX, null);
    return () => props.spans.map((s) => renderSpan(s, props.plain ? null : ctx));
  },
};
