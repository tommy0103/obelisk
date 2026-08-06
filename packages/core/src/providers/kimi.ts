import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';

import { filePath, projectSlugFromPath, sourceInventoryIssue, trunc, truncJson } from '../parsing.ts';
import type {
  Cursor,
  DiscoverContext,
  TranscriptRecord,
  IndexUnit,
  MessageRecord,
  ProviderAdapter,
  RawLookup,
  RawRecord,
  InventoryIssue,
  SubagentRecord,
  SummaryRecord,
  ToolCallRecord,
  ToolResultRecord,
} from './types.ts';

type JsonRecord = Record<string, any>;

interface KimiWireFile {
  readonly agentId: string;
  readonly main: boolean;
  readonly path: string;
}

interface KimiSessionUnitMeta {
  readonly kind: 'session';
  readonly sessionDir: string;
  readonly statePath: string;
  readonly wireFiles: readonly KimiWireFile[];
  readonly currentCursor: Exclude<Cursor, null>;
}

interface LineRecord {
  readonly line: number;
  readonly record: JsonRecord;
}

interface ProjectedSession {
  readonly messages: MessageRecord[];
  readonly toolCalls: ToolCallRecord[];
  readonly toolResults: ToolResultRecord[];
  readonly summaries: SummaryRecord[];
  readonly subagents: SubagentRecord[];
  readonly durations: TranscriptRecord[];
  readonly mainMessageCount: number;
  readonly mainWirePath: string;
}

const SOURCE = 'kimi';
export const KIMI_CANONICAL_TRANSCRIPT_MARKER = '__kimi_canonical_transcript_v4__';

function defaultKimiRoot(): string {
  return process.env['KIMI_CODE_HOME'] ?? join(homedir(), '.kimi-code');
}

function readState(path: string): JsonRecord {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as JsonRecord
      : {};
  } catch {
    return {};
  }
}

function readWire(path: string): LineRecord[] {
  const lines = readFileSync(path, 'utf8').split('\n');
  const records: LineRecord[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.endsWith('\r') ? lines[index]!.slice(0, -1) : lines[index]!;
    if (line.length === 0) continue;
    try {
      records.push({ line: index + 1, record: JSON.parse(line) as JsonRecord });
    } catch (error) {
      if (index === lines.length - 1) break;
      throw new Error(`wire.jsonl: corrupted line ${index + 1} in ${path}: ${String(error)}`, {
        cause: error,
      });
    }
  }
  return records;
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

function fileLineCount(path: string): number {
  const raw = readFileSync(path, 'utf8');
  if (raw.length === 0) return 0;
  const newlines = raw.match(/\n/g)?.length ?? 0;
  return newlines + (raw.endsWith('\n') ? 0 : 1);
}

function cursorFor(statePath: string, wires: readonly KimiWireFile[]): Exclude<Cursor, null> {
  const paths = [statePath, ...wires.map((wire) => wire.path)].filter(existsSync);
  let maxMtime = 0;
  let totalLines = 0;
  for (const path of paths) {
    maxMtime = Math.max(maxMtime, statSync(path).mtimeMs);
    totalLines += fileLineCount(path);
  }
  return `${maxMtime}:${totalLines}`;
}

function normalizeTime(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return null;
}

function contentParts(content: unknown): JsonRecord[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content)
    ? content.filter((part): part is JsonRecord => part !== null && typeof part === 'object')
    : [];
}

function rawPartText(part: JsonRecord): string | null {
  if (part.type === 'text' && typeof part.text === 'string') return part.text;
  if (part.type === 'think' && typeof part.think === 'string') return part.think;
  if (part.type === 'thinking' && typeof part.thinking === 'string') return part.thinking;
  return null;
}

function partText(part: JsonRecord): string | null {
  const text = rawPartText(part);
  return text === null ? null : trunc(text);
}

function partContentType(part: JsonRecord): string {
  return part.type === 'think' || part.type === 'thinking'
    ? 'thinking'
    : typeof part.type === 'string'
      ? part.type
      : 'unknown';
}

