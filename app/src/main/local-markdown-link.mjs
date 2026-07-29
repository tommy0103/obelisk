import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOCAL_LINK_PREVIEW_BYTES = 12 * 1024;

function withoutLineSuffix(filePath) {
  return filePath.replace(/:\d+(?::\d+)?$/, '');
}

export function localMarkdownLinkCandidates(href) {
  if (typeof href !== 'string' || !href.trim()) return [];
  const rawHref = href.trim();
  let filePath;
  try {
    if (rawHref.startsWith('file:')) {
      filePath = fileURLToPath(rawHref);
    } else {
      filePath = decodeURIComponent(rawHref);
    }
  } catch {
    return [];
  }
  if (!path.isAbsolute(filePath)) return [];
  const withoutSuffix = withoutLineSuffix(filePath);
  return withoutSuffix === filePath ? [filePath] : [filePath, withoutSuffix];
}

export function resolveExistingLocalMarkdownFile(href) {
  for (const filePath of localMarkdownLinkCandidates(href)) {
    try {
      if (fs.statSync(filePath).isFile()) return filePath;
    } catch {}
  }
  return null;
}

export function previewLocalMarkdownLink(href) {
  const filePath = resolveExistingLocalMarkdownFile(href);
  if (!filePath) return { exists: false };
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(LOCAL_LINK_PREVIEW_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const content = buffer.subarray(0, bytesRead);
    if (content.includes(0)) return { exists: true, path: filePath, preview: null, truncated: false };
    return {
      exists: true,
      path: filePath,
      preview: content.toString('utf8'),
      truncated: bytesRead === LOCAL_LINK_PREVIEW_BYTES,
    };
  } catch {
    return { exists: false };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
