// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { getArgPreview, getToolIcon, renderTerminalTool } from './tool-renderer.js';
import { renderMarkdown } from './utils.js';

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function parseToolInput(toolCall) {
  try {
    return JSON.parse(toolCall.input_json || '{}');
  } catch {
    return {};
  }
}

function formatToolInput(toolCall) {
  try {
    return JSON.stringify(JSON.parse(toolCall.input_json || '{}'), null, 2);
  } catch {
    return toolCall.input_json || '';
  }
}

function renderFileContent(text, label = 'File contents') {
  let lines = text.split('\n');
  const hasLineNums = lines.length > 1 && lines.slice(0, 5).every(line => /^\s*\d+\t/.test(line) || line === '');
  let gutter;
  if (hasLineNums) {
    const parsed = lines.map(line => {
      const match = line.match(/^\s*(\d+)\t(.*)$/);
      return match ? { num: match[1], code: match[2] } : { num: '', code: line };
    });
    gutter = parsed.map(line => line.num).join('\n');
    lines = parsed.map(line => line.code);
  } else {
    gutter = lines.map((_, index) => index + 1).join('\n');
  }
  const total = lines.length;
  const collapsed = total > 12;
  return `<div class="file-content">
    <div class="file-content-head"><span class="label">${escapeHtml(label)}</span><span class="meta">${total} lines</span></div>
    <div class="file-content-body ${collapsed ? 'collapsed' : ''}"><div class="gutter">${gutter}</div><div class="code">${escapeHtml(lines.join('\n'))}</div></div>
    ${collapsed ? `<button class="file-content-expand" onclick="this.previousElementSibling.classList.toggle('collapsed');this.textContent=this.previousElementSibling.classList.contains('collapsed')?'Show all ${total} lines':'Collapse'">Show all ${total} lines</button>` : ''}
  </div>`;
}

function renderDiff(oldString, newString) {
  const oldLines = oldString.split('\n');
  const newLines = newString.split('\n');
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++;

  const result = [];
  for (let index = 0; index < prefix; index++) result.push({ kind: 'context', text: oldLines[index], oldNo: index + 1, newNo: index + 1 });
  for (let index = prefix; index < oldLines.length - suffix; index++) result.push({ kind: 'del', text: oldLines[index], oldNo: index + 1, newNo: null });
  for (let index = prefix; index < newLines.length - suffix; index++) result.push({ kind: 'add', text: newLines[index], oldNo: null, newNo: index + 1 });
  for (let index = 0; index < suffix; index++) {
    result.push({
      kind: 'context',
      text: oldLines[oldLines.length - suffix + index],
      oldNo: oldLines.length - suffix + index + 1,
      newNo: newLines.length - suffix + index + 1,
    });
  }

  const adds = result.filter(line => line.kind === 'add').length;
  const dels = result.filter(line => line.kind === 'del').length;
  const rows = result.map(line => {
    const oldNumber = line.oldNo == null ? ' ' : String(line.oldNo);
    const newNumber = line.newNo == null ? ' ' : String(line.newNo);
    return `<div class="diff-gutter ${line.kind}">${oldNumber.padStart(3)} ${newNumber.padStart(3)}</div><div class="diff-line ${line.kind}">  ${escapeHtml(line.text)}</div>`;
  }).join('');

  return `<div class="diff-view">
    <div class="diff-view-head"><span class="label">Diff</span><div class="stats"><span class="stat-add">+${adds}</span><span class="stat-del">−${dels}</span></div></div>
    <div class="diff-body">${rows}</div>
  </div>`;
}