function messageText(content: unknown): string | null {
  const parts = contentParts(content);
  const text = parts.map(partText).filter((value): value is string => value !== null);
  return text.length > 0 ? trunc(text.join('\n')) : null;
}

function messageContentType(content: unknown): string {
  const types = new Set(contentParts(content).map(partContentType));
  return types.size === 1 ? [...types][0]! : 'unknown';
}

function namespacedSessionId(nativeId: string): string {
  return `kimi:${nativeId}`;
}

function namespacedAgentId(sessionId: string, agentId: string): string {
  return `${sessionId}:${agentId}`;
}

function namespacedEventId(sessionId: string, agentId: string, nativeId: unknown, line: number): string {
  const suffix = typeof nativeId === 'string' && nativeId.length > 0 ? nativeId : `line-${line}`;
  return `${sessionId}:${agentId}:${suffix}`;
}

function namespacedToolId(sessionId: string, agentId: string, nativeId: unknown): string {
  return `${sessionId}:${agentId}:${String(nativeId)}`;
}

function numericField(record: JsonRecord, ...fields: string[]): number | null {
  const value = fields.map((field) => record[field]).find((candidate) => (
    typeof candidate === 'number' && Number.isFinite(candidate)
  ));
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function inputUsage(usage: JsonRecord): number | null {
  const normalized = numericField(usage, 'input_tokens', 'inputTokens');
  if (normalized !== null) return normalized;
  const fields = ['inputOther', 'inputCacheRead', 'inputCacheCreation'];
  const values = fields.map((field) => numericField(usage, field));
  return values.some((value) => value !== null)
    ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : null;
}

function outputUsage(usage: JsonRecord): number | null {
  return numericField(usage, 'output_tokens', 'outputTokens', 'output');
}

function isRealUserMessage(message: JsonRecord): boolean {
  if (message.role !== 'user') return false;
  const origin = message.origin as JsonRecord | undefined;
  if (origin === undefined || origin.kind === 'user') return true;
  return (origin.kind === 'skill_activation' || origin.kind === 'plugin_command')
    && origin.trigger === 'user-slash';
}

function slashCommandText(command: string, args: unknown): string {
  const trimmedArgs = typeof args === 'string' ? args.trim() : '';
  return trimmedArgs.length > 0 ? `${command} ${trimmedArgs}` : command;
}

function userSlashCommandText(message: JsonRecord): string | null {
  const origin = message.origin as JsonRecord | undefined;
  if (message.role === 'user' && origin?.trigger === 'user-slash') {
    if (origin.kind === 'skill_activation' && typeof origin.skillName === 'string') {
      return slashCommandText(`/${origin.skillName}`, origin.skillArgs);
    }
    if (
      origin.kind === 'plugin_command'
      && typeof origin.pluginId === 'string'
      && typeof origin.commandName === 'string'
    ) {
      return slashCommandText(`/${origin.pluginId}:${origin.commandName}`, origin.commandArgs);
    }
  }
  return null;
}

function projectedMessageText(message: JsonRecord): string | null {
  const slashCommand = userSlashCommandText(message);
  return slashCommand === null ? messageText(message.content) : trunc(slashCommand);
}

function isMetaMessage(message: JsonRecord): boolean {
  const origin = message.origin as JsonRecord | undefined;
  if (origin === undefined || origin.kind === 'user') return false;
  return !isRealUserMessage(message);
}

function canonicalMessageContentType(message: JsonRecord): string {
  const origin = message.origin as JsonRecord | undefined;
  return origin?.kind === 'skill_activation' && !isRealUserMessage(message)
    ? 'skill_instructions'
    : messageContentType(message.content);
}

function projectSession(meta: KimiSessionUnitMeta, sessionId: string, state: JsonRecord): ProjectedSession {
  const cwd = typeof state.cwd === 'string'
    ? state.cwd
    : typeof state.workDir === 'string'
      ? state.workDir
      : null;
  const messages: MessageRecord[] = [];
  const toolCalls: ToolCallRecord[] = [];
  const toolResults: ToolResultRecord[] = [];
  const summaries: SummaryRecord[] = [];
  const durations: TranscriptRecord[] = [];
  const childParentCalls = new Map<string, string>();
  let mainMessageCount = 0;

  for (const wire of meta.wireFiles) {
    const wireMessageStart = messages.length;
    const records = readWire(wire.path);
    const agentDbId = wire.main ? null : namespacedAgentId(sessionId, wire.agentId);
    let previousUuid: string | null = null;
    let model: string | null = null;
    const stepStarts = new Map<string, number>();
    const stepMessages = new Map<string, MessageRecord[]>();
    const callMessageUuids = new Map<string, string>();
    const injectionMessageUuids = new Set<string>();
    const realUserMessageUuids = new Set<string>();
    let undoFloor = wireMessageStart;

    const resetOpenState = (): void => {
      stepStarts.clear();
      stepMessages.clear();
      callMessageUuids.clear();
    };

    const applyUndo = (count: number): void => {
      if (count <= 0) return;
      const removedMessageUuids = new Set<string>();
      let removedUserCount = 0;
      for (let index = messages.length - 1; index >= undoFloor; index--) {
        const message = messages[index]!;
        if (injectionMessageUuids.has(message.uuid)) continue;
        messages.splice(index, 1);
        removedMessageUuids.add(message.uuid);
        injectionMessageUuids.delete(message.uuid);
        if (wire.main) mainMessageCount--;
        if (realUserMessageUuids.delete(message.uuid)) {
          removedUserCount++;
          if (removedUserCount >= count) break;
        }
      }
      const removedToolIds = new Set(
        toolCalls.filter((call) => removedMessageUuids.has(call.message_uuid)).map((call) => call.id),
      );
      for (let index = toolCalls.length - 1; index >= 0; index--) {
        if (removedMessageUuids.has(toolCalls[index]!.message_uuid)) toolCalls.splice(index, 1);
      }
      for (let index = toolResults.length - 1; index >= 0; index--) {
        const result = toolResults[index]!;
        if (removedMessageUuids.has(result.message_uuid) || removedToolIds.has(result.tool_use_id)) {
          toolResults.splice(index, 1);
        }
      }
      for (let index = durations.length - 1; index >= 0; index--) {
        const duration = durations[index]!;
        if (duration.kind === 'message-turn-duration' && removedMessageUuids.has(duration.uuid)) {
          durations.splice(index, 1);
        }
      }
      previousUuid = messages.slice(wireMessageStart).at(-1)?.uuid ?? null;
      resetOpenState();
    };

    const pushMessage = (message: MessageRecord, stepUuid?: string): void => {
      messages.push(message);
      if (wire.main) mainMessageCount++;
      previousUuid = message.uuid;
      if (stepUuid !== undefined) {
        const entries = stepMessages.get(stepUuid) ?? [];
        entries.push(message);
        stepMessages.set(stepUuid, entries);
      }
    };

    for (const { line, record } of records) {
      const timestamp = normalizeTime(record.time);
      if (record.type === 'config.update') {
        model = typeof record.modelAlias === 'string' ? record.modelAlias : model;
        continue;
      }
      if (record.type === 'context.clear') {
        undoFloor = messages.length;
        resetOpenState();
        continue;
      }
      if (record.type === 'context.undo') {
        applyUndo(typeof record.count === 'number' ? record.count : 0);
        continue;
      }
      if (record.type === 'context.append_message') {
        const source = record.message as JsonRecord | undefined;
        if (source === undefined || typeof source.role !== 'string') continue;
        const uuid = namespacedEventId(sessionId, wire.agentId, source.id, line);
        const origin = source.origin as JsonRecord | undefined;
        const messageUuid = uuid;
        pushMessage({
          kind: 'message',
          uuid,
          session_id: sessionId,
          type: source.role,
          parent_uuid: previousUuid,
          timestamp,
          role: source.role,
          text: projectedMessageText(source),
          content_type: canonicalMessageContentType(source),
          is_meta: isMetaMessage(source) ? 1 : 0,
          visibility: 'visible',
          model,
          is_sidechain: wire.main ? 0 : 1,
          agent_id: agentDbId,
          input_tokens: null,
          output_tokens: null,
          cwd,
          skill: null,
          source: SOURCE,
        });
        if (origin?.kind === 'injection') injectionMessageUuids.add(messageUuid);
        if (isRealUserMessage(source)) realUserMessageUuids.add(messageUuid);
        if (Array.isArray(source.toolCalls)) {
          for (const call of source.toolCalls) {
            if (call === null || typeof call !== 'object' || typeof call.id !== 'string') continue;
            const fn = call.function as JsonRecord | undefined;
            const name = typeof fn?.name === 'string' ? fn.name : 'tool';
            let args: unknown = fn?.arguments ?? {};
            if (typeof args === 'string') {
              try { args = JSON.parse(args); } catch { args = { raw: args }; }
            }
            const toolId = namespacedToolId(sessionId, wire.agentId, call.id);
            toolCalls.push({
              kind: 'tool_call',
              id: toolId,
              message_uuid: messageUuid,
              session_id: sessionId,
              name,
              presentation: name === 'Skill' ? 'skill' : 'default',
              input_json: truncJson(args) ?? '{}',
              file_path: filePath(name, args as JsonRecord | undefined),
            });
            callMessageUuids.set(call.id, messageUuid);
          }
        }
        if (source.role === 'tool' && typeof source.toolCallId === 'string') {
          const toolId = namespacedToolId(sessionId, wire.agentId, source.toolCallId);
          toolResults.push({
            kind: 'tool_result',
            tool_use_id: toolId,
            message_uuid: messageUuid,
            session_id: sessionId,
            content: messageText(source.content) ?? '',
            file_path: null,
            is_error: source.isError === true ? 1 : 0,
          });
        }
        continue;
      }
      if (record.type === 'context.apply_compaction') {
        const content = typeof record.contextSummary === 'string'
          ? record.contextSummary
          : typeof record.summary === 'string'
            ? record.summary
            : messageText((record.summary as JsonRecord | undefined)?.content);
        if (content !== null) {
          summaries.push({
            kind: 'summary',
            id: namespacedEventId(sessionId, wire.agentId, undefined, line),
            session_id: sessionId,
            timestamp,
            source: 'compaction',
            content,
          });
        }
        undoFloor = messages.length;
        resetOpenState();
        continue;
      }
      if (record.type !== 'context.append_loop_event') continue;
      const event = record.event as JsonRecord | undefined;
      if (event === undefined || typeof event.type !== 'string') continue;
      if (event.type === 'step.begin' && typeof event.uuid === 'string') {
        stepStarts.set(event.uuid, typeof record.time === 'number' ? record.time : 0);
        continue;
      }
      if (event.type === 'content.part' && typeof event.stepUuid === 'string') {
        const part = event.part as JsonRecord | undefined;
        if (part === undefined) continue;
        const text = partText(part);
        if (text === null || text.trim().length === 0) continue;
        pushMessage({
          kind: 'message',
          uuid: namespacedEventId(sessionId, wire.agentId, event.uuid, line),
          session_id: sessionId,
          type: 'assistant',
          parent_uuid: previousUuid,
          timestamp,
          role: 'assistant',
          text,
          content_type: partContentType(part),
          is_meta: 0,
          visibility: 'visible',
          model,
          is_sidechain: wire.main ? 0 : 1,
          agent_id: agentDbId,
          input_tokens: null,
          output_tokens: null,
          cwd,
          skill: null,
          source: SOURCE,
        }, event.stepUuid);
        continue;
      }
      if (event.type === 'tool.call' && typeof event.stepUuid === 'string' && event.toolCallId !== undefined) {
        const uuid = namespacedEventId(sessionId, wire.agentId, event.uuid, line);
        const toolId = namespacedToolId(sessionId, wire.agentId, event.toolCallId);
        pushMessage({
          kind: 'message', uuid, session_id: sessionId, type: 'assistant', parent_uuid: previousUuid,
          timestamp, role: 'assistant', text: null, content_type: 'tool_use', is_meta: 0,
          visibility: 'visible', model,
          is_sidechain: wire.main ? 0 : 1, agent_id: agentDbId, input_tokens: null,
          output_tokens: null, cwd, skill: null, source: SOURCE,
        }, event.stepUuid);
        toolCalls.push({
          kind: 'tool_call',
          id: toolId,
          message_uuid: uuid,
          session_id: sessionId,
          name: String(event.name ?? 'tool'),
          presentation: event.name === 'Skill' ? 'skill' : 'default',
          input_json: truncJson(event.args ?? {}) ?? '{}',
          file_path: filePath(String(event.name ?? 'tool'), event.args as JsonRecord | undefined),
        });
        callMessageUuids.set(String(event.toolCallId), uuid);
        continue;
      }
      if (event.type === 'tool.result' && event.toolCallId !== undefined) {
        const nativeToolId = String(event.toolCallId);
        const result = event.result as JsonRecord | undefined;
        const output = result?.output;
        const content = typeof output === 'string' ? trunc(output) : truncJson(output ?? '') ?? '';
        const toolId = namespacedToolId(sessionId, wire.agentId, nativeToolId);
        toolResults.push({
          kind: 'tool_result',
          tool_use_id: toolId,
          message_uuid: callMessageUuids.get(nativeToolId) ?? '',
          session_id: sessionId,
          content,
          file_path: null,
          is_error: result?.isError === true ? 1 : 0,
        });
        const childId = typeof content === 'string' ? /^agent_id:\s*(\S+)/m.exec(content)?.[1] : undefined;
        if (childId !== undefined) childParentCalls.set(childId, toolId);
        continue;
      }
      if (event.type === 'step.end' && typeof event.uuid === 'string') {
        const step = stepMessages.get(event.uuid) ?? [];
        const last = step.at(-1);
        if (last !== undefined) {
          const usage = event.usage as JsonRecord | undefined;
          if (usage !== undefined) {
            last.input_tokens = inputUsage(usage);
            last.output_tokens = outputUsage(usage);
          }
          const started = stepStarts.get(event.uuid);
          if (started !== undefined && typeof record.time === 'number' && record.time >= started) {
            durations.push({ kind: 'message-turn-duration', uuid: last.uuid, turn_duration_ms: record.time - started });
          }
        }
      }
    }
  }

  const agents = state.agents as JsonRecord | undefined;
  const subagents: SubagentRecord[] = [];
  if (agents !== undefined) {
    for (const [agentId, candidate] of Object.entries(agents)) {
      if (agentId === 'main' || candidate === null || typeof candidate !== 'object') continue;
      const agent = candidate as JsonRecord;
      const labels = agent.labels as JsonRecord | undefined;
      subagents.push({
        kind: 'subagent',
        agent_id: namespacedAgentId(sessionId, agentId),
        session_id: sessionId,
        parent_tool_use_id: childParentCalls.get(agentId) ?? null,
        agent_type: typeof labels?.profile === 'string'
          ? labels.profile
          : typeof agent.type === 'string'
            ? agent.type
            : null,
        description: typeof agent.swarmItem === 'string' ? agent.swarmItem : null,
        duration_ms: null,
        total_tokens: null,
      });
    }
  }

  return {
    messages,
    toolCalls,
    toolResults,
    summaries,
    subagents,
    durations,
    mainMessageCount,
    mainWirePath: meta.wireFiles.find((wire) => wire.main)?.path ?? join(meta.sessionDir, 'wire.jsonl'),
  };
}

function sessionDirectories(
  rootDir: string,
  reportIssue?: (issue: InventoryIssue) => void,
): string[] {
  const sessionsDir = join(rootDir, 'sessions');
  if (!existsSync(sessionsDir)) return [];
  const result: string[] = [];
  let workspaces;
  try {
    workspaces = readdirSync(sessionsDir, { withFileTypes: true });
  } catch (error) {
    reportIssue?.(sourceInventoryIssue(sessionsDir, error));
    return result;
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const workspaceDir = join(sessionsDir, workspace.name);
    let sessions;
    try {
      sessions = readdirSync(workspaceDir, { withFileTypes: true });
    } catch (error) {
      reportIssue?.(sourceInventoryIssue(workspaceDir, error));
      continue;
    }
    for (const session of sessions) {
      if (session.isDirectory()) result.push(join(workspaceDir, session.name));
    }
  }
  return result.sort();
}

function changedSessionDirectories(rootDir: string, changedPaths: readonly string[]): Set<string> {
  const sessionsDir = join(rootDir, 'sessions');
  const result = new Set<string>();
  for (const changedPath of changedPaths) {
    const absolute = isAbsolute(changedPath)
      ? normalize(changedPath)
      : normalize(join(sessionsDir, changedPath));
    const inside = relative(sessionsDir, absolute);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) continue;
    const [workspaceId, sessionId] = inside.split(sep);
    if (workspaceId && sessionId) result.add(join(sessionsDir, workspaceId, sessionId));
  }
  return result;
}

