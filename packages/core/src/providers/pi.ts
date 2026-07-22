import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  type Dirent,
} from 'node:fs';
import { homedir } from 'node:os';
import {
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from 'node:path';

import { projectSlugFromPath, readLines, trunc, truncJson } from '../parsing.ts';
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

type JsonRecord = Record<string, any>;

interface PiLineRecord {
  readonly line: number;
  readonly entry: JsonRecord;
}

interface PiUnitMeta {
  readonly header: JsonRecord;
}

interface ProjectedMessage {
  readonly id: string;
  readonly part: number;
  readonly type: string;
  readonly role: string;
  readonly text: string | null;
  readonly contentType: string;
  readonly isMeta: 0 | 1;
  readonly visibility: 'visible' | 'hidden';
  readonly toolCall?: JsonRecord;
  readonly toolResult?: JsonRecord;
}

const SOURCE = 'pi';
const TITLE_LIMIT = 200;
export const PI_CANONICAL_TRANSCRIPT_MARKER = '__pi_canonical_transcript_v1__';

function resolvePath(value: string, home: string, cwd: string): string {
  if (value === '~') return home;
  if (value.startsWith(`~${sep}`) || value.startsWith('~/') || value.startsWith('~\\')) {
    return resolve(home, value.slice(2));
  }
  return isAbsolute(value) ? normalize(value) : resolve(cwd, value);
}

export function defaultPiSessionsRoot({
  env = process.env,
  home = homedir(),
  cwd = process.cwd(),
}: {
  env?: NodeJS.ProcessEnv;
  home?: string;
  cwd?: string;
} = {}): string {
  const explicitSessions = env['PI_CODING_AGENT_SESSION_DIR'];
  if (explicitSessions) return resolvePath(explicitSessions, home, cwd);

  const agentDir = resolvePath(env['PI_CODING_AGENT_DIR'] || join(home, '.pi', 'agent'), home, cwd);
  const settingsPath = join(agentDir, 'settings.json');
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as JsonRecord;
      if (typeof settings.sessionDir === 'string' && settings.sessionDir.trim().length > 0) {
        return resolvePath(settings.sessionDir, home, cwd);
      }
    } catch { /* malformed optional global Pi settings */ }
  }
  return join(agentDir, 'sessions');
}

function lineCount(raw: string): number {
  if (raw.length === 0) return 0;
  const newlines = raw.match(/\n/g)?.length ?? 0;
  return newlines + (raw.endsWith('\n') ? 0 : 1);
}

function cursorMtime(cursor: Cursor): number | null {
  if (typeof cursor !== 'string') return null;
  const separator = cursor.indexOf(':');
  if (separator <= 0) return null;
  const mtime = Number(cursor.slice(0, separator));
  return Number.isFinite(mtime) ? mtime : null;
}

function readHeader(path: string): JsonRecord | null {
  let first: string | null = null;
  try {
    readLines(path, (line) => {
      first = line.endsWith('\r') ? line.slice(0, -1) : line;
      return false;
    });
    if (!first) return null;
    const header = JSON.parse(first) as JsonRecord;
    return header?.type === 'session'
      && header.version === 3
      && typeof header.id === 'string'
      && header.id.length > 0
      ? header
      : null;
  } catch {
    return null;
  }
}

function standardSessionFiles(rootDir: string): string[] {
  if (!existsSync(rootDir)) return [];
  const paths: string[] = [];
  let projects: Dirent<string>[];
  try { projects = readdirSync(rootDir, { withFileTypes: true }); } catch { return []; }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = join(rootDir, project.name);
    let sessions: Dirent<string>[];
    try { sessions = readdirSync(projectDir, { withFileTypes: true }); } catch { continue; }
    for (const session of sessions) {
      if (session.isFile() && session.name.toLowerCase().endsWith('.jsonl')) {
        paths.push(join(projectDir, session.name));
      }
    }
  }
  return paths.sort();
}

