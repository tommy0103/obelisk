// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Codex provider adapter in Core (see docs/adr/0001).
//
// Pure: discovers Codex rollout files and parses one into a record stream. It
// never touches the Obelisk database. A v4 checkpoint supports a cooperative
// append path that reads only new bytes; the existing prefix-hash path remains
// available for verified appends, while replacements, truncations, legacy
// cursors, and unterminated tails fall back to a complete snapshot. The whole-
// file scan remains necessary for event_msg ↔ response_item dedup, but it
// retains only bounded checkpoint state instead of every parsed JSON object.

import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readSync, statSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

import {
  trunc, truncJson, readLines, tryRealpath, extractHarnessKind,
  discoverCodexJsonlFiles, normalizeObservedCwd, projectSlugFromPath, sourceInventoryIssue,
  codexRawId, codexDbId, codexCallId, codexLineUuid, codexParentThreadId,
  codexIsGuardianThread, codexAgentNickname, codexAgentRole, codexUsage,
  codexEventText, codexMessagePayloadText, codexVisibleMessageKey,
  codexToolInput, codexToolOutput,
  isSkillInstructions,
  readCodexGuardianThreadInfo, normalizeTranscriptTimestamp,
  isCodexCompressedPath, isCodexTranscriptPath, readCodexCompressedBytes,
  readCodexBufferLines, readCodexLines,
} from '../parsing.ts';

import { RetryableSourceReadError } from './source-read-error.ts';

import type {
  Cursor,
  DiscoverContext,
  TranscriptRecord,
  IndexUnit,
  MessageRecord,
  ProviderAdapter,
  RawLookup,
  RawRecord,
} from './types.ts';

export const name = 'codex';
// v5 replays v3/v4 rows once so transcript timestamps and session bounds
// use canonical UTC milliseconds after timestamp normalization.
const CODEX_CANONICAL_TRANSCRIPT_MARKER = '__codex_canonical_transcript_v5__';
const CODEX_SESSIONS_DIR = 'sessions';
const CODEX_ARCHIVED_SESSIONS_DIR = 'archived_sessions';

const HIDDEN_CONTEXT_ENVELOPE_RE = /^\s*<(environment_context|codex_internal_context)\b[^>]*>[\s\S]*<\/\1>\s*$/;

function messageVisibility(role: string, text: string | null): 'visible' | 'hidden' {
  return role === 'user' && typeof text === 'string' && HIDDEN_CONTEXT_ENVELOPE_RE.test(text)
    ? 'hidden'
    : 'visible';
}

function codexTranscriptDirs(rootDir: string): string[] {
  return [
    join(rootDir, CODEX_SESSIONS_DIR),
    join(rootDir, CODEX_ARCHIVED_SESSIONS_DIR),
  ];
}

export function defaultCodexHome({
  env = process.env,
  homeDir = homedir(),
  cwd = process.cwd(),
}: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  cwd?: string;
} = {}): string {
  const fromEnv = env['CODEX_HOME'];
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    const trimmed = fromEnv.trim();
    const expanded = trimmed === '~'
      ? homeDir
      : trimmed.startsWith('~/') || trimmed.startsWith('~\\')
        ? join(homeDir, trimmed.slice(2))
        : trimmed;
    return normalize(resolve(cwd, expanded));
  }
  return join(homeDir, '.codex');
}

function canonicalCodexRoot(rootDir: string): string {
  return normalize(tryRealpath(rootDir) ?? resolve(rootDir));
}

function lexicalCodexRoot(rootDir: string): string {
  return normalize(resolve(rootDir));
}

function codexScopeForPath(rootDir: string, defaultRoot: string): string | null {
  if (rootDir === defaultRoot) return null;
  return codexScopedRootId(rootDir);
}

function codexScopedRootId(rootDir: string): string {
  const label = basename(rootDir)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'root';
  const hash = createHash('sha256').update(`codex-root-v1\0${rootDir}`).digest('hex').slice(0, 8);
  return `${label}-${hash}`;
}

function legacyCodexRootScope(rootDir: string, homeDir: string): string | null {
  return codexScopeForPath(lexicalCodexRoot(rootDir), lexicalCodexRoot(join(homeDir, '.codex')));
}

export function codexRootScope(rootDir: string, homeDir: string = homedir()): string | null {
  return codexScopeForPath(canonicalCodexRoot(rootDir), canonicalCodexRoot(join(homeDir, '.codex')));
}

function pathInside(dir: string, targetPath: string): boolean {
  const rel = relative(normalize(dir), normalize(targetPath));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function sameCodexRootPath(a: string, b: string): boolean {
  return canonicalCodexRoot(a) === canonicalCodexRoot(b);
}

const CODEX_ZST_CURSOR_TAG = 'codex-zst-v2';
const CODEX_ZST_LEGACY_CURSOR_TAG = 'codex-zst-v1';
const CODEX_BASIC_CURSOR_TAG = 'codex-basic-v2';
const CODEX_STORE_CURSOR_TAG = ':codex-store-v1:';

function codexDirectoryIdentity(path: string): string | null {
  try {
    const stat = codexStatSync(path);
    return stat.isDirectory() && usableSourceIdentity(stat)
      ? `${stat.devExact}:${stat.inoExact}:${stat.birthtimeMs}`
      : null;
  } catch { return null; }
}

function readCodexStore(cursor: Cursor): { identity: string; aliases: string[]; defaultOwner: boolean } | null {
  const suffix = cursor?.split(CODEX_STORE_CURSOR_TAG)[1];
  if (suffix === undefined) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(suffix, 'base64url').toString('utf8'));
    if (isRecord(value) && typeof value.identity === 'string' && Array.isArray(value.aliases)
      && value.aliases.every((alias: unknown) => typeof alias === 'string')) {
      return { identity: value.identity, aliases: value.aliases, defaultOwner: value.defaultOwner === true };
    }
  } catch { /* malformed checkpoint suffix */ }
  return null;
}

function codexStoreSuffix(identity: string | null | undefined, aliases: readonly string[], defaultOwner: boolean): string | undefined {
  if (identity == null) return undefined;
  return CODEX_STORE_CURSOR_TAG + Buffer.from(JSON.stringify({ identity, aliases: [...aliases].sort(), defaultOwner })).toString('base64url');
}

function encodeCodexZstCursor(stat: CodexStats, completeLines: number, rootScope: string | null = null): string {
  const parts = [
    stat.mtimeMs,
    completeLines,
    stat.size,
    stat.ctimeMs,
    stat.inoExact,
    CODEX_ZST_CURSOR_TAG,
    stat.devExact,
  ];
  if (rootScope !== null) parts.push(rootScope);
  return parts.join(':');
}

// Cursor format: `${mtime}:${lines}:${completeLineOffset}:${ctimeMs}:${ino}`.
// mtime+ctime+source identity still let discovery notice same-millisecond
// rewrites. The provider state carries sourceSize because the outer size field
// is now the safe restart offset, not the current EOF.
function codexCursorSignatureDiffers(cursor: string, filePath: string, expectedRootScope: string | null = null): boolean {
  const stat = codexStatSync(filePath);
  const parts = cursor.split(CODEX_STORE_CURSOR_TAG)[0]!.split(':');
  if (parts[5] === CODEX_BASIC_CURSOR_TAG) {
    const validLength = expectedRootScope === null ? parts.length === 7 : parts.length === 8;
    return !validLength
      || (parts[7] ?? null) !== expectedRootScope
      || Number(parts[0]) !== stat.mtimeMs
      || Number(parts[2]) !== stat.size
      || Number(parts[3]) !== stat.ctimeMs
      || !cursorIntegerMatches(parts[4]!, stat.inoExact)
      || !cursorIntegerMatches(parts[6]!, stat.devExact);
  }
  if (isCodexCompressedPath(filePath)) {
    const validLength = expectedRootScope === null ? parts.length === 7 : parts.length === 8;
    const exactFormat = parts[5] === CODEX_ZST_CURSOR_TAG;
    const legacyUnsafeIdentity = parts[5] === CODEX_ZST_LEGACY_CURSOR_TAG
      && (!safeLegacyIdentity(parts[6]!) || !safeLegacyIdentity(parts[4]!));
    const cursorScope = parts[7] ?? null;
    return !validLength
      || cursorScope !== expectedRootScope
      || (!exactFormat && parts[5] !== CODEX_ZST_LEGACY_CURSOR_TAG)
      || !Number.isSafeInteger(Number(parts[1]))
      || Number(parts[1]) < 0
      || Number(parts[0]) !== stat.mtimeMs
      || Number(parts[2]) !== stat.size
      || Number(parts[3]) !== stat.ctimeMs
      || legacyUnsafeIdentity
      || !cursorIntegerMatches(parts[4]!, stat.inoExact)
      || !cursorIntegerMatches(parts[6]!, stat.devExact);
  }
  if (parts.length === 5) {
    return !safeLegacyIdentity(parts[4]!)
      || Number(parts[0]) !== stat.mtimeMs
      || Number(parts[2]) !== stat.size
      || Number(parts[3]) !== stat.ctimeMs
      || !cursorIntegerMatches(parts[4]!, stat.inoExact);
  }
  if (parts.length < 5) return true;
  let sourceSize = Number(parts[2]);
  let cursorRootScope: string | null = null;
  let legacyUnsafeIdentity = true;
  try {
    const state = JSON.parse(Buffer.from(parts[5]!, 'base64url').toString('utf8'));
    if (Number.isSafeInteger(state?.sourceSize) && state.sourceSize >= 0) sourceSize = state.sourceSize;
    if (typeof state?.rootScope === 'string' && state.rootScope.length > 0) cursorRootScope = state.rootScope;
    legacyUnsafeIdentity = state?.sourceIdentityEncoding !== 'uint64-decimal-v1'
      && (!safeLegacyIdentity(state?.dev) || !safeLegacyIdentity(state?.sourceInode ?? parts[4]!));
  } catch { /* legacy or malformed cursor: force replay */ }
  return cursorRootScope !== expectedRootScope
    || legacyUnsafeIdentity
    || Number(parts[0]) !== stat.mtimeMs
    || sourceSize !== stat.size
    || Number(parts[3]) !== stat.ctimeMs
    || !cursorIntegerMatches(parts[4]!, stat.inoExact);
}

function safeLegacyIdentity(value: string): boolean {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0;
}

type CodexStats = Pick<Stats, 'size' | 'mtimeMs' | 'ctimeMs' | 'birthtimeMs' | 'nlink'> & {
  devExact: string;
  inoExact: string;
  mtimeNsExact: string;
  ctimeNsExact: string;
  birthtimeNsExact: string;
  isFile(): boolean;
  isDirectory(): boolean;
};

function codexStatSync(path: string): CodexStats {
  const exact = statSync(path, { bigint: true });
  const dev = BigInt.asUintN(64, BigInt(exact.dev));
  const ino = BigInt.asUintN(64, BigInt(exact.ino));
  const millis = (ns: bigint): number => Number(ns / 1_000_000_000n) * 1000
    + Number(ns % 1_000_000_000n) / 1_000_000;
  return {
    size: Number(exact.size),
    mtimeMs: millis(exact.mtimeNs), ctimeMs: millis(exact.ctimeNs),
    birthtimeMs: millis(exact.birthtimeNs), nlink: Number(exact.nlink),
    devExact: String(dev), inoExact: String(ino),
    mtimeNsExact: String(exact.mtimeNs), ctimeNsExact: String(exact.ctimeNs),
    birthtimeNsExact: String(exact.birthtimeNs),
    isFile: () => exact.isFile(),
    isDirectory: () => exact.isDirectory(),
  };
}

function cursorIntegerMatches(cursorValue: string, exactValue: string): boolean {
  return cursorValue === exactValue;
}

function trustedCursorIdentity(state: DecodedCodexCursor): boolean {
  return state.sourceIdentityEncoding === 'uint64-decimal-v1'
    || (safeLegacyIdentity(state.dev ?? '') && safeLegacyIdentity(state.sourceInode ?? state.inode));
}

interface CodexFileIdentity {
  readonly device: string;
  readonly inode: string;
  readonly mtime: number;
  readonly ctime: number;
  readonly exact: boolean;
}

function codexFileIdentity(cursor: Cursor): CodexFileIdentity | null {
  if (cursor === null) return null;
  const parts = cursor.split(':');
  const compressed = parts[5] === CODEX_ZST_CURSOR_TAG || parts[5] === CODEX_ZST_LEGACY_CURSOR_TAG;
  if (parts[5] === CODEX_BASIC_CURSOR_TAG) {
    return {
      device: parts[6]!, inode: parts[4]!, mtime: Number(parts[0]),
      ctime: Number(parts[3]), exact: true,
    };
  }
  const device = compressed ? parts[6] : decodeCodexCursor(cursor)?.dev;
  if (device === undefined) return null;
  const state = compressed ? null : decodeCodexCursor(cursor);
  const exact = compressed
    ? parts[5] === CODEX_ZST_CURSOR_TAG
      || (safeLegacyIdentity(device) && safeLegacyIdentity(parts[4]!))
    : state?.sourceIdentityEncoding === 'uint64-decimal-v1'
      || (safeLegacyIdentity(device) && safeLegacyIdentity(parts[4]!));
  return { device, inode: parts[4]!, mtime: Number(parts[0]), ctime: Number(parts[3]), exact };
}

