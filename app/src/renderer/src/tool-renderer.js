// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

function escapeHTML(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const JAVASCRIPT_KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends', 'finally',
  'for', 'from', 'function', 'get', 'if', 'implements', 'import', 'in',
  'instanceof', 'interface', 'let', 'new', 'of', 'package', 'private', 'protected',
  'public', 'return', 'set', 'static', 'super', 'switch', 'throw', 'try', 'typeof',
  'var', 'void', 'while', 'with', 'yield',
]);
const JAVASCRIPT_LITERALS = new Set(['false', 'Infinity', 'NaN', 'null', 'true', 'undefined']);
const CODEACT_GLOBALS = new Set([
  'ALL_TOOLS', 'Array', 'Boolean', 'Date', 'Error', 'JSON', 'Map', 'Math', 'Number',
  'Object', 'Promise', 'RegExp', 'Set', 'String', 'clearTimeout', 'generatedImage',
  'image', 'load', 'notify', 'setTimeout', 'store', 'text', 'tools', 'yield_control',
]);

function isIdentifierStart(char) {
  return /[A-Za-z_$]/.test(char);
}

function isIdentifierPart(char) {
  return /[\w$]/.test(char);
}

function highlightJavaScript(source) {
  const code = String(source);
  let html = '';
  let plain = '';
  let index = 0;

  const flushPlain = () => {
    if (!plain) return;
    html += escapeHTML(plain);
    plain = '';
  };
  const token = (kind, value) => {
    flushPlain();
    html += `<span class="codeact-token ${kind}">${escapeHTML(value)}</span>`;
  };

  while (index < code.length) {
    const char = code[index];
    const next = code[index + 1];

    if (char === '/' && next === '/') {
      const start = index;
      index += 2;
      while (index < code.length && code[index] !== '\n') index += 1;
      token('comment', code.slice(start, index));
      continue;
    }

    if (char === '/' && next === '*') {
      const start = index;
      index += 2;
      while (index < code.length && !(code[index] === '*' && code[index + 1] === '/')) index += 1;
      if (index < code.length) index += 2;
      token('comment', code.slice(start, index));
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      const start = index;
      const quote = char;
      index += 1;
      while (index < code.length) {
        if (code[index] === '\\') {
          index = Math.min(index + 2, code.length);
          continue;
        }
        if (code[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      token('string', code.slice(start, index));
      continue;
    }

    if (/\d/.test(char) || (char === '.' && /\d/.test(next))) {
      const match = code.slice(index).match(/^(?:0[xX][\dA-Fa-f](?:_?[\dA-Fa-f])*n?|0[bB][01](?:_?[01])*n?|0[oO][0-7](?:_?[0-7])*n?|(?:\d(?:_?\d)*)?(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?n?)/);
      const value = match?.[0];
      if (value) {
        token('number', value);
        index += value.length;
        continue;
      }
    }

    if (isIdentifierStart(char)) {
      const start = index;
      index += 1;
      while (index < code.length && isIdentifierPart(code[index])) index += 1;
      const value = code.slice(start, index);
      if (JAVASCRIPT_KEYWORDS.has(value)) token('keyword', value);
      else if (JAVASCRIPT_LITERALS.has(value)) token('literal', value);
      else if (CODEACT_GLOBALS.has(value)) token('global', value);
      else plain += value;
      continue;
    }

    plain += char;
    index += 1;
  }

  flushPlain();
  return html;
}

const TERMINAL_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"><rect x="2" y="3" width="12" height="10" rx="1.2"/><path d="M5 7l2 1.5-2 1.5M8.5 10.5h2.5"/></svg>';
const TOOL_ICONS = {
  Bash: TERMINAL_ICON,
  exec: TERMINAL_ICON,
  Read: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"><path d="M3.5 2h6l3 3v9a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M9.5 2v3h3"/></svg>',
  Edit: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"><path d="M3.5 2h6l3 3v9a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M9.5 2v3h3"/><path d="M6 10l4-4M6.5 10.5l-1.2 1.4 1.4-1.2"/></svg>',
  Write: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"><path d="M3.5 2h6l3 3v9a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M9.5 2v3h3"/><path d="M6 9.5h4M6 11.5h2.5"/></svg>',
};

export function getToolIcon(name) {
  return TOOL_ICONS[name] || '';
}

export function getArgPreview(toolCall) {
  try {
    const input = JSON.parse(toolCall.input_json || '{}');
    if (typeof input === 'string') return input.slice(0, 90);
    if (input.file_path) return input.file_path;
    if (input.command) return input.command;
    if (input.path) return input.path;
    if (input.query) return input.query;
    if (input.description) return input.description;
    if (input.pattern) return input.pattern;
    if (input.url) return input.url;
    if (input.name) return input.name;
    if (input.title) return input.title;
    for (const key of Object.keys(input)) {
      if (typeof input[key] === 'string' && input[key].length < 90) return input[key];
    }
    return JSON.stringify(input).slice(0, 90);
  } catch {
    return (toolCall.input_json || '').slice(0, 90);
  }
}

function renderTerminal(command, output, isError) {
  let formatted = escapeHTML(output);
  formatted = formatted.replace(/(✓[^\n]*)/g, '<span style="color:#4ade80">$1</span>');
  formatted = formatted.replace(/(✗[^\n]*|FAIL[^\n]*|Error:[^\n]*)/g, '<span style="color:#f87171">$1</span>');
  return `<div class="terminal-view">
    <div class="terminal-prompt-line"><span class="prompt-marker">$</span><span class="prompt-cmd">${escapeHTML(command)}</span></div>
    ${output ? `<div class="terminal-divider"></div><div class="terminal-output ${isError ? 'is-error' : ''}">${formatted}</div>` : ''}
  </div>`;
}

function decodeJsonStringPrefix(source, start) {
  let value = '';
  let index = start;
  let complete = false;
  while (index < source.length) {
    const char = source[index++];
    if (char === '"') {
      complete = true;
      break;
    }
    if (char !== '\\') {
      value += char;
      continue;
    }
    if (index >= source.length) break;
    const escaped = source[index++];
    if (escaped === 'n') value += '\n';
    else if (escaped === 'r') value += '\r';
    else if (escaped === 't') value += '\t';
    else if (escaped === 'b') value += '\b';
    else if (escaped === 'f') value += '\f';
    else if (escaped === 'u') {
      const hex = source.slice(index, index + 4);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        value += String.fromCharCode(Number.parseInt(hex, 16));
        index += 4;
      }
    } else {
      value += escaped;
    }
  }
  return { value, next: index, complete };
}

function extractInputTextBlocks(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const texts = parsed
        .filter(item => item?.type === 'input_text' && typeof item.text === 'string')
        .map(item => item.text);
      if (texts.length) {
        return {
          texts,
          unwrapped: true,
          truncated: false,
          hasOtherBlocks: texts.length !== parsed.length,
        };
      }
    }
  } catch {}

  const marker = '"text":"';
  const texts = [];
  let cursor = 0;
  while (raw.includes('"type":"input_text"', cursor)) {
    const markerIndex = raw.indexOf(marker, cursor);
    if (markerIndex === -1) break;
    const decoded = decodeJsonStringPrefix(raw, markerIndex + marker.length);
    texts.push(decoded.value);
    cursor = Math.max(decoded.next, markerIndex + marker.length);
    if (!decoded.complete) break;
  }
  if (texts.length) {
    return { texts, unwrapped: true, truncated: true, hasOtherBlocks: false };
  }
  return { texts: [raw], unwrapped: false, truncated: false, hasOtherBlocks: false };
}

function parseScriptHeader(text, isError) {
  const match = String(text).match(/^Script (completed|failed|running)(?: with cell ID ([^\n]+))?\nWall time ([^\n]+)\nOutput:\n?/);
  if (!match) {
    return {
      status: isError ? 'failed' : 'complete',
      cellId: null,
      rest: String(text),
      matched: false,
    };
  }
  return {
    status: match[1] === 'completed' ? 'complete' : match[1],
    cellId: match[2] || null,
    rest: String(text).slice(match[0].length),
    matched: true,
  };
}

function tryFormatJson(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return null;
  }
}

