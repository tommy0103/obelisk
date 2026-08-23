// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Core's pure parse/discover helpers — node:sqlite-free by construction, so the compiled
// providers can be consumed by the app (better-sqlite3 / a Node without
// node:sqlite). Originally extracted verbatim from db/indexer; it now exposes a
// typed seam while remaining limited to node:fs/path/os.
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';

import type { InventoryIssue } from './providers/types.ts';

const CLAUDE_DIR = join(homedir(), '.claude');
const CODEX_DIR = join(homedir(), '.codex');
const PROJECTS_DIR = join(CLAUDE_DIR, 'projects');
const CODEX_SESSIONS_DIR = join(CODEX_DIR, 'sessions');
const TEXT_LIMIT = 10000;

type JsonRecord = Record<string, any>;
type JsonValue = any;

function sourceInventoryIssue(path: string, error: unknown): InventoryIssue {
  return { path, error: error instanceof Error ? error.message : String(error) };
}

type DiscoveryIssueHandler = (issue: InventoryIssue) => void;

export interface ClaudeJsonlFile {
  path: string;
  sessionId: string;
  project: string;
  isSubagent: boolean;
  agentId?: string;
  workflowRunId?: string;
  source?: 'claude';
}

export interface CodexJsonlFile {
  path: string;
  source: 'codex';
}

interface CodexLineRecord {
  lineNum: number;
  obj: JsonRecord;
}

// ---- message/text helpers ----
function trunc(s: any): any {
  return typeof s === 'string' && s.length > TEXT_LIMIT ? s.slice(0, TEXT_LIMIT) : s;
}

function truncJson(obj: JsonValue, limit = TEXT_LIMIT): string | null {
  if (obj === null || obj === undefined) return null;
  const walk = (v: JsonValue): JsonValue => {
    if (typeof v === 'string') return v.length > limit ? v.slice(0, limit) + '...[truncated]' : v;
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === 'object' && v !== null) {
      const out: JsonRecord = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(obj));
}

function extractText(content: JsonValue): string | null {
  if (typeof content === 'string') return trunc(content);
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const b of content) {
    if (b.type === 'text' && b.text) parts.push(b.text);
    else if (b.type === 'thinking' && b.thinking) parts.push(b.thinking);
  }
  return parts.length ? trunc(parts.join('\n')) : null;
}

function extractContentType(content: JsonValue): string {
  if (typeof content === 'string') return 'text';
  if (!Array.isArray(content) || !content.length) return 'unknown';
  const types = new Set<string>();
  let sawUnknown = false;
  for (const b of content) {
    if (!b || typeof b !== 'object') { sawUnknown = true; continue; }
    if (b.type === 'text') types.add('text');
    else if (b.type === 'thinking') types.add('thinking');
    else if (b.type === 'tool_use') types.add('tool_use');
    else if (b.type === 'tool_result') types.add('tool_result');
    else sawUnknown = true;
  }
  return !sawUnknown && types.size === 1 ? [...types][0] : 'unknown';
}

const COMMAND_ENVELOPE_RE = /^\s*(<command-name>[^<]+<\/command-name>|<(?:task-notification|system-reminder)\b|<local-command(?:\b|-))/;
const SKILL_INSTRUCTIONS_RE = /^\s*Base directory for this skill(?:\s*:|\s*\r?\n)/;

function extractMessageIsMeta(record: JsonRecord, text: string | null = extractText(record?.message?.content)): 0 | 1 {
  const msg = record?.message || {};
  if (record?.isMeta === true || msg.isMeta === true) return 1;
  return typeof text === 'string' && COMMAND_ENVELOPE_RE.test(text) ? 1 : 0;
}

function isSkillInstructions(text: unknown): boolean {
  return typeof text === 'string' && SKILL_INSTRUCTIONS_RE.test(text);
}

function filePath(name: string, input: JsonRecord | null | undefined): string | null {
  if (!input) return null;
  return ['Read', 'Edit', 'Write', 'NotebookEdit'].includes(name) ? (input.file_path || null) : null;
}

function isDir(p: string): boolean { try { return statSync(p).isDirectory(); } catch { return false; } }

function readLines(filePath: string, callback: (line: string) => boolean | void): void {
  const fd = openSync(filePath, 'r');
  const bufSize = 64 * 1024;
  const buf = Buffer.alloc(bufSize);
  let remainder = '';
  let bytesRead;
  try {
    while ((bytesRead = readSync(fd, buf, 0, bufSize, null)) > 0) {
      const lines = buf.toString('utf8', 0, bytesRead).split('\n');
      lines[0] = remainder + lines[0];
      remainder = lines.pop() ?? '';
      for (const line of lines) {
        if (line && callback(line) === false) return;
      }
    }
    if (remainder) callback(remainder);
  } finally {
    closeSync(fd);
  }
}

