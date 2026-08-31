// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import type { Cursor } from './types.ts';

export const KIMI_MANIFEST_CURSOR_FORMAT = 'kimi-manifest-v1';
export type KimiCursorDisposition = 'current' | 'replay';

export interface KimiWireFile {
  readonly agentId: string;
  readonly main: boolean;
  readonly path: string;
}

export interface KimiSessionSnapshot {
  readonly sessionDir: string;
  readonly statePath: string;
  readonly wireFiles: readonly KimiWireFile[];
  readonly currentCursor: Exclude<Cursor, null>;
}

/**
 * Only an exact current-format match can prove that a Kimi session is clean.
 * Legacy and unknown cursors fail closed to one replay; they never poison the
 * provider with a version error.
 */
export function classifyKimiCursor(
  storedCursor: Cursor,
  currentCursor: Exclude<Cursor, null>,
): KimiCursorDisposition {
  return storedCursor === currentCursor ? 'current' : 'replay';
}

interface KimiManifestMember {
  readonly relativePath: string;
  readonly dev: string;
  readonly ino: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

function normalizedRelativePath(sessionDir: string, path: string): string {
  return relative(sessionDir, path).split(sep).join('/');
}

function listWireFiles(sessionDir: string): KimiWireFile[] {
  const agentsDir = join(sessionDir, 'agents');
  const files: KimiWireFile[] = [];
  if (existsSync(agentsDir)) {
    for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(agentsDir, entry.name, 'wire.jsonl');
      if (existsSync(path)) files.push({ agentId: entry.name, main: entry.name === 'main', path });
    }
  }
  if (!files.some((file) => file.main)) {
    const legacy = join(sessionDir, 'wire.jsonl');
    if (existsSync(legacy)) files.push({ agentId: 'main', main: true, path: legacy });
  }
  return files.sort((a, b) => Number(b.main) - Number(a.main) || a.agentId.localeCompare(b.agentId));
}

function manifestCursor(sessionDir: string, paths: readonly string[]): string {
  let maxMtimeNs = 0n;
  const members = paths.filter(existsSync).map((path): KimiManifestMember => {
    const stat = statSync(path, { bigint: true });
    if (stat.mtimeNs > maxMtimeNs) maxMtimeNs = stat.mtimeNs;
    return {
      relativePath: normalizedRelativePath(sessionDir, path),
      dev: String(stat.dev),
      ino: String(stat.ino),
      size: String(stat.size),
      mtimeNs: String(stat.mtimeNs),
      ctimeNs: String(stat.ctimeNs),
    };
  }).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const digest = createHash('sha256').update(JSON.stringify(members)).digest('base64url');
  const maxMtimeMs = maxMtimeNs / 1_000_000n;
  return `${maxMtimeMs}:0:${KIMI_MANIFEST_CURSOR_FORMAT}:${digest}`;
}

/**
 * Capture one deterministic, body-free view of the Kimi session members.
 * The manifest format owns path normalization, ordering, metadata fields, and
 * digest encoding; changing any of those requires a new cursor-format tag.
 */
export function snapshotKimiSession(sessionDir: string): KimiSessionSnapshot {
  const statePath = join(sessionDir, 'state.json');
  const wireFiles = listWireFiles(sessionDir);
  return {
    sessionDir,
    statePath,
    wireFiles,
    currentCursor: manifestCursor(sessionDir, [statePath, ...wireFiles.map((wire) => wire.path)]),
  };
}
