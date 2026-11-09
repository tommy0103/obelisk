import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { parse } from '../packages/core/src/providers/codex.ts';
import { persist } from '../packages/core/src/persist.ts';
import { assembleSessionDetail } from '../packages/core/src/session-detail.ts';
import { buildSessionTimelinePresentation } from '../app/src/renderer/src/session-timeline-presentation.mjs';

test('a captured Codex custom_tool_call preserves the patch through storage, Pretty and Raw', () => {
  const path = fileURLToPath(new URL('./fixtures/codex-apply-patch.jsonl', import.meta.url));
  const events = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const captured = events.find(event => event.payload.type === 'custom_tool_call').payload.input;
  const unit = { key: path, sessionId: '' };
  const records = [...parse(unit, null)];
  const direct = assembleSessionDetail(records);
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8'));
    persist(db, unit, parse(unit, null));
    const detail = assembleSessionDetail({
      session: db.prepare('SELECT * FROM sessions').get(),
      messages: db.prepare('SELECT * FROM messages ORDER BY timestamp, uuid').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls').all(),
      toolResults: db.prepare('SELECT * FROM tool_results').all(),
    });
    assert.deepEqual(detail, direct, 'database round-trip must preserve the canonical detail');
    const message = detail.messages.find(row => row.tool_calls?.some(call => call.name === 'apply_patch'));
    assert.ok(message, 'the captured call must be reachable from the visible timeline');
    const call = message.tool_calls.find(row => row.name === 'apply_patch');
    assert.equal(JSON.parse(call.input_json), captured);
    assert.equal(call.result.content, events.at(-1).payload.output);
    const presentation = buildSessionTimelinePresentation({ kind: 'message', message });
    const html = presentation.toolPrettyHtml.get(call.id);
    const escaped = captured.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    assert.equal(html.match(/<div class="code">([\s\S]*?)<\/div>/)?.[1], escaped);
    assert.doesNotMatch(html, /class="field-(?:grid|key)"/);
    assert.equal(JSON.parse(presentation.toolInputText.get(call.id)), captured,
      'Raw must still expose the complete captured input');
  } finally {
    db.close();
  }
});
