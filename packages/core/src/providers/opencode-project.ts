// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import { normalizeObservedCwd, projectSlugFromPath, trunc, truncJson } from '../parsing.ts';
import type { SqliteDb } from '../sqlite-types.ts';
import type { IndexUnit, MessageRecord, MessageVisibility, SessionRecord, SubagentRecord, SummaryRecord, TranscriptRecord } from './types.ts';
import type { SessionRow, SessionMessageRow, MessageRow, PartRow } from './opencode-source.ts';
import { isRecord, transcriptObject, modernMessageData, legacyMessageData, legacyPartData, str, parseModelRef, completedCompaction } from './opencode-decode.ts';
import { opencodeSessionId } from './opencode-identity.ts';

const name = 'opencode';

const timestampOfMs = (time: number | null | undefined): string | null => (
  typeof time === 'number' && Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : null
);

interface RevertInfo {
  messageID: string | null;
  partID: string | null;
}

function parseRevert(revert: string | null): RevertInfo | null {
  if (revert === null) return null;
  const value = transcriptObject(revert, 'session revert');
  if (typeof value.messageID !== 'string'
    || (value.partID !== undefined && value.partID !== null && typeof value.partID !== 'string')) {
    throw new Error('opencode: invalid revert payload');
  }
  return {
    messageID: str(value.messageID),
    partID: str(value.partID),
  };
}

export function fingerprintSession(
  format: 'v1' | 'v2',
  session: SessionRow,
  isSubagent: boolean,
  v2Messages?: readonly SessionMessageRow[],
  v1Messages?: readonly MessageRow[],
  v1Parts?: readonly PartRow[],
): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([
    format,
    session.id,
    session.parent_id,
    session.directory,
    session.title,
    session.version,
    session.revert,
    session.time_created,
    session.time_updated,
    session.time_archived,
    session.agent,
    session.model,
    isSubagent,
  ]));
  if (format === 'v2' && v2Messages) {
    for (const m of v2Messages) {
      hash.update(`\nm2${JSON.stringify([m.id, m.type, m.seq, m.time_created, m.time_updated, m.data])}`);
    }
  } else if (format === 'v1' && v1Messages && v1Parts) {
    for (const m of v1Messages) {
      hash.update(`\nm1${JSON.stringify([m.id, m.time_created, m.time_updated, m.data])}`);
    }
    for (const p of v1Parts) {
      hash.update(`\np1${JSON.stringify([p.id, p.message_id, p.time_created, p.time_updated, p.data])}`);
    }
  }
  return hash.digest('hex').slice(0, 24);
}

const FILE_TOOLS = new Set(['read', 'edit', 'write', 'apply_patch', 'patch']);

function toolFilePath(toolName: string, input: unknown): string | null {
  if (isRecord(input) && FILE_TOOLS.has(toolName.toLowerCase())) {
    if (typeof input.path === 'string' && input.path.length > 0) return input.path;
    if (typeof input.filePath === 'string' && input.filePath.length > 0) return input.filePath;
  }
  return null;
}

function v2UsageTokens(tokens: unknown): { input: number | null; output: number | null } {
  if (!isRecord(tokens)) return { input: null, output: null };
  const rawInput = tokens.input;
  const rawOutput = tokens.output;
  const rawReasoning = tokens.reasoning;
  const cache = isRecord(tokens.cache) ? tokens.cache : {};
  const cacheRead = typeof cache.read === 'number' && Number.isFinite(cache.read) ? cache.read : 0;
  const cacheWrite = typeof cache.write === 'number' && Number.isFinite(cache.write) ? cache.write : 0;

  let input: number | null = null;
  if (typeof rawInput === 'number' && Number.isFinite(rawInput)) {
    input = rawInput + cacheRead + cacheWrite;
  }
  let output: number | null = null;
  if (typeof rawOutput === 'number' && Number.isFinite(rawOutput)) {
    const reasoning = typeof rawReasoning === 'number' && Number.isFinite(rawReasoning) ? rawReasoning : 0;
    output = rawOutput + reasoning;
  }
  return { input, output };
}

function v1StepUsageTokens(tokens: unknown): { input: number | null; output: number | null } {
  if (!isRecord(tokens)) return { input: null, output: null };
  const rawInput = tokens.input;
  const rawOutput = tokens.output;
  const rawReasoning = tokens.reasoning;
  const cache = isRecord(tokens.cache) ? tokens.cache : {};
  const cacheRead = typeof cache.read === 'number' && Number.isFinite(cache.read) ? cache.read : 0;
  const cacheWrite = typeof cache.write === 'number' && Number.isFinite(cache.write) ? cache.write : 0;

  let input: number | null = null;
  if (typeof rawInput === 'number' && Number.isFinite(rawInput)) {
    input = rawInput + cacheRead + cacheWrite;
  }
  let output: number | null = null;
  if (typeof rawOutput === 'number' && Number.isFinite(rawOutput)) {
    const reasoning = typeof rawReasoning === 'number' && Number.isFinite(rawReasoning) ? rawReasoning : 0;
    output = rawOutput + reasoning;
  }
  return { input, output };
}