function codexFileMatches(identity: CodexFileIdentity | null, filePath: string, { unshared = false } = {}): boolean {
  if (identity === null || !identity.exact) return false;
  let stat: CodexStats;
  try { stat = codexStatSync(filePath); } catch { return false; }
  if (!stat.isFile() || !usableSourceIdentity(stat) || (unshared && stat.nlink !== 1)) return false;
  return cursorIntegerMatches(identity.device, stat.devExact)
    && cursorIntegerMatches(identity.inode, stat.inoExact)
    // A replacement can reuse an inode. When available, creation time also
    // has to predate the checkpoint. Otherwise require unchanged metadata.
    && (stat.birthtimeMs > 0
      ? stat.birthtimeMs <= identity.ctime
      : stat.ctimeMs === identity.ctime && stat.mtimeMs === identity.mtime);
}

function cursorIdentifiesCodexFile(cursor: Cursor, path: string, options?: { unshared?: boolean }): boolean {
  return codexFileMatches(codexFileIdentity(cursor), path, options);
}

function hasRenamedCodexRollout(identity: CodexFileIdentity | null, path: string): boolean {
  if (identity === null) return false;
  const parent = dirname(path);
  try {
    return readdirSync(parent, { withFileTypes: true }).some(entry => entry.isFile()
      && !isCodexTranscriptPath(entry.name)
      && codexFileMatches(identity, join(parent, entry.name), { unshared: true }));
  } catch { return false; }
}

function matchesLegacyGuardian(path: string, sessionId: string, mtime: number): boolean {
  try {
    if (tryRealpath(path) !== path || statSync(path).mtimeMs !== mtime) return false;
    const guardian = readCodexGuardianThreadInfo(isCodexCompressedPath(path) ? readCodexCompressedBytes(path) : path);
    return guardian !== null && codexDbId(guardian.threadRawId) === sessionId;
  } catch { return false; }
}

function hasUnresolvedCodexAlias(path: string): boolean {
  for (let current = path; current !== dirname(current); current = dirname(current)) {
    try {
      const entry = lstatSync(current, { throwIfNoEntry: false });
      if (entry?.isSymbolicLink()) return true;
      if (entry !== undefined) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOTDIR') throw error;
    }
  }
  return false;
}

function checkDirStatus(dirPath: string): 'exists' | 'missing' | { error: unknown } {
  try {
    statSync(dirPath);
    return 'exists';
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return 'missing';
    return { error };
  }
}

