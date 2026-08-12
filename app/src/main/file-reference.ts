// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import fs from 'node:fs';
import path from 'node:path';

const EDITOR_SCHEMES: Record<string, string> = {
  vscode: 'vscode',
  'vscode-insiders': 'vscode-insiders',
  cursor: 'cursor',
  windsurf: 'windsurf',
  zed: 'zed',
};

const DEFAULT_EDITOR_SCHEME = 'vscode';

interface FileReferenceQuery {
  rawPath?: string | null;
  cwd?: string | null;
  roots?: (string | null | undefined)[];
}

interface EditorUrlOptions {
  scheme?: string | null;
  filePath: string;
  line?: number | null;
  column?: number | null;
}

function normalizeRoots(roots: (string | null | undefined)[] = []): string[] {
  const seen = new Set<string>();
  for (const root of roots) {
    if (typeof root !== 'string' || !root.trim() || !path.isAbsolute(root)) continue;
    seen.add(path.resolve(root));
  }
  return [...seen];
}

function isWithinRoots(candidate: string, roots: string[]): boolean {
  return roots.some((root) => candidate === root || candidate.startsWith(root + path.sep));
}

// A reference may be absolute, relative to the message cwd, or project-relative with a
// leading slash (`/src/foo.ts`). path.join treats the leading slash as a no-op, so the same
// join covers the last two cases.
function fileReferenceCandidates({ rawPath, cwd, roots = [] }: FileReferenceQuery): string[] {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return [];
  const cleaned = rawPath.trim();
  const bases = normalizeRoots([cwd, ...roots]);
  const candidates: string[] = [];
  if (path.isAbsolute(cleaned)) candidates.push(path.resolve(cleaned));
  for (const base of bases) candidates.push(path.resolve(base, `.${path.sep}${cleaned}`));
  return [...new Set(candidates)];
}

// Resolves to an existing file that lives inside one of the session's own roots. Transcript
// text is untrusted input, so containment is checked after realpath — a symlink pointing out
// of the project must not widen what the app will open.
function resolveFileReference(query: FileReferenceQuery): string | null {
  const roots = normalizeRoots([query.cwd, ...(query.roots || [])]);
  if (!roots.length) return null;
  for (const candidate of fileReferenceCandidates(query)) {
    if (!isWithinRoots(candidate, roots)) continue;
    try {
      const real = fs.realpathSync(candidate);
      if (!isWithinRoots(real, roots)) continue;
      if (fs.statSync(real).isFile()) return real;
    } catch {}
  }
  return null;
}

function buildEditorUrl({ scheme, filePath, line, column }: EditorUrlOptions): string {
  const resolved = EDITOR_SCHEMES[String(scheme || '')] || DEFAULT_EDITOR_SCHEME;
  let target = `${resolved}://file${encodeURI(filePath)}`;
  const lineNumber = Number(line);
  if (Number.isInteger(lineNumber) && lineNumber > 0) {
    target += `:${lineNumber}`;
    const columnNumber = Number(column);
    if (Number.isInteger(columnNumber) && columnNumber > 0) target += `:${columnNumber}`;
  }
  return target;
}

export {
  DEFAULT_EDITOR_SCHEME,
  EDITOR_SCHEMES,
  buildEditorUrl,
  fileReferenceCandidates,
  isWithinRoots,
  normalizeRoots,
  resolveFileReference,
};
