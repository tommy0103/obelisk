// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Claude Code provider adapter in Core (see docs/adr/0001).
//
// Pure: discovers Claude transcript files and parses one into a record stream.
// It never touches the Obelisk database. The per-line logic mirrors the original
// indexJsonl exactly, but yields canonical TranscriptRecords instead of writing rows; the shared
// persist layer consumes them. Session aggregates here reflect only THIS chunk
// (started_at/ended_at/message_count); persist merges them with any existing row.

import { createHash } from 'node:crypto';
import { RetryableSourceReadError } from './source-read-error.ts';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, relative } from 'node:path';

import {
  extractText, extractContentType, extractMessageIsMeta, isSkillInstructions,
  filePath, trunc, truncJson, readLines, discoverJsonlFiles, isDir, sourceInventoryIssue,
} from '../parsing.ts';

import type {
  Cursor,
  DiscoverContext,
  TranscriptRecord,
  IndexUnit,
  ProviderAdapter,
  RawLookup,
  RawRecord,
} from './types.ts';

// Claude cursor encodes the file mtime and the number of lines already indexed:
// "<mtimeMs>:<linesProcessed>". mtime lets discovery detect change; lines lets
// parse resume without reprocessing.
function cursorToSkip(cursor: Cursor): number {
  if (!cursor) return 0;
  const n = Number(cursor.split(':')[1]);
  return Number.isFinite(n) ? n : 0;
}

// Cursor format: `${mtime}:${lines}:${size}:${ctimeMs}:${ino}`. The
// mtime+ctime+size+inode signature (CONTRIBUTING: cursors must detect
// same-millisecond rewrites) lets a same-mtime tail completion or a
// same-mtime replacement back into discovery. Legacy `${mtime}:${lines}`
// cursors keep the mtime-only gate and upgrade on the next parse.
function cursorSignatureDiffers(cursor: string, filePath: string): boolean {
  const stat = statSync(filePath);
  const parts = cursor.split(':');
  if (parts.length < 5) return Number(parts[0]) < stat.mtimeMs;
  return Number(parts[0]) !== stat.mtimeMs
    || Number(parts[2]) !== stat.size
    || Number(parts[3]) !== stat.ctimeMs
    || Number(parts[4]) !== stat.ino;
}

export const name = 'claude';
// v4: orphaned subagent transcripts now publish their session row. The marker
// moves so an install that already indexed those transcripts (and therefore
// holds their cursors) replays them once and gains the missing rows.
export const CLAUDE_CANONICAL_TRANSCRIPT_MARKER = '__claude_canonical_transcript_v4__';

interface ClaudeWorkflowUnitMeta {
  readonly kind: 'workflow';
  readonly mainTranscriptPath: string;
}