function renderValue(value) {
  if (value === null || value === undefined) return '<span class="literal-null">null</span>';
  if (typeof value === 'boolean') return `<span class="literal-bool">${value}</span>`;
  if (typeof value === 'number') return `<span class="literal-num">${value}</span>`;
  if (typeof value === 'string') {
    if (/^https?:\/\//.test(value)) return `<span class="literal-string">${escapeHtml(value)}</span>`;
    if (value.length > 120) {
      return `<span class="lit-string-long" onclick="this.classList.toggle('open')">"${escapeHtml(value.slice(0, 120))}<span class="long-rest">${escapeHtml(value.slice(120))}</span>"<button class="more-btn">+${value.length - 120}</button></span>`;
    }
    return `<span class="literal-string">"${escapeHtml(value)}"</span>`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '<span class="literal-null">[]</span>';
    if (value.length <= 4 && value.every(item => typeof item !== 'object')) {
      return `<span class="literal-string">[${value.map(item => renderValue(item)).join(', ')}]</span>`;
    }
    return `<span class="literal-null">Array(${value.length})</span>`;
  }
  if (typeof value === 'object') return `<span class="literal-null">Object(${Object.keys(value).length})</span>`;
  return `<span>${escapeHtml(String(value))}</span>`;
}

function renderFieldGrid(object) {
  const entries = Object.entries(object);
  if (!entries.length) return '';
  const rows = entries.map(([key, value]) => (
    `<div class="field-key">${escapeHtml(key)}</div><div class="field-val">${renderValue(value)}</div>`
  )).join('');
  return `<div class="field-grid">${rows}</div>`;
}

function extractHero(object) {
  if (!object || typeof object !== 'object') return null;
  const titleKey = ['title', 'name', 'summary'].find(key => typeof object[key] === 'string');
  const urlKey = ['url', 'permalink', 'href', 'link'].find(key => typeof object[key] === 'string' && /^https?:/.test(object[key]));
  const idKey = ['id', 'identifier', 'uuid', 'key'].find(key => typeof object[key] === 'string');
  if (!titleKey && !urlKey && !idKey) return null;
  return { titleKey, urlKey, idKey };
}

function renderObjectOutput(object) {
  const hero = extractHero(object);
  let rest = object;
  if (hero) {
    rest = { ...object };
    if (hero.titleKey) delete rest[hero.titleKey];
    if (hero.urlKey) delete rest[hero.urlKey];
    if (hero.idKey) delete rest[hero.idKey];
  }
  let html = '';
  if (hero) {
    html += '<div style="margin-bottom:10px;padding:8px 12px;border-left:2px solid var(--accent-soft);background:rgba(167,139,250,0.04);border-radius:0 5px 5px 0;">';
    if (hero.titleKey) html += `<div style="font-size:14px;font-weight:600;color:var(--fg);margin-bottom:2px;">${escapeHtml(object[hero.titleKey])}</div>`;
    const subtitle = [];
    if (hero.idKey) subtitle.push(escapeHtml(object[hero.idKey]));
    if (hero.urlKey) subtitle.push(escapeHtml(object[hero.urlKey]));
    if (subtitle.length) html += `<div style="font-family:var(--font-mono);font-size:11px;color:var(--muted);">${subtitle.join(' · ')}</div>`;
    html += '</div>';
  }
  if (Object.keys(rest).length) html += renderFieldGrid(rest);
  return html;
}

function renderAutoTable(rows) {
  const sample = rows.slice(0, 5);
  const allKeys = new Set();
  for (const row of sample) Object.keys(row).forEach(key => allKeys.add(key));
  const columns = Array.from(allKeys);
  const head = columns.map(column => `<th>${escapeHtml(column)}</th>`).join('');
  const body = rows.slice(0, 50).map(row => (
    `<tr>${columns.map(column => {
      const value = row[column];
      if (value == null) return '<td><span class="literal-null">—</span></td>';
      if (typeof value === 'string' && value.length > 60) return `<td title="${escapeHtml(value)}">${escapeHtml(value.slice(0, 60))}…</td>`;
      if (typeof value === 'object') return `<td>${renderValue(value)}</td>`;
      return `<td>${escapeHtml(String(value))}</td>`;
    }).join('')}</tr>`
  )).join('');
  return `<div class="auto-table-wrap">
    <div class="auto-table-head"><span class="h-label">Result</span><span class="h-meta">${rows.length} items · ${columns.length} columns</span></div>
    <div class="auto-table-scroll"><table class="auto-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
  </div>`;
}

function renderOutput(output, isError) {
  if (!output) return '<div style="padding:8px;color:var(--muted-2);font-style:italic;font-size:11px;">No output.</div>';

  let parsed = null;
  try { parsed = JSON.parse(output); } catch {}
  if (parsed !== null && typeof parsed === 'object') {
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(item => item && typeof item === 'object' && !Array.isArray(item))) {
      return renderAutoTable(parsed);
    }
    if (Array.isArray(parsed)) return renderFieldGrid(Object.fromEntries(parsed.map((item, index) => [index, item])));
    return renderObjectOutput(parsed);
  }

  if (output.includes('\n')) {
    const lines = output.split('\n');
    const total = lines.length;
    const collapsed = total > 10;
    const gutter = lines.map((_, index) => index + 1).join('\n');
    return `<div class="file-content">
      <div class="file-content-body ${collapsed ? 'collapsed' : ''}"><div class="gutter">${gutter}</div><div class="code">${escapeHtml(output)}</div></div>
      ${collapsed ? `<button class="file-content-expand" onclick="this.previousElementSibling.classList.toggle('collapsed');this.textContent=this.previousElementSibling.classList.contains('collapsed')?'Show all ${total} lines':'Collapse'">Show all ${total} lines</button>` : ''}
    </div>`;
  }

  return `<div class="result-chip ${isError ? 'error' : ''}">${escapeHtml(output)}</div>`;
}

