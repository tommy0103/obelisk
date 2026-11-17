// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { Marked } from 'marked';
import { SESSION_IMAGE_TAG } from './session-image-contract.js';

const SAFE_IMAGE_PROTOCOLS = new Set(['blob:', 'file:', 'http:', 'https:']);
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};
// Markdown source may spell alt text, titles and URLs with entity references,
// which marked passes through and the attributes re-escape on the way out, so
// decode them once in between. Doing that through a detached element's
// innerHTML would mean parsing untrusted markup, so decode in a single pass
// instead -- one pass, so `&amp;lt;` stays `&lt;`.
function decodeMarkedAttribute(value) {
  return String(value ?? '').replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, entity) => {
    if (entity[0] === '#') {
      const codePoint = entity[1] === 'x' || entity[1] === 'X'
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

function escapeAttribute(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function isSafeImageSource(source) {
  try {
    const url = new URL(source, globalThis.document?.baseURI ?? 'file:///');
    return SAFE_IMAGE_PROTOCOLS.has(url.protocol)
      || (url.protocol === 'data:' && /^data:image\//i.test(source));
  } catch {
    return false;
  }
}

// A source the app will not load is rendered through the same element with no
// src, so a blocked image and an image that fails to load look the same to the
// reader instead of being two different pieces of UI.
function renderSessionMarkdownImage({ href, title, text }) {
  const source = decodeMarkedAttribute(href).trim();
  const alt = decodeMarkedAttribute(text);
  const accessibleTitle = decodeMarkedAttribute(title);
  const attributes = [`alt="${escapeAttribute(alt)}"`];
  if (source && isSafeImageSource(source)) attributes.unshift(`src="${escapeAttribute(source)}"`);
  if (accessibleTitle) attributes.push(`title="${escapeAttribute(accessibleTitle)}"`);
  return `<${SESSION_IMAGE_TAG} ${attributes.join(' ')}></${SESSION_IMAGE_TAG}>`;
}

export const sessionMarked = new Marked({ renderer: { image: renderSessionMarkdownImage } });