function totalInputTokens(usage: Record<string, unknown>): number | null {
  const fields = [
    'input_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
  ];
  let seen = false;
  let total = 0;
  for (const field of fields) {
    const value = usage[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    seen = true;
    total += value;
  }
  return seen ? total : null;
}

function discoverAt(rootDir: string, ctx: DiscoverContext): IndexUnit[] {
  const projectsDir = join(rootDir, 'projects');
  if (!existsSync(projectsDir) && (ctx.indexedSessions?.().length ?? 0) > 0) {
    ctx.reportIncompleteInventory?.({ path: projectsDir, error: 'Source folder is unavailable' });
  }
  const historyPath = normalize(join(rootDir, 'history.jsonl'));
  const historyTitles = new Map<string, string>();
  if (existsSync(historyPath)) {
    readLines(historyPath, (line: string) => {
      try {
        const item = JSON.parse(line);
        if (item?.sessionId && item?.title) historyTitles.set(item.sessionId, item.title);
      } catch { /* malformed history entry */ }
    });
  }
  const changedTranscriptPaths = new Set<string>();
  const changedWorkflowPaths = new Set<string>();
  const forcedPaths = new Set<string>();
  let historyChanged = false;
  for (const changedPath of ctx.changedPaths ?? []) {
    const rootRelative = isAbsolute(changedPath)
      ? normalize(changedPath)
      : normalize(join(rootDir, changedPath));
    if (rootRelative === historyPath) historyChanged = true;
    const absolute = isAbsolute(changedPath)
      ? normalize(changedPath)
      : normalize(join(projectsDir, changedPath));
    const inside = relative(projectsDir, absolute);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) continue;
    if (absolute.toLowerCase().endsWith('.meta.json')) {
      const transcript = absolute.slice(0, -'.meta.json'.length) + '.jsonl';
      changedTranscriptPaths.add(transcript);
      forcedPaths.add(transcript);
    } else if (absolute.toLowerCase().endsWith('.jsonl')) {
      changedTranscriptPaths.add(absolute);
    } else if (absolute.toLowerCase().endsWith('.json')) {
      changedWorkflowPaths.add(absolute);
    }
  }
  let inventoryComplete = true;
  const files = discoverJsonlFiles(projectsDir, issue => {
    inventoryComplete = false;
    ctx.reportIncompleteInventory?.(issue);
  });
  const orphanMembers = new Map<string, IndexUnit[]>();
  for (const file of files) {
    if (!file.isSubagent) continue;
    const mainPath = join(projectsDir, file.project, `${file.sessionId}.jsonl`);
    if (!transcriptProvedMissing(mainPath)) continue;
    const key = join(projectsDir, file.project, file.sessionId, 'subagents');
    const members = orphanMembers.get(key) ?? [];
    members.push({ key: file.path, sessionId: file.sessionId, project: file.project,
      isSubagent: true, agentId: file.agentId,
      meta: file.workflowRunId ? { workflowRunId: file.workflowRunId } : {} });
    orphanMembers.set(key, members);
  }
  const orphanPaths = new Set([...orphanMembers.values()].flatMap(members => members.map(unit => unit.key)));
  const orphanUnits: IndexUnit[] = [];
  for (const [key, members] of orphanMembers) {
    const member = members[0]!;
    if (!inventoryComplete) { ctx.retainSession?.(member.sessionId); continue; }
    const mainPath = join(dirname(key), '..', `${member.sessionId}.jsonl`);
    const mainCursor = ctx.previousCursor?.(normalize(mainPath)) ?? ctx.lastCursor(normalize(mainPath));
    let signature: string;
    try { signature = orphanFingerprint([...members.map(unit => unit.key), ...orphanWorkflowPaths(key)], mainCursor); }
    catch (error) {
      ctx.retainSession?.(member.sessionId);
      ctx.reportIncompleteInventory?.(sourceInventoryIssue(key, error));
      continue;
    }
    if (ctx.lastCursor(key) === signature) continue;
    orphanUnits.push({ key, sessionId: member.sessionId, project: member.project, retractSessionIds: [member.sessionId],
      meta: { kind: 'orphan-family', members, signature, mainPath: normalize(mainPath), mainCursor } satisfies ClaudeOrphanFamilyMeta });
  }
  const transcriptUnits = files.filter((file) => {
    if (orphanPaths.has(file.path)) return false;
    const normalizedPath = normalize(file.path);
    if (ctx.changedPaths !== undefined && !historyChanged && !changedTranscriptPaths.has(normalizedPath)) return false;
    const cursor = ctx.lastCursor(file.path);
    return historyChanged
      || forcedPaths.has(normalizedPath)
      || cursor === null
      || cursorSignatureDiffers(cursor, file.path);
  }).map((f: any) => ({
    key: f.path,
    sessionId: f.sessionId,
    project: f.project,
    isSubagent: f.isSubagent,
    agentId: f.agentId,
    meta: {
      ...(f.workflowRunId ? { workflowRunId: f.workflowRunId } : {}),
      ...(historyTitles.has(f.sessionId) ? { historyTitle: historyTitles.get(f.sessionId) } : {}),
    },
  }));

  const workflowUnits: IndexUnit[] = [];
  if (!existsSync(projectsDir)) return [...transcriptUnits, ...orphanUnits];
  let projects: string[];
  try { projects = readdirSync(projectsDir); } catch (error) {
    ctx.reportIncompleteInventory?.(sourceInventoryIssue(projectsDir, error));
    return [...transcriptUnits, ...orphanUnits];
  }
  for (const project of projects) {
    const projectPath = join(projectsDir, project);
    if (!isDir(projectPath)) continue;
    let sessionIds: string[];
    try { sessionIds = readdirSync(projectPath); } catch (error) {
      ctx.reportIncompleteInventory?.(sourceInventoryIssue(projectPath, error));
      continue;
    }
    for (const sessionId of sessionIds) {
      const workflowDir = join(projectPath, sessionId, 'workflows');
      if (!isDir(workflowDir)) continue;
      const mainTranscriptPath = join(projectPath, `${sessionId}.jsonl`);
      let files: string[];
      try { files = readdirSync(workflowDir); } catch (error) {
        ctx.reportIncompleteInventory?.(sourceInventoryIssue(workflowDir, error));
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const workflowPath = join(workflowDir, file);
        const normalizedPath = normalize(workflowPath);
        const relationshipChanged = changedTranscriptPaths.has(normalize(mainTranscriptPath));
        if (
          ctx.changedPaths !== undefined
          && !changedWorkflowPaths.has(normalizedPath)
          && !relationshipChanged
        ) continue;
        const mtime = statSync(workflowPath).mtimeMs;
        const cursor = ctx.lastCursor(workflowPath);
        if (!relationshipChanged && cursor !== null && Number(cursor.split(':')[0]) >= mtime) continue;
        workflowUnits.push({
          key: workflowPath,
          sessionId,
          project,
          meta: { kind: 'workflow', mainTranscriptPath } satisfies ClaudeWorkflowUnitMeta,
        });
      }
    }
  }
  return [...transcriptUnits, ...orphanUnits, ...workflowUnits.filter(unit =>
    !orphanMembers.has(join(projectsDir, unit.project!, unit.sessionId, 'subagents')))];
}

