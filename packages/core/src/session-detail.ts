import type {
  TranscriptRecord,
  MessageVisibility,
  MessageRecord,
  SessionRecord,
  SummaryRecord,
  ToolCallRecord,
  ToolResultRecord,
  WorkflowAgentRecord,
  WorkflowRecord,
} from './providers/types.ts';

type WithoutKind<T extends { kind: string }> = Omit<T, 'kind'>;

export interface SessionDetailMessage {
  [key: string]: unknown;
  uuid: string;
  type: string | null;
  timestamp: string | null;
  text: string | null;
  content_type: string | null;
  is_meta: 0 | 1;
  session_id: string | null;
  cwd: string | null;
  turn_duration_ms: number | null;
}

export type SessionDetailToolResult = WithoutKind<ToolResultRecord>;

export interface SessionDetailWorkflowAgent {
  agent_id: string;
  phase: string | null;
  label: string | null;
  state: string | null;
  tokens: number | null;
  duration_ms: number | null;
}

export interface SessionDetailWorkflow {
  [key: string]: unknown;
  run_id: string;
  parent_tool_use_id: string | null;
  workflow_name: string | null;
  status: string | null;
  duration_ms: number | null;
  total_tokens: number | null;
  agent_count: number | null;
  agents: SessionDetailWorkflowAgent[];
}

export interface AssembledToolCall {
  id: string;
  name: string;
  presentation: 'default' | 'skill';
  input_json: string | null;
  result: SessionDetailToolResult | null;
  subagent?: {
    agent_id: string;
    agent_type: string | null;
    description: string | null;
  };
  workflow?: SessionDetailWorkflow;
}

export interface AssembledMessage extends SessionDetailMessage {
  [key: string]: unknown;
  tool_calls?: AssembledToolCall[];
  _thinking?: string;
  _skillMd?: string;
}

export interface SessionDetailSnapshot {
  session: SessionDetailSession | null;
  messages: AssembledMessage[];
  workflows: SessionDetailWorkflow[];
  summaries: SessionDetailSummary[];
}

export type SessionDetailSummary = WithoutKind<SummaryRecord> & Record<string, unknown>;

export type SessionDetailSession = Omit<WithoutKind<SessionRecord>, 'countMode'>;

export interface SessionDetailSessionRow {
  [key: string]: unknown;
  id: string;
  title?: string | null;
  project?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  git_branch?: string | null;
  version?: string | null;
  message_count?: number | null;
  jsonl_path?: string | null;
  source?: string | null;
}

export interface SessionMessageRow {
  [key: string]: unknown;
  uuid: string;
  session_id?: string | null;
  type?: string | null;
  role?: string | null;
  parent_uuid?: string | null;
  timestamp?: string | null;
  text?: string | null;
  content_type?: string | null;
  is_meta?: number | boolean | null;
  visibility?: string | null;
}

export interface SessionToolResultRow {
  [key: string]: unknown;
  tool_use_id: string;
  message_uuid?: string | null;
  session_id?: string | null;
  content?: string | null;
}

export interface SessionToolCallRow {
  [key: string]: unknown;
  id: string;
  message_uuid: string;
  session_id?: string | null;
  name: string;
  presentation?: string | null;
  input_json?: string | null;
}

export interface SessionSubagentRow {
  [key: string]: unknown;
  agent_id: string;
  session_id?: string | null;
  parent_tool_use_id?: string | null;
  agent_type?: string | null;
  description?: string | null;
}

export interface SessionWorkflowAgentRow {
  [key: string]: unknown;
  agent_id: string;
  run_id?: string | null;
  session_id?: string | null;
  phase?: string | null;
  label?: string | null;
  state?: string | null;
  tokens?: number | null;
  duration_ms?: number | null;
}

