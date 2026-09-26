// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// GitHub Copilot / VS Code Chat provider.
//
// One logical session is assembled from the union of two source-local stores:
// a lossy Chronicle SQLite row and a richer workspace transcript. The adapter
// never writes either source. SQLite opening is injected because Core runs in
// both node:sqlite (CLI) and better-sqlite3 (Electron) environments.

import { createHash } from 'node:crypto';
import {
  existsSync,
  openSync,
  closeSync,
  readSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import {
  basename,
  isAbsolute,
  join,
  normalize,
  relative,
} from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeObservedCwd,
  projectSlugFromPath,
  trunc,
} from '../parsing.ts';
import type { SqliteDb, SqliteRow } from '../sqlite-types.ts';
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

export const name = 'copilot';
const COPILOT_CANONICAL_TRANSCRIPT_MARKER = '__copilot_canonical_transcript_v2__';
const CURSOR_TAG = 'copilot-snapshot-v1';
const TRANSCRIPT_VERSION = 1;
const COPILOT_STORAGE_DIR = 'github.copilot-chat';
const TRANSCRIPT_STORAGE_DIR = 'GitHub.copilot-chat';

export type CopilotChronicleOpener = (path: string) => SqliteDb;

type JsonObject = Record<string, unknown>;

interface ChronicleSession {
  readonly rawSessionId: string;
  readonly dbPath: string;
  readonly root: string;
  readonly cwd: string | null;
  readonly contextKey: string;
  readonly row: SqliteRow;
  readonly turns: readonly SqliteRow[];
  readonly fingerprint: string;
  readonly mtimeMs: number;
}

interface TranscriptSource {
  readonly rawSessionId: string;
  readonly path: string;
  readonly root: string;
  readonly workspaceId: string;
  readonly cwd: string | null;
  readonly contextKey: string;
  readonly version: number | null;
  readonly copilotVersion: string | null;
  readonly signature: string;
  readonly mtimeMs: number;
}

interface CopilotUnitMeta {
  readonly rawSessionId: string;
  readonly sessionId: string;
  readonly contextKey: string;
  readonly cwd: string | null;
  readonly transcript: TranscriptSource | null;
  readonly chronicle: {
    readonly dbPath: string;
    readonly root: string;
    readonly rawSessionId: string;
    readonly fingerprint: string;
  } | null;
  readonly currentCursor: string;
  readonly tombstone?: boolean;
}