export function discover(ctx: DiscoverContext): IndexUnit[] {
  return discoverAt(join(homedir(), '.claude'), ctx);
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => typeof part?.text === 'string' ? part.text : '').join('\n');
}

function workflowParentToolUseId(
  transcriptPath: string,
  runId: string,
): string | null {
  if (!existsSync(transcriptPath)) return null;
  const workflowToolIds = new Set<string>();
  let parentToolUseId: string | null = null;
  readLines(transcriptPath, (line: string) => {
    let record: any;
    try { record = JSON.parse(line); } catch { return; }
    const content = record?.message?.content;
    if (!Array.isArray(content)) return;
    if (record.type === 'assistant') {
      for (const block of content) {
        if (block?.type === 'tool_use' && block?.name === 'Workflow' && typeof block.id === 'string') {
          workflowToolIds.add(block.id);
        }
      }
      return;
    }
    if (record.type !== 'user') return;
    for (const block of content) {
      if (block?.type !== 'tool_result' || !workflowToolIds.has(block.tool_use_id)) continue;
      const text = toolResultText(block.content);
      if (!text.includes(runId)) continue;
      parentToolUseId = block.tool_use_id;
      return false;
    }
  });
  return parentToolUseId;
}

function* parseWorkflow(unit: IndexUnit): Generator<TranscriptRecord, Cursor> {
  const mtime = statSync(unit.key).mtimeMs;
  const outCursor = `${mtime}:1`;
  let workflow: any;
  try { workflow = JSON.parse(readFileSync(unit.key, 'utf8')); } catch { return outCursor; }
  if (!workflow?.runId) return outCursor;
  const meta = unit.meta as ClaudeWorkflowUnitMeta;
  const progress = Array.isArray(workflow.workflowProgress) ? workflow.workflowProgress : [];
  const agents = progress.filter((item: any) => item?.type === 'workflow_agent' && item.agentId);
  yield {
    kind: 'workflow',
    run_id: workflow.runId,
    session_id: unit.sessionId,
    parent_tool_use_id: workflowParentToolUseId(
      meta.mainTranscriptPath,
      workflow.runId,
    ),
    task_id: workflow.taskId || null,
    script: workflow.script || null,
    result_json: workflow.result ? JSON.stringify(workflow.result) : null,
    timestamp: workflow.timestamp || null,
    agent_count: agents.length,
    duration_ms: workflow.durationMs || null,
    total_tokens: workflow.totalTokens || null,
    status: workflow.status || null,
    workflow_name: workflow.workflowName || null,
  };
  for (const item of agents) {
    yield {
      kind: 'workflow_agent',
      agent_id: `agent-${item.agentId}`,
      run_id: workflow.runId,
      session_id: unit.sessionId,
      phase: item.phaseTitle || null,
      label: item.label || null,
      model: item.model || null,
      state: item.state || null,
      duration_ms: item.durationMs || null,
      tokens: item.tokens || null,
      tool_calls: item.toolCalls || null,
    };
  }
  return outCursor;
}

