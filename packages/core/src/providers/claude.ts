// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Claude Code provider adapter in Core (see docs/adr/0001).
//
// Pure: discovers Claude transcript files and parses one into a record stream.
// It never touches the Obelisk database. The per-line logic mirrors the original
// indexJsonl exactly, but yields canonical TranscriptRecords instead of writing rows; the shared
// persist layer consumes them. Session aggregates here reflect only THIS chunk
// (started_at/ended_at/message_count); persist merges them with any existing row.

import { createHash } from 'node:crypto';
import { RetryableSourceReadError } from './source-read-error.ts';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, posix, relative, resolve, win32 } from 'node:path';

import {
  TEXT_LIMIT, extractText, extractContentType, extractHarnessKind,
  filePath, trunc, truncJson, readLines, discoverJsonlFiles, isDir, sourceInventoryIssue,
  normalizeTranscriptTimestamp,
} from '../parsing.ts';

import type {
  Cursor,
  DiscoverContext,
  IndexedSession,
  TranscriptRecord,
  IndexUnit,
  ProviderAdapter,
  RawLookup,
  RawRecord,
} from './types.ts';

// Claude cursor encodes the file mtime and the number of lines already indexed:
// "<mtimeMs>:<linesProcessed>". mtime lets discovery detect change; lines lets
// parse resume without reprocessing.
function cursorToSkip(cursor: Cursor): number {
  if (!cursor) return 0;
  const n = Number(cursor.split(':')[1]);
  return Number.isFinite(n) ? n : 0;
}

// Cursor format: mtime:lines:size:ctime:inode:device:birthtime, optionally
// followed by the physical root's device, inode and creation time. The
// mtime+ctime+size+inode signature (CONTRIBUTING: cursors must detect
// same-millisecond rewrites) lets a same-mtime tail completion or a
// same-mtime replacement back into discovery. Legacy `${mtime}:${lines}`
// cursors keep the mtime-only gate and upgrade on the next parse.
function cursorSignatureDiffers(cursor: string, filePath: string): boolean {
  const stat = statSync(filePath);
  const parts = cursor.split(':');
  if (parts.length < 5) return Number(parts[0]) < stat.mtimeMs;
  return Number(parts[0]) !== stat.mtimeMs
    || Number(parts[2]) !== stat.size
    || Number(parts[3]) !== stat.ctimeMs
    || Number(parts[4]) !== stat.ino
    || (parts.length >= 7 && (Number(parts[5]) !== stat.dev || Number(parts[6]) !== stat.birthtimeMs));
}

export const name = 'claude';
// v8 adds Claude's human-authored mid-turn queued commands to the canonical
// transcript. Existing installs must replay once to index those attachments.
export const CLAUDE_CANONICAL_TRANSCRIPT_MARKER = '__claude_canonical_transcript_v8__';
const CLAUDE_V7_CANONICAL_TRANSCRIPT_MARKER = '__claude_canonical_transcript_v7__';

function isWindowsStylePath(value: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(value) || value.startsWith('\\\\');
}

export function canonicalRootPath(dir: string): string {
  const useWin32 = process.platform === 'win32' || isWindowsStylePath(dir);
  const pathImpl = useWin32 ? win32 : posix;
  const norm = pathImpl.normalize(dir);
  const parsedRoot = pathImpl.parse(norm).root;
  if (norm.length > parsedRoot.length && (norm.endsWith('/') || (useWin32 && norm.endsWith('\\')))) {
    return norm.slice(0, -1);
  }
  return norm;
}

function sanitizeRootTag(dir: string): string {
  return basename(canonicalRootPath(dir)).replace(/^\./, '').replace(/:/g, '-') || 'alt';
}

export function rootTagFor(rootDir: string, defaultRoot: string): string {
  const normalizedRoot = physicalPath(rootDir);
  const normalizedDefault = physicalPath(defaultRoot);
  if (sameNormalizedPath(normalizedRoot, normalizedDefault)) return '';
  const base = sanitizeRootTag(normalizedRoot);
  const hashInput = (process.platform === 'win32' || isWindowsStylePath(normalizedRoot))
    ? normalizedRoot.toLowerCase()
    : normalizedRoot;
  const hash = createHash('sha256').update(hashInput).digest('hex').slice(0, 6);
  return `${base}-${hash}`;
}

function lexicalPathInside(root: string, candidate: string): boolean {
  const useWin32 = process.platform === 'win32' || (isWindowsStylePath(root) && isWindowsStylePath(candidate));
  const pathImpl = useWin32 ? win32 : { normalize, relative, isAbsolute };
  const base = pathImpl.normalize(root);
  const target = pathImpl.normalize(candidate);
  const cmpBase = useWin32 ? base.toLowerCase() : base;
  const cmpTarget = useWin32 ? target.toLowerCase() : target;
  if (cmpBase === cmpTarget) return true;
  const rel = pathImpl.relative(cmpBase, cmpTarget);
  if (rel.length === 0) return false;
  return !pathImpl.isAbsolute(rel) && !/(^|[/\\])\.\.([/\\]|$)/.test(rel);
}

export function sameNormalizedPath(left: string, right: string): boolean {
  const useWin32 = process.platform === 'win32' || (isWindowsStylePath(left) && isWindowsStylePath(right));
  const norm = useWin32 ? win32.normalize : normalize;
  const a = norm(left);
  const b = norm(right);
  return useWin32 ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function tryRealpath(target: string): string | null {
  try {
    return realpathSync(target);
  } catch {
    return null;
  }
}

function physicalPath(target: string): string {
  return canonicalRootPath(tryRealpath(target) ?? target);
}

function lexicalPathKey(path: string): string {
  const normalized = canonicalRootPath(path);
  return process.platform === 'win32' || isWindowsStylePath(path) ? normalized.toLowerCase() : normalized;
}

function watchPathOnDisk(path: string): string {
  // Deletion events identify a path that no longer resolves. Resolve its
  // closest surviving ancestor to recover the physical watcher spelling.
  let ancestor = normalize(path);
  for (;;) {
    const resolved = tryRealpath(ancestor);
    if (resolved !== null) return join(resolved, relative(ancestor, path));
    const parent = dirname(ancestor);
    if (parent === ancestor) return path;
    ancestor = parent;
  }
}

function hasUnresolvedLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) return false;
    const parent = dirname(path);
    return parent !== path && tryRealpath(parent) === null && hasUnresolvedLink(parent);
  }
}

const CLAUDE_ROOT_OBSERVATION_KEY = '__claude_configured_roots__';

interface ClaudePhysicalRoot {
  readonly path: string;
  readonly identity: string | null;
}

interface ClaudeRootObservation {
  readonly kind: 'root-observation';
  readonly roots: ReadonlyMap<string, ClaudePhysicalRoot | null>;
  readonly cursor: string;
}

function readRootObservations(cursor: Cursor): Map<string, string> | null {
  if (!cursor?.startsWith('0:0:')) return null;
  try {
    const entries: unknown = JSON.parse(cursor.slice(4));
    if (!Array.isArray(entries)) return null;
    return new Map(entries.filter((entry): entry is [string, string] =>
      Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && typeof entry[1] === 'string'));
  } catch { return null; }
}

function rootObservationUnits(
  observedRoots: ReadonlyMap<string, ClaudePhysicalRoot | null>,
  physicalRoots: ReadonlyMap<string, ClaudePhysicalRoot>,
  indexed: readonly IndexedSession[],
  ctx: DiscoverContext,
  usesRootSet: boolean,
): IndexUnit[] {
  if (ctx.previousCursor === undefined || ctx.indexedSessions === undefined) return [];
  const previous = readRootObservations(ctx.previousCursor(CLAUDE_ROOT_OBSERVATION_KEY));
  if (!usesRootSet && previous === null && ![...observedRoots].some(([configured, physical]) =>
    physical !== null && !sameNormalizedPath(configured, physical.path))) return [];
  const indexedRoots = new Set(indexed.flatMap(session => {
    const location = transcriptLocation(session.jsonlPath);
    return location === null ? [] : [lexicalPathKey(location.root)];
  }));
  const hasUnselectedHistory = [...indexedRoots].some(root => !physicalRoots.has(root));
  // An incremental exclusion leaves the store's rows in the index. Keep its
  // association available in case the setting is restored before the store.
  const recorded = new Map([...previous ?? []].filter(([, root]) => indexedRoots.has(lexicalPathKey(root))));
  for (const [configured, physical] of observedRoots) {
    const key = lexicalPathKey(configured);
    const priorRoot = previous?.get(key);
    const priorKey = priorRoot === undefined ? null : lexicalPathKey(priorRoot);
    const displacedHistory = priorKey === null
      ? previous === null && physical === null && hasUnselectedHistory
      : indexedRoots.has(priorKey) && !physicalRoots.has(priorKey);
    if (displacedHistory) {
      ctx.reportIncompleteInventory?.({ path: configured, error: 'Configured Claude root no longer resolves to its indexed store' });
      if (priorRoot === undefined) return [];
      recorded.set(key, priorRoot);
    } else if (physical !== null) {
      recorded.set(key, physical.path);
    }
  }
  const cursor = `0:0:${JSON.stringify([...recorded].sort(([left], [right]) => left.localeCompare(right)))}`;
  if (ctx.lastCursor(CLAUDE_ROOT_OBSERVATION_KEY) === cursor) return [];
  return [{
    key: CLAUDE_ROOT_OBSERVATION_KEY, sessionId: '',
    meta: { kind: 'root-observation', roots: observedRoots, cursor } satisfies ClaudeRootObservation,
  }];
}