function changedStandardFiles(rootDir: string, changedPaths: readonly string[]): Set<string> {
  const changed = changedPaths.map((path) => (
    isAbsolute(path) ? normalize(path) : normalize(join(rootDir, path))
  ));
  const files = new Set<string>();
  for (const path of standardSessionFiles(rootDir)) {
    const normalizedPath = normalize(path);
    const projectDir = normalize(join(rootDir, relative(rootDir, path).split(sep)[0]!));
    if (changed.some((candidate) => (
      candidate === normalizedPath || candidate === projectDir || candidate === normalize(rootDir)
    ))) files.add(normalizedPath);
  }
  return files;
}

function discoverAt(rootDir: string, ctx: DiscoverContext): IndexUnit[] {
  const selected = ctx.changedPaths === undefined
    ? null
    : changedStandardFiles(rootDir, ctx.changedPaths);
  const units: IndexUnit[] = [];
  for (const path of standardSessionFiles(rootDir)) {
    const normalizedPath = normalize(path);
    if (selected !== null && !selected.has(normalizedPath)) continue;
    let mtimeMs: number;
    try { mtimeMs = statSync(path).mtimeMs; } catch { continue; }
    if (selected === null && cursorMtime(ctx.lastCursor(path)) === mtimeMs) continue;
    const header = readHeader(path);
    if (header === null) continue;
    const sessionId = namespacedSessionId(header.id);
    units.push({
      key: path,
      sessionId,
      project: projectSlugFromPath(typeof header.cwd === 'string' ? header.cwd : null) ?? undefined,
      meta: { header } satisfies PiUnitMeta,
    });
  }
  return units;
}

function readPiLines(path: string): { raw: string; records: PiLineRecord[]; cursor: Exclude<Cursor, null> } {
  const before = statSync(path);
  const raw = readFileSync(path, 'utf8');
  const physicalLines = raw.split('\n');
  if (raw.endsWith('\n')) physicalLines.pop();
  const records: PiLineRecord[] = [];
  for (let index = 0; index < physicalLines.length; index++) {
    const source = physicalLines[index]!.endsWith('\r')
      ? physicalLines[index]!.slice(0, -1)
      : physicalLines[index]!;
    if (source.length === 0) continue;
    try {
      records.push({ line: index + 1, entry: JSON.parse(source) as JsonRecord });
    } catch (error) {
      const tornFinalLine = index === physicalLines.length - 1 && !raw.endsWith('\n');
      if (tornFinalLine) break;
      throw new Error(`Pi session: corrupted line ${index + 1} in ${path}: ${String(error)}`, { cause: error });
    }
  }
  const after = statSync(path);
  if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) {
    throw new Error(`Pi session changed while indexing: ${path}`);
  }
  return { raw, records, cursor: `${after.mtimeMs}:${lineCount(raw)}` };
}

function namespacedSessionId(nativeId: unknown): string {
  return `pi:${String(nativeId).replace(/^pi:/, '')}`;
}

function messageId(sessionId: string, entryId: unknown, part: number): string {
  return `${sessionId}:message:${String(entryId)}:${part}`;
}

function toolId(sessionId: string, nativeId: unknown): string {
  return `${sessionId}:tool:${String(nativeId)}`;
}

