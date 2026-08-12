// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import {
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from 'node:path';

import {
  normalizeObservedCwd,
  projectSlugFromPath,
  TEXT_LIMIT,
  trunc,
  truncJson,
} from '../parsing.ts';
import type {
  Cursor,
  DiscoverContext,
  IndexUnit,
  InventoryIssue,
  MessageRecord,
  MessageVisibility,
  ProviderAdapter,
  RawLookup,
  RawRecord,
  TranscriptRecord,
} from './types.ts';

type JsonRecord = Record<string, any>;

interface PiHeader extends JsonRecord {
  type: 'session';
  version?: number;
  id: string;
  timestamp?: string;
  cwd?: string;
  parentSession?: string;
}

interface PiLine {
  readonly line: number;
  readonly ordinal: number;
  readonly raw: string;
  readonly record: JsonRecord;
}

interface PiEntryLine extends PiLine {
  readonly record: JsonRecord & {
    id: string;
    parentId: string | null;
  };
}

interface PiSessionUnitMeta {
  readonly kind: 'pi-session' | 'pi-tombstone';
  readonly discoveredSessionId: string | null;
  readonly collisionPaths?: readonly string[];
}

interface PiProjection {
  readonly records: TranscriptRecord[];
  readonly messageCount: number;
  readonly title: string | null;
  readonly endedAt: string | null;
}

interface PiToolOccurrence {
  readonly id: string;
  readonly filePath: string | null;
  readonly visibility: MessageVisibility;
}

interface PiToolScope {
  readonly nativeId: string;
  readonly occurrence: PiToolOccurrence | null;
  readonly parent: PiToolScope | null;
}

interface PiMessageProjection {
  readonly tail: string | null;
  readonly toolScope: PiToolScope | null;
}

export interface PiRootResolution {
  readonly root: string;
  readonly requiresExplicitRoot: boolean;
  readonly reason?: string;
}

export interface PiProvider extends ProviderAdapter {
  readonly rootResolution: PiRootResolution;
}

const SOURCE = 'pi';
const MAX_HEADER_BYTES = 1024 * 1024;
const BLOCK_PAD = 4;

export const PI_CANONICAL_TRANSCRIPT_MARKER = '__pi_canonical_transcript_v9__';

function inventoryIssue(sourcePath: string, error: unknown): InventoryIssue {
  const errorPath = (error as { path?: unknown } | null)?.path;
  return {
    path: typeof errorPath === 'string' ? errorPath : sourcePath,
    error: error instanceof Error ? error.message : String(error),
  };
}

function reportInventory(
  ctx: DiscoverContext,
  complete: boolean,
  issue: InventoryIssue | null,
  fallbackPath: string,
): void {
  if (!complete) ctx.reportIncompleteInventory?.(issue ?? {
    path: fallbackPath,
    error: 'Source inventory is incomplete',
  });
}

function expandTilde(path: string, homeDir: string): string {
  if (path === '~') return homeDir;
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homeDir, path.slice(2));
  return path;
}

function configuredAbsolutePath(value: unknown, homeDir: string): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const expanded = expandTilde(value.trim(), homeDir);
  return isAbsolute(expanded) ? normalize(expanded) : null;
}

function defaultAgentDir(homeDir: string): string {
  return join(homeDir, '.pi', 'agent');
}

function readSettings(path: string): JsonRecord {
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as JsonRecord
      : {};
  } catch {
    // Pi 0.83 records the load error and continues with an empty settings scope.
    return {};
  }
}

export function resolveDefaultPiRoot({
  env = process.env,
  homeDir = homedir(),
  cwd = process.cwd(),
}: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  cwd?: string;
} = {}): PiRootResolution {
  const fallbackAgentDir = defaultAgentDir(homeDir);
  const fallbackRoot = join(fallbackAgentDir, 'sessions');
  const envSessionDir = env['PI_CODING_AGENT_SESSION_DIR'];
  if (typeof envSessionDir === 'string' && envSessionDir.trim().length > 0) {
    const absolute = configuredAbsolutePath(envSessionDir, homeDir);
    return absolute === null
      ? {
          root: fallbackRoot,
          requiresExplicitRoot: true,
          reason: 'PI_CODING_AGENT_SESSION_DIR is relative to the Pi launch cwd',
        }
      : { root: absolute, requiresExplicitRoot: false };
  }

  const envAgentDir = env['PI_CODING_AGENT_DIR'];
  let agentDir = fallbackAgentDir;
  if (typeof envAgentDir === 'string' && envAgentDir.trim().length > 0) {
    const absolute = configuredAbsolutePath(envAgentDir, homeDir);
    if (absolute === null) {
      return {
        root: fallbackRoot,
        requiresExplicitRoot: true,
        reason: 'PI_CODING_AGENT_DIR is relative to the Pi launch cwd',
      };
    }
    agentDir = absolute;
  }

  const globalSettings = readSettings(join(agentDir, 'settings.json'));
  const projectCwd = normalizeObservedCwd(cwd);
  const projectSettings = projectCwd === null
    ? {}
    : readSettings(join(projectCwd, '.pi', 'settings.json'));
  const projectOverridesSessionDir = Object.prototype.hasOwnProperty.call(
    projectSettings,
    'sessionDir',
  );
  const sessionDir = projectOverridesSessionDir
    ? projectSettings.sessionDir
    : globalSettings.sessionDir;
  if (typeof sessionDir === 'string' && sessionDir.trim().length > 0) {
    const expanded = expandTilde(sessionDir.trim(), homeDir);
    if (isAbsolute(expanded)) {
      return { root: normalize(expanded), requiresExplicitRoot: false };
    }
    if (projectOverridesSessionDir && projectCwd !== null) {
      return { root: resolve(projectCwd, expanded), requiresExplicitRoot: false };
    }
    return {
      root: join(agentDir, 'sessions'),
      requiresExplicitRoot: true,
      reason: 'Pi global settings.json sessionDir is relative to the Pi launch cwd',
    };
  }
  if (
    sessionDir !== undefined
    && sessionDir !== null
    && sessionDir !== ''
  ) {
    return {
      root: join(agentDir, 'sessions'),
      requiresExplicitRoot: true,
      reason: 'Pi settings.json sessionDir must be a string',
    };
  }
  return { root: join(agentDir, 'sessions'), requiresExplicitRoot: false };
}

function resolvePiRoot(rootDir: string | undefined, cwd: string | undefined): PiRootResolution {
  if (rootDir !== undefined) {
    const absolute = configuredAbsolutePath(rootDir, homedir());
    if (absolute !== null) return { root: absolute, requiresExplicitRoot: false };
  }
  const automatic = resolveDefaultPiRoot({ cwd });
  return rootDir === undefined
    ? automatic
    : {
        root: automatic.root,
        requiresExplicitRoot: true,
        reason: 'Obelisk Pi providerRoot must be absolute or start with ~',
      };
}

