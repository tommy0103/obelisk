// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// USF (Universal Session Format), version 1. The format is specified in
// docs/usf-spec.md; this module is its reference implementation.
//
// USF is assembled from the canonical transcript (ADR-0007): the same
// `TranscriptRecord` stream that persist serializes and session detail
// presents. The assembly therefore sits before persist and is the same for
// every provider. It follows the rules of that seam: it never checks the
// provider and never parses message text to recover provider semantics. What a
// record does not say, USF does not say either.
//
// Like direct session-detail assembly, it needs complete parses (cursor =
// null) of every unit of the sessions concerned: turns and sub-agent runs
// cannot be cut from a delta.

import type {
  HarnessKind,
  MessageRecord,
  SessionRecord,
  SubagentRecord,
  SummaryRecord,
  ToolCallRecord,
  ToolResultRecord,
  TranscriptRecord,
} from './providers/types.ts';

export const USF_VERSION = 1;

export const USF_HARNESS_KINDS = [
  'compaction', 'recap', 'interruption', 'command', 'reminder', 'skill',
  'attachment', 'task', 'error', 'result', 'notification', 'other',
] as const satisfies readonly HarnessKind[];
export type UsfHarnessKind = typeof USF_HARNESS_KINDS[number];

/** `local` keeps every step and marks the ones that are not current; `published` has only current steps. */
export type UsfProfile = 'local' | 'published';
export type UsfState = 'inactive' | 'hidden';

export interface UsfBlob { sha256: string; bytes: number }
export type UsfContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; media_type: string; blob: UsfBlob }
  | { type: 'file'; media_type: string; blob: UsfBlob };
export type UsfContent = string | UsfContentPart[];

/** Integers. `input` includes cached input; `cached` is the cached part of it. */
export interface UsfUsage { input?: number; cached?: number; output?: number }

export const USF_MASK_FIELDS = ['content', 'input', 'result', 'file', 'description', 'extra'] as const;
/** Published form only: where a placeholder stands in place of a secret. */
export interface UsfMask {
  in: typeof USF_MASK_FIELDS[number];
  /** JSON Pointer to the text inside the field; absent when the field is the text. */
  path?: string;
  at: number;
  n: number;
  rule: string;
}

interface UsfStepBase {
  id: string;
  at: string | null;
  state?: UsfState;
  skill?: string;
  extra?: Record<string, unknown>;
  masks?: UsfMask[];
}
export interface UsfHumanStep extends UsfStepBase { by: 'human'; content: UsfContent }
export interface UsfHarnessStep extends UsfStepBase {
  by: 'harness';
  kind: UsfHarnessKind;
  content: UsfContent;
  model?: string;
  usage?: UsfUsage;
}
export interface UsfTextStep extends UsfStepBase {
  by: 'agent';
  kind: 'text' | 'reasoning';
  content: UsfContent;
  model?: string;
  usage?: UsfUsage;
}
export interface UsfRun {
  agent: { id: string; type?: string; description?: string };
  steps: UsfStep[];
}
export interface UsfToolStep extends UsfStepBase {
  by: 'agent';
  kind: 'tool';
  tool: { id: string; name: string; input: unknown };
  presentation?: 'skill';
  file?: string;
  result?: { at: string | null; content: UsfContent; error: boolean };
  run?: UsfRun;
  model?: string;
  usage?: UsfUsage;
}
/** A sub-agent whose starting call the records do not name. */
export interface UsfRunStep extends UsfStepBase { by: 'agent'; kind: 'run'; run: UsfRun }
export type UsfStep = UsfHumanStep | UsfHarnessStep | UsfTextStep | UsfToolStep | UsfRunStep;

export interface UsfTurn {
  steps: UsfStep[];
  /** Published form only; defined by the publisher, not by this module. */
  v?: number;
  parent?: string | null;
  id?: string;
}

export interface UsfSession {
  usf: typeof USF_VERSION;
  harness: { name: string; version?: string };
  id: string;
  title: string | null;
  git_branch: string | null;
  /** Present when a sub-agent started the session: it then has tasks, and no human step. */
  started_by?: 'agent';
  turns: UsfTurn[];
}

/** What the assembly met in one session. Counts, for diagnostics. */
export interface UsfAssemblyStats {
  /** Tool results whose call is not among the records; each became a `result` step. */
  resultsWithoutCall: number;
  /** Result-carrying messages whose own text says something other than the results. */
  textOnResultMessage: number;
  /** Sub-agents no call is known to have started; each became a `run` step. */
  runsWithoutCall: number;
  /** Steps whose message carried no text. */
  emptyContent: number;
  /** Timestamps that could not be read as a time and became null. */
  notATime: number;
  /** Messages that were another part of the submission before them. */
  partsJoined: number;
}