function sessionDirectoryFromWirePath(wirePath: string): string {
  const parent = dirname(wirePath);
  return basename(parent) === 'main' && basename(dirname(parent)) === 'agents'
    ? dirname(dirname(parent))
    : parent;
}

function rawFromWire(path: string, messageUuid: string): RawRecord | null {
  if (!existsSync(path)) return null;
  const fallbackLine = /:line-(\d+)$/.exec(messageUuid)?.[1];
  const nativeId = messageUuid.split(':').at(-1);
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const line = fallbackLine !== undefined
    ? lines[Number(fallbackLine) - 1]
    : lines.find((candidate) => nativeId !== undefined && candidate.includes(nativeId));
  if (!line) return null;
  let projectedText: string | null = null;
  try {
    const record = JSON.parse(line) as JsonRecord;
    if (record.type === 'context.append_message') {
      const message = record.message as JsonRecord | undefined;
      if (message !== undefined) {
        const slashCommand = userSlashCommandText(message);
        if (slashCommand !== null) projectedText = slashCommand;
        else {
          const parts = contentParts(message.content).map((part) => {
            return rawPartText(part);
          }).filter((part): part is string => part !== null);
          projectedText = parts.length > 0 ? parts.join('\n') : null;
        }
      }
    } else if (record.type === 'context.append_loop_event') {
      const part = (record.event as JsonRecord | undefined)?.part as JsonRecord | undefined;
      if (part !== undefined) projectedText = rawPartText(part);
    }
  } catch { /* malformed torn source line */ }
  return {
    text: line,
    totalLength: line.length,
    offset: 0,
    limit: line.length,
    hasMore: false,
    messageText: projectedText,
  };
}