export function* parseV2(
  unit: IndexUnit,
  meta: { dbPath: string; rawSessionId: string },
  db: SqliteDb,
  session: SessionRow,
): Generator<TranscriptRecord, string> {
  const sessionId = unit.sessionId;
  const isSubagent = unit.isSubagent === true;

  const messages = db.prepare(
    'SELECT id, session_id, type, seq, time_created, time_updated, data FROM session_message WHERE session_id = ? ORDER BY seq, time_created, id',
  ).all(meta.rawSessionId) as unknown as SessionMessageRow[];

  const fingerprint = fingerprintSession('v2', session, isSubagent, messages);
  const revert = parseRevert(session.revert);

  let activeCutIndex = -1;
  if (revert?.messageID) {
    activeCutIndex = messages.findIndex(m => m.id === revert.messageID);
  }

  const startedAt = timestampOfMs(session.time_created);
  let endedAt: string | null = null;
  const gitBranch: string | null = null;
  let visibleCount = 0;
  let previousMessageUuid: string | null = null;
  const records: TranscriptRecord[] = [];

  for (let mIdx = 0; mIdx < messages.length; mIdx++) {
    const m = messages[mIdx]!;
    const isMessageActive = activeCutIndex === -1 || mIdx < activeCutIndex;
    const baseVisibility: MessageVisibility = isMessageActive ? 'visible' : 'inactive';
    const messageTimestamp = timestampOfMs(m.time_created);
    const data = modernMessageData(m);

    if (isMessageActive && m.time_updated) {
      const updatedTime = timestampOfMs(m.time_updated);
      if (updatedTime !== null && (endedAt === null || updatedTime > endedAt)) {
        endedAt = updatedTime;
      }
    }

    if (m.type === 'compaction') {
      const summaryText = completedCompaction(data);
      if (summaryText !== null) {
        const usage = v2UsageTokens(data.tokens);
        records.push({
          kind: 'summary',
          id: `${sessionId}:summary:${encodeURIComponent(m.id)}`,
          session_id: sessionId,
          timestamp: messageTimestamp,
          source: name,
          content: trunc(summaryText),
          visibility: baseVisibility,
          input_tokens: usage.input,
          output_tokens: usage.output,
        } satisfies SummaryRecord);
      } else {
        const usage = v2UsageTokens(data.tokens);
        if (usage.input !== null || usage.output !== null) {
          const uuid = `${sessionId}:m:${String(m.seq).padStart(6, '0')}:${encodeURIComponent(m.id)}:msg`;
          records.push({
            kind: 'message',
            uuid,
            session_id: sessionId,
            type: 'system',
            parent_uuid: previousMessageUuid,
            timestamp: messageTimestamp,
            role: 'system',
            text: null,
            content_type: 'unknown',
            is_meta: 1,
            visibility: 'hidden',
            model: parseModelRef(session.model) ?? null,
            is_sidechain: isSubagent ? 1 : 0,
            agent_id: isSubagent ? sessionId : null,
            input_tokens: usage.input,
            output_tokens: usage.output,
            cwd: session.directory ?? null,
            skill: null,
            source: name,
          } satisfies MessageRecord);
          previousMessageUuid = uuid;
        }
      }
      continue;
    }

    if (m.type === 'system' || m.type === 'synthetic') {
      const uuid = `${sessionId}:m:${String(m.seq).padStart(6, '0')}:${encodeURIComponent(m.id)}:msg`;
      const text = str(data.text);
      visibleCount += baseVisibility === 'visible' ? 1 : 0;
      records.push({
        kind: 'message',
        uuid,
        session_id: sessionId,
        type: 'system',
        parent_uuid: previousMessageUuid,
        timestamp: messageTimestamp,
        role: 'system',
        text: text !== null ? trunc(text) : null,
        content_type: text !== null ? 'text' : 'unknown',
        is_meta: 1,
        visibility: baseVisibility,
        model: parseModelRef(session.model) ?? null,
        is_sidechain: isSubagent ? 1 : 0,
        agent_id: isSubagent ? sessionId : null,
        input_tokens: null,
        output_tokens: null,
        cwd: session.directory ?? null,
        skill: null,
        source: name,
      } satisfies MessageRecord);
      previousMessageUuid = uuid;
      continue;
    }

    if (m.type === 'model-switched') {
      const uuid = `${sessionId}:m:${String(m.seq).padStart(6, '0')}:${encodeURIComponent(m.id)}:msg`;
      const toModel = parseModelRef(data.model);
      const fromModel = parseModelRef(data.previous);
      const cardText = fromModel !== null && toModel !== null
        ? `model ${fromModel} → ${toModel}`
        : `model → ${toModel ?? fromModel ?? 'default'}`;
      visibleCount += baseVisibility === 'visible' ? 1 : 0;
      records.push({
        kind: 'message',
        uuid,
        session_id: sessionId,
        type: 'system',
        parent_uuid: previousMessageUuid,
        timestamp: messageTimestamp,
        role: 'system',
        text: cardText,
        content_type: 'text',
        is_meta: 1,
        visibility: baseVisibility,
        model: toModel ?? parseModelRef(session.model) ?? null,
        is_sidechain: isSubagent ? 1 : 0,
        agent_id: isSubagent ? sessionId : null,
        input_tokens: null,
        output_tokens: null,
        cwd: session.directory ?? null,
        skill: null,
        source: name,
      } satisfies MessageRecord);
      previousMessageUuid = uuid;
      continue;
    }

    if (m.type === 'agent-switched') {
      const uuid = `${sessionId}:m:${String(m.seq).padStart(6, '0')}:${encodeURIComponent(m.id)}:msg`;
      const toAgent = str(data.agent);
      const fromAgent = str(data.previous);
      const cardText = fromAgent !== null && toAgent !== null
        ? `agent ${fromAgent} → ${toAgent}`
        : `agent → ${toAgent ?? fromAgent ?? 'default'}`;
      visibleCount += baseVisibility === 'visible' ? 1 : 0;
      records.push({
        kind: 'message',
        uuid,
        session_id: sessionId,
        type: 'system',
        parent_uuid: previousMessageUuid,
        timestamp: messageTimestamp,
        role: 'system',
        text: cardText,
        content_type: 'text',
        is_meta: 1,
        visibility: baseVisibility,
        model: parseModelRef(session.model) ?? null,
        is_sidechain: isSubagent ? 1 : 0,
        agent_id: isSubagent ? sessionId : null,
        input_tokens: null,
        output_tokens: null,
        cwd: session.directory ?? null,
        skill: null,
        source: name,
      } satisfies MessageRecord);
      previousMessageUuid = uuid;
      continue;
    }

    if (m.type === 'location-switched') {
      const uuid = `${sessionId}:m:${String(m.seq).padStart(6, '0')}:${encodeURIComponent(m.id)}:msg`;
      visibleCount += baseVisibility === 'visible' ? 1 : 0;
      records.push({
        kind: 'message',
        uuid,
        session_id: sessionId,
        type: 'system',
        parent_uuid: previousMessageUuid,
        timestamp: messageTimestamp,
        role: 'system',
        text: 'location switched',
        content_type: 'text',
        is_meta: 1,
        visibility: baseVisibility,
        model: parseModelRef(session.model) ?? null,
        is_sidechain: isSubagent ? 1 : 0,
        agent_id: isSubagent ? sessionId : null,
        input_tokens: null,
        output_tokens: null,
        cwd: session.directory ?? null,
        skill: null,
        source: name,
      } satisfies MessageRecord);
      previousMessageUuid = uuid;
      continue;
    }

    if (m.type === 'idle') {
      const uuid = `${sessionId}:m:${String(m.seq).padStart(6, '0')}:${encodeURIComponent(m.id)}:msg`;
      records.push({
        kind: 'message',
        uuid,
        session_id: sessionId,
        type: 'system',
        parent_uuid: previousMessageUuid,
        timestamp: messageTimestamp,
        role: 'system',
        text: null,
        content_type: 'unknown',
        is_meta: 1,
        visibility: 'hidden',
        model: parseModelRef(session.model) ?? null,
        is_sidechain: isSubagent ? 1 : 0,
        agent_id: isSubagent ? sessionId : null,
        input_tokens: null,
        output_tokens: null,
        cwd: session.directory ?? null,
        skill: null,
        source: name,
      } satisfies MessageRecord);
      previousMessageUuid = uuid;
      continue;
    }

    if (m.type === 'user') {
      const uuid = `${sessionId}:m:${String(m.seq).padStart(6, '0')}:${encodeURIComponent(m.id)}:msg`;
      const userText = str(data.text);
      visibleCount += baseVisibility === 'visible' ? 1 : 0;
      records.push({
        kind: 'message',
        uuid,
        session_id: sessionId,
        type: 'user',
        parent_uuid: previousMessageUuid,
        timestamp: messageTimestamp,
        role: 'user',
        text: userText !== null ? trunc(userText) : null,
        content_type: userText !== null ? 'text' : 'unknown',
        is_meta: 0,
        visibility: baseVisibility,
        model: null,
        is_sidechain: isSubagent ? 1 : 0,
        agent_id: isSubagent ? sessionId : null,
        input_tokens: null,
        output_tokens: null,
        cwd: session.directory ?? null,
        skill: null,
        source: name,
      } satisfies MessageRecord);
      previousMessageUuid = uuid;
      continue;
    }

    if (m.type === 'assistant') {
      const model = parseModelRef(data.model) ?? parseModelRef(session.model) ?? null;
      const content = Array.isArray(data.content) ? data.content : [];
      const assistantRecords: MessageRecord[] = [];
      let hasToolCall = false;

      for (let cIdx = 0; cIdx < content.length; cIdx++) {
        const item = content[cIdx];
        if (!isRecord(item)) continue;
        const itemType = str(item.type);
        const blockKey = String(cIdx).padStart(4, '0');

        if (itemType === 'text') {
          const textVal = str(item.text);
          if (textVal === null) continue;
          const uuid = `${sessionId}:m:${String(m.seq).padStart(6, '0')}:${encodeURIComponent(m.id)}:c:${blockKey}:text`;
          visibleCount += baseVisibility === 'visible' ? 1 : 0;
          const record: MessageRecord = {
            kind: 'message',
            uuid,
            session_id: sessionId,
            type: 'assistant',
            parent_uuid: previousMessageUuid,
            timestamp: messageTimestamp,
            role: 'assistant',
            text: trunc(textVal),
            content_type: 'text',
            is_meta: 0,
            visibility: baseVisibility,
            model,
            is_sidechain: isSubagent ? 1 : 0,
            agent_id: isSubagent ? sessionId : null,
            input_tokens: null,
            output_tokens: null,
            cwd: session.directory ?? null,
            skill: null,
            source: name,
          };
          assistantRecords.push(record);
          records.push(record);
          previousMessageUuid = uuid;
        } else if (itemType === 'reasoning') {
          const thinkVal = str(item.text);
          if (thinkVal === null) continue;
          const uuid = `${sessionId}:m:${String(m.seq).padStart(6, '0')}:${encodeURIComponent(m.id)}:c:${blockKey}:think`;
          visibleCount += baseVisibility === 'visible' ? 1 : 0;
          const record: MessageRecord = {
            kind: 'message',
            uuid,
            session_id: sessionId,
            type: 'assistant',
            parent_uuid: previousMessageUuid,
            timestamp: messageTimestamp,
            role: 'assistant',
            text: trunc(thinkVal),
            content_type: 'thinking',
            is_meta: 0,
            visibility: baseVisibility,
            model,
            is_sidechain: isSubagent ? 1 : 0,
            agent_id: isSubagent ? sessionId : null,
            input_tokens: null,
            output_tokens: null,
            cwd: session.directory ?? null,
            skill: null,
            source: name,
          };
          assistantRecords.push(record);
          records.push(record);
          previousMessageUuid = uuid;
        } else if (itemType === 'tool') {
          const callId = str(item.id);
          const toolName = str(item.name);
          if (callId === null || toolName === null) continue;
          hasToolCall = true;

          const uuid = `${sessionId}:m:${String(m.seq).padStart(6, '0')}:${encodeURIComponent(m.id)}:c:${blockKey}:tool`;
          const toolCallId = `${uuid}:call:${encodeURIComponent(callId)}`;
          const state = isRecord(item.state) ? item.state : {};
          const status = str(state.status);
          const input = state.input ?? {};
          const filePath = toolFilePath(toolName, input);

          visibleCount += baseVisibility === 'visible' ? 1 : 0;
          const record: MessageRecord = {
            kind: 'message',
            uuid,
            session_id: sessionId,
            type: 'assistant',
            parent_uuid: previousMessageUuid,
            timestamp: messageTimestamp,
            role: 'assistant',
            text: null,
            content_type: 'tool_use',
            is_meta: 0,
            visibility: baseVisibility,
            model,
            is_sidechain: isSubagent ? 1 : 0,
            agent_id: isSubagent ? sessionId : null,
            input_tokens: null,
            output_tokens: null,
            cwd: session.directory ?? null,
            skill: null,
            source: name,
          };
          assistantRecords.push(record);
          records.push(record);
          previousMessageUuid = uuid;

          records.push({
            kind: 'tool_call',
            id: toolCallId,
            message_uuid: uuid,
            session_id: sessionId,
            name: toolName,
            presentation: 'default',
            input_json: truncJson(input) ?? '{}',
            file_path: filePath,
          });

          if (status === 'completed' || status === 'error') {
            let contentStr = '';
            const isError: 0 | 1 = status === 'error' ? 1 : 0;
            if (status === 'error') {
              contentStr = typeof state.error === 'string'
                ? state.error
                : JSON.stringify(state.error ?? '');
            } else if (typeof state.content === 'string') {
              contentStr = state.content;
            } else if (Array.isArray(state.content)) {
              contentStr = state.content
                .map(c => (isRecord(c) && typeof c.text === 'string' ? c.text : JSON.stringify(c)))
                .join('\n');
            } else if (state.output !== undefined && state.output !== null) {
              contentStr = typeof state.output === 'string'
                ? state.output
                : JSON.stringify(state.output);
            }
            records.push({
              kind: 'tool_result',
              tool_use_id: toolCallId,
              message_uuid: uuid,
              session_id: sessionId,
              content: trunc(contentStr),
              file_path: filePath,
              is_error: isError,
            });
          }
        }
      }

      // If no text/think/tool messages emitted, emit textless anchor
      if (assistantRecords.length === 0) {
        const uuid = `${sessionId}:m:${String(m.seq).padStart(6, '0')}:${encodeURIComponent(m.id)}:msg`;
        visibleCount += baseVisibility === 'visible' ? 1 : 0;
        const record: MessageRecord = {
          kind: 'message',
          uuid,
          session_id: sessionId,
          type: 'assistant',
          parent_uuid: previousMessageUuid,
          timestamp: messageTimestamp,
          role: 'assistant',
          text: null,
          content_type: hasToolCall ? 'tool_use' : 'unknown',
          is_meta: 0,
          visibility: baseVisibility,
          model,
          is_sidechain: isSubagent ? 1 : 0,
          agent_id: isSubagent ? sessionId : null,
          input_tokens: null,
          output_tokens: null,
          cwd: session.directory ?? null,
          skill: null,
          source: name,
        };
        assistantRecords.push(record);
        records.push(record);
        previousMessageUuid = uuid;
      }

      // Attach token usage to the final assistant message record
      const usage = v2UsageTokens(data.tokens);
      if (assistantRecords.length > 0) {
        const lastRecord = assistantRecords.at(-1)!;
        lastRecord.input_tokens = usage.input;
        lastRecord.output_tokens = usage.output;
      }
      continue;
    }

    if (m.type === 'skill') {
      const uuid = `${sessionId}:m:${String(m.seq).padStart(6, '0')}:${encodeURIComponent(m.id)}:msg`;
      const skillName = str(data.name) ?? str(data.skill);
      const instructions = str(data.instructions) ?? str(data.text);
      visibleCount += baseVisibility === 'visible' ? 1 : 0;
      records.push({
        kind: 'message',
        uuid,
        session_id: sessionId,
        type: 'system',
        parent_uuid: previousMessageUuid,
        timestamp: messageTimestamp,
        role: 'system',
        text: instructions !== null ? trunc(instructions) : null,
        content_type: instructions !== null ? 'skill_instructions' : 'text',
        is_meta: 1,
        visibility: baseVisibility,
        model: parseModelRef(session.model) ?? null,
        is_sidechain: isSubagent ? 1 : 0,
        agent_id: isSubagent ? sessionId : null,
        input_tokens: null,
        output_tokens: null,
        cwd: session.directory ?? null,
        skill: skillName ?? null,
        source: name,
      } satisfies MessageRecord);
      previousMessageUuid = uuid;
      continue;
    }

    if (m.type === 'shell') {
      const uuid = `${sessionId}:m:${String(m.seq).padStart(6, '0')}:${encodeURIComponent(m.id)}:msg`;
      const command = str(data.command);
      const status = str(data.status);
      const output = typeof data.output === 'string' ? data.output
        : isRecord(data.output) && typeof data.output.output === 'string' ? data.output.output : '';
      const terminal = status === 'exited' || status === 'timeout' || status === 'killed'
        || status === 'completed' || status === 'error'
        || (status === null && isRecord(data.time) && typeof data.time.completed === 'number');
      const failed = status === 'timeout' || status === 'killed' || status === 'error'
        || (status === 'exited' && typeof data.exit === 'number' && data.exit !== 0);
      const toolCallId = `${uuid}:call:${encodeURIComponent(m.id)}`;
      const usage = v2UsageTokens(data.tokens);
      visibleCount += baseVisibility === 'visible' ? 1 : 0;
      records.push({
        kind: 'message',
        uuid,
        session_id: sessionId,
        type: 'assistant',
        parent_uuid: previousMessageUuid,
        timestamp: messageTimestamp,
        role: 'assistant',
        text: null,
        content_type: 'tool_use',
        is_meta: 0,
        visibility: baseVisibility,
        model: parseModelRef(session.model) ?? null,
        is_sidechain: isSubagent ? 1 : 0,
        agent_id: isSubagent ? sessionId : null,
        input_tokens: usage.input,
        output_tokens: usage.output,
        cwd: session.directory ?? null,
        skill: null,
        source: name,
      } satisfies MessageRecord);
      records.push({
        kind: 'tool_call',
        id: toolCallId,
        message_uuid: uuid,
        session_id: sessionId,
        name: 'bash',
        presentation: 'default',
        input_json: JSON.stringify({ command: command ?? '' }),
        file_path: null,
      });
      if (terminal || output.length > 0) {
        records.push({
          kind: 'tool_result',
          tool_use_id: toolCallId,
          message_uuid: uuid,
          session_id: sessionId,
          content: trunc(output),
          file_path: null,
          is_error: failed ? 1 : 0,
        });
      }
      previousMessageUuid = uuid;
      continue;
    }

    // Preserved audit record for unknown future-type
    const uuid = `${sessionId}:m:${String(m.seq).padStart(6, '0')}:${encodeURIComponent(m.id)}:msg`;
    const text = str(data.text) ?? (typeof m.data === 'string' && m.data.length > 0 ? m.data : null);
    visibleCount += baseVisibility === 'visible' ? 1 : 0;
    records.push({
      kind: 'message',
      uuid,
      session_id: sessionId,
      type: 'system',
      parent_uuid: previousMessageUuid,
      timestamp: messageTimestamp,
      role: 'system',
      text: text !== null ? trunc(text) : null,
      content_type: text !== null ? 'text' : 'unknown',
      is_meta: 1,
      visibility: baseVisibility,
      model: parseModelRef(session.model) ?? null,
      is_sidechain: isSubagent ? 1 : 0,
      agent_id: isSubagent ? sessionId : null,
      input_tokens: null,
      output_tokens: null,
      cwd: session.directory ?? null,
      skill: null,
      source: name,
    } satisfies MessageRecord);
    previousMessageUuid = uuid;
  }

  if (isSubagent && session.parent_id !== null) {
    records.push({
      kind: 'subagent',
      agent_id: sessionId,
      session_id: opencodeSessionId(session.parent_id, meta.dbPath),
      parent_tool_use_id: null,
      agent_type: session.agent ?? null,
      description: session.title ?? null,
      duration_ms: null,
      total_tokens: null,
    } satisfies SubagentRecord);
  }

  records.push({
    kind: 'session',
    id: sessionId,
    title: session.title ?? null,
    project: projectSlugFromPath(normalizeObservedCwd(session.directory)),
    started_at: startedAt,
    ended_at: endedAt ?? timestampOfMs(session.time_updated ?? session.time_created),
    git_branch: gitBranch,
    version: session.version ?? null,
    message_count: visibleCount,
    countMode: 'total',
    jsonl_path: unit.key,
    source: name,
  } satisfies SessionRecord);

  for (const record of records) yield record;

  return fingerprint;
}