export interface AssembledUsfSession {
  /** The session in local form. */
  session: UsfSession;
  stats: UsfAssemblyStats;
  /** The uuids of messages that became a part of the human step before them. */
  joined: string[];
  /**
   * True when this session is another session's sub-agent whose parent was
   * not among the records, so that it stands alone here. With the parent
   * present, a child session is a run inside it and is not listed.
   */
  detached: boolean;
}

export interface UsfAssembly {
  sessions: AssembledUsfSession[];
  /** Message uuids that occurred more than once; the first occurrence was used. */
  duplicateMessages: number;
  /** Record kinds USF has no place for, with how many there were. */
  notCarried: Record<string, number>;
}

// A time is written as RFC 3339 says: date, "T", time, and "Z" or an offset.
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
export function isUsfTime(value: unknown): value is string {
  return typeof value === 'string' && TIME.test(value) && !Number.isNaN(Date.parse(value));
}

// A surrogate code unit that is not half of a pair.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

type ListedRecord = MessageRecord | ToolCallRecord | ToolResultRecord | SummaryRecord;

interface AgentRecords {
  agentId: string;
  records: ListedRecord[];
  note: SubagentRecord | null;
}

interface SessionRecords {
  sessionId: string;
  record: SessionRecord | null;
  main: ListedRecord[];
  agents: AgentRecords[];
  /** The session is also some other session's sub-agent. */
  child: boolean;
  parent: string | null;
}

const SEP = '\u0000';
const sessionKey = (id: string) => `session${SEP}${id}`;
const agentKey = (session: string, agent: string) => `agent${SEP}${session}${SEP}${agent}`;

// Records -> sessions, their own records and their sub-agents'. What ties
// records together is in the records, the same way for every provider (and
// the same reading session detail makes):
//   - a message belongs to a session; it is a sub-agent's when `agent_id` is
//     set and is not the session's own id;
//   - a tool call or result belongs where its message does;
//   - a sub-agent record names the agent and, when the provider knows it, the
//     call that started it. The agent's messages are either in the same
//     session under its `agent_id`, or the agent is a session of its own
//     whose id is the `agent_id`.
function groupRecords(records: Iterable<TranscriptRecord>) {
  const all = [...records];
  const lists = new Map<string, ListedRecord[]>();
  const list = (key: string) => {
    let found = lists.get(key);
    if (!found) { found = []; lists.set(key, found); }
    return found;
  };
  const home = new Map<string, string>();
  const sessionRecords = new Map<string, SessionRecord>();
  const notes = new Map<string, SubagentRecord>();
  const notCarried: Record<string, number> = {};
  let duplicateMessages = 0;

  for (const record of all) {
    if (record.kind !== 'message') continue;
    if (home.has(record.uuid)) { duplicateMessages++; continue; }
    home.set(record.uuid, record.agent_id && record.agent_id !== record.session_id
      ? agentKey(record.session_id, record.agent_id)
      : sessionKey(record.session_id));
  }
  const taken = new Set<string>();
  for (const record of all) {
    switch (record.kind) {
      case 'message':
        if (taken.has(record.uuid)) break;
        taken.add(record.uuid);
        list(home.get(record.uuid) as string).push(record);
        break;
      case 'tool_call':
      case 'tool_result':
        list(home.get(record.message_uuid) ?? sessionKey(record.session_id)).push(record);
        break;
      case 'summary':
        list(sessionKey(record.session_id)).push(record);
        break;
      case 'session': {
        if (record.countMode === 'delta') {
          throw new Error('USF assembly requires a fresh full parse (cursor = null), not a provider delta');
        }
        // Fill-if-null, as persist does: a value already present is not replaced.
        const present = sessionRecords.get(record.id);
        sessionRecords.set(record.id, present
          ? { ...record, ...Object.fromEntries(Object.entries(present).filter(([, value]) => value !== null && value !== undefined)) } as SessionRecord
          : record);
        break;
      }
      case 'subagent': {
        // A sub-agent can be described from more than one point of the parse; the fields merge.
        const key = `${record.session_id}${SEP}${record.agent_id}`;
        notes.set(key, {
          ...(notes.get(key) ?? record),
          ...Object.fromEntries(Object.entries(record).filter(([, value]) => value !== null && value !== undefined)),
        } as SubagentRecord);
        break;
      }
      default:
        notCarried[record.kind] = (notCarried[record.kind] ?? 0) + 1;
    }
  }

  const ids = new Set<string>(sessionRecords.keys());
  for (const key of lists.keys()) ids.add(key.split(SEP)[1]);

  // The sub-agents a session's calls can start, and theirs in turn.
  const agentsOf = (sessionId: string, seen = new Set([sessionId])): AgentRecords[] => {
    const out: AgentRecords[] = [];
    for (const note of notes.values()) {
      if (note.session_id !== sessionId) continue;
      const own = lists.get(agentKey(sessionId, note.agent_id));
      const asSession = own ? undefined : lists.get(sessionKey(note.agent_id));
      out.push({ agentId: note.agent_id, records: own ?? asSession ?? [], note });
      if (!own && ids.has(note.agent_id) && !seen.has(note.agent_id)) {
        seen.add(note.agent_id);
        out.push(...agentsOf(note.agent_id, seen));
      }
    }
    // Messages of a sub-agent that no record announced are kept all the same.
    for (const [key, own] of lists) {
      const [kind, session, agent] = key.split(SEP);
      if (kind === 'agent' && session === sessionId && !notes.has(`${session}${SEP}${agent}`)) {
        out.push({ agentId: agent, records: own, note: null });
      }
    }
    return out;
  };

  const parents = new Map<string, string>();
  for (const note of notes.values()) if (note.agent_id !== note.session_id) parents.set(note.agent_id, note.session_id);

  const sessions: SessionRecords[] = [...ids].map((id) => ({
    sessionId: id,
    record: sessionRecords.get(id) ?? null,
    main: lists.get(sessionKey(id)) ?? [],
    agents: agentsOf(id),
    child: parents.has(id),
    parent: parents.get(id) ?? null,
  }));
  return { sessions, duplicateMessages, notCarried };
}

