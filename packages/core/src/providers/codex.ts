// Codex provider adapter in Core (see docs/adr/0001).
//
// Pure: discovers Codex rollout files and parses one into a record stream. It
// never touches the Obelisk database. Unlike claude, codex is a FULL-REPARSE
// adapter: it makes a cheap first pass for compact deduplication keys, then a
// projection pass that re-emits every canonical record. Raw JSON objects are
// never retained for the whole file. Hence the session record uses countMode
// 'total' (persist replaces the count, never accumulates).

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, relative } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import {
  trunc, truncJson, iterateLineSegments, readLines,
  discoverCodexJsonlFiles, normalizeObservedCwd, projectSlugFromPath,
  codexRawId, codexDbId, codexCallId, codexLineUuid, codexParentThreadId,
  codexAgentNickname, codexAgentRole, codexUsage,
  codexEventText, codexMessagePayloadText, codexVisibleMessageKey,
  codexToolInput, codexToolOutput,
  extractMessageIsMeta, isSkillInstructions,
} from '../parsing.ts';
import type { LineReadOptions } from '../parsing.ts';

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
const CODEX_CANONICAL_TRANSCRIPT_MARKER = '__codex_canonical_transcript_v2__';

const HIDDEN_CONTEXT_ENVELOPE_RE = /^\s*<(environment_context|codex_internal_context)\b[^>]*>[\s\S]*<\/\1>\s*$/;

function messageVisibility(role: string, text: string | null): 'visible' | 'hidden' {
  return role === 'user' && typeof text === 'string' && HIDDEN_CONTEXT_ENVELOPE_RE.test(text)
    ? 'hidden'
    : 'visible';
}

type SelectedJsonValue =
  | { kind: 'string'; value: string }
  | { kind: 'object'; start: number };

function skipJsonWhitespace(line: Buffer, start: number): number {
  let index = start;
  while (index < line.length) {
    const byte = line[index]!;
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) break;
    index++;
  }
  return index;
}

function jsonStringEnd(line: Buffer, quote: number): number | null {
  for (let index = quote + 1; index < line.length; index++) {
    const byte = line[index]!;
    if (byte === 0x5c) {
      index++;
      continue;
    }
    if (byte === 0x22) return index;
  }
  return null;
}

