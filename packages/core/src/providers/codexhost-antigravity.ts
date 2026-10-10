// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// CodexHost's Antigravity adapter is the one harness that writes its own
// transcript sidecar. Other CodexHost harnesses keep their native stores and
// are indexed by their existing Obelisk providers.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, normalize, relative, resolve } from 'node:path';

import { normalizeObservedCwd, projectSlugFromPath, sourceInventoryIssue, trunc, truncJson } from '../parsing.ts';
import type {
  Cursor,
  DiscoverContext,
  IndexUnit,
  MessageRecord,
  ProviderAdapter,
  RawLookup,
  RawRecord,
  TranscriptRecord,
} from './types.ts';

export const name = 'codexhost-antigravity';
export const CODEXHOST_ANTIGRAVITY_CANONICAL_TRANSCRIPT_MARKER = '__codexhost_antigravity_canonical_transcript_v2__';
const CURSOR_TAG = 'codexhost-antigravity-snapshot-v1';
const HISTORY_DIR = 'antigravity-history';
const MAPPING_DIR = join('mapping-store', 'threads');

type JsonObject = Record<string, unknown>;

interface SourceSnapshot {
  readonly historyPath: string;
  readonly mappingPath: string;
  readonly hostThreadId: string;
  readonly nativeSessionId: string;
  readonly cwd: string;
  readonly title: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly history: JsonObject | null;
  readonly cursor: string;
}

