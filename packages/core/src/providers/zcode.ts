// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// ZCode provider adapter in Core (see docs/adr/0001 and docs/adr/0006).
//
// Pure: discovers the ZCode session store and parses sessions into canonical
// records. It never touches the Obelisk database.
//
// Source layout ($root = ~/.zcode/cli by default):
//   db/db.sqlite        — the single authoritative session store (WAL mode)
//
// Every storage mutation (append, in-place re-save, hard delete, rewind,
// compaction, microcompact) is handled by ONE strategy: when a unit's content
// fingerprint changed, atomically replace the whole session's records
// (discovery attaches retractSessionIds; parse re-emits everything with
// countMode 'total'). Change detection is content-based, not watermark-based:
// ZCode's touchSession is max(time_updated, ?) and user-message re-saves pass
// the ORIGINAL created time, so watermarks can fail to advance on real writes
// (source-verified; see .obelisk/zcode-design-v2.md §2).
//
// Detection layers per unit:
//   L1 — session.time_updated + revert + message/part counts and maxes
//        (cheap, batch-queried);
//   L2 — sha256 over the raw session/message/part rows (authoritative; a
//        mutation that preserves every L1 field is still caught).
// The cursor is `${time_updated}:${messageCount}:v2:${fingerprint24}` — the
// prefix keeps persist's index_state mtime/lines_processed convention.
//
// Schema generations: the transcript tables (session/message/part) have had
// identical SQL columns from migration 0014/0015 through 0022 (0.16.9); drift
// lives inside the JSON payloads. The model-selection shape changed in
// migration 0020 (old {providerID, modelID, variant} alongside new
// {providerId, modelId, reasoningLevel}); rows of both shapes coexist in one
// database, so identity is read per row under a shape-authority rule
// (readModelSelection below) — never by database version. Unknown shapes fail
// closed at the FIELD level: model becomes null, the message still indexes.
//
// Semantics mapping (three observed combinations of the semantics triad):
//   (visible,visible,visible) + user_prompt/assistant_response → visible
//   (visible,hidden,visible)  + timeline_event                 → visible + is_meta
//   (hidden,visible,hidden)   + system_reminder etc.           → hidden
//   anything else / future kinds                              → hidden + diagnostic

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { normalizeObservedCwd, projectSlugFromPath, trunc, truncJson } from '../parsing.ts';

import type {
  Cursor,
  DiscoverContext,
  IndexUnit,
  MessageRecord,
  MessageVisibility,
  ProviderAdapter,
  RawLookup,
  RawRecord,
  TranscriptRecord,
  WatchTarget,
} from './types.ts';

export const name = 'zcode';
export const ZCODE_CANONICAL_TRANSCRIPT_MARKER = '__zcode_canonical_transcript_v1__';

const BUSY_TIMEOUT_MS = 500;

// ---- JSON helpers ----

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseJson(text: unknown): Record<string, unknown> | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

