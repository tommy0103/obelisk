// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// V1: conversations_v2; V2: flat JSONL; V3: workspace JSONL + sub-executions.
// Each unit replaces one session identified by (normalized cwd, native id).

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join, normalize, win32 } from 'node:path';

import { normalizeObservedCwd, projectSlugFromPath, readLines, trunc, truncJson } from '../parsing.ts';
import type { SqliteDb, SqliteRow } from '../sqlite-types.ts';
import type {
  Cursor, DiscoverContext, IndexUnit, MessageRecord, ProviderAdapter,
  RawLookup, RawRecord, TranscriptRecord, WatchTarget,
} from './types.ts';

export const name = 'kiro';
export const KIRO_CANONICAL_TRANSCRIPT_MARKER = '__kiro_canonical_transcript_v3__';
export type KiroDatabaseOpener = (path: string) => SqliteDb;
type JsonRecord = Record<string, any>;
type Format = 'cli' | 'workspace' | 'sqlite';

interface KiroSource {
  format: Format;
  path: string;
  metadataPath?: string;
  header: JsonRecord;
  rawId: string;
  cwd: string | null;
  signature: string;
  mtime: number;
}

interface KiroUnitMeta {
  sources: KiroSource[];
  cursor: string;
  tombstone?: boolean;
  indexed?: readonly { sessionId: string; jsonlPath: string }[];
}

interface ProjectedMessage {
  role: string;
  text: string | null;
  contentType?: 'thinking';
  timestamp: string | null;
  model?: string | null;
  input?: number | null;
  output?: number | null;
  meta?: boolean;
  agent?: string;
  execution?: string;
  summary?: boolean;
  subagent?: { id: string; name: string | null; description: string | null; duration: number | null; parentCall: number | null };
  call?: { id: string; name: string; input: unknown };
  result?: { id: string; content: string; error: boolean };
  raw: unknown;
}

const require = createRequire(import.meta.url);

function defaultOpenDatabase(path: string): SqliteDb {
  // Like ZCode, defer the Node binding so Electron bundlers do not hoist it.
  // Callers may inject better-sqlite3 using the same structural DB interface.
  const specifier = ['node', 'sqlite'].join(':');
  const { DatabaseSync } = require(specifier) as {
    DatabaseSync: new (path: string, options: { readOnly: boolean }) => SqliteDb;
  };
  return new DatabaseSync(path, { readOnly: true });
}