function highlightJson(json) {
  let html = '';
  let plain = '';
  let index = 0;

  const flushPlain = () => {
    if (!plain) return;
    html += escapeHTML(plain);
    plain = '';
  };
  const token = (kind, value) => {
    flushPlain();
    html += `<span class="codeact-json-token ${kind}">${escapeHTML(value)}</span>`;
  };

  while (index < json.length) {
    const char = json[index];

    if (char === '"') {
      const start = index;
      index += 1;
      while (index < json.length) {
        if (json[index] === '\\') {
          index = Math.min(index + 2, json.length);
          continue;
        }
        if (json[index] === '"') {
          index += 1;
          break;
        }
        index += 1;
      }
      let lookahead = index;
      while (/\s/.test(json[lookahead])) lookahead += 1;
      token(json[lookahead] === ':' ? 'key' : 'string', json.slice(start, index));
      continue;
    }

    if (char === '-' || /\d/.test(char)) {
      const match = json.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (match) {
        token('number', match[0]);
        index += match[0].length;
        continue;
      }
    }

    const literal = ['true', 'false', 'null'].find(value => json.startsWith(value, index));
    if (literal) {
      token('literal', literal);
      index += literal.length;
      continue;
    }

    plain += char;
    index += 1;
  }

  flushPlain();
  return html;
}