export function* parse(unit: IndexUnit, cursor: Cursor): Generator<TranscriptRecord, Cursor> {
  if ((unit.meta as ClaudeOrphanFamilyMeta | undefined)?.kind === 'orphan-family') {
    return yield* parseOrphanFamily(unit, cursor);
  }
  if ((unit.meta as ClaudeWorkflowUnitMeta | undefined)?.kind === 'workflow') {
    return yield* parseWorkflow(unit);
  }
  const skip = cursorToSkip(cursor);
  const stat = statSync(unit.key);
  const mtime = stat.mtimeMs;
  const isSubagent = unit.isSubagent === true;
  const records: TranscriptRecord[] = [];
  const historyTitle = ((unit.meta as { historyTitle?: string } | undefined)?.historyTitle ?? null) as string | null;
  let aiTitle: string | null = null;
  let customTitle: string | null = null;
  const sm = {
    started_at: null as string | null,
    ended_at: null as string | null,
    git_branch: null as string | null,
    version: null as string | null,
    n: 0,
  };
  const subagentStats = {
    startedAt: null as string | null,
    endedAt: null as string | null,
    totalTokens: 0,
  };

  let lineNum = 0;
  // Lines the cursor may safely skip on the next parse. A line only counts
  // when it parsed, or when it is newline-terminated (mid-file garbage keeps
  // the legacy count). An unterminated tail that fails to parse may still be
  // growing — counting it would permanently skip the completed line.
  let cursorLines = 0;
  readLines(unit.key, (line: string, terminated: boolean) => {
    lineNum++;
    let obj: any;
    let parsed = true;
    try { obj = JSON.parse(line); } catch { parsed = false; }
    if (parsed || terminated) cursorLines = lineNum;
    if (!parsed) return;
    const sid = unit.sessionId;
    const ts = obj.timestamp || null;
    const msg = obj.message || {};
    const usage = msg.usage || {};

    // Claude Code now persists app-, CLI-, and hook-assigned session names as
    // `custom-title` records. Scan title metadata across the whole transcript,
    // including cursor-skipped lines, so incremental parses retain the intended
    // precedence without depending on the previously persisted title.
    if (obj.type === 'custom-title' && obj.customTitle) {
      customTitle = obj.customTitle;
      return;
    }
    if (obj.type === 'ai-title' && obj.aiTitle) {
      aiTitle = obj.aiTitle;
      return;
    }

    if (isSubagent && (obj.type === 'user' || obj.type === 'assistant')) {
      if (ts && (!subagentStats.startedAt || ts < subagentStats.startedAt)) subagentStats.startedAt = ts;
      if (ts && (!subagentStats.endedAt || ts > subagentStats.endedAt)) subagentStats.endedAt = ts;
      subagentStats.totalTokens += (totalInputTokens(usage) ?? 0) + (usage.output_tokens ?? 0);
    }
    if (lineNum <= skip) return;

    if (obj.type === 'system' && obj.subtype === 'away_summary' && obj.content) {
      records.push({ kind: 'summary', id: obj.uuid || `${sid}-away-${ts}`, session_id: sid, timestamp: ts, source: 'away_summary', content: obj.content });
      return;
    }
    if (obj.type === 'system' && obj.subtype === 'turn_duration' && obj.parentUuid && obj.durationMs) {
      records.push({ kind: 'message-turn-duration', uuid: obj.parentUuid, turn_duration_ms: obj.durationMs });
      return;
    }
    if (obj.type !== 'user' && obj.type !== 'assistant') return;

    if (ts && (!sm.started_at || ts < sm.started_at)) sm.started_at = ts;
    if (ts && (!sm.ended_at || ts > sm.ended_at)) sm.ended_at = ts;
    if (obj.gitBranch) sm.git_branch = obj.gitBranch;
    if (obj.version) sm.version = obj.version;
    sm.n++;

    const text = extractText(msg.content);
    const rawContentType = extractContentType(msg.content);
    const isMeta = extractMessageIsMeta(obj, text);
    const contentType = isMeta && isSkillInstructions(text) ? 'skill_instructions' : rawContentType;
    const aid = isSubagent ? (unit.agentId ?? null) : (obj.agentId || null);

    if (obj.uuid) {
      records.push({
        kind: 'message', uuid: obj.uuid, session_id: sid, type: obj.type,
        parent_uuid: obj.parentUuid || null, timestamp: ts, role: msg.role || obj.type,
        text, content_type: contentType, is_meta: (isMeta ? 1 : 0), visibility: 'visible',
        model: msg.model || null,
        is_sidechain: obj.isSidechain ? 1 : 0, agent_id: aid,
        input_tokens: totalInputTokens(usage), output_tokens: usage.output_tokens || null,
        cwd: obj.cwd || null, skill: obj.attributionSkill || null, source: 'claude',
      });
    }

    if (obj.type === 'assistant' && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type === 'tool_use' && b.id)
          records.push({ kind: 'tool_call', id: b.id, message_uuid: obj.uuid, session_id: sid, name: b.name, presentation: b.name === 'Skill' ? 'skill' : 'default', input_json: truncJson(b.input || {}) as string, file_path: filePath(b.name, b.input) });
      }
    }

    if (obj.type === 'user' && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type !== 'tool_result' || !b.tool_use_id) continue;
        const rt = typeof b.content === 'string' ? b.content
          : Array.isArray(b.content) ? b.content.map((c: any) => c.text || '').join('\n') : '';
        records.push({ kind: 'tool_result', tool_use_id: b.tool_use_id, message_uuid: obj.uuid, session_id: sid, content: trunc(rt), file_path: obj.toolUseResult?.filePath || null, is_error: b.is_error ? 1 : 0 });
      }
    }
  });

  if (isSubagent && unit.agentId) {
    const metaPath = unit.key.replace(/\.jsonl$/, '.meta.json');
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
        const workflowRunId = (unit.meta as { workflowRunId?: string } | undefined)?.workflowRunId;
        if (workflowRunId) {
          records.push({
            kind: 'workflow_agent',
            agent_id: unit.agentId,
            run_id: workflowRunId,
            session_id: unit.sessionId,
            agent_type: meta.agentType || null,
            description: meta.description || null,
          });
        } else {
          const started = subagentStats.startedAt ? new Date(subagentStats.startedAt).getTime() : null;
          const ended = subagentStats.endedAt ? new Date(subagentStats.endedAt).getTime() : null;
          records.push({
            kind: 'subagent',
            agent_id: unit.agentId,
            session_id: unit.sessionId,
            parent_tool_use_id: meta.toolUseId || null,
            agent_type: meta.agentType || null,
            description: meta.description || null,
            duration_ms: started !== null && ended !== null ? ended - started : null,
            total_tokens: subagentStats.totalTokens,
          });
        }
      } catch { /* malformed optional subagent metadata */ }
    }
  }

  // Subagent transcripts do not own a session row while their main transcript
  // exists (matches indexJsonl). Claude can leave a session directory behind
  // holding nothing but `subagents/` — the parent `<sessionId>.jsonl` was
  // cleaned up or never flushed — and then no unit would ever publish that
  // session: its records land in messages while the session itself disappears
  // from the catalogue, from session detail, and from every statement that
  // joins sessions. The subagent transcript is the only surviving witness, so
  // it publishes the row. Fresh per-unit snapshots use total counts so they
  // remain canonical detail input; appends use deltas. Finalization reconciles
  // the orphan family count from all stored sibling contributions.
  const mainTranscriptPath = isSubagent ? mainTranscriptPathOf(unit) : null;
  const orphanedSubagent = mainTranscriptPath !== null && transcriptProvedMissing(mainTranscriptPath);
  if (!isSubagent || orphanedSubagent) {
    records.push({
      kind: 'session',
      id: unit.sessionId,
      title: isSubagent ? null : (customTitle ?? aiTitle ?? historyTitle),
      project: unit.project || null,
      started_at: sm.started_at,
      ended_at: sm.ended_at,
      git_branch: isSubagent ? null : sm.git_branch,
      version: isSubagent ? null : sm.version,
      message_count: sm.n,
      countMode: skip > 0 ? 'delta' : 'total',
      jsonl_path: mainTranscriptPath ?? unit.key,
      source: 'claude',
    });
  }

  yield* records;
  return `${mtime}:${cursorLines}:${stat.size}:${stat.ctimeMs}:${stat.ino}`;
}