export interface SessionWorkflowRow {
  [key: string]: unknown;
  run_id: string;
  session_id?: string | null;
  parent_tool_use_id?: string | null;
  workflow_name?: string | null;
  status?: string | null;
  duration_ms?: number | null;
  total_tokens?: number | null;
  agent_count?: number | null;
  agents?: SessionWorkflowAgentRow[] | null;
}

export interface SessionSummaryRow {
  [key: string]: unknown;
  id: string | number;
  session_id?: string | null;
  visibility?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
}

export interface SessionDetailRows {
  session?: SessionDetailSessionRow | null;
  messages?: SessionMessageRow[];
  toolCalls?: SessionToolCallRow[];
  toolResults?: SessionToolResultRow[];
  subagents?: SessionSubagentRow[];
  workflows?: SessionWorkflowRow[];
  summaries?: SessionSummaryRow[];
}

function withoutKind<T extends { kind: string }>(record: T): WithoutKind<T> {
  const { kind: _kind, ...value } = record;
  return value;
}

function canonicalVisibility(value: unknown): MessageVisibility {
  if (value === null || value === undefined || value === 'visible') return 'visible';
  if (value === 'inactive') return 'inactive';
  return 'hidden';
}

function assembleMessages(
  messages: SessionDetailMessage[],
  toolCalls: ToolCallRecord[],
  toolResults: ToolResultRecord[],
  subagents: Extract<TranscriptRecord, { kind: 'subagent' }>[],
  workflows: SessionDetailWorkflow[],
): AssembledMessage[] {
  const visibleMessageUuids = new Set(messages.map((message) => message.uuid));
  const visibleToolCalls = toolCalls.filter((toolCall) => visibleMessageUuids.has(toolCall.message_uuid));
  const visibleToolResults = toolResults.filter((result) => visibleMessageUuids.has(result.message_uuid));
  const visibleCallIds = new Set(visibleToolCalls.map((toolCall) => toolCall.id));
  const attachedResultMessageUuids = new Set(
    visibleToolResults
      .filter((result) => visibleCallIds.has(result.tool_use_id))
      .map((result) => result.message_uuid),
  );
  const omitToolResultMessage = (message: SessionDetailMessage) => (
    message.content_type === 'tool_result'
    && (attachedResultMessageUuids.has(message.uuid) || !message.text)
  );
  const resultsByCallId = new Map<string, SessionDetailToolResult>();
  for (const result of visibleToolResults) {
    resultsByCallId.set(result.tool_use_id, withoutKind(result));
  }

  const subagentsByCallId = new Map<string, Extract<TranscriptRecord, { kind: 'subagent' }>>();
  for (const subagent of subagents) {
    if (subagent.parent_tool_use_id) subagentsByCallId.set(subagent.parent_tool_use_id, subagent);
  }

  const callsByMessageUuid = new Map<string, AssembledToolCall[]>();
  const workflowsByCallId = new Map(
    workflows
      .filter((workflow) => workflow.parent_tool_use_id)
      .map((workflow) => [workflow.parent_tool_use_id as string, workflow]),
  );
  for (const toolCall of visibleToolCalls) {
    const call: AssembledToolCall = {
      id: toolCall.id,
      name: toolCall.name,
      presentation: toolCall.presentation,
      input_json: toolCall.input_json,
      result: resultsByCallId.get(toolCall.id) ?? null,
    };
    const subagent = subagentsByCallId.get(toolCall.id);
    if (subagent) {
      call.subagent = {
        agent_id: subagent.agent_id,
        agent_type: subagent.agent_type ?? null,
        description: subagent.description ?? null,
      };
    }
    const workflow = workflowsByCallId.get(toolCall.id);
    if (workflow) call.workflow = workflow;
    const calls = callsByMessageUuid.get(toolCall.message_uuid) ?? [];
    calls.push(call);
    callsByMessageUuid.set(toolCall.message_uuid, calls);
  }

  const raw = messages.map((message): AssembledMessage => {
    const assembled: AssembledMessage = { ...message };
    const calls = callsByMessageUuid.get(message.uuid);
    if (calls?.length) assembled.tool_calls = calls;
    return assembled;
  });

  const output: AssembledMessage[] = [];
  for (let index = 0; index < raw.length; index++) {
    const message = raw[index];
    if (omitToolResultMessage(message)) continue;

    if (message.type === 'assistant' && message.content_type === 'thinking') {
      const thinkingParts = [message.text ?? ''];
      let nextIndex = index + 1;
      while (
        nextIndex < raw.length
        && raw[nextIndex].type === 'assistant'
        && raw[nextIndex].content_type === 'thinking'
      ) {
        thinkingParts.push(raw[nextIndex].text ?? '');
        nextIndex++;
      }
      if (
        nextIndex < raw.length
        && raw[nextIndex].type === 'assistant'
        && raw[nextIndex].content_type !== 'thinking'
      ) {
        raw[nextIndex]._thinking = thinkingParts.join('\n\n');
        index = nextIndex - 1;
        continue;
      }
      output.push({ ...message, text: thinkingParts.join('\n\n'), content_type: 'thinking' });
      index = nextIndex - 1;
      continue;
    }

    if (message.type === 'assistant' && message.content_type === 'tool_use') {
      const merged: AssembledMessage = {
        ...message,
        tool_calls: [...(message.tool_calls ?? [])],
      };
      const mergedCalls = merged.tool_calls ?? [];
      if (message._thinking) merged._thinking = message._thinking;
      const skillOnly = mergedCalls.length === 1 && mergedCalls[0].presentation === 'skill';
      let nextIndex = index + 1;
      while (nextIndex < raw.length) {
        const next = raw[nextIndex];
        if (omitToolResultMessage(next)) {
          nextIndex++;
          continue;
        }
        if (next.content_type === 'skill_instructions' && next.text) {
          merged._skillMd = next.text;
          nextIndex++;
          continue;
        }
        if (!skillOnly && next.type === 'assistant' && next.content_type === 'tool_use') {
          if (next.tool_calls) mergedCalls.push(...next.tool_calls);
          if (next.text && !merged.text) merged.text = next.text;
          nextIndex++;
          continue;
        }
        break;
      }
      output.push(merged);
      index = nextIndex - 1;
      continue;
    }

    const assembled: AssembledMessage = { ...message };
    if (message._thinking) assembled._thinking = message._thinking;
    if (message.type === 'assistant'
      && message.content_type !== 'tool_use'
      && message.content_type !== 'thinking') {
      if (!assembled.tool_calls) assembled.tool_calls = [];
      let nextIndex = index + 1;
      while (nextIndex < raw.length) {
        const next = raw[nextIndex];
        if (omitToolResultMessage(next)) {
          nextIndex++;
          continue;
        }
        if (next.type === 'assistant' && next.content_type === 'tool_use') {
          if (next.tool_calls) assembled.tool_calls.push(...next.tool_calls);
          nextIndex++;
          continue;
        }
        break;
      }
      if (!assembled.tool_calls.length) delete assembled.tool_calls;
      index = nextIndex - 1;
    }
    output.push(assembled);
  }

  return output;
}