interface ParsedTranscript {
  readonly records: TranscriptRecord[];
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly version: string | null;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function samePath(left: string, right: string): boolean {
  const a = normalize(left);
  const b = normalize(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate.split('#', 1)[0]!);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function defaultCopilotUserDataRoots(): string[] {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return [join(appData, 'Code', 'User'), join(appData, 'Code - Insiders', 'User')];
  }
  if (process.platform === 'darwin') {
    const base = join(homedir(), 'Library', 'Application Support');
    return [join(base, 'Code', 'User'), join(base, 'Code - Insiders', 'User')];
  }
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return [join(base, 'Code', 'User'), join(base, 'Code - Insiders', 'User')];
}

function directoryEntries(path: string) {
  return readdirSync(path, { withFileTypes: true });
}

function findCaseInsensitiveDirectory(parent: string, wanted: string): string | null {
  if (!existsSync(parent)) return null;
  const entry = directoryEntries(parent).find(
    (candidate) => candidate.isDirectory() && candidate.name.toLowerCase() === wanted.toLowerCase(),
  );
  return entry ? join(parent, entry.name) : null;
}

function workspaceContext(workspaceDir: string, root: string, workspaceId: string): {
  cwd: string | null;
  contextKey: string;
} {
  const metadataPath = join(workspaceDir, 'workspace.json');
  if (existsSync(metadataPath)) {
    try {
      const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as unknown;
      if (isObject(metadata)) {
        const location = stringValue(metadata.folder) ?? stringValue(metadata.workspace);
        if (location?.startsWith('file:')) {
          const path = normalizeObservedCwd(fileURLToPath(location));
          if (path !== null) return { cwd: path, contextKey: `path:${path}` };
        }
      }
    } catch {
      // An unreadable workspace.json falls back to the stable workspace id.
    }
  }
  return {
    cwd: null,
    contextKey: `workspace:${normalize(root)}:${workspaceId}`,
  };
}

function firstTranscriptEvent(path: string): JsonObject | null {
  const fd = openSync(path, 'r');
  const buffer = Buffer.alloc(64 * 1024);
  let text = '';
  try {
    while (!text.includes('\n')) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      text += buffer.toString('utf8', 0, count);
      if (text.length > 1024 * 1024) break;
    }
  } finally {
    closeSync(fd);
  }
  const line = text.split(/\r?\n/, 1)[0]?.trim();
  if (!line) return null;
  try {
    const value = JSON.parse(line) as unknown;
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function transcriptSignature(path: string): { signature: string; mtimeMs: number } {
  const stat = statSync(path);
  return {
    signature: [stat.mtimeMs, stat.ctimeMs, stat.size, stat.dev, stat.ino].join(':'),
    mtimeMs: stat.mtimeMs,
  };
}

function transcriptSource(
  path: string,
  root: string,
  workspaceDir: string,
  workspaceId: string,
): TranscriptSource {
  const first = firstTranscriptEvent(path);
  const data = first?.type === 'session.start' && isObject(first.data) ? first.data : {};
  const context = isObject(data.context) ? data.context : {};
  const observed = normalizeObservedCwd(context.cwd);
  const fallback = workspaceContext(workspaceDir, root, workspaceId);
  const rawSessionId = stringValue(data.sessionId) ?? basename(path, '.jsonl');
  const stat = transcriptSignature(path);
  return {
    rawSessionId,
    path,
    root,
    workspaceId,
    cwd: observed ?? fallback.cwd,
    contextKey: observed !== null ? `path:${observed}` : fallback.contextKey,
    version: Number.isInteger(data.version) ? Number(data.version) : null,
    copilotVersion: stringValue(data.copilotVersion),
    ...stat,
  };
}

function chronicleSessionFingerprint(row: SqliteRow, turns: readonly SqliteRow[]): string {
  return sha256(JSON.stringify({
    session: [
      row.id, row.cwd, row.repository, row.branch, row.summary,
      row.created_at, row.updated_at, row.host_type, row.agent_name, row.agent_description,
    ],
    turns: turns.map((turn) => [
      turn.turn_index, turn.user_message, turn.assistant_response, turn.timestamp,
    ]),
  }));
}

function chronicleMtime(dbPath: string): number {
  const walPath = `${dbPath}-wal`;
  return Math.max(
    statSync(dbPath).mtimeMs,
    existsSync(walPath) ? statSync(walPath).mtimeMs : 0,
  );
}

function chronicleSessionFromRow(
  row: SqliteRow,
  turns: readonly SqliteRow[],
  dbPath: string,
  root: string,
  mtimeMs: number,
): ChronicleSession | null {
  if (typeof row.id !== 'string' || row.id.length === 0) return null;
  const cwd = normalizeObservedCwd(row.cwd);
  return {
    rawSessionId: row.id,
    dbPath,
    root,
    cwd,
    contextKey: cwd !== null ? `path:${cwd}` : `chronicle:${normalize(root)}`,
    row,
    turns,
    fingerprint: chronicleSessionFingerprint(row, turns),
    mtimeMs,
  };
}

function readChronicleSessions(
  dbPath: string,
  root: string,
  openChronicle: CopilotChronicleOpener,
): ChronicleSession[] {
  const db = openChronicle(dbPath);
  try {
    const sessions = db.prepare(`
      SELECT id, cwd, repository, host_type, branch, summary,
             agent_name, agent_description, created_at, updated_at
      FROM sessions
      ORDER BY id
    `).all();
    const readTurns = db.prepare(`
      SELECT turn_index, user_message, assistant_response, timestamp
      FROM turns
      WHERE session_id = ?
      ORDER BY turn_index, id
    `);
    const mtimeMs = chronicleMtime(dbPath);
    return sessions.flatMap((row) => {
      const turns = typeof row.id === 'string' ? readTurns.all(row.id) : [];
      const session = chronicleSessionFromRow(row, turns, dbPath, root, mtimeMs);
      return session === null ? [] : [session];
    });
  } finally {
    db.close();
  }
}

export function copilotSessionId(rawSessionId: string, contextKey: string): string {
  const scope = sha256(`copilot-context-v1\0${contextKey}`);
  return `copilot:${encodeURIComponent(rawSessionId)}:${scope}`;
}

function messageUuid(sessionId: string, eventId: string, projection: string): string {
  return `${sessionId}:event:${encodeURIComponent(eventId)}:${projection}`;
}

function toolCallId(sessionId: string, rawToolCallId: string): string {
  return `${sessionId}:tool:${encodeURIComponent(rawToolCallId)}`;
}

function chronicleMessageUuid(sessionId: string, turnIndex: unknown, role: string): string {
  const ordinal = String(Number(turnIndex) || 0).padStart(6, '0');
  return `${sessionId}:chronicle:${ordinal}:${role}`;
}

function isoBounds(values: readonly (string | null)[]): { startedAt: string | null; endedAt: string | null } {
  const timestamps = values.filter((value): value is string => typeof value === 'string' && value.length > 0).sort();
  return { startedAt: timestamps[0] ?? null, endedAt: timestamps.at(-1) ?? null };
}

function toolInputJson(value: unknown): string {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value));
    } catch {
      return JSON.stringify(value);
    }
  }
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