function inspectHeader(path: string): PiHeader {
  const fd = openSync(path, 'r');
  let pending = Buffer.alloc(0);
  let scanned = 0;
  const inspectLine = (lineBuffer: Buffer): PiHeader | null => {
    const line = lineBuffer.toString('utf8').replace(/\r$/, '');
    if (line.trim().length === 0) return null;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      // Pi's loader skips malformed physical lines while looking for the first
      // parsed entry. Full transcript parsing remains strict.
      return null;
    }
    return asHeader(value, path);
  };
  try {
    while (scanned < MAX_HEADER_BYTES) {
      const buffer = Buffer.alloc(Math.min(4096, MAX_HEADER_BYTES - scanned));
      const bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) {
        if (pending.length > 0) {
          const header = inspectLine(pending);
          if (header !== null) return header;
        }
        throw new Error(`Malformed Pi session header in ${path}`);
      }
      scanned += bytes;
      const chunk = buffer.subarray(0, bytes);
      let combined = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let newline = combined.indexOf(10);
      while (newline >= 0) {
        const header = inspectLine(combined.subarray(0, newline));
        if (header !== null) return header;
        combined = combined.subarray(newline + 1);
        newline = combined.indexOf(10);
      }
      pending = Buffer.from(combined);
    }
    const probe = Buffer.alloc(1);
    if (readSync(fd, probe, 0, 1, null) === 0) {
      if (pending.length > 0) {
        const header = inspectLine(pending);
        if (header !== null) return header;
      }
      throw new Error(`Malformed Pi session header in ${path}`);
    }
    throw new Error(`Pi session header exceeds ${MAX_HEADER_BYTES} bytes: ${path}`);
  } finally {
    closeSync(fd);
  }
}