/**
 * Project one canonical provider record stream into the app's session detail.
 * Provider-specific wire semantics must already be resolved before this seam.
 */
function assembleTranscriptRecords(records: Iterable<TranscriptRecord>): SessionDetailSnapshot {
  let session: SessionDetailSession | null = null;
  const messages: SessionDetailMessage[] = [];
  const messagesByUuid = new Map<string, SessionDetailMessage>();
  const mainMessageUuids = new Set<string>();
  const toolCalls: ToolCallRecord[] = [];
  const toolResults: ToolResultRecord[] = [];
  const subagents: Extract<TranscriptRecord, { kind: 'subagent' }>[] = [];
  const workflows: WorkflowRecord[] = [];
  const workflowAgentsById = new Map<string, WorkflowAgentRecord>();
  const summaries: SessionDetailSummary[] = [];

  for (const record of records) {
    switch (record.kind) {
      case 'session':
        if (record.countMode === 'delta') {
          throw new Error('Direct session detail assembly requires a fresh full parse (cursor = null), not a provider delta');
        }
        session = {
          id: record.id,
          title: record.title,
          project: record.project,
          started_at: record.started_at,
          ended_at: record.ended_at,
          git_branch: record.git_branch,
          version: record.version,
          message_count: record.message_count,
          jsonl_path: record.jsonl_path,
          source: record.source,
        };
        break;
      case 'message': {
        if (canonicalVisibility(record.visibility) !== 'visible') break;
        const message: SessionDetailMessage = {
          uuid: record.uuid,
          type: record.type || record.role,
          timestamp: record.timestamp,
          text: record.text,
          content_type: record.content_type,
          is_meta: record.is_meta,
          // Both kept per message, not per session: the working directory can change
          // mid-session, and the session id scopes which roots a file reference may resolve in.
          session_id: typeof record.session_id === 'string' ? record.session_id : null,
          cwd: typeof record.cwd === 'string' ? record.cwd : null,
          turn_duration_ms: typeof (record as MessageRecord & { turn_duration_ms?: unknown }).turn_duration_ms === 'number'
            ? (record as MessageRecord & { turn_duration_ms: number }).turn_duration_ms
            : null,
        };
        messages.push(message);
        messagesByUuid.set(message.uuid, message);
        if (record.agent_id === null) mainMessageUuids.add(message.uuid);
        break;
      }
      case 'tool_call':
        toolCalls.push(record);
        break;
      case 'tool_result':
        toolResults.push(record);
        break;
      case 'subagent':
        subagents.push(record);
        break;
      case 'workflow':
        workflows.push(record);
        break;
      case 'workflow_agent':
        workflowAgentsById.set(record.agent_id, {
          ...(workflowAgentsById.get(record.agent_id) ?? record),
          ...Object.fromEntries(
            Object.entries(record).filter(([, value]) => value !== null && value !== undefined),
          ),
        } as WorkflowAgentRecord);
        break;
      case 'summary':
        if (canonicalVisibility(record.visibility) !== 'visible') break;
        summaries.push(withoutKind(record));
        break;
      case 'message-turn-duration': {
        const message = messagesByUuid.get(record.uuid);
        if (message) message.turn_duration_ms = record.turn_duration_ms;
        break;
      }
      case 'delete-session':
        break;
    }
  }

  const assembledWorkflows: SessionDetailWorkflow[] = workflows.map((workflow) => {
    const agents = [...workflowAgentsById.values()]
      .filter((agent) => agent.run_id === workflow.run_id)
      .map((agent) => ({
        agent_id: agent.agent_id,
        phase: agent.phase ?? null,
        label: agent.label ?? null,
        state: agent.state ?? null,
        tokens: agent.tokens ?? null,
        duration_ms: agent.duration_ms ?? null,
      }));
    return {
      run_id: workflow.run_id,
      parent_tool_use_id: workflow.parent_tool_use_id ?? null,
      workflow_name: workflow.workflow_name,
      status: workflow.status,
      duration_ms: workflow.duration_ms,
      total_tokens: workflow.total_tokens,
      agent_count: workflow.agent_count ?? agents.length,
      agents,
    };
  });

  const detailMessages = session === null
    ? messages
    : messages.filter((message) => mainMessageUuids.has(message.uuid));
  detailMessages.sort((left, right) => {
    const leftTimestamp = left.timestamp ?? '';
    const rightTimestamp = right.timestamp ?? '';
    if (leftTimestamp !== rightTimestamp) return leftTimestamp < rightTimestamp ? -1 : 1;
    return left.uuid < right.uuid ? -1 : left.uuid > right.uuid ? 1 : 0;
  });

  return {
    session,
    messages: assembleMessages(detailMessages, toolCalls, toolResults, subagents, assembledWorkflows),
    workflows: assembledWorkflows,
    summaries,
  };
}