// ---- model identity: shape-authority rule (design §4.4a) ----
//
// Old shape: {providerID, modelID, variant?} (also nested under user $.model
// and timeline part fromModel/toModel). New shape (migration 0020): assistant
// message top-level {providerId, modelId, reasoningLevel?}, user
// $.modelSelection, timeline part *ModelSelection. If ANY member of the new
// shape is PRESENT, the new shape owns the whole selection: parse it as a
// unit and never borrow old members to fill gaps. The old shape is read only
// when the new shape is entirely absent. Both-missing → null (not an error).
function readSelection(
  fresh: Record<string, unknown> | null,
  legacy: Record<string, unknown> | null,
): { providerId: string | null; modelId: string | null } {
  if (fresh !== null && ('providerId' in fresh || 'modelId' in fresh || 'options' in fresh)) {
    return { providerId: str(fresh.providerId), modelId: str(fresh.modelId) };
  }
  if (legacy !== null && ('providerID' in legacy || 'modelID' in legacy)) {
    return { providerId: str(legacy.providerID), modelId: str(legacy.modelID) };
  }
  return { providerId: null, modelId: null };
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function messageModel(data: Record<string, unknown>): string | null {
  // assistant: new top-level keys vs legacy top-level keys; user: $.modelSelection
  // vs $.model (both dual-written on fresh 0.16.9 rows).
  const selection = data.role === 'user'
    ? readSelection(isRecord(data.modelSelection) ? data.modelSelection : null, isRecord(data.model) ? data.model : null)
    : readSelection(data, data);
  // canonical projection: observed modelId only — provider namespaces
  // (builtin:* vs account:*) stay in the raw projection so the 0020 rename
  // cannot split search aggregates or duplicate records.
  return selection.modelId;
}

function timelineModelText(part: Record<string, unknown>, side: 'from' | 'to'): string | null {
  const freshKey = `${side}ModelSelection`;
  const legacyKey = `${side}Model`;
  return readSelection(
    isRecord(part[freshKey]) ? part[freshKey] as Record<string, unknown> : null,
    isRecord(part[legacyKey]) ? part[legacyKey] as Record<string, unknown> : null,
  ).modelId;
}

// ---- source access ----

function openSource(dbPath: string): DatabaseSync | null {
  try {
    return new DatabaseSync(dbPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
  } catch {
    return null;
  }
}

function sourceTables(db: DatabaseSync): Set<string> {
  try {
    return new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => String((r as { name: unknown }).name)),
    );
  } catch {
    return new Set();
  }
}

interface SessionRow {
  id: string;
  parent_id: string | null;
  task_type: string | null;
  directory: string | null;
  title: string | null;
  version: string | null;
  revert: string | null;
  time_created: number | null;
  time_updated: number | null;
  time_archived: number | null;
}

interface MessageRow {
  id: string;
  session_id: string;
  time_created: number | null;
  time_updated: number | null;
  sequence: number | null;
  data: string | null;
}

interface PartRow {
  id: string;
  message_id: string;
  session_id: string;
  time_created: number | null;
  time_updated: number | null;
  sequence: number | null;
  data: string | null;
}

const MESSAGE_ORDER = 'sequence IS NULL, sequence, time_created, rowid';
// Tail key `id` mirrors upstream's part ordering (apps/zcode-cli messages
// repository); rowid would diverge whenever (sequence, time_created) ties and
// rowid order differs from id lexicographic order (NULL-sequence legacy rows).
const PART_ORDER = 'sequence IS NULL, sequence, time_created, id';

// ---- fingerprint ----
//
// Hash over the RAW rows (parse-then-hash would miss fields the projection
// does not know). Session canonical columns + full message/part rows in
// source order. Used by discovery (L2 compare) and parse (cursor) — must stay
// byte-identical between the two call sites.
function fingerprintSession(
  session: SessionRow,
  messages: readonly MessageRow[],
  parts: readonly PartRow[],
): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([
    session.id, session.parent_id, session.task_type, session.directory, session.title,
    session.version, session.revert, session.time_archived, session.time_created, session.time_updated,
  ]));
  for (const m of messages) {
    hash.update(`\nm${JSON.stringify([m.id, m.sequence, m.time_created, m.time_updated, m.data])}`);
  }
  for (const p of parts) {
    hash.update(`\np${JSON.stringify([p.id, p.message_id, p.sequence, p.time_created, p.time_updated, p.data])}`);
  }
  return hash.digest('hex').slice(0, 24);
}

// ---- cursor ----

interface CursorState {
  timeUpdated: number;
  messageCount: number;
  fingerprint: string;
}

function encodeCursor(state: CursorState): string {
  return `${state.timeUpdated}:${state.messageCount}:v2:${state.fingerprint}`;
}

// Retract-only units must leave a cursor that can never equal a real session's
// fingerprint ('tombstone' is not 24 hex chars), so a byte-identical restore of
// a deleted session is detected as a change and re-indexed instead of being
// suppressed by a stale cursor forever.
const TOMBSTONE_CURSOR = '0:0:v2:tombstone';

