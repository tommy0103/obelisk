// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Two reference shapes appear in transcripts and need different handling:
//   A. Markdown links with an absolute path — `[roadmap.md](/Users/me/proj/roadmap.md:162)`
//   B. Inline code holding a project-relative path — `` `src/hooks/hook.ts:40` ``
// Both end up as an anchor carrying the split-out components; the main process resolves them.

const REFERENCE_SUFFIX = /:(\d+)(?::(\d+)|-(\d+))?$/;
const INLINE_CODE_REFERENCE = /^[\w@.\-/]+\.[A-Za-z0-9]+:\d+(?::\d+|-\d+)?$/;
const LOCAL_HREF = /^(?:file:|\/|[A-Za-z]:[\\/])/;

export function isLocalHref(href) {
  return typeof href === 'string' && LOCAL_HREF.test(href.trim());
}

// Deliberately strict: an extension *and* a line number are both required. Plain inline code
// such as `package.json` or `useState` must never become a link.
export function isInlineCodeReference(text) {
  return typeof text === 'string' && INLINE_CODE_REFERENCE.test(text.trim());
}

export function parseFileReference(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const text = raw.trim();
  const match = REFERENCE_SUFFIX.exec(text);
  if (!match) return { path: text, line: null, column: null, endLine: null };
  return {
    path: text.slice(0, match.index),
    line: Number(match[1]),
    column: match[2] ? Number(match[2]) : null,
    endLine: match[3] ? Number(match[3]) : null,
  };
}

// Only `file:` URLs are percent-encoded. Decoding a plain path would corrupt any filename
// that legitimately contains `%`.
export function hrefToPath(href) {
  if (!href.startsWith('file:')) return href;
  try {
    return decodeURIComponent(new URL(href).pathname);
  } catch {
    return '';
  }
}

function applyReference(el, raw, { cwd, sessionId }) {
  const ref = parseFileReference(raw);
  if (!ref?.path) return false;
  el.classList.add('file-ref');
  el.dataset.filePath = ref.path;
  if (cwd) el.dataset.fileCwd = cwd;
  if (sessionId) el.dataset.fileSession = sessionId;
  if (ref.line) el.dataset.fileLine = String(ref.line);
  if (ref.column) el.dataset.fileColumn = String(ref.column);
  if (ref.endLine) el.dataset.fileEndLine = String(ref.endLine);
  return true;
}

function markLinkReferences(rootEl, context) {
  for (const anchor of rootEl.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href') || '';
    if (!isLocalHref(href)) continue;
    const filePath = hrefToPath(href.trim());
    if (filePath) applyReference(anchor, filePath, context);
  }
}

// Fenced blocks render as <pre><code>; only inline code is linkified, so a path quoted inside
// a code sample never turns into navigation.
function markInlineCodeReferences(rootEl, context) {
  if (!context.cwd) return;
  for (const code of rootEl.querySelectorAll('code')) {
    if (code.closest('pre')) continue;
    const text = code.textContent.trim();
    if (!isInlineCodeReference(text)) continue;
    const anchor = document.createElement('a');
    anchor.textContent = text;
    if (!applyReference(anchor, text, context)) continue;
    code.replaceChildren(anchor);
  }
}

// Cheap pre-filter on the rendered HTML. Most messages contain neither a link nor inline code,
// and this runs for every rendered row — a string scan is far cheaper than walking the DOM.
export function mayContainFileReference(html) {
  return typeof html === 'string' && (html.includes('<a ') || html.includes('<code'));
}

export function markFileReferences(rootEl, { cwd = null, sessionId = null } = {}) {
  const context = { cwd, sessionId };
  markLinkReferences(rootEl, context);
  markInlineCodeReferences(rootEl, context);
  return rootEl;
}

function onClick(event) {
  const anchor = event.target instanceof Element ? event.target.closest('a.file-ref') : null;
  if (!anchor) return;
  event.preventDefault();
  const { filePath, fileCwd, fileSession, fileLine, fileColumn } = anchor.dataset;
  if (!filePath) return;
  void window.obelisk?.openFileReference?.({
    sessionId: fileSession || null,
    path: filePath,
    cwd: fileCwd || null,
    line: fileLine ? Number(fileLine) : null,
    column: fileColumn ? Number(fileColumn) : null,
  });
}

export function installFileReferenceHandler(target = document) {
  target.addEventListener('click', onClick);
  return () => target.removeEventListener('click', onClick);
}