function transcriptLocation(path: string) {
  const pathImpl = process.platform === 'win32' || isWindowsStylePath(path) ? win32 : posix;
  const projectDir = pathImpl.dirname(path);
  const projectsDir = pathImpl.dirname(projectDir);
  if (pathImpl.basename(projectsDir) !== 'projects') return null;
  const root = pathImpl.dirname(projectsDir);
  return { root, project: pathImpl.basename(projectDir), file: pathImpl.basename(path) };
}

function checkpointIdentifiesFile(fields: readonly string[], stat: Stats): boolean {
  if (fields.length < 5 || stat.ino === 0 || !stat.isFile()) return false;
  // Older full cursors lack a device and creation time. A file created
  // after that checkpoint cannot be the original inode, even if its
  // inode number has since been reused.
  return Number(fields[4]) === stat.ino
    && stat.ctimeMs >= Number(fields[3])
    && (fields.length >= 7
      ? Number(fields[5]) === stat.dev && Number(fields[6]) === stat.birthtimeMs
      : stat.birthtimeMs > 0 && stat.birthtimeMs <= Number(fields[3]));
}

function checkpointMatchesFile(cursor: Cursor, path: string): string | null {
  try {
    const stat = statSync(path);
    // A hard-linked transcript can live in independent selected stores.
    // For a relocation, require either the old snapshot or a growing file
    // with the same filesystem identity.
    const fields = cursor?.split(':') ?? [];
    if (stat.nlink !== 1 || !checkpointIdentifiesFile(fields, stat)) return null;
    const mtime = Number(fields[0]);
    const size = Number(fields[2]);
    const ctime = Number(fields[3]);
    return (stat.size === size && stat.mtimeMs === mtime && stat.ctimeMs === ctime)
      || (stat.size > size && stat.mtimeMs >= mtime)
      ? fileSignature(stat) : null;
  } catch { return null; }
}

function mayUseStoredPath(cursor: Cursor, path: string): boolean {
  try {
    const stat = statSync(path);
    return checkpointIdentifiesFile(cursor?.split(':') ?? [], stat);
  } catch (error) {
    // Surviving children may still attest a missing main transcript.
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
  }
}

function physicalDirectoryIdentity(root: string): string | null {
  try {
    const stat = statSync(root);
    return stat.isDirectory() && stat.ino !== 0 ? `${stat.dev}:${stat.ino}:${stat.birthtimeMs}` : null;
  } catch { return null; }
}

function checkpointRootIdentity(cursor: Cursor): string | null {
  const fields = cursor?.split(':') ?? [];
  return fields.length === 10 ? fields.slice(7).join(':') : null;
}

function checkpointOwnsStoredPath(cursor: Cursor, root: string, path: string): boolean {
  const identity = checkpointRootIdentity(cursor);
  return identity === null ? mayUseStoredPath(cursor, path) : identity === physicalDirectoryIdentity(root);
}

function rootMatchingCheckpoint(
  location: NonNullable<ReturnType<typeof transcriptLocation>>,
  roots: readonly string[],
  cursor: Cursor,
): string | undefined {
  const rootIdentity = checkpointRootIdentity(cursor);
  const matching = roots.filter(root => {
    if (rootIdentity !== null && rootIdentity !== physicalDirectoryIdentity(root)) return false;
    const path = join(root, 'projects', location.project, location.file);
    if (checkpointMatchesFile(cursor, path) === null) return false;
    const resolved = tryRealpath(path);
    return resolved !== null && sameNormalizedPath(path, resolved);
  });
  return matching.length === 1 ? matching[0] : undefined;
}

function orphanRootCandidates(
  location: NonNullable<ReturnType<typeof transcriptLocation>>,
  roots: readonly string[],
  cursor: Cursor,
  ctx: DiscoverContext,
) {
  const session = location.file.slice(0, -'.jsonl'.length);
  if (!location.file.endsWith('.jsonl') || !isSafePathSegment(session)) return [];
  const parent = join('projects', location.project);
  const historicalDirectory = join(location.root, parent, session, 'subagents');
  const rootIdentity = checkpointRootIdentity(cursor);
  return roots.flatMap(root => {
    const mainPath = join(root, parent, location.file);
    if (!transcriptProvedMissing(mainPath)) return [];
    const directory = join(root, parent, session, 'subagents');
    let members: string[];
    try { members = orphanMemberPaths(directory); } catch { return []; }
    if (members.length === 0) return [];
    const verified = rootIdentity !== null
      ? rootIdentity === physicalDirectoryIdentity(root)
      : members.some(member => {
        const historicalPath = join(historicalDirectory, relative(directory, member));
        const prior = ctx.previousCursor?.(historicalPath) ?? ctx.lastCursor(historicalPath);
        if (checkpointMatchesFile(prior, member) === null) return false;
        const resolved = tryRealpath(member);
        return resolved !== null && sameNormalizedPath(member, resolved);
      });
    return [{ root, mainPath, verified }];
  });
}

function sessionRootTag(sessionId: string): string {
  const separator = sessionId.indexOf(':');
  return separator < 0 ? '' : sessionId.slice(0, separator);
}