// ---- project-path + discovery helpers ----
function legacyProjectPathFromSlug(project: string | null | undefined): string | null {
  if (!project) return null;
  return '/' + project.replace(/-/g, '/').replace(/^\//, '');
}

function normalizeObservedCwd(cwd: unknown): string | null {
  if (typeof cwd !== 'string' || !cwd.trim() || !isAbsolute(cwd)) return null;
  return normalize(cwd);
}

function projectSlugFromPath(projectPath: string | null): string | null {
  const normalized = normalizeObservedCwd(projectPath);
  if (!normalized) return null;
  return '-' + normalized.replace(/^[\\/]+/, '').replace(/[\\/]+/g, '-');
}

function inferProjectPath(project: string | null | undefined, observedCwds: unknown[] = []): string | null {
  const byPath = new Map<string, { path: string; count: number; first: number }>();
  for (const cwd of observedCwds) {
    const normalized = normalizeObservedCwd(cwd);
    if (!normalized) continue;
    const current = byPath.get(normalized) || { path: normalized, count: 0, first: byPath.size };
    current.count++;
    byPath.set(normalized, current);
  }
  const best = [...byPath.values()].sort((a, b) => b.count - a.count || a.first - b.first)[0];
  return best?.path || legacyProjectPathFromSlug(project);
}

function discoverJsonlFiles(
  projectsDir = PROJECTS_DIR,
  reportIssue?: DiscoveryIssueHandler,
): ClaudeJsonlFile[] {
  const files: ClaudeJsonlFile[] = [];
  if (!existsSync(projectsDir)) return files;
  let projects;
  try { projects = readdirSync(projectsDir); } catch (error) { reportIssue?.(sourceInventoryIssue(projectsDir, error)); return files; }
  for (const proj of projects) {
    const projPath = join(projectsDir, proj);
    if (!isDir(projPath)) continue;
    let entries;
    try { entries = readdirSync(projPath); } catch (error) { reportIssue?.(sourceInventoryIssue(projPath, error)); continue; }
    for (const f of entries) {
      if (f.endsWith('.jsonl'))
        files.push({ path: join(projPath, f), sessionId: f.slice(0, -6), project: proj, isSubagent: false });
    }
    for (const sd of entries) {
      const saDir = join(projPath, sd, 'subagents');
      if (!isDir(saDir)) continue;
      let saEntries;
      try { saEntries = readdirSync(saDir); } catch (error) { reportIssue?.(sourceInventoryIssue(saDir, error)); continue; }
      for (const sf of saEntries) {
        if (sf.endsWith('.jsonl'))
          files.push({ path: join(saDir, sf), sessionId: sd, project: proj, isSubagent: true, agentId: sf.slice(0, -6) });
      }
      const wfRoot = join(saDir, 'workflows');
      if (!isDir(wfRoot)) continue;
      let wfDirs;
      try { wfDirs = readdirSync(wfRoot); } catch (error) { reportIssue?.(sourceInventoryIssue(wfRoot, error)); continue; }
      for (const wfDir of wfDirs) {
        const wfPath = join(wfRoot, wfDir);
        if (!isDir(wfPath)) continue;
        let wfEntries;
        try { wfEntries = readdirSync(wfPath); } catch (error) { reportIssue?.(sourceInventoryIssue(wfPath, error)); continue; }
        for (const wf of wfEntries) {
          if (wf.endsWith('.jsonl'))
            files.push({ path: join(wfPath, wf), sessionId: sd, project: proj, isSubagent: true, agentId: wf.slice(0, -6), workflowRunId: wfDir });
        }
      }
    }
  }
  return files;
}

function discoverCodexJsonlFiles(
  sessionsDir = CODEX_SESSIONS_DIR,
  reportIssue?: DiscoveryIssueHandler,
): CodexJsonlFile[] {
  const files: CodexJsonlFile[] = [];
  if (!existsSync(sessionsDir)) return files;
  const walk = (dir: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch (error) { reportIssue?.(sourceInventoryIssue(dir, error)); return; }
    for (const entry of entries) {
      const fp = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fp);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push({ path: fp, source: 'codex' });
      }
    }
  };
  walk(sessionsDir);
  return files;
}

// ---- Codex pure helpers ----
function codexDbId(id: unknown): string | null {
  if (!id) return null;
  const raw = String(id).replace(/^codex:/, '');
  return `codex:${raw}`;
}

function codexRawId(id: unknown): string | null {
  return id ? String(id).replace(/^codex:/, '') : null;
}

function codexLineUuid(threadId: unknown, lineNum: number): string {
  return `codex:${codexRawId(threadId)}:${String(lineNum).padStart(6, '0')}`;
}

function codexCallId(threadId: unknown, callId: unknown): string | null {
  if (!threadId || !callId) return null;
  return `codex:${codexRawId(threadId)}:${String(callId).replace(/^codex:/, '')}`;
}

function codexParentThreadId(meta: JsonRecord): string | null {
  const subagent = meta?.source?.subagent;
  return subagent?.thread_spawn?.parent_thread_id
    || meta?.forked_from_id
    || subagent?.parent_thread_id
    || null;
}

function codexIsGuardianThread(meta: JsonRecord, records: CodexLineRecord[] = []): boolean {
  const subagent = meta?.source?.subagent;
  if (subagent?.other === 'guardian') return true;
  if (meta?.thread_source !== 'subagent') return false;
  return records.some(({ obj }) => obj?.payload?.model === 'codex-auto-review' || obj?.model === 'codex-auto-review');
}