/**
 * The main transcript a subagent transcript belongs to.
 *
 * Subagent units live at `<project>/<sessionId>/subagents[/workflows/<run>]/<agent>.jsonl`,
 * so the owning session file is `<project>/<sessionId>.jsonl` — which is not
 * necessarily on disk any more (see the orphaned-subagent branch in parse).
 */
interface ClaudeOrphanFamilyMeta {
  kind: 'orphan-family';
  members: IndexUnit[];
  signature: string;
  mainPath: string;
  mainCursor: Cursor;
}

function orphanFingerprint(paths: string[], mainCursor: Cursor): string {
  const signature = [...paths].sort().map(path => {
    const stat = statSync(path);
    const sidecar = path.endsWith('.jsonl') ? path.replace(/\.jsonl$/, '.meta.json') : null;
    let metaSignature: number[] | null = null;
    try { const meta = sidecar === null ? null : statSync(sidecar); metaSignature = meta === null ? null : [meta.mtimeMs, meta.ctimeMs, meta.size, meta.ino]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return [path, stat.mtimeMs, stat.ctimeMs, stat.size, stat.ino, stat.dev, metaSignature];
  });
  return `claude-orphan-v1:${createHash('sha256').update(JSON.stringify([signature, mainCursor])).digest('hex')}`;
}

function orphanMemberPaths(directory: string): string[] {
  const paths = readdirSync(directory).filter(name => name.endsWith('.jsonl')).map(name => join(directory, name));
  const workflows = join(directory, 'workflows');
  let runs: string[];
  try { runs = readdirSync(workflows); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return paths; throw error; }
  for (const run of runs) {
    const runPath = join(workflows, run);
    if (!statSync(runPath).isDirectory()) continue;
    for (const name of readdirSync(runPath)) if (name.endsWith('.jsonl')) paths.push(join(runPath, name));
  }
  return paths;
}

function orphanWorkflowPaths(directory: string): string[] {
  const workflows = join(dirname(directory), 'workflows');
  try { return readdirSync(workflows).filter(name => name.endsWith('.json')).map(name => join(workflows, name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}

function* parseOrphanFamily(unit: IndexUnit, _cursor: Cursor): Generator<TranscriptRecord, Cursor> {
  const meta = unit.meta as ClaudeOrphanFamilyMeta;
  const verify = () => {
    if (!transcriptProvedMissing(meta.mainPath)
      || orphanFingerprint([...orphanMemberPaths(unit.key), ...orphanWorkflowPaths(unit.key)], meta.mainCursor) !== meta.signature) {
      throw new RetryableSourceReadError(unit.key, 'Orphan transcript family changed during snapshot');
    }
  };
  verify();
  const records: TranscriptRecord[] = [];
  const sessions: Extract<TranscriptRecord, { kind: 'session' }>[] = [];
  for (const member of meta.members) {
    const sidecar = member.key.replace(/\.jsonl$/, '.meta.json');
    try {
      const data = JSON.parse(readFileSync(sidecar, 'utf8'));
      if (data === null || typeof data !== 'object' || Array.isArray(data)
        || (data.agentType !== undefined && typeof data.agentType !== 'string')
        || (data.description !== undefined && typeof data.description !== 'string')) {
        throw new Error('Orphan subagent metadata has no stable object shape');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new RetryableSourceReadError(sidecar, 'Orphan subagent metadata is incomplete or invalid', { cause: error });
      }
    }
    let hasJson = false;
    readLines(member.key, (line, terminated) => {
      if (!line.trim()) return;
      try { JSON.parse(line); hasJson = true; }
      catch { throw new RetryableSourceReadError(member.key, terminated ? 'Malformed orphan transcript' : 'Incomplete orphan transcript'); }
    });
    if (!hasJson) throw new RetryableSourceReadError(member.key, 'Orphan transcript has no stable records');
    for (const record of parse(member, null)) {
      if (record.kind === 'session') sessions.push(record);
      else records.push(record);
    }
  }
  for (const path of orphanWorkflowPaths(unit.key)) {
    const workflow = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof workflow?.runId !== 'string' || !workflow.runId) {
      throw new RetryableSourceReadError(path, 'Orphan workflow has no stable identity');
    }
    records.push(...parseWorkflow({ key: path, sessionId: unit.sessionId, project: unit.project,
      meta: { kind: 'workflow', mainTranscriptPath: meta.mainPath } satisfies ClaudeWorkflowUnitMeta }));
  }
  verify();
  yield* records;
  const timestamps = sessions.flatMap(session => [session.started_at, session.ended_at]).filter((value): value is string => value !== null).sort();
  yield {
    kind: 'session', id: unit.sessionId, title: null, project: unit.project ?? null,
    started_at: timestamps[0] ?? null, ended_at: timestamps.at(-1) ?? null,
    git_branch: null, version: null,
    message_count: new Set(records.filter(record => record.kind === 'message').map(record => record.uuid)).size,
    countMode: 'total', jsonl_path: meta.mainPath, source: 'claude',
  };
  return meta.signature;
}

function mainTranscriptPathOf(unit: IndexUnit): string | null {
  // Match the owning session directory rather than the first ancestor named
  // subagents (the user's home or project can legally contain that name).
  let directory = dirname(unit.key);
  while (dirname(directory) !== directory) {
    const parent = dirname(directory);
    if (basename(directory) === 'subagents' && basename(parent) === unit.sessionId) {
      return join(dirname(parent), `${unit.sessionId}.jsonl`);
    }
    directory = parent;
  }
  return null;
}

function transcriptProvedMissing(path: string): boolean {
  try { statSync(path); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
}

function rawClaude(input: RawLookup): RawRecord | null {
  const mainPath = typeof input.session?.jsonl_path === 'string' ? input.session.jsonl_path : null;
  if (mainPath === null) return null;
  let sourcePath = mainPath;
  if (input.agentId !== null) {
    const runId = input.workflowAgent?.['run_id'];
    sourcePath = typeof runId === 'string'
      ? join(dirname(mainPath), String(input.session?.id ?? ''), 'subagents', 'workflows', runId, `${input.agentId}.jsonl`)
      : join(dirname(mainPath), String(input.session?.id ?? ''), 'subagents', `${input.agentId}.jsonl`);
  }
  if (!existsSync(sourcePath)) return null;
  let found: string | null = null;
  readLines(sourcePath, (line: string) => {
    if (!line.includes(input.messageUuid)) return;
    try {
      if (JSON.parse(line)?.uuid === input.messageUuid) {
        found = line;
        return false;
      }
    } catch { /* malformed source line */ }
  });
  const raw = found as string | null;
  let messageText: string | null = null;
  if (raw !== null) {
    try {
      const content = JSON.parse(raw)?.message?.content;
      if (typeof content === 'string') messageText = content;
      else if (Array.isArray(content)) {
        const parts = content.map((part) => part?.text ?? part?.thinking).filter((part) => typeof part === 'string');
        messageText = parts.length > 0 ? parts.join('\n') : null;
      }
    } catch { /* malformed source line */ }
  }
  return raw === null
    ? null
    : { text: raw, totalLength: raw.length, offset: 0, limit: raw.length, hasMore: false, messageText };
}

export function createClaudeProvider({ rootDir = join(homedir(), '.claude') }: { rootDir?: string } = {}): ProviderAdapter {
  return {
    name,
    descriptor: { id: name, name: 'Claude Code', vendor: 'Anthropic', defaultRoot: rootDir, color: '#d97757' },
    indexVersionMarker: CLAUDE_CANONICAL_TRANSCRIPT_MARKER,
    watchTargets: (configuredRoot) => [
      { kind: 'tree', path: join(configuredRoot, 'projects') },
      { kind: 'file', path: join(configuredRoot, 'history.jsonl') },
    ],
    discover: (ctx) => discoverAt(rootDir, ctx),
    parse,
    raw: rawClaude,
  };
}

export const claudeProvider = createClaudeProvider();