function discoverAtRoot(
  rootDir: string,
  rootScope: string | null,
  ctx: DiscoverContext,
  {
    usesRootSet = false,
    aliases = [rootDir],
    homeDir = homedir(),
    recoveredRoots = new Map<string, string>(),
    confirmedGuardians = new Map<string, { sessionId: string; mtime: number }>(),
    storeSuffix,
  }: {
    usesRootSet?: boolean; aliases?: readonly string[]; homeDir?: string; recoveredRoots?: ReadonlyMap<string, string>;
    confirmedGuardians?: ReadonlyMap<string, { sessionId: string; mtime: number }>; storeSuffix?: string;
  } = {},
): IndexUnit[] {
  const [sessionsDir, archivedSessionsDir] = codexTranscriptDirs(rootDir);
  const indexedList = ctx.indexedSessions?.() ?? [];
  const canonical = (p: string) => normalize(p).replace(/\.zst$/, '');
  const rootStatus = checkDirStatus(rootDir);
  if (rootStatus !== 'exists' && rootStatus !== 'missing') {
    ctx.reportIncompleteInventory?.(sourceInventoryIssue(rootDir, rootStatus.error));
    return [];
  }
  if (rootStatus === 'missing') {
    const hasPrior = usesRootSet
      ? indexedList.some((s) => pathInside(rootDir, s.jsonlPath) || (rootScope !== null && s.sessionId.startsWith(`codex:${rootScope}:`)))
      : indexedList.length > 0;
    if (hasPrior || (usesRootSet && hasUnresolvedCodexAlias(rootDir))) {
      ctx.reportIncompleteInventory?.({ path: sessionsDir, error: 'Source folder is unavailable' });
    }
    return [];
  }
  const sessionsStatus = checkDirStatus(sessionsDir);
  if (sessionsStatus !== 'exists' && sessionsStatus !== 'missing') {
    ctx.reportIncompleteInventory?.(sourceInventoryIssue(sessionsDir, sessionsStatus.error));
  } else if (sessionsStatus === 'missing') {
    const hasPriorInSessions = usesRootSet
      ? indexedList.some((s) => pathInside(sessionsDir, s.jsonlPath))
      : indexedList.length > 0;
    if (hasPriorInSessions) {
      ctx.reportIncompleteInventory?.({ path: sessionsDir, error: 'Source folder is unavailable' });
    }
  }
  const archivedStatus = checkDirStatus(archivedSessionsDir);
  if (archivedStatus !== 'exists' && archivedStatus !== 'missing') {
    ctx.reportIncompleteInventory?.(sourceInventoryIssue(archivedSessionsDir, archivedStatus.error));
  } else if (archivedStatus === 'missing' && indexedList.some((s) => pathInside(archivedSessionsDir, s.jsonlPath))) {
    ctx.reportIncompleteInventory?.({ path: archivedSessionsDir, error: 'Source folder is unavailable' });
  }

  const sessionIndexPath = normalize(join(rootDir, 'session_index.jsonl'));
  const sessionIndexAliases = new Set<string>([sessionIndexPath]);
  const realRootDir = tryRealpath(rootDir);
  if (realRootDir !== null) {
    sessionIndexAliases.add(normalize(join(realRootDir, 'session_index.jsonl')));
  }
  const sessionIndex = new Map<string, { title: string; updatedAt: string | null }>();
  if (existsSync(sessionIndexPath)) {
    readLines(sessionIndexPath, (line: string) => {
      try {
        const item = JSON.parse(line);
        if (item?.id && item?.thread_name) {
          sessionIndex.set(codexRawId(item.id) as string, {
            title: item.thread_name,
            updatedAt: normalizeTranscriptTimestamp(item.updated_at),
          });
        }
      } catch { /* malformed session-index entry */ }
    });
  }
  const changedFiles = new Set<string>();
  let sessionIndexChanged = false;
  const transcriptAliases = [sessionsDir, archivedSessionsDir].map((transcriptDir) => {
    const candidates = [normalize(transcriptDir)];
    const realDir = tryRealpath(transcriptDir);
    if (realDir !== null) {
      const resolvedDir = normalize(realDir);
      if (resolvedDir !== candidates[0]) candidates.push(resolvedDir);
    }
    return { transcriptDir: normalize(transcriptDir), candidates };
  });
  const routedChangedPaths = [...(ctx.changedPaths ?? [])];
  for (const alias of aliases) {
    for (const changedPath of ctx.changedPaths ?? []) {
      const absolute = isAbsolute(changedPath) ? normalize(changedPath) : normalize(join(alias, changedPath));
      const aliasRelative = relative(normalize(alias), absolute);
      if (aliasRelative === '' || aliasRelative.startsWith('..') || isAbsolute(aliasRelative)) continue;
      routedChangedPaths.push(normalize(join(rootDir, aliasRelative)));
    }
  }
  for (const changedPath of routedChangedPaths) {
    const rootRelative = isAbsolute(changedPath)
      ? normalize(changedPath)
      : normalize(join(rootDir, changedPath));
    if (sessionIndexAliases.has(rootRelative)) sessionIndexChanged = true;
    for (const { transcriptDir, candidates } of transcriptAliases) {
      for (const candidateDir of candidates) {
        const absolute = isAbsolute(changedPath)
          ? normalize(changedPath)
          : normalize(join(candidateDir, changedPath));
        const inside = relative(candidateDir, absolute);
        if (!inside || inside.startsWith('..') || isAbsolute(inside)) continue;
        const mapped = normalize(join(transcriptDir, inside));
        if (isCodexTranscriptPath(mapped)) {
          changedFiles.add(mapped);
          if (isCodexCompressedPath(mapped)) {
            changedFiles.add(mapped.slice(0, -'.zst'.length));
          } else {
            changedFiles.add(`${mapped}.zst`);
          }
        }
      }
    }
  }
  const forcedMigrationPaths = new Set<string>();
  const indexedByPath = new Map(indexedList.map(session => [session.jsonlPath, session.sessionId]));
  for (const session of indexedList) {
    if (!pathInside(rootDir, session.jsonlPath)) continue;
    const scopeMismatch = rootScope !== null
      ? !session.sessionId.startsWith(`codex:${rootScope}:`)
      : /^codex:[^:]+:/.test(session.sessionId);
    if (scopeMismatch) forcedMigrationPaths.add(canonical(session.jsonlPath));
  }
  const historicalAliasesByPath = new Map<string, { sessionId: string; cursor: string; path: string }[]>();
  if (usesRootSet) {
    const rootIdentity = codexDirectoryIdentity(rootDir);
    const priorRoots = new Map<string, { physicalRoot: string | null; scope: string | null }>();
    for (const session of indexedList) {
      const recoveredRoot = recoveredRoots.get(session.sessionId);
      if (recoveredRoot !== undefined && recoveredRoot !== rootDir) continue;
      const priorRoot = deriveCodexRootFromSessionPath(session.jsonlPath);
      if (priorRoot === null || priorRoot === rootDir) continue;
      let prior = priorRoots.get(priorRoot);
      if (prior === undefined) {
        prior = { physicalRoot: tryRealpath(priorRoot), scope: legacyCodexRootScope(priorRoot, homeDir) };
        priorRoots.set(priorRoot, prior);
      }
      const sessionScope = /^codex:([^:]+):[^:]+$/.exec(session.sessionId)?.[1] ?? null;
      if (sessionScope !== prior.scope) continue;

      const path = normalize(join(rootDir, relative(priorRoot, session.jsonlPath)));
      const cursor = ctx.previousCursor?.(session.jsonlPath) ?? ctx.lastCursor(session.jsonlPath);
      const store = readCodexStore(cursor);
      if (prior.physicalRoot !== rootDir && (store !== null ? store.identity !== rootIdentity
        : cursorIdentifiesCodexFile(cursor, session.jsonlPath)
          || !cursorIdentifiesCodexFile(cursor, path, { unshared: true }))) continue;
      // A live symlink only identifies today's target. Require a historical
      // source checkpoint before transferring ownership across root paths.
      if (cursor === null || (store !== null && store.identity !== rootIdentity)
        || tryRealpath(path) !== path || !cursorIdentifiesCodexFile(cursor, path)) {
        ctx.retainSession?.(session.sessionId);
        if (sessionScope === rootScope || ctx.snapshotRequired) {
          ctx.reportIncompleteInventory?.({ path: session.jsonlPath, error: 'Codex alias no longer matches its historical source' });
        }
        continue;
      }
      const key = canonical(path);
      const previous = historicalAliasesByPath.get(key) ?? [];
      previous.push({ sessionId: session.sessionId, cursor, path });
      historicalAliasesByPath.set(key, previous);
    }
  }
  const discovered: IndexUnit[] = codexTranscriptDirs(rootDir).flatMap((transcriptDir) => (
    discoverCodexJsonlFiles(transcriptDir, ctx.reportIncompleteInventory).flatMap<IndexUnit>((file) => {
      const fileChanged = changedFiles.has(normalize(file.path));
      const scopeMigration = forcedMigrationPaths.has(canonical(file.path)) || historicalAliasesByPath.has(canonical(file.path));
      if (ctx.changedPaths !== undefined && !sessionIndexChanged && !fileChanged && !scopeMigration) return [];
      const cursor = ctx.lastCursor(file.path);
      const unchangedSource = cursor !== null && !codexCursorSignatureDiffers(cursor, file.path, rootScope);
      const unchangedStore = storeSuffix === undefined || !cursor?.includes(CODEX_STORE_CURSOR_TAG) || cursor.endsWith(storeSuffix);
      const indexedSessionId = indexedByPath.get(file.path);
      if (unchangedSource && !scopeMigration && !sessionIndexChanged && !fileChanged && indexedSessionId !== undefined
        && storeSuffix !== undefined && !cursor.includes(CODEX_STORE_CURSOR_TAG)
        && cursorIdentifiesCodexFile(cursor, file.path, { unshared: true })) {
        return [{ key: file.path, sessionId: indexedSessionId, meta: { rootScope, storeSuffix, storeOnly: true } }];
      }
      // A session-index-only refresh must update the aggregate, but a
      // strengthened cursor already contains the identity needed to construct
      // the normal-session unit. Avoid reopening every historical rollout for
      // guardian classification when its source signature is unchanged.
      if (sessionIndexChanged && !fileChanged && !scopeMigration && unchangedSource && unchangedStore) {
        const checkpoint = decodeCodexCursor(cursor);
        if (checkpoint !== null) {
          const parentId = codexParentThreadId(checkpoint.meta);
          const indexed = sessionIndex.get(checkpoint.threadRawId);
          return [{
            key: file.path,
            sessionId: codexDbId(parentId || checkpoint.threadRawId, rootScope) ?? '',
            meta: {
              source: 'codex', guardian: false, parentThreadId: parentId, threadRawId: checkpoint.threadRawId,
              rootScope,
              storeSuffix,
              indexedTitle: indexed?.title,
              indexedUpdatedAt: indexed?.updatedAt,
            },
          }];
        }
      }
      // Skip unchanged files before paying for guardian detection: guardian
      // status is content-derived, so a file whose cursor signature still
      // matches cannot have changed status. Pre-v3 databases may still hold
      // guardian session rows; the v3 marker bump forces one full replay that
      // retracts them.
      if (!sessionIndexChanged && !fileChanged && !scopeMigration && unchangedSource && unchangedStore) return [];
      let guardian: { threadRawId: string; lineNum: number } | null;
      let meta: any = null;
      try {
        if (isCodexCompressedPath(file.path)) {
          const decompressed = readCodexCompressedBytes(file.path);
          guardian = readCodexGuardianThreadInfo(decompressed);
          readCodexBufferLines(decompressed, (line: string) => {
            try {
              const record = JSON.parse(line);
              if (record?.type === 'session_meta' && record.payload?.id) {
                meta = record.payload;
                return false;
              }
            } catch { /* malformed source line */ }
          });
        } else {
          guardian = readCodexGuardianThreadInfo(file.path);
          readLines(file.path, (line: string) => {
            try {
              const record = JSON.parse(line);
              if (record?.type === 'session_meta' && record.payload?.id) {
                meta = record.payload;
                return false;
              }
            } catch { /* malformed source line */ }
          });
        }
      } catch (error) {
        ctx.reportIncompleteInventory?.({
          path: file.path,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
      const rawId = meta ? codexRawId(meta.id) : null;
      if (rawId === null && guardian === null
        && (ctx.previousCursor?.(file.path) ?? ctx.lastCursor(file.path)) !== null) {
        ctx.reportIncompleteInventory?.({ path: file.path, error: 'Previously indexed rollout has no readable session identity' });
        return [];
      }
      const parentId = meta ? codexParentThreadId(meta) : null;
      const indexed = rawId ? sessionIndex.get(rawId) : undefined;
      const legacyGuardian = guardian !== null && rootScope !== null ? confirmedGuardians.get(file.path) : undefined;
      return [{
        key: file.path,
        sessionId: guardian === null ? codexDbId(parentId || rawId, rootScope) ?? '' : '',
        ...(legacyGuardian === undefined ? {} : {
          atomicGroup: `guardian-replay:${legacyGuardian.sessionId}`,
          retractSessionIds: [legacyGuardian.sessionId],
        }),
        meta: {
          source: 'codex',
          guardian: guardian !== null,
          parentThreadId: parentId,
          threadRawId: rawId,
          rootScope,
          storeSuffix,
          legacyGuardian,
          indexedTitle: indexed?.title,
          indexedUpdatedAt: indexed?.updatedAt,
          sessionIndexChanged,
        },
      }];
    })
  ));
  // Switching archive representation or root identity scope can replace or
  // rename the root while leaving unchanged child cursors behind. A root
  // snapshot retracts its whole session, so publish every contributor in one
  // transaction, even in changed-path mode.
  const indexed = new Map(indexedList.map(session => [session.sessionId, session]));
  const indexedByCanonicalPath = new Map<string, string[]>();
  for (const session of indexedList) {
    const key = canonical(session.jsonlPath);
    const ids = indexedByCanonicalPath.get(key) ?? [];
    ids.push(session.sessionId);
    indexedByCanonicalPath.set(key, ids);
  }
  const transitions = new Map<string, { unitKeys: Set<string>; retractSessionIds: Set<string> }>();
  for (const unit of discovered) {
    const meta = unit.meta as { guardian?: boolean; parentThreadId?: string | null; threadRawId?: string };
    if (meta.guardian || !unit.sessionId) continue;
    const path = canonical(unit.key);
    const aliasIds = (historicalAliasesByPath.get(path) ?? []).map(entry => entry.sessionId);
    const directIds = indexedByCanonicalPath.get(path) ?? [];
    const retractions = [...aliasIds, ...directIds].filter(id => (
      id !== unit.sessionId && (!meta.parentThreadId || id.endsWith(`:${meta.threadRawId}`))
    ));
    const previous = indexed.get(unit.sessionId);
    let archiveTransition = false;
    if (retractions.length === 0 && !meta.parentThreadId && previous && canonical(previous.jsonlPath) === path) {
      const cursor = ctx.lastCursor(unit.key);
      const prior = decodeCodexCursor(cursor);
      const stat = codexStatSync(unit.key);
      const rootReplaced = cursor !== null && !isCodexCompressedPath(unit.key)
        && (prior === null || !trustedCursorIdentity(prior)
          || prior.inode !== stat.inoExact || prior.dev !== stat.devExact
          || (codexCursorSignatureDiffers(cursor, unit.key, rootScope) && stat.size <= (prior.sourceSize ?? prior.size)));
      archiveTransition = normalize(previous.jsonlPath) !== normalize(unit.key) || rootReplaced
        || (isCodexCompressedPath(unit.key) && cursor !== null && codexCursorSignatureDiffers(cursor, unit.key, rootScope));
    }
    if (retractions.length === 0 && !archiveTransition && aliasIds.length === 0) continue;

    const transition = transitions.get(unit.sessionId) ?? { unitKeys: new Set<string>(), retractSessionIds: new Set<string>() };
    transition.unitKeys.add(unit.key);
    for (const id of retractions) transition.retractSessionIds.add(id);
    transitions.set(unit.sessionId, transition);
  }
  if (transitions.size === 0) return discovered;
  let censusComplete = true;
  const complete = discoverAtRoot(rootDir, rootScope, {
    ...ctx, changedPaths: undefined, lastCursor: () => null, indexedSessions: () => [],
    reportIncompleteInventory: issue => {
      censusComplete = false;
      ctx.reportIncompleteInventory?.(issue);
    },
  }, { usesRootSet, aliases, storeSuffix });
  const remaining = discovered.filter(unit => !transitions.has(unit.sessionId));
  const families = new Map<string, IndexUnit[]>();
  for (const unit of complete) {
    if (!transitions.has(unit.sessionId)) continue;
    const family = families.get(unit.sessionId) ?? [];
    family.push(unit);
    families.set(unit.sessionId, family);
  }
  for (const [sessionId, { unitKeys, retractSessionIds }] of transitions) {
    const family = families.get(sessionId) ?? [];
    const root = family.find(unit => !(unit.meta as { parentThreadId?: string | null }).parentThreadId);
    const memberKeys = new Set(family.map(unit => unit.key));
    if (!censusComplete || root === undefined || [...unitKeys].some(key => !memberKeys.has(key))) {
      ctx.retainSession?.(sessionId);
      for (const id of retractSessionIds) ctx.retainSession?.(id);
      if (censusComplete) {
        ctx.reportIncompleteInventory?.({ path: root?.key ?? rootDir, error: 'Missing contributor during Codex session reconciliation' });
      }
      continue;
    }
    const memberPaths = new Map(family.flatMap(unit => {
      const meta = unit.meta as { parentThreadId?: string | null; threadRawId?: string };
      return meta.parentThreadId && meta.threadRawId ? [[meta.threadRawId, unit.key]] : [];
    }));
    const aliasEvidence = new Map<string, { sessionId: string; cursor: string; path: string }[]>();
    let knownFamily = true;
    const aliasParents = historicalAliasesByPath.get(canonical(root.key)) ?? [];
    for (const oldId of new Set([...retractSessionIds, ...aliasParents.map(alias => alias.sessionId)])) {
      const oldSession = indexed.get(oldId);
      if (oldSession === undefined) continue;
      const oldRoot = deriveCodexRootFromSessionPath(oldSession.jsonlPath);
      if (oldRoot === null || oldRoot === rootDir) continue;
      for (const memberId of oldSession.memberSessionIds ?? []) {
        const wireId = memberId.slice(memberId.lastIndexOf(':') + 1);
        const memberPath = memberPaths.get(wireId);
        const oldPath = memberPath === undefined ? null : join(oldRoot, relative(rootDir, memberPath));
        const cursor = oldPath === null ? null : ctx.previousCursor?.(oldPath) ?? ctx.lastCursor(oldPath);
        if (memberPath === undefined || cursor === null || tryRealpath(memberPath) !== memberPath
          || !cursorIdentifiesCodexFile(cursor, memberPath)) {
          knownFamily = false;
          break;
        }
        const key = canonical(memberPath);
        aliasEvidence.set(key, [...aliasEvidence.get(key) ?? [], { sessionId: oldId, cursor, path: memberPath }]);
      }
    }
    if (!knownFamily) {
      ctx.retainSession?.(sessionId);
      for (const id of retractSessionIds) ctx.retainSession?.(id);
      ctx.reportIncompleteInventory?.({ path: root.key, error: 'Codex alias family no longer matches its historical sources' });
      continue;
    }
    family.sort((a, b) => Number(b.key === root.key) - Number(a.key === root.key));
    for (const unit of family) {
      const isRootUnit = unit.key === root.key;
      remaining.push({
        ...unit,
        atomicGroup: retractSessionIds.size > 0 ? `scope-migration:${sessionId}` : `archive-transition:${sessionId}`,
        ...(isRootUnit && retractSessionIds.size > 0 ? { retractSessionIds: [...retractSessionIds] } : {}),
        meta: {
          ...(unit.meta as object),
          forceSnapshot: true,
          replaceSnapshot: isRootUnit,
          historicalAliases: [
            ...historicalAliasesByPath.get(canonical(unit.key)) ?? [],
            ...aliasEvidence.get(canonical(unit.key)) ?? [],
          ],
        },
      });
    }
  }
  return remaining;
}

export function discover(ctx: DiscoverContext): IndexUnit[] {
  return discoverAtRoot(defaultCodexHome(), null, ctx);
}

const CODEX_CURSOR_STATE_VERSION = 4;
const CODEX_FINGERPRINT_CHUNK_BYTES = 8 * 1024 * 1024;
const CODEX_DEDUP_BLOOM_BYTES = 32 * 1024;
const CODEX_DEDUP_BLOOM_PROBES = 6;
// A verified cursor may retain only a bounded prefix fingerprint. Larger
// sources deliberately lose the verified fast path and use snapshot replay on
// the next verification request; cooperative append still remains available.
const CODEX_MAX_CURSOR_CHUNK_HASHES = 128;
const CODEX_MAX_OPEN_CALLS = 4096;
// A malformed completed JSONL line is a durable source defect: the checkpoint
// must not advance over it. Thrown from parse() when a prior checkpoint
// exists so the build's skipped-file diagnostics surface the frozen source;
// whole-snapshot builds (no prior cursor) stay silent instead.
const CODEX_MALFORMED_LINE_ERROR = 'Malformed JSONL line: incremental indexing is frozen until the source is repaired';

interface CodexCursorState {
  v: number;
  threadRawId: string;
  rootScope?: string | null;
  meta: Record<string, any>;
  // Present only on the cooperative-capable v4 subformat. Old #148 v4
  // cursors are deliberately rejected for offset resumption.
  completeLineOffset?: number;
  sourceSize?: number;
  dev?: string;
  sourceInode?: string;
  sourceIdentityEncoding?: 'uint64-decimal-v1';
  verifiedPrefix?: boolean;
  stateComplete?: boolean;
  /** The thread has a `user_message` event: what the person typed is recorded as such an event. */
  userMessageEvents?: boolean;
  indexedTitle?: string;
  indexedUpdatedAt?: string | null;
  chunkHashes: string[];
  eventMessageBloom: string;
  responseMessageBloom: string;
  openCallMessageUuids: Record<string, string>;
  terminated: boolean;
  currentCwd: string | null;
  currentModel: string | null;
  lastMessageUuid: string | null;
  lastTextAssistant: MessageRecord | null;
  startedAt: string | null;
  endedAt: string | null;
  gitBranch: string | null;
  version: string | null;
  threadTitle: string | null;
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

interface DecodedCodexCursor extends CodexCursorState {
  lineCount: number;
  size: number;
  ctimeMs: number;
  inode: string;
}

/**
 * Test/benchmark-only observation of source work for one parse invocation.
 * Codex-local by design: ADR-0013 records the trigger (a second provider
 * needing parse observability) for lifting this into a shared contract.
 */
export interface CodexParseMetrics {
  sourceBytesRead: number;
  suffixBytesRead: number;
  jsonLinesParsed: number;
  emittedRecords: number;
  plan: 'snapshot' | 'verified-append' | 'cooperative-append' | 'noop' | null;
}

export function createCodexParseMetrics(): CodexParseMetrics {
  return { sourceBytesRead: 0, suffixBytesRead: 0, jsonLinesParsed: 0, emittedRecords: 0, plan: null };
}

/** Deterministic test seam for source mutation checks; never used by production callers. */
export interface CodexParseTestHooks {
  beforeScan?(): void;
  afterScan?(): void;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, max = 1024): string | null {
  return typeof value === 'string' ? value.slice(0, max) : null;
}

function checkpointMeta(meta: Record<string, any>): Record<string, any> {
  const source = isRecord(meta.source) ? meta.source : null;
  const subagent = source && isRecord(source.subagent) ? source.subagent : null;
  const threadSpawn = subagent && isRecord(subagent.thread_spawn) ? subagent.thread_spawn : null;
  return {
    id: boundedString(meta.id),
    cwd: boundedString(meta.cwd),
    timestamp: boundedString(meta.timestamp),
    cli_version: boundedString(meta.cli_version),
    thread_source: boundedString(meta.thread_source),
    forked_from_id: boundedString(meta.forked_from_id),
    agent_nickname: boundedString(meta.agent_nickname),
    agent_role: boundedString(meta.agent_role),
    git: isRecord(meta.git) ? { branch: boundedString(meta.git.branch) } : null,
    source: subagent ? {
      subagent: {
        other: boundedString(subagent.other),
        parent_thread_id: boundedString(subagent.parent_thread_id),
        thread_spawn: threadSpawn ? {
          parent_thread_id: boundedString(threadSpawn.parent_thread_id),
          agent_nickname: boundedString(threadSpawn.agent_nickname),
          agent_role: boundedString(threadSpawn.agent_role),
        } : null,
      },
    } : null,
  };
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function usableSourceIdentity(stat: CodexStats): boolean {
  return /^\d+$/.test(stat.devExact) && BigInt(stat.devExact) > 0n
    && /^\d+$/.test(stat.inoExact) && BigInt(stat.inoExact) > 0n;
}

function decodeBloom(value: unknown): Buffer | null {
  if (typeof value !== 'string') return null;
  try {
    const filter = Buffer.from(value, 'base64url');
    return filter.length === CODEX_DEDUP_BLOOM_BYTES ? filter : null;
  } catch {
    return null;
  }
}

function emptyBloom(): Buffer {
  return Buffer.alloc(CODEX_DEDUP_BLOOM_BYTES);
}

function bloomAdd(filter: Buffer, key: string): void {
  const digest = Buffer.from(key, 'base64url');
  const first = digest.readUInt32LE(0);
  const step = (digest.readUInt32LE(4) | 1) >>> 0;
  const bits = filter.length * 8;
  for (let probe = 0; probe < CODEX_DEDUP_BLOOM_PROBES; probe++) {
    const bit = ((first + Math.imul(probe, step)) >>> 0) % bits;
    filter[bit >>> 3]! |= 1 << (bit & 7);
  }
}

function bloomMightContain(filter: Buffer, key: string): boolean {
  const digest = Buffer.from(key, 'base64url');
  const first = digest.readUInt32LE(0);
  const step = (digest.readUInt32LE(4) | 1) >>> 0;
  const bits = filter.length * 8;
  for (let probe = 0; probe < CODEX_DEDUP_BLOOM_PROBES; probe++) {
    const bit = ((first + Math.imul(probe, step)) >>> 0) % bits;
    if ((filter[bit >>> 3]! & (1 << (bit & 7))) === 0) return false;
  }
  return true;
}

function isCheckpointMessage(value: unknown): value is MessageRecord {
  if (!isRecord(value)) return false;
  return value.kind === 'message'
    && typeof value.uuid === 'string'
    && typeof value.session_id === 'string'
    && typeof value.type === 'string'
    && nullableString(value.parent_uuid)
    && nullableString(value.timestamp)
    && nullableString(value.role)
    && nullableString(value.text)
    && nullableString(value.content_type)
    && (value.is_meta === 0 || value.is_meta === 1)
    && ['visible', 'inactive', 'hidden'].includes(value.visibility)
    && nullableString(value.model)
    && (value.is_sidechain === 0 || value.is_sidechain === 1)
    && nullableString(value.agent_id)
    && (value.input_tokens === null || typeof value.input_tokens === 'number')
    && (value.output_tokens === null || typeof value.output_tokens === 'number')
    && nullableString(value.cwd)
    && nullableString(value.skill)
    && typeof value.source === 'string';
}

function decodeCodexCursor(cursor: Cursor): DecodedCodexCursor | null {
  if (cursor === null) return null;
  const parts = cursor.split(':');
  if (parts.length < 6) return null;
  const lineCount = Number(parts[1]);
  const size = Number(parts[2]);
  const ctimeMs = Number(parts[3]);
  const inode = parts[4]!;
  if (!Number.isSafeInteger(lineCount) || !Number.isSafeInteger(size)
    || !Number.isFinite(ctimeMs) || !/^\d+$/.test(inode)) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(parts[5]!, 'base64url').toString('utf8'));
    if (!isRecord(value)
      || value.v !== CODEX_CURSOR_STATE_VERSION
      || typeof value.threadRawId !== 'string'
      || (value.rootScope !== undefined && !nullableString(value.rootScope))
      || !isRecord(value.meta)
      || (value.completeLineOffset !== undefined && (!Number.isSafeInteger(value.completeLineOffset) || value.completeLineOffset < 0))
      || (value.sourceSize !== undefined && (!Number.isSafeInteger(value.sourceSize) || value.sourceSize < 0))
      || (value.dev !== undefined && typeof value.dev !== 'string')
      || (value.sourceInode !== undefined && typeof value.sourceInode !== 'string')
      || (value.sourceIdentityEncoding !== undefined && value.sourceIdentityEncoding !== 'uint64-decimal-v1')
      || (value.verifiedPrefix !== undefined && typeof value.verifiedPrefix !== 'boolean')
      || (value.stateComplete !== undefined && typeof value.stateComplete !== 'boolean')
      || (value.userMessageEvents !== undefined && typeof value.userMessageEvents !== 'boolean')
      || (value.indexedTitle !== undefined && typeof value.indexedTitle !== 'string')
      || (value.indexedUpdatedAt !== undefined && !nullableString(value.indexedUpdatedAt))
      || !Array.isArray(value.chunkHashes)
      || value.chunkHashes.length > CODEX_MAX_CURSOR_CHUNK_HASHES
      || !value.chunkHashes.every(item => typeof item === 'string')
      || decodeBloom(value.eventMessageBloom) === null
      || decodeBloom(value.responseMessageBloom) === null
      || !isRecord(value.openCallMessageUuids)
      || Object.keys(value.openCallMessageUuids).length > CODEX_MAX_OPEN_CALLS
      || !Object.values(value.openCallMessageUuids).every(item => typeof item === 'string')
      || typeof value.terminated !== 'boolean'
      || !nullableString(value.currentCwd)
      || !nullableString(value.currentModel)
      || !nullableString(value.lastMessageUuid)
      || (value.lastTextAssistant !== null && !isCheckpointMessage(value.lastTextAssistant))
      || !nullableString(value.startedAt)
      || !nullableString(value.endedAt)
      || !nullableString(value.gitBranch)
      || !nullableString(value.version)
      || !nullableString(value.threadTitle)
      || !Number.isSafeInteger(value.messageCount)
      || !Number.isFinite(value.totalInputTokens)
      || !Number.isFinite(value.totalOutputTokens)) {
      return null;
    }
    // Keep #148 v4 cursors readable. They simply lack the strengthened offset
    // identity and therefore cannot enter cooperative mode.
    return {
      ...(value as unknown as CodexCursorState),
      lineCount,
      size,
      ctimeMs,
      inode,
    };
  } catch {
    return null;
  }
}

function encodeCodexCursor(
  stat: CodexStats,
  lineCount: number,
  completeLineOffset: number,
  state: CodexCursorState,
): string {
  const encoded = Buffer.from(JSON.stringify({ ...state, sourceIdentityEncoding: 'uint64-decimal-v1' })).toString('base64url');
  return `${stat.mtimeMs}:${lineCount}:${completeLineOffset}:${stat.ctimeMs}:${stat.inoExact}:${encoded}`;
}

function sameStat(a: CodexStats, b: CodexStats): boolean {
  return a.mtimeMs === b.mtimeMs
    && a.ctimeMs === b.ctimeMs
    && a.size === b.size
    && a.inoExact === b.inoExact && a.devExact === b.devExact
    && a.mtimeNsExact === b.mtimeNsExact && a.ctimeNsExact === b.ctimeNsExact
    && a.birthtimeNsExact === b.birthtimeNsExact;
}

function sameSource(a: CodexStats, b: CodexStats): boolean {
  return a.devExact === b.devExact && a.inoExact === b.inoExact;
}

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('base64url');
}

function visibleMessageDigest(role: unknown, text: unknown): string {
  return sha256(codexVisibleMessageKey(role, text));
}

function fingerprintCodexFile(
  filePath: string,
  size: number,
  prior: DecodedCodexCursor | null,
  metrics?: CodexParseMetrics,
): { chunkHashes: string[]; prefixMatches: boolean; bytesRead: number; complete: boolean } {
  const fd = openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(CODEX_FINGERPRINT_CHUNK_BYTES);
  const chunkHashes: string[] = [];
  let fingerprintBounded = true;
  // `size` is the restart offset for strengthened v4. Fingerprints, however,
  // cover the source bytes that produced the checkpoint, including an
  // unterminated tail; use sourceSize when available.
  const priorSourceSize = prior === null ? 0 : (prior.sourceSize ?? prior.size);
  const priorChunks = prior === null ? 0 : Math.ceil(priorSourceSize / CODEX_FINGERPRINT_CHUNK_BYTES);
  const completePriorChunks = prior === null ? 0 : Math.floor(priorSourceSize / CODEX_FINGERPRINT_CHUNK_BYTES);
  const priorTailBytes = prior === null ? 0 : priorSourceSize % CODEX_FINGERPRINT_CHUNK_BYTES;
  let prefixMatches = prior !== null && priorSourceSize <= size && prior.chunkHashes.length === priorChunks;
  let position = 0;
  try {
    while (position < size) {
      const wanted = Math.min(buffer.length, size - position);
      let filled = 0;
      while (filled < wanted) {
        const count = readSync(fd, buffer, filled, wanted - filled, position + filled);
        if (count === 0) break;
        filled += count;
        if (metrics) metrics.sourceBytesRead += count;
      }
      if (filled === 0) break;
      const index = chunkHashes.length;
      const bytes = buffer.subarray(0, filled);
      if (index >= CODEX_MAX_CURSOR_CHUNK_HASHES) {
        fingerprintBounded = false;
        position += filled;
        continue;
      }
      const digest = sha256(bytes);
      chunkHashes.push(digest);
      if (prior !== null && prefixMatches) {
        if (index < completePriorChunks) {
          prefixMatches = digest === prior.chunkHashes[index];
        } else if (index === completePriorChunks && priorTailBytes > 0) {
          prefixMatches = sha256(bytes.subarray(0, priorTailBytes)) === prior.chunkHashes[index];
        }
      }
      position += filled;
    }
  } finally {
    closeSync(fd);
  }
  return {
    chunkHashes,
    prefixMatches: fingerprintBounded && prefixMatches && position === size,
    bytesRead: position,
    complete: fingerprintBounded,
  };
}

export function* parse(
  unit: IndexUnit,
  _cursor: Cursor,
  metrics?: CodexParseMetrics,
  testHooks?: CodexParseTestHooks,
): Generator<TranscriptRecord, Cursor> {
  const stat = codexStatSync(unit.key);
  const compressed = isCodexCompressedPath(unit.key);
  const sourceMeta = unit.meta as {
    guardian?: boolean;
    sessionIndexChanged?: boolean;
    forceSnapshot?: boolean;
    replaceSnapshot?: boolean;
    rootScope?: string | null;
    historicalAliases?: { cursor: string; path: string }[];
    [key: string]: unknown;
  } | undefined;
  const rootScope = typeof sourceMeta?.rootScope === 'string' && sourceMeta.rootScope.length > 0
    ? sourceMeta.rootScope
    : null;
  if (sourceMeta?.forceSnapshot) {
    // A null fresh cursor can mean a torn/unstable source, not an empty
    // contribution. Stage and validate the whole snapshot before publishing
    // anything; otherwise root retraction could commit without its child.
    if (sourceMeta.historicalAliases?.some(({ cursor, path }) => tryRealpath(path) !== path || !cursorIdentifiesCodexFile(cursor, path))) {
      throw new RetryableSourceReadError(unit.key, 'Codex alias no longer matches its historical source');
    }
    const freshUnit = { ...unit, meta: { ...sourceMeta, forceSnapshot: false, replaceSnapshot: false } };
    const fresh = parse(freshUnit, null, metrics, testHooks);
    const records: TranscriptRecord[] = [];
    let step = fresh.next();
    while (!step.done) { records.push(step.value); step = fresh.next(); }
    const childId = sourceMeta.parentThreadId ? codexDbId(sourceMeta.threadRawId, rootScope) : null;
    const identified = sourceMeta.replaceSnapshot
      ? records.some(record => record.kind === 'session' && record.id === unit.sessionId)
      : childId !== null && records.some(record =>
        (record.kind === 'subagent' && record.agent_id === childId && record.session_id === unit.sessionId)
        || (record.kind === 'delete-session' && record.sessionId === childId));
    if (step.value === null || !identified) {
      throw new RetryableSourceReadError(unit.key, 'Archive contributor did not produce a complete stable snapshot');
    }
    if (sourceMeta.replaceSnapshot) yield { kind: 'delete-session', sessionId: unit.sessionId };
    yield* records;
    return step.value;
  }
  if (compressed && !sourceMeta?.guardian && _cursor !== null && !codexCursorSignatureDiffers(_cursor, unit.key, rootScope)) {
    if (sourceMeta?.sessionIndexChanged) {
      // The archive did not change, but session_index.jsonl is a separate
      // metadata source. Read a fresh snapshot for native-title precedence and
      // bounds, then publish only its root aggregate. Replaying its deletion
      // or messages would retract unchanged child contributions.
      for (const record of parse(unit, null, metrics, testHooks)) {
        if (record.kind === 'session') {
          yield { ...record, message_count: 0, countMode: 'delta' };
        }
      }
      return _cursor;
    }
    if (metrics) metrics.plan = 'noop';
    return _cursor;
  }
  const prior = compressed ? null : decodeCodexCursor(_cursor);
  const decoded = compressed ? readCodexCompressedBytes(unit.key) : null;
  if (compressed && metrics) metrics.sourceBytesRead += stat.size;

  const readSourceLines = (
    callback: (line: string, terminated: boolean, endOffset?: number) => boolean | void,
    options: { start?: number; onBytesRead?: (bytes: number) => void } = {},
  ): void => {
    if (decoded !== null) {
      if ((options.start ?? 0) !== 0) {
        throw new Error('Compressed Codex rollout cannot resume at a byte offset');
      }
      readCodexBufferLines(decoded, callback);
      return;
    }
    readLines(unit.key, callback, options);
  };

  const readMode = unit.meta && typeof unit.meta === 'object' && 'readMode' in unit.meta
    && (unit.meta as { readMode?: unknown }).readMode === 'strict'
    ? 'strict'
    : 'normal';
  // Discovery has already classified this source as a guardian. That is an
  // explicit source invalidation, not an append: force a complete scan so the
  // canonical guardian retraction can remove this child contribution.
  const guardianInvalidation = unit.meta && typeof unit.meta === 'object'
    && (unit.meta as { guardian?: unknown }).guardian === true;
  // The cooperative path deliberately trusts Codex's normal append-only writer:
  // same device/inode, a complete-line checkpoint, and monotonic growth let us
  // seek to the suffix without reading the old prefix. Any failed gate falls
  // through to #148's fingerprinted verification/snapshot behavior.
  const cooperativeCandidate = !compressed && !guardianInvalidation && readMode === 'normal'
    && prior !== null
    && trustedCursorIdentity(prior)
    && (prior.rootScope ?? null) === rootScope
    && usableSourceIdentity(stat)
    && prior.completeLineOffset !== undefined
    && prior.sourceSize !== undefined
    && prior.dev !== undefined
    && prior.sourceInode !== undefined
    && prior.stateComplete !== false
    && prior.threadRawId === codexRawId(prior.meta.id)
    && prior.dev === stat.devExact
    && prior.sourceInode === stat.inoExact
    && prior.inode === stat.inoExact
    && prior.terminated
    && prior.completeLineOffset === prior.size
    && prior.sourceSize === prior.size
    && stat.size >= prior.completeLineOffset;
  // Growth is the normal append signal; ctime necessarily changes when bytes
  // are appended. For same-size sources, require the unchanged ctime before
  // treating the file as a no-op, otherwise let fingerprinting detect rewrites.
  const sameCheckpoint = !compressed && !guardianInvalidation && cooperativeCandidate && stat.size === prior.size;
  const rawIndexedMeta = unit.meta as { indexedTitle?: string; indexedUpdatedAt?: string | null } | undefined;
  const indexedMeta = rawIndexedMeta && {
    ...rawIndexedMeta, indexedUpdatedAt: normalizeTranscriptTimestamp(rawIndexedMeta.indexedUpdatedAt),
  };
  // Session-index metadata is independent of the source read plan. Strict
  // mode and unsupported file identities still need the aggregate patch
  // after fingerprint verification, even though they cannot use the noop path.
  const metadataChanged = prior !== null && (
    prior.indexedTitle !== indexedMeta?.indexedTitle
    || prior.indexedUpdatedAt !== (indexedMeta?.indexedUpdatedAt ?? undefined)
  );
  if (sameCheckpoint && stat.ctimeMs === prior.ctimeMs) {
    if (!metadataChanged) {
      if (metrics) metrics.plan = 'noop';
      return _cursor;
    }
    const parentRawId = codexParentThreadId(prior.meta);
    // A child has no independent session aggregate to patch. It must be
    // re-planned with the parent projection rather than replace its parent.
    if (parentRawId) return _cursor;
    const endedAt = indexedMeta?.indexedUpdatedAt && (!prior.endedAt || indexedMeta.indexedUpdatedAt > prior.endedAt)
      ? indexedMeta.indexedUpdatedAt
      : prior.endedAt;
    yield {
      kind: 'session', id: codexDbId(prior.threadRawId, rootScope) as string,
      title: prior.threadTitle ?? indexedMeta?.indexedTitle ?? null,
      project: projectSlugFromPath(normalizeObservedCwd(prior.meta.cwd)),
      started_at: prior.startedAt, ended_at: endedAt, git_branch: prior.gitBranch,
      version: prior.version, message_count: prior.messageCount, countMode: 'total',
      jsonl_path: unit.key, source: 'codex',
    };
    const { lineCount, size, ctimeMs: _ctimeMs, inode: _inode, ...state } = prior;
    return encodeCodexCursor(stat, lineCount, size, {
      ...state,
      indexedTitle: indexedMeta?.indexedTitle,
      indexedUpdatedAt: indexedMeta?.indexedUpdatedAt ?? undefined,
      endedAt,
    });
  }
  const cooperativeAppend = !compressed && cooperativeCandidate && stat.size > prior.size;
  const fingerprint = compressed
    ? { chunkHashes: [], prefixMatches: false, bytesRead: stat.size, complete: false }
    : (cooperativeAppend
      ? {
        chunkHashes: prior!.chunkHashes,
        prefixMatches: false,
        bytesRead: 0,
        complete: stat.size <= CODEX_MAX_CURSOR_CHUNK_HASHES * CODEX_FINGERPRINT_CHUNK_BYTES,
      }
      : fingerprintCodexFile(unit.key, stat.size, prior, metrics));
  const afterFingerprint = codexStatSync(unit.key);
  if ((!cooperativeAppend && (fingerprint.bytesRead !== stat.size || !sameStat(stat, afterFingerprint)))
    || (cooperativeAppend && !sameSource(stat, afterFingerprint))) return _cursor;
  const appendCandidate = !compressed && !guardianInvalidation && (cooperativeAppend || (prior !== null
    && trustedCursorIdentity(prior)
    && (prior.rootScope ?? null) === rootScope
    && prior.verifiedPrefix === true
    && prior.threadRawId === codexRawId(prior.meta.id)
    && prior.dev === stat.devExact
    && prior.sourceInode === stat.inoExact
    && prior.inode === stat.inoExact
    && prior.terminated
    && prior.stateComplete !== false
    && prior.completeLineOffset !== undefined
    && prior.completeLineOffset === prior.size
    && fingerprint.prefixMatches));
  const eventMessageKeys = new Set<string>();
  const appendedEventMessageKeys = new Set<string>();
  const appendedUserPromptKeys = new Set<string>();
  const appendedResponseMessageKeys = new Set<string>();
  let metaRecord: { lineNum: number; obj: any } | null = !appendCandidate
    ? null
    : { lineNum: 1, obj: { timestamp: prior.startedAt, payload: prior.meta } };
  let sawAutoReviewModel = false;
  let sawUserMessageEvent = false;
  const scan = (start: number, collectAppendedResponses: boolean): {
    lineCount: number; completeLineCount: number; completeLineOffset: number; terminated: boolean; malformed: boolean;
  } => {
    let scannedLineNum = start === 0 ? 0 : (appendCandidate ? prior!.lineCount : 0);
    let scannedCompleteLineCount = start === 0 ? 0 : (appendCandidate ? prior!.lineCount : 0);
    let scannedCompleteLineOffset = start === 0 ? 0 : (appendCandidate ? prior!.completeLineOffset! : 0);
    let scannedTerminated = start === 0 ? true : (appendCandidate ? prior!.terminated : true);
    let malformed = false;
    readSourceLines((line: string, lineTerminated: boolean, endOffset?: number) => {
      scannedTerminated = lineTerminated;
      if (!lineTerminated) return;
      scannedLineNum++;
      scannedCompleteLineCount++;
      if (endOffset !== undefined) scannedCompleteLineOffset = endOffset;
      // Parse every completed record before emitting anything. A malformed
      // complete JSONL line is not a partial tail and must not publish a
      // replacement assembled from only a source prefix.
      let obj: any;
      try {
        obj = JSON.parse(line);
        if (metrics) metrics.jsonLinesParsed++;
      } catch {
        malformed = true;
        return;
      }
      if (metaRecord === null && obj?.type === 'session_meta' && obj.payload?.id) {
        metaRecord = { lineNum: scannedLineNum, obj };
      }
      sawAutoReviewModel ||= obj?.payload?.model === 'codex-auto-review'
        || obj?.model === 'codex-auto-review';
      const payload = obj?.payload || {};
      if (obj?.type === 'event_msg') {
        sawUserMessageEvent ||= payload.type === 'user_message';
        if (payload.type === 'user_message' || payload.type === 'agent_message') {
          const text = codexEventText(payload);
          if (text !== null) {
            const key = visibleMessageDigest(payload.type === 'user_message' ? 'user' : 'assistant', text);
            eventMessageKeys.add(key);
            if (collectAppendedResponses) {
              appendedEventMessageKeys.add(key);
              if (payload.type === 'user_message') appendedUserPromptKeys.add(visibleMessageDigest('user-prompt', text));
            }
          }
        }
      } else if (collectAppendedResponses && obj?.type === 'response_item'
        && payload.type === 'message' && payload.role !== 'developer') {
        const text = codexMessagePayloadText(payload);
        if (text !== null) appendedResponseMessageKeys.add(visibleMessageDigest(payload.role || 'assistant', text));
      }
    }, {
      start,
      onBytesRead: (bytes) => {
        if (metrics) {
          metrics.sourceBytesRead += bytes;
          if (start > 0) metrics.suffixBytesRead += bytes;
        }
      },
    });
    return {
      lineCount: scannedLineNum,
      completeLineCount: scannedCompleteLineCount,
      completeLineOffset: scannedCompleteLineOffset,
      terminated: scannedTerminated,
      malformed,
    };
  };
  testHooks?.beforeScan?.();
  let scanResult = scan(appendCandidate ? prior.size : 0, appendCandidate);
  testHooks?.afterScan?.();
  const afterScan = codexStatSync(unit.key);
  // A read-time mutation is transient: keep the old cursor and let the next
  // build retry. A malformed completed JSONL line is a durable source defect
  // and fails closed. With a prior checkpoint the throw surfaces the frozen
  // source through the build's skipped-file diagnostics while the per-unit
  // rollback preserves the old cursor; without one (force rebuild, first
  // sight of the source) the unit stays silent so a single corrupt archive
  // file cannot block a whole-snapshot rebuild.
  if (!sameStat(stat, afterScan)) return _cursor;
  if (scanResult.malformed) {
    if (prior === null && (!compressed || _cursor === null)) return _cursor;
    throw new Error(CODEX_MALFORMED_LINE_ERROR);
  }
  const priorCompleteLineOffset = appendCandidate ? prior!.completeLineOffset! : null;
  if (priorCompleteLineOffset !== null && (afterScan.size < prior!.size || scanResult.completeLineOffset < priorCompleteLineOffset)) return _cursor;
  if (priorCompleteLineOffset !== null && scanResult.completeLineOffset === priorCompleteLineOffset) {
    // Bytes without a final newline are not a consumable append. Keep the old
    // cursor and emit no aggregate so the next pass re-reads that partial line.
    if (stat.size > prior!.size) return _cursor;
    // A same-size source whose prefix fingerprint just matched changed only
    // its stat timestamps (cp -p / rsync -a preserve mtime and size while
    // ctime necessarily changes). Returning the old cursor would never heal:
    // discovery keeps re-planning the unit and every build repeats the O(N)
    // fingerprint. The verified prefix justifies refreshing the cursor's
    // stat legs; a metadata-only change patches the aggregate exactly like
    // the unchanged-stat no-op path above.
    if (metrics) metrics.plan = 'verified-append';
    const prev = prior!;
    const { lineCount, size, ctimeMs: _ctimeMs, inode: _inode, ...state } = prev;
    const parentRawId = metadataChanged ? codexParentThreadId(prev.meta) : null;
    if (metadataChanged && !parentRawId) {
      // A child has no independent session aggregate to patch (see above);
      // it still heals its stat legs so discovery stops re-planning it.
      const endedAt = indexedMeta?.indexedUpdatedAt && (!prev.endedAt || indexedMeta.indexedUpdatedAt > prev.endedAt)
        ? indexedMeta.indexedUpdatedAt
        : prev.endedAt;
      yield {
        kind: 'session', id: codexDbId(prev.threadRawId, rootScope) as string,
        title: prev.threadTitle ?? indexedMeta?.indexedTitle ?? null,
        project: projectSlugFromPath(normalizeObservedCwd(prev.meta.cwd)),
        started_at: prev.startedAt, ended_at: endedAt, git_branch: prev.gitBranch,
        version: prev.version, message_count: prev.messageCount, countMode: 'total',
        jsonl_path: unit.key, source: 'codex',
      };
      return encodeCodexCursor(stat, lineCount, size, {
        ...state,
        indexedTitle: indexedMeta?.indexedTitle,
        indexedUpdatedAt: indexedMeta?.indexedUpdatedAt ?? undefined,
        endedAt,
      });
    }
    return encodeCodexCursor(stat, lineCount, size, state);
  }
  const priorEventBloom = appendCandidate ? decodeBloom(prior.eventMessageBloom)! : emptyBloom();
  const priorResponseBloom = appendCandidate ? decodeBloom(prior.responseMessageBloom)! : emptyBloom();
  // Bloom filters have no false negatives. A possible cross-boundary duplicate
  // therefore falls back to the exact full replay; false positives cost time,
  // never rows. This keeps the cursor bounded without weakening deduplication.
  const possibleCrossBoundaryDuplicate = appendCandidate && (
    [...appendedEventMessageKeys].some(key => bloomMightContain(priorResponseBloom, key))
      || [...appendedResponseMessageKeys].some(key => bloomMightContain(priorEventBloom, key))
  );
  // Whether a user-role response item is the person's depends on whether the
  // thread records prompts as events at all. Rows emitted before the first
  // such event were judged without it, so its arrival replays the thread.
  const firstUserMessageEvent = appendCandidate && sawUserMessageEvent && prior.userMessageEvents !== true;
  // Multipart items use a separate digest domain in the bounded response bloom:
  // an eventual prompt event changes their labels, not their stored identities.
  const possiblePromptLabelChange = appendCandidate
    && [...appendedUserPromptKeys].some(key => bloomMightContain(priorResponseBloom, key));
  // A label-only replay updates existing rows in place. It has no obsolete
  // identities to retract, and deleting the shared session here would erase
  // unchanged child rollouts that discovery correctly did not schedule.
  const labelsOnlyReplay = (firstUserMessageEvent || possiblePromptLabelChange) && !possibleCrossBoundaryDuplicate;
  const fast = appendCandidate && !possibleCrossBoundaryDuplicate && !firstUserMessageEvent && !possiblePromptLabelChange;
  if (metrics) metrics.plan = fast
    ? (cooperativeAppend ? 'cooperative-append' : 'verified-append')
    : 'snapshot';
  if (appendCandidate && !fast) {
    eventMessageKeys.clear();
    metaRecord = null;
    sawAutoReviewModel = false;
    sawUserMessageEvent = false;
    scanResult = scan(0, false);
    if (!sameStat(stat, codexStatSync(unit.key))) return _cursor;
    if (scanResult.malformed) throw new Error(CODEX_MALFORMED_LINE_ERROR);
  }
  const { lineCount: lineNum, completeLineCount, completeLineOffset, terminated } = scanResult;
  const eventMessageBloom = fast ? priorEventBloom : emptyBloom();
  const responseMessageBloom = fast ? priorResponseBloom : emptyBloom();
  for (const key of eventMessageKeys) bloomAdd(eventMessageBloom, key);
  const previous = fast ? prior : null;
  const userMessageEvents = sawUserMessageEvent || previous?.userMessageEvents === true;
  const basicCursor = compressed
    ? encodeCodexZstCursor(stat, completeLineCount, rootScope)
    : `${stat.mtimeMs}:${completeLineCount}:${completeLineOffset}:${stat.ctimeMs}:${stat.inoExact}:${CODEX_BASIC_CURSOR_TAG}:${stat.devExact}${rootScope === null ? '' : `:${rootScope}`}`;
  const capturedMeta = metaRecord as { lineNum: number; obj: any } | null;
  if (capturedMeta === null) return basicCursor;

  const rawMeta = capturedMeta.obj.payload as Record<string, any>;
  const meta = checkpointMeta(rawMeta);
  const threadRawId = codexRawId(rawMeta.id) as string;
  if (codexIsGuardianThread(meta, sawAutoReviewModel ? [{ lineNum: 0, obj: { model: 'codex-auto-review' } }] : [])) {
    // Guardian children previously contributed rows to their parent projection.
    // `delete-session` is intentionally keyed by the child db id: persist()
    // deletes rows where that value is `agent_id`, while preserving the shared
    // parent session and sibling/root contributions.
    yield { kind: 'delete-session', sessionId: codexDbId(threadRawId, rootScope) as string };
    return basicCursor;
  }

  const parentRawId = codexParentThreadId(meta);
  const sessionId = codexDbId(parentRawId || threadRawId, rootScope) as string;
  const agentId = (parentRawId ? codexDbId(threadRawId, rootScope) : null) as string | null;
  const isSidechain: 0 | 1 = agentId ? 1 : 0;
  const project = projectSlugFromPath(normalizeObservedCwd(meta.cwd));
  const lineUuid = (n: number): string => codexLineUuid(threadRawId, n, rootScope) as string;
  const callMessageUuids = new Map(Object.entries(previous?.openCallMessageUuids ?? {}));
  const openCallMessageUuids = new Map(callMessageUuids);
  // A full snapshot can reconstruct open calls from the whole source even if
  // the previous cooperative checkpoint deliberately marked its state partial.
  let stateComplete = appendCandidate ? previous?.stateComplete !== false : true;
  const rememberOpenCall = (toolId: string, uuid: string): void => {
    if (!stateComplete) return;
    openCallMessageUuids.set(toolId, uuid);
    if (openCallMessageUuids.size > CODEX_MAX_OPEN_CALLS) {
      stateComplete = false;
      openCallMessageUuids.clear();
    }
  };

  const out: TranscriptRecord[] = [];
  // A child rollout contributes to its parent projection. Replaying only this
  // child cannot safely retract the whole parent session; leave destructive
  // replacement to orchestration that replays the complete contributing tree.
  const canRetract = (sourceMeta?.replaceSnapshot || (_cursor !== null && !fast && !labelsOnlyReplay)) && !agentId;
  if (canRetract) out.push({ kind: 'delete-session', sessionId });
  const msgByUuid = new Map<string, MessageRecord>();
  const emittedMessageUuids = new Set<string>();
  const initialTimestamp = normalizeTranscriptTimestamp(meta.timestamp || capturedMeta.obj.timestamp);
  const indexedUpdatedAt = indexedMeta?.indexedUpdatedAt ?? null;
  const sm = {
    started_at: previous?.startedAt ?? initialTimestamp,
    ended_at: previous?.endedAt ?? initialTimestamp,
    git_branch: previous?.gitBranch ?? (meta.git?.branch || null) as string | null,
    version: previous?.version ?? (meta.cli_version || null) as string | null,
    threadTitle: previous?.threadTitle ?? null,
    n: previous?.messageCount ?? 0,
    lastMessageUuid: previous?.lastMessageUuid ?? null,
    lastTextAssistantUuid: previous?.lastTextAssistant?.uuid ?? null,
    totalInputTokens: previous?.totalInputTokens ?? 0,
    totalOutputTokens: previous?.totalOutputTokens ?? 0,
  };
  if (indexedUpdatedAt && (!sm.ended_at || indexedUpdatedAt > sm.ended_at)) sm.ended_at = indexedUpdatedAt;

  let currentCwd = previous?.currentCwd ?? normalizeObservedCwd(meta.cwd);
  let currentModel = previous?.currentModel ?? null;
  let lastTextAssistant = previous?.lastTextAssistant === null || previous?.lastTextAssistant === undefined
    ? null
    : { ...previous.lastTextAssistant };
  if (lastTextAssistant !== null) msgByUuid.set(lastTextAssistant.uuid, lastTextAssistant);

  const updateBounds = (ts: string | null) => {
    if (!ts) return;
    if (!sm.started_at || ts < sm.started_at) sm.started_at = ts;
    if (!sm.ended_at || ts > sm.ended_at) sm.ended_at = ts;
  };

  const insertMessage = ({ uuid, type, role, text = null, contentType = 'text', timestamp, isMeta = 0 }: {
    uuid: string; type: string; role: string; text?: string | null; contentType?: string; timestamp: string | null; isMeta?: 0 | 1;
  }) => {
    const visibility = messageVisibility(role, text);
    const skillInstructions = role === 'user' && isSkillInstructions(text);
    // A hidden message is one of Codex's context envelopes. A user-role item
    // that no prompt event stands for is Codex's too; nothing says what it is.
    const harnessKind = skillInstructions ? 'skill'
      : visibility === 'hidden' ? 'reminder'
        : extractHarnessKind({}, text) ?? (isMeta ? 'other' : null);
    const rec: MessageRecord = {
      kind: 'message', uuid, session_id: sessionId, type, parent_uuid: sm.lastMessageUuid,
      timestamp: timestamp || null, role, text: trunc(text),
      content_type: skillInstructions ? 'skill_instructions' : contentType,
      is_meta: harnessKind === null ? 0 : 1, harness_kind: harnessKind, visibility,
      model: currentModel, is_sidechain: isSidechain, agent_id: agentId,
      input_tokens: null, output_tokens: null, cwd: currentCwd, skill: null, source: 'codex',
    };
    out.push(rec);
    emittedMessageUuids.add(uuid);
    msgByUuid.set(uuid, rec);
    sm.lastMessageUuid = uuid;
    if (!agentId && visibility === 'visible') sm.n++;
    if (type === 'assistant' && contentType === 'text') {
      sm.lastTextAssistantUuid = uuid;
      lastTextAssistant = rec;
    }
    updateBounds(timestamp);
    return uuid;
  };

  const processRecord = (currentLine: number, obj: any): void => {
    const ts = normalizeTranscriptTimestamp(obj.timestamp);
    if (obj.type === 'session_meta') {
      if (obj.payload?.cwd) currentCwd = normalizeObservedCwd(obj.payload.cwd) || currentCwd;
      if (obj.payload?.git?.branch) sm.git_branch = obj.payload.git.branch;
      if (obj.payload?.cli_version) sm.version = obj.payload.cli_version;
      updateBounds(normalizeTranscriptTimestamp(obj.payload?.timestamp) || ts);
      return;
    }
    if (obj.type === 'turn_context') {
      currentCwd = normalizeObservedCwd(obj.payload?.cwd) || currentCwd;
      currentModel = obj.payload?.model || currentModel;
      updateBounds(ts);
      return;
    }
    if (obj.type === 'event_msg') {
      const payload = obj.payload || {};
      if (payload.type === 'user_message' || payload.type === 'agent_message' || payload.type === 'agent_reasoning') {
        const text = codexEventText(payload);
        if (text === null) return;
        const isReasoning = payload.type === 'agent_reasoning';
        insertMessage({
          uuid: lineUuid(currentLine),
          type: payload.type === 'user_message' ? 'user' : 'assistant',
          role: payload.type === 'user_message' ? 'user' : 'assistant',
          text, contentType: isReasoning ? 'thinking' : 'text', timestamp: ts,
        });
        return;
      }
      if (payload.type === 'collab_agent_spawn_end' && payload.call_id && payload.new_thread_id) {
        const uuid = insertMessage({ uuid: lineUuid(currentLine), type: 'assistant', role: 'assistant', text: null, contentType: 'tool_use', timestamp: ts });
        const toolId = codexCallId(threadRawId, payload.call_id, rootScope) as string;
        const description = payload.new_agent_nickname || payload.new_agent_role || 'Agent';
        const input = {
          description, subagent_type: payload.new_agent_role || 'Agent', prompt: payload.prompt || '',
          new_thread_id: payload.new_thread_id, model: payload.model || null, reasoning_effort: payload.reasoning_effort || null,
        };
        out.push({ kind: 'tool_call', id: toolId, message_uuid: uuid, session_id: sessionId, name: 'Agent', presentation: 'default', input_json: truncJson(input) as string, file_path: null });
        callMessageUuids.set(toolId, uuid);
        rememberOpenCall(toolId, uuid);
        out.push({ kind: 'subagent', agent_id: codexDbId(payload.new_thread_id, rootScope) as string, session_id: sessionId, parent_tool_use_id: toolId, agent_type: payload.new_agent_role || null, description });
        return;
      }
      if (payload.type === 'task_complete') {
        if (sm.lastTextAssistantUuid && payload.duration_ms !== undefined) {
          out.push({ kind: 'message-turn-duration', uuid: sm.lastTextAssistantUuid, turn_duration_ms: payload.duration_ms || null });
        }
        updateBounds(ts);
        return;
      }
      if (payload.type === 'token_count') {
        const usage = codexUsage(payload);
        if (usage.inputTokens != null) sm.totalInputTokens = usage.inputTokens;
        if (usage.outputTokens != null) sm.totalOutputTokens = usage.outputTokens;
        if (sm.lastTextAssistantUuid && (usage.inputTokens != null || usage.outputTokens != null)) {
          const rec = msgByUuid.get(sm.lastTextAssistantUuid);
          if (rec) {
            rec.input_tokens = usage.inputTokens;
            rec.output_tokens = usage.outputTokens;
            if (!emittedMessageUuids.has(rec.uuid)) {
              out.push(rec);
              emittedMessageUuids.add(rec.uuid);
            }
          }
        }
        return;
      }
      if (payload.type === 'thread_name_updated' && payload.thread_name) sm.threadTitle = payload.thread_name;
      return;
    }
    if (obj.type !== 'response_item') return;
    const payload = obj.payload || {};
    if (payload.type === 'message' && payload.role !== 'developer') {
      const text = codexMessagePayloadText(payload);
      const role = payload.role || 'assistant';
      const key = text === null ? null : visibleMessageDigest(role, text);
      if (text !== null && key !== null && !eventMessageKeys.has(key)) {
        // Codex records each prompt the person typed as a `user_message` event
        // with a user-role response item beside it. In a thread that has such
        // events, a user-role item without one was put there by Codex itself
        // (session preamble, the notice left by an aborted turn). A thread with
        // no such event at all keeps its prompts only as response items.
        // UserMessageItem::message in Codex concatenates text inputs without
        // separators. Keep our existing stored text/identity representation,
        // but do not infer harness authorship from that formatting difference.
        const promptText = role === 'user' ? codexMessagePayloadText(payload, '') : null;
        const promptKey = promptText === null ? null : visibleMessageDigest('user', promptText);
        const possibleHumanPrompt = promptKey !== null && (eventMessageKeys.has(promptKey)
          || (fast && bloomMightContain(priorEventBloom, promptKey)));
        const injected = role === 'user' && userMessageEvents && !possibleHumanPrompt;
        insertMessage({ uuid: lineUuid(currentLine), type: role === 'user' ? 'user' : 'assistant', role, text, contentType: 'text', timestamp: ts, isMeta: injected ? 1 : 0 });
        bloomAdd(responseMessageBloom, key);
        if (promptText !== null && promptText !== text) {
          bloomAdd(responseMessageBloom, visibleMessageDigest('user-prompt', promptText));
        }
      }
      return;
    }
    if (['function_call', 'custom_tool_call', 'tool_search_call', 'web_search_call'].includes(payload.type) && payload.call_id) {
      const uuid = insertMessage({ uuid: lineUuid(currentLine), type: 'assistant', role: 'assistant', text: null, contentType: 'tool_use', timestamp: ts });
      const name = payload.name || payload.tool || payload.type.replace(/_call$/, '');
      const toolId = codexCallId(threadRawId, payload.call_id, rootScope) as string;
      out.push({ kind: 'tool_call', id: toolId, message_uuid: uuid, session_id: sessionId, name, presentation: name === 'Skill' ? 'skill' : 'default', input_json: truncJson(codexToolInput(payload)) as string, file_path: null });
      callMessageUuids.set(toolId, uuid);
      rememberOpenCall(toolId, uuid);
      return;
    }
    if (['function_call_output', 'custom_tool_call_output', 'tool_search_output'].includes(payload.type) && payload.call_id) {
      const toolId = codexCallId(threadRawId, payload.call_id, rootScope) as string;
      const messageUuid = callMessageUuids.get(toolId) || '';
      // Preserve the source result even when malformed input has no matching
      // call. An empty anchor is explicit evidence of the missing association;
      // silently dropping the source record would create a timeline hole.
      out.push({ kind: 'tool_result', tool_use_id: toolId, message_uuid: messageUuid, session_id: sessionId, content: trunc(codexToolOutput(payload) || ''), file_path: null, is_error: payload.is_error ? 1 : 0 });
      openCallMessageUuids.delete(toolId);
    }
  };

  let currentLine = fast ? prior!.lineCount : 0;
  const emitStart = fast ? prior!.size : 0;
  readSourceLines((line: string, lineTerminated: boolean) => {
    if (!lineTerminated) return;
    currentLine++;
    try {
      processRecord(currentLine, JSON.parse(line));
      if (metrics) metrics.jsonLinesParsed++;
    } catch { /* pre-scan already rejected malformed complete lines */ }
  }, {
    start: emitStart,
    onBytesRead: (bytes) => {
      if (metrics) {
        metrics.sourceBytesRead += bytes;
        if (emitStart > 0) metrics.suffixBytesRead += bytes;
      }
    },
  });
  const afterParse = codexStatSync(unit.key);
  // `out` is only a staging buffer. If the source changed during the second
  // pass, abandon before adding aggregates or yielding anything; returning an
  // old cursor after emitting a mixed view would split source and projection.
  if (currentLine !== lineNum || !sameStat(stat, afterParse)) return _cursor;

  if (agentId) {
    const started = sm.started_at ? new Date(sm.started_at).getTime() : null;
    const ended = sm.ended_at ? new Date(sm.ended_at).getTime() : null;
    const tokenTotal = (sm.totalInputTokens || 0) + (sm.totalOutputTokens || 0);
    out.push({
      kind: 'subagent', agent_id: agentId, session_id: sessionId,
      agent_type: codexAgentRole(meta), description: codexAgentNickname(meta),
      duration_ms: started && ended ? ended - started : null, total_tokens: tokenTotal || null,
    });
  } else {
    out.push({
      kind: 'session', id: sessionId, title: sm.threadTitle ?? indexedMeta?.indexedTitle ?? null, project,
      started_at: sm.started_at, ended_at: sm.ended_at, git_branch: sm.git_branch, version: sm.version,
      message_count: sm.n, countMode: 'total', jsonl_path: unit.key, source: 'codex',
    });
  }

  const checkpointSize = completeLineOffset;
  const outCursor = compressed
    ? encodeCodexZstCursor(stat, completeLineCount, rootScope)
    : encodeCodexCursor(stat, completeLineCount, checkpointSize, {
        v: CODEX_CURSOR_STATE_VERSION,
        threadRawId,
        ...(rootScope !== null ? { rootScope } : {}),
        meta,
        completeLineOffset: checkpointSize,
        sourceSize: stat.size,
        dev: stat.devExact,
        sourceInode: stat.inoExact,
        sourceIdentityEncoding: 'uint64-decimal-v1',
        // A complete initial snapshot is verified by definition. Cooperative
        // append keeps the old hashes only as stale metadata and must not claim
        // that the enlarged prefix was verified.
        verifiedPrefix: !cooperativeCandidate
          && fingerprint.complete
          && (prior === null || fingerprint.prefixMatches),
        stateComplete,
        userMessageEvents,
        indexedTitle: indexedMeta?.indexedTitle,
        indexedUpdatedAt: indexedMeta?.indexedUpdatedAt ?? undefined,
        chunkHashes: fingerprint.chunkHashes,
        eventMessageBloom: eventMessageBloom.toString('base64url'),
        responseMessageBloom: responseMessageBloom.toString('base64url'),
        openCallMessageUuids: Object.fromEntries(openCallMessageUuids),
        terminated,
        currentCwd,
        currentModel,
        lastMessageUuid: sm.lastMessageUuid,
        lastTextAssistant,
        startedAt: sm.started_at,
        endedAt: sm.ended_at,
        gitBranch: sm.git_branch,
        version: sm.version,
        threadTitle: sm.threadTitle,
        messageCount: sm.n,
        totalInputTokens: sm.totalInputTokens,
        totalOutputTokens: sm.totalOutputTokens,
      });
  if (metrics) metrics.emittedRecords += out.length;
  yield* out;
  return outCursor;
}

function existingCodexRepresentation(path: string): string | null {
  const plain = isCodexCompressedPath(path)
    ? path.slice(0, -'.zst'.length)
    : path;
  if (existsSync(plain)) return plain;
  if (existsSync(`${plain}.zst`)) return `${plain}.zst`;
  return null;
}

function findCodexFile(rootDir: string, rawThreadId: string): string | null {
  const stack = codexTranscriptDirs(rootDir);
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (!existsSync(current)) continue;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
      } else if (
        entry.isFile()
        && (entry.name.endsWith(`${rawThreadId}.jsonl`) || entry.name.endsWith(`${rawThreadId}.jsonl.zst`))
      ) {
        const resolved = existingCodexRepresentation(path);
        if (resolved !== null) return resolved;
      }
    }
  }
  return null;
}