export function* parseV1(
  unit: IndexUnit,
  meta: { dbPath: string; rawSessionId: string },
  db: SqliteDb,
  session: SessionRow,
): Generator<TranscriptRecord, string> {
  const sessionId = unit.sessionId;
  const isSubagent = unit.isSubagent === true;

  const messages = db.prepare(
    'SELECT id, session_id, time_created, time_updated, data FROM message WHERE session_id = ? ORDER BY time_created, id',
  ).all(meta.rawSessionId) as unknown as MessageRow[];

  const parts = db.prepare(
    'SELECT id, message_id, session_id, time_created, time_updated, data FROM part WHERE session_id = ? ORDER BY id',
  ).all(meta.rawSessionId) as unknown as PartRow[];

  const fingerprint = fingerprintSession('v1', session, isSubagent, undefined, messages, parts);
  const revert = parseRevert(session.revert);

  const partsByMessage = new Map<string, PartRow[]>();
  for (const part of parts) {
    const list = partsByMessage.get(part.message_id) ?? [];
    list.push(part);
    partsByMessage.set(part.message_id, list);
  }

  let revertMessageIndex = -1;
  if (revert?.messageID) {
    revertMessageIndex = messages.findIndex(m => m.id === revert.messageID);
  }

  const startedAt = timestampOfMs(session.time_created);
  let endedAt: string | null = null;
  const gitBranch: string | null = null;
  let visibleCount = 0;
  let previousMessageUuid: string | null = null;
  const records: TranscriptRecord[] = [];

  for (let mIdx = 0; mIdx < messages.length; mIdx++) {
    const m = messages[mIdx]!;
    const mData = legacyMessageData(m);
    const role = str(mData.role) ?? 'user';
    const messageTimestamp = timestampOfMs(m.time_created);
    const mParts = partsByMessage.get(m.id) ?? [];

    const isAtRevert = revertMessageIndex !== -1 && mIdx === revertMessageIndex;
    const isAfterRevert = revertMessageIndex !== -1 && mIdx > revertMessageIndex;

    if (!isAfterRevert && m.time_updated) {
      const updatedTime = timestampOfMs(m.time_updated);
      if (updatedTime !== null && (endedAt === null || updatedTime > endedAt)) {
        endedAt = updatedTime;
      }
    }

    if (role === 'user') {
      let revertPartFound = false;
      let userEmittedAny = false;
      for (let pIdx = 0; pIdx < mParts.length; pIdx++) {
        const p = mParts[pIdx]!;
        const pData = legacyPartData(p);
        let isPartActive = true;
        if (isAfterRevert) {
          isPartActive = false;
        } else if (isAtRevert) {
          if (revert?.partID === null) {
            isPartActive = false;
          } else if (p.id === revert?.partID || revertPartFound) {
            revertPartFound = true;
            isPartActive = false;
          }
        }
        const visibility: MessageVisibility = isPartActive ? 'visible' : 'inactive';
        const pType = str(pData.type);
        if (pType === 'text') {
          const textVal = str(pData.text);
          if (textVal === null) continue;
          const uuid = `${sessionId}:m:${String(mIdx).padStart(6, '0')}:${encodeURIComponent(m.id)}:p:${encodeURIComponent(p.id)}:text`;
          visibleCount += visibility === 'visible' ? 1 : 0;
          records.push({
            kind: 'message',
            uuid,
            session_id: sessionId,
            type: 'user',
            parent_uuid: previousMessageUuid,
            timestamp: messageTimestamp,
            role: 'user',
            text: trunc(textVal),
            content_type: 'text',
            is_meta: 0,
            visibility,
            model: null,
            is_sidechain: isSubagent ? 1 : 0,
            agent_id: isSubagent ? sessionId : null,
            input_tokens: null,
            output_tokens: null,
            cwd: session.directory ?? null,
            skill: null,
            source: name,
          } satisfies MessageRecord);
          previousMessageUuid = uuid;
          userEmittedAny = true;
        }
      }

      if (!userEmittedAny) {
        const isReverted = isAfterRevert || (isAtRevert && revert?.partID === null);
        const visibility: MessageVisibility = isReverted ? 'inactive' : 'visible';
        const uuid = `${sessionId}:m:${String(mIdx).padStart(6, '0')}:${encodeURIComponent(m.id)}:msg`;
        const userText = str(mData.text);
        visibleCount += visibility === 'visible' ? 1 : 0;
        records.push({
          kind: 'message',
          uuid,
          session_id: sessionId,
          type: 'user',
          parent_uuid: previousMessageUuid,
          timestamp: messageTimestamp,
          role: 'user',
          text: userText !== null ? trunc(userText) : null,
          content_type: userText !== null ? 'text' : 'unknown',
          is_meta: 0,
          visibility,
          model: null,
          is_sidechain: isSubagent ? 1 : 0,
          agent_id: isSubagent ? sessionId : null,
          input_tokens: null,
          output_tokens: null,
          cwd: session.directory ?? null,
          skill: null,
          source: name,
        } satisfies MessageRecord);
        previousMessageUuid = uuid;
      }
      continue;
    }

    if (role === 'assistant') {
      const model = parseModelRef(mData.modelID) ?? parseModelRef(mData.model) ?? parseModelRef(session.model) ?? null;
      let hasStepTokens = false;
      const assistantRecords: MessageRecord[] = [];
      let currentStepRecords: MessageRecord[] = [];
      let hasToolCall = false;

      let revertPartFound = false;

      for (let pIdx = 0; pIdx < mParts.length; pIdx++) {
        const p = mParts[pIdx]!;
        const pData = legacyPartData(p);

        let isPartActive = true;
        if (isAfterRevert) {
          isPartActive = false;
        } else if (isAtRevert) {
          if (revert?.partID === null) {
            isPartActive = false;
          } else if (p.id === revert?.partID || revertPartFound) {
            revertPartFound = true;
            isPartActive = false;
          }
        }
        const visibility: MessageVisibility = isPartActive ? 'visible' : 'inactive';
        const pType = str(pData.type);

        if (pType === 'step-start') {
          currentStepRecords = [];
        } else if (pType === 'text') {
          const textVal = str(pData.text);
          if (textVal === null) continue;
          const uuid = `${sessionId}:m:${String(mIdx).padStart(6, '0')}:${encodeURIComponent(m.id)}:p:${encodeURIComponent(p.id)}:text`;
          visibleCount += visibility === 'visible' ? 1 : 0;
          const record: MessageRecord = {
            kind: 'message',
            uuid,
            session_id: sessionId,
            type: 'assistant',
            parent_uuid: previousMessageUuid,
            timestamp: messageTimestamp,
            role: 'assistant',
            text: trunc(textVal),
            content_type: 'text',
            is_meta: 0,
            visibility,
            model,
            is_sidechain: isSubagent ? 1 : 0,
            agent_id: isSubagent ? sessionId : null,
            input_tokens: null,
            output_tokens: null,
            cwd: session.directory ?? null,
            skill: null,
            source: name,
          };
          assistantRecords.push(record);
          currentStepRecords.push(record);
          records.push(record);
          previousMessageUuid = uuid;
        } else if (pType === 'reasoning') {
          const thinkVal = str(pData.text);
          if (thinkVal === null) continue;
          const uuid = `${sessionId}:m:${String(mIdx).padStart(6, '0')}:${encodeURIComponent(m.id)}:p:${encodeURIComponent(p.id)}:think`;
          visibleCount += visibility === 'visible' ? 1 : 0;
          const record: MessageRecord = {
            kind: 'message',
            uuid,
            session_id: sessionId,
            type: 'assistant',
            parent_uuid: previousMessageUuid,
            timestamp: messageTimestamp,
            role: 'assistant',
            text: trunc(thinkVal),
            content_type: 'thinking',
            is_meta: 0,
            visibility,
            model,
            is_sidechain: isSubagent ? 1 : 0,
            agent_id: isSubagent ? sessionId : null,
            input_tokens: null,
            output_tokens: null,
            cwd: session.directory ?? null,
            skill: null,
            source: name,
          };
          assistantRecords.push(record);
          currentStepRecords.push(record);
          records.push(record);
          previousMessageUuid = uuid;
        } else if (pType === 'tool') {
          const callId = str(pData.callID);
          const toolName = str(pData.tool);
          if (callId === null || toolName === null) continue;
          hasToolCall = true;

          const uuid = `${sessionId}:m:${String(mIdx).padStart(6, '0')}:${encodeURIComponent(m.id)}:p:${encodeURIComponent(p.id)}:tool`;
          const toolCallId = `${uuid}:call:${encodeURIComponent(callId)}`;
          const state = isRecord(pData.state) ? pData.state : {};
          const status = str(state.status);
          const input = state.input ?? {};
          const filePath = toolFilePath(toolName, input);

          visibleCount += visibility === 'visible' ? 1 : 0;
          const record: MessageRecord = {
            kind: 'message',
            uuid,
            session_id: sessionId,
            type: 'assistant',
            parent_uuid: previousMessageUuid,
            timestamp: messageTimestamp,
            role: 'assistant',
            text: null,
            content_type: 'tool_use',
            is_meta: 0,
            visibility,
            model,
            is_sidechain: isSubagent ? 1 : 0,
            agent_id: isSubagent ? sessionId : null,
            input_tokens: null,
            output_tokens: null,
            cwd: session.directory ?? null,
            skill: null,
            source: name,
          };
          assistantRecords.push(record);
          currentStepRecords.push(record);
          previousMessageUuid = uuid;

          records.push(record);
          records.push({
            kind: 'tool_call',
            id: toolCallId,
            message_uuid: uuid,
            session_id: sessionId,
            name: toolName,
            presentation: 'default',
            input_json: truncJson(input) ?? '{}',
            file_path: filePath,
          });

          if (status === 'completed' || status === 'error') {
            let contentStr = '';
            const isError: 0 | 1 = status === 'error' ? 1 : 0;
            if (status === 'error') {
              contentStr = typeof state.error === 'string'
                ? state.error
                : JSON.stringify(state.error ?? '');
            } else if (state.output !== undefined && state.output !== null) {
              contentStr = typeof state.output === 'string'
                ? state.output
                : JSON.stringify(state.output);
            }
            records.push({
              kind: 'tool_result',
              tool_use_id: toolCallId,
              message_uuid: uuid,
              session_id: sessionId,
              content: trunc(contentStr),
              file_path: filePath,
              is_error: isError,
            });
          }
        } else if (pType === 'step-finish') {
          const stepUsage = v1StepUsageTokens(pData.tokens);
          if (stepUsage.input !== null || stepUsage.output !== null) {
            hasStepTokens = true;
            if (currentStepRecords.length > 0) {
              const target = currentStepRecords.at(-1)!;
              target.input_tokens = stepUsage.input;
              target.output_tokens = stepUsage.output;
            } else {
              const uuid = `${sessionId}:m:${String(mIdx).padStart(6, '0')}:${encodeURIComponent(m.id)}:p:${encodeURIComponent(p.id)}:step`;
              visibleCount += visibility === 'visible' ? 1 : 0;
              const record: MessageRecord = {
                kind: 'message',
                uuid,
                session_id: sessionId,
                type: 'assistant',
                parent_uuid: previousMessageUuid,
                timestamp: messageTimestamp,
                role: 'assistant',
                text: null,
                content_type: 'unknown',
                is_meta: 0,
                visibility,
                model,
                is_sidechain: isSubagent ? 1 : 0,
                agent_id: isSubagent ? sessionId : null,
                input_tokens: stepUsage.input,
                output_tokens: stepUsage.output,
                cwd: session.directory ?? null,
                skill: null,
                source: name,
              };
              assistantRecords.push(record);
              currentStepRecords.push(record);
              records.push(record);
              previousMessageUuid = uuid;
            }
          }
        }
      }

      // If no text/think/tool messages emitted, emit textless anchor
      if (assistantRecords.length === 0) {
        const uuid = `${sessionId}:m:${String(mIdx).padStart(6, '0')}:${encodeURIComponent(m.id)}:msg`;
        const isReverted = isAfterRevert || (isAtRevert && revert?.partID === null);
        const visibility: MessageVisibility = isReverted ? 'inactive' : 'visible';
        visibleCount += visibility === 'visible' ? 1 : 0;
        const record: MessageRecord = {
          kind: 'message',
          uuid,
          session_id: sessionId,
          type: 'assistant',
          parent_uuid: previousMessageUuid,
          timestamp: messageTimestamp,
          role: 'assistant',
          text: null,
          content_type: hasToolCall ? 'tool_use' : 'unknown',
          is_meta: 0,
          visibility,
          model,
          is_sidechain: isSubagent ? 1 : 0,
          agent_id: isSubagent ? sessionId : null,
          input_tokens: null,
          output_tokens: null,
          cwd: session.directory ?? null,
          skill: null,
          source: name,
        };
        assistantRecords.push(record);
        records.push(record);
        previousMessageUuid = uuid;
      }

      // If no step-finish occurred, fallback to assistant.tokens
      if (!hasStepTokens && assistantRecords.length > 0) {
        const fallbackUsage = v1StepUsageTokens(mData.tokens);
        const lastRecord = assistantRecords.at(-1)!;
        lastRecord.input_tokens = fallbackUsage.input;
        lastRecord.output_tokens = fallbackUsage.output;
      }
    }
  }

  if (isSubagent && session.parent_id !== null) {
    records.push({
      kind: 'subagent',
      agent_id: sessionId,
      session_id: opencodeSessionId(session.parent_id, meta.dbPath),
      parent_tool_use_id: null,
      agent_type: session.agent ?? null,
      description: session.title ?? null,
      duration_ms: null,
      total_tokens: null,
    } satisfies SubagentRecord);
  }

  records.push({
    kind: 'session',
    id: sessionId,
    title: session.title ?? null,
    project: projectSlugFromPath(normalizeObservedCwd(session.directory)),
    started_at: startedAt,
    ended_at: endedAt ?? timestampOfMs(session.time_updated ?? session.time_created),
    git_branch: gitBranch,
    version: session.version ?? null,
    message_count: visibleCount,
    countMode: 'total',
    jsonl_path: unit.key,
    source: name,
  } satisfies SessionRecord);

  for (const record of records) yield record;

  return fingerprint;
}