function object(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function time(value: unknown): string | null {
  // CLI Prompt.meta.timestamp is epoch milliseconds; store columns are too.
  const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function observedCwd(value: unknown): string | null {
  // Preserve native Windows cwd when an exported history is read on POSIX.
  if (typeof value === 'string' && win32.isAbsolute(value) && !value.startsWith('/')) {
    return win32.normalize(value).replaceAll('\\', '/').toLowerCase();
  }
  return normalizeObservedCwd(value);
}

export function kiroSessionId(rawId: string, cwd: string | null): string {
  return `kiro:${encodeURIComponent(rawId)}:${hash(`kiro-cwd-v1\0${observedCwd(cwd) ?? ''}`)}`;
}

export function defaultKiroDatabasePath({
  homeDir = homedir(), platform = process.platform, env = process.env,
}: { homeDir?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}): string {
  if (platform === 'darwin') return join(homeDir, 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3');
  if (platform === 'win32') return win32.join(env.LOCALAPPDATA ?? win32.join(homeDir, 'AppData', 'Local'), 'kiro-cli', 'data.sqlite3');
  return join(env.XDG_DATA_HOME ?? join(homeDir, '.local', 'share'), 'kiro-cli', 'data.sqlite3');
}

function signature(paths: readonly string[]): { signature: string; mtime: number } {
  let mtime = 0;
  const members = paths.map(path => {
    try {
      const stat = statSync(path);
      mtime = Math.max(mtime, stat.mtimeMs);
      return [path, stat.mtimeMs, stat.ctimeMs, stat.size, stat.dev, stat.ino];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [path, 'missing'];
      throw error;
    }
  });
  return { signature: hash(JSON.stringify(members)), mtime };
}

function sourceSignature(source: KiroSource) {
  return signature(source.format === 'sqlite'
    ? [source.path, `${source.path}-wal`]
    : filePaths(source.path, source.metadataPath!, source.format));
}

function childPaths(path: string): string[] {
  const directory = join(dirname(path), 'sub-executions');
  try {
    // Enumerate native files. Transcript ids never authorize filesystem reads.
    return readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && /^[a-zA-Z0-9_-]+\.jsonl$/.test(entry.name))
      .map(entry => join(directory, entry.name)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function filePaths(path: string, metadataPath: string, format: 'cli' | 'workspace'): string[] {
  return format === 'cli' ? [path, metadataPath]
    : [path, metadataPath, join(dirname(path), 'sub-executions'), ...childPaths(path)];
}

function readJsonl(path: string, firstOnly = false): JsonRecord[] {
  const records: JsonRecord[] = [];
  try {
    readLines(path, (line, terminated) => {
      if (!line.trim()) return;
      try {
        const value: unknown = JSON.parse(line);
        if (!firstOnly && (value === null || typeof value !== 'object' || Array.isArray(value))) throw new Error('Expected object');
        records.push(object(value));
      } catch (error) {
        // Discovery only checks the version. Parse rejects completed corrupt
        // lines, but tolerates an unfinished tail from a live writer.
        if (terminated && !firstOnly) throw new Error(`Invalid Kiro JSONL at ${path}`, { cause: error });
      }
      if (firstOnly) return false;
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return records;
}

function sourcePath(source: KiroSource): string {
  return source.format === 'sqlite'
    ? `${source.path}#kiro:${encodeURIComponent(source.header.key)}:${encodeURIComponent(source.rawId)}`
    : source.path;
}

function cursor(sources: readonly KiroSource[]): string {
  return `${Math.max(...sources.map(source => source.mtime), 0)}:0:kiro-snapshot-v1:${hash(JSON.stringify(sources.map(source => [sourcePath(source), source.signature, source.header])))}`;
}

function discoverAt(root: string, dbPath: string, ctx: DiscoverContext, openDatabase: KiroDatabaseOpener): IndexUnit[] {
  const indexed = ctx.indexedSessions?.() ?? [];
  const sources: KiroSource[] = [];
  let complete = true;
  const issue = (path: string, error: unknown) => {
    complete = false;
    ctx.reportIncompleteInventory?.({ path, error: error instanceof Error ? error.message : String(error) });
  };
  const entries = (path: string, required = false) => {
    try { return readdirSync(path, { withFileTypes: true }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || required) issue(path, error);
      return [];
    }
  };
  const sessionsRoot = join(root, 'sessions');
  const workspaces = entries(sessionsRoot, indexed.some(session => !session.jsonlPath.includes('#kiro:')));
  const addFile = (path: string, metadataPath: string, format: 'cli' | 'workspace') => {
    try {
      const before = signature(filePaths(path, metadataPath, format));
      const header = object(JSON.parse(readFileSync(metadataPath, 'utf8')));
      const rawId = str(format === 'cli' ? header.session_id : header.id);
      if (rawId === null) throw new Error('Kiro session id is missing');
      if (format === 'cli' && header.session_state?.version !== 'v1') {
        throw new Error(`Unsupported Kiro CLI schema ${String(header.session_state?.version)}`);
      }
      if (format === 'cli') {
        const first = readJsonl(path, true)[0];
        if (first !== undefined && first.version !== 'v1') throw new Error(`Unsupported Kiro CLI event version ${String(first.version)}`);
      }
      if (format === 'workspace' && header.schemaVersion !== '1.0.0') {
        throw new Error(`Unsupported Kiro workspace schema ${String(header.schemaVersion)}`);
      }
      if (signature(filePaths(path, metadataPath, format)).signature !== before.signature) throw new Error('Kiro metadata changed during discovery');
      sources.push({
        format, path, metadataPath, header, rawId,
        cwd: observedCwd(format === 'cli' ? header.cwd : header.workspacePaths?.[0] ?? header.rootPaths?.[0]),
        ...before,
      });
    } catch (error) { issue(metadataPath, error); }
  };
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const workspacePath = join(sessionsRoot, workspace.name);
    if (workspace.name === 'cli') {
      for (const file of entries(workspacePath)) {
        if (file.isFile() && file.name.endsWith('.json')) {
          addFile(join(workspacePath, file.name.slice(0, -5) + '.jsonl'), join(workspacePath, file.name), 'cli');
        }
      }
    } else {
      for (const session of entries(workspacePath)) {
        if (!session.isDirectory() || !session.name.startsWith('sess_')) continue;
        const dir = join(workspacePath, session.name);
        addFile(join(dir, 'messages.jsonl'), join(dir, 'session.json'), 'workspace');
      }
    }
  }
  try {
    statSync(dbPath);
    const before = signature([dbPath, `${dbPath}-wal`]);
    const db = openDatabase(dbPath);
    try {
      const rows = db.prepare('SELECT key, conversation_id, created_at, updated_at FROM conversations_v2 ORDER BY key, conversation_id').all();
      if (signature([dbPath, `${dbPath}-wal`]).signature !== before.signature) throw new Error('Kiro database changed during discovery');
      for (const header of rows) {
        if (str(header.key) === null || str(header.conversation_id) === null) throw new Error('Invalid Kiro conversation identity');
        sources.push({ format: 'sqlite', path: dbPath, header, rawId: header.conversation_id, cwd: observedCwd(header.key), ...before });
      }
    } finally { db.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || indexed.some(session => session.jsonlPath.includes('#kiro:'))) issue(dbPath, error);
  }

  const groups = new Map<string, KiroSource[]>();
  for (const source of sources) {
    const id = kiroSessionId(source.rawId, source.cwd);
    groups.set(id, [...(groups.get(id) ?? []), source]);
  }
  const units: IndexUnit[] = [];
  for (const [sessionId, group] of groups) {
    // Prefer the newest saved snapshot. On equal timestamps, file formats
    // outrank the classic database. Do not deduplicate by prompt text.
    const updated = (source: KiroSource) => Date.parse(time(source.header.updated_at ?? source.header.lastModifiedAt) ?? '') || 0;
    const priority = { workspace: 2, cli: 1, sqlite: 0 };
    group.sort((a, b) => updated(b) - updated(a) || priority[b.format] - priority[a.format] || a.path.localeCompare(b.path));
    const currentCursor = cursor(group);
    const key = `kiro-unit:${sessionId}`;
    const prior = indexed.find(session => session.sessionId === sessionId);
    const hinted = ctx.changedPaths?.some(path => group.some(source => [source.path, source.metadataPath, `${source.path}-wal`, sourcePath(source)].includes(path))) ?? false;
    if (!hinted && ctx.lastCursor(key) === currentCursor && (ctx.indexedSessions === undefined || prior !== undefined)) continue;
    // Incomplete inventory cannot certify switching from an old source copy.
    if (!complete && prior !== undefined && prior.jsonlPath !== sourcePath(group[0]!)) continue;
    units.push({ key, sessionId, project: projectSlugFromPath(group[0]!.cwd) ?? undefined,
      retractSessionIds: [sessionId], meta: { sources: group, cursor: currentCursor } satisfies KiroUnitMeta });
  }
  if (complete) {
    for (const session of indexed) {
      if (groups.has(session.sessionId)) continue;
      units.push({ key: `kiro-unit:${session.sessionId}`, sessionId: session.sessionId,
        retractSessionIds: [session.sessionId], meta: { sources: [], cursor: '0:0:kiro-tombstone', tombstone: true, indexed } satisfies KiroUnitMeta });
    }
  }
  return units.sort((a, b) => a.key.localeCompare(b.key));
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    const block = object(part);
    if (typeof block.Text === 'string') return block.Text;
    if ('Json' in block) return JSON.stringify(block.Json);
    if (block.kind === 'text' && typeof block.data === 'string') return block.data;
    if (block.kind === 'json') return JSON.stringify(block.data);
    return '';
  }).filter(Boolean).join('\n');
}

function usage(metadata: JsonRecord, cli = false): { input: number | null; output: number | null } {
  const fields = cli
    ? ['input_token_count', 'cache_read_input_token_count', 'cache_write_input_token_count']
    : ['uncached_input_tokens', 'cache_read_input_tokens', 'cache_write_input_tokens'];
  const values = fields.map(field => number(metadata[field]));
  return {
    input: values.some(value => value !== null) ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null,
    output: number(metadata[cli ? 'output_token_count' : 'output_tokens']),
  };
}

function cliMessages(source: KiroSource): ProjectedMessage[] {
  const out: ProjectedMessage[] = [];
  const byRawId = new Map<string, ProjectedMessage>();
  let timestamp = time(source.header.created_at);
  const model = str(source.header.session_state?.rts_model_state?.model_info?.model_id);
  const reason = str(source.header.session_created_reason);
  if (reason === 'subagent') {
    // These headers attest child origin but carry no parent id. Keep them as
    // searchable standalone sessions, with an explicit metadata card.
    out.push({ role: 'system', text: 'Session created by a Kiro subagent', timestamp, meta: true, raw: { session_created_reason: reason } });
  }
  for (const event of readJsonl(source.path)) {
    if (event.version !== 'v1') throw new Error(`Unsupported Kiro CLI event version ${String(event.version)}`);
    const data = object(event.data);
    timestamp = time(data.meta?.timestamp) ?? timestamp;
    if (!['Prompt', 'AssistantMessage', 'ToolResults'].includes(event.kind)) continue;
    const role = event.kind === 'AssistantMessage' ? 'assistant' : 'user';
    const start = out.length;
    for (const part of Array.isArray(data.content) ? data.content : []) {
      const block = object(part);
      const value = object(block.data);
      const base = { role, timestamp, model, raw: event };
      if (block.kind === 'text' && typeof block.data === 'string') out.push({ ...base, text: block.data });
      else if (block.kind === 'thinking') out.push({ ...base, text: str(value.text), contentType: 'thinking', model: str(value.modelId) ?? model });
      else if (block.kind === 'toolUse' && str(value.toolUseId) !== null && str(value.name) !== null) {
        out.push({ ...base, text: null, call: { id: value.toolUseId, name: value.name, input: value.input } });
      } else if (block.kind === 'toolResult' && str(value.toolUseId) !== null) {
        out.push({ ...base, text: resultText(value.content) || null,
          result: { id: value.toolUseId, content: resultText(value.content), error: value.status !== 'success' } });
      } else out.push({ ...base, text: null });
    }
    if (out.length === start) out.push({ role, timestamp, model, text: null, raw: event });
    if (typeof data.message_id === 'string') byRawId.set(data.message_id, out.at(-1)!);
  }
  // Usage is per user turn, not per assistant block. Attach it once, to the
  // last assistant message id explicitly named by the turn metadata.
  const turns = source.header.session_state?.conversation_metadata?.user_turn_metadatas;
  for (const turn of Array.isArray(turns) ? turns : []) {
    let owner = (Array.isArray(turn.message_ids) ? turn.message_ids : [])
      .map((id: string) => byRawId.get(id)).filter((message: ProjectedMessage | undefined) => message?.role === 'assistant').at(-1);
    const tokens = usage(object(turn), true);
    if (owner === undefined) {
      if (tokens.input === null && tokens.output === null) continue;
      owner = { role: 'assistant', text: null, timestamp: time(turn.end_timestamp), model, raw: turn };
      out.push(owner);
    }
    owner.input = tokens.input;
    owner.output = tokens.output;
    owner.model = str(turn.model) ?? owner.model;
  }
  return out;
}

function workspaceMessages(source: KiroSource): ProjectedMessage[] {
  const events = readJsonl(source.path);
  const out: ProjectedMessage[] = [];
  const children = new Map<string, ProjectedMessage>();
  const completions: JsonRecord[] = [];
  if (str(source.header.parentSessionId)) {
    out.push({ role: 'system', text: `Forked from Kiro session ${source.header.parentSessionId}`,
      timestamp: time(source.header.createdAt), meta: true,
      raw: { parentSessionId: source.header.parentSessionId, forkedAtMessageId: source.header.forkedAtMessageId, createdReason: source.header.createdReason } });
  }
  const append = (event: JsonRecord, agent?: string) => {
    const payload = object(event.payload);
    const timestamp = time(event.timestamp);
    const base = { timestamp, model: str(source.header.modelId), raw: event, agent,
      execution: str(payload.executionId) ?? undefined };
    if (payload.type === 'usage_summary') {
      out.push({ ...base, role: 'system', text: `Kiro reported usage: ${JSON.stringify(payload)}`, meta: true });
    } else if (payload.type === 'session_metadata' && payload.value?.usagePercentage !== undefined) {
      out.push({ ...base, role: 'system', text: `Kiro reported usage percentage: ${JSON.stringify(payload)}`, meta: true });
    } else if (['user', 'assistant', 'agent_note', 'session_start'].includes(payload.type)) {
      const role = payload.type === 'user' ? 'user' : payload.type === 'assistant' ? 'assistant' : 'system';
      const text = str(payload.content);
      out.push({ ...base, role, text, contentType: payload.operationType === 'Reasoning' ? 'thinking' : undefined,
        model: str(payload.reasoningModelId) ?? base.model, meta: role === 'system', summary: ['Summary', 'PrintSummary'].includes(payload.operationType) });
    } else if (payload.type === 'tool_call' && str(payload.toolCallId) && str(payload.toolName)) {
      out.push({ ...base, role: 'assistant', text: null,
        call: { id: payload.toolCallId, name: payload.toolName, input: payload.args } });
    } else if (payload.type === 'tool_result' && str(payload.toolCallId)) {
      const text = resultText(payload.content);
      out.push({ ...base, role: 'user', text: text || null,
        result: { id: payload.toolCallId, content: text, error: payload.success === false } });
    } else if (payload.type === 'sub_agent_start' && str(payload.subSessionId)) {
      const message: ProjectedMessage = { ...base, role: 'system', text: str(payload.prompt) ?? str(payload.explanation), meta: true,
        execution: str(payload.parentExecutionId) ?? undefined,
        subagent: { id: payload.subSessionId, name: str(payload.subAgentName), description: str(payload.prompt) ?? str(payload.explanation), duration: null, parentCall: null } };
      out.push(message);
      children.set(payload.subSessionId, message);
    } else if (payload.type === 'sub_agent_complete') {
      completions.push(event);
    } else if (['tool_call', 'tool_result'].includes(payload.type)) {
      out.push({ ...base, role: payload.type === 'tool_call' ? 'assistant' : 'user', text: null });
    }
  };
  for (const event of events) append(event);
  for (const path of childPaths(source.path)) {
    const nativeId = basename(path, '.jsonl');
    // Interrupted executions may have persisted a child file before its start
    // marker. Keep those messages and attest only the id in the native filename.
    if (!children.has(nativeId)) {
      const message: ProjectedMessage = { role: 'system', text: null, timestamp: null, meta: true,
        subagent: { id: nativeId, name: null, description: null, duration: null, parentCall: null }, raw: { subSessionId: nativeId } };
      out.push(message);
      children.set(nativeId, message);
    }
    for (const event of readJsonl(path)) append(event, nativeId);
  }
  for (const event of completions) {
    const payload = object(event.payload);
    const child = children.get(payload.subSessionId);
    if (child === undefined) continue;
    const end = time(event.timestamp);
    if (end !== null && child.timestamp !== null) child.subagent!.duration = Math.max(0, Date.parse(end) - Date.parse(child.timestamp));
    const text = str(payload.response);
    out.push({ role: 'assistant', text,
      timestamp: end, model: str(source.header.modelId), agent: payload.subSessionId, raw: event });
  }
  for (const child of children.values()) {
    // Native V3 starts the child before emitting its orchestration tool call.
    // Match the saved prompt and role within the same execution; ambiguous
    // matches stay unlinked rather than assigning another delegation's tool.
    const candidates = out.flatMap((message, index) => {
      if (message.agent !== child.agent || message.execution !== child.execution || message.call?.name !== 'orchestrate_subagent') return [];
      const stages = object(message.call.input).stages;
      return Array.isArray(stages) && stages.some(stage => object(stage).prompt_template === child.subagent!.description && object(stage).role === child.subagent!.name) ? [index] : [];
    });
    if (candidates.length === 1) child.subagent!.parentCall = candidates[0]!;
  }
  return out;
}

function sqliteMessages(source: KiroSource, openDatabase: KiroDatabaseOpener): ProjectedMessage[] {
  const db = openDatabase(source.path);
  let row: SqliteRow | undefined;
  try {
    row = db.prepare('SELECT * FROM conversations_v2 WHERE key = ? AND conversation_id = ?').get(source.header.key, source.rawId);
  } finally { db.close(); }
  if (row === undefined) throw new Error('Kiro conversation disappeared after discovery');
  const conversation = object(JSON.parse(row.value));
  if (conversation.conversation_id !== source.rawId || !Array.isArray(conversation.history)) throw new Error('Invalid Kiro conversation');
  const out: ProjectedMessage[] = [];
  let timestamp = time(row.created_at);
  const userMessage = (user: JsonRecord, raw: unknown) => {
    timestamp = time(user.timestamp) ?? timestamp;
    const content = object(user.content);
    if (content.Prompt !== undefined || content.CancelledToolUses !== undefined) {
      const prompt = object(content.Prompt ?? content.CancelledToolUses);
      const text = str(prompt.prompt);
      out.push({ role: 'user', text, timestamp, raw });
    }
    const results = content.ToolUseResults?.tool_use_results ?? content.CancelledToolUses?.tool_use_results;
    for (const result of Array.isArray(results) ? results : []) {
      if (str(result.tool_use_id) === null) continue;
      const text = resultText(result.content);
      out.push({ role: 'user', text: text || null, timestamp, raw,
        result: { id: result.tool_use_id, content: text, error: result.status !== 'Success' } });
    }
    if (Object.keys(content).length === 0) out.push({ role: 'user', text: null, timestamp, raw });
  };
  for (const turn of conversation.history) {
    const metadata = object(turn.request_metadata);
    if (turn.user !== null && turn.user !== undefined) userMessage(object(turn.user), turn);
    timestamp = time(metadata.stream_end_timestamp_ms) ?? timestamp;
    const assistant = object(turn.assistant?.Response ?? turn.assistant?.ToolUse);
    const model = str(metadata.model_id) ?? str(conversation.model_info?.model_id);
    const base = { role: 'assistant', timestamp, model, raw: turn };
    const start = out.length;
    if (str(assistant.thinking?.text) !== null) out.push({ ...base, text: assistant.thinking.text, contentType: 'thinking' });
    if (str(assistant.content) !== null) out.push({ ...base, text: assistant.content });
    for (const tool of Array.isArray(assistant.tool_uses) ? assistant.tool_uses : []) {
      if (str(tool.id) === null || str(tool.name) === null) continue;
      out.push({ ...base, text: null,
        call: { id: tool.id, name: tool.name, input: tool.args } });
    }
    if (out.length === start) out.push({ ...base, text: null });
    Object.assign(out.at(-1)!, usage(metadata));
  }
  // An interrupted prompt/result can be saved outside the paired history.
  if (conversation.next_message !== null && conversation.next_message !== undefined) userMessage(object(conversation.next_message), conversation.next_message);
  return out;
}

function project(sources: KiroSource[], openDatabase: KiroDatabaseOpener): ProjectedMessage[] {
  const check = () => {
    for (const source of sources) {
      if (sourceSignature(source).signature !== source.signature) throw new Error('Kiro source changed after discovery');
    }
  };
  check();
  const source = sources[0]!;
  const messages = source.format === 'cli' ? cliMessages(source)
    : source.format === 'workspace' ? workspaceMessages(source) : sqliteMessages(source, openDatabase);
  check();
  return messages;
}

function recordsFor(source: KiroSource, sessionId: string, messages: ProjectedMessage[]): TranscriptRecord[] {
  const records: TranscriptRecord[] = [];
  const calls = new Map<string, string>();
  const previous = new Map<string, string>();
  const uuidAt = (index: number) => `${sessionId}:message:${String(index).padStart(6, '0')}`;
  for (const [index, message] of messages.entries()) {
    const uuid = uuidAt(index);
    const scope = message.agent ?? '';
    if (message.summary && message.text !== null) {
      records.push({ kind: 'summary', id: `${uuid}:summary`, session_id: sessionId,
        timestamp: message.timestamp, source: 'kiro:compaction', content: trunc(message.text), visibility: 'visible' });
      continue;
    }
    records.push({ kind: 'message', uuid, session_id: sessionId, type: message.role, parent_uuid: previous.get(scope) ?? null,
      timestamp: message.timestamp, role: message.role, text: message.text === null ? null : trunc(message.text),
      content_type: message.contentType ?? (message.call ? 'tool_use' : message.result ? 'tool_result' : message.text === null ? 'unknown' : 'text'), is_meta: message.meta ? 1 : 0, visibility: 'visible', model: message.model ?? null,
      is_sidechain: message.agent ? 1 : 0, agent_id: message.agent ? `${sessionId}:subagent:${message.agent}` : null, input_tokens: message.input ?? null, output_tokens: message.output ?? null,
      cwd: source.cwd, skill: null, source: name } satisfies MessageRecord);
    previous.set(scope, uuid);
    if (message.subagent !== undefined) records.push({ kind: 'subagent', agent_id: `${sessionId}:subagent:${message.subagent.id}`, session_id: sessionId,
      parent_tool_use_id: message.subagent.parentCall === null ? null : `${uuidAt(message.subagent.parentCall)}:tool`,
      agent_type: message.subagent.name, description: message.subagent.description, duration_ms: message.subagent.duration });
    if (message.call !== undefined) {
      // Occurrence-scoped ids preserve retries reusing the same native tool id.
      const id = `${uuid}:tool`;
      calls.set(`${scope}\0${message.call.id}`, id);
      records.push({ kind: 'tool_call', id, message_uuid: uuid, session_id: sessionId, name: message.call.name,
        presentation: 'default', input_json: truncJson(message.call.input ?? {}) ?? '{}', file_path: null });
    }
    if (message.result !== undefined) {
      records.push({ kind: 'tool_result', tool_use_id: calls.get(`${scope}\0${message.result.id}`) ?? `${uuid}:orphan-tool`, message_uuid: uuid,
        session_id: sessionId, content: trunc(message.result.content), file_path: null, is_error: message.result.error ? 1 : 0 });
      calls.delete(`${scope}\0${message.result.id}`);
    }
  }
  const header = source.header;
  records.push({ kind: 'session', id: sessionId,
    title: str(header.title) ?? messages.find(message => message.role === 'user' && !message.contentType && !message.result && message.text !== null)?.text?.slice(0, 200) ?? null,
    project: projectSlugFromPath(source.cwd), started_at: time(header.created_at ?? header.createdAt),
    ended_at: time(header.updated_at ?? header.lastModifiedAt) ?? messages.at(-1)?.timestamp ?? null,
    git_branch: null, version: source.format === 'workspace' ? `workspace-${header.schemaVersion}` : source.format === 'cli' ? 'cli-v1' : 'conversations-v2',
    message_count: messages.filter(message => message.agent === undefined && !(message.summary && message.text !== null)).length, countMode: 'total', jsonl_path: sourcePath(source), source: name });
  return records;
}

export function createKiroProvider({
  rootDir, homeDir = homedir(), databasePath, openDatabase = defaultOpenDatabase,
}: { rootDir?: string; homeDir?: string; databasePath?: string; openDatabase?: KiroDatabaseOpener } = {}): ProviderAdapter {
  const automaticRoot = join(homeDir, '.kiro');
  const expanded = rootDir === '~' ? homeDir : rootDir?.startsWith('~/') || rootDir?.startsWith('~\\') ? join(homeDir, rootDir.slice(2)) : rootDir;
  const root = normalize(expanded ?? automaticRoot);
  // A custom root is self-contained. It must not silently read the user's
  // unrelated platform store; exported stores can sit at <root>/data.sqlite3.
  const dbPath = databasePath ?? (root === normalize(automaticRoot) ? defaultKiroDatabasePath({ homeDir }) : join(root, 'data.sqlite3'));
  return {
    name, descriptor: { id: name, name: 'Kiro', vendor: 'AWS', defaultRoot: root, color: '#9046ff' },
    indexVersionMarker: KIRO_CANONICAL_TRANSCRIPT_MARKER,
    sessionUnitKey: session => `kiro-unit:${session.sessionId}`,
    watchTargets(configuredRoot): WatchTarget[] {
      const store = normalize(configuredRoot) === root ? dbPath : join(configuredRoot, 'data.sqlite3');
      return [{ kind: 'tree', path: join(configuredRoot, 'sessions') }, { kind: 'file', path: store }, { kind: 'file', path: `${store}-wal` }];
    },
    discover: ctx => discoverAt(root, dbPath, ctx, openDatabase),
    *parse(unit: IndexUnit, _cursor: Cursor): Generator<TranscriptRecord, Cursor> {
      const meta = unit.meta as KiroUnitMeta;
      if (meta.tombstone) {
        const current = discoverAt(root, dbPath, {
          lastCursor: () => null,
          indexedSessions: () => meta.indexed ?? [],
          reportIncompleteInventory: issue => { throw new Error(`Kiro inventory changed before deletion: ${issue?.error}`); },
        }, openDatabase);
        if (current.some(candidate => candidate.sessionId === unit.sessionId && !(candidate.meta as KiroUnitMeta).tombstone)) throw new Error('Kiro session reappeared before deletion');
        return meta.cursor;
      }
      const source = meta.sources[0]!;
      yield* recordsFor(source, unit.sessionId, project(meta.sources, openDatabase));
      return meta.cursor;
    },
    raw(input: RawLookup): RawRecord | null {
      try {
        if (input.source !== name || typeof input.session?.id !== 'string') return null;
        const units = discoverAt(root, dbPath, { lastCursor: () => null }, openDatabase);
        const unit = units.find(unit => unit.sessionId === input.session!.id);
        if (unit === undefined) return null;
        const meta = unit.meta as KiroUnitMeta;
        if (input.cursor !== meta.cursor) return null;
        const prefix = `${unit.sessionId}:message:`;
        if (!input.messageUuid.startsWith(prefix)) return null;
        const ordinal = input.messageUuid.slice(prefix.length);
        if (!/^\d{6,}$/.test(ordinal)) return null;
        const message = project(meta.sources, openDatabase)[Number(ordinal)];
        if (message === undefined) return null;
        const text = JSON.stringify(message.raw);
        return { text, totalLength: text.length, hasMore: false, messageText: message.text };
      } catch { return null; }
    },
  };
}

export const kiroProvider = createKiroProvider();