function decodeCursor(cursor: Cursor): CursorState | null {
  if (cursor === null) return null;
  const parts = cursor.split(':');
  if (parts.length !== 4 || parts[2] !== 'v2') return null;
  const timeUpdated = Number(parts[0]);
  const messageCount = Number(parts[1]);
  if (!Number.isFinite(timeUpdated) || !Number.isFinite(messageCount)) return null;
  return { timeUpdated, messageCount, fingerprint: parts[3]! };
}

// ---- discovery ----

interface SessionUnitMeta {
  kind: 'zcode-session';
  dbPath: string;
  rawSessionId: string;
}

function canonicalSessionId(dbPath: string, rawSessionId: string): string {
  const dbi = createHash('sha256').update(realpathOrNull(dbPath) ?? dbPath).digest('hex').slice(0, 12);
  return `zcode:${dbi}:${rawSessionId}`;
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function unitKey(dbPath: string, rawSessionId: string): string {
  return `${dbPath}#z:${rawSessionId}`;
}

function discoverAt(rootDir: string, ctx: DiscoverContext): IndexUnit[] {
  const dbPath = join(rootDir, 'db', 'db.sqlite');
  const walPath = `${dbPath}-wal`;

  // changedPaths routing: this provider only reacts to the db file, its WAL,
  // or an ancestor of them. Anything else is another provider's business.
  if (ctx.changedPaths !== undefined) {
    const normalized = normalize(dbPath);
    const touched = ctx.changedPaths.some((changed) => {
      const absolute = isAbsolute(changed) ? normalize(changed) : normalized;
      return absolute === normalized || absolute === normalize(walPath) || normalized.startsWith(absolute + '/');
    });
    if (!touched) return [];
  }

  let present: 'yes' | 'missing' | 'inaccessible';
  try {
    statSync(dbPath);
    present = 'yes';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    present = code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'inaccessible';
  }
  if (present === 'inaccessible') {
    // Permission problems are not absence: report instead of pretending the
    // source is empty (which would also suppress tombstones via early exit).
    ctx.reportIncompleteInventory?.({ path: dbPath, error: 'Source database is not accessible' });
    return [];
  }
  if (present === 'missing') {
    if ((ctx.indexedSessions?.().length ?? 0) > 0) {
      ctx.reportIncompleteInventory?.({ path: dbPath, error: 'Source database is unavailable' });
    }
    return [];
  }

  const db = openSource(dbPath);
  if (db === null) {
    ctx.reportIncompleteInventory?.({ path: dbPath, error: 'Session database is busy or unreadable' });
    return [];
  }
  try {
    const tables = sourceTables(db);
    if (!tables.has('session') || !tables.has('message') || !tables.has('part')) {
      // Present but not a usable session store (garbage bytes, or a schema we
      // do not recognize). Never tombstone from an unusable source.
      ctx.reportIncompleteInventory?.({ path: dbPath, error: 'Session database has no transcript tables' });
      return [];
    }

    db.exec('BEGIN');
    try {
      const sessions = db.prepare(
        'SELECT id, parent_id, task_type, directory, title, version, revert, time_created, time_updated, time_archived FROM session',
      ).all() as unknown as SessionRow[];
      const messageAgg = new Map<string, number>();
      for (const row of db.prepare(
        'SELECT session_id, COUNT(*) c FROM message GROUP BY session_id',
      ).all() as unknown as Array<{ session_id: string; c: number }>) {
        messageAgg.set(row.session_id, row.c);
      }

      const units: IndexUnit[] = [];
      const liveSessionIds = new Set<string>();
      // Raw ids of live sessions, for parent-liveness checks: a subagent child
      // whose parent row is gone indexes as an ordinary parentless session
      // (design §4.6a) instead of emitting a SubagentRecord that dangles off a
      // nonexistent session.
      const liveRawIds = new Set(sessions.map((session) => session.id));
      for (const session of sessions) {
        const sessionId = canonicalSessionId(dbPath, session.id);
        liveSessionIds.add(sessionId);
        const key = unitKey(dbPath, session.id);
        const agg = messageAgg.get(session.id) ?? 0;
        const cursor = ctx.lastCursor(key);
        const state = decodeCursor(cursor);
        let changed = state === null;
        if (state !== null) {
          // L1: cheap watermark/count comparison.
          const l1Match = state.timeUpdated === (session.time_updated ?? 0)
            && state.messageCount === agg;
          if (l1Match) {
            // L2: raw-row fingerprint catches writes that preserve L1.
            const messages = db.prepare(
              `SELECT id, session_id, time_created, time_updated, sequence, data FROM message WHERE session_id = ? ORDER BY ${MESSAGE_ORDER}`,
            ).all(session.id) as unknown as MessageRow[];
            const parts = db.prepare(
              `SELECT id, message_id, session_id, time_created, time_updated, sequence, data FROM part WHERE session_id = ? ORDER BY ${PART_ORDER}`,
            ).all(session.id) as unknown as PartRow[];
            changed = fingerprintSession(session, messages, parts) !== state.fingerprint;
          } else {
            changed = true;
          }
        }
        if (!changed) continue;
        // A subagent classification is only meaningful while the parent
        // session is live in the same database.
        const isSubagent = session.task_type === 'subagent_child'
          && session.parent_id !== null
          && liveRawIds.has(session.parent_id);
        units.push({
          key,
          sessionId,
          project: projectSlugFromPath(normalizeObservedCwd(session.directory)) ?? undefined,
          isSubagent,
          agentId: isSubagent ? sessionId : undefined,
          retractSessionIds: [sessionId],
          meta: { kind: 'zcode-session', dbPath, rawSessionId: session.id } satisfies SessionUnitMeta,
        });
      }

      // Tombstones: indexed zcode sessions from THIS db whose identity is
      // gone. The unit key prefix `${dbPath}#z:` cannot be confused with a
      // longer path (e.g. db.sqlite2) and only fires when the enumeration
      // above succeeded (busy/unreadable already returned early).
      for (const indexed of ctx.indexedSessions?.() ?? []) {
        if (!indexed.jsonlPath.startsWith(`${dbPath}#z:`)) continue;
        if (liveSessionIds.has(indexed.sessionId)) continue;
        units.push({
          key: indexed.jsonlPath,
          sessionId: indexed.sessionId,
          retractSessionIds: [indexed.sessionId],
          meta: { kind: 'zcode-session', dbPath, rawSessionId: '' } satisfies SessionUnitMeta,
        });
      }
      return units;
    } finally {
      db.exec('COMMIT');
    }
  } catch (error) {
    ctx.reportIncompleteInventory?.({
      path: dbPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  } finally {
    db.close();
  }
}

// ---- semantics triad → visibility (design §4.2, fail-closed) ----

function mapVisibility(data: Record<string, unknown>): {
  visibility: MessageVisibility;
  isMeta: 0 | 1;
} {
  const semantics = isRecord(data.semantics) ? data.semantics : {};
  const ui = str(semantics.uiVisibility);
  const provider = str(semantics.providerVisibility);
  const transcript = str(semantics.transcriptVisibility);
  const kind = str(semantics.kind);
  if (ui === 'visible' && provider === 'visible' && transcript === 'visible'
    && (kind === 'user_prompt' || kind === 'assistant_response')) {
    return { visibility: 'visible', isMeta: 0 };
  }
  if (ui === 'visible' && provider === 'hidden' && transcript === 'visible' && kind === 'timeline_event') {
    return { visibility: 'visible', isMeta: 1 };
  }
  if (ui === 'hidden' && provider === 'visible' && transcript === 'hidden') {
    return { visibility: 'hidden', isMeta: 0 };
  }
  return { visibility: 'hidden', isMeta: 0 };
}

// ---- rewind / compaction active-set (design §4.5) ----

interface RevertInfo {
  keptMessageIds: Set<string>;
  branchCutAfterMessageId: string | null;
}

function parseRevert(revert: string | null): RevertInfo | null {
  const value = parseJson(revert);
  if (value === null) return null;
  const kept = Array.isArray(value.keptMessageIDs) ? value.keptMessageIDs : [];
  return {
    keptMessageIds: new Set(kept.filter((id): id is string => typeof id === 'string')),
    branchCutAfterMessageId: typeof value.branchCutAfterMessageID === 'string' ? value.branchCutAfterMessageID : null,
  };
}

// ---- parse ----

const timestampOfMs = (time: number | null | undefined): string | null => (
  typeof time === 'number' && Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : null
);

function totalInputTokens(tokens: unknown): number | null {
  if (!isRecord(tokens)) return null;
  const input = tokens.input;
  const cacheRead = isRecord(tokens.cache) ? tokens.cache.read : undefined;
  let seen = false;
  let total = 0;
  for (const value of [input, cacheRead]) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    seen = true;
    total += value;
  }
  return seen ? total : null;
}

function outputTokens(tokens: unknown): number | null {
  if (!isRecord(tokens)) return null;
  const value = tokens.output;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Tool result content: state.output when completed, state.error when failed. */
function toolResultContent(state: Record<string, unknown>): { content: string; isError: 0 | 1 } {
  const status = str(state.status);
  if (status === 'error') {
    const error = state.error;
    return {
      content: typeof error === 'string' ? error : JSON.stringify(error ?? ''),
      isError: 1,
    };
  }
  const output = state.output;
  if (typeof output === 'string') return { content: output, isError: status === 'error' ? 1 : 0 };
  if (output !== undefined && output !== null) return { content: JSON.stringify(output), isError: 0 };
  return { content: '', isError: 0 };
}

function* parse(unit: IndexUnit, _cursor: Cursor): Generator<TranscriptRecord, Cursor> {
  const meta = unit.meta as SessionUnitMeta;
  if (meta.rawSessionId === '') return TOMBSTONE_CURSOR; // tombstone: retract-only
  const db = openSource(meta.dbPath);
  if (db === null) {
    // Never a silent empty replacement: this unit carries retractSessionIds,
    // so committing zero records would drop the session until the next
    // successful parse. Throwing aborts the unit's transaction; the caller
    // skips it and the last-good index survives (design §3.3).
    throw new Error(`zcode: session database is busy or unreadable: ${meta.dbPath}`);
  }
  try {
    db.exec('BEGIN');
    let session: SessionRow | undefined;
    let messages: MessageRow[];
    let parts: PartRow[];
    try {
      session = db.prepare(
        'SELECT id, parent_id, task_type, directory, title, version, revert, time_created, time_updated, time_archived FROM session WHERE id = ?',
      ).get(meta.rawSessionId) as unknown as SessionRow | undefined;
      if (session === undefined) {
        // Vanished mid-flight (deleted between discover and parse): keep the
        // old index; the next discover emits a tombstone for it.
        throw new Error(`zcode: session vanished before parse: ${meta.rawSessionId}`);
      }
      messages = db.prepare(
        `SELECT id, session_id, time_created, time_updated, sequence, data FROM message WHERE session_id = ? ORDER BY ${MESSAGE_ORDER}`,
      ).all(meta.rawSessionId) as unknown as MessageRow[];
      parts = db.prepare(
        `SELECT id, message_id, session_id, time_created, time_updated, sequence, data FROM part WHERE session_id = ? ORDER BY ${PART_ORDER}`,
      ).all(meta.rawSessionId) as unknown as PartRow[];
    } finally {
      db.exec('COMMIT');
    }

    const sessionId = unit.sessionId;
    const fingerprint = fingerprintSession(session, messages, parts);

    const partsByMessage = new Map<string, PartRow[]>();
    for (const part of parts) {
      const list = partsByMessage.get(part.message_id) ?? [];
      list.push(part);
      partsByMessage.set(part.message_id, list);
    }

    // rewind active set
    const revert = parseRevert(session.revert);
    const order = new Map<string, number>();
    messages.forEach((m, i) => order.set(m.id, i));
    const isActive = (messageId: string): boolean => {
      if (revert === null) return true;
      if (revert.keptMessageIds.has(messageId)) return true;
      if (revert.branchCutAfterMessageId !== null) {
        const cut = order.get(revert.branchCutAfterMessageId);
        const self = order.get(messageId);
        if (cut !== undefined && self !== undefined && self > cut) return true;
      }
      return false;
    };

    // compaction boundary: tail_start_id is the INCLUSIVE last-summarized id
    const compactionParts = parts
      .map(p => parseJson(p.data))
      .filter((d): d is Record<string, unknown> => d !== null && d.type === 'compaction');
    let compactTailIndex: number | null = null;
    for (const part of compactionParts) {
      const tailId = str(part.tail_start_id);
      if (tailId === null) continue;
      const idx = order.get(tailId);
      if (idx !== undefined && (compactTailIndex === null || idx > compactTailIndex)) compactTailIndex = idx;
    }

    const startedAt = timestampOfMs(session.time_created);
    let endedAt: string | null = null;
    let gitBranch: string | null = null;
    let visibleCount = 0;
    const records: TranscriptRecord[] = [];

    for (const message of messages) {
      const data = parseJson(message.data);
      if (data === null) continue;
      const semantics = isRecord(data.semantics) ? data.semantics : {};
      const kind = str(semantics.kind);
      const index = order.get(message.id) ?? 0;
      const { visibility: triadVisibility, isMeta } = mapVisibility(data);
      let visibility = triadVisibility;
      if (triadVisibility === 'visible' && !isActive(message.id)) visibility = 'inactive';
      if (triadVisibility === 'visible' && compactTailIndex !== null && index <= compactTailIndex) visibility = 'inactive';

      const messageTimestamp = timestampOfMs(
        isRecord(data.time) && typeof data.time.created === 'number' ? data.time.created : message.time_created,
      );
      // Assistant rows carry time.completed; prefer it for ended_at so the
      // session end reflects the last response, not its request time.
      const completedAt = timestampOfMs(
        isRecord(data.time) && typeof data.time.completed === 'number' ? data.time.completed : null,
      );
      const effectiveAt = completedAt ?? messageTimestamp;
      if (effectiveAt !== null && isActive(message.id)) {
        if (endedAt === null || effectiveAt > endedAt) endedAt = effectiveAt;
      }

      const model = messageModel(data);
      const parentUuid = str(data.parentID) !== null ? `${sessionId}:${str(data.parentID)}` : null;

      if (kind === 'compact_summary') {
        const summary = isRecord(data.summary) ? data.summary : {};
        const body = typeof summary.body === 'string' ? summary.body : '';
        records.push({
          kind: 'summary',
          id: `${sessionId}:${message.id}`,
          session_id: sessionId,
          timestamp: messageTimestamp,
          source: name,
          content: body,
          visibility,
        });
        continue;
      }

      const messageParts = partsByMessage.get(message.id) ?? [];
      const textParts: string[] = [];
      let thinkingIndex = 0;
      for (const part of messageParts) {
        const partData = parseJson(part.data);
        if (partData === null) continue;
        switch (partData.type) {
          case 'text':
            if (typeof partData.text === 'string') textParts.push(partData.text);
            break;
          case 'reasoning': {
            if (typeof partData.text !== 'string' || partData.text.length === 0) break;
            visibleCount += visibility === 'visible' ? 1 : 0;
            records.push({
              kind: 'message',
              uuid: `${sessionId}:${message.id}:think${thinkingIndex++}`,
              session_id: sessionId,
              type: 'assistant',
              parent_uuid: `${sessionId}:${message.id}`,
              timestamp: messageTimestamp,
              role: 'assistant',
              text: partData.text,
              content_type: 'thinking',
              is_meta: isMeta,
              visibility,
              model,
              is_sidechain: unit.isSubagent === true ? 1 : 0,
              agent_id: unit.isSubagent === true ? sessionId : null,
              input_tokens: null,
              output_tokens: null,
              cwd: null,
              skill: null,
              source: name,
            } satisfies MessageRecord);
            break;
          }
          case 'tool': {
            const callId = str(partData.callID);
            const toolName = str(partData.tool);
            if (callId === null || toolName === null) break;
            const state = isRecord(partData.state) ? partData.state : {};
            const status = str(state.status);
            const input = state.input;
            const inputJson = input === undefined ? '{}' : (truncJson(input) ?? '{}');
            records.push({
              kind: 'tool_call',
              id: `${sessionId}:${callId}`,
              message_uuid: `${sessionId}:${message.id}`,
              session_id: sessionId,
              name: toolName,
              presentation: 'default',
              input_json: inputJson,
              file_path: toolFilePath(toolName, input),
            });
            if (status === 'completed' || status === 'error') {
              const result = toolResultContent(state);
              records.push({
                kind: 'tool_result',
                tool_use_id: `${sessionId}:${callId}`,
                message_uuid: `${sessionId}:${message.id}`,
                session_id: sessionId,
                content: trunc(result.content),
                file_path: toolFilePath(toolName, input),
                is_error: result.isError,
              });
            }
            break;
          }
          case 'timeline': {
            // meta card text for timeline_event messages (e.g. a model switch)
            if (kind === 'timeline_event') {
              const from = timelineModelText(partData, 'from');
              const to = timelineModelText(partData, 'to');
              if (from !== null || to !== null) {
                textParts.push(from !== null && to !== null ? `model ${from} → ${to}` : `model → ${to ?? from}`);
              }
            }
            break;
          }
          case 'file':
            // attachment: no text row content; the parent message keeps a
            // text:null row so tokens and timeline stay hole-free
            break;
          case 'step-start':
          case 'step-finish':
          case 'snapshot':
          case 'patch':
          case 'retry':
          case 'agent':
            break;
          default:
            break;
        }
      }

      const role = data.role === 'user' ? 'user' : 'assistant';
      if (role === 'user') {
        const env = isRecord(data.contextSnapshot) && isRecord((data.contextSnapshot as Record<string, unknown>).envInfo)
          ? (data.contextSnapshot as Record<string, unknown>).envInfo as Record<string, unknown>
          : {};
        const branch = str(env.gitBranch);
        if (branch !== null && isActive(message.id)) gitBranch = branch;
      }

      if (triadVisibility === 'hidden' && kind !== 'timeline_event') {
        // hidden transport-only: emit the row for parent-chain completeness,
        // helpers never return it (persist filters by visibility).
        records.push({
          kind: 'message',
          uuid: `${sessionId}:${message.id}`,
          session_id: sessionId,
          type: role,
          parent_uuid: parentUuid,
          timestamp: messageTimestamp,
          role,
          text: textParts.length > 0 ? trunc(textParts.join('\n')) : null,
          content_type: 'text',
          is_meta: isMeta,
          visibility: 'hidden',
          model,
          is_sidechain: unit.isSubagent === true ? 1 : 0,
          agent_id: unit.isSubagent === true ? sessionId : null,
          input_tokens: null,
          output_tokens: null,
          cwd: null,
          skill: null,
          source: name,
        } satisfies MessageRecord);
        continue;
      }

      visibleCount += visibility === 'visible' ? 1 : 0;
      records.push({
        kind: 'message',
        uuid: `${sessionId}:${message.id}`,
        session_id: sessionId,
        type: role,
        parent_uuid: parentUuid,
        timestamp: messageTimestamp,
        role,
        text: textParts.length > 0 ? trunc(textParts.join('\n')) : null,
        content_type: 'text',
        is_meta: isMeta,
        visibility,
        model,
        is_sidechain: unit.isSubagent === true ? 1 : 0,
        agent_id: unit.isSubagent === true ? sessionId : null,
        input_tokens: role === 'assistant' ? totalInputTokens(data.tokens) : null,
        output_tokens: role === 'assistant' ? outputTokens(data.tokens) : null,
        cwd: role === 'assistant' && isRecord(data.path) ? str((data.path as Record<string, unknown>).cwd) : null,
        skill: null,
        source: name,
      } satisfies MessageRecord);
    }

    // subagent record: emitted from the CHILD's own unit (agent_id = the
    // child session id; the parent link lives in session.parent_id, exposed
    // by raw()). No heuristic pairing — parent_tool_use_id stays null until
    // an explicit upstream bridge exists (design §4.6a).
    if (unit.isSubagent === true && session.parent_id !== null) {
      let agentType: string | null = null;
      let description: string | null = null;
      for (const message of messages) {
        const data = parseJson(message.data);
        if (data === null) continue;
        const agent = str(data.agent);
        if (agent !== null && agentType === null) agentType = agent;
        break;
      }
      description = session.title;
      records.push({
        kind: 'subagent',
        agent_id: sessionId,
        session_id: canonicalSessionId(meta.dbPath, session.parent_id),
        parent_tool_use_id: null,
        agent_type: agentType,
        description,
        duration_ms: null,
        total_tokens: null,
      });
    }

    records.push({
      kind: 'session',
      id: sessionId,
      title: session.title,
      project: projectSlugFromPath(normalizeObservedCwd(session.directory)),
      started_at: startedAt,
      ended_at: endedAt,
      git_branch: gitBranch,
      version: session.version,
      message_count: visibleCount,
      countMode: 'total',
      jsonl_path: unit.key,
      source: name,
    });

    for (const record of records) yield record;
    return encodeCursor({
      timeUpdated: session.time_updated ?? 0,
      messageCount: messages.length,
      fingerprint,
    });
  } finally {
    db.close();
  }
}

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write']);

function toolFilePath(toolName: string, input: unknown): string | null {
  if (isRecord(input) && FILE_TOOLS.has(toolName) && typeof input.file_path === 'string') {
    return input.file_path;
  }
  return null;
}

// ---- raw projection ----

function raw(input: RawLookup): RawRecord | null {
  if (input.source !== name || input.messageUuid === null) return null;
  // messageUuid is `${sessionId}:${messageId}[:thinkN]`; sessionId itself is
  // `zcode:<dbi>:<rawSessionId>` — split from the right so ids containing ':'
  // survive.
  const withoutThink = input.messageUuid.replace(/:think\d+$/, '');
  const lastColon = withoutThink.lastIndexOf(':');
  if (lastColon === -1) return null;
  const messageId = withoutThink.slice(lastColon + 1);
  const sessionId = withoutThink.slice(0, lastColon);
  const rawSessionId = sessionId.split(':')[2] ?? null;
  const dbPath = typeof input.session?.jsonl_path === 'string'
    ? String(input.session.jsonl_path).split('#z:')[0]
    : null;
  if (rawSessionId === null || dbPath === null) return null;
  const db = openSource(dbPath);
  if (db === null) return null;
  try {
    const row = db.prepare('SELECT data FROM message WHERE id = ?').get(messageId) as unknown as { data: string | null } | undefined;
    if (row === undefined) return null;
    const parts = db.prepare(
      `SELECT data FROM part WHERE message_id = ? ORDER BY ${PART_ORDER}`,
    ).all(messageId) as unknown as Array<{ data: string | null }>;
    const projection = {
      message: parseJson(row.data),
      parts: parts.map(p => parseJson(p.data)),
    };
    const text = JSON.stringify(projection, null, 1);
    const truncated = trunc(text);
    return {
      text: truncated,
      totalLength: text.length,
      hasMore: truncated !== text,
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

// ---- provider ----

export function createZcodeProvider({
  rootDir,
  homeDir = homedir(),
}: {
  rootDir?: string;
  homeDir?: string;
} = {}): ProviderAdapter {
  const resolvedRoot = rootDir !== undefined && rootDir.trim() !== ''
    ? (rootDir.startsWith('~/') ? join(homeDir, rootDir.slice(2)) : rootDir)
    : join(homeDir, '.zcode', 'cli');
  return {
    name,
    descriptor: { id: name, name: 'ZCode', vendor: 'Z.ai', defaultRoot: resolvedRoot, color: '#3b82f6' },
    indexVersionMarker: ZCODE_CANONICAL_TRANSCRIPT_MARKER,
    discover: (ctx: DiscoverContext) => discoverAt(resolvedRoot, ctx),
    parse,
    watchTargets: (configuredRoot: string): WatchTarget[] => [
      { kind: 'file', path: join(configuredRoot, 'db', 'db.sqlite') },
      { kind: 'file', path: join(configuredRoot, 'db', 'db.sqlite-wal') },
    ],
    raw,
  };
}

export const zcodeProvider = createZcodeProvider();