function resolveIndexedRoots(
  roots: readonly string[],
  defaultRoot: string,
  configured: readonly string[],
  indexed: readonly IndexedSession[],
  ctx: DiscoverContext,
) {
  // Keep v7 identity upgrades distinguishable from older bare-ID indexes after
  // v8 becomes the current replay marker.
  const preV7 = (ctx.previousCursor?.(CLAUDE_CANONICAL_TRANSCRIPT_MARKER) ?? null) === null
    && (ctx.previousCursor?.(CLAUDE_V7_CANONICAL_TRANSCRIPT_MARKER) ?? null) === null;
  const canonicalTags = new Map(roots.map(root => [root, rootTagFor(root, defaultRoot)]));
  const legacyBareIds = new Set<string>();
  const byRoot = new Map(roots.map(root => [root, new Map<string, IndexedSession[]>()]));
  const rootByKey = new Map(roots.map(root => [lexicalPathKey(root), root]));
  const observedPriorRoots = new Map<string, string | null>();
  const reservedTags = new Set<string>();
  const blockedPaths = new Set<string>();
  for (const session of indexed) {
    const location = transcriptLocation(session.jsonlPath);
    if (location === null) continue;
    const cursor = ctx.previousCursor?.(session.jsonlPath) ?? ctx.lastCursor(session.jsonlPath);
    let root = rootByKey.get(lexicalPathKey(location.root));
    if (root !== undefined && !checkpointOwnsStoredPath(cursor, root, session.jsonlPath)) root = undefined;
    if (root === undefined) {
      // A currently resolving symlink says nothing about where it pointed at
      // indexing time. Match the prior checkpoint against the selected stores.
      root = rootMatchingCheckpoint(location, roots, cursor);
    }
    const orphanCandidates = root === undefined ? orphanRootCandidates(location, roots, cursor, ctx) : [];
    const verifiedOrphans = orphanCandidates.filter(candidate => candidate.verified);
    const orphanRelocation = root === undefined && verifiedOrphans.length === 1;
    if (orphanRelocation) root = verifiedOrphans[0]?.root;
    if (root === undefined) {
      if (!observedPriorRoots.has(location.root)) observedPriorRoots.set(location.root, tryRealpath(location.root));
      const observedPriorRoot = observedPriorRoots.get(location.root) ?? null;
      const ambiguousOrphans = orphanCandidates.filter(candidate => candidate.verified
        || observedPriorRoot === null || sameNormalizedPath(observedPriorRoot, candidate.root));
      const possiblySelected = configured.some(candidate => sameNormalizedPath(candidate, location.root))
        || (observedPriorRoot !== null && rootByKey.has(lexicalPathKey(observedPriorRoot)))
        || (observedPriorRoot === null && roots.some(candidate => existsSync(join(candidate, 'projects', location.project, location.file))))
        || ambiguousOrphans.length > 0;
      if (possiblySelected) {
        for (const { mainPath } of ambiguousOrphans) blockedPaths.add(lexicalPathKey(mainPath));
        // An unresolved prior row and its replacement must not share a
        // path-keyed cursor, even when their session IDs are distinct.
        if (rootByKey.has(lexicalPathKey(location.root))) blockedPaths.add(lexicalPathKey(session.jsonlPath));
        ctx.retainSession?.(session.sessionId);
        ctx.reportSkippedArtifact?.({ path: session.jsonlPath, error: 'Prior Claude root identity cannot be verified' });
      }
      // A former path can become a new default root or acquire the same
      // deterministic tag. Keep unverified history out of its namespace.
      reservedTags.add(sessionRootTag(session.sessionId));
      continue;
    }
    if (preV7 && !orphanRelocation && sessionRootTag(session.sessionId) === ''
      && canonicalTags.get(root) !== '' && !sameNormalizedPath(location.root, defaultRoot)) {
      legacyBareIds.add(session.sessionId);
    }
    const sessions = byRoot.get(root)!;
    const key = lexicalPathKey(join(root, 'projects', location.project, location.file));
    const sameFile = sessions.get(key) ?? [];
    sameFile.push(session);
    sessions.set(key, sameFile);
  }

  const tagOwners = new Map<string, Set<string>>();
  for (const [root, sessions] of byRoot) {
    for (const session of [...sessions.values()].flat()) {
      const tag = sessionRootTag(session.sessionId);
      if (legacyBareIds.has(session.sessionId)) continue;
      const owners = tagOwners.get(tag) ?? new Set<string>();
      owners.add(root);
      tagOwners.set(tag, owners);
    }
  }

  const assignedTags = new Set<string>();
  return [...roots].sort((a, b) => lexicalPathKey(a).localeCompare(lexicalPathKey(b))).map(root => {
    const sessions = byRoot.get(root)!;
    const canonical = canonicalTags.get(root)!;
    const established = [...tagOwners].filter(([, owners]) => owners.size === 1 && owners.has(root)).map(([tag]) => tag);
    const available = (tag: string) => !assignedTags.has(tag)
      && !reservedTags.has(tag) && (!tagOwners.has(tag) || established.includes(tag));
    // Prefer an established scope even when this physical store is now the
    // default. When there are established duplicates, prefer the canonical tag.
    let tag = established.includes(canonical) ? canonical
      : established.length === 1 ? established[0]!
      : canonical;
    if (!available(tag) && !established.includes(tag)) {
      const digest = createHash('sha256').update(lexicalPathKey(root)).digest('hex');
      tag = `${sanitizeRootTag(root)}-${digest}`;
    }
    assignedTags.add(tag);
    return { root, sessions, tag, legacyBareIds, blockedPaths };
  });
}

export function legacyClaudeMigrationTargets(
  defaultRoot: string,
  configuredRoots: readonly string[],
  indexed: readonly IndexedSession[],
  previousCursor: (path: string) => Cursor,
): { oldId: string; newId: string; jsonlPath: string }[] {
  const roots = new Map(configuredRoots.map(configured => {
    const root = physicalPath(configured);
    return [lexicalPathKey(root), root];
  }));
  return resolveIndexedRoots([...roots.values()], defaultRoot, configuredRoots, indexed, {
    lastCursor: previousCursor, previousCursor,
  }).flatMap(({ sessions, tag, legacyBareIds }) => [...sessions.values()].flatMap(priors => priors
    .filter(prior => legacyBareIds.has(prior.sessionId))
    .map(prior => ({
      oldId: prior.sessionId,
      newId: canonicalSessionId(prior.sessionId, tag),
      jsonlPath: prior.jsonlPath,
    }))));
}

export function pathInside(root: string, candidate: unknown): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  if (lexicalPathInside(root, candidate)) return true;
  const realRoot = tryRealpath(root);
  const realCandidate = tryRealpath(candidate);
  if (realRoot !== null && realCandidate !== null) {
    return lexicalPathInside(realRoot, realCandidate);
  }
  return false;
}

function isSafePathSegment(value: string): boolean {
  return value.length > 0
    && value !== '.'
    && value !== '..'
    && !value.includes('/')
    && !value.includes('\\')
    && !value.includes('\0');
}

export function canonicalSessionId(rawSessionId: string, rootTag: string): string {
  return rootTag ? `${rootTag}:${rawSessionId}` : rawSessionId;
}

export function bareSessionId(sessionId: unknown): string {
  const text = typeof sessionId === 'string' ? sessionId : String(sessionId ?? '');
  const separator = text.indexOf(':');
  return separator === -1 ? text : text.slice(separator + 1);
}

function messageUuid(sessionId: string, rawUuid: string): string {
  return sessionId.includes(':') ? `${sessionId}:${rawUuid}` : rawUuid;
}

function scopedId(sessionId: string, rawId: string): string {
  return sessionId.includes(':') ? `${sessionId}:${rawId}` : rawId;
}

function queuedAttachmentMessageUuid(sessionId: string, rawUuid: string): string {
  return messageUuid(sessionId, `${bareSessionId(sessionId)}:${rawUuid}`);
}

function parentMessageUuid(sessionId: string, rawUuid: string, queuedAttachmentUuids: ReadonlySet<string>): string {
  return queuedAttachmentUuids.has(rawUuid)
    ? queuedAttachmentMessageUuid(sessionId, rawUuid)
    : messageUuid(sessionId, rawUuid);
}

function isWireUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function humanQueuedContent(record: any): { text: string | null; contentType: string } | null {
  const attachment = record?.type === 'attachment' ? record.attachment : null;
  const prompt = attachment?.prompt;
  const promptContent = typeof prompt === 'string'
    ? prompt
    : Array.isArray(prompt)
      ? prompt.filter((part) => part !== null && typeof part === 'object' && !Array.isArray(part)
        && ((part.type === 'text' && typeof part.text === 'string')
          || (part.type === 'thinking' && typeof part.thinking === 'string')
          || part.type === 'image'))
      : null;
  if (attachment?.type !== 'queued_command'
    || attachment.origin?.kind !== 'human'
    || (attachment.humanTurn !== undefined && attachment.humanTurn !== true)
    || attachment.isMeta === true || record.isMeta === true
    || (attachment.commandMode !== undefined && attachment.commandMode !== 'prompt')
    || !isWireUuid(record.uuid)
    || promptContent === null || (Array.isArray(promptContent) && promptContent.length === 0)) return null;
  const extractedText = extractText(promptContent, Infinity);
  const text = typeof extractedText === 'string' && extractedText.trim().length > 0 ? extractedText : null;
  const includesImage = Array.isArray(promptContent) && promptContent.some((part) => part.type === 'image');
  if (text === null && !includesImage) return null;
  return {
    text,
    contentType: extractContentType(promptContent),
  };
}

function extractRawUuid(messageUuid: string, sessionId?: unknown): string {
  const sessionStr = typeof sessionId === 'string' ? sessionId : String(sessionId ?? '');
  if (sessionStr && messageUuid.startsWith(`${sessionStr}:`)) {
    return messageUuid.slice(sessionStr.length + 1);
  }
  const idx = messageUuid.lastIndexOf(':');
  return idx === -1 ? messageUuid : messageUuid.slice(idx + 1);
}

function extractQueuedAttachmentRawUuid(messageUuid: string, sessionId: unknown): string {
  const sessionStr = typeof sessionId === 'string' ? sessionId : String(sessionId ?? '');
  const providerId = extractRawUuid(messageUuid, sessionStr);
  const localPrefix = `${bareSessionId(sessionStr)}:`;
  if (providerId.startsWith(localPrefix)) {
    const wireUuid = providerId.slice(localPrefix.length);
    if (isWireUuid(wireUuid)) return wireUuid;
  }
  return providerId;
}

