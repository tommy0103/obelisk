// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import DOMPurify from 'dompurify';
import { state } from './store.js';
import { markFileReferences, mayContainFileReference } from './file-references.mjs';
import { isSafeImageSource, sessionMarked } from './markdown-image-renderer.js';
import { SESSION_IMAGE_TAG } from './session-image-contract.js';

function pad2(n) { return String(n).padStart(2, '0'); }

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function fmtListTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const hhmm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (isSameDay(d, now)) return hhmm;
  const mmdd = `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
  if (d.getFullYear() === now.getFullYear()) return `${mmdd} ${hhmm}`;
  return `${d.getFullYear()}/${mmdd} ${hhmm}`;
}

export function fmtRelative(ts) {
  const diff = Date.now() - ts;
  const min = 60000, hr = 3600000, day = 86400000;
  if (diff < 0) return 'in the future';
  if (diff < min) return 'just now';
  if (diff < hr) return Math.floor(diff / min) + 'm ago';
  if (diff < day) return Math.floor(diff / hr) + 'h ago';
  if (diff < day * 30) return Math.floor(diff / day) + 'd ago';
  if (diff < day * 365) return Math.floor(diff / (day * 30)) + 'mo ago';
  return Math.floor(diff / (day * 365)) + 'y ago';
}

export function fmtClockTime(iso) {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function escapeHTML(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function highlightPlain(text, query) {
  if (!query) return escapeHTML(text);
  const safe = escapeHTML(text);
  const q = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp(q, 'gi'), m => `<mark>${m}</mark>`);
}

// Transcript Markdown is attacker-controlled, and marked passes raw HTML
// through. DOMPurify's default allowlist strips scripts, handlers and
// javascript: URLs; the session image element keeps the sources the Markdown
// image renderer accepts, which DOMPurify's URI check would drop (file:, blob:).
// A separate instance keeps this hook off the update-notes sanitizer. Built on
// first use: Node tests import this module without a DOM.
let purify = null;
function sanitizeMarkdown(html) {
  if (!purify) {
    purify = DOMPurify(window);
    purify.addHook('uponSanitizeAttribute', (node, data) => {
      if (node.nodeName.toLowerCase() === SESSION_IMAGE_TAG && data.attrName === 'src') {
        data.forceKeepAttr = isSafeImageSource(data.attrValue);
      }
    });
  }
  return purify.sanitize(html, {
    ADD_TAGS: [SESSION_IMAGE_TAG],
    FORBID_TAGS: ['style'],
    RETURN_DOM_FRAGMENT: true,
  });
}

function highlightTextNodes(rootEl, query) {
  if (!query) return;
  const q = query.toLowerCase();
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, null);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue;
    if (!text) continue;
    const lower = text.toLowerCase();
    if (!lower.includes(q)) continue;
    const frag = document.createDocumentFragment();
    let last = 0, i = lower.indexOf(q);
    while (i !== -1) {
      if (i > last) frag.appendChild(document.createTextNode(text.slice(last, i)));
      const mark = document.createElement('mark');
      mark.textContent = text.slice(i, i + q.length);
      frag.appendChild(mark);
      last = i + q.length;
      i = lower.indexOf(q, last);
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}

export function renderMarkdown(text, opts = {}) {
  if (text == null) return '';
  const html = sessionMarked.parse(text, { async: false });
  const cls = opts.variant === 'msg' ? 'markdown-msg'
            : opts.variant === 'compact' ? 'markdown-compact'
            : 'markdown-body';
  const container = document.createElement('div');
  container.className = cls;
  container.append(sanitizeMarkdown(html));
  // Without a cwd or session to resolve against, a reference could never be opened — leaving it
  // unmarked keeps it from looking actionable.
  if ((opts.cwd || opts.sessionId) && mayContainFileReference(html)) {
    markFileReferences(container, { cwd: opts.cwd, sessionId: opts.sessionId });
  }
  if (opts.query) highlightTextNodes(container, opts.query.trim());
  return container.outerHTML;
}

export function fmtDuration(ms) {
  if (!ms) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (sec || !parts.length) parts.push(`${sec}s`);
  return parts.join(' ');
}

export function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

export function fmtTooltipDate(isoDay) {
  const d = new Date(isoDay + 'T00:00:00');
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const day = d.getDate();
  const suffix = day === 1 || day === 21 || day === 31 ? 'st' : day === 2 || day === 22 ? 'nd' : day === 3 || day === 23 ? 'rd' : 'th';
  const thisYear = new Date().getFullYear();
  if (d.getFullYear() === thisYear) return `${months[d.getMonth()]} ${day}${suffix}`;
  return `${months[d.getMonth()]} ${day}${suffix}, ${d.getFullYear()}`;
}

export function positionTooltip(el, x, y) {
  const pad = 12;
  const rect = el.getBoundingClientRect();
  let left = x + pad;
  if (left + rect.width > window.innerWidth - pad) left = x - rect.width - pad;
  el.style.left = left + 'px';
  el.style.top = (y - 28) + 'px';
}

export function formatProjectLabel(slug) {
  if (!slug) return '(no project)';
  const projectPath = state.projects.find(project => project.project === slug)?.project_path;
  if (projectPath) {
    const parts = projectPath.split('/');
    return parts[parts.length - 1];
  }
  return slug.replace(/^-/, '');
}