function transcriptRecords(
  source: TranscriptSource,
  sessionId: string,
  cwd: string | null,
): ParsedTranscript {
  const before = transcriptSignature(source.path);
  if (before.signature !== source.signature) {
    throw new Error(`Copilot transcript changed after discovery: ${source.path}`);
  }
  const lines = readFileSync(source.path, 'utf8').split(/\r?\n/);
  const events: JsonObject[] = [];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    try {
      const value = JSON.parse(raw) as unknown;
      if (!isObject(value)) continue;
      events.push(value);
    } catch {
      // A partial or malformed source line is not interpreted as another event.
    }
  }
  const after = transcriptSignature(source.path);
  if (after.signature !== source.signature) {
    throw new Error(`Copilot transcript changed while it was read: ${source.path}`);
  }

  const out: TranscriptRecord[] = [];
  const timestamps: (string | null)[] = [];
  const callMessages = new Map<string, string>();
  const emittedCalls = new Set<string>();
  let lastMessageUuid: string | null = null;
  let syntheticOrdinal = 0;
  let startVersion: string | null = source.copilotVersion;

  const insertMessage = (
    uuid: string,
    role: string,
    text: string | null,
    contentType: string,
    timestamp: string | null,
  ): string => {
    const record: MessageRecord = {
      kind: 'message',
      uuid,
      session_id: sessionId,
      type: role,
      parent_uuid: lastMessageUuid,
      timestamp,
      role,
      text: text === '' ? null : trunc(text),
      content_type: contentType,
      is_meta: 0,
      visibility: 'visible',
      model: null,
      is_sidechain: 0,
      agent_id: null,
      input_tokens: null,
      output_tokens: null,
      cwd,
      skill: null,
      source: name,
    };
    out.push(record);
    lastMessageUuid = uuid;
    timestamps.push(timestamp);
    return uuid;
  };

  const ensureToolCall = (
    rawCallId: string,
    rawEventId: string,
    toolName: string,
    args: unknown,
    timestamp: string | null,
    preferredMessageUuid?: string,
  ): string => {
    const canonicalId = toolCallId(sessionId, rawCallId);
    if (emittedCalls.has(canonicalId)) return callMessages.get(canonicalId)!;
    const owner = preferredMessageUuid ?? insertMessage(
      messageUuid(sessionId, rawEventId, `tool-${String(syntheticOrdinal++).padStart(3, '0')}`),
      'assistant',
      null,
      'tool_use',
      timestamp,
    );
    out.push({
      kind: 'tool_call',
      id: canonicalId,
      message_uuid: owner,
      session_id: sessionId,
      name: toolName || 'unknown',
      presentation: 'default',
      input_json: trunc(toolInputJson(args)),
      file_path: null,
    });
    emittedCalls.add(canonicalId);
    callMessages.set(canonicalId, owner);
    return owner;
  };

  for (const value of events) {
    const type = stringValue(value.type);
    const eventId = stringValue(value.id) ?? `line-${String(syntheticOrdinal++).padStart(6, '0')}`;
    const timestamp = stringValue(value.timestamp);
    const data = isObject(value.data) ? value.data : {};
    if (type === 'session.start') {
      startVersion = stringValue(data.copilotVersion) ?? startVersion;
      timestamps.push(stringValue(data.startTime) ?? timestamp);
      continue;
    }
    if (type === 'user.message') {
      const content = stringValue(data.content);
      insertMessage(
        messageUuid(sessionId, eventId, 'user'),
        'user',
        content,
        content === null || content === '' ? 'unknown' : 'text',
        timestamp,
      );
      continue;
    }
    if (type === 'assistant.message') {
      const reasoning = stringValue(data.reasoningText);
      if (reasoning !== null && reasoning !== '') {
        insertMessage(messageUuid(sessionId, eventId, 'reasoning'), 'assistant', reasoning, 'thinking', timestamp);
      }
      const requests = Array.isArray(data.toolRequests)
        ? data.toolRequests.filter(isObject)
        : [];
      const content = stringValue(data.content);
      const emitMain = content !== null && content !== '' || requests.length > 0 || reasoning === null || reasoning === '';
      let owner: string | null = null;
      if (emitMain) {
        owner = insertMessage(
          messageUuid(sessionId, eventId, 'assistant'),
          'assistant',
          content,
          content !== null && content !== '' ? 'text' : requests.length > 0 ? 'tool_use' : 'unknown',
          timestamp,
        );
      }
      for (const request of requests) {
        const rawCallId = stringValue(request.toolCallId);
        if (rawCallId === null) continue;
        ensureToolCall(
          rawCallId,
          eventId,
          stringValue(request.name) ?? 'unknown',
          request.arguments,
          timestamp,
          owner ?? undefined,
        );
      }
      continue;
    }
    if (type === 'tool.execution_start') {
      const rawCallId = stringValue(data.toolCallId);
      if (rawCallId !== null) {
        ensureToolCall(
          rawCallId,
          eventId,
          stringValue(data.toolName) ?? 'unknown',
          data.arguments,
          timestamp,
        );
      }
      continue;
    }
    if (type === 'tool.execution_complete') {
      const rawCallId = stringValue(data.toolCallId);
      if (rawCallId === null) continue;
      const canonicalId = toolCallId(sessionId, rawCallId);
      const owner = ensureToolCall(rawCallId, eventId, 'unknown', {}, timestamp);
      const result = isObject(data.result) ? stringValue(data.result.content) : null;
      out.push({
        kind: 'tool_result',
        tool_use_id: canonicalId,
        message_uuid: owner,
        session_id: sessionId,
        content: trunc(result ?? ''),
        file_path: null,
        is_error: data.success === false ? 1 : 0,
      });
      timestamps.push(timestamp);
      continue;
    }
    if (type === 'assistant.turn_start' || type === 'assistant.turn_end') {
      timestamps.push(timestamp);
    }
    // Unknown events are retained as raw JSONL evidence but do not acquire
    // guessed canonical semantics.
  }

  const bounds = isoBounds(timestamps);
  return {
    records: out,
    ...bounds,
    version: startVersion,
  };
}