export function renderPrettyTool(toolCall) {
  const args = parseToolInput(toolCall);
  const result = toolCall.result || {};
  const isError = Boolean(result.is_error);
  const output = result.content || '';

  if (toolCall.name === 'Read') {
    if (!output) return '<div style="color:var(--muted);font-size:11px;font-style:italic;">No content returned.</div>';
    return renderFileContent(output);
  }

  if (toolCall.name === 'Write') {
    const path = args.file_path || args.path || '?';
    const header = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
      <span class="tool-action-label">Writing</span>
      <span class="file-ref">${escapeHtml(path)}</span>
    </div>`;
    let content = '';
    if (args.content) {
      const lines = args.content.split('\n');
      const gutter = lines.map((_, index) => index + 1).join('\n');
      content = `<div class="file-content">
        <div class="file-content-head"><span class="label">New file</span><span class="meta">${lines.length} lines</span></div>
        <div class="file-content-body collapsed"><div class="gutter">${gutter}</div><div class="code">${escapeHtml(args.content)}</div></div>
      </div>`;
    }
    return header + content + `<div class="result-chip ${isError ? 'error' : ''}">${escapeHtml(output)}</div>`;
  }

  if (toolCall.name === 'Edit') {
    const diff = args.old_string && args.new_string ? renderDiff(args.old_string, args.new_string) : '';
    return diff + `<div class="result-chip ${isError ? 'error' : ''}">${escapeHtml(output)}</div>`;
  }

  const terminal = renderTerminalTool(toolCall.name, args, output, isError);
  if (terminal !== null) return terminal;
  const input = typeof args === 'string'
    ? renderFileContent(args, 'Input')
    : `<div class="body-section"><div class="body-label">Input</div>${renderFieldGrid(args)}</div>`;
  return input
    + (output ? `<div class="body-section" style="margin-top:12px;"><div class="body-label">Output</div>${renderOutput(output, isError)}</div>` : '');
}

function groupWorkflowAgents(workflow) {
  const phases = {};
  for (const agent of (workflow?.agents || [])) {
    const phase = agent.phase || 'Other';
    if (!phases[phase]) phases[phase] = [];
    phases[phase].push(agent);
  }
  return phases;
}

export function buildSessionTimelinePresentation(item, { query = '', expandedText } = {}) {
  const message = item?.message || {};
  const toolCalls = item?.kind === 'workflow-tools'
    ? (item.toolCalls || [])
    : (message.tool_calls || []);
  const toolInputs = new Map();
  const toolInputText = new Map();
  const toolPrettyHtml = new Map();
  const toolResultHtml = new Map();
  const toolArgPreviews = new Map();
  const toolIcons = new Map();
  const workflowAgentGroups = new Map();
  const refs = { cwd: message.cwd || null, sessionId: message.session_id || null };

  for (const toolCall of toolCalls) {
    const input = parseToolInput(toolCall);
    toolInputs.set(toolCall.id, input);
    toolInputText.set(toolCall.id, formatToolInput(toolCall));
    toolArgPreviews.set(toolCall.id, getArgPreview(toolCall));
    toolIcons.set(toolCall.id, getToolIcon(toolCall.name));
    if (item?.kind === 'workflow-tools' || !['Skill', 'Agent', 'Task', 'Workflow'].includes(toolCall.name)) {
      toolPrettyHtml.set(toolCall.id, renderPrettyTool(toolCall));
    }
    if ((toolCall.name === 'Agent' || toolCall.name === 'Task') && toolCall.result?.content) {
      toolResultHtml.set(toolCall.id, renderMarkdown(toolCall.result.content, { variant: 'compact', ...refs }));
    }
    if (toolCall.name === 'Workflow') workflowAgentGroups.set(toolCall.id, groupWorkflowAgents(toolCall.workflow));
  }

  const effectiveText = expandedText ?? message.text;
  return {
    messageHtml: message.text
      ? renderMarkdown(effectiveText, { variant: item?.kind === 'meta' ? 'compact' : 'msg', query, ...refs })
      : '',
    thinkingHtml: message._thinking
      ? renderMarkdown(message._thinking, { variant: 'msg', query, ...refs })
      : (item?.kind === 'thinking' ? renderMarkdown(message.text, { variant: 'msg', query, ...refs }) : ''),
    skillHtml: message._skillMd ? renderMarkdown(message._skillMd, { variant: 'compact', ...refs }) : '',
    summaryHtml: message.summary?.content
      ? renderMarkdown(message.summary.content, { variant: 'compact', ...refs })
      : '',
    toolInputs,
    toolInputText,
    toolPrettyHtml,
    toolResultHtml,
    toolArgPreviews,
    toolIcons,
    workflowAgentGroups,
    standaloneWorkflowGroups: item?.kind === 'workflow'
      ? groupWorkflowAgents(item.workflowCall?.workflow)
      : {},
  };
}