interface CodexRootEntry {
  readonly rootDir: string;
  readonly rootScope: string | null;
  readonly aliases: string[];
}

function parseCodexMessageUuid(messageUuid: string): { rootScope: string | null; threadRawId: string; lineNum: number } | null {
  const bare = /^codex:([^:]+):(\d+)$/.exec(messageUuid);
  if (bare !== null) {
    return { rootScope: null, threadRawId: bare[1]!, lineNum: Number(bare[2]) };
  }
  const scoped = /^codex:([^:]+):([^:]+):(\d+)$/.exec(messageUuid);
  if (scoped !== null) {
    return { rootScope: scoped[1]!, threadRawId: scoped[2]!, lineNum: Number(scoped[3]) };
  }
  return null;
}

function deriveCodexRootFromSessionPath(jsonlPath: string): string | null {
  const normalized = normalize(jsonlPath);
  const index = Math.max(
    normalized.lastIndexOf(`${sep}${CODEX_SESSIONS_DIR}${sep}`),
    normalized.lastIndexOf(`${sep}${CODEX_ARCHIVED_SESSIONS_DIR}${sep}`),
  );
  return index > 0 ? normalized.slice(0, index) : null;
}

// Verify the preceding chunks as well as the target line's chunks. The raw
// UUID is a line ordinal, so unverified earlier bytes could shift its meaning.
function readVerifiedCodexRawLines(
  path: string,
  prior: DecodedCodexCursor,
  visit: (line: string) => boolean | void,
): void {
  const sourceSize = prior.sourceSize ?? prior.size;
  const committed = prior.completeLineOffset ?? prior.size;
  const chunkSize = CODEX_FINGERPRINT_CHUNK_BYTES;
  if (!prior.verifiedPrefix || committed <= 0 || committed > sourceSize
    || prior.chunkHashes.length !== Math.ceil(sourceSize / chunkSize)) return;

  const fd = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(Math.min(chunkSize, sourceSize));
  let remainder = Buffer.alloc(0);
  try {
    for (let offset = 0; offset < committed; offset += chunkSize) {
      const length = Math.min(chunkSize, sourceSize - offset);
      let filled = 0;
      while (filled < length) {
        const count = readSync(fd, buffer, filled, length - filled, offset + filled);
        if (count === 0) return;
        filled += count;
      }
      if (sha256(buffer.subarray(0, length)) !== prior.chunkHashes[offset / chunkSize]) return;
      const chunk = buffer.subarray(0, Math.min(length, committed - offset));
      const data = remainder.length === 0 ? chunk : Buffer.concat([remainder, chunk]);
      const lastNewline = data.lastIndexOf(0x0a);
      let stopped = false;
      readCodexBufferLines(data.subarray(0, lastNewline + 1), line => {
        if (visit(line) === false) {
          stopped = true;
          return false;
        }
      });
      if (stopped) return;
      remainder = Buffer.from(data.subarray(lastNewline + 1));
    }
  } finally {
    closeSync(fd);
  }
}