interface ClaudeWorkflowUnitMeta {
  readonly kind: 'workflow';
  readonly mainTranscriptPath: string;
  readonly aliasTransition?: ClaudeAliasTransition;
}

interface ClaudeAliasTransition {
  readonly path: string;
  readonly signature: string;
}

function totalInputTokens(usage: Record<string, unknown>): number | null {
  const fields = [
    'input_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
  ];
  let seen = false;
  let total = 0;
  for (const field of fields) {
    const value = usage[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    seen = true;
    total += value;
  }
  return seen ? total : null;
}

function workflowMainSignature(mainTranscriptPath: string): string {
  try {
    return fileSignature(statSync(mainTranscriptPath));
  } catch {
    return 'missing';
  }
}

function fileSignature(stat: Stats): string {
  return `${stat.mtimeMs}:${stat.size}:${stat.ctimeMs}:${stat.ino}`;
}

function assertRootIdentity(root: ClaudePhysicalRoot): void {
  if (root.identity !== null && physicalDirectoryIdentity(root.path) !== root.identity) {
    throw new RetryableSourceReadError(root.path, 'Claude store changed during indexing');
  }
}

function assertTranscriptSignature(path: string, signature: string): void {
  if (signature === 'missing' || workflowMainSignature(path) !== signature) {
    throw new RetryableSourceReadError(path, 'Claude transcript changed during alias reconciliation');
  }
}

function discoverAt(
  rootDir: string,
  ctx: DiscoverContext,
  rootTag: string,
  priorByPath: ReadonlyMap<string, IndexedSession[]>,
  indexed: readonly IndexedSession[],
  usesRootSet: boolean,
  legacyBareIds: ReadonlySet<string>,
  blockedPaths: ReadonlySet<string>,
  sourceRoot: ClaudePhysicalRoot,
): IndexUnit[] {
  const projectsDir = join(rootDir, 'projects');
  let projectsStat: Stats | null = null;
  let projectsStatError: NodeJS.ErrnoException | null = null;
  try {
    projectsStat = statSync(projectsDir);
  } catch (error) {
    projectsStatError = error as NodeJS.ErrnoException;
  }
  if (projectsStatError !== null) {
    if (projectsStatError.code !== 'ENOENT') {
      ctx.reportIncompleteInventory?.(sourceInventoryIssue(projectsDir, projectsStatError));
      return [];
    }
    const rootWasIndexed = indexed.some((session) => pathInside(rootDir, session.jsonlPath));
    const rootExists = existsSync(rootDir);
    if (rootWasIndexed || hasUnresolvedLink(rootDir) || (!usesRootSet && !rootExists && indexed.length > 0)) {
      ctx.reportIncompleteInventory?.({ path: projectsDir, error: 'Source folder is unavailable' });
    }
    return [];
  }
  if (!projectsStat!.isDirectory()) {
    ctx.reportIncompleteInventory?.({ path: projectsDir, error: 'Source folder is not a directory' });
    return [];
  }
  const historyPath = normalize(join(rootDir, 'history.jsonl'));
  const historyTitles = new Map<string, string>();
  if (existsSync(historyPath)) {
    readLines(historyPath, (line: string) => {
      try {
        const item = JSON.parse(line);
        if (item?.sessionId && item?.title) historyTitles.set(item.sessionId, item.title);
      } catch { /* malformed history entry */ }
    });
  }
  const changedTranscriptPaths = new Set<string>();
  const changedWorkflowPaths = new Set<string>();
  const forcedPaths = new Set<string>();
  let historyChanged = false;
  for (const changedPath of ctx.changedPaths ?? []) {
    const observedPath = isAbsolute(changedPath)
      ? watchPathOnDisk(changedPath)
      : changedPath;
    const rootRelative = isAbsolute(observedPath)
      ? normalize(observedPath)
      : normalize(join(rootDir, changedPath));
    if (rootRelative === historyPath) historyChanged = true;
    const absolute = isAbsolute(observedPath)
      ? normalize(observedPath)
      : normalize(join(projectsDir, changedPath));
    const inside = relative(projectsDir, absolute);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) continue;
    if (absolute.toLowerCase().endsWith('.meta.json')) {
      const transcript = absolute.slice(0, -'.meta.json'.length) + '.jsonl';
      changedTranscriptPaths.add(transcript);
      forcedPaths.add(transcript);
    } else if (absolute.toLowerCase().endsWith('.jsonl')) {
      changedTranscriptPaths.add(absolute);
    } else if (absolute.toLowerCase().endsWith('.json')) {
      changedWorkflowPaths.add(absolute);
    }
  }
  let inventoryComplete = true;
  const files = discoverJsonlFiles(projectsDir, issue => {
    inventoryComplete = false;
    ctx.reportIncompleteInventory?.(issue);
  }).filter(file => {
    const path = file.isSubagent ? join(projectsDir, file.project, `${file.sessionId}.jsonl`) : file.path;
    return !blockedPaths.has(lexicalPathKey(path));
  });
  const identityFor = (path: string, rawId: string) => {
    const canonicalId = canonicalSessionId(rawId, rootTag);
    const candidates = (priorByPath.get(lexicalPathKey(path)) ?? [])
      // Pre-v7 bare custom identities use the existing schema migration.
      .filter(session => bareSessionId(session.sessionId) === rawId && !legacyBareIds.has(session.sessionId));
    const surviving = candidates.find(session => session.sessionId === canonicalId)
      ?? candidates.sort((a, b) => a.sessionId.localeCompare(b.sessionId))[0];
    const sessionId = surviving?.sessionId ?? canonicalId;
    return {
      sessionId,
      aliases: candidates.filter(session => session.sessionId !== sessionId),
      relocated: candidates.filter(session => !sameNormalizedPath(path, session.jsonlPath)),
    };
  };
  const transitions = new Map<string, ClaudeAliasTransition & { previousIds: string[] }>();
  for (const file of files) {
    if (file.isSubagent) continue;
    const identity = identityFor(file.path, file.sessionId);
    if (identity.relocated.length > 0 || identity.aliases.length > 0) {
      const signature = workflowMainSignature(file.path);
      if (signature === 'missing' || identity.relocated.some(session =>
        checkpointMatchesFile(ctx.previousCursor?.(session.jsonlPath) ?? ctx.lastCursor(session.jsonlPath), file.path) !== signature)) {
        inventoryComplete = false;
        ctx.reportIncompleteInventory?.({ path: file.path, error: 'Claude transcript changed during alias discovery' });
      }
      transitions.set(lexicalPathKey(file.path), {
        path: file.path,
        signature,
        previousIds: [identity.sessionId, ...identity.aliases.map(alias => alias.sessionId)],
      });
    }
  }
  const orphanMembers = new Map<string, IndexUnit[]>();
  for (const file of files) {
    if (!file.isSubagent) continue;
    const mainPath = join(projectsDir, file.project, `${file.sessionId}.jsonl`);
    if (!transcriptProvedMissing(mainPath)) continue;
    const key = join(projectsDir, file.project, file.sessionId, 'subagents');
    const members = orphanMembers.get(key) ?? [];
    members.push({ key: file.path, sessionId: identityFor(mainPath, file.sessionId).sessionId, project: file.project,
      isSubagent: true, agentId: file.agentId,
      meta: file.workflowRunId ? { workflowRunId: file.workflowRunId } : {} });
    orphanMembers.set(key, members);
  }
  const orphanPaths = new Set([...orphanMembers.values()].flatMap(members => members.map(unit => unit.key)));
  const orphanUnits: IndexUnit[] = [];
  for (const [key, members] of orphanMembers) {
    const member = members[0]!;
    const rawMainPath = join(dirname(key), '..', `${bareSessionId(member.sessionId)}.jsonl`);
    const mainPath = normalize(rawMainPath);
    const prior = priorByPath.get(lexicalPathKey(mainPath))?.[0];
    if (!inventoryComplete) {
      ctx.retainSession?.(member.sessionId);
      if (prior && prior.sessionId !== member.sessionId) ctx.retainSession?.(prior.sessionId);
      continue;
    }
    const mainCursor = ctx.previousCursor?.(mainPath) ?? ctx.lastCursor(mainPath);
    let signature: string;
    try { signature = orphanFingerprint([...members.map(unit => unit.key), ...orphanWorkflowPaths(key)], mainCursor); }
    catch (error) {
      ctx.retainSession?.(member.sessionId);
      if (prior && prior.sessionId !== member.sessionId) ctx.retainSession?.(prior.sessionId);
      ctx.reportIncompleteInventory?.(sourceInventoryIssue(key, error));
      continue;
    }
    if (ctx.lastCursor(key) === signature) continue;
    if (prior && prior.sessionId !== member.sessionId) {
      ctx.retainSession?.(prior.sessionId);
    }
    // A missing main file does not revoke already indexed history. Preserve
    // that evidence during force cleanup while refreshing surviving children.
    orphanUnits.push({ key, sessionId: member.sessionId, project: member.project, preserveSessionHistory: true,
      meta: { kind: 'orphan-family', members, signature, mainPath, mainCursor } satisfies ClaudeOrphanFamilyMeta });
  }
  const transcriptUnits: IndexUnit[] = files.flatMap((file) => {
    if (orphanPaths.has(file.path)) return [];
    const mainPath = file.isSubagent ? join(projectsDir, file.project, `${file.sessionId}.jsonl`) : file.path;
    const transition = transitions.get(lexicalPathKey(mainPath));
    const normalizedPath = normalize(file.path);
    if (!transition && ctx.changedPaths !== undefined && !historyChanged && !changedTranscriptPaths.has(normalizedPath)) return [];
    const cursor = ctx.lastCursor(file.path);
    if (!transition && !historyChanged && !forcedPaths.has(normalizedPath) && cursor !== null
      && !cursorSignatureDiffers(cursor, file.path)) return [];
    const { sessionId, aliases } = identityFor(mainPath, file.sessionId);
    return [{
      key: file.path,
      sessionId,
      project: file.project,
      isSubagent: file.isSubagent,
      agentId: file.agentId,
      ...(!file.isSubagent && aliases.length > 0 ? {
        retractSessionIds: aliases.map(alias => alias.sessionId),
        redirectRetractedSessionMemories: {
          newMessagePrefix: scopedId(sessionId, ''),
          oldMessagePrefixes: new Map(aliases.map(alias => [alias.sessionId, scopedId(alias.sessionId, '')])),
        },
      } : {}),
      ...(transition ? { atomicGroup: mainPath } : {}),
      meta: {
        ...(file.workflowRunId ? { workflowRunId: file.workflowRunId } : {}),
        ...(historyTitles.has(file.sessionId) ? { historyTitle: historyTitles.get(file.sessionId) } : {}),
        ...(transition ? { aliasTransition: transition } : {}),
      },
    }];
  });

  const workflowUnits: IndexUnit[] = [];
  const reportWorkflowIssue = (path: string, error: unknown) => {
    inventoryComplete = false;
    ctx.reportIncompleteInventory?.(sourceInventoryIssue(path, error));
  };
  const finish = (units: IndexUnit[]) => {
    if (!inventoryComplete) {
      for (const { previousIds } of transitions.values()) {
        for (const id of previousIds) ctx.retainSession?.(id);
      }
      units = units.filter(unit => unit.atomicGroup === undefined);
    }
    // Publish children before the main unit verifies and redirects anchors
    // to the surviving family, all inside the same publication transaction.
    return units.filter(unit => !unit.redirectRetractedSessionMemories)
      .concat(units.filter(unit => unit.redirectRetractedSessionMemories))
      .map(unit => ({ ...unit, meta: { ...unit.meta as object, sourceRoot } }));
  };
  let projects: string[];
  try { projects = readdirSync(projectsDir); } catch (error) {
    reportWorkflowIssue(projectsDir, error);
    return finish([...transcriptUnits, ...orphanUnits]);
  }
  for (const project of projects) {
    const projectPath = join(projectsDir, project);
    if (!isDir(projectPath)) continue;
    let sessionIds: string[];
    try { sessionIds = readdirSync(projectPath); } catch (error) {
      reportWorkflowIssue(projectPath, error);
      continue;
    }
    for (const sessionId of sessionIds) {
      const workflowDir = join(projectPath, sessionId, 'workflows');
      if (!isDir(workflowDir)) continue;
      const mainTranscriptPath = join(projectPath, `${sessionId}.jsonl`);
      if (blockedPaths.has(lexicalPathKey(mainTranscriptPath))) continue;
      const transition = transitions.get(lexicalPathKey(mainTranscriptPath));
      const currentMainSig = workflowMainSignature(mainTranscriptPath);
      let files: string[];
      try { files = readdirSync(workflowDir); } catch (error) {
        reportWorkflowIssue(workflowDir, error);
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const workflowPath = join(workflowDir, file);
        const normalizedPath = normalize(workflowPath);
        const relationshipChanged = changedTranscriptPaths.has(normalize(mainTranscriptPath));
        if (
          !transition && ctx.changedPaths !== undefined
          && !changedWorkflowPaths.has(normalizedPath)
          && !relationshipChanged
        ) continue;
        const mtime = statSync(workflowPath).mtimeMs;
        const cursor = ctx.lastCursor(workflowPath);
        const cursorParts = cursor?.split(':');
        const cursorMtime = cursorParts ? Number(cursorParts[0]) : NaN;
        const cursorMainSig = cursorParts && cursorParts.length >= 3 ? cursorParts.slice(2).join(':') : null;
        if (!transition && !relationshipChanged && cursor !== null && cursorMtime >= mtime && cursorMainSig === currentMainSig) continue;
        workflowUnits.push({
          key: workflowPath,
          sessionId: identityFor(mainTranscriptPath, sessionId).sessionId,
          project,
          ...(transition ? { atomicGroup: mainTranscriptPath } : {}),
          meta: { kind: 'workflow', mainTranscriptPath, ...(transition ? { aliasTransition: transition } : {}) } satisfies ClaudeWorkflowUnitMeta,
        });
      }
    }
  }
  return finish([...transcriptUnits, ...orphanUnits, ...workflowUnits.filter(unit =>
    !orphanMembers.has(join(projectsDir, unit.project!, bareSessionId(unit.sessionId), 'subagents')))]);
}