function decodeJsonString(line: Buffer, quote: number, end: number): string | null {
  try {
    const value = JSON.parse(line.toString('utf8', quote, end + 1));
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

function selectedJsonValue(line: Buffer, start: number): SelectedJsonValue | null {
  if (start >= line.length) return null;
  const byte = line[start]!;
  if (byte === 0x22) {
    const end = jsonStringEnd(line, start);
    if (end === null) return null;
    const value = decodeJsonString(line, start, end);
    return value === null ? null : { kind: 'string', value };
  }
  if (byte === 0x7b) return { kind: 'object', start };
  return null;
}

/**
 * Extract selected immediate children from one JSON object without decoding or
 * materializing unrelated nested values. `required` allows callers to stop as
 * soon as envelope fields are known; omit it to scan the complete object.
 */
function selectJsonObjectFields(
  line: Buffer,
  objectStart: number,
  wanted: ReadonlySet<string>,
  required?: ReadonlySet<string>,
): Map<string, SelectedJsonValue> {
  const selected = new Map<string, SelectedJsonValue>();
  const remaining = required === undefined ? null : new Set(required);
  let depth = 0;

  for (let index = objectStart; index < line.length; index++) {
    const byte = line[index]!;
    if (byte === 0x22) {
      const end = jsonStringEnd(line, index);
      if (end === null) return selected;
      if (depth === 1) {
        const colon = skipJsonWhitespace(line, end + 1);
        if (line[colon] === 0x3a) {
          const key = decodeJsonString(line, index, end);
          if (key !== null && wanted.has(key)) {
            const valueStart = skipJsonWhitespace(line, colon + 1);
            const value = selectedJsonValue(line, valueStart);
            if (value !== null) selected.set(key, value);
            remaining?.delete(key);
            if (remaining?.size === 0) return selected;
          }
        }
      }
      index = end;
      continue;
    }
    if (byte === 0x7b || byte === 0x5b) depth++;
    else if (byte === 0x7d || byte === 0x5d) {
      depth--;
      if (depth === 0) return selected;
    }
  }
  return selected;
}

function jsonObjectStart(line: Buffer): number | null {
  const start = skipJsonWhitespace(line, 0);
  return line[start] === 0x7b ? start : null;
}

function codexEnvelopeType(line: Buffer): string | null {
  const objectStart = jsonObjectStart(line);
  if (objectStart === null) return null;
  const fields = selectJsonObjectFields(line, objectStart, new Set(['type']), new Set(['type']));
  const type = fields.get('type');
  return type?.kind === 'string' ? type.value : null;
}

function codexPayloadStringField(line: Buffer, name: string): string | null {
  const objectStart = jsonObjectStart(line);
  if (objectStart === null) return null;
  const outer = selectJsonObjectFields(
    line,
    objectStart,
    new Set(['payload']),
    new Set(['payload']),
  );
  const payload = outer.get('payload');
  if (payload?.kind !== 'object') return null;
  const fields = selectJsonObjectFields(
    line,
    payload.start,
    new Set([name]),
    new Set([name]),
  );
  return fieldString(fields, name);
}

function parseOrdinaryCodexLine(line: string): any | null {
  try { return JSON.parse(line); } catch { return null; }
}

interface CodexFileInspection {
  metaRecord: { lineNum: number; obj: any } | null;
  guardian: boolean;
}

function inspectCodexFile(filePath: string): CodexFileInspection {
  let metaRecord: CodexFileInspection['metaRecord'] = null;
  let sawAutoReview = false;
  for (const source of iterateCodexSourceLines(filePath)) {
    if (source.line === null) continue;
    const obj = parseOrdinaryCodexLine(source.line);
    if (obj === null) continue;
    if (obj?.payload?.model === 'codex-auto-review' || obj?.model === 'codex-auto-review') sawAutoReview = true;
    if (obj?.type === 'session_meta' && obj.payload?.id) {
      // Match the legacy discovery helper exactly: later metadata replaces the
      // candidate only while a legacy subagent scan is still in progress.
      metaRecord = { lineNum: source.lineNumber, obj };
      if (obj.payload?.source?.subagent?.other === 'guardian') break;
      if (obj.payload?.thread_source !== 'subagent') break;
    }
    const meta = metaRecord?.obj?.payload;
    if (meta && (
      meta.source?.subagent?.other === 'guardian'
      || (meta.thread_source === 'subagent' && sawAutoReview)
    )) break;
  }
  const capturedMeta = metaRecord as CodexFileInspection['metaRecord'];
  const meta = capturedMeta?.obj?.payload;
  const guardian = Boolean(meta && (
    meta.source?.subagent?.other === 'guardian'
    || (meta.thread_source === 'subagent' && sawAutoReview)
  ));
  return { metaRecord: capturedMeta, guardian };
}

interface CodexFirstPass extends CodexFileInspection {
  lineCount: number;
  eventMessageKeys: Set<string>;
  tokenUsageByLine: Map<number, { inputTokens: number | null; outputTokens: number | null }>;
}

type CodexAnnotationEvent =
  | { kind: 'assistant'; lineNum: number; duplicateKey: string | null }
  | { kind: 'usage'; inputTokens: number | null; outputTokens: number | null };

function scanCodexFirstPass(filePath: string, options: LineReadOptions = {}): CodexFirstPass {
  let metaRecord: CodexFileInspection['metaRecord'] = null;
  let sawAutoReview = false;
  let lineCount = 0;
  const eventMessageKeys = new Set<string>();
  const annotationEvents: CodexAnnotationEvent[] = [];

  for (const source of iterateCodexSourceLines(filePath, options)) {
    lineCount = source.lineNumber;
    if (source.line === null) continue;
    if (source.envelopeType === 'response_item'
      && source.payloadType !== null
      && source.payloadType !== 'message') continue;
    if (!['session_meta', 'turn_context', 'event_msg', 'response_item'].includes(source.envelopeType || '')) continue;
    const obj = parseOrdinaryCodexLine(source.line);
    if (obj === null) continue;
    if (obj?.payload?.model === 'codex-auto-review' || obj?.model === 'codex-auto-review') sawAutoReview = true;
    if (metaRecord === null && obj?.type === 'session_meta' && obj.payload?.id) {
      metaRecord = { lineNum: lineCount, obj };
    }
    if (obj?.type === 'event_msg') {
      const payload = obj.payload || {};
      if (payload.type === 'user_message' || payload.type === 'agent_message') {
        const text = codexEventText(payload);
        if (text !== null) {
          const role = payload.type === 'user_message' ? 'user' : 'assistant';
          eventMessageKeys.add(codexVisibleMessageKey(role, text));
          if (role === 'assistant') annotationEvents.push({ kind: 'assistant', lineNum: lineCount, duplicateKey: null });
        }
      } else if (payload.type === 'token_count') {
        const usage = codexUsage(payload);
        annotationEvents.push({ kind: 'usage', ...usage });
      }
      continue;
    }
    if (obj?.type === 'response_item') {
      const payload = obj.payload || {};
      if (payload.type !== 'message' || payload.role === 'developer') continue;
      const text = codexMessagePayloadText(payload);
      const role = payload.role || 'assistant';
      if (role === 'assistant' && text !== null) {
        annotationEvents.push({
          kind: 'assistant',
          lineNum: lineCount,
          duplicateKey: codexVisibleMessageKey(role, text),
        });
      }
    }
  }

  const tokenUsageByLine = new Map<number, { inputTokens: number | null; outputTokens: number | null }>();
  let lastTextAssistantLine: number | null = null;
  for (const event of annotationEvents) {
    if (event.kind === 'assistant') {
      if (event.duplicateKey !== null && eventMessageKeys.has(event.duplicateKey)) continue;
      lastTextAssistantLine = event.lineNum;
      continue;
    }
    if (lastTextAssistantLine !== null && (event.inputTokens !== null || event.outputTokens !== null)) {
      tokenUsageByLine.set(lastTextAssistantLine, {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
      });
    }
  }

  const meta = metaRecord?.obj?.payload;
  const guardian = Boolean(meta && (
    meta.source?.subagent?.other === 'guardian'
    || (meta.thread_source === 'subagent' && sawAutoReview)
  ));
  return { metaRecord, guardian, lineCount, eventMessageKeys, tokenUsageByLine };
}

const CODEX_ENVELOPE_PROBE_LIMIT = 256 * 1024;

function fieldString(fields: ReadonlyMap<string, SelectedJsonValue>, name: string): string | null {
  const field = fields.get(name);
  return field?.kind === 'string' ? field.value : null;
}

interface CodexSourceLine {
  lineNumber: number;
  envelopeType: string | null;
  payloadType: string | null;
  line: string | null;
}

type CodexLineMode = 'unknown' | 'ordinary' | 'skip';

/**
 * Classify each Codex envelope from its small prefix. Records that the legacy
 * adapter parses but never emits are skipped without assembling their payload.
 * Every ordinary record is still decoded by the same helpers as upstream.
 */
function* iterateCodexSourceLines(
  filePath: string,
  options: LineReadOptions = {},
): Generator<CodexSourceLine> {
  let lineNumber = 0;
  let mode: CodexLineMode = 'unknown';
  let envelopeType: string | null = null;
  let payloadType: string | null = null;
  let probeFragments: Buffer[] = [];
  let probeBytes = 0;
  let textFragments: string[] = [];
  let decoder = new StringDecoder('utf8');

  const reset = () => {
    mode = 'unknown';
    envelopeType = null;
    payloadType = null;
    probeFragments = [];
    probeBytes = 0;
    textFragments = [];
    decoder = new StringDecoder('utf8');
  };

  for (const segment of iterateLineSegments(filePath, options)) {
    if (segment.lineStart) {
      lineNumber++;
      reset();
    }

    if (mode !== 'skip') textFragments.push(decoder.write(segment.bytes));

    if (mode === 'unknown') {
      const probe = probeFragments.length === 0
        ? segment.bytes
        : Buffer.concat([...probeFragments, segment.bytes], probeBytes + segment.bytes.length);
      const classified = codexEnvelopeType(probe);
      if (classified !== null) {
        envelopeType = classified;
        payloadType = classified === 'response_item'
          ? codexPayloadStringField(probe, 'type')
          : null;
        if (classified === 'compacted' || classified === 'world_state') {
          mode = 'skip';
          textFragments = [];
        } else {
          mode = 'ordinary';
        }
        probeFragments = [];
        probeBytes = 0;
      } else if (segment.lineEnd) {
        mode = 'ordinary';
      } else {
        const copy = Buffer.allocUnsafe(segment.bytes.length);
        segment.bytes.copy(copy);
        probeFragments.push(copy);
        probeBytes += copy.length;
        if (probeBytes >= CODEX_ENVELOPE_PROBE_LIMIT) {
          mode = 'ordinary';
          probeFragments = [];
          probeBytes = 0;
        }
      }
    }

    if (!segment.lineEnd) continue;
    if (mode === 'ordinary') {
      const tail = decoder.end();
      if (tail) textFragments.push(tail);
      const line = textFragments.join('');
      if (envelopeType === null) {
        const parsed = parseOrdinaryCodexLine(line);
        envelopeType = typeof parsed?.type === 'string' ? parsed.type : null;
        payloadType = typeof parsed?.payload?.type === 'string' ? parsed.payload.type : null;
      }
      if (envelopeType === 'compacted' || envelopeType === 'world_state') {
        yield { lineNumber, envelopeType, payloadType, line: null };
        continue;
      }
      yield {
        lineNumber,
        envelopeType,
        payloadType,
        line,
      };
    } else if (mode === 'skip') {
      yield { lineNumber, envelopeType, payloadType, line: null };
    }
  }
}

function discoverAt(rootDir: string, ctx: DiscoverContext): IndexUnit[] {
  const sessionsDir = join(rootDir, 'sessions');
  const sessionIndexPath = normalize(join(rootDir, 'session_index.jsonl'));
  const sessionIndex = new Map<string, { title: string; updatedAt: string | null }>();
  if (existsSync(sessionIndexPath)) {
    readLines(sessionIndexPath, (line: string) => {
      try {
        const item = JSON.parse(line);
        if (item?.id && item?.thread_name) {
          sessionIndex.set(codexRawId(item.id) as string, {
            title: item.thread_name,
            updatedAt: item.updated_at || null,
          });
        }
      } catch { /* malformed session-index entry */ }
    });
  }
  const changedFiles = new Set<string>();
  let sessionIndexChanged = false;
  for (const changedPath of ctx.changedPaths ?? []) {
    const rootRelative = isAbsolute(changedPath)
      ? normalize(changedPath)
      : normalize(join(rootDir, changedPath));
    if (rootRelative === sessionIndexPath) sessionIndexChanged = true;
    const absolute = isAbsolute(changedPath)
      ? normalize(changedPath)
      : normalize(join(sessionsDir, changedPath));
    const inside = relative(sessionsDir, absolute);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) continue;
    if (absolute.toLowerCase().endsWith('.jsonl')) changedFiles.add(absolute);
  }
  return discoverCodexJsonlFiles(sessionsDir).flatMap((file) => {
    if (ctx.changedPaths !== undefined && !sessionIndexChanged && !changedFiles.has(normalize(file.path))) return [];
    const cursor = ctx.lastCursor(file.path);
    const inspection = inspectCodexFile(file.path);
    if (!sessionIndexChanged && cursor !== null && Number(cursor.split(':')[0]) >= statSync(file.path).mtimeMs && !inspection.guardian) {
      return [];
    }
    const meta = inspection.metaRecord?.obj?.payload ?? null;
    const rawId = meta ? codexRawId(meta.id) : null;
    const parentId = meta ? codexParentThreadId(meta) : null;
    const indexed = rawId ? sessionIndex.get(rawId) : undefined;
    return [{
      key: file.path,
      sessionId: inspection.guardian ? '' : codexDbId(parentId || rawId) ?? '',
      meta: {
        source: 'codex',
        guardian: inspection.guardian,
        indexedTitle: indexed?.title,
        indexedUpdatedAt: indexed?.updatedAt,
      },
    }];
  });
}

export function discover(ctx: DiscoverContext): IndexUnit[] {
  return discoverAt(join(homedir(), '.codex'), ctx);
}

export function* parse(unit: IndexUnit, _cursor: Cursor): Generator<TranscriptRecord, Cursor> {
  const snapshot = statSync(unit.key);
  const sourceOptions: LineReadOptions = {
    maxBytes: snapshot.size,
    expectedFile: {
      dev: snapshot.dev,
      ino: snapshot.ino,
      minBytes: snapshot.size,
    },
  };
  const firstPass = scanCodexFirstPass(unit.key, sourceOptions);
  const outCursor = `${snapshot.mtimeMs}:${firstPass.lineCount}`;
  const metaRecord = firstPass.metaRecord;
  if (!metaRecord) return outCursor;

  const meta = metaRecord.obj.payload;
  const threadRawId = codexRawId(meta.id) as string;
  if (firstPass.guardian) {
    yield { kind: 'delete-session', sessionId: codexDbId(threadRawId) as string };
    return outCursor;
  }

  const parentRawId = codexParentThreadId(meta);
  const sessionId = codexDbId(parentRawId || threadRawId) as string;
  const agentId = (parentRawId ? codexDbId(threadRawId) : null) as string | null;
  const isSidechain: 0 | 1 = agentId ? 1 : 0;
  const project = projectSlugFromPath(normalizeObservedCwd(meta.cwd));
  const lineUuid = (n: number): string => codexLineUuid(threadRawId, n) as string;

  const indexedMeta = unit.meta as { indexedTitle?: string; indexedUpdatedAt?: string | null } | undefined;
  const initialTimestamp = (meta.timestamp || metaRecord.obj.timestamp || null) as string | null;
  const indexedUpdatedAt = indexedMeta?.indexedUpdatedAt ?? null;
  const sm = {
    started_at: initialTimestamp,
    ended_at: indexedUpdatedAt && (!initialTimestamp || indexedUpdatedAt > initialTimestamp)
      ? indexedUpdatedAt
      : initialTimestamp,
    git_branch: (meta.git?.branch || null) as string | null,
    version: (meta.cli_version || null) as string | null,
    title: indexedMeta?.indexedTitle ?? null,
    n: 0,
    lastMessageUuid: null as string | null,
    lastTextAssistantUuid: null as string | null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  };

  let currentCwd = normalizeObservedCwd(meta.cwd);
  let currentModel: string | null = null;
  const eventMessageKeys = firstPass.eventMessageKeys;
  const callMessageUuids = new Map<string, string>();

  const updateBounds = (ts: string | null) => {
    if (!ts) return;
    if (!sm.started_at || ts < sm.started_at) sm.started_at = ts;
    if (!sm.ended_at || ts > sm.ended_at) sm.ended_at = ts;
  };

  const createMessage = ({ uuid, type, role, text = null, contentType = 'text', timestamp, sourceLine, isMeta = 0 }: {
    uuid: string; type: string; role: string; text?: string | null; contentType?: string; timestamp: string | null; sourceLine: number; isMeta?: 0 | 1;
  }) => {
    const visibility = messageVisibility(role, text);
    const skillInstructions = role === 'user' && isSkillInstructions(text);
    const usage = role === 'assistant' && contentType === 'text'
      ? firstPass.tokenUsageByLine.get(sourceLine)
      : undefined;
    const rec: MessageRecord = {
      kind: 'message', uuid, session_id: sessionId, type, parent_uuid: sm.lastMessageUuid,
      timestamp: timestamp || null, role, text: trunc(text),
      content_type: skillInstructions ? 'skill_instructions' : contentType,
      is_meta: visibility === 'hidden' || skillInstructions ? 1 : (isMeta || extractMessageIsMeta({}, text)), visibility,
      model: currentModel, is_sidechain: isSidechain, agent_id: agentId,
      input_tokens: usage?.inputTokens ?? null, output_tokens: usage?.outputTokens ?? null,
      cwd: currentCwd, skill: null, source: 'codex',
    };
    sm.lastMessageUuid = uuid;
    if (!agentId) sm.n++;
    if (type === 'assistant' && contentType === 'text') sm.lastTextAssistantUuid = uuid;
    updateBounds(timestamp);
    return rec;
  };

  for (const source of iterateCodexSourceLines(unit.key, sourceOptions)) {
    const currentLine = source.lineNumber;
    const envelopeType = source.envelopeType;
    if (envelopeType === 'compacted' || envelopeType === 'world_state') continue;
    if (source.line === null) continue;
    let obj: any;
    try { obj = JSON.parse(source.line); } catch { continue; }
    const ts = obj.timestamp || null;
    if (obj.type === 'session_meta') {
      if (obj.payload?.cwd) currentCwd = normalizeObservedCwd(obj.payload.cwd) || currentCwd;
      if (obj.payload?.git?.branch) sm.git_branch = obj.payload.git.branch;
      if (obj.payload?.cli_version) sm.version = obj.payload.cli_version;
      updateBounds(obj.payload?.timestamp || ts);
      continue;
    }
    if (obj.type === 'turn_context') {
      currentCwd = normalizeObservedCwd(obj.payload?.cwd) || currentCwd;
      currentModel = obj.payload?.model || currentModel;
      updateBounds(ts);
      continue;
    }
    if (obj.type === 'event_msg') {
      const payload = obj.payload || {};
      if (payload.type === 'user_message' || payload.type === 'agent_message' || payload.type === 'agent_reasoning') {
        const text = codexEventText(payload);
        if (text === null) continue;
        const isReasoning = payload.type === 'agent_reasoning';
        yield createMessage({
          uuid: lineUuid(currentLine),
          type: payload.type === 'user_message' ? 'user' : 'assistant',
          role: payload.type === 'user_message' ? 'user' : 'assistant',
          text, contentType: isReasoning ? 'thinking' : 'text', timestamp: ts, sourceLine: currentLine,
        });
        continue;
      }
      if (payload.type === 'collab_agent_spawn_end' && payload.call_id && payload.new_thread_id) {
        const message = createMessage({ uuid: lineUuid(currentLine), type: 'assistant', role: 'assistant', text: null, contentType: 'tool_use', timestamp: ts, sourceLine: currentLine });
        yield message;
        const uuid = message.uuid;
        const toolId = codexCallId(threadRawId, payload.call_id) as string;
        const description = payload.new_agent_nickname || payload.new_agent_role || 'Agent';
        const input = {
          description, subagent_type: payload.new_agent_role || 'Agent', prompt: payload.prompt || '',
          new_thread_id: payload.new_thread_id, model: payload.model || null, reasoning_effort: payload.reasoning_effort || null,
        };
        yield { kind: 'tool_call', id: toolId, message_uuid: uuid, session_id: sessionId, name: 'Agent', presentation: 'default', input_json: truncJson(input) as string, file_path: null };
        callMessageUuids.set(toolId, uuid);
        yield { kind: 'subagent', agent_id: codexDbId(payload.new_thread_id) as string, session_id: sessionId, parent_tool_use_id: toolId, agent_type: payload.new_agent_role || null, description };
        continue;
      }
      if (payload.type === 'task_complete') {
        if (sm.lastTextAssistantUuid && payload.duration_ms !== undefined) {
          yield { kind: 'message-turn-duration', uuid: sm.lastTextAssistantUuid, turn_duration_ms: payload.duration_ms || null };
        }
        updateBounds(ts);
        continue;
      }
      if (payload.type === 'token_count') {
        const usage = codexUsage(payload);
        if (usage.inputTokens != null) sm.totalInputTokens = usage.inputTokens;
        if (usage.outputTokens != null) sm.totalOutputTokens = usage.outputTokens;
        continue;
      }
      if (payload.type === 'thread_name_updated' && payload.thread_name) sm.title = payload.thread_name;
      continue;
    }
    if (obj.type !== 'response_item') continue;
    const payload = obj.payload || {};
    if (payload.type === 'message' && payload.role !== 'developer') {
      const text = codexMessagePayloadText(payload);
      const role = payload.role || 'assistant';
      if (text !== null && !eventMessageKeys.has(codexVisibleMessageKey(role, text))) {
        yield createMessage({ uuid: lineUuid(currentLine), type: role === 'user' ? 'user' : 'assistant', role, text, contentType: 'text', timestamp: ts, sourceLine: currentLine });
      }
      continue;
    }
    if (['function_call', 'custom_tool_call', 'tool_search_call', 'web_search_call'].includes(payload.type) && payload.call_id) {
      const message = createMessage({ uuid: lineUuid(currentLine), type: 'assistant', role: 'assistant', text: null, contentType: 'tool_use', timestamp: ts, sourceLine: currentLine });
      yield message;
      const uuid = message.uuid;
      const name = payload.name || payload.tool || payload.type.replace(/_call$/, '');
      const toolId = codexCallId(threadRawId, payload.call_id) as string;
      yield { kind: 'tool_call', id: toolId, message_uuid: uuid, session_id: sessionId, name, presentation: name === 'Skill' ? 'skill' : 'default', input_json: truncJson(codexToolInput(payload)) as string, file_path: null };
      callMessageUuids.set(toolId, uuid);
      continue;
    }
    if (['function_call_output', 'custom_tool_call_output', 'tool_search_output'].includes(payload.type) && payload.call_id) {
      const toolId = codexCallId(threadRawId, payload.call_id) as string;
      yield { kind: 'tool_result', tool_use_id: toolId, message_uuid: callMessageUuids.get(toolId) || '', session_id: sessionId, content: trunc(codexToolOutput(payload) || ''), file_path: null, is_error: payload.is_error ? 1 : 0 };
    }
  }

  if (agentId) {
    const started = sm.started_at ? new Date(sm.started_at).getTime() : null;
    const ended = sm.ended_at ? new Date(sm.ended_at).getTime() : null;
    const tokenTotal = (sm.totalInputTokens || 0) + (sm.totalOutputTokens || 0);
    yield {
      kind: 'subagent', agent_id: agentId, session_id: sessionId,
      agent_type: codexAgentRole(meta), description: codexAgentNickname(meta),
      duration_ms: started && ended ? ended - started : null, total_tokens: tokenTotal || null,
    };
  } else {
    yield {
      kind: 'session', id: sessionId, title: sm.title, project,
      started_at: sm.started_at, ended_at: sm.ended_at, git_branch: sm.git_branch, version: sm.version,
      message_count: sm.n, countMode: 'total', jsonl_path: unit.key, source: 'codex',
    };
  }
  return outCursor;
}

function findCodexFile(rootDir: string, rawThreadId: string): string | null {
  const stack = [join(rootDir, 'sessions')];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (!existsSync(current)) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && entry.name.endsWith(`${rawThreadId}.jsonl`)) return path;
    }
  }
  return null;
}

