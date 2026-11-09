// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
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

interface CapturedKimiSession extends KimiSessionSnapshot {
  readonly members: readonly KimiManifestMember[];
}

function normalizedRelativePath(sessionDir: string, path: string): string {
  return relative(sessionDir, path).split(sep).join('/');
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function optionalDirectoryEntries(path: string) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function listedMember(sessionDir: string, path: string): KimiManifestMember {
  // The caller observed this exact entry in a directory listing. Any stat
  // failure, including ENOENT, means the snapshot raced a mutation rather than
  // proving that the member was absent.
  const stat = statSync(path, { bigint: true });
  return {
    relativePath: normalizedRelativePath(sessionDir, path),
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  };
}

function manifestCursor(members: readonly KimiManifestMember[]): string {
  const maxMtimeNs = members.reduce((latest, member) => {
    const mtimeNs = BigInt(member.mtimeNs);
    return mtimeNs > latest ? mtimeNs : latest;
  }, 0n);
  const digest = createHash('sha256').update(JSON.stringify(members)).digest('base64url');
  const maxMtimeMs = maxMtimeNs / 1_000_000n;
  return `${maxMtimeMs}:0:${KIMI_MANIFEST_CURSOR_FORMAT}:${digest}`;
}

function captureKimiSession(sessionDir: string): CapturedKimiSession {
  const statePath = join(sessionDir, 'state.json');
  const sessionEntries = optionalDirectoryEntries(sessionDir);
  if (sessionEntries === null) {
    const members: KimiManifestMember[] = [];
    return {
      sessionDir,
      statePath,
      wireFiles: [],
      members,
      currentCursor: manifestCursor(members),
    };
  }

  const members: KimiManifestMember[] = [];
  if (sessionEntries.some((entry) => entry.name === 'state.json')) {
    members.push(listedMember(sessionDir, statePath));
  }

  const wireFiles: KimiWireFile[] = [];
  const agentsEntry = sessionEntries.find((entry) => entry.name === 'agents' && entry.isDirectory());
  if (agentsEntry !== undefined) {
    const agentsDir = join(sessionDir, agentsEntry.name);
    const agentEntries = readdirSync(agentsDir, { withFileTypes: true });
    for (const agentEntry of agentEntries) {
      if (!agentEntry.isDirectory()) continue;
      const agentDir = join(agentsDir, agentEntry.name);
      const entries = readdirSync(agentDir, { withFileTypes: true });
      if (!entries.some((entry) => entry.name === 'wire.jsonl')) continue;
      const path = join(agentDir, 'wire.jsonl');
      members.push(listedMember(sessionDir, path));
      wireFiles.push({ agentId: agentEntry.name, main: agentEntry.name === 'main', path });
    }
  }

  if (!wireFiles.some((file) => file.main) && sessionEntries.some((entry) => entry.name === 'wire.jsonl')) {
    const path = join(sessionDir, 'wire.jsonl');
    members.push(listedMember(sessionDir, path));
    wireFiles.push({ agentId: 'main', main: true, path });
  }

  members.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  wireFiles.sort((a, b) => Number(b.main) - Number(a.main) || a.agentId.localeCompare(b.agentId));
  return {
    sessionDir,
    statePath,
    wireFiles,
    members,
    currentCursor: manifestCursor(members),
  };
}

/**
 * Capture one deterministic, body-free view of the Kimi session members.
 * The manifest format owns path normalization, ordering, metadata fields, and
 * digest encoding; changing any of those requires a new cursor-format tag.
 */
export function snapshotKimiSession(sessionDir: string): KimiSessionSnapshot {
  const before = captureKimiSession(sessionDir);
  const after = captureKimiSession(sessionDir);
  if (before.currentCursor !== after.currentCursor) {
    throw new Error(`Kimi session changed while snapshotting: ${sessionDir}`);
  }
  return {
    sessionDir: after.sessionDir,
    statePath: after.statePath,
    wireFiles: after.wireFiles,
    currentCursor: after.currentCursor,
  };
}
