// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import test from 'node:test';
import assert from 'node:assert/strict';

import { getArgPreview, getToolIcon, renderTerminalTool } from '../app/src/renderer/src/tool-renderer.js';
import { renderPrettyTool } from '../app/src/renderer/src/session-timeline-presentation.mjs';

test('Codex exec renders source and decoded result instead of a Bash terminal', () => {
  const output = JSON.stringify([
    { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
    { type: 'input_text', text: 'first line\nsecond line' },
  ]);
  const html = renderTerminalTool('exec', 'const value = await tools.read();', output, false);

  assert.match(html, /class="codeact-view is-complete"/);
  assert.match(html, />Source</);
  assert.match(html, /codeact-token keyword">const</);
  assert.match(html, /codeact-token keyword">await</);
  assert.match(html, /codeact-token global">tools</);
  assert.doesNotMatch(html, />JavaScript</);
  assert.match(html, />Result</);
  assert.match(html, /first line\nsecond line/);
  assert.doesNotMatch(html, />Completed</);
  assert.doesNotMatch(html, /codeact-status-dot/);
  assert.doesNotMatch(html, /0\.1 seconds/);
  assert.doesNotMatch(html, /terminal-view|input_text|Script completed/);
});

test('Codex exec formats consecutive JSON result blocks independently', () => {
  const output = JSON.stringify([
    { type: 'input_text', text: 'Script completed\nWall time 0.2 seconds\nOutput:\n' },
    { type: 'input_text', text: JSON.stringify({ exit_code: 0, output: 'first\nline' }) },
    { type: 'input_text', text: JSON.stringify({ exit_code: 1, output: 'second\nline' }) },
  ]);
  const html = renderTerminalTool('exec', 'await task();', output, false);
  const visibleText = html.replace(/<[^>]+>/g, '');
  const resultBlockCount = html.match(/class="codeact-result-block/g)?.length || 0;

  assert.equal(resultBlockCount, 2);
  assert.match(visibleText, /\{\n {2}"exit_code": 0,\n {2}"output": "first\\nline"\n\}/);
  assert.match(visibleText, /\{\n {2}"exit_code": 1,\n {2}"output": "second\\nline"\n\}/);
  assert.match(html, /codeact-json-token key">"exit_code"</);
  assert.match(html, /codeact-json-token number">0</);
  assert.doesNotMatch(visibleText, /\{"exit_code":/);
});

test('Claude Bash continues to use terminal rendering', () => {
  const html = renderTerminalTool('Bash', { command: 'echo hello' }, 'hello\n', false);

  assert.match(html, /class="terminal-view"/);
  assert.match(html, /echo hello/);
});

test('Codex exec decodes a truncated input_text envelope without inventing missing output', () => {
  const truncated = '[{"type":"input_text","text":"Script completed\\nWall time 0.2 seconds\\nOutput:\\n"},{"type":"input_text","text":"line 1\\nline 2';
  const html = renderTerminalTool('exec', 'text(result);', truncated, false);

  assert.match(html, /line 1\nline 2/);
  assert.match(html, /Indexed output truncated/);
  assert.doesNotMatch(html, /\\n|input_text/);
});

test('Codex exec derives failed and running states from the captured result', () => {
  const failed = JSON.stringify([
    { type: 'input_text', text: 'Script failed\nWall time 9.4 seconds\nOutput:\n' },
    { type: 'input_text', text: 'Script error:\nExit code: 1' },
  ]);
  const running = 'Script running with cell ID 128\nWall time 10.0 seconds\nOutput:\n';

  const failedHtml = renderTerminalTool('exec', 'await task();', failed, false);
  const runningHtml = renderTerminalTool('exec', 'await task();', running, false);

  assert.match(failedHtml, /class="codeact-view is-failed"/);
  assert.match(failedHtml, />Failed</);
  assert.match(runningHtml, /class="codeact-view is-running"/);
  assert.match(runningHtml, />Running</);
});

test('Codex exec keeps large payloads in a bounded DOM structure', () => {
  const source = 'const value = await tools.read();\n'.repeat(300);
  const output = JSON.stringify([
    { type: 'input_text', text: 'Script completed\nWall time 0.3 seconds\nOutput:\n' },
    { type: 'input_text', text: 'x'.repeat(9_000) },
  ]);
  const html = renderTerminalTool('exec', source, output, false);
  const spanCount = html.match(/<span\b/g)?.length || 0;
  const preCount = html.match(/<pre\b/g)?.length || 0;

  assert.ok(spanCount < source.length / 4, `expected token-level markup, received ${spanCount} spans`);
  assert.equal(preCount, 3);
  assert.doesNotMatch(html, /code-char|ansi-char/);
});

test('Codex exec syntax highlighting escapes source content', () => {
  const source = 'const value = "<script>"; // not markup';
  const output = JSON.stringify([
    { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
    { type: 'input_text', text: JSON.stringify({ html: '<script>result</script>' }) },
  ]);
  const html = renderTerminalTool('exec', source, output, false);

  assert.match(html, /codeact-token string">"&lt;script&gt;"</);
  assert.match(html, /codeact-token comment">\/\/ not markup</);
  assert.match(html, /codeact-json-token string">"&lt;script&gt;result&lt;\/script&gt;"</);
  assert.doesNotMatch(html, /<script>/);
});

test('Codex exec preview uses its string input', () => {
  assert.equal(getArgPreview({ input_json: JSON.stringify('echo hello') }), 'echo hello');
});

test('Codex exec uses the Claude Bash terminal icon', () => {
  assert.equal(getToolIcon('exec'), getToolIcon('Bash'));
});

test('Codex apply_patch renders its string input as one multiline block', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: app.css',
    '@@',
    '-old',
    '+new <value>',
    '*** End Patch',
  ].join('\n');
  const html = renderPrettyTool({
    name: 'apply_patch',
    input_json: JSON.stringify(patch),
    result: { content: 'Done!', is_error: 0 },
  });

  assert.match(html, /class="file-content"/);
  assert.match(html, /<span class="label">Input<\/span><span class="meta">6 lines<\/span>/);
  assert.match(html, /\*\*\* Begin Patch\n\*\*\* Update File: app\.css\n@@\n-old\n\+new &lt;value&gt;\n\*\*\* End Patch/);
  assert.doesNotMatch(html, /<div class="field-(?:grid|key)">/);
  assert.doesNotMatch(html, /<value>/);
});

test('generic object tool input continues to render as a field grid', () => {
  const html = renderPrettyTool({
    name: 'custom_tool',
    input_json: JSON.stringify({ path: 'app.css', recursive: true }),
    result: {},
  });

  assert.match(html, /class="field-grid"/);
  assert.match(html, /class="field-key">path</);
  assert.match(html, /class="field-key">recursive</);
  assert.doesNotMatch(html, /class="file-content"/);
});
