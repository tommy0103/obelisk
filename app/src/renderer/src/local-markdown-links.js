const HOVER_DELAY_MS = 300;
const HIDE_DELAY_MS = 120;
const cache = new Map();
let hoverTimer = null;
let hideTimer = null;
let activeLink = null;
let previewEl = null;

function isLocalHref(href) {
  return typeof href === 'string' && (/^(?:file:|\/|[A-Za-z]:[\\/]|\\\\)/.test(href.trim()));
}

function markdownLink(target) {
  const link = target instanceof Element ? target.closest('.markdown-msg a, .markdown-body a, .markdown-compact a') : null;
  return link && isLocalHref(link.getAttribute('href')) ? link : null;
}

function hidePreview() {
  clearTimeout(hoverTimer);
  clearTimeout(hideTimer);
  hoverTimer = null;
  hideTimer = null;
  activeLink = null;
  previewEl?.remove();
  previewEl = null;
}

function showPreview(link, result) {
  if (!result?.preview || activeLink !== link) return;
  previewEl?.remove();
  previewEl = document.createElement('aside');
  previewEl.className = 'local-file-preview';
  const pathEl = document.createElement('div');
  pathEl.className = 'local-file-preview-path';
  pathEl.textContent = result.path;
  const contentEl = document.createElement('pre');
  contentEl.textContent = `${result.preview}${result.truncated ? '\n…' : ''}`;
  previewEl.append(pathEl, contentEl);
  document.body.append(previewEl);
}

async function previewLink(link) {
  const href = link.getAttribute('href');
  if (!href || !window.obelisk?.previewLocalMarkdownLink) return;
  let result = cache.get(href);
  if (!result) {
    result = await window.obelisk.previewLocalMarkdownLink(href);
    cache.set(href, result);
  }
  showPreview(link, result);
}

function onPointerOver(event) {
  const link = markdownLink(event.target);
  if (!link || link.contains(event.relatedTarget)) return;
  clearTimeout(hideTimer);
  hideTimer = null;
  clearTimeout(hoverTimer);
  activeLink = link;
  hoverTimer = setTimeout(() => void previewLink(link), HOVER_DELAY_MS);
}

function onPointerOut(event) {
  const link = markdownLink(event.target);
  if (link && !link.contains(event.relatedTarget)) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hidePreview, HIDE_DELAY_MS);
  }
}

function onClick(event) {
  const link = markdownLink(event.target);
  if (!link) return;
  event.preventDefault();
  const href = link.getAttribute('href');
  if (href) void window.obelisk?.openLocalMarkdownLink?.(href);
}

export function installLocalMarkdownLinkHandlers() {
  document.addEventListener('pointerover', onPointerOver);
  document.addEventListener('pointerout', onPointerOut);
  document.addEventListener('click', onClick);
  document.addEventListener('scroll', hidePreview, true);
  return () => {
    document.removeEventListener('pointerover', onPointerOver);
    document.removeEventListener('pointerout', onPointerOut);
    document.removeEventListener('click', onClick);
    document.removeEventListener('scroll', hidePreview, true);
    hidePreview();
  };
}