function chronicleRecords(
  chronicle: ChronicleSession,
  sessionId: string,
  cwd: string | null,
): { records: TranscriptRecord[]; startedAt: string | null; endedAt: string | null } {
  const out: TranscriptRecord[] = [];
  const timestamps: (string | null)[] = [];
  let parent: string | null = null;
  const push = (turn: SqliteRow, role: 'user' | 'assistant', value: unknown) => {
    if (typeof value !== 'string') return;
    const uuid = chronicleMessageUuid(sessionId, turn.turn_index, role);
    const timestamp = stringValue(turn.timestamp);
    out.push({
      kind: 'message',
      uuid,
      session_id: sessionId,
      type: role,
      parent_uuid: parent,
      timestamp,
      role,
      text: value === '' ? null : trunc(value),
      content_type: value === '' ? 'unknown' : 'text',
      is_meta: 0,
      visibility: 'visible',
      model: null,
      is_sidechain: 0,
      agent_id: null,
      input_tokens: null,
      output_tokens: null,
      cwd,
      skill: null,
      source: name,
    });
    parent = uuid;
    timestamps.push(timestamp);
  };
  for (const turn of chronicle.turns) {
    push(turn, 'user', turn.user_message);
    push(turn, 'assistant', turn.assistant_response);
  }
  timestamps.push(stringValue(chronicle.row.created_at), stringValue(chronicle.row.updated_at));
  return { records: out, ...isoBounds(timestamps) };
}