function rawCodex(
  rootEntries: readonly CodexRootEntry[],
  input: RawLookup,
): RawRecord | null {
  const parsed = parseCodexMessageUuid(input.messageUuid);
  if (parsed === null) return null;
  const sessionPath = typeof input.session?.jsonl_path === 'string' ? input.session.jsonl_path : null;
  const derivedRoot = sessionPath === null ? null : deriveCodexRootFromSessionPath(sessionPath);
  const physicalRoot = derivedRoot === null ? null : tryRealpath(derivedRoot);
  const resolvedPath = input.agentId === null && sessionPath !== null
    ? existingCodexRepresentation(sessionPath)
    : (derivedRoot === null ? rootEntries.filter(entry => entry.rootScope === parsed.rootScope).map(entry => entry.rootDir) : [derivedRoot])
      .map(root => findCodexFile(root, parsed.threadRawId)).find(path => path !== null) ?? null;
  if (resolvedPath === null) return null;
  const verifySource = input.cursorForPath !== undefined || input.cursor != null || derivedRoot !== physicalRoot;
  let readPath = resolvedPath;
  let sourceCursor: Cursor = null;
  let verifiedPrefix: DecodedCodexCursor | null = null;
  if (verifySource) {
    if (derivedRoot === null || physicalRoot === null) return null;
    const sourceDir = codexTranscriptDirs(derivedRoot).find(dir => pathInside(dir, resolvedPath));
    const physicalDir = sourceDir === undefined ? null : tryRealpath(sourceDir);
    if (sourceDir === undefined || physicalDir === null) return null;
    const physicalPath = tryRealpath(resolvedPath);
    // Discovery follows the transcript directory itself, then skips symlink
    // entries during its walk. Raw reads must use the same source boundary.
    if (physicalPath !== join(physicalDir, relative(sourceDir, resolvedPath))) return null;
    const store = readCodexStore(input.cursor ?? null);
    if (store !== null && store.identity !== codexDirectoryIdentity(physicalRoot)) return null;
    sourceCursor = input.agentId === null
      ? input.cursor ?? null
      : input.cursorForPath?.(resolvedPath) ?? null;
    if (!cursorIdentifiesCodexFile(sourceCursor, physicalPath)) {
      try {
        const stat = codexStatSync(physicalPath);
        if (!stat.isFile() || isCodexCompressedPath(physicalPath)
          || (codexFileIdentity(sourceCursor)?.exact && usableSourceIdentity(stat))) return null;
      } catch { return null; }
      verifiedPrefix = decodeCodexCursor(sourceCursor);
      if (verifiedPrefix?.threadRawId !== parsed.threadRawId || !verifiedPrefix.verifiedPrefix) return null;
    }
    readPath = physicalPath;
  }
  let lineNumber = 0;
  let found: string | null = null;
  let verifiedThread = !verifySource;
  const visit = (line: string) => {
    lineNumber++;
    if (!verifiedThread) {
      try {
        const record = JSON.parse(line);
        if (record?.type === 'session_meta') {
          const parent = codexParentThreadId(record.payload);
          if (codexRawId(record.payload?.id) !== parsed.threadRawId
            || (input.agentId !== null && codexDbId(parent, parsed.rootScope) !== input.session?.id)) return false;
          verifiedThread = true;
        }
      } catch { /* malformed source line */ }
    }
    if (lineNumber !== parsed.lineNum) return;
    if (!verifiedThread) return false;
    found = line;
    return false;
  };
  if (verifiedPrefix === null) {
    readCodexLines(readPath, visit);
    if (verifySource && !cursorIdentifiesCodexFile(sourceCursor, readPath)) return null;
  } else {
    try { readVerifiedCodexRawLines(readPath, verifiedPrefix, visit); } catch { return null; }
  }
  const raw = found as string | null;
  let messageText: string | null = null;
  if (raw !== null) {
    try {
      const obj = JSON.parse(raw);
      const payload = obj?.payload ?? {};
      if (obj?.type === 'event_msg') {
        messageText = typeof payload.message === 'string'
          ? payload.message
          : typeof payload.text === 'string'
            ? payload.text
            : null;
      } else if (obj?.type === 'response_item' && payload.type === 'message' && Array.isArray(payload.content)) {
        messageText = codexMessagePayloadText(payload);
      }
    } catch { /* malformed source line */ }
  }
  return raw === null
    ? null
    : { text: raw, totalLength: raw.length, offset: 0, limit: raw.length, hasMore: false, messageText };
}