function usageOf(record: { input_tokens?: number | null; output_tokens?: number | null }): UsfUsage | null {
  if (record.input_tokens == null && record.output_tokens == null) return null;
  const usage: UsfUsage = {};
  if (record.input_tokens != null) usage.input = record.input_tokens;
  if (record.output_tokens != null) usage.output = record.output_tokens;
  return usage;
}

function stateOf(visibility: string | null | undefined): { state?: UsfState } {
  return visibility === 'inactive' || visibility === 'hidden' ? { state: visibility } : {};
}

function parts(content: UsfContent): UsfContentPart[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

function assembleSession(input: SessionRecords): { assembled: AssembledUsfSession; placed: Set<string> } {
  const stats: UsfAssemblyStats = {
    resultsWithoutCall: 0, textOnResultMessage: 0, runsWithoutCall: 0, emptyContent: 0, notATime: 0, partsJoined: 0,
  };
  const joined: string[] = [];
  // `at` is a time or null. What stands in a timestamp's place and cannot be read as one is left out.
  const time = (value: string | null | undefined): string | null => {
    if (value == null) return null;
    if (isUsfTime(value)) return value;
    stats.notATime++;
    return null;
  };
  const describe = (agent: AgentRecords): UsfRun['agent'] => ({
    id: agent.agentId,
    ...(agent.note?.agent_type ? { type: agent.note.agent_type } : {}),
    ...(agent.note?.description ? { description: agent.note.description } : {}),
  });
  const startedBy = new Map<string, AgentRecords>();
  for (const agent of input.agents) {
    if (agent.note?.parent_tool_use_id) startedBy.set(agent.note.parent_tool_use_id, agent);
  }
  const placed = new Set<string>();
  // A session a sub-agent started: its provider says so, or another session's
  // records name it as their sub-agent. Nobody submits in it; like in a
  // sub-agent's records inside a session, a user message is a task.
  const agentStarted = input.record?.started_by === 'agent' || input.child;

  // The steps of one list of records. `top`: the session's own records, where a
  // person can submit; otherwise a sub-agent's, where a user message is its
  // task. `owner`: the id of the session or sub-agent whose records these are.
  const stepsOf = (records: ListedRecord[], top: boolean, owner: string): UsfStep[] => {
    const messages = new Map<string, MessageRecord>();
    const results = new Map<string, ToolResultRecord>();
    const brought = new Map<string, ToolResultRecord[]>();
    const calls = new Set<string>();
    const callsOf = new Map<string, ToolCallRecord[]>();
    for (const record of records) if (record.kind === 'message') messages.set(record.uuid, record);
    for (const record of records) {
      if (record.kind === 'tool_call') {
        calls.add(record.id);
        // Providers yield calls before, after or between the messages. Their
        // canonical message_uuid relationship, not their yield position,
        // determines where they belong in the session.
        if (messages.has(record.message_uuid)) {
          const list = callsOf.get(record.message_uuid);
          if (list) list.push(record); else callsOf.set(record.message_uuid, [record]);
        }
      }
      else if (record.kind === 'tool_result') {
        results.set(record.tool_use_id, record);
        const list = brought.get(record.message_uuid);
        if (list) list.push(record); else brought.set(record.message_uuid, [record]);
      }
    }
    // A message's model and usage go on one step only, the first made from it.
    const usageGiven = new Set<string>();
    const from = (message: MessageRecord | undefined): { model?: string; usage?: UsfUsage } => {
      if (!message) return {};
      const usage = usageGiven.has(message.uuid) ? null : usageOf(message);
      if (usage) usageGiven.add(message.uuid);
      return { ...(message.model ? { model: message.model } : {}), ...(usage ? { usage } : {}) };
    };

    const toolStep = (record: ToolCallRecord): UsfToolStep => {
      const message = messages.get(record.message_uuid);
      const result = results.get(record.id);
      // A sub-agent hangs on one call only, the first that names it.
      const started = startedBy.get(record.id);
      const agent = started && !placed.has(started.agentId) ? started : null;
      let input: unknown;
      try { input = JSON.parse(record.input_json); } catch { input = record.input_json ?? null; }
      const step: UsfToolStep = {
        by: 'agent', kind: 'tool', id: record.id, at: time(message?.timestamp),
        ...stateOf(message?.visibility),
        ...(message?.skill ? { skill: message.skill } : {}),
        ...from(message),
        ...(record.presentation === 'skill' ? { presentation: 'skill' as const } : {}),
        tool: { id: record.id, name: record.name, input },
      };
      // The file the call works on, as the provider worked it out.
      const file = record.file_path ?? result?.file_path;
      if (file) step.file = file;
      if (result) {
        step.result = {
          at: time(messages.get(result.message_uuid)?.timestamp),
          content: result.content ?? '',
          error: !!result.is_error,
        };
      }
      if (agent) {
        placed.add(agent.agentId);
        step.run = { agent: describe(agent), steps: stepsOf(agent.records, false, agent.agentId) };
      }
      return step;
    };
    // Where a step that has a time but no place of its own goes: before the
    // first step that is later, at the end when none is.
    const placeByTime = (steps: UsfStep[], step: UsfStep): void => {
      const at = step.at;
      const before = at === null ? -1 : steps.findIndex((other) => other.at !== null && Date.parse(other.at) > Date.parse(at));
      steps.splice(before < 0 ? steps.length : before, 0, step);
    };

    const steps: UsfStep[] = [];
    let lastHuman: { step: UsfHumanStep; uuid: string } | null = null;
    for (const record of records) {
      if (record.kind === 'message') {
        const base = {
          id: record.uuid,
          at: time(record.timestamp),
          ...stateOf(record.visibility),
          ...(record.skill ? { skill: record.skill } : {}),
        };
        const text = record.text ?? '';
        // What the provider says the harness wrote here. The assembly adds only
        // what the structure of the records shows: a task, a result without a call.
        const kind = record.harness_kind ?? null;
        const carried = brought.get(record.uuid) ?? [];
        if (record.content_type === 'tool_result') {
          // The message that brings tool results back has no step of its own:
          // the results hang on their calls, and its text, when it has one,
          // repeats them. Text that says something else is kept.
          if (text.trim() && !carried.some((result) => (result.content ?? '').trim() === text.trim())) {
            if (carried.length) stats.textOnResultMessage++;
            steps.push({ by: 'harness', ...base, kind: kind ?? (carried.length ? 'other' : 'result'), content: text });
          }
        } else if (record.role === 'user') {
          const person = top && !agentStarted && kind === null && !record.is_meta && !record.is_sidechain
            && (!record.agent_id || record.agent_id === record.session_id);
          if (!text) stats.emptyContent++;
          // Some providers give one record per part of a message (a text, then
          // an image). A message that directly follows a person's, at the same
          // instant and naming it as its parent, is another part of the same
          // submission, not a second submission.
          const last = steps[steps.length - 1];
          if (person && lastHuman && last === lastHuman.step && base.at !== null && base.at === last.at
            && base.state === last.state && record.parent_uuid === lastHuman.uuid) {
            lastHuman.step.content = [...parts(lastHuman.step.content), { type: 'text', text }];
            lastHuman.uuid = record.uuid;
            joined.push(record.uuid);
            stats.partsJoined++;
          } else if (person) {
            const step: UsfHumanStep = { by: 'human', ...base, content: text };
            steps.push(step);
            lastHuman = { step, uuid: record.uuid };
          } else {
            steps.push({
              by: 'harness', ...base,
              kind: kind ?? ((!top || agentStarted) && !record.is_meta ? 'task' : 'other'),
              content: text,
            });
          }
        } else if (record.role === 'assistant' && (kind !== null || record.is_meta)) {
          // Written in the agent's place by the harness (a notice, a failed
          // model call): not something the model said.
          steps.push({ by: 'harness', ...base, ...from(record), kind: kind ?? 'other', content: text });
        } else if (record.role === 'assistant') {
          // A message that only carries tool calls has no step of its own: the
          // calls are the steps. Any other message stays, also when no text
          // was kept for it: it still says that the model was called there.
          if (record.text != null || !callsOf.has(record.uuid)) {
            if (record.text == null) stats.emptyContent++;
            steps.push({
              by: 'agent', kind: record.content_type === 'thinking' ? 'reasoning' : 'text',
              ...base, ...from(record), content: text,
            });
          }
        } else {
          steps.push({ by: 'harness', ...base, kind: kind ?? 'other', content: text });
        }
        for (const made of callsOf.get(record.uuid) ?? []) steps.push(toolStep(made));
        // A result whose call is not among the records is kept where its message is.
        for (const result of carried) {
          if (calls.has(result.tool_use_id)) continue;
          stats.resultsWithoutCall++;
          steps.push({
            by: 'harness', id: result.tool_use_id, at: base.at, ...stateOf(record.visibility),
            kind: 'result', content: result.content ?? '',
            ...(result.is_error ? { extra: { error: true } } : {}),
          });
        }
      } else if (record.kind === 'tool_call') {
        // A call whose message is not among the records stays where it was yielded.
        if (!messages.has(record.message_uuid)) steps.push(toolStep(record));
      } else if (record.kind === 'tool_result' && !messages.has(record.message_uuid) && !calls.has(record.tool_use_id)) {
        stats.resultsWithoutCall++;
        steps.push({
          by: 'harness', kind: 'result', id: record.tool_use_id, at: null, content: record.content ?? '',
          ...(record.is_error ? { extra: { error: true } } : {}),
        });
      } else if (record.kind === 'summary') {
        const usage = usageOf(record);
        // A summary stays where the provider yielded it among the messages.
        // Its time cannot place it: a compaction summary stands before the
        // history it kept, and is written after it.
        steps.push({
          by: 'harness', id: record.id, at: time(record.timestamp), ...stateOf(record.visibility),
          ...(usage ? { usage } : {}),
          kind: record.source === 'away_summary' ? 'recap' : /compact/i.test(record.source ?? '') ? 'compaction' : 'other',
          content: record.content ?? '',
        });
      }
    }

    // Sub-agents of this session or agent that no call here started, as far as
    // the records say: each is a step of its own, put where its first step
    // falls in time. USF does not guess which call started it.
    for (const agent of input.agents) {
      if (placed.has(agent.agentId)) continue;
      if ((agent.note?.session_id ?? input.sessionId) !== owner) continue;
      placed.add(agent.agentId);
      stats.runsWithoutCall++;
      const inner = stepsOf(agent.records, false, agent.agentId);
      const at = inner.find((step) => step.at !== null)?.at ?? null;
      const step: UsfRunStep = { by: 'agent', kind: 'run', id: agent.agentId, at, run: { agent: describe(agent), steps: inner } };
      placeByTime(steps, step);
    }
    return steps;
  };

  const steps = stepsOf(input.main, true, input.sessionId);

  // A turn starts at each submission that is current. What comes before the
  // first one belongs to the first turn.
  const turns: UsfTurn[] = [];
  const submits = (step: UsfStep) => step.by === 'human' && !step.state;
  for (const step of steps) {
    if (submits(step) && !(turns.length === 1 && !turns[0].steps.some(submits))) turns.push({ steps: [] });
    if (!turns.length) turns.push({ steps: [] });
    turns[turns.length - 1].steps.push(step);
  }

  const source = input.record?.source
    ?? input.main.find((record): record is MessageRecord => record.kind === 'message')?.source
    ?? 'unknown';
  return {
    assembled: {
      session: {
        usf: USF_VERSION,
        harness: { name: source, ...(input.record?.version ? { version: input.record.version } : {}) },
        id: input.sessionId,
        title: input.record?.title ?? null,
        git_branch: input.record?.git_branch ?? null,
        ...(agentStarted ? { started_by: 'agent' as const } : {}),
        turns,
      },
      stats,
      joined,
      detached: false,
    },
    placed,
  };
}

/**
 * Assemble the sessions of a canonical record stream into USF, in local form.
 *
 * `records` are the records of every unit of the sessions concerned, each from
 * a fresh full parse (cursor = null), in the order the provider gave them.
 * Messages and summaries keep that order; calls follow their owning message.
 * Calls without a message retain their yield position. Unlinked subagent runs
 * are inserted by time without re-sorting the existing steps.
 */
export function assembleUsf(records: Iterable<TranscriptRecord>): UsfAssembly {
  const { sessions, duplicateMessages, notCarried } = groupRecords(records);
  const out: AssembledUsfSession[] = [];
  const placed = new Set<string>();
  const byId = new Map(sessions.map((session) => [session.sessionId, session]));
  // Assemble ancestors before descendants even when provider units arrive in
  // the opposite order. Otherwise detached grandchildren would be emitted twice.
  const ordered: SessionRecords[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (session: SessionRecords): void => {
    if (visited.has(session.sessionId)) return;
    if (visiting.has(session.sessionId)) throw new Error('USF assembly requires acyclic subagent session relationships');
    visiting.add(session.sessionId);
    const parent = session.parent === null ? undefined : byId.get(session.parent);
    if (parent) visit(parent);
    visiting.delete(session.sessionId);
    visited.add(session.sessionId);
    ordered.push(session);
  };
  for (const session of sessions) visit(session);
  for (const session of sessions) {
    if (session.child) continue;
    const result = assembleSession(session);
    out.push(result.assembled);
    for (const id of result.placed) placed.add(id);
  }
  // A child session is a run inside its parent. One whose parent is not among
  // the records stands alone.
  for (const session of ordered) {
    if (!session.child || placed.has(session.sessionId)) continue;
    const result = assembleSession(session);
    out.push({ ...result.assembled, detached: true });
    for (const id of result.placed) placed.add(id);
  }
  return { sessions: out, duplicateMessages, notCarried };
}

/** The published form of a session in local form: only the steps that are current. */
export function publishedUsf(session: UsfSession): UsfSession {
  const current = (steps: UsfStep[]): UsfStep[] => steps
    .filter((step) => !step.state)
    .map((step): UsfStep => (step.by === 'agent' && (step.kind === 'tool' || step.kind === 'run') && step.run
      ? { ...step, run: { ...step.run, steps: current(step.run.steps) } }
      : step));
  return {
    ...session,
    turns: session.turns.map((turn) => ({ ...turn, steps: current(turn.steps) })).filter((turn) => turn.steps.length > 0),
  };
}

/**
 * Check a value against the format. Returns the problems found, as text; an
 * empty list means it conforms. At most 50 problems are reported.
 */
export function validateUsf(value: unknown, { profile = 'local' }: { profile?: UsfProfile } = {}): string[] {
  const problems: string[] = [];
  const bad = (where: string, what: string) => { if (problems.length < 50) problems.push(`${where}: ${what}`); };
  const object = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
  const only = (where: string, v: unknown, required: readonly string[], optional: readonly string[]) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) bad(where, 'value is not an object');
    const fields = object(v);
    for (const key of required) if (!Object.hasOwn(fields, key)) bad(where, `"${key}" is missing`);
    for (const key of Object.keys(fields)) {
      if (!required.includes(key) && !optional.includes(key)) bad(where, `"${key}" is not a field of the format`);
    }
  };
  const textFields = (where: string, v: unknown, required: readonly string[], optional: readonly string[] = []) => {
    const fields = object(v);
    for (const key of [...required, ...optional.filter((key) => key in fields)]) {
      if (typeof fields[key] !== 'string') bad(where, `"${key}" is not text`);
    }
  };
  const time = (where: string, v: unknown) => { if (v !== null && !isUsfTime(v)) bad(where, '"at" is neither a time nor null'); };
  // Numbers are integers; text is well-formed Unicode.
  const ancestors = new Set<object>();
  let nonJson = false;
  const scalars = (where: string, v: unknown): void => {
    if (typeof v === 'number') { if (!Number.isSafeInteger(v)) bad(where, `${v} is not an integer`); }
    else if (typeof v === 'string') { if (LONE_SURROGATE.test(v)) bad(where, 'text is not well-formed Unicode'); }
    else if (v && typeof v === 'object') {
      if (ancestors.has(v)) { nonJson = true; bad(where, 'cyclic value is not JSON'); return; }
      ancestors.add(v);
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) scalars(`${where}[${i}]`, v[i]);
      } else {
        if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) { nonJson = true; bad(where, 'value is not a JSON object'); }
        for (const [key, item] of Object.entries(v)) {
          if (LONE_SURROGATE.test(key)) bad(where, 'key is not well-formed Unicode');
          scalars(`${where}.${key}`, item);
        }
      }
      ancestors.delete(v);
    } else if (v !== null && typeof v !== 'boolean') { nonJson = true; bad(where, 'value is not JSON'); }
  };
  // Reject non-JSON and cyclic input before walking recursive run structures.
  scalars('session', value);
  if (nonJson) return problems;
  const content = (where: string, v: unknown) => {
    if (typeof v === 'string') return;
    if (!Array.isArray(v)) { bad(where, 'content is neither text nor a list of parts'); return; }
    v.forEach((part, i) => {
      const at = `${where}[${i}]`;
      const fields = object(part);
      if (fields.type === 'text') {
        only(at, part, ['type', 'text'], []);
        textFields(at, part, ['text']);
      } else if (fields.type === 'image' || fields.type === 'file') {
        only(at, part, ['type', 'media_type', 'blob'], []);
        textFields(at, part, ['media_type']);
        only(`${at}.blob`, fields.blob, ['sha256', 'bytes'], []);
        const blob = object(fields.blob);
        if (typeof blob.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(blob.sha256)) bad(`${at}.blob`, '"sha256" is not a SHA-256 hex digest');
        if (!Number.isSafeInteger(blob.bytes) || (blob.bytes as number) < 0) bad(`${at}.blob`, '"bytes" is not a nonnegative integer');
      } else bad(at, 'unknown kind of part');
    });
  };
  const usage = (where: string, v: unknown) => {
    if (v === undefined) return;
    only(where, v, [], ['input', 'cached', 'output']);
    for (const [key, count] of Object.entries(object(v))) {
      if (!Number.isSafeInteger(count)) bad(where, `"${key}" is not an integer`);
    }
  };
  const masks = (where: string, step: Record<string, unknown>): string[] => {
    if (!('masks' in step)) return [];
    if (profile !== 'published') { bad(where, '"masks" is only allowed in the published form'); return ['masks']; }
    if (!Array.isArray(step.masks)) { bad(where, '"masks" is not a list'); return ['masks']; }
    step.masks.forEach((entry, i) => {
      const mask = object(entry);
      only(`${where}.masks[${i}]`, entry, ['in', 'at', 'n', 'rule'], ['path']);
      if (!(USF_MASK_FIELDS as readonly unknown[]).includes(mask.in)
        || !Number.isSafeInteger(mask.at) || (mask.at as number) < 0
        || !Number.isSafeInteger(mask.n) || (mask.n as number) < 1
        || typeof mask.rule !== 'string'
        || ('path' in mask && typeof mask.path !== 'string')) bad(`${where}.masks[${i}]`, 'not a valid mask entry');
    });
    return ['masks'];
  };
  const ids = new Set<unknown>();
  const run = (where: string, v: unknown) => {
    const fields = object(v);
    only(where, v, ['agent', 'steps'], []);
    only(`${where}.agent`, fields.agent, ['id'], ['type', 'description']);
    textFields(`${where}.agent`, fields.agent, ['id'], ['type', 'description']);
    checkSteps(where, fields.steps, false);
  };
  const checkSteps = (where: string, list: unknown, top: boolean): void => {
    if (!Array.isArray(list)) { bad(where, '"steps" is not a list'); return; }
    list.forEach((entry, i) => {
      const at = `${where}.steps[${i}]`;
      const step = object(entry);
      const extra = masks(at, step);
      textFields(at, step, ['id'], ['skill', 'model']);
      if ('extra' in step && (!step.extra || typeof step.extra !== 'object' || Array.isArray(step.extra))) bad(at, '"extra" is not an object');
      if (ids.has(step.id)) bad(at, `id "${String(step.id)}" is used twice`);
      ids.add(step.id);
      if (typeof step.id !== 'string') bad(at, '"id" is not text');
      time(at, step.at);
      if ('state' in step && (profile !== 'local' || (step.state !== 'inactive' && step.state !== 'hidden'))) {
        bad(at, `"state" ${JSON.stringify(step.state)} is not allowed here`);
      }
      if (step.by === 'human') {
        only(at, step, ['by', 'id', 'at', 'content'], ['state', 'skill', 'extra', ...extra]);
        content(at, step.content);
        if (!top) bad(at, 'a sub-agent run has a human step');
      } else if (step.by === 'harness') {
        only(at, step, ['by', 'id', 'at', 'kind', 'content'], ['state', 'skill', 'model', 'usage', 'extra', ...extra]);
        content(at, step.content);
        if (!(USF_HARNESS_KINDS as readonly unknown[]).includes(step.kind)) bad(at, `unknown kind ${JSON.stringify(step.kind)}`);
        usage(`${at}.usage`, step.usage);
      } else if (step.by === 'agent' && (step.kind === 'text' || step.kind === 'reasoning')) {
        only(at, step, ['by', 'kind', 'id', 'at', 'content'], ['state', 'skill', 'model', 'usage', 'extra', ...extra]);
        content(at, step.content);
        usage(`${at}.usage`, step.usage);
      } else if (step.by === 'agent' && step.kind === 'tool') {
        only(at, step, ['by', 'kind', 'id', 'at', 'tool'],
          ['state', 'skill', 'model', 'usage', 'presentation', 'file', 'result', 'run', 'extra', ...extra]);
        if ('presentation' in step && step.presentation !== 'skill') bad(at, `unknown presentation ${JSON.stringify(step.presentation)}`);
        if ('file' in step && typeof step.file !== 'string') bad(at, '"file" is not text');
        only(`${at}.tool`, step.tool, ['id', 'name', 'input'], []);
        textFields(`${at}.tool`, step.tool, ['id', 'name']);
        if ('result' in step) {
          const result = object(step.result);
          only(`${at}.result`, step.result, ['at', 'content', 'error'], []);
          time(`${at}.result`, result.at);
          content(`${at}.result`, result.content);
          if (typeof result.error !== 'boolean') bad(`${at}.result`, '"error" is not true or false');
        }
        if ('run' in step) run(`${at}.run`, step.run);
        usage(`${at}.usage`, step.usage);
      } else if (step.by === 'agent' && step.kind === 'run') {
        only(at, step, ['by', 'kind', 'id', 'at', 'run'], ['state', 'extra', ...extra]);
        run(`${at}.run`, step.run);
      } else {
        bad(at, `unknown step: by ${JSON.stringify(step.by)}, kind ${JSON.stringify(step.kind)}`);
      }
    });
  };

  const session = object(value);
  only('session', value, ['usf', 'harness', 'id', 'title', 'git_branch', 'turns'], ['started_by']);
  if ('started_by' in session && session.started_by !== 'agent') bad('session', `"started_by" ${JSON.stringify(session.started_by)} is not "agent"`);
  textFields('session', value, ['id']);
  for (const key of ['title', 'git_branch']) {
    if (session[key] !== null && typeof session[key] !== 'string') bad('session', `"${key}" is neither text nor null`);
  }
  if (session.usf !== USF_VERSION) bad('session', `version ${JSON.stringify(session.usf)} is not ${USF_VERSION}`);
  only('session.harness', session.harness, ['name'], ['version']);
  textFields('session.harness', session.harness, ['name'], ['version']);
  if (!Array.isArray(session.turns)) bad('session', '"turns" is not a list');
  const turns = Array.isArray(session.turns) ? session.turns : [];
  turns.forEach((entry, t) => {
    const where = `turns[${t}]`;
    const turn = object(entry);
    only(where, entry, ['steps'], profile === 'published' ? ['v', 'parent', 'id'] : []);
    if ('v' in turn && !Number.isSafeInteger(turn.v)) bad(where, '"v" is not an integer');
    if ('id' in turn && typeof turn.id !== 'string') bad(where, '"id" is not text');
    if ('parent' in turn && turn.parent !== null && typeof turn.parent !== 'string') bad(where, '"parent" is neither text nor null');
    checkSteps(where, turn.steps, true);
    const steps = Array.isArray(turn.steps) ? turn.steps : [];
    const starts = steps
      .map((step, i) => (object(step).by === 'human' && !object(step).state ? i : -1))
      .filter((i) => i >= 0);
    if (starts.length > 1) bad(where, 'more than one submission in a turn');
    if (starts.length > 0 && session.started_by === 'agent') bad(where, 'a session started by an agent has a human step');
    if (t > 0 && starts[0] !== 0) bad(where, 'a turn after the first does not start with a submission');
  });
  return problems;
}