interface UnitMeta {
  readonly snapshot?: SourceSnapshot;
  readonly tombstone?: true;
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function hasOnlyKeys(value: JsonObject, allowedKeys: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function hasValidHarnessError(value: unknown): boolean {
  const error = object(value);
  return error !== null
    && hasOnlyKeys(error, ['code', 'message', 'retryable', 'diagnostic', 'stage', 'durationMs', 'stderrTail'])
    && text(error.code) !== null
    && text(error.message) !== null
    && typeof error.retryable === 'boolean'
    && (error.diagnostic === undefined || typeof error.diagnostic === 'string')
    && (error.stage === undefined || typeof error.stage === 'string')
    && (error.durationMs === undefined || (typeof error.durationMs === 'number' && Number.isFinite(error.durationMs)))
    && (error.stderrTail === undefined || typeof error.stderrTail === 'string');
}

function validateOutcome(value: unknown, path: string, kind: 'turn' | 'item'): void {
  const outcome = object(value);
  const status = text(outcome?.status);
  const statuses = kind === 'turn'
    ? ['succeeded', 'failed', 'cancelled', 'unknown']
    : ['succeeded', 'failed', 'cancelled'];
  if (outcome === null || status === null || !statuses.includes(status)) {
    throw new Error(`Malformed CodexHost Antigravity ${kind} outcome: ${path}`);
  }
  const outcomeKeys = status === 'failed' ? ['status', 'error']
    : status === 'cancelled' || status === 'unknown' ? ['status', 'reason'] : ['status'];
  if (!hasOnlyKeys(outcome, outcomeKeys)) {
    throw new Error(`Malformed CodexHost Antigravity ${kind} outcome fields: ${path}`);
  }
  if (status === 'failed' && !hasValidHarnessError(outcome.error)) {
    throw new Error(`Malformed CodexHost Antigravity ${kind} failure: ${path}`);
  }
  if ((status === 'cancelled' && outcome.reason !== undefined && typeof outcome.reason !== 'string')
    || (status === 'unknown' && typeof outcome.reason !== 'string')) {
    throw new Error(`Malformed CodexHost Antigravity ${kind} outcome reason: ${path}`);
  }
}

function validateHistory(history: JsonObject, path: string): void {
  const turns = history.turns as unknown[];
  for (const turnCandidate of turns) {
    const turn = object(turnCandidate);
    if (turn === null || !Array.isArray(turn.input) || !Array.isArray(turn.items)) {
      throw new Error(`Malformed CodexHost Antigravity turn: ${path}`);
    }
    validateOutcome(turn.outcome, path, 'turn');
    for (const inputCandidate of turn.input) {
      const input = object(inputCandidate);
      if (input?.type !== 'text' || typeof input.text !== 'string') {
        throw new Error(`Malformed CodexHost Antigravity turn input: ${path}`);
      }
    }
    for (const itemCandidate of turn.items) {
      const envelope = object(itemCandidate);
      validateOutcome(envelope?.outcome, path, 'item');
      const item = object(envelope?.item);
      if (item === null || typeof item.type !== 'string') {
        throw new Error(`Malformed CodexHost Antigravity turn item: ${path}`);
      }
      if ((item.type === 'agentMessage' || item.type === 'reasoning') && typeof item.text !== 'string') {
        throw new Error(`Malformed CodexHost Antigravity ${item.type} text: ${path}`);
      }
      if (item.type === 'commandExecution' && typeof item.command !== 'string') {
        throw new Error(`Malformed CodexHost Antigravity command: ${path}`);
      }
      if (item.type === 'toolExecution'
        && (typeof item.toolName !== 'string' || !Object.prototype.hasOwnProperty.call(item, 'arguments'))) {
        throw new Error(`Malformed CodexHost Antigravity tool execution: ${path}`);
      }
    }
  }
}

function signature(path: string): string {
  const stat = statSync(path);
  return [stat.mtimeMs, stat.ctimeMs, stat.size, stat.dev, stat.ino].join(':');
}

function readStableJson(path: string): { value: JsonObject; signature: string; mtimeMs: number } {
  const before = signature(path);
  const value = object(JSON.parse(readFileSync(path, 'utf8')));
  const after = signature(path);
  if (before !== after) throw new Error(`Source changed while reading: ${path}`);
  if (value === null) throw new Error(`Expected JSON object: ${path}`);
  return { value, signature: after, mtimeMs: statSync(path).mtimeMs };
}

function sessionId(hostThreadId: string, cwd: string): string {
  const scope = createHash('sha256').update(`${name}-cwd-v1\0`).update(cwd).digest('hex');
  return `${name}:${encodeURIComponent(hostThreadId)}:${scope}`;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function sourceSnapshot(mappingPath: string, historyPath: string): SourceSnapshot | null {
  const mapping = readStableJson(mappingPath);
  const mapped = mapping.value;
  if (mapped.harnessId !== 'antigravity' || mapped.state !== 'ready') return null;
  const hostThreadId = basename(mappingPath, '.json');
  const nativeRef = object(mapped.nativeSessionRef);
  const nativeSessionId = text(nativeRef?.nativeSessionId);
  const cwd = normalizeObservedCwd(mapped.cwd);
  if (mapped.formatVersion !== 1) {
    throw new Error(`Unsupported CodexHost Antigravity mapping version: ${mappingPath}`);
  }
  if (mapped.hostThreadId !== hostThreadId || nativeRef?.harnessId !== 'antigravity'
    || nativeSessionId === null || nativeSessionId.length === 0 || cwd === null) {
    throw new Error(`Malformed CodexHost Antigravity thread mapping: ${mappingPath}`);
  }
  let history: ReturnType<typeof readStableJson> | null;
  try {
    history = readStableJson(historyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    history = null;
  }
  if (history !== null && (history.value.formatVersion !== 1
    || history.value.nativeSessionId !== nativeSessionId || !Array.isArray(history.value.turns))) {
    throw new Error(`Unsupported or mismatched CodexHost Antigravity history: ${historyPath}`);
  }
  if (history !== null) validateHistory(history.value, historyPath);
  const digest = createHash('sha256').update(`${mapping.signature}\0${history?.signature ?? 'absent'}`).digest('base64url');
  return {
    historyPath, mappingPath, hostThreadId, nativeSessionId, cwd,
    title: text(mapped.title), createdAt: text(mapped.createdAt), updatedAt: text(mapped.updatedAt),
    history: history?.value ?? null,
    cursor: `${Math.max(history?.mtimeMs ?? 0, mapping.mtimeMs)}:0:${CURSOR_TAG}:${history === null ? 'absent' : 'present'}:${digest}`,
  };
}

function ordinal(n: number): string {
  return String(n + 1).padStart(6, '0');
}

function projectedRecords(snapshot: SourceSnapshot, id: string): TranscriptRecord[] {
  const out: TranscriptRecord[] = [];
  const turns = (snapshot.history?.turns as unknown[] | undefined) ?? [];
  let parent: string | null = null;
  let messageCount = 0;
  const addMessage = (uuid: string, role: string, content: string | null, contentType: string, model: string | null, isMeta: 0 | 1 = 0): void => {
    const row: MessageRecord = {
      kind: 'message', uuid, session_id: id, type: role, parent_uuid: parent,
      timestamp: null, role, text: content === null ? null : trunc(content), content_type: contentType,
      is_meta: isMeta, visibility: 'visible', model, is_sidechain: 0, agent_id: null,
      input_tokens: null, output_tokens: null, cwd: snapshot.cwd, skill: null, source: name,
    };
    out.push(row);
    parent = uuid;
    messageCount++;
  };
  const rootModel = text(object(snapshot.history?.model)?.id);
  for (const [turnIndex, candidate] of turns.entries()) {
    const turn = object(candidate);
    if (turn === null || !Array.isArray(turn.input) || !Array.isArray(turn.items)) {
      throw new Error(`Malformed CodexHost Antigravity turn: ${snapshot.historyPath}`);
    }
    const model = text(object(turn.model)?.id) ?? rootModel;
    const prefix = `${id}:t${ordinal(turnIndex)}`;
    for (const [inputIndex, value] of turn.input.entries()) {
      const input = object(value);
      if (input?.type !== 'text' || typeof input.text !== 'string') {
        throw new Error(`Malformed CodexHost Antigravity turn input: ${snapshot.historyPath}`);
      }
      addMessage(`${prefix}:input:${ordinal(inputIndex)}`, 'user', input.text, 'text', null);
    }
    for (const [itemIndex, value] of turn.items.entries()) {
      const envelope = object(value);
      const item = object(envelope?.item);
      if (item === null || typeof item.type !== 'string') {
        throw new Error(`Malformed CodexHost Antigravity turn item: ${snapshot.historyPath}`);
      }
      const uuid = `${prefix}:item:${ordinal(itemIndex)}`;
      if (item.type === 'agentMessage' || item.type === 'reasoning') {
        addMessage(uuid, 'assistant', text(item.text), item.type === 'reasoning' ? 'thinking' : 'text', model);
        continue;
      }
      if (item.type === 'contextCompaction') {
        addMessage(uuid, 'system', null, 'unknown', model, 1);
        continue;
      }
      // Item IDs are local to the CodexHost thread. Ordinals also distinguish
      // repeated snapshots of one upstream item and keep round-trip order stable.
      const callId = `${uuid}:call`;
      const toolName = item.type === 'commandExecution' ? 'commandExecution'
        : item.type === 'toolExecution' ? (text(item.namespace) ? `${item.namespace}.${text(item.toolName) ?? 'tool'}` : text(item.toolName) ?? 'tool')
          : item.type;
      addMessage(uuid, 'assistant', null, 'tool_use', model);
      const argumentsValue = item.type === 'commandExecution'
        ? { command: item.command, cwd: item.cwd }
        : item.type === 'toolExecution' ? item.arguments ?? {} : item;
      out.push({
        kind: 'tool_call', id: callId, message_uuid: uuid, session_id: id,
        name: toolName, presentation: 'default', input_json: truncJson(argumentsValue) ?? '{}', file_path: null,
      });
      if (item.type === 'commandExecution' || item.type === 'toolExecution') {
        const output = object(item.output);
        const parts = Array.isArray(output?.content) ? output.content : [];
        const resultText = item.type === 'commandExecution' ? text(item.output) ?? ''
          : parts.map((part) => text(object(part)?.text)).filter((part): part is string => part !== null).join('\n');
        const outcome = object(envelope?.outcome);
        const status = outcome?.status;
        const errorMessage = status === 'failed' ? text(object(outcome?.error)?.message) : null;
        out.push({
          kind: 'tool_result', tool_use_id: callId, message_uuid: uuid, session_id: id,
          content: trunc(errorMessage ? [resultText, errorMessage].filter(Boolean).join('\n') : resultText), file_path: null,
          is_error: status === 'failed' || (item.type === 'commandExecution' && typeof item.exitCode === 'number' && item.exitCode !== 0) ? 1 : 0,
        });
      }
    }
    const outcome = object(turn.outcome);
    if (outcome?.status === 'failed') {
      addMessage(`${prefix}:outcome`, 'system', text(object(outcome.error)?.message), 'text', null);
    }
  }
  if (messageCount === 0) {
    // Metadata-only mappings still need one hidden cwd witness so the shared
    // project-path resolver does not reconstruct a bogus path from the slug.
    out.push({
      kind: 'message', uuid: `${id}:mapping`, session_id: id, type: 'system', parent_uuid: null,
      timestamp: null, role: 'system', text: null, content_type: 'unknown', is_meta: 1,
      visibility: 'hidden', model: null, is_sidechain: 0, agent_id: null,
      input_tokens: null, output_tokens: null, cwd: snapshot.cwd, skill: null, source: name,
    });
  }
  out.push({
    kind: 'session', id, title: snapshot.title, project: projectSlugFromPath(snapshot.cwd),
    started_at: snapshot.createdAt, ended_at: snapshot.updatedAt,
    git_branch: null, version: 'codexhost-antigravity-v1', message_count: messageCount,
    countMode: 'total', jsonl_path: snapshot.mappingPath, source: name,
  });
  return out;
}

export function createCodexHostAntigravityProvider({
  rootDir = process.env.CODEXHOST_DATA_DIR ? resolve(process.env.CODEXHOST_DATA_DIR) : join(homedir(), '.codexhost'),
}: { rootDir?: string } = {}): ProviderAdapter {
  const historyRoot = join(rootDir, HISTORY_DIR);
  const mappingRoot = join(rootDir, MAPPING_DIR);
  return {
    name,
    descriptor: { id: name, name: 'CodexHost Antigravity', vendor: 'CodexHost', defaultRoot: rootDir, color: '#6784ff' },
    indexVersionMarker: CODEXHOST_ANTIGRAVITY_CANONICAL_TRANSCRIPT_MARKER,
    watchTargets: (configuredRoot) => [
      { kind: 'tree', path: join(configuredRoot, HISTORY_DIR) },
      { kind: 'tree', path: join(configuredRoot, MAPPING_DIR) },
    ],
    discover(ctx: DiscoverContext): IndexUnit[] {
      const indexed = ctx.indexedSessions?.() ?? [];
      let complete = true;
      const issue = (path: string, error: unknown): void => {
        complete = false;
        ctx.reportIncompleteInventory?.(sourceInventoryIssue(path, error));
      };
      let entries;
      try {
        entries = readdirSync(mappingRoot, { withFileTypes: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' || indexed.length > 0) issue(mappingRoot, error);
        return [];
      }
      const units: IndexUnit[] = [];
      const live = new Set<string>();
      const indexedByPath = new Map(indexed.map((session) => [normalize(session.jsonlPath), session]));
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.name.endsWith('.json') || entry.name.startsWith('.')) continue;
        const mappingPath = join(mappingRoot, entry.name);
        if (!entry.isFile()) {
          issue(mappingPath, 'Expected a regular CodexHost thread mapping');
          continue;
        }
        const historyPath = join(historyRoot, entry.name);
        let snapshot: SourceSnapshot | null;
        try {
          snapshot = sourceSnapshot(mappingPath, historyPath);
        } catch (error) {
          issue(mappingPath, error);
          continue;
        }
        if (snapshot === null) continue;
        const id = sessionId(snapshot.hostThreadId, snapshot.cwd);
        live.add(id);
        const key = normalize(mappingPath);
        const prior = indexedByPath.get(key);
        const priorId = prior?.sessionId;
        const oldCursor = ctx.lastCursor(key);
        const knownCursors = [prior?.cursor, oldCursor]
          .filter((cursor): cursor is string => typeof cursor === 'string');
        const previouslyIndexed = prior !== undefined || oldCursor !== null;
        const historyWasDefinitelyAbsent = knownCursors.length > 0
          && knownCursors.every((cursor) => cursor.includes(`${CURSOR_TAG}:absent:`));
        if (snapshot.history === null && previouslyIndexed && !historyWasDefinitelyAbsent) {
          issue(historyPath, 'Previously indexed Antigravity history is unavailable');
          continue;
        }
        const hinted = ctx.changedPaths?.some((path) => (
          normalize(path) === key || normalize(path) === normalize(historyPath)
        )) ?? false;
        if (!hinted && oldCursor === snapshot.cursor && (priorId === undefined || priorId === id)) continue;
        units.push({
          key, sessionId: id, project: projectSlugFromPath(snapshot.cwd) ?? undefined,
          meta: { snapshot } satisfies UnitMeta,
          retractSessionIds: priorId && priorId !== id ? [priorId, id] : [id],
        });
      }
      if (complete) {
        const tombstones: IndexUnit[] = [];
        for (const old of indexed) {
          if (live.has(old.sessionId)) continue;
          // A remaining but invalid mapping was reported above, so it may
          // not be interpreted as a deletion of this indexed identity.
          if (entries.some((entry) => entry.name === basename(old.jsonlPath))) continue;
          tombstones.push({ key: normalize(old.jsonlPath), sessionId: old.sessionId,
            retractSessionIds: [old.sessionId], meta: { tombstone: true } satisfies UnitMeta });
        }
        if (complete) units.push(...tombstones);
      }
      return units;
    },
    *parse(unit: IndexUnit, _cursor: Cursor): Generator<TranscriptRecord, Cursor> {
      const meta = unit.meta as UnitMeta;
      if (meta.tombstone) {
        try {
          statSync(unit.key);
          throw new Error(`CodexHost Antigravity mapping reappeared before retraction: ${unit.key}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        return '0:0:codexhost-antigravity-tombstone';
      }
      const expected = meta.snapshot!;
      const current = sourceSnapshot(expected.mappingPath, expected.historyPath);
      if (current === null || current.cursor !== expected.cursor || sessionId(current.hostThreadId, current.cwd) !== unit.sessionId) {
        throw new Error(`CodexHost Antigravity source changed after discovery: ${unit.key}`);
      }
      const records = projectedRecords(current, unit.sessionId);
      const after = sourceSnapshot(expected.mappingPath, expected.historyPath);
      if (after?.cursor !== expected.cursor) throw new Error(`CodexHost Antigravity source changed during parsing: ${unit.key}`);
      yield* records;
      return expected.cursor;
    },
    raw(input: RawLookup): RawRecord | null {
      try {
        const path = text(input.session?.jsonl_path);
        const id = text(input.session?.id);
        if (path === null || id === null || !inside(mappingRoot, path)) return null;
        const match = /:t(\d{6}):(input|item):(\d{6})$/.exec(input.messageUuid);
        const outcomeMatch = /:t(\d{6}):outcome$/.exec(input.messageUuid);
        if ((match === null && outcomeMatch === null) || !input.messageUuid.startsWith(`${id}:`)) return null;
        const snapshot = sourceSnapshot(path, join(historyRoot, basename(path)));
        if (snapshot === null || snapshot.history === null || sessionId(snapshot.hostThreadId, snapshot.cwd) !== id) return null;
        if (input.cursor !== undefined && input.cursor !== snapshot.cursor) return null;
        const turnIndex = Number((outcomeMatch ?? match)![1]);
        const turn = object((snapshot.history.turns as unknown[])[turnIndex - 1]);
        let value: unknown;
        let messageText: string | null;
        if (outcomeMatch !== null) {
          value = turn?.outcome;
          messageText = text(object(object(value)?.error)?.message);
        } else if (match !== null) {
          value = match[2] === 'input'
            ? (turn?.input as unknown[] | undefined)?.[Number(match[3]) - 1]
            : (turn?.items as unknown[] | undefined)?.[Number(match[3]) - 1];
          const item = object(object(value)?.item);
          messageText = match[2] === 'input' ? text(object(value)?.text)
            : item?.type === 'agentMessage' || item?.type === 'reasoning' ? text(item.text) : null;
        } else {
          return null;
        }
        if (value === undefined) return null;
        const raw = JSON.stringify(value);
        return { text: raw, totalLength: raw.length, offset: 0, limit: raw.length, hasMore: false, messageText };
      } catch { return null; }
    },
  };
}

export const codexHostAntigravityProvider = createCodexHostAntigravityProvider();