function formatResultBlocks(blocks) {
  return blocks.filter(block => block !== '').map(block => {
    const formatted = tryFormatJson(block);
    return formatted === null
      ? { text: block, html: escapeHTML(block), isJson: false }
      : { text: formatted, html: highlightJson(formatted), isJson: true };
  });
}

function decodeCodeActOutput(raw, isError) {
  const extracted = extractInputTextBlocks(String(raw || ''));
  const first = extracted.texts[0] || '';
  const header = parseScriptHeader(first, isError);
  const bodyBlocks = header.matched
    ? [header.rest, ...extracted.texts.slice(1)]
    : extracted.texts;
  return {
    ...header,
    blocks: formatResultBlocks(bodyBlocks),
    truncated: extracted.truncated || String(raw || '').length >= 10000,
    hasOtherBlocks: extracted.hasOtherBlocks,
  };
}

function renderCodeAct(source, output, isError) {
  const code = String(source || '');
  const lines = code.split('\n');
  const gutter = lines.map((_, index) => index + 1).join('\n');
  const result = decodeCodeActOutput(output, isError);
  const statusLabel = result.status === 'failed' ? 'Failed' : 'Running';
  const emptyText = result.status === 'running'
    ? 'Execution was still running when this event was captured.'
    : result.status === 'failed'
      ? 'No failure details were captured.'
      : 'No result returned.';
  const cell = result.cellId ? `<span class="codeact-cell">Cell ${escapeHTML(result.cellId)}</span>` : '';
  const status = result.status === 'complete'
    ? ''
    : `<span class="codeact-status"><span class="codeact-status-dot" aria-hidden="true"></span>${statusLabel}</span>`;
  const metadata = status || cell
    ? `<div class="codeact-result-meta">${status}${cell}</div>`
    : '';
  const notes = [
    result.truncated ? '<div class="codeact-note">Indexed output truncated. Open Raw to inspect the captured envelope.</div>' : '',
    result.hasOtherBlocks ? '<div class="codeact-note">Additional structured blocks are available in Raw.</div>' : '',
  ].join('');
  const resultContent = result.blocks.length
    ? `<div class="codeact-result" tabindex="0" role="list" aria-label="CodeAct result">${result.blocks.map((block, index) => `
        <pre class="codeact-result-block ${block.isJson ? 'is-json' : ''}" role="listitem" aria-label="Result block ${index + 1}">${block.html}</pre>`).join('')}
      </div>`
    : `<div class="codeact-result is-empty" tabindex="0" aria-label="CodeAct result">${escapeHTML(emptyText)}</div>`;

  return `<div class="codeact-view is-${result.status}" role="group" aria-label="CodeAct execution">
    <section class="codeact-section codeact-source-section">
      <div class="codeact-section-head">
        <span class="codeact-section-label">Source</span>
      </div>
      <div class="codeact-code-frame" tabindex="0" aria-label="CodeAct source">
        <pre class="codeact-gutter" aria-hidden="true">${gutter}</pre>
        <pre class="codeact-code"><code>${highlightJavaScript(code)}</code></pre>
      </div>
    </section>
    <section class="codeact-section codeact-result-section">
      <div class="codeact-section-head">
        <span class="codeact-section-label">Result</span>
        ${metadata}
      </div>
      ${resultContent}
      ${notes}
    </section>
  </div>`;
}

export function renderTerminalTool(name, input, output, isError) {
  if (name === 'Bash') {
    const description = input?.description
      ? `<div style="font-size:11.5px;color:var(--muted);margin-bottom:8px;">${escapeHTML(input.description)}</div>`
      : '';
    return description + renderTerminal(input?.command || '', output, isError);
  }
  if (name === 'exec') {
    return renderCodeAct(typeof input === 'string' ? input : '', output, isError);
  }
  return null;
}