function readOneChronicleSession(
  evidence: NonNullable<CopilotUnitMeta['chronicle']>,
  openChronicle: CopilotChronicleOpener,
): ChronicleSession | null {
  const db = openChronicle(evidence.dbPath);
  try {
    const row = db.prepare(`
      SELECT id, cwd, repository, host_type, branch, summary,
             agent_name, agent_description, created_at, updated_at
      FROM sessions
      WHERE id = ?
    `).get(evidence.rawSessionId);
    if (row === undefined) return null;
    const turns = db.prepare(`
      SELECT turn_index, user_message, assistant_response, timestamp
      FROM turns
      WHERE session_id = ?
      ORDER BY turn_index, id
    `).all(evidence.rawSessionId);
    return chronicleSessionFromRow(
      row,
      turns,
      evidence.dbPath,
      evidence.root,
      chronicleMtime(evidence.dbPath),
    );
  } finally {
    db.close();
  }
}

function cursorFor(
  transcript: TranscriptSource | null,
  chronicle: ChronicleSession | null,
): string {
  const mtime = Math.max(transcript?.mtimeMs ?? 0, chronicle?.mtimeMs ?? 0);
  const digest = sha256(JSON.stringify({
    transcript: transcript ? [transcript.path, transcript.signature, transcript.version] : null,
    chronicle: chronicle ? [chronicle.dbPath, chronicle.fingerprint] : null,
  }));
  return `${mtime}:0:${CURSOR_TAG}:${digest}`;
}

function sourcePathFor(transcript: TranscriptSource | null, chronicle: ChronicleSession | null): string {
  if (transcript !== null) return transcript.path;
  return `${chronicle!.dbPath}#session:${encodeURIComponent(chronicle!.rawSessionId)}`;
}

function relevantChangedPath(paths: readonly string[], transcript: TranscriptSource | null, chronicle: ChronicleSession | null): boolean {
  for (const changed of paths) {
    const normalized = normalize(changed);
    if (transcript !== null && samePath(normalized, transcript.path)) return true;
    if (chronicle !== null && [chronicle.dbPath, `${chronicle.dbPath}-wal`, `${chronicle.dbPath}-shm`]
      .some((candidate) => samePath(normalized, candidate))) return true;
  }
  return false;
}

function rawTranscript(input: RawLookup): RawRecord | null {
  const path = typeof input.session?.jsonl_path === 'string' ? input.session.jsonl_path : null;
  if (path === null || !path.toLowerCase().endsWith('.jsonl') || !existsSync(path)) return null;
  const match = /:event:([^:]+):(user|assistant|reasoning|tool-\d+)$/.exec(input.messageUuid);
  if (match === null) return null;
  const eventId = decodeURIComponent(match[1]!);
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    try {
      const event = JSON.parse(raw) as unknown;
      if (!isObject(event) || event.id !== eventId) continue;
      const data = isObject(event.data) ? event.data : {};
      const messageText = match[2] === 'reasoning'
        ? stringValue(data.reasoningText)
        : stringValue(data.content);
      return {
        text: raw,
        totalLength: raw.length,
        offset: 0,
        limit: raw.length,
        hasMore: false,
        messageText,
      };
    } catch {
      // Continue to the next source line.
    }
  }
  return null;
}