export function discover(ctx: DiscoverContext): IndexUnit[] {
  return createClaudeProvider().discover(ctx);
}
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => typeof part?.text === 'string' ? part.text : '').join('\n');
}

function workflowParentToolUseId(
  transcriptPath: string,
  runId: string,
): string | null {
  if (!existsSync(transcriptPath)) return null;
  const workflowToolIds = new Set<string>();
  let parentToolUseId: string | null = null;
  readLines(transcriptPath, (line: string) => {
    let record: any;
    try { record = JSON.parse(line); } catch { return; }
    const content = record?.message?.content;
    if (!Array.isArray(content)) return;
    if (record.type === 'assistant') {
      for (const block of content) {
        if (block?.type === 'tool_use' && block?.name === 'Workflow' && typeof block.id === 'string') {
          workflowToolIds.add(block.id);
        }
      }
      return;
    }
    if (record.type !== 'user') return;
    for (const block of content) {
      if (block?.type !== 'tool_result' || !workflowToolIds.has(block.tool_use_id)) continue;
      const text = toolResultText(block.content);
      if (!text.includes(runId)) continue;
      parentToolUseId = block.tool_use_id;
      return false;
    }
  });
  return parentToolUseId;
}

function* parseWorkflow(unit: IndexUnit): Generator<TranscriptRecord, Cursor> {
  const mtime = statSync(unit.key).mtimeMs;
  const meta = unit.meta as ClaudeWorkflowUnitMeta;
  const mainSig = workflowMainSignature(meta.mainTranscriptPath);
  const outCursor = `${mtime}:1:${mainSig}`;
  let workflow: any;
  try { workflow = JSON.parse(readFileSync(unit.key, 'utf8')); } catch { return outCursor; }
  if (!workflow?.runId) return outCursor;
  const progress = Array.isArray(workflow.workflowProgress) ? workflow.workflowProgress : [];
  const agents = progress.filter((item: any) => item?.type === 'workflow_agent' && item.agentId);
  const rawParentToolUseId = workflowParentToolUseId(
    meta.mainTranscriptPath,
    workflow.runId,
  );
  const canonicalRunId = scopedId(unit.sessionId, String(workflow.runId));
  yield {
    kind: 'workflow',
    run_id: canonicalRunId,
    session_id: unit.sessionId,
    parent_tool_use_id: rawParentToolUseId ? scopedId(unit.sessionId, rawParentToolUseId) : null,
    task_id: workflow.taskId || null,
    script: workflow.script || null,
    result_json: workflow.result ? JSON.stringify(workflow.result) : null,
    timestamp: normalizeTranscriptTimestamp(workflow.timestamp),
    agent_count: agents.length,
    duration_ms: workflow.durationMs || null,
    total_tokens: workflow.totalTokens || null,
    status: workflow.status || null,
    workflow_name: workflow.workflowName || null,
  };
  for (const item of agents) {
    yield {
      kind: 'workflow_agent',
      agent_id: scopedId(unit.sessionId, `agent-${item.agentId}`),
      run_id: canonicalRunId,
      session_id: unit.sessionId,
      phase: item.phaseTitle || null,
      label: item.label || null,
      model: item.model || null,
      state: item.state || null,
      duration_ms: item.durationMs || null,
      tokens: item.tokens || null,
      tool_calls: item.toolCalls || null,
    };
  }
  return outCursor;
}

