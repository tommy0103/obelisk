// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseJson(text: unknown): JsonRecord | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export function transcriptObject(text: unknown, location: string): JsonRecord {
  const value = parseJson(text);
  if (value === null) throw new Error(`opencode: invalid JSON payload at ${location}`);
  return value;
}

export function modernMessageData(message: { id: string; type: string; data: string }): JsonRecord {
  const data = transcriptObject(message.data, `session_message ${message.id}`);
  if (message.type === 'user' && typeof data.text !== 'string') {
    throw new Error(`opencode: invalid user payload at session_message ${message.id}`);
  }
  if (message.type === 'assistant') {
    if (!Array.isArray(data.content) || data.content.some(item => !isRecord(item)
      || typeof item.type !== 'string'
      || ((item.type === 'text' || item.type === 'reasoning') && typeof item.text !== 'string')
      || (item.type === 'tool' && (str(item.id) === null || str(item.name) === null
        || !isRecord(item.state) || typeof item.state.status !== 'string')))) {
      throw new Error(`opencode: invalid assistant payload at session_message ${message.id}`);
    }
  }
  // The pre-split writer records callID/output/time, with no status or exit.
  const preSplitShell = data.status === undefined && typeof data.callID === 'string'
    && typeof data.output === 'string' && isRecord(data.time) && typeof data.time.created === 'number';
  if (message.type === 'shell' && (typeof data.command !== 'string' || (!preSplitShell && typeof data.status !== 'string')
    || (data.exit !== undefined && (typeof data.exit !== 'number' || !Number.isFinite(data.exit)))
    || (data.output !== undefined && typeof data.output !== 'string'
      && (!isRecord(data.output) || typeof data.output.output !== 'string')))) {
    throw new Error(`opencode: invalid shell payload at session_message ${message.id}`);
  }
  return data;
}

export function legacyMessageData(message: { id: string; data: string }): JsonRecord {
  const data = transcriptObject(message.data, `message ${message.id}`);
  if (data.role !== 'user' && data.role !== 'assistant') {
    throw new Error(`opencode: invalid role payload at message ${message.id}`);
  }
  return data;
}

export function legacyPartData(part: { id: string; data: string }): JsonRecord {
  const data = transcriptObject(part.data, `part ${part.id}`);
  if (typeof data.type !== 'string'
    || ((data.type === 'text' || data.type === 'reasoning') && typeof data.text !== 'string')
    || (data.type === 'tool' && (str(data.callID) === null || str(data.tool) === null
      || !isRecord(data.state) || typeof data.state.status !== 'string'
      || !isRecord(data.state.input)
      || (data.state.status === 'completed' && typeof data.state.output !== 'string')
      || (data.state.status === 'error' && typeof data.state.error !== 'string')))) {
    throw new Error(`opencode: invalid part payload at part ${part.id}`);
  }
  return data;
}

export function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function parseModelRef(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) {
    const parsed = parseJson(value);
    if (parsed && typeof parsed.id === 'string' && parsed.id.length > 0) {
      return parsed.id;
    }
    return value;
  }
  if (isRecord(value)) {
    if (typeof value.id === 'string' && value.id.length > 0) {
      return value.id;
    }
    if (typeof value.modelID === 'string' && value.modelID.length > 0) {
      return value.modelID;
    }
  }
  return null;
}

// Pre-split compaction is inserted only by compaction.ended and has no status.
// V2 persists running/failed rows too, which must never be presented as summaries.
export function completedCompaction(data: JsonRecord): string | null {
  const completed = data.status === 'completed' || (data.status === undefined
    && (data.reason === 'auto' || data.reason === 'manual')
    && typeof data.recent === 'string' && isRecord(data.time)
    && typeof data.time.created === 'number');
  return completed ? str(data.summary) : null;
}