function rawChronicle(
  input: RawLookup,
  openChronicle: CopilotChronicleOpener | undefined,
): RawRecord | null {
  if (openChronicle === undefined) return null;
  const sourcePath = typeof input.session?.jsonl_path === 'string' ? input.session.jsonl_path : null;
  const pathMatch = sourcePath?.match(/^(.*)#session:([^#]+)$/);
  const uuidMatch = /:chronicle:(\d{6}):(user|assistant)$/.exec(input.messageUuid);
  if (pathMatch === undefined || pathMatch === null || uuidMatch === null) return null;
  const dbPath = pathMatch[1]!;
  if (!existsSync(dbPath)) return null;
  const db = openChronicle(dbPath);
  try {
    const rawSessionId = decodeURIComponent(pathMatch[2]!);
    const row = db.prepare(`
      SELECT turn_index, user_message, assistant_response, timestamp
      FROM turns WHERE session_id = ? AND turn_index = ?
    `).get(rawSessionId, Number(uuidMatch[1]));
    if (row === undefined) return null;
    const messageText = uuidMatch[2] === 'user'
      ? stringValue(row.user_message)
      : stringValue(row.assistant_response);
    const text = JSON.stringify(row);
    return { text, totalLength: text.length, offset: 0, limit: text.length, hasMore: false, messageText };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export function createCopilotProvider({
  rootDir,
  userDataRoots,
  openChronicle,
}: {
  rootDir?: string;
  userDataRoots?: readonly string[];
  openChronicle?: CopilotChronicleOpener;
} = {}): ProviderAdapter {
  const automaticRoots = defaultCopilotUserDataRoots();
  const usesRootSet = rootDir === undefined;
  const descriptorRoot = rootDir
    ?? userDataRoots?.[0]
    ?? automaticRoots[0]!;
  const sourceRoots = userDataRoots !== undefined
    ? [...userDataRoots]
    : rootDir === undefined ? automaticRoots : [rootDir];

  const discover = (ctx: DiscoverContext): IndexUnit[] => {
    const indexed = ctx.indexedSessions?.() ?? [];
    const transcripts: TranscriptSource[] = [];
    const chronicles: ChronicleSession[] = [];
    let inventoryComplete = true;
    const issue = (path: string, error: unknown) => {
      inventoryComplete = false;
      ctx.reportIncompleteInventory?.({
        path,
        error: error instanceof Error ? error.message : String(error),
      });
    };

    for (const root of sourceRoots) {
      if (!existsSync(root)) {
        if (indexed.some((session) => pathInside(root, session.jsonlPath))) {
          issue(root, 'Previously indexed VS Code User data root is unavailable');
        }
        continue;
      }
      const dbPath = join(root, 'globalStorage', COPILOT_STORAGE_DIR, 'session-store.db');
      if (existsSync(dbPath)) {
        if (openChronicle === undefined) {
          issue(dbPath, 'No read-only Chronicle SQLite opener is configured');
        } else {
          try {
            chronicles.push(...readChronicleSessions(dbPath, root, openChronicle));
          } catch (error) {
            issue(dbPath, error);
          }
        }
      } else if (indexed.some((session) => session.jsonlPath.startsWith(`${dbPath}#`))) {
        issue(dbPath, 'Previously indexed Chronicle database is unavailable');
      }

      const workspaceRoot = join(root, 'workspaceStorage');
      if (!existsSync(workspaceRoot)) continue;
      let workspaceEntries;
      try {
        workspaceEntries = directoryEntries(workspaceRoot);
      } catch (error) {
        issue(workspaceRoot, error);
        continue;
      }
      for (const workspace of workspaceEntries) {
        if (!workspace.isDirectory()) continue;
        const workspaceDir = join(workspaceRoot, workspace.name);
        let extensionDir: string | null;
        try {
          extensionDir = findCaseInsensitiveDirectory(workspaceDir, TRANSCRIPT_STORAGE_DIR);
        } catch (error) {
          issue(workspaceDir, error);
          continue;
        }
        if (extensionDir === null) continue;
        const transcriptDir = join(extensionDir, 'transcripts');
        if (!existsSync(transcriptDir)) continue;
        let files;
        try {
          files = directoryEntries(transcriptDir);
        } catch (error) {
          issue(transcriptDir, error);
          continue;
        }
        for (const file of files) {
          if (!file.isFile() || !file.name.toLowerCase().endsWith('.jsonl')) continue;
          const path = join(transcriptDir, file.name);
          try {
            transcripts.push(transcriptSource(path, root, workspaceDir, workspace.name));
          } catch (error) {
            issue(path, error);
          }
        }
      }
    }

    const groups = new Map<string, { transcript: TranscriptSource | null; chronicle: ChronicleSession | null }>();
    for (const transcript of transcripts) {
      const key = `${transcript.rawSessionId}\0${transcript.contextKey}`;
      const current = groups.get(key);
      if (current?.transcript !== undefined && current.transcript !== null) {
        issue(transcript.path, `Duplicate Copilot transcript identity also exists at ${current.transcript.path}`);
        if (transcript.mtimeMs <= current.transcript.mtimeMs) continue;
      }
      groups.set(key, { transcript, chronicle: current?.chronicle ?? null });
    }
    for (const chronicle of chronicles) {
      const exactKey = `${chronicle.rawSessionId}\0${chronicle.contextKey}`;
      const rawCandidates = [...groups.entries()].filter(([, value]) => (
        value.transcript?.rawSessionId === chronicle.rawSessionId
      ));
      const candidates = [...groups.entries()].filter(([, value]) => (
        value.transcript?.rawSessionId === chronicle.rawSessionId
        && value.transcript.cwd !== null
        && chronicle.cwd !== null
        && samePath(value.transcript.cwd, chronicle.cwd)
      ));
      const key = groups.has(exactKey)
        ? exactKey
        : candidates.length === 1
          ? candidates[0]![0]
          : rawCandidates.length === 1 ? rawCandidates[0]![0] : exactKey;
      const current = groups.get(key);
      if (current?.chronicle !== undefined && current.chronicle !== null) {
        issue(chronicle.dbPath, `Duplicate Copilot Chronicle identity for ${chronicle.rawSessionId}`);
        continue;
      }
      groups.set(key, { transcript: current?.transcript ?? null, chronicle });
    }

    const units: IndexUnit[] = [];
    const liveSessionIds = new Set<string>();
    for (const [groupKey, sources] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      const separator = groupKey.indexOf('\0');
      const rawSessionId = groupKey.slice(0, separator);
      const contextKey = groupKey.slice(separator + 1);
      const sessionId = copilotSessionId(rawSessionId, contextKey);
      liveSessionIds.add(sessionId);
      const transcriptUnsupported = sources.transcript !== null
        && sources.transcript.version !== TRANSCRIPT_VERSION;
      if (transcriptUnsupported) {
        issue(
          sources.transcript!.path,
          sources.transcript!.version === null
            ? 'Copilot transcript format version is missing'
            : `Unsupported Copilot transcript format version ${sources.transcript!.version}`,
        );
        // A transcript-only unknown version remains a live identity, but it is
        // not parsed and its cursor is not advanced. This preserves the last
        // known-good snapshot and makes every later scan retry the source.
        if (sources.chronicle === null) continue;
      }
      const currentCursor = cursorFor(sources.transcript, sources.chronicle);
      const changedByHint = ctx.changedPaths !== undefined
        && relevantChangedPath(ctx.changedPaths, sources.transcript, sources.chronicle);
      if (!changedByHint && ctx.lastCursor(`copilot-unit:${sessionId}`) === currentCursor) continue;
      const cwd = sources.transcript?.cwd ?? sources.chronicle?.cwd ?? null;
      const meta: CopilotUnitMeta = {
        rawSessionId,
        sessionId,
        contextKey,
        cwd,
        transcript: sources.transcript,
        chronicle: sources.chronicle === null ? null : {
          dbPath: sources.chronicle.dbPath,
          root: sources.chronicle.root,
          rawSessionId,
          fingerprint: sources.chronicle.fingerprint,
        },
        currentCursor,
      };
      units.push({
        key: `copilot-unit:${sessionId}`,
        sessionId,
        ...(projectSlugFromPath(cwd) === null ? {} : { project: projectSlugFromPath(cwd)! }),
        meta,
        retractSessionIds: [sessionId],
      });
    }

    if (inventoryComplete) {
      for (const session of indexed) {
        if (liveSessionIds.has(session.sessionId)) continue;
        units.push({
          key: `copilot-unit:${session.sessionId}`,
          sessionId: session.sessionId,
          meta: {
            rawSessionId: '',
            sessionId: session.sessionId,
            contextKey: '',
            cwd: null,
            transcript: null,
            chronicle: null,
            currentCursor: '0:0:copilot-tombstone',
            tombstone: true,
          } satisfies CopilotUnitMeta,
          retractSessionIds: [session.sessionId],
        });
      }
    }
    return units;
  };

  function* parse(unit: IndexUnit, _cursor: Cursor): Generator<TranscriptRecord, Cursor> {
    const meta = unit.meta as CopilotUnitMeta;
    if (meta.tombstone === true) return null;

    let transcript: ParsedTranscript | null = null;
    if (meta.transcript?.version === TRANSCRIPT_VERSION) {
      transcript = transcriptRecords(meta.transcript, meta.sessionId, meta.cwd);
    }

    let chronicle: ChronicleSession | null = null;
    if (meta.chronicle !== null) {
      if (openChronicle === undefined) throw new Error('No read-only Chronicle SQLite opener is configured');
      chronicle = readOneChronicleSession(meta.chronicle, openChronicle);
      if (chronicle === null || chronicle.fingerprint !== meta.chronicle.fingerprint) {
        throw new Error(`Copilot Chronicle session changed after discovery: ${meta.rawSessionId}`);
      }
    }

    const canonical = transcript !== null
      ? transcript.records
      : chronicle !== null ? chronicleRecords(chronicle, meta.sessionId, meta.cwd).records : [];
    const fallbackBounds = chronicle === null
      ? { startedAt: null, endedAt: null }
      : chronicleRecords(chronicle, meta.sessionId, meta.cwd);
    const startedAt = transcript?.startedAt ?? fallbackBounds.startedAt;
    const endedAt = transcript?.endedAt ?? fallbackBounds.endedAt;
    yield* canonical;

    const summary = chronicle === null ? null : stringValue(chronicle.row.summary);
    if (summary !== null && summary !== '') {
      yield {
        kind: 'summary',
        id: `${meta.sessionId}:chronicle:summary`,
        session_id: meta.sessionId,
        timestamp: stringValue(chronicle!.row.updated_at),
        source: name,
        content: trunc(summary),
        visibility: 'visible',
        input_tokens: null,
        output_tokens: null,
      };
    }
    yield {
      kind: 'session',
      id: meta.sessionId,
      // Chronicle's `summary` is extracted from request text and truncated by
      // Copilot. It is evidence, not an upstream session-title field.
      title: null,
      project: projectSlugFromPath(meta.cwd),
      started_at: startedAt,
      ended_at: endedAt,
      git_branch: chronicle === null ? null : stringValue(chronicle.row.branch),
      version: transcript?.version ?? (chronicle === null ? null : 'chronicle-v3'),
      message_count: canonical.filter((record) => record.kind === 'message' && record.visibility === 'visible').length,
      countMode: 'total',
      jsonl_path: sourcePathFor(transcript === null ? null : meta.transcript, chronicle),
      source: name,
    };
    return meta.currentCursor;
  }

  return {
    name,
    descriptor: {
      id: name,
      name: 'GitHub Copilot',
      vendor: 'GitHub',
      defaultRoot: descriptorRoot,
      color: '#8957e5',
    },
    indexVersionMarker: COPILOT_CANONICAL_TRANSCRIPT_MARKER,
    sessionUnitKey: (session) => `copilot-unit:${session.sessionId}`,
    watchTargets: (configuredRoot) => (
      usesRootSet && samePath(configuredRoot, descriptorRoot) ? sourceRoots : [configuredRoot]
    ).flatMap((root) => {
      const dbPath = join(root, 'globalStorage', COPILOT_STORAGE_DIR, 'session-store.db');
      return [
        { kind: 'file' as const, path: dbPath },
        { kind: 'file' as const, path: `${dbPath}-wal` },
        { kind: 'tree' as const, path: join(root, 'workspaceStorage') },
      ];
    }),
    discover,
    parse,
    raw: (input) => rawTranscript(input) ?? rawChronicle(input, openChronicle),
  };
}

export const copilotProvider = createCopilotProvider();