function rawCodex(rootDir: string, input: RawLookup): RawRecord | null {
  const match = /^codex:([^:]+):(\d+)$/.exec(input.messageUuid);
  if (match === null) return null;
  const path = input.agentId === null && typeof input.session?.jsonl_path === 'string'
    ? input.session.jsonl_path
    : findCodexFile(rootDir, match[1]!);
  if (path === null || !existsSync(path)) return null;
  let lineNumber = 0;
  let found: string | null = null;
  readLines(path, (line: string) => {
    lineNumber++;
    if (lineNumber !== Number(match[2])) return;
    found = line;
    return false;
  });
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

export function createCodexProvider({ rootDir = join(homedir(), '.codex') }: { rootDir?: string } = {}): ProviderAdapter {
  return {
    name,
    descriptor: { id: name, name: 'Codex', vendor: 'OpenAI', defaultRoot: rootDir, color: '#10a37f' },
    indexVersionMarker: CODEX_CANONICAL_TRANSCRIPT_MARKER,
    watchRoots: (configuredRoot) => [join(configuredRoot, 'sessions'), join(configuredRoot, 'session_index.jsonl')],
    discover: (ctx) => discoverAt(rootDir, ctx),
    parse,
    raw: (input) => rawCodex(rootDir, input),
  };
}

export const codexProvider = createCodexProvider();
