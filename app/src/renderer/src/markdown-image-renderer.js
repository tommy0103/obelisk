// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

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
let configuredMarked = null;

// marked escapes the alt text and title it hands to the renderer, and the
// attributes are re-escaped on the way back out, so they have to be decoded
// once in between. Doing that through a detached element's innerHTML would
// mean parsing untrusted markup, so decode the entities marked actually emits
// in a single pass instead -- one pass, so `&amp;lt;` stays `&lt;`.
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

function isSafeImageSource(source) {
  try {
    const url = new URL(source, globalThis.document?.baseURI ?? 'file:///');
    return SAFE_IMAGE_PROTOCOLS.has(url.protocol)
      || (url.protocol === 'data:' && /^data:image\//i.test(source));
  } catch {
    return false;
  }
}

// marked <= 14 calls renderer.image(href, title, text); marked >= 15 passes the
// image token instead. Accepting both keeps an upgrade from silently turning
// every session image into fallback text.
export function normalizeMarkdownImageToken(hrefOrToken, title, text) {
  if (hrefOrToken && typeof hrefOrToken === 'object') {
    return {
      href: hrefOrToken.href ?? '',
      title: hrefOrToken.title ?? '',
      text: hrefOrToken.text ?? '',
    };
  }
  return { href: hrefOrToken ?? '', title: title ?? '', text: text ?? '' };
}

// A source the app will not load is rendered through the same element with no
// src, so a blocked image and an image that fails to load look the same to the
// reader instead of being two different pieces of UI.
export function renderSessionMarkdownImage(hrefOrToken, title, text) {
  const token = normalizeMarkdownImageToken(hrefOrToken, title, text);
  const source = decodeMarkedAttribute(token.href).trim();
  const alt = decodeMarkedAttribute(token.text);
  const accessibleTitle = decodeMarkedAttribute(token.title);
  const attributes = [`alt="${escapeAttribute(alt)}"`];
  if (source && isSafeImageSource(source)) attributes.unshift(`src="${escapeAttribute(source)}"`);
  if (accessibleTitle) attributes.push(`title="${escapeAttribute(accessibleTitle)}"`);
  return `<${SESSION_IMAGE_TAG} ${attributes.join(' ')}></${SESSION_IMAGE_TAG}>`;
}

export function configureMarkdownImages(marked) {
  if (!marked || configuredMarked === marked) return;
  marked.use({
    renderer: {
      image: renderSessionMarkdownImage,
    },
  });
  configuredMarked = marked;
}