function asHeader(value: unknown, path: string): PiHeader {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Pi session header is not an object: ${path}`);
  }
  const header = value as JsonRecord;
  const version = header.version ?? 1;
  if (
    header.type !== 'session'
    || typeof header.id !== 'string'
    || header.id.length === 0
    || (header.timestamp !== undefined && typeof header.timestamp !== 'string')
    || (header.cwd !== undefined && typeof header.cwd !== 'string')
    || !Number.isInteger(version)
    || version < 1
    || version > 3
  ) {
    throw new Error(`Unsupported or malformed Pi session header: ${path}`);
  }
  if (header.parentSession !== undefined && typeof header.parentSession !== 'string') {
    throw new Error(`Malformed Pi parentSession in ${path}`);
  }
  return header as PiHeader;
}

export function piSessionId(header: PiHeader): string {
  // Pi's --session-id lookup is project-local, so the header id alone is not
  // globally unique. The immutable header cwd supplies a path-independent
  // namespace. Pi's permissive v1 loader also accepts a missing cwd; those
  // sessions share a deterministic legacy namespace rather than inheriting
  // Obelisk's unrelated launch cwd.
  const cwd = normalizeObservedCwd(header.cwd) ?? header.cwd ?? '';
  const projectScope = createHash('sha256')
    .update('pi-cwd-v1\0')
    .update(cwd)
    .digest('hex');
  return `pi:${encodeURIComponent(header.id)}:${projectScope}`;
}

function invalidUnitId(path: string): string {
  return `pi:invalid:${createHash('sha256').update(path).digest('hex').slice(0, 24)}`;
}

function listJsonlFiles(root: string): {
  files: string[];
  complete: boolean;
  rootMissing: boolean;
  issue: InventoryIssue | null;
} {
  const stack = [root];
  const files: string[] = [];
  let complete = true;
  let rootMissing = false;
  let issue: InventoryIssue | null = null;
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      complete = false;
      issue ??= inventoryIssue(current, error);
      if (current === root) {
        rootMissing = (error as { code?: unknown } | null)?.code === 'ENOENT';
      }
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.name.toLowerCase().endsWith('.jsonl')) {
        if (entry.isFile()) {
          files.push(normalize(path));
        } else if (entry.isSymbolicLink()) {
          try {
            // Pi lists session names first and follows the path when opening it,
            // so a readable file symlink is live session provenance.
            if (statSync(path).isFile()) files.push(normalize(path));
            else {
              complete = false;
              issue ??= {
                path,
                error: 'Expected a file symlink target',
              };
            }
          } catch (error) {
            complete = false;
            issue ??= inventoryIssue(path, error);
          }
        }
      }
    }
  }
  return { files: files.sort(), complete, rootMissing, issue };
}

function normalizedChangedPaths(root: string, changedPaths: readonly string[] | undefined): string[] | null {
  if (changedPaths === undefined) return null;
  return changedPaths.map((path) => normalize(isAbsolute(path) ? path : join(root, path)));
}

function pathAffected(path: string, changedPaths: readonly string[]): boolean {
  return changedPaths.some((changedPath) => {
    if (path === changedPath) return true;
    const inside = relative(changedPath, path);
    return inside.length > 0 && !inside.startsWith('..') && !isAbsolute(inside);
  });
}

function snapshotCursor(stat: {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  ino: number;
}): string {
  // Keep the legacy mtime/line slots first, while the opaque cursor column
  // retains the complete stat fingerprint for snapshot providers.
  return `${stat.mtimeMs}:0:pi-snapshot-v1:${stat.ctimeMs}:${stat.size}:${stat.ino}`;
}

function fileDigest(path: string, expectedCursor: string): string {
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (snapshotCursor(statSync(path)) !== expectedCursor) {
    throw new Error(`Pi session changed during discovery: ${path}`);
  }
  return digest;
}

function discoverAt(root: string, ctx: DiscoverContext): IndexUnit[] {
  const inventory = listJsonlFiles(root);
  const indexedSessions = (ctx.indexedSessions?.() ?? []).map((session) => ({
    sessionId: session.sessionId,
    path: normalize(session.jsonlPath),
  }));
  const indexedPathBySessionId = new Map(
    indexedSessions.map((session) => [session.sessionId, session.path]),
  );
  // A provider root that has never contributed a session is safely empty. Once
  // Pi provenance exists, the same absence is ambiguous and must preserve it.
  const safelyMissingRoot = inventory.rootMissing && indexedSessions.length === 0;
  let inventoryComplete = inventory.complete || safelyMissingRoot;
  let reportedIssue = safelyMissingRoot ? null : inventory.issue;
  const onIncomplete = (issue: InventoryIssue) => {
    inventoryComplete = false;
    reportedIssue ??= issue;
  };
  const files = inventory.files;
  const fileSet = new Set(files);
  const changedPaths = normalizedChangedPaths(root, ctx.changedPaths);
  const inspectedHeaders = files.map((path) => {
    let beforeCursor: string | null = null;
    let header: PiHeader | null = null;
    let error: Error | null = null;
    try {
      beforeCursor = snapshotCursor(statSync(path));
    } catch (cause) {
      onIncomplete(inventoryIssue(path, cause));
    }
    try {
      header = inspectHeader(path);
    } catch (cause) {
      error = cause instanceof Error ? cause : new Error(String(cause));
    }
    return { path, header, error, beforeCursor };
  });
  const inspected = inspectedHeaders.flatMap(({ path, header, error, beforeCursor }) => {
    let currentCursor: string;
    try {
      currentCursor = snapshotCursor(statSync(path));
    } catch (cause) {
      onIncomplete(inventoryIssue(path, cause));
      return [];
    }
    if (beforeCursor === null) return [];
    if (beforeCursor !== currentCursor) {
      onIncomplete({
        path,
        error: 'Session changed during discovery',
      });
      return [];
    }
    return [{
      path,
      header,
      sessionId: header === null ? invalidUnitId(path) : piSessionId(header),
      error,
      currentCursor,
    }];
  });

  const groups = new Map<string, typeof inspected>();
  for (const file of inspected) {
    const group = groups.get(file.sessionId) ?? [];
    group.push(file);
    groups.set(file.sessionId, group);
  }
  const selectedGroups: Array<{
    groupSessionId: string;
    group: typeof inspected;
    candidates: typeof inspected;
    collisionPaths?: readonly string[];
  }> = [];
  for (const [groupSessionId, group] of groups) {
    let candidates = group;
    let collisionPaths: readonly string[] | undefined;
    if (group.length > 1 && group.every((file) => file.error === null)) {
      const digests = new Set<string>();
      let digestFailed = false;
      for (const file of group) {
        try {
          digests.add(fileDigest(file.path, file.currentCursor));
        } catch (error) {
          onIncomplete(inventoryIssue(file.path, error));
          digestFailed = true;
        }
      }
      if (digestFailed) {
        continue;
      }
      if (digests.size === 1) candidates = [group[0]!];
      else collisionPaths = group.map((file) => file.path);
    }
    selectedGroups.push({ groupSessionId, group, candidates, collisionPaths });
  }
  reportInventory(ctx, inventoryComplete, reportedIssue, root);

  const validByPath = new Map(
    inspected
      .filter((file) => file.error === null)
      .map((file) => [file.path, file] as const),
  );
  const validSessionIds = new Set(
    inspected.filter((file) => file.error === null).map((file) => file.sessionId),
  );
  const identityCensusComplete = (
    inventoryComplete
    && inspected.length === files.length
    && inspected.every((file) => file.error === null)
  );
  const forceSessionIds = new Set<string>();
  const retractionsByPath = new Map<string, Set<string>>();
  const tombstones: IndexUnit[] = [];
  for (const indexed of indexedSessions) {
    if (!inventoryComplete) continue;
    const shouldReconcile = changedPaths === null
      ? true
      : pathAffected(indexed.path, changedPaths);
    if (!shouldReconcile) continue;

    const current = validByPath.get(indexed.path);
    if (current !== undefined) {
      if (current.sessionId !== indexed.sessionId) {
        if (validSessionIds.has(indexed.sessionId)) {
          forceSessionIds.add(indexed.sessionId);
        } else if (identityCensusComplete) {
          const retractions = retractionsByPath.get(indexed.path) ?? new Set<string>();
          retractions.add(indexed.sessionId);
          retractionsByPath.set(indexed.path, retractions);
        }
      }
      continue;
    }
    if (validSessionIds.has(indexed.sessionId)) {
      // A valid copy survived a move, unlink, or torn duplicate. Reparse it so
      // jsonl_path follows readable provenance instead of a missing/bad source.
      forceSessionIds.add(indexed.sessionId);
      continue;
    }
    if (fileSet.has(indexed.path)) {
      // The source still exists but its header is currently invalid. Preserve
      // the last committed session until a complete replacement can parse.
      continue;
    }
    if (!identityCensusComplete) continue;
    tombstones.push({
      key: indexed.path,
      sessionId: indexed.sessionId,
      retractSessionIds: [indexed.sessionId],
      meta: {
        kind: 'pi-tombstone',
        discoveredSessionId: null,
      } satisfies PiSessionUnitMeta,
    });
  }

  const units: IndexUnit[] = [];
  for (const { groupSessionId, group, candidates, collisionPaths } of selectedGroups) {
    const groupRetractions = [...new Set(group.flatMap(
      (file) => [...(retractionsByPath.get(file.path) ?? [])],
    ))];
    const groupChanged = changedPaths !== null && group.some((file) => pathAffected(file.path, changedPaths));
    const forced = forceSessionIds.has(groupSessionId) || groupRetractions.length > 0;
    for (const file of candidates) {
      if (changedPaths !== null && !groupChanged && !forced) continue;
      const cursor = ctx.lastCursor(file.path);
      if (changedPaths === null && !forced && cursor === file.currentCursor) continue;
      const indexedPath = indexedPathBySessionId.get(file.sessionId);
      // Publishing a different copy for an existing logical session depends on
      // certifying the provider-wide identity census. A readable unit remains
      // source-local only when it is new or owns the committed provenance.
      const sourceLocal = (
        groupRetractions.length === 0
        && (indexedPath === undefined || indexedPath === file.path)
      );
      if (!inventoryComplete && !sourceLocal) continue;
      units.push({
        key: file.path,
        sessionId: file.sessionId,
        ...(groupRetractions.length === 0 ? {} : { retractSessionIds: groupRetractions }),
        project: file.header === null
          ? undefined
          : projectSlugFromPath(normalizeObservedCwd(file.header.cwd)) ?? undefined,
        meta: {
          kind: 'pi-session',
          discoveredSessionId: file.sessionId,
          ...(collisionPaths === undefined ? {} : { collisionPaths }),
        } satisfies PiSessionUnitMeta,
      });
    }
  }
  return [...units, ...tombstones].sort((left, right) => (
    left.key.localeCompare(right.key)
    || left.sessionId.localeCompare(right.sessionId)
  ));
}

function parseLines(path: string): {
  header: PiHeader;
  entries: PiEntryLine[];
  cursor: string;
  snapshot: string;
} {
  const before = statSync(path);
  const raw = readFileSync(path, 'utf8');
  const after = statSync(path);
  if (snapshotCursor(before) !== snapshotCursor(after)) {
    throw new Error(`Pi session changed while indexing: ${path}`);
  }

  const segments = raw.split('\n');
  const lines: PiLine[] = [];
  for (let index = 0; index < segments.length; index++) {
    let line = segments[index]!;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.trim().length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(line) as unknown;
    } catch {
      // Pi 0.83 skips malformed physical lines, including an incomplete tail.
      // Stable-file checks around this parse still make a later append retryable.
      continue;
    }
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error(`Malformed Pi JSONL value at line ${index + 1} in ${path}`);
    }
    lines.push({
      line: index + 1,
      ordinal: lines.length,
      raw: line,
      record: record as JsonRecord,
    });
  }
  if (lines.length === 0) throw new Error(`Empty Pi session: ${path}`);
  const header = asHeader(lines[0]!.record, path);
  const version = header.version ?? 1;
  const sourceEntries = lines.slice(1).map(({ line, ordinal, raw: lineRaw, record }) => ({
    line,
    ordinal,
    raw: lineRaw,
    record: { ...record },
  }));

  if (version === 1) {
    let previousId: string | null = null;
    for (let index = 0; index < sourceEntries.length; index++) {
      const entry = sourceEntries[index]!.record;
      entry.id = `v1-entry-${sourceEntries[index]!.ordinal}`;
      entry.parentId = previousId;
      previousId = entry.id;
      if (entry.type === 'compaction' && typeof entry.firstKeptEntryIndex === 'number') {
        const target = lines[entry.firstKeptEntryIndex];
        if (target !== undefined && target.record.type !== 'session') {
          entry.firstKeptEntryId = `v1-entry-${target.ordinal}`;
        }
        delete entry.firstKeptEntryIndex;
      }
    }
  }
  if (version <= 2) {
    for (const entry of sourceEntries) {
      if (entry.record.type === 'message' && entry.record.message?.role === 'hookMessage') {
        entry.record.message = { ...entry.record.message, role: 'custom' };
      }
    }
  }

  const entries: PiEntryLine[] = sourceEntries.map((entry) => {
    const { id, parentId } = entry.record;
    if (
      typeof id !== 'string'
      || id.length === 0
      || (parentId !== null && typeof parentId !== 'string')
      || typeof entry.record.type !== 'string'
      || typeof entry.record.timestamp !== 'string'
    ) {
      throw new Error(`Malformed Pi entry at line ${entry.line} in ${path}`);
    }
    return entry as PiEntryLine;
  });
  return {
    header,
    entries,
    cursor: snapshotCursor(after),
    snapshot: snapshotCursor(after),
  };
}

function checkpointCompactions(entries: readonly PiEntryLine[]): Set<string> {
  const checkpoints = new Set<string>();
  for (const entry of entries) {
    if (entry.record.type !== 'compaction' || entry.record.retainedTail === undefined) continue;
    if (!Array.isArray(entry.record.retainedTail)) {
      throw new Error(`Malformed retainedTail at Pi line ${entry.line}`);
    }
    checkpoints.add(entry.record.id);
  }
  return checkpoints;
}

function activeContextEntries(
  headId: string | null,
  byId: ReadonlyMap<string, PiEntryLine>,
  checkpoints: ReadonlySet<string>,
): Set<string> {
  if (headId === null) return new Set();

  // retainedTail is agent-core's storage checkpoint format: stop there before
  // applying its context transform. Legacy-only chains keep coding-agent's
  // firstKeptEntryId behavior, including nested legacy compactions.
  const reversePath: PiEntryLine[] = [];
  const visited = new Set<string>();
  let currentId: string | null = headId;
  while (currentId !== null) {
    if (visited.has(currentId)) throw new Error(`Pi active branch contains a cycle at ${currentId}`);
    visited.add(currentId);
    const current = byId.get(currentId);
    if (current === undefined) throw new Error(`Pi active head ${currentId} does not exist`);
    reversePath.push(current);
    if (checkpoints.has(current.record.id)) break;
    const parentId = current.record.parentId;
    currentId = parentId !== null && byId.has(parentId) ? parentId : null;
  }

  // Mirror Pi's defaultContextEntryTransform(): only the latest compaction
  // contributes context, with either its retained tail or its kept ancestors.
  const path = reversePath.reverse();
  let compactionIndex = -1;
  for (let index = 0; index < path.length; index++) {
    if (path[index]!.record.type === 'compaction') compactionIndex = index;
  }
  if (compactionIndex < 0) return new Set(path.map((entry) => entry.record.id));

  const compaction = path[compactionIndex]!;
  const active = new Set<string>([
    compaction.record.id,
    ...path.slice(compactionIndex + 1).map((entry) => entry.record.id),
  ]);
  if (!checkpoints.has(compaction.record.id)) {
    const firstKeptId = typeof compaction.record.firstKeptEntryId === 'string'
      ? compaction.record.firstKeptEntryId
      : null;
    const firstKeptIndex = firstKeptId === null
      ? -1
      : path.findIndex((entry, index) => index < compactionIndex && entry.record.id === firstKeptId);
    if (firstKeptIndex >= 0) {
      for (let index = firstKeptIndex; index < compactionIndex; index++) {
        active.add(path[index]!.record.id);
      }
    }
  }
  return active;
}

function analyzeTree(entries: readonly PiEntryLine[]): {
  byId: Map<string, PiEntryLine>;
  active: Set<string>;
  checkpoints: Set<string>;
} {
  const byId = new Map<string, PiEntryLine>();
  for (const entry of entries) {
    if (byId.has(entry.record.id)) throw new Error(`Duplicate Pi entry id: ${entry.record.id}`);
    byId.set(entry.record.id, entry);
  }
  const checkpoints = checkpointCompactions(entries);

  for (const entry of entries) {
    if (entry.record.type === 'leaf') {
      const targetId = entry.record.targetId;
      if (targetId !== null && typeof targetId !== 'string') {
        throw new Error(`Malformed Pi leaf target at line ${entry.line}`);
      }
      if (typeof targetId === 'string' && !byId.has(targetId)) {
        throw new Error(`Pi leaf target ${targetId} does not exist`);
      }
    }
  }
  // Validate the functional parent graph once. Resolved paths are memoized, so
  // a long linear transcript is O(n) rather than walking every prefix again.
  const resolved = new Set<string>();
  for (const entry of entries) {
    const path: string[] = [];
    const positions = new Map<string, number>();
    let currentId: string | null = entry.record.id;
    while (currentId !== null && !resolved.has(currentId)) {
      if (positions.has(currentId)) throw new Error(`Pi session contains a cycle at ${currentId}`);
      positions.set(currentId, path.length);
      path.push(currentId);
      const current = byId.get(currentId);
      if (current === undefined) {
        throw new Error(`Pi entry ${entry.record.id} has a truncated parent chain`);
      }
      const parentId = current.record.parentId;
      currentId = (
        parentId === null
        || !byId.has(parentId)
      ) ? null : parentId;
    }
    for (const id of path) resolved.add(id);
  }

  let headId: string | null = null;
  for (const entry of entries) {
    headId = entry.record.type === 'leaf' ? entry.record.targetId as string | null : entry.record.id;
  }
  const active = activeContextEntries(headId, byId, checkpoints);
  return { byId, active, checkpoints };
}

function normalizeTime(value: unknown, fallback: string | null = null): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return fallback;
}

function imagePlaceholder(part: JsonRecord): string {
  const mime = typeof part.mimeType === 'string' && part.mimeType.length > 0 ? part.mimeType : 'unknown';
  const chars = typeof part.data === 'string' ? part.data.length : 0;
  return `[image ${mime}; base64 chars=${chars}]`;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (part?.type === 'text' && typeof part.text === 'string') return part.text;
    if (part?.type === 'thinking' && typeof part.thinking === 'string') return part.thinking;
    if (part?.type === 'image') return imagePlaceholder(part);
    return '';
  }).filter((part) => part.length > 0).join('\n');
}

function bashPresentation(message: JsonRecord): { text: string; suffix: string } {
  const command = typeof message.command === 'string' ? message.command : '';
  const output = typeof message.output === 'string' ? message.output : '';
  const text = `Ran \`${command}\`\n${output.length > 0 ? `\`\`\`\n${output}\n\`\`\`` : '(no output)'}`;
  let suffix = '';
  if (message.cancelled === true) suffix += '\n\n(command cancelled)';
  else if (typeof message.exitCode === 'number' && message.exitCode !== 0) {
    suffix += `\n\nCommand exited with code ${message.exitCode}`;
  }
  if (
    message.truncated === true
    && typeof message.fullOutputPath === 'string'
    && message.fullOutputPath.length > 0
  ) {
    suffix += `\n\n[Output truncated. Full output: ${message.fullOutputPath}]`;
  }
  return { text, suffix };
}

function bashText(message: JsonRecord): string {
  const { text, suffix } = bashPresentation(message);
  if (suffix.length === 0) return trunc(text);
  if (suffix.length >= TEXT_LIMIT) return suffix.slice(0, TEXT_LIMIT);
  return `${text.slice(0, TEXT_LIMIT - suffix.length)}${suffix}`;
}

function fullBashText(message: JsonRecord): string {
  const { text, suffix } = bashPresentation(message);
  return `${text}${suffix}`;
}

function messageDisplayText(message: JsonRecord): string | null {
  if (message.role === 'bashExecution') return bashText(message);
  if (message.role === 'branchSummary' || message.role === 'compactionSummary') {
    return typeof message.summary === 'string' ? message.summary : null;
  }
  const text = contentText(message.content);
  if (message.role === 'assistant' && typeof message.errorMessage === 'string' && message.errorMessage.length > 0) {
    return text.length > 0 ? `${text}\n${message.errorMessage}` : message.errorMessage;
  }
  return text.length > 0 ? text : null;
}

function physicalUserTitle(message: JsonRecord): string | null {
  if (message.role !== 'user') return null;
  if (typeof message.content === 'string') {
    const title = message.content.trim();
    return title.length > 0 ? title : null;
  }
  if (!Array.isArray(message.content)) return null;
  const title = message.content
    .flatMap((part) => part?.type === 'text' && typeof part.text === 'string' ? [part.text] : [])
    .join(' ')
    .trim();
  return title.length > 0 ? title : null;
}

function usageFields(message: JsonRecord): { input: number | null; output: number | null } {
  const usage = message.usage;
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) {
    return { input: null, output: null };
  }
  const numeric = (field: string): number | null => (
    typeof usage[field] === 'number' && Number.isFinite(usage[field]) ? usage[field] : null
  );
  const inputs = [numeric('input'), numeric('cacheRead'), numeric('cacheWrite')];
  return {
    input: inputs.some((value) => value !== null)
      ? inputs.reduce<number>((sum, value) => sum + (value ?? 0), 0)
      : null,
    output: numeric('output'),
  };
}

function messageUuid(
  sessionId: string,
  entry: PiEntryLine,
  blockIndex: number,
  tailIndex?: number,
): string {
  const ordinal = String(entry.ordinal).padStart(6, '0');
  const block = String(blockIndex).padStart(BLOCK_PAD, '0');
  return tailIndex === undefined
    ? `${sessionId}:entry:${ordinal}:message:block:${block}`
    : `${sessionId}:entry:${ordinal}:message:tail:${String(tailIndex).padStart(BLOCK_PAD, '0')}:block:${block}`;
}

function toolCallId(messageId: string): string {
  return `${messageId}:tool`;
}

function findToolOccurrence(
  scope: PiToolScope | null,
  nativeId: string,
  visibility: MessageVisibility,
): PiToolOccurrence | null {
  let current = scope;
  while (current !== null) {
    if (current.nativeId === nativeId) {
      const occurrence = current.occurrence;
      if (occurrence === null) return null;
      return visibility === 'inactive' || occurrence.visibility === 'visible'
        ? occurrence
        : null;
    }
    current = current.parent;
  }
  return null;
}

function piFilePath(name: unknown, input: unknown): string | null {
  if (typeof name !== 'string' || !['read', 'edit', 'write'].includes(name.toLowerCase())) return null;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  return typeof (input as JsonRecord).path === 'string' ? (input as JsonRecord).path : null;
}

function projectContent(
  content: unknown,
  emit: (blockIndex: number, contentType: string, text: string | null) => string,
): string[] {
  if (typeof content === 'string') return [emit(0, 'text', trunc(content))];
  if (!Array.isArray(content) || content.length === 0) return [emit(0, 'unknown', null)];
  const uuids: string[] = [];
  for (let index = 0; index < content.length; index++) {
    const part = content[index];
    if (part?.type === 'text' && typeof part.text === 'string') {
      uuids.push(emit(index, 'text', trunc(part.text)));
    } else if (part?.type === 'image') {
      uuids.push(emit(index, 'image', imagePlaceholder(part)));
    } else {
      uuids.push(emit(index, 'unknown', truncJson(part) ?? null));
    }
  }
  return uuids;
}

function projectSession(
  header: PiHeader,
  entries: readonly PiEntryLine[],
  sessionId: string,
  active: ReadonlySet<string>,
  checkpoints: ReadonlySet<string>,
): PiProjection {
  const records: TranscriptRecord[] = [];
  const tailByEntry = new Map<string, string | null>();
  const toolScopeByEntry = new Map<string, PiToolScope | null>();
  let messageCount = 0;
  let latestName: string | null = null;
  let firstUserTitle: string | null = null;
  let endedAt = normalizeTime(header.timestamp);

  const emitMessage = ({
    entry,
    parent,
    blockIndex,
    tailIndex,
    type,
    role,
    text,
    contentType,
    isMeta,
    visibility,
    model,
    timestamp,
  }: {
    entry: PiEntryLine;
    parent: string | null;
    blockIndex: number;
    tailIndex?: number;
    type: string;
    role: string;
    text: string | null;
    contentType: string;
    isMeta: 0 | 1;
    visibility: MessageVisibility;
    model: string | null;
    timestamp: string | null;
  }): MessageRecord => {
    const record: MessageRecord = {
      kind: 'message',
      uuid: messageUuid(sessionId, entry, blockIndex, tailIndex),
      session_id: sessionId,
      type,
      parent_uuid: parent,
      timestamp,
      role,
      text,
      content_type: contentType,
      is_meta: isMeta,
      visibility,
      model,
      is_sidechain: 0,
      agent_id: null,
      input_tokens: null,
      output_tokens: null,
      cwd: normalizeObservedCwd(header.cwd),
      skill: null,
      source: SOURCE,
    };
    records.push(record);
    if (record.visibility === 'visible') messageCount++;
    if (record.timestamp !== null && (endedAt === null || record.timestamp > endedAt)) endedAt = record.timestamp;
    return record;
  };

  const projectAgentMessage = ({
    entry,
    message,
    parent,
    visibility,
    isMeta = 0,
    tailIndex,
    forcedRole,
    accountUsage = true,
    toolScope,
  }: {
    entry: PiEntryLine;
    message: JsonRecord;
    parent: string | null;
    visibility: MessageVisibility;
    isMeta?: 0 | 1;
    tailIndex?: number;
    forcedRole?: 'custom';
    accountUsage?: boolean;
    toolScope: PiToolScope | null;
  }): PiMessageProjection => {
    const role = forcedRole ?? (typeof message.role === 'string' ? message.role : 'unknown');
    const timestamp = normalizeTime(message.timestamp, normalizeTime(entry.record.timestamp));
    let previous = parent;
    let currentToolScope = toolScope;
    const emitted: MessageRecord[] = [];
    const emit = (
      blockIndex: number,
      contentType: string,
      text: string | null,
      type = role === 'assistant' ? 'assistant' : role === 'user' ? 'user' : 'system',
      projectedRole = role,
      meta = isMeta,
      model: string | null = null,
    ): string => {
      const record = emitMessage({
        entry,
        parent: previous,
        blockIndex,
        tailIndex,
        type,
        role: projectedRole,
        text,
        contentType,
        isMeta: meta,
        visibility,
        model,
        timestamp,
      });
      emitted.push(record);
      previous = record.uuid;
      return record.uuid;
    };

    if (role === 'user') {
      projectContent(message.content, (index, contentType, text) => (
        emit(index, contentType, text, 'user', 'user')
      ));
    } else if (role === 'assistant') {
      const content = Array.isArray(message.content) ? message.content : [];
      const model = typeof message.responseModel === 'string'
        ? message.responseModel
        : typeof message.model === 'string' ? message.model : null;
      for (let index = 0; index < content.length; index++) {
        const part = content[index] as JsonRecord;
        if (part?.type === 'thinking' && typeof part.thinking === 'string') {
          if (part.thinking.length > 0) emit(index, 'thinking', trunc(part.thinking), 'assistant', 'assistant', 0, model);
        } else if (part?.type === 'text' && typeof part.text === 'string') {
          emit(index, 'text', trunc(part.text), 'assistant', 'assistant', 0, model);
        } else if (part?.type === 'toolCall' && typeof part.id === 'string' && typeof part.name === 'string') {
          const uuid = emit(index, 'tool_use', null, 'assistant', 'assistant', 0, model);
          const input = part.arguments !== null && typeof part.arguments === 'object' ? part.arguments : {};
          const filePath = piFilePath(part.name, input);
          const occurrence = { id: toolCallId(uuid), filePath, visibility };
          currentToolScope = {
            nativeId: part.id,
            occurrence,
            parent: currentToolScope,
          };
          records.push({
            kind: 'tool_call',
            id: occurrence.id,
            message_uuid: uuid,
            session_id: sessionId,
            name: part.name,
            presentation: 'default',
            input_json: truncJson(input) ?? '{}',
            file_path: filePath,
          });
        } else {
          emit(index, 'unknown', truncJson(part) ?? null, 'assistant', 'assistant', 1, model);
        }
      }
      if (typeof message.errorMessage === 'string' && message.errorMessage.length > 0) {
        emit(content.length, 'error', trunc(message.errorMessage), 'assistant', 'assistant', 0, model);
      }
      if (emitted.length === 0) emit(0, 'unknown', null, 'assistant', 'assistant', 0, model);
      if (accountUsage) {
        const usage = usageFields(message);
        emitted.at(-1)!.input_tokens = usage.input;
        emitted.at(-1)!.output_tokens = usage.output;
      }
    } else if (role === 'toolResult') {
      const nativeCallId = String(message.toolCallId);
      const occurrence = findToolOccurrence(currentToolScope, nativeCallId, visibility);
      const content = contentText(message.content);
      const uuid = emit(0, 'tool_result', trunc(content), 'user', 'toolResult');
      if (accountUsage) {
        const usage = usageFields(message);
        emitted.at(-1)!.input_tokens = usage.input;
        emitted.at(-1)!.output_tokens = usage.output;
      }
      if (occurrence !== null) {
        records.push({
          kind: 'tool_result',
          tool_use_id: occurrence.id,
          message_uuid: uuid,
          session_id: sessionId,
          content: trunc(content),
          file_path: occurrence.filePath,
          is_error: message.isError === true ? 1 : 0,
        });
      }
      currentToolScope = {
        nativeId: nativeCallId,
        occurrence: null,
        parent: currentToolScope,
      };
    } else if (role === 'bashExecution') {
      emit(0, 'bash_execution', bashText(message), 'user', 'bashExecution', 0);
    } else if (role === 'custom') {
      const display = message.display !== false;
      const customVisibility = display ? visibility : 'hidden';
      const originalVisibility = visibility;
      visibility = customVisibility;
      projectContent(message.content, (index, _contentType, text) => (
        emit(index, 'custom', text, 'system', 'custom', 1)
      ));
      visibility = originalVisibility;
    } else if (role === 'branchSummary' || role === 'compactionSummary') {
      if (typeof message.summary === 'string') {
        const usage = accountUsage ? usageFields(message) : { input: null, output: null };
        const retainedIdentity = tailIndex === undefined
          ? ''
          : `:tail:${String(tailIndex).padStart(BLOCK_PAD, '0')}`;
        records.push({
          kind: 'summary',
          id: `${sessionId}:entry:${entry.ordinal}:summary${retainedIdentity}:${role}`,
          session_id: sessionId,
          timestamp,
          source: role === 'branchSummary' ? 'pi:branch_summary' : 'pi:compaction',
          content: trunc(message.summary),
          visibility,
          input_tokens: usage.input,
          output_tokens: usage.output,
        });
      }
    } else {
      emit(0, 'unknown', messageDisplayText(message), 'system', role, 1);
    }
    return { tail: previous, toolScope: currentToolScope };
  };

  for (const entry of entries) {
    const source = entry.record;
    const inContext = active.has(source.id);
    const inheritedTail = source.parentId === null ? null : tailByEntry.get(source.parentId) ?? null;
    const inheritedToolScope = source.parentId === null
      ? null
      : toolScopeByEntry.get(source.parentId) ?? null;
    if (source.type === 'leaf') {
      const target = source.targetId;
      tailByEntry.set(source.id, typeof target === 'string' ? tailByEntry.get(target) ?? null : null);
      toolScopeByEntry.set(
        source.id,
        typeof target === 'string' ? toolScopeByEntry.get(target) ?? null : null,
      );
      continue;
    }
    tailByEntry.set(source.id, inheritedTail);
    toolScopeByEntry.set(source.id, inheritedToolScope);
    const visibility: MessageVisibility = inContext ? 'visible' : 'inactive';

    if (source.type === 'session_info') {
      latestName = typeof source.name === 'string'
        ? source.name.trim() || null
        : null;
    } else if (source.type === 'message') {
      if (source.message === null || typeof source.message !== 'object' || Array.isArray(source.message)) {
        throw new Error(`Malformed Pi message at line ${entry.line}`);
      }
      firstUserTitle ??= physicalUserTitle(source.message);
      const projected = projectAgentMessage({
        entry,
        message: source.message,
        parent: inheritedTail,
        visibility,
        toolScope: inheritedToolScope,
      });
      tailByEntry.set(source.id, projected.tail);
      toolScopeByEntry.set(source.id, projected.toolScope);
    } else if (source.type === 'custom_message') {
      const projected = projectAgentMessage({
        entry,
        message: {
          role: 'custom',
          content: source.content,
          customType: source.customType,
          display: source.display,
          details: source.details,
          timestamp: new Date(source.timestamp).getTime(),
        },
        parent: inheritedTail,
        visibility,
        isMeta: 1,
        forcedRole: 'custom',
        toolScope: inheritedToolScope,
      });
      tailByEntry.set(source.id, projected.tail);
      toolScopeByEntry.set(source.id, projected.toolScope);
    } else if (source.type === 'compaction' || source.type === 'branch_summary') {
      if (typeof source.summary !== 'string') throw new Error(`Malformed Pi summary at line ${entry.line}`);
      const usage = usageFields(source);
      records.push({
        kind: 'summary',
        id: `${sessionId}:entry:${entry.ordinal}:summary:${source.type}`,
        session_id: sessionId,
        timestamp: normalizeTime(source.timestamp),
        source: source.type === 'compaction' ? 'pi:compaction' : 'pi:branch_summary',
        content: trunc(source.summary),
        visibility,
        input_tokens: usage.input,
        output_tokens: usage.output,
      });
      if (source.type === 'compaction' && checkpoints.has(source.id) && inContext) {
        let tail = inheritedTail;
        let toolScope: PiToolScope | null = null;
        for (let index = 0; index < source.retainedTail.length; index++) {
          const retained = source.retainedTail[index];
          if (retained === null || typeof retained !== 'object' || Array.isArray(retained)) {
            throw new Error(`Malformed Pi retainedTail message at line ${entry.line}`);
          }
          const projected = projectAgentMessage({
            entry,
            message: retained,
            parent: tail,
            visibility,
            tailIndex: index,
            accountUsage: false,
            toolScope,
          });
          tail = projected.tail;
          toolScope = projected.toolScope;
        }
        tailByEntry.set(source.id, tail);
        toolScopeByEntry.set(source.id, toolScope);
      }
    }
    const entryTime = normalizeTime(source.timestamp);
    if (entryTime !== null && (endedAt === null || entryTime > endedAt)) endedAt = entryTime;
  }

  const title = latestName ?? firstUserTitle;
  return { records, messageCount, title, endedAt };
}

function parsePi(unit: IndexUnit): { records: TranscriptRecord[]; cursor: string } {
  const meta = unit.meta as PiSessionUnitMeta | undefined;
  if (meta?.kind === 'pi-tombstone') {
    return {
      records: [],
      // A zero watermark keeps recreation discoverable even if no watcher event is available.
      cursor: '0:0',
    };
  }
  if (meta?.collisionPaths !== undefined) {
    throw new Error(`Divergent Pi session copies share one header identity: ${meta.collisionPaths.join(', ')}`);
  }
  const { header, entries, cursor, snapshot } = parseLines(unit.key);
  const sessionId = piSessionId(header);
  if (
    meta?.kind !== 'pi-session'
    || typeof meta.discoveredSessionId !== 'string'
    || sessionId !== meta.discoveredSessionId
    || sessionId !== unit.sessionId
  ) {
    throw new Error(`Pi session header changed after discovery: ${unit.key}`);
  }
  const { active, checkpoints } = analyzeTree(entries);
  const projected = projectSession(header, entries, sessionId, active, checkpoints);
  const afterProjection = statSync(unit.key);
  if (snapshotCursor(afterProjection) !== snapshot) {
    throw new Error(`Pi session changed while indexing: ${unit.key}`);
  }
  const session: TranscriptRecord = {
    kind: 'session',
    id: sessionId,
    title: projected.title,
    project: projectSlugFromPath(normalizeObservedCwd(header.cwd)),
    started_at: normalizeTime(header.timestamp),
    ended_at: projected.endedAt,
    git_branch: null,
    version: `session-v${header.version ?? 1}`,
    message_count: projected.messageCount,
    countMode: 'total',
    jsonl_path: unit.key,
    source: SOURCE,
  };
  return {
    records: [
      { kind: 'delete-session', sessionId },
      session,
      ...projected.records,
    ],
    cursor,
  };
}

interface PiRawBlock {
  readonly exists: boolean;
  readonly text: string | null;
}

const MISSING_RAW_BLOCK: PiRawBlock = { exists: false, text: null };

function fullJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value) ?? null;
}

function rawContentBlock(content: unknown, blockIndex: number): PiRawBlock {
  if (blockIndex < 0) return MISSING_RAW_BLOCK;
  if (typeof content === 'string') {
    return blockIndex === 0 ? { exists: true, text: content } : MISSING_RAW_BLOCK;
  }
  if (!Array.isArray(content) || content.length === 0) {
    return blockIndex === 0 ? { exists: true, text: null } : MISSING_RAW_BLOCK;
  }
  const part = content[blockIndex];
  if (part === undefined) return MISSING_RAW_BLOCK;
  if (part?.type === 'text' && typeof part.text === 'string') {
    return { exists: true, text: part.text };
  }
  if (part?.type === 'image') return { exists: true, text: imagePlaceholder(part) };
  return { exists: true, text: fullJson(part) };
}

function rawMessageBlock(message: JsonRecord, blockIndex: number): PiRawBlock {
  const role = typeof message.role === 'string' ? message.role : 'unknown';
  if (role === 'user' || role === 'custom') return rawContentBlock(message.content, blockIndex);
  if (role === 'assistant') {
    const content = Array.isArray(message.content) ? message.content : [];
    let emitted = false;
    for (let index = 0; index < content.length; index++) {
      const part = content[index] as JsonRecord;
      let text: string | null;
      if (part?.type === 'thinking' && typeof part.thinking === 'string') {
        if (part.thinking.length === 0) continue;
        text = part.thinking;
      } else if (part?.type === 'text' && typeof part.text === 'string') {
        text = part.text;
      } else if (
        part?.type === 'toolCall'
        && typeof part.id === 'string'
        && typeof part.name === 'string'
      ) {
        text = null;
      } else {
        text = fullJson(part);
      }
      emitted = true;
      if (index === blockIndex) return { exists: true, text };
    }
    if (typeof message.errorMessage === 'string' && message.errorMessage.length > 0) {
      emitted = true;
      if (blockIndex === content.length) return { exists: true, text: message.errorMessage };
    }
    return !emitted && blockIndex === 0
      ? { exists: true, text: null }
      : MISSING_RAW_BLOCK;
  }
  if (role === 'toolResult') {
    return blockIndex === 0
      ? { exists: true, text: contentText(message.content) }
      : MISSING_RAW_BLOCK;
  }
  if (role === 'bashExecution') {
    return blockIndex === 0
      ? { exists: true, text: fullBashText(message) }
      : MISSING_RAW_BLOCK;
  }
  if (role === 'branchSummary' || role === 'compactionSummary') return MISSING_RAW_BLOCK;
  return blockIndex === 0
    ? { exists: true, text: messageDisplayText(message) }
    : MISSING_RAW_BLOCK;
}

function rawPi(input: RawLookup): RawRecord | null {
  try {
    const path = typeof input.session?.jsonl_path === 'string' ? input.session.jsonl_path : null;
    const sessionId = typeof input.session?.id === 'string' ? input.session.id : null;
    if (path === null || sessionId === null || typeof input.cursor !== 'string') return null;
    const prefix = `${sessionId}:entry:`;
    if (!input.messageUuid.startsWith(prefix)) return null;
    const match = /^(\d+):message:(?:tail:(\d+):)?block:(\d+)$/.exec(
      input.messageUuid.slice(prefix.length),
    );
    if (match === null) return null;
    const ordinal = Number(match[1]);
    const tailIndex = match[2] === undefined ? null : Number(match[2]);
    const blockIndex = Number(match[3]);
    if (
      !Number.isInteger(ordinal)
      || ordinal <= 0
      || (tailIndex !== null && (!Number.isInteger(tailIndex) || tailIndex < 0))
      || !Number.isInteger(blockIndex)
      || blockIndex < 0
    ) return null;

    const { header, entries, cursor } = parseLines(path);
    if (cursor !== input.cursor) return null;
    if (piSessionId(header) !== sessionId) return null;
    const entry = entries.find((candidate) => candidate.ordinal === ordinal);
    if (entry === undefined) return null;
    const source = entry.record;
    let message: JsonRecord | null = null;
    if (source.type === 'message' && tailIndex === null) {
      message = source.message !== null
        && typeof source.message === 'object'
        && !Array.isArray(source.message)
        ? source.message
        : null;
    } else if (source.type === 'custom_message' && tailIndex === null) {
      message = {
        role: 'custom',
        content: source.content,
        display: source.display,
      };
    } else if (source.type === 'compaction' && tailIndex !== null && Array.isArray(source.retainedTail)) {
      const retained = source.retainedTail[tailIndex];
      message = retained !== null && typeof retained === 'object' && !Array.isArray(retained)
        ? retained
        : null;
    }
    if (message === null) return null;
    const block = rawMessageBlock(message, blockIndex);
    if (!block.exists) return null;
    // Pi stores source messages either directly or inside a retained tail.
    // Return the same message-shaped raw container for both forms.
    const rawText = fullJson(message);
    if (rawText === null) return null;
    return {
      text: rawText,
      totalLength: rawText.length,
      offset: 0,
      limit: rawText.length,
      hasMore: false,
      messageText: block.text,
    };
  } catch {
    // Raw lookup is best-effort evidence display. A rename, torn write, or
    // replacement session must never escape as an application error.
    return null;
  }
}

export function createPiProvider({
  rootDir,
  cwd,
}: {
  rootDir?: string;
  cwd?: string;
} = {}): PiProvider {
  const rootResolution = resolvePiRoot(rootDir, cwd);
  const root = rootResolution.root;
  return {
    name: SOURCE,
    descriptor: {
      id: SOURCE,
      name: 'Pi',
      vendor: 'Pi',
      defaultRoot: root,
      color: '#f59e0b',
      requiresExplicitRoot: rootResolution.requiresExplicitRoot,
      rootResolutionReason: rootResolution.reason,
    },
    indexVersionMarker: PI_CANONICAL_TRANSCRIPT_MARKER,
    rootResolution,
    watchRoots: (configuredRoot) => {
      if (rootResolution.requiresExplicitRoot) return [];
      const absolute = configuredAbsolutePath(configuredRoot, homedir());
      return absolute === null ? [] : [absolute];
    },
    discover(ctx: DiscoverContext): IndexUnit[] {
      if (rootResolution.requiresExplicitRoot) {
        ctx.reportIncompleteInventory?.({
          path: root,
          error: rootResolution.reason ?? 'Select a Pi session folder',
        });
        return [];
      }
      return discoverAt(root, ctx);
    },
    *parse(unit: IndexUnit, _cursor: Cursor): Generator<TranscriptRecord, Cursor> {
      const parsed = parsePi(unit);
      yield* parsed.records;
      return parsed.cursor;
    },
    raw: rawPi,
  };
}

export const piProvider = createPiProvider();