export function* parse(unit: IndexUnit, cursor: Cursor): Generator<TranscriptRecord, Cursor> {
  const meta = unit.meta as { aliasTransition?: ClaudeAliasTransition; sourceRoot?: ClaudePhysicalRoot } | undefined;
  const { aliasTransition: transition, sourceRoot } = meta ?? {};
  if (sourceRoot !== undefined) assertRootIdentity(sourceRoot);
  if (transition === undefined) {
    const nextCursor = yield* parseUnit(unit, cursor);
    if (sourceRoot !== undefined) assertRootIdentity(sourceRoot);
    return nextCursor;
  }
  const memberSignature = workflowMainSignature(unit.key);
  assertTranscriptSignature(transition.path, transition.signature);
  assertTranscriptSignature(unit.key, memberSignature);
  const nextCursor = yield* parseUnit(unit, null);
  assertTranscriptSignature(unit.key, memberSignature);
  assertTranscriptSignature(transition.path, transition.signature);
  if (sourceRoot !== undefined) assertRootIdentity(sourceRoot);
  return nextCursor;
}

function* parseUnit(unit: IndexUnit, cursor: Cursor): Generator<TranscriptRecord, Cursor> {
  const rootObservation = unit.meta as ClaudeRootObservation | undefined;
  if (rootObservation?.kind === 'root-observation') {
    for (const [configured, physical] of rootObservation.roots) {
      const resolved = tryRealpath(configured);
      if (resolved === null ? physical !== null : physical === null || !sameNormalizedPath(resolved, physical.path)) {
        throw new RetryableSourceReadError(configured, 'Configured Claude root changed during discovery');
      }
      if (physical !== null) assertRootIdentity(physical);
    }
    return rootObservation.cursor;
  }
  if ((unit.meta as ClaudeOrphanFamilyMeta | undefined)?.kind === 'orphan-family') {
    return yield* parseOrphanFamily(unit, cursor);
  }
  if ((unit.meta as ClaudeWorkflowUnitMeta | undefined)?.kind === 'workflow') {
    return yield* parseWorkflow(unit);
  }
  const stat = statSync(unit.key);
  const fields = cursor?.split(':') ?? [];
  const resume = fields.length < 5 || (checkpointIdentifiesFile(fields, stat) && stat.size >= Number(fields[2]));
  const skip = resume ? cursorToSkip(cursor) : 0;
  const mtime = stat.mtimeMs;
  const isSubagent = unit.isSubagent === true;
  const location = isSubagent ? null : transcriptLocation(unit.key);
  const physical = location === null ? null : tryRealpath(location.root);
  const rootIdentity = physical !== null && location !== null && sameNormalizedPath(location.root, physical)
    ? physicalDirectoryIdentity(physical) : null;
  const records: TranscriptRecord[] = [];
  const queuedAttachmentUuids = new Set<string>();
  const historyTitle = ((unit.meta as { historyTitle?: string } | undefined)?.historyTitle ?? null) as string | null;
  let aiTitle: string | null = null;
  let customTitle: string | null = null;
  const sm = {
    started_at: null as string | null,
    ended_at: null as string | null,
    git_branch: null as string | null,
    version: null as string | null,
    n: 0,
  };
  const subagentStats = {
    startedAt: null as string | null,
    endedAt: null as string | null,
    totalTokens: 0,
  };

  let lineNum = 0;
  // Lines the cursor may safely skip on the next parse. A line only counts
  // when it parsed, or when it is newline-terminated (mid-file garbage keeps
  // the legacy count). An unterminated tail that fails to parse may still be
  // growing — counting it would permanently skip the completed line.
  let cursorLines = 0;
  readLines(unit.key, (line: string, terminated: boolean) => {
    lineNum++;
    let obj: any;
    let parsed = true;
    try { obj = JSON.parse(line); } catch { parsed = false; }
    if (parsed || terminated) cursorLines = lineNum;
    if (!parsed) return;
    const sid = unit.sessionId;
    const ts = normalizeTranscriptTimestamp(obj.timestamp);
    const msg = obj.message || {};
    const usage = msg.usage || {};
    const queuedContent = isSubagent ? null : humanQueuedContent(obj);
    if (queuedContent !== null) queuedAttachmentUuids.add(obj.uuid);

    // Claude Code now persists app-, CLI-, and hook-assigned session names as
    // `custom-title` records. Scan title metadata across the whole transcript,
    // including cursor-skipped lines, so incremental parses retain the intended
    // precedence without depending on the previously persisted title.
    if (obj.type === 'custom-title' && obj.customTitle) {
      customTitle = obj.customTitle;
      return;
    }
    if (obj.type === 'ai-title' && obj.aiTitle) {
      aiTitle = obj.aiTitle;
      return;
    }

    if (isSubagent && (obj.type === 'user' || obj.type === 'assistant')) {
      if (ts && (!subagentStats.startedAt || ts < subagentStats.startedAt)) subagentStats.startedAt = ts;
      if (ts && (!subagentStats.endedAt || ts > subagentStats.endedAt)) subagentStats.endedAt = ts;
      subagentStats.totalTokens += (totalInputTokens(usage) ?? 0) + (usage.output_tokens ?? 0);
    }
    if (lineNum <= skip) return;

    if (obj.type === 'system' && obj.subtype === 'away_summary' && obj.content) {
      records.push({ kind: 'summary', id: scopedId(sid, obj.uuid || `${bareSessionId(sid)}-away-${ts}`), session_id: sid, timestamp: ts, source: 'away_summary', content: obj.content, visibility: 'visible' });
      return;
    }
    if (obj.type === 'system' && obj.subtype === 'turn_duration' && obj.parentUuid && obj.durationMs) {
      records.push({ kind: 'message-turn-duration', uuid: parentMessageUuid(sid, obj.parentUuid, queuedAttachmentUuids), turn_duration_ms: obj.durationMs });
      return;
    }
    if (queuedContent !== null) {
      if (ts && (!sm.started_at || ts < sm.started_at)) sm.started_at = ts;
      if (ts && (!sm.ended_at || ts > sm.ended_at)) sm.ended_at = ts;
      sm.n++;
      records.push({
        kind: 'message', uuid: queuedAttachmentMessageUuid(sid, obj.uuid), session_id: sid,
        type: 'user', parent_uuid: typeof obj.parentUuid === 'string' && obj.parentUuid.length > 0
          ? parentMessageUuid(sid, obj.parentUuid, queuedAttachmentUuids) : null,
        timestamp: ts, role: 'user', text: trunc(queuedContent.text), content_type: queuedContent.contentType,
        is_meta: 0, harness_kind: null, visibility: 'visible', model: null,
        is_sidechain: obj.isSidechain ? 1 : 0,
        agent_id: typeof obj.agentId === 'string' && obj.agentId ? scopedId(sid, obj.agentId) : null,
        input_tokens: null, output_tokens: null,
        cwd: typeof obj.cwd === 'string' && obj.cwd ? obj.cwd : null, skill: null, source: 'claude',
      });
      return;
    }
    if (obj.type !== 'user' && obj.type !== 'assistant') return;

    if (ts && (!sm.started_at || ts < sm.started_at)) sm.started_at = ts;
    if (ts && (!sm.ended_at || ts > sm.ended_at)) sm.ended_at = ts;
    if (obj.gitBranch) sm.git_branch = obj.gitBranch;
    if (obj.version) sm.version = obj.version;
    sm.n++;

    const fullText = extractText(msg.content, Infinity);
    const text = trunc(fullText);
    // Preserve canonical classification independently of the caller's output budget.
    const classificationText = trunc(fullText, TEXT_LIMIT);
    const rawContentType = extractContentType(msg.content);
    const harnessKind = extractHarnessKind(obj, classificationText);
    const contentType = harnessKind === 'skill' ? 'skill_instructions' : rawContentType;
    const rawAid = isSubagent ? (unit.agentId ?? null) : (obj.agentId || null);
    const aid = rawAid ? scopedId(sid, rawAid) : null;

    const msgUuid = messageUuid(sid, obj.uuid);
    if (obj.uuid) {
      records.push({
        kind: 'message', uuid: msgUuid, session_id: sid, type: obj.type,
        parent_uuid: obj.parentUuid ? parentMessageUuid(sid, obj.parentUuid, queuedAttachmentUuids) : null,
        timestamp: ts, role: msg.role || obj.type,
        text, content_type: contentType, is_meta: harnessKind === null ? 0 : 1, harness_kind: harnessKind, visibility: 'visible',
        model: msg.model || null,
        is_sidechain: obj.isSidechain ? 1 : 0, agent_id: aid,
        input_tokens: totalInputTokens(usage), output_tokens: usage.output_tokens || null,
        cwd: obj.cwd || null, skill: obj.attributionSkill || null, source: 'claude',
      });
    }

    if (obj.type === 'assistant' && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type === 'tool_use' && b.id)
          records.push({ kind: 'tool_call', id: scopedId(sid, b.id), message_uuid: msgUuid, session_id: sid, name: b.name, presentation: b.name === 'Skill' ? 'skill' : 'default', input_json: truncJson(b.input || {}) as string, file_path: filePath(b.name, b.input) });
      }
    }

    if (obj.type === 'user' && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type !== 'tool_result' || !b.tool_use_id) continue;
        const rt = typeof b.content === 'string' ? b.content
          : Array.isArray(b.content) ? b.content.map((c: any) => c.text || '').join('\n') : '';
        records.push({ kind: 'tool_result', tool_use_id: scopedId(sid, b.tool_use_id), message_uuid: msgUuid, session_id: sid, content: trunc(rt), file_path: obj.toolUseResult?.filePath || null, is_error: b.is_error ? 1 : 0 });
      }
    }
  });

  if (isSubagent && unit.agentId) {
    const metaPath = unit.key.replace(/\.jsonl$/, '.meta.json');
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
        const workflowRunId = (unit.meta as { workflowRunId?: string } | undefined)?.workflowRunId;
        if (workflowRunId) {
          records.push({
            kind: 'workflow_agent',
            agent_id: scopedId(unit.sessionId, unit.agentId),
            run_id: scopedId(unit.sessionId, workflowRunId),
            session_id: unit.sessionId,
            agent_type: meta.agentType || null,
            description: meta.description || null,
          });
        } else {
          const started = subagentStats.startedAt ? new Date(subagentStats.startedAt).getTime() : null;
          const ended = subagentStats.endedAt ? new Date(subagentStats.endedAt).getTime() : null;
          records.push({
            kind: 'subagent',
            agent_id: scopedId(unit.sessionId, unit.agentId),
            session_id: unit.sessionId,
            parent_tool_use_id: meta.toolUseId ? scopedId(unit.sessionId, meta.toolUseId) : null,
            agent_type: meta.agentType || null,
            description: meta.description || null,
            duration_ms: started !== null && ended !== null ? ended - started : null,
            total_tokens: subagentStats.totalTokens,
          });
        }
      } catch { /* malformed optional subagent metadata */ }
    }
  }

  // Subagent transcripts do not own a session row while their main transcript
  // exists (matches indexJsonl). Claude can leave a session directory behind
  // holding nothing but `subagents/` — the parent `<sessionId>.jsonl` was
  // cleaned up or never flushed — and then no unit would ever publish that
  // session: its records land in messages while the session itself disappears
  // from the catalogue, from session detail, and from every statement that
  // joins sessions. The subagent transcript is the only surviving witness, so
  // it publishes the row. Fresh per-unit snapshots use total counts so they
  // remain canonical detail input; appends use deltas. Finalization reconciles
  // the orphan family count from all stored sibling contributions.
  const mainTranscriptPath = isSubagent ? mainTranscriptPathOf(unit) : null;
  const orphanedSubagent = mainTranscriptPath !== null && transcriptProvedMissing(mainTranscriptPath);
  if (!isSubagent || orphanedSubagent) {
    records.push({
      kind: 'session',
      id: unit.sessionId,
      title: isSubagent ? null : (customTitle ?? aiTitle ?? historyTitle),
      project: unit.project || null,
      started_at: sm.started_at,
      ended_at: sm.ended_at,
      git_branch: isSubagent ? null : sm.git_branch,
      version: isSubagent ? null : sm.version,
      message_count: sm.n,
      countMode: skip > 0 ? 'delta' : 'total',
      jsonl_path: mainTranscriptPath ?? unit.key,
      source: 'claude',
    });
  }

  yield* records;
  const fileCursor = `${mtime}:${cursorLines}:${stat.size}:${stat.ctimeMs}:${stat.ino}:${stat.dev}:${stat.birthtimeMs}`;
  return rootIdentity === null ? fileCursor : `${fileCursor}:${rootIdentity}`;
}