export function createKimiProvider({ rootDir = defaultKimiRoot() }: { rootDir?: string } = {}): ProviderAdapter {
  const name = SOURCE;
  return {
    name,
    descriptor: { id: name, name: 'Kimi Code', vendor: 'Moonshot AI', defaultRoot: rootDir, color: '#6d6afc' },
    indexVersionMarker: KIMI_CANONICAL_TRANSCRIPT_MARKER,
    sessionUnitKey: ({ jsonlPath }) => sessionDirectoryFromWirePath(jsonlPath),
    watchRoots: (configuredRoot) => [join(configuredRoot, 'sessions'), join(configuredRoot, 'session_index.jsonl')],
    discover(ctx: DiscoverContext): IndexUnit[] {
      const units: IndexUnit[] = [];
      const sessionsDir = join(rootDir, 'sessions');
      if (!existsSync(sessionsDir) && (ctx.indexedSessions?.().length ?? 0) > 0) {
        ctx.reportIncompleteInventory?.({ path: sessionsDir, error: 'Source folder is unavailable' });
      }
      const changedSessions = ctx.changedPaths === undefined
        ? null
        : changedSessionDirectories(rootDir, ctx.changedPaths);
      for (const sessionDir of sessionDirectories(rootDir, ctx.reportIncompleteInventory)) {
        if (changedSessions !== null && !changedSessions.has(sessionDir)) continue;
        const statePath = join(sessionDir, 'state.json');
        const wireFiles = listWireFiles(sessionDir);
        if (wireFiles.length === 0) continue;
        const currentCursor = cursorFor(statePath, wireFiles);
        if (changedSessions === null && ctx.lastCursor(sessionDir) === currentCursor) continue;
        const state = readState(statePath);
        const cwd = typeof state.cwd === 'string' ? state.cwd : typeof state.workDir === 'string' ? state.workDir : null;
        units.push({
          key: sessionDir,
          sessionId: namespacedSessionId(basename(sessionDir)),
          project: projectSlugFromPath(cwd) ?? undefined,
          meta: { kind: 'session', sessionDir, statePath, wireFiles, currentCursor } satisfies KimiSessionUnitMeta,
        });
      }
      return units;
    },
    *parse(unit: IndexUnit, _cursor: Cursor): Generator<TranscriptRecord, Cursor> {
      const meta = unit.meta as KimiSessionUnitMeta;
      const before = cursorFor(meta.statePath, meta.wireFiles);
      const state = readState(meta.statePath);
      const projected = projectSession(meta, unit.sessionId, state);
      const after = cursorFor(meta.statePath, meta.wireFiles);
      if (before !== after) throw new Error(`Kimi session changed while indexing: ${meta.sessionDir}`);

      yield { kind: 'delete-session', sessionId: unit.sessionId };
      // Kimi persists a titled session before the first prompt; keep it retracted until user evidence exists.
      const hasLastPrompt = typeof state.lastPrompt === 'string' && state.lastPrompt.length > 0;
      const hasProjectedUserPrompt = projected.messages.some((message) => (
        message.agent_id === null && message.role === 'user' && !message.is_meta
      ));
      if (state.title === 'New Session' && !hasLastPrompt && !hasProjectedUserPrompt) return after;
      yield {
        kind: 'session',
        id: unit.sessionId,
        title: typeof state.title === 'string'
          ? state.title
          : typeof state.lastPrompt === 'string'
            ? state.lastPrompt
            : null,
        project: unit.project ?? null,
        started_at: normalizeTime(state.createdAt),
        ended_at: normalizeTime(state.updatedAt),
        git_branch: null,
        version: null,
        message_count: projected.mainMessageCount,
        countMode: 'total',
        jsonl_path: projected.mainWirePath,
        source: SOURCE,
      };
      yield* projected.messages;
      yield* projected.toolCalls;
      yield* projected.toolResults;
      yield* projected.summaries;
      yield* projected.subagents;
      yield* projected.durations;
      return after;
    },
    raw(input: RawLookup): RawRecord | null {
      const mainPath = typeof input.session?.jsonl_path === 'string' ? input.session.jsonl_path : null;
      if (mainPath === null) return null;
      if (input.agentId === null) return rawFromWire(mainPath, input.messageUuid);
      const rawAgentId = input.agentId.split(':').at(-1);
      if (rawAgentId === undefined) return null;
      const sessionDir = sessionDirectoryFromWirePath(mainPath);
      return rawFromWire(join(sessionDir, 'agents', rawAgentId, 'wire.jsonl'), input.messageUuid);
    },
  };
}

export const kimiProvider = createKimiProvider();