/** Adapt persisted rows back into the same canonical record language providers emit. */
function sessionDetailRecordsFromRows(input: SessionDetailRows): TranscriptRecord[] {
  const records: TranscriptRecord[] = [];
  if (input.session) {
    const session = input.session;
    records.push({
      kind: 'session',
      id: session.id,
      title: typeof session.title === 'string' ? session.title : null,
      project: typeof session.project === 'string' ? session.project : null,
      started_at: typeof session.started_at === 'string' ? session.started_at : null,
      ended_at: typeof session.ended_at === 'string' ? session.ended_at : null,
      git_branch: typeof session.git_branch === 'string' ? session.git_branch : null,
      version: typeof session.version === 'string' ? session.version : null,
      message_count: typeof session.message_count === 'number' ? session.message_count : 0,
      countMode: 'total',
      jsonl_path: typeof session.jsonl_path === 'string' ? session.jsonl_path : '',
      source: typeof session.source === 'string' ? session.source : '',
    });
  }
  for (const message of input.messages ?? []) {
    records.push({
      ...message,
      kind: 'message',
      uuid: message.uuid,
      session_id: typeof message.session_id === 'string' ? message.session_id : '',
      type: typeof message.type === 'string' ? message.type : typeof message.role === 'string' ? message.role : '',
      parent_uuid: typeof message.parent_uuid === 'string' ? message.parent_uuid : null,
      timestamp: typeof message.timestamp === 'string' ? message.timestamp : null,
      role: typeof message.role === 'string' ? message.role : null,
      text: typeof message.text === 'string' ? message.text : null,
      content_type: typeof message.content_type === 'string' ? message.content_type : null,
      is_meta: message.is_meta ? 1 : 0,
      visibility: canonicalVisibility(message.visibility),
      model: typeof message.model === 'string' ? message.model : null,
      is_sidechain: message.is_sidechain ? 1 : 0,
      agent_id: typeof message.agent_id === 'string' ? message.agent_id : null,
      input_tokens: typeof message.input_tokens === 'number' ? message.input_tokens : null,
      output_tokens: typeof message.output_tokens === 'number' ? message.output_tokens : null,
      cwd: typeof message.cwd === 'string' ? message.cwd : null,
      skill: typeof message.skill === 'string' ? message.skill : null,
      source: typeof message.source === 'string' ? message.source : '',
    });
  }
  for (const toolCall of input.toolCalls ?? []) {
    records.push({
      ...toolCall,
      kind: 'tool_call',
      id: toolCall.id,
      message_uuid: toolCall.message_uuid,
      session_id: typeof toolCall.session_id === 'string' ? toolCall.session_id : '',
      name: toolCall.name,
      presentation: toolCall.presentation === 'skill' ? 'skill' : 'default',
      input_json: typeof toolCall.input_json === 'string' ? toolCall.input_json : '',
      file_path: typeof toolCall.file_path === 'string' ? toolCall.file_path : null,
    });
  }
  for (const result of input.toolResults ?? []) {
    records.push({
      ...result,
      kind: 'tool_result',
      tool_use_id: result.tool_use_id,
      message_uuid: typeof result.message_uuid === 'string' ? result.message_uuid : '',
      session_id: typeof result.session_id === 'string' ? result.session_id : '',
      content: typeof result.content === 'string' ? result.content : '',
      file_path: typeof result.file_path === 'string' ? result.file_path : null,
      is_error: result.is_error ? 1 : 0,
    });
  }
  for (const subagent of input.subagents ?? []) {
    records.push({
      ...subagent,
      kind: 'subagent',
      agent_id: subagent.agent_id,
      session_id: typeof subagent.session_id === 'string' ? subagent.session_id : '',
      parent_tool_use_id: typeof subagent.parent_tool_use_id === 'string' ? subagent.parent_tool_use_id : null,
      agent_type: typeof subagent.agent_type === 'string' ? subagent.agent_type : null,
      description: typeof subagent.description === 'string' ? subagent.description : null,
      duration_ms: typeof subagent.duration_ms === 'number' ? subagent.duration_ms : null,
      total_tokens: typeof subagent.total_tokens === 'number' ? subagent.total_tokens : null,
    });
  }
  for (const workflow of input.workflows ?? []) {
    records.push({
      ...workflow,
      kind: 'workflow',
      run_id: workflow.run_id,
      session_id: typeof workflow.session_id === 'string' ? workflow.session_id : '',
      parent_tool_use_id: typeof workflow.parent_tool_use_id === 'string' ? workflow.parent_tool_use_id : null,
      task_id: typeof workflow.task_id === 'string' ? workflow.task_id : null,
      script: typeof workflow.script === 'string' ? workflow.script : null,
      result_json: typeof workflow.result_json === 'string' ? workflow.result_json : null,
      timestamp: typeof workflow.timestamp === 'string' ? workflow.timestamp : null,
      agent_count: typeof workflow.agent_count === 'number' ? workflow.agent_count : 0,
      duration_ms: typeof workflow.duration_ms === 'number' ? workflow.duration_ms : null,
      total_tokens: typeof workflow.total_tokens === 'number' ? workflow.total_tokens : null,
      status: typeof workflow.status === 'string' ? workflow.status : null,
      workflow_name: typeof workflow.workflow_name === 'string' ? workflow.workflow_name : null,
    });
    for (const agent of workflow.agents ?? []) {
      records.push({
        ...agent,
        kind: 'workflow_agent',
        agent_id: agent.agent_id,
        run_id: typeof agent.run_id === 'string' ? agent.run_id : workflow.run_id,
        session_id: typeof agent.session_id === 'string'
          ? agent.session_id
          : typeof workflow.session_id === 'string' ? workflow.session_id : '',
        ...(typeof agent.agent_type === 'string' ? { agent_type: agent.agent_type } : {}),
        ...(typeof agent.description === 'string' ? { description: agent.description } : {}),
        ...(typeof agent.phase === 'string' ? { phase: agent.phase } : {}),
        ...(typeof agent.label === 'string' ? { label: agent.label } : {}),
        ...(typeof agent.model === 'string' ? { model: agent.model } : {}),
        ...(typeof agent.state === 'string' ? { state: agent.state } : {}),
        ...(typeof agent.duration_ms === 'number' ? { duration_ms: agent.duration_ms } : {}),
        ...(typeof agent.tokens === 'number' ? { tokens: agent.tokens } : {}),
        ...(typeof agent.tool_calls === 'number' ? { tool_calls: agent.tool_calls } : {}),
      });
    }
  }
  for (const summary of input.summaries ?? []) {
    records.push({
      ...summary,
      kind: 'summary',
      id: String(summary.id),
      session_id: typeof summary.session_id === 'string' ? summary.session_id : '',
      timestamp: typeof summary.timestamp === 'string' ? summary.timestamp : null,
      source: typeof summary.source === 'string' ? summary.source : '',
      content: typeof summary.content === 'string' ? summary.content : '',
      visibility: canonicalVisibility(summary.visibility),
      input_tokens: typeof summary.input_tokens === 'number' ? summary.input_tokens : null,
      output_tokens: typeof summary.output_tokens === 'number' ? summary.output_tokens : null,
    });
  }
  return records;
}

/**
 * Assemble detail from either a provider's complete canonical transcript stream
 * (a fresh parse with cursor = null) or the same records after a persistence
 * round-trip. This is the only presentation seam.
 */
export function assembleSessionDetail(
  input: Iterable<TranscriptRecord> | SessionDetailRows,
): SessionDetailSnapshot {
  const records = Symbol.iterator in input
    ? input as Iterable<TranscriptRecord>
    : sessionDetailRecordsFromRows(input as SessionDetailRows);
  return assembleTranscriptRecords(records);
}