function summaryId(sessionId: string, entryId: unknown, source: string): string {
  return `${sessionId}:summary:${String(entryId)}:${source}`;
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

function textBlocks(content: unknown): Array<{ part: number; text: string }> {
  if (typeof content === 'string') return [{ part: 0, text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block, part) => (
    block?.type === 'text' && typeof block.text === 'string'
      ? [{ part, text: block.text }]
      : []
  ));
}

function joinedText(content: unknown): string | null {
  const parts = textBlocks(content).map((part) => part.text);
  return parts.length > 0 ? parts.join('\n') : null;
}

function bashText(message: JsonRecord): string {
  const command = typeof message.command === 'string' ? message.command : '';
  const output = typeof message.output === 'string' ? message.output : '';
  const lines = [output.length > 0 ? `$ ${command}\n${output}` : `$ ${command}`];
  if (typeof message.exitCode === 'number' && message.exitCode !== 0) {
    lines.push(`[exit code: ${message.exitCode}]`);
  }
  if (message.cancelled === true) lines.push('[cancelled]');
  if (message.truncated === true) lines.push('[output truncated]');
  return lines.join('\n');
}

function projectedMessages(entry: JsonRecord, sessionId: string): ProjectedMessage[] {
  if (entry.type === 'custom_message') {
    return textBlocks(entry.content).map(({ part, text }) => ({
      id: messageId(sessionId, entry.id, part), part, type: 'custom', role: 'custom', text,
      contentType: 'text', isMeta: 1, visibility: entry.display === false ? 'hidden' : 'visible',
    }));
  }
  if (entry.type !== 'message') return [];
  const message = entry.message as JsonRecord | undefined;
  if (!message || typeof message.role !== 'string') return [];

  if (message.role === 'assistant') {
    const content = Array.isArray(message.content) ? message.content : [];
    const projected: ProjectedMessage[] = [];
    for (let part = 0; part < content.length; part++) {
      const block = content[part];
      if (block?.type === 'text' && typeof block.text === 'string') {
        projected.push({
          id: messageId(sessionId, entry.id, part), part, type: 'assistant', role: 'assistant',
          text: block.text, contentType: 'text', isMeta: 0, visibility: 'visible',
        });
      } else if (block?.type === 'thinking' && typeof block.thinking === 'string') {
        projected.push({
          id: messageId(sessionId, entry.id, part), part, type: 'assistant', role: 'assistant',
          text: block.thinking, contentType: 'thinking', isMeta: 0, visibility: 'visible',
        });
      } else if (block?.type === 'toolCall' && block.id !== undefined) {
        projected.push({
          id: messageId(sessionId, entry.id, part), part, type: 'assistant', role: 'assistant',
          text: null, contentType: 'tool_use', isMeta: 0, visibility: 'visible', toolCall: block,
        });
      }
    }
    if (typeof message.errorMessage === 'string' && message.errorMessage.length > 0) {
      const part = content.length;
      projected.push({
        id: messageId(sessionId, entry.id, part), part, type: 'assistant', role: 'assistant',
        text: message.errorMessage, contentType: 'text', isMeta: 0, visibility: 'visible',
      });
    }
    return projected;
  }

  if (message.role === 'toolResult') {
    const text = joinedText(message.content) ?? '';
    return [{
      id: messageId(sessionId, entry.id, 0), part: 0, type: 'toolResult', role: 'toolResult',
      text, contentType: 'tool_result', isMeta: 0, visibility: 'visible', toolResult: message,
    }];
  }

  if (message.role === 'bashExecution') {
    return [{
      id: messageId(sessionId, entry.id, 0), part: 0, type: 'bashExecution', role: 'bashExecution',
      text: bashText(message), contentType: 'text', isMeta: 0, visibility: 'visible',
    }];
  }

  if (message.role === 'custom') {
    return textBlocks(message.content).map(({ part, text }) => ({
      id: messageId(sessionId, entry.id, part), part, type: 'custom', role: 'custom', text,
      contentType: 'text', isMeta: 1, visibility: message.display === false ? 'hidden' : 'visible',
    }));
  }

  if (message.role !== 'user') return [];
  return textBlocks(message.content).map(({ part, text }) => ({
    id: messageId(sessionId, entry.id, part), part, type: 'user', role: 'user', text,
    contentType: 'text', isMeta: 0, visibility: 'visible',
  }));
}

function numeric(usage: JsonRecord, ...names: string[]): number | null {
  for (const name of names) {
    const value = usage[name];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function inputUsage(usage: JsonRecord): number | null {
  const values = [
    numeric(usage, 'input', 'input_tokens'),
    numeric(usage, 'cacheRead', 'cache_read_input_tokens'),
    numeric(usage, 'cacheWrite', 'cache_creation_input_tokens'),
  ];
  return values.some((value) => value !== null)
    ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : null;
}

function piFilePath(name: unknown, args: unknown): string | null {
  if (typeof name !== 'string' || !['read', 'edit', 'write'].includes(name.toLowerCase())) return null;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return null;
  const input = args as JsonRecord;
  return typeof input.path === 'string'
    ? input.path
    : typeof input.file_path === 'string'
      ? input.file_path
      : null;
}

function structuralGitBranch(header: JsonRecord, entries: readonly JsonRecord[]): string | null {
  const values = [header, ...entries].reverse();
  for (const value of values) {
    if (typeof value.gitBranch === 'string') return value.gitBranch;
    if (typeof value.git_branch === 'string') return value.git_branch;
    if (typeof value.git?.branch === 'string') return value.git.branch;
  }
  return null;
}

function titleFor(entries: readonly JsonRecord[]): string | null {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.type === 'session_info') {
      if (typeof entry.name !== 'string') return null;
      return entry.name.trim() || null;
    }
  }
  for (const entry of entries) {
    if (entry.type !== 'message' || entry.message?.role !== 'user') continue;
    const text = joinedText(entry.message.content)?.trim();
    if (text) return text.slice(0, TITLE_LIMIT);
  }
  return null;
}

function summaryRecord(entry: JsonRecord, sessionId: string): TranscriptRecord | null {
  if (entry.type === 'compaction' && typeof entry.summary === 'string') {
    return {
      kind: 'summary', id: summaryId(sessionId, entry.id, 'compaction'), session_id: sessionId,
      timestamp: normalizeTimestamp(entry.timestamp), source: 'compaction', content: trunc(entry.summary),
    };
  }
  if (entry.type === 'branch_summary' && typeof entry.summary === 'string') {
    return {
      kind: 'summary', id: summaryId(sessionId, entry.id, 'branch_summary'), session_id: sessionId,
      timestamp: normalizeTimestamp(entry.timestamp), source: 'branch_summary', content: trunc(entry.summary),
    };
  }
  if (entry.type === 'message') {
    const message = entry.message as JsonRecord | undefined;
    if (message?.role === 'compactionSummary' && typeof message.summary === 'string') {
      return {
        kind: 'summary', id: summaryId(sessionId, entry.id, 'compaction'), session_id: sessionId,
        timestamp: normalizeTimestamp(entry.timestamp ?? message.timestamp), source: 'compaction', content: trunc(message.summary),
      };
    }
    if (message?.role === 'branchSummary' && typeof message.summary === 'string') {
      return {
        kind: 'summary', id: summaryId(sessionId, entry.id, 'branch_summary'), session_id: sessionId,
        timestamp: normalizeTimestamp(entry.timestamp ?? message.timestamp), source: 'branch_summary', content: trunc(message.summary),
      };
    }
  }
  return null;
}

export function* parse(unit: IndexUnit, _cursor: Cursor): Generator<TranscriptRecord, Cursor> {
  const source = readPiLines(unit.key);
  const header = source.records[0]?.entry;
  if (
    header?.type !== 'session'
    || header.version !== 3
    || typeof header.id !== 'string'
    || header.id.length === 0
  ) return source.cursor;

  const sessionId = namespacedSessionId(header.id);
  const lineEntries = source.records.slice(1).filter(({ entry }) => (
    entry && typeof entry === 'object' && typeof entry.id === 'string'
  ));
  const entries = lineEntries.map(({ entry }) => entry);
  const entryById = new Map(entries.map((entry) => [entry.id as string, entry]));
  const projectedById = new Map(entries.map((entry) => [entry.id as string, projectedMessages(entry, sessionId)]));
  const finalMessageByEntry = new Map<string, string | null>();
  const resolvingFinal = new Set<string>();
  const finalMessage = (entryId: unknown): string | null => {
    if (typeof entryId !== 'string') return null;
    if (finalMessageByEntry.has(entryId)) return finalMessageByEntry.get(entryId) ?? null;
    if (resolvingFinal.has(entryId)) return null;
    resolvingFinal.add(entryId);
    const own = projectedById.get(entryId)?.at(-1)?.id;
    const entry = entryById.get(entryId);
    const result = own ?? finalMessage(entry?.parentId);
    resolvingFinal.delete(entryId);
    finalMessageByEntry.set(entryId, result);
    return result;
  };

  const leaf = entries.at(-1);
  const activeEntryIds = new Set<string>();
  let active: JsonRecord | undefined = leaf;
  while (active && typeof active.id === 'string' && !activeEntryIds.has(active.id)) {
    activeEntryIds.add(active.id);
    active = typeof active.parentId === 'string' ? entryById.get(active.parentId) : undefined;
  }

  const modelByEntry = new Map<string, string | null>();
  const resolvingModel = new Set<string>();
  const modelAt = (entry: JsonRecord): string | null => {
    if (modelByEntry.has(entry.id)) return modelByEntry.get(entry.id) ?? null;
    if (resolvingModel.has(entry.id)) return null;
    resolvingModel.add(entry.id);
    const parent = typeof entry.parentId === 'string' ? entryById.get(entry.parentId) : undefined;
    let model = parent ? modelAt(parent) : null;
    if (entry.type === 'model_change' && typeof entry.modelId === 'string') model = entry.modelId;
    if (entry.type === 'message' && entry.message?.role === 'assistant' && typeof entry.message.model === 'string') {
      model = entry.message.model;
    }
    resolvingModel.delete(entry.id);
    modelByEntry.set(entry.id, model);
    return model;
  };

  const cwdByEntry = new Map<string, string | null>();
  const resolvingCwd = new Set<string>();
  const cwdAt = (entry: JsonRecord): string | null => {
    if (cwdByEntry.has(entry.id)) return cwdByEntry.get(entry.id) ?? null;
    if (resolvingCwd.has(entry.id)) {
      throw new Error(`Pi session: corrupted cwd ancestry cycle involving entry ${String(entry.id)} in ${unit.key}`);
    }
    resolvingCwd.add(entry.id);
    const parent = typeof entry.parentId === 'string' ? entryById.get(entry.parentId) : undefined;
    let cwd = parent ? cwdAt(parent) : (typeof header.cwd === 'string' ? header.cwd : null);
    if (typeof entry.cwd === 'string') cwd = entry.cwd;
    if (typeof entry.message?.cwd === 'string') cwd = entry.message.cwd;
    resolvingCwd.delete(entry.id);
    cwdByEntry.set(entry.id, cwd);
    return cwd;
  };
  for (const entry of entries) cwdAt(entry);

  const records: TranscriptRecord[] = [];
  const toolPaths = new Map<string, string | null>();
  let startedAt = normalizeTimestamp(header.timestamp);
  let endedAt = startedAt;
  const updateBounds = (timestamp: string | null): void => {
    if (timestamp === null) return;
    if (startedAt === null || timestamp < startedAt) startedAt = timestamp;
    if (endedAt === null || timestamp > endedAt) endedAt = timestamp;
  };

  for (const entry of entries) {
    const timestamp = normalizeTimestamp(entry.timestamp ?? entry.message?.timestamp);
    updateBounds(timestamp);
    const summary = summaryRecord(entry, sessionId);
    if (summary !== null) records.push(summary);

    const projected = projectedById.get(entry.id as string) ?? [];
    let parentUuid = finalMessage(entry.parentId);
    const usage = entry.type === 'message' && entry.message?.role === 'assistant'
      ? (entry.message.usage ?? {}) as JsonRecord
      : {};
    for (let index = 0; index < projected.length; index++) {
      const item = projected[index]!;
      const isLastAssistantPart = item.role === 'assistant' && index === projected.length - 1;
      const message: MessageRecord = {
        kind: 'message', uuid: item.id, session_id: sessionId, type: item.type,
        parent_uuid: parentUuid, timestamp, role: item.role, text: trunc(item.text),
        content_type: item.contentType, is_meta: item.isMeta, visibility: item.visibility,
        model: modelAt(entry), is_sidechain: activeEntryIds.has(entry.id as string) ? 0 : 1,
        agent_id: null,
        input_tokens: isLastAssistantPart ? inputUsage(usage) : null,
        output_tokens: isLastAssistantPart ? numeric(usage, 'output', 'output_tokens') : null,
        cwd: cwdAt(entry), skill: null, source: SOURCE,
      };
      records.push(message);
      parentUuid = item.id;

      if (item.toolCall) {
        const id = toolId(sessionId, item.toolCall.id);
        const args = item.toolCall.arguments && typeof item.toolCall.arguments === 'object'
          ? item.toolCall.arguments
          : {};
        const path = piFilePath(item.toolCall.name, args);
        toolPaths.set(id, path);
        records.push({
          kind: 'tool_call', id, message_uuid: item.id, session_id: sessionId,
          name: typeof item.toolCall.name === 'string' ? item.toolCall.name : 'tool',
          presentation: item.toolCall.name === 'Skill' ? 'skill' : 'default',
          input_json: truncJson(args) ?? '{}', file_path: path,
        });
      }
      if (item.toolResult) {
        const id = toolId(sessionId, item.toolResult.toolCallId);
        records.push({
          kind: 'tool_result', tool_use_id: id, message_uuid: item.id, session_id: sessionId,
          content: trunc(joinedText(item.toolResult.content) ?? ''),
          file_path: toolPaths.get(id) ?? null, is_error: item.toolResult.isError === true ? 1 : 0,
        });
      }
    }
  }

  yield { kind: 'delete-session', sessionId };
  yield* records;
  yield {
    kind: 'session', id: sessionId, title: titleFor(entries),
    project: projectSlugFromPath(typeof header.cwd === 'string' ? header.cwd : null),
    started_at: startedAt, ended_at: endedAt,
    git_branch: structuralGitBranch(header, entries), version: String(header.version),
    message_count: records.filter((record) => record.kind === 'message').length,
    countMode: 'total', jsonl_path: unit.key, source: SOURCE,
  };
  return source.cursor;
}

function rawMessageText(entry: JsonRecord, part: number): string | null {
  if (entry.type === 'custom_message') {
    return textBlocks(entry.content).find((block) => block.part === part)?.text ?? null;
  }
  if (entry.type !== 'message') return null;
  const message = entry.message as JsonRecord | undefined;
  if (!message) return null;
  if (message.role === 'assistant') {
    const content = Array.isArray(message.content) ? message.content : [];
    const block = content[part];
    if (block?.type === 'text' && typeof block.text === 'string') return block.text;
    if (block?.type === 'thinking' && typeof block.thinking === 'string') return block.thinking;
    if (part === content.length && typeof message.errorMessage === 'string' && message.errorMessage.length > 0) {
      return message.errorMessage;
    }
    return null;
  }
  if (message.role === 'toolResult') return joinedText(message.content) ?? '';
  if (message.role === 'bashExecution') return bashText(message);
  if (message.role === 'custom' || message.role === 'user') {
    return textBlocks(message.content).find((block) => block.part === part)?.text ?? null;
  }
  return null;
}

function rawPi(input: RawLookup): RawRecord | null {
  const match = /^pi:[^:]+:message:([^:]+):(\d+)$/.exec(input.messageUuid);
  const path = typeof input.session?.jsonl_path === 'string' ? input.session.jsonl_path : null;
  if (match === null || path === null || !existsSync(path)) return null;
  const entryId = match[1]!;
  const part = Number(match[2]);
  let found: RawRecord | null = null;
  readLines(path, (line) => {
    const source = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!source.includes(entryId)) return;
    try {
      const entry = JSON.parse(source) as JsonRecord;
      if (entry?.id !== entryId) return;
      found = {
        text: source, totalLength: source.length, offset: 0, limit: source.length,
        hasMore: false, messageText: rawMessageText(entry, part),
      };
      return false;
    } catch { /* malformed source line */ }
  });
  return found;
}

export function createPiProvider({ rootDir }: { rootDir?: string } = {}): ProviderAdapter {
  const resolvedRoot = rootDir ?? defaultPiSessionsRoot();
  return {
    name: SOURCE,
    descriptor: {
      id: SOURCE, name: 'Pi', vendor: 'Pi', defaultRoot: resolvedRoot, color: '#e2b714',
    },
    indexVersionMarker: PI_CANONICAL_TRANSCRIPT_MARKER,
    watchRoots: (configuredRoot) => [configuredRoot],
    discover: (ctx) => discoverAt(resolvedRoot, ctx),
    parse,
    raw: rawPi,
  };
}

export const piProvider = createPiProvider();