export function createCodexProvider({
  rootDir,
  roots,
  homeDir = homedir(),
  cwd = process.cwd(),
}: {
  rootDir?: string;
  roots?: readonly string[];
  homeDir?: string;
  cwd?: string;
} = {}): ProviderAdapter {
  const usesRootSet = roots !== undefined;
  const rawList = usesRootSet
    ? roots
    : [rootDir ?? defaultCodexHome({ homeDir, cwd })];
  const rootEntries: CodexRootEntry[] = [];
  for (const candidate of rawList) {
    const normalized = normalize(candidate);
    rootEntries.push({
      rootDir: normalized,
      rootScope: null,
      aliases: [normalized],
    });
  }
  const descriptorRoot = rootDir ?? rootEntries[0]?.rootDir ?? defaultCodexHome({ homeDir, cwd });
  const sourceRoots = rootEntries.map((entry) => entry.rootDir);
  const resolvedRootEntries = (): CodexRootEntry[] => {
    if (!usesRootSet) return rootEntries;
    const grouped = new Map<string, CodexRootEntry>();
    for (const entry of rootEntries) {
      const canonical = canonicalCodexRoot(entry.rootDir);
      const existing = grouped.get(canonical);
      if (existing !== undefined) {
        existing.aliases.push(entry.rootDir);
      } else {
        grouped.set(canonical, {
          rootDir: canonical,
          rootScope: codexRootScope(canonical, homeDir),
          aliases: [...new Set([canonical, entry.rootDir])],
        });
      }
    }
    return [...grouped.values()];
  };

  return {
    name,
    descriptor: { id: name, name: 'Codex', vendor: 'OpenAI', defaultRoot: descriptorRoot, color: '#10a37f' },
    indexVersionMarker: CODEX_CANONICAL_TRANSCRIPT_MARKER,
    watchTargets: (configuredRoot) => (
      usesRootSet && sameCodexRootPath(configuredRoot, descriptorRoot) ? sourceRoots : [configuredRoot]
    ).flatMap((root) => [
      ...codexTranscriptDirs(root).map((dir) => ({ kind: 'tree' as const, path: dir })),
      { kind: 'file' as const, path: join(root, 'session_index.jsonl') },
    ]),
    discover: (ctx) => {
      let entries = resolvedRootEntries();
      const defaultRoot = lexicalCodexRoot(join(homeDir, '.codex'));
      const knownEntries = new Map(entries.map(entry => [entry.rootDir, codexDirectoryIdentity(entry.rootDir)]));
      const observedIdentities = new Set(knownEntries.values());
      const missingEntries = entries.filter(entry => checkDirStatus(entry.rootDir) === 'missing');
      const prior = (ctx.indexedSessions?.() ?? []).map(session => {
        const cursor = ctx.previousCursor?.(session.jsonlPath) ?? ctx.lastCursor(session.jsonlPath);
        const store = readCodexStore(cursor);
        return {
          session, store, cursor, root: deriveCodexRootFromSessionPath(session.jsonlPath),
          hasCursor: cursor !== null, file: store === null ? codexFileIdentity(cursor) : null,
          legacyMtime: cursor === null ? Number.NaN : Number(/^([^:]+):\d+$/.exec(cursor)?.[1]),
        };
      });
      const aliasesByIdentity = new Map<string, Set<string>>();
      // A path may be selected again after a refresh through a different alias.
      // Keep previous alias evidence attached to the directory that was indexed.
      for (const { store } of prior) {
        if (store === null || !observedIdentities.has(store.identity)) continue;
        const aliases = aliasesByIdentity.get(store.identity) ?? new Set<string>();
        for (const alias of store.aliases) aliases.add(alias);
        aliasesByIdentity.set(store.identity, aliases);
      }
      const unavailable = (session: typeof prior[number]['session'], error: string): void => {
        ctx.retainSession?.(session.sessionId);
        ctx.reportIncompleteInventory?.({ path: session.jsonlPath, error });
      };
      const incomingBareRoot = entries.find(entry => entry.rootScope === null)?.rootDir;
      const defaultTarget = tryRealpath(defaultRoot) ?? defaultRoot;
      const retainedBareRoots = new Set<string>();
      const blockedRoots = new Set<string>();
      const unverifiedMembers = new Set<string>();
      const recoveredRoots = new Map<string, string>();
      const confirmedGuardians = new Map<string, { sessionId: string; mtime: number }>();
      const verifiedLegacyRoots = new Set<string>();
      // Legacy checkpoints describe individual rollouts. An unchanged
      // sibling or a renamed copy of the same file can establish continuity
      // before applying normal replacement semantics at a physical root.
      for (const { session, file, root, store } of prior) {
        if (store === null && root !== null && knownEntries.get(root) != null
          && codexFileMatches(file, session.jsonlPath, { unshared: true })) verifiedLegacyRoots.add(root);
      }
      for (const { session, file, root, store } of prior) {
        if (store === null && root !== null && knownEntries.get(root) != null && !verifiedLegacyRoots.has(root)
          && hasRenamedCodexRollout(file, session.jsonlPath)) verifiedLegacyRoots.add(root);
      }
      let defaultDisplaced = false;
      for (const { session, file, cursor, hasCursor, legacyMtime, root, store } of prior) {
        if (root === null) continue;
        const rootIdentity = knownEntries.get(root);
        const reachedByAlias = store !== null && observedIdentities.has(store.identity);
        if (missingEntries.some(entry => (
          store !== null ? store.aliases.includes(entry.rootDir) && !reachedByAlias
            : !knownEntries.has(root) && !knownEntries.has(tryRealpath(root) ?? root)
        ))) {
          unavailable(session, 'Source folder is unavailable');
        }
        const exactSourceMatches = store === null
          && cursorIdentifiesCodexFile(cursor, session.jsonlPath, { unshared: true });
        const sourceMatches = store === null && exactSourceMatches;
        const legacyPhysicalCustom = store === null && root !== defaultRoot && rootIdentity != null
          && incomingBareRoot === defaultRoot && defaultTarget === defaultRoot
          && tryRealpath(root) === root && exactSourceMatches;
        // Pre-feature cursors used lexical paths even through a symlink. A
        // verified different physical path is the documented custom migration.
        const historicalDefault = usesRootSet && (store?.defaultOwner ?? !legacyPhysicalCustom);
        const defaultAliasMatches = incomingBareRoot !== undefined && root === defaultRoot
          && tryRealpath(root) === incomingBareRoot
          && (store === null ? sourceMatches : knownEntries.get(incomingBareRoot) === store.identity);
        // Old guardian rows can have only the pre-v3 mtime/line checkpoint.
        // During replay, recognize their persisted self membership plus the
        // unchanged lexical file and its explicit native guardian ID.
        const legacyGuardianMatches = rootIdentity != null && ctx.snapshotRequired && Number.isFinite(legacyMtime)
          && session.memberSessionIds?.includes(session.sessionId)
          && matchesLegacyGuardian(session.jsonlPath, session.sessionId, legacyMtime);
        if (legacyGuardianMatches) confirmedGuardians.set(session.jsonlPath, { sessionId: session.sessionId, mtime: legacyMtime });
        const currentStoreMatches = store !== null ? rootIdentity === store.identity
          : sourceMatches || verifiedLegacyRoots.has(root) || legacyGuardianMatches;
        const recoverStore = () => entries.find(entry => {
          const identity = knownEntries.get(entry.rootDir);
          return identity != null && (store !== null ? identity === store.identity
            : codexFileMatches(file, join(entry.rootDir, relative(root, session.jsonlPath)), { unshared: true }));
        })?.rootDir;
        let recoveredRoot: string | undefined;
        if (/^codex:[^:]+$/.test(session.sessionId) && historicalDefault && !legacyGuardianMatches
          && (root !== defaultTarget || !currentStoreMatches)
          && !defaultAliasMatches) {
          defaultDisplaced = true;
          recoveredRoot = currentStoreMatches && rootIdentity != null ? root : recoverStore();
          if (recoveredRoot !== undefined) {
            retainedBareRoots.add(recoveredRoot);
            recoveredRoots.set(session.sessionId, recoveredRoot);
          }
          else if (incomingBareRoot !== undefined) {
            unavailable(session, 'Codex default home changed before its indexed session could be reconciled');
          }
        }
        if (rootIdentity != null && (store !== null ? store.identity !== rootIdentity
          : hasCursor && !currentStoreMatches)) {
          if (recoveredRoot !== undefined && recoveredRoot !== root && root === incomingBareRoot) continue;
          unavailable(session, 'Codex store no longer matches its historical source');
          if (store !== null || !usesRootSet) blockedRoots.add(root);
          else for (const memberId of session.memberSessionIds ?? []) unverifiedMembers.add(memberId);
        }
      }
      if (retainedBareRoots.size > 1) {
        retainedBareRoots.clear();
        for (const { session } of prior) {
          if (/^codex:[^:]+$/.test(session.sessionId)) {
            unavailable(session, 'Multiple Codex stores claim historical bare IDs');
          }
        }
      }
      if (defaultDisplaced) {
        entries = entries.map(entry => ({
          ...entry,
          rootScope: retainedBareRoots.has(entry.rootDir) ? null : entry.rootScope
            ?? codexScopedRootId(entry.rootDir),
        }));
      }
      entries = entries.filter(entry => !blockedRoots.has(entry.rootDir));
      const discoverEntry = (entry: CodexRootEntry, discoveryContext: DiscoverContext) => {
        const identity = knownEntries.get(entry.rootDir);
        const aliases = new Set([...entry.aliases, ...(identity == null ? [] : aliasesByIdentity.get(identity) ?? [])]);
        return discoverAtRoot(entry.rootDir, entry.rootScope, discoveryContext, {
          usesRootSet,
          aliases: entry.aliases,
          homeDir,
          recoveredRoots,
          confirmedGuardians,
          storeSuffix: codexStoreSuffix(identity, [...aliases], entry.rootScope === null
            && (usesRootSet || lexicalCodexRoot(entry.rootDir) === defaultRoot)),
        });
      };
      const discovered = entries.flatMap(entry => discoverEntry(entry, ctx));
      if (unverifiedMembers.size > 0) {
        for (const unit of discovered) {
          const meta = unit.meta as { threadRawId?: string; rootScope?: string | null };
          const memberId = codexDbId(meta.threadRawId, meta.rootScope);
          if (memberId !== null && unverifiedMembers.has(memberId)) ctx.retainSession?.(unit.sessionId);
        }
      }
      // A scope migration can retract an old sessionId (e.g. bare `codex:<id>`)
      // that is simultaneously claimed by another configured root in the same pass
      // (e.g. default `~/.codex` with an identical copied thread ID). Bind the
      // migrating unit family and the reclaiming bare-root family into ONE
      // atomicGroup (with retracting migration units sorted first) so both
      // publish or roll back together in a single transaction.
      const migrationUnits = discovered.filter((unit) => (unit.retractSessionIds?.length ?? 0) > 0);
      const bareRoots = entries.filter((entry) => entry.rootScope === null);
      if (migrationUnits.length === 0) return discovered;

      const migrationGroupByRetractedId = new Map<string, string>();
      const migrationGroupKeys = new Set<string>();
      for (const unit of migrationUnits) {
        if (!unit.atomicGroup) continue;
        migrationGroupKeys.add(unit.atomicGroup);
        for (const retractedId of unit.retractSessionIds ?? []) {
          migrationGroupByRetractedId.set(retractedId, unit.atomicGroup);
        }
      }

      const retractedIds = new Set(migrationGroupByRetractedId.keys());
      const bareReplays = bareRoots.length > 0 && retractedIds.size > 0
        ? bareRoots
          .flatMap((entry) => discoverEntry(entry, {
            ...ctx,
            changedPaths: undefined,
            lastCursor: () => null,
            indexedSessions: () => [],
          }))
          .filter((unit) => retractedIds.has(unit.sessionId))
        : [];

      const isMigratingUnit = (unit: IndexUnit): boolean => (
        (unit.retractSessionIds?.length ?? 0) > 0
        || (unit.atomicGroup !== undefined && migrationGroupKeys.has(unit.atomicGroup))
      );

      const filtered = discovered.filter((unit) => isMigratingUnit(unit) || !retractedIds.has(unit.sessionId));
      const mergedReplays = bareReplays.map((unit) => {
        const unitMeta = unit.meta as { parentThreadId?: string | null } | undefined;
        const sharedGroup = migrationGroupByRetractedId.get(unit.sessionId) ?? `reclaim-bare:${unit.sessionId}`;
        return {
          ...unit,
          atomicGroup: sharedGroup,
          meta: {
            ...(unit.meta as object),
            forceSnapshot: true,
            replaceSnapshot: !unitMeta?.parentThreadId,
          },
        };
      });

      return [...filtered, ...mergedReplays].sort((a, b) => {
        const aMigrating = isMigratingUnit(a) ? 0 : 1;
        const bMigrating = isMigratingUnit(b) ? 0 : 1;
        if (aMigrating !== bMigrating) return aMigrating - bMigrating;
        const aIsChild = (a.meta as { parentThreadId?: string | null } | undefined)?.parentThreadId ? 1 : 0;
        const bIsChild = (b.meta as { parentThreadId?: string | null } | undefined)?.parentThreadId ? 1 : 0;
        return aIsChild - bIsChild;
      });
    },
    *parse(unit, cursor, metrics?: CodexParseMetrics, testHooks?: CodexParseTestHooks) {
      const sourceMeta = unit.meta as {
        storeSuffix?: string; storeOnly?: boolean; rootScope?: string | null; legacyGuardian?: { sessionId: string; mtime: number };
      } | undefined;
      const storeSuffix = sourceMeta?.storeSuffix;
      if (storeSuffix === undefined) return yield* parse(unit, cursor, metrics, testHooks);
      const store = readCodexStore(storeSuffix);
      const root = deriveCodexRootFromSessionPath(unit.key);
      const requireStore = () => {
        if (store !== null && root !== null && codexDirectoryIdentity(root) !== store.identity) {
          throw new RetryableSourceReadError(unit.key, 'Codex store changed during indexing');
        }
      };
      requireStore();
      const legacyGuardian = sourceMeta?.legacyGuardian;
      if (legacyGuardian !== undefined && !matchesLegacyGuardian(unit.key, legacyGuardian.sessionId, legacyGuardian.mtime)) {
        throw new RetryableSourceReadError(unit.key, 'Codex guardian changed before its previous rows could be retracted');
      }
      if (sourceMeta?.storeOnly && (cursor === null || codexCursorSignatureDiffers(cursor, unit.key, sourceMeta.rootScope))) {
        throw new RetryableSourceReadError(unit.key, 'Codex rollout changed before its store checkpoint could be recorded');
      }
      const result = sourceMeta?.storeOnly ? cursor : yield* parse(unit, cursor, metrics, testHooks);
      requireStore();
      return result === null ? null : result.split(CODEX_STORE_CURSOR_TAG)[0] + storeSuffix;
    },
    raw: (input) => rawCodex(resolvedRootEntries(), input),
  };
}

export const codexProvider = createCodexProvider();