function readCodexGuardianThreadInfo(filePath: string): { threadRawId: string; lineNum: number } | null {
  const records: CodexLineRecord[] = [];
  let metaRecord: CodexLineRecord | null = null;
  let lineNum = 0;
  readLines(filePath, (line) => {
    lineNum++;
    let obj: JsonRecord;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    records.push({ lineNum, obj });
    if (obj?.type === 'session_meta' && obj.payload?.id) {
      metaRecord = { lineNum, obj };
      if (obj.payload?.source?.subagent?.other === 'guardian') return false;
      if (obj.payload?.thread_source !== 'subagent') return false;
    }
    if (metaRecord && codexIsGuardianThread(metaRecord.obj.payload, records)) return false;
  });
  const capturedMeta = metaRecord as CodexLineRecord | null;
  const meta = capturedMeta?.obj?.payload;
  if (!meta || !codexIsGuardianThread(meta, records)) return null;
  const threadRawId = codexRawId(meta.id);
  return threadRawId ? { threadRawId, lineNum } : null;
}

function codexAgentNickname(meta: JsonRecord): string | null {
  return meta?.agent_nickname
    || meta?.source?.subagent?.thread_spawn?.agent_nickname
    || null;
}

function codexAgentRole(meta: JsonRecord): string | null {
  return meta?.agent_role
    || meta?.source?.subagent?.thread_spawn?.agent_role
    || null;
}

function parseCodexJsonInput(value: JsonValue): JsonValue {
  if (value === null || value === undefined || value === '') return {};
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

interface CodexUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

function codexUsage(payload: JsonRecord): CodexUsage {
  const usage = payload?.info?.last_token_usage || payload?.info?.total_token_usage || payload?.last_token_usage || null;
  if (!usage) return { inputTokens: null, outputTokens: null };
  return {
    inputTokens: typeof usage.input_tokens === 'number' && Number.isFinite(usage.input_tokens)
      ? usage.input_tokens
      : null,
    outputTokens: typeof usage.output_tokens === 'number' && Number.isFinite(usage.output_tokens)
      ? usage.output_tokens
      : null,
  };
}

function codexEventText(payload: JsonRecord): string | null {
  if (typeof payload?.message === 'string') return payload.message;
  if (Array.isArray(payload?.text_elements) && payload.text_elements.length) {
    const parts = payload.text_elements.map((item: JsonValue) => typeof item === 'string' ? item : item?.text).filter(Boolean);
    if (parts.length) return parts.join('\n');
  }
  if (typeof payload?.text === 'string') return payload.text;
  return null;
}

function codexMessagePayloadText(payload: JsonRecord): string | null {
  if (!Array.isArray(payload?.content)) return null;
  const parts: string[] = [];
  for (let index = 0; index < payload.content.length; index++) {
    const block = payload.content[index];
    const image = payload.content[index + 1];
    const close = payload.content[index + 2];
    if (
      block?.type === 'input_text'
      && typeof block.text === 'string'
      && block.text.trim() === '<image>'
      && image?.type === 'input_image'
      && close?.type === 'input_text'
      && typeof close.text === 'string'
      && close.text.trim() === '</image>'
    ) {
      index += 2;
      continue;
    }
    if (typeof block?.text === 'string') parts.push(block.text);
  }
  return parts.length ? parts.join('\n') : null;
}

function codexVisibleMessageKey(role: unknown, text: unknown): string {
  return `${role || ''}\u0000${text || ''}`;
}

function codexToolInput(payload: JsonRecord): JsonValue {
  if (payload?.type === 'custom_tool_call') return parseCodexJsonInput(payload.input);
  if (payload?.type === 'tool_search_call') return parseCodexJsonInput(payload.arguments);
  if (payload?.type === 'web_search_call') return { action: payload.action || null };
  return parseCodexJsonInput(payload?.arguments);
}

function codexToolOutput(payload: JsonRecord): string | null {
  if (typeof payload?.output === 'string') return payload.output;
  if (payload?.output !== undefined) return JSON.stringify(payload.output);
  if (payload?.tools !== undefined) return JSON.stringify(payload.tools);
  if (payload?.execution !== undefined) return JSON.stringify(payload.execution);
  return null;
}

export {
  CLAUDE_DIR, CODEX_DIR, PROJECTS_DIR, CODEX_SESSIONS_DIR, TEXT_LIMIT,
  trunc, truncJson, extractText, extractContentType, extractMessageIsMeta, isSkillInstructions, filePath, isDir, readLines,
  legacyProjectPathFromSlug, normalizeObservedCwd, projectSlugFromPath, inferProjectPath,
  discoverJsonlFiles, discoverCodexJsonlFiles, sourceInventoryIssue,
  codexDbId, codexRawId, codexLineUuid, codexCallId, codexParentThreadId, codexIsGuardianThread,
  readCodexGuardianThreadInfo, codexAgentNickname, codexAgentRole, parseCodexJsonInput,
  codexUsage, codexEventText, codexMessagePayloadText, codexVisibleMessageKey, codexToolInput, codexToolOutput,
};