/**
 * The main transcript a subagent transcript belongs to.
 *
 * Subagent units live at `<project>/<sessionId>/subagents[/workflows/<run>]/<agent>.jsonl`,
 * so the owning session file is `<project>/<sessionId>.jsonl` — which is not
 * necessarily on disk any more (see the orphaned-subagent branch in parse).
 */
interface ClaudeOrphanFamilyMeta {
  kind: 'orphan-family';
  members: IndexUnit[];
  signature: string;
  mainPath: string;
  mainCursor: Cursor;
}

function orphanFingerprint(paths: string[], mainCursor: Cursor): string {
  const signature = [...paths].sort().map(path => {
    const stat = statSync(path);
    const sidecar = path.endsWith('.jsonl') ? path.replace(/\.jsonl$/, '.meta.json') : null;
    let metaSignature: number[] | null = null;
    try { const meta = sidecar === null ? null : statSync(sidecar); metaSignature = meta === null ? null : [meta.mtimeMs, meta.ctimeMs, meta.size, meta.ino]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return [path, stat.mtimeMs, stat.ctimeMs, stat.size, stat.ino, stat.dev, metaSignature];
  });
  return `claude-orphan-v1:${createHash('sha256').update(JSON.stringify([signature, mainCursor])).digest('hex')}`;
}

function orphanMemberPaths(directory: string): string[] {
  const paths = readdirSync(directory).filter(name => name.endsWith('.jsonl')).map(name => join(directory, name));
  const workflows = join(directory, 'workflows');
  let runs: string[];
  try { runs = readdirSync(workflows); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return paths; throw error; }
  for (const run of runs) {
    const runPath = join(workflows, run);
    if (!statSync(runPath).isDirectory()) continue;
    for (const name of readdirSync(runPath)) if (name.endsWith('.jsonl')) paths.push(join(runPath, name));
  }
  return paths;
}

function orphanWorkflowPaths(directory: string): string[] {
  const workflows = join(dirname(directory), 'workflows');
  try { return readdirSync(workflows).filter(name => name.endsWith('.json')).map(name => join(workflows, name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}

function* parseOrphanFamily(unit: IndexUnit, _cursor: Cursor): Generator<TranscriptRecord, Cursor> {
  const meta = unit.meta as ClaudeOrphanFamilyMeta;
  const verify = () => {
    if (!transcriptProvedMissing(meta.mainPath)
      || orphanFingerprint([...orphanMemberPaths(unit.key), ...orphanWorkflowPaths(unit.key)], meta.mainCursor) !== meta.signature) {
      throw new RetryableSourceReadError(unit.key, 'Orphan transcript family changed during snapshot');
    }
  };
  verify();
  const records: TranscriptRecord[] = [];
  const sessions: Extract<TranscriptRecord, { kind: 'session' }>[] = [];
  for (const member of meta.members) {
    const sidecar = member.key.replace(/\.jsonl$/, '.meta.json');
    try {
      const data = JSON.parse(readFileSync(sidecar, 'utf8'));
      if (data === null || typeof data !== 'object' || Array.isArray(data)
        || (data.agentType !== undefined && typeof data.agentType !== 'string')
        || (data.description !== undefined && typeof data.description !== 'string')) {
        throw new Error('Orphan subagent metadata has no stable object shape');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new RetryableSourceReadError(sidecar, 'Orphan subagent metadata is incomplete or invalid', { cause: error });
      }
    }
    let hasJson = false;
    readLines(member.key, (line, terminated) => {
      if (!line.trim()) return;
      try { JSON.parse(line); hasJson = true; }
      catch { throw new RetryableSourceReadError(member.key, terminated ? 'Malformed orphan transcript' : 'Incomplete orphan transcript'); }
    });
    if (!hasJson) throw new RetryableSourceReadError(member.key, 'Orphan transcript has no stable records');
    for (const record of parse(member, null)) {
      if (record.kind === 'session') sessions.push(record);
      else records.push(record);
    }
  }
  for (const path of orphanWorkflowPaths(unit.key)) {
    const workflow = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof workflow?.runId !== 'string' || !workflow.runId) {
      throw new RetryableSourceReadError(path, 'Orphan workflow has no stable identity');
    }
    records.push(...parseWorkflow({ key: path, sessionId: unit.sessionId, project: unit.project,
      meta: { kind: 'workflow', mainTranscriptPath: meta.mainPath } satisfies ClaudeWorkflowUnitMeta }));
  }
  verify();
  yield* records;
  const timestamps = sessions.flatMap(session => [session.started_at, session.ended_at]).filter((value): value is string => value !== null).sort();
  yield {
    kind: 'session', id: unit.sessionId, title: null, project: unit.project ?? null,
    started_at: timestamps[0] ?? null, ended_at: timestamps.at(-1) ?? null,
    git_branch: null, version: null,
    message_count: new Set(records.filter(record => record.kind === 'message').map(record => record.uuid)).size,
    countMode: 'total', jsonl_path: meta.mainPath, source: 'claude',
  };
  return meta.signature;
}

function mainTranscriptPathOf(unit: IndexUnit): string | null {
  // Match the owning session directory rather than the first ancestor named
  // subagents (the user's home or project can legally contain that name).
  let directory = dirname(unit.key);
  const rawId = bareSessionId(unit.sessionId);
  while (dirname(directory) !== directory) {
    const parent = dirname(directory);
    if (basename(directory) === 'subagents' && basename(parent) === rawId) {
      return join(dirname(parent), `${rawId}.jsonl`);
    }
    directory = parent;
  }
  return null;
}

function transcriptProvedMissing(path: string): boolean {
  try { statSync(path); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
}

function rawClaude(input: RawLookup): RawRecord | null {
  const mainPath = typeof input.session?.jsonl_path === 'string' ? input.session.jsonl_path : null;
  if (mainPath === null) return null;
  const location = transcriptLocation(mainPath);
  if (location !== null) {
    const realRoot = tryRealpath(location.root);
    const rootIdentity = checkpointRootIdentity(input.cursor ?? null);
    if (rootIdentity !== null && rootIdentity !== physicalDirectoryIdentity(location.root)) return null;
    if (realRoot !== null && !sameNormalizedPath(location.root, realRoot)) {
      if (checkpointMatchesFile(input.cursor ?? null, mainPath) === null) return null;
    } else if (input.cursor != null && !mayUseStoredPath(input.cursor, mainPath)) {
      return null;
    }
  }
  let sourcePath = mainPath;
  if (input.agentId !== null) {
    const runId = input.workflowAgent?.['run_id'];
    const bareId = bareSessionId(input.session?.id);
    const rawAgentId = extractRawUuid(input.agentId, input.session?.id);
    const rawRunId = typeof runId === 'string' ? extractRawUuid(runId, input.session?.id) : null;
    if (!isSafePathSegment(bareId) || !isSafePathSegment(rawAgentId)) return null;
    if (rawRunId !== null && !isSafePathSegment(rawRunId)) return null;
    const subagentsDir = resolve(dirname(mainPath), bareId, 'subagents');
    const containerDir = rawRunId !== null ? resolve(subagentsDir, 'workflows', rawRunId) : subagentsDir;
    sourcePath = resolve(containerDir, `${rawAgentId}.jsonl`);
    if (!lexicalPathInside(containerDir, sourcePath)) return null;
    if (!existsSync(sourcePath)) return null;
    const realContainer = tryRealpath(subagentsDir);
    const realSource = tryRealpath(sourcePath);
    if (realContainer === null || realSource === null || !lexicalPathInside(realContainer, realSource)) {
      return null;
    }
  } else if (!existsSync(sourcePath)) {
    return null;
  }
  let found: string | null = null;
  // Alias reconciliation rewrites the root prefix while preserving Claude's
  // local attachment key; decode that extra session prefix only for messages.
  const rawMsgUuid = extractQueuedAttachmentRawUuid(input.messageUuid, input.session?.id);
  readLines(sourcePath, (line: string) => {
    if (!line.includes(rawMsgUuid)) return;
    try {
      if (JSON.parse(line)?.uuid === rawMsgUuid) {
        found = line;
        return false;
      }
    } catch { /* malformed source line */ }
  });
  const raw = found as string | null;
  let messageText: string | null = null;
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw);
      const queuedContent = humanQueuedContent(parsed);
      if (queuedContent !== null) messageText = queuedContent.text;
      else {
        const content = parsed?.message?.content;
        if (typeof content === 'string') messageText = content;
        else if (Array.isArray(content)) {
          const parts = content.map((part) => part?.text ?? part?.thinking).filter((part) => typeof part === 'string');
          messageText = parts.length > 0 ? parts.join('\n') : null;
        }
      }
    } catch { /* malformed source line */ }
  }
  return raw === null
    ? null
    : { text: raw, totalLength: raw.length, offset: 0, limit: raw.length, hasMore: false, messageText };
}

export function createClaudeProvider({
  rootDir = join(homedir(), '.claude'),
  sourceRoots,
  id = name,
  displayName = 'Claude Code',
  vendor = 'Anthropic',
  color = '#d97757',
}: {
  rootDir?: string;
  sourceRoots?: readonly string[];
  id?: string;
  displayName?: string;
  vendor?: string;
  color?: string;
} = {}): ProviderAdapter & { rootTagFor?: (root: string) => string } {
  const defaultRoot = rootDir;
  const usesRootSet = sourceRoots !== undefined;
  const configuredRoots = usesRootSet ? [...sourceRoots] : [rootDir];

  return {
    name: id,
    descriptor: { id, name: displayName, vendor, defaultRoot, color },
    indexVersionMarker: id === name
      ? CLAUDE_CANONICAL_TRANSCRIPT_MARKER
      : `${CLAUDE_CANONICAL_TRANSCRIPT_MARKER}:${id}`,
    rootTagFor: (root: string) => rootTagFor(root, defaultRoot),
    watchTargets: (configuredRoot) => {
      const targets = (
        usesRootSet
        && (sameNormalizedPath(configuredRoot, defaultRoot)
          || configuredRoots.some((r) => sameNormalizedPath(r, configuredRoot)))
      ) ? configuredRoots : [configuredRoot];
      return targets.flatMap((root) => [
        { kind: 'tree' as const, path: join(root, 'projects') },
        { kind: 'file' as const, path: join(root, 'history.jsonl') },
      ]);
    },
    discover: (ctx) => {
      const indexed = ctx.indexedSessions?.() ?? [];
      const roots = new Map<string, string>();
      const physicalRoots = new Map<string, ClaudePhysicalRoot>();
      const observedRoots = new Map<string, ClaudePhysicalRoot | null>();
      for (const configured of configuredRoots) {
        const resolved = tryRealpath(configured);
        const root = canonicalRootPath(resolved ?? configured);
        const key = lexicalPathKey(root);
        roots.set(key, root);
        const observed = resolved === null ? null : physicalRoots.get(key) ?? { path: root, identity: physicalDirectoryIdentity(root) };
        if (observed !== null) physicalRoots.set(key, observed);
        observedRoots.set(configured, observed);
      }
      const transcripts = resolveIndexedRoots([...roots.values()], defaultRoot, configuredRoots, indexed, ctx)
        .flatMap(({ root, sessions, tag, legacyBareIds, blockedPaths }) =>
          discoverAt(root, ctx, id === name ? tag : id, sessions, indexed, usesRootSet, legacyBareIds, blockedPaths,
            physicalRoots.get(lexicalPathKey(root)) ?? { path: root, identity: null }));
      return [...rootObservationUnits(observedRoots, physicalRoots, indexed, ctx, usesRootSet), ...transcripts];
    },
    parse,
    raw: rawClaude,
  };
}
