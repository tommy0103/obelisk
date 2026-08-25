// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function read(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

const cards = [
  ['1', 'cover'],
  ['2', 'thinking'],
  ['3', 'vibe'],
  ['4', 'workflow'],
  ['5', 'closing'],
];

test('skill routes only the explicit recap intent to the split recap overview', async () => {
  const skill = await read('skill-doc/SKILL.md');

  assert.match(skill, /## Intent Routing/);
  assert.match(skill, /references\/recap\/overview\.md/);
  assert.match(skill, /first word is `recap`/i);
  assert.match(skill, /Everything after `recap` is the recap target/);
  assert.match(skill, /`\/obelisk recap this week`/);
  assert.match(skill, /`\/obelisk recap this month`/);
  assert.match(skill, /`\/obelisk recap last week`/);
  assert.match(skill, /`\/obelisk recap last month`/);
  assert.match(skill, /do not load\s+`references\/recap\/overview\.md`/);
  assert.doesNotMatch(skill, /NetEase-style chart/);
  assert.doesNotMatch(skill, /playful personal progress recap/);
});

test('README lists the recap folder without making recap the core retrieval path', async () => {
  const readme = await read('README.md');

  assert.match(readme, /references\/recap\/overview\.md/);
  for (const [n, name] of cards) {
    assert.match(readme, new RegExp(`skill-doc/references/recap/pattern${n}-${name}\\.md`));
    assert.match(readme, new RegExp(`skill-doc/references/recap/writing${n}-${name}\\.md`));
  }
  assert.match(readme, /optional .*\/obelisk recap/i);
  assert.match(readme, /explicit `\/obelisk recap` intent/);
  assert.match(readme, /card-by-card/i);
});

test('old recap references are thin redirects to the split docs', async () => {
  const retrieval = await read('skill-doc/references/recap-patterns.md');
  const writing = await read('skill-doc/references/recap-writing.md');

  assert.match(retrieval, /compatibility/i);
  assert.match(retrieval, /references\/recap\/overview\.md/);
  assert.match(retrieval, /Do not use this as an all-in-one/i);
  assert.match(writing, /compatibility/i);
  assert.match(writing, /references\/recap\/overview\.md/);
  assert.match(writing, /per-card writing/i);
  assert.ok(retrieval.length < 1200);
  assert.ok(writing.length < 1200);
});

test('recap overview defines the card-by-card retrieval and writing loop', async () => {
  const ref = await read('skill-doc/references/recap/overview.md');

  assert.match(ref, /Highest Priority: Phase Loop/i);
  assert.match(ref, /Spotify Wrapped-like/i);
  assert.match(ref, /share cards/i);
  assert.match(ref, /make the user's work feel seen/i);
  assert.match(ref, /Do not criticize/i);
  assert.match(ref, /Do not preload all recap files/i);
  assert.match(ref, /Do not gather all\s+evidence first/i);
  assert.match(ref, /Update\/write the JSON for Card 1 now/i);
  assert.match(ref, /Only after the JSON is updated, move to Card 2/i);
  assert.match(ref, /pattern1-cover\.md[\s\S]*writing1-cover\.md/);
  assert.match(ref, /pattern2-thinking\.md[\s\S]*writing2-thinking\.md/);
  assert.match(ref, /pattern3-vibe\.md[\s\S]*writing3-vibe\.md/);
  assert.match(ref, /pattern4-workflow\.md[\s\S]*writing4-workflow\.md/);
  assert.match(ref, /pattern5-closing\.md[\s\S]*writing5-closing\.md/);
});

test('recap overview stays narrow and leaves card details to per-card files', async () => {
  const ref = await read('skill-doc/references/recap/overview.md');

  assert.ok(ref.split('\n').length < 90);
  assert.match(ref, /The per-card files own retrieval details/i);
  assert.doesNotMatch(ref, /schema_version/);
  assert.doesNotMatch(ref, /obelisk\.recap\.v1/);
  assert.doesNotMatch(ref, /~\/\.obelisk\/recap\//);
  assert.doesNotMatch(ref, /references\/schema\.md/);
  assert.doesNotMatch(ref, /## JSON Shape/);

  for (const archetype of [
    'architect',
    'debugger',
    'shipper',
    'curator',
    'director',
    'cartographer',
    'wanderer',
  ]) {
    assert.match(ref, new RegExp(`\\b${archetype}\\b`));
  }
});

test('each recap card has a separate retrieval pattern and writing reference', async () => {
  for (const [n, name] of cards) {
    const pattern = await read(`skill-doc/references/recap/pattern${n}-${name}.md`);
    const writing = await read(`skill-doc/references/recap/writing${n}-${name}.md`);

    assert.match(pattern, new RegExp(`# Card ${n} .* Retrieval`));
    assert.match(pattern, /Read this card's writing file immediately after/i);
    assert.match(pattern, /update the JSON/i);
    assert.match(pattern, /evidence/i);
    if (n !== '5') assert.match(pattern, /Do not read `pattern/);
    assert.doesNotMatch(pattern, /## JSON Shape/);

    assert.match(writing, new RegExp(`# Card ${n} .* Writing`));
    assert.match(writing, /Mock taste anchor/i);
    assert.match(writing, /## JSON Shape/);
    assert.match(writing, /Before writing/i);
    assert.match(writing, /After writing/i);
    assert.match(writing, /evidence_refs/);
    if (n !== '1' && n !== '5') assert.match(writing, /Update the JSON now before reading/i);
  }
});

test('cover and closing writing own JSON initialization and final save rules', async () => {
  const cover = await read('skill-doc/references/recap/writing1-cover.md');
  const closing = await read('skill-doc/references/recap/writing5-closing.md');

  assert.match(cover, /First JSON Write/i);
  assert.match(cover, /schema_version: "obelisk\.recap\.v1"/);
  assert.match(cover, /~\/\.obelisk\/recap\//);
  assert.match(cover, /recap-\{YYYY\}-W\{WW\}\.json/);
  assert.match(cover, /recap-\{YYYY\}-\{MM\}\.json/);
  assert.match(closing, /Final save rules/i);
  assert.match(closing, /file contains only the JSON object/i);
  assert.match(closing, /Keep exactly five cards/i);
});

test('cover card retrieval and writing choose one dominant human claim', async () => {
  const pattern = await read('skill-doc/references/recap/pattern1-cover.md');
  const writing = await read('skill-doc/references/recap/writing1-cover.md');

  assert.match(pattern, /dominant claim/i);
  assert.match(pattern, /persona/i);
  assert.match(pattern, /activity/i);
  assert.match(pattern, /footer/i);
  assert.match(pattern, /not a topic inventory/i);
  assert.match(writing, /从零设计了一个完整的 memory 系统。/);
  assert.match(writing, /one plain claim/i);
  assert.match(writing, /one breath/i);
  assert.match(writing, /not a topic list/i);
  assert.match(writing, /The Architect/);
});

test('cover card schema uses claim instead of subtitle', async () => {
  const pattern = await read('skill-doc/references/recap/pattern1-cover.md');
  const writing = await read('skill-doc/references/recap/writing1-cover.md');
  const component = await read('app/src/renderer/src/components/recap/CoverCard.vue');
  const detail = await read('app/src/renderer/src/views/RecapDetail.vue');
  const list = await read('app/src/renderer/src/views/RecapList.vue');
  const mock = await read('app/src/renderer/src/mock/recap-2026-W24.json');

  assert.match(pattern, /claim that lists three topics/i);
  assert.doesNotMatch(pattern, /subtitle/);
  assert.match(writing, /claim: string/);
  assert.match(writing, /persona: \{ archetype: string; title: string; claim: string; tone: string \}/);
  assert.match(writing, /cover\.claim/);
  assert.match(writing, /persona\.claim/);
  assert.doesNotMatch(writing, /cover\.subtitle/);
  assert.doesNotMatch(writing, /persona\.subtitle/);
  assert.match(component, /claim:\s*String/);
  assert.match(component, /claim\s*\|\|\s*subtitle/);
  assert.match(detail, /cover\.claim\s*\|\|\s*cover\.subtitle/);
  assert.match(list, /persona\?\.claim\s*\|\|\s*r\.persona\?\.subtitle/);
  assert.match(mock, /"claim": "从零设计了一个完整的 memory 系统。"/);
});

test('thinking card retrieval searches for turns instead of implementation timeline', async () => {
  const pattern = await read('skill-doc/references/recap/pattern2-thinking.md');
  const writing = await read('skill-doc/references/recap/writing2-thinking.md');

  assert.match(pattern, /turning points/i);
  assert.match(pattern, /user question/i);
  assert.match(pattern, /friction/i);
  assert.match(pattern, /what changed in the user's mind/i);
  assert.match(pattern, /not a project timeline/i);
  assert.match(pattern, /not an implementation log/i);
  assert.match(writing, /Five questions, five turns\./);
  assert.match(writing, /raw SQLite, no wiki/);
  assert.match(writing, /unified filter opts, not DSL/);
  assert.match(writing, /is_error in JSONL/);
  assert.match(writing, /soft-delete, human-only/);
  assert.match(writing, /GitHub-style activity timeline/);
  assert.match(writing, /turn.*short decision fragment/i);
});

test('thinking path schema uses turn instead of outcome', async () => {
  const pattern = await read('skill-doc/references/recap/pattern2-thinking.md');
  const writing = await read('skill-doc/references/recap/writing2-thinking.md');
  const component = await read('app/src/renderer/src/components/recap/PathCard.vue');
  const mock = await read('app/src/renderer/src/mock/recap-2026-W24.json');

  assert.match(pattern, /prompt, turn, and an `evidence` anchor/i);
  assert.doesNotMatch(pattern, /outcome/);
  assert.match(writing, /turn: string/);
  assert.match(writing, /"turn": "raw SQLite, no wiki"/);
  assert.match(writing, /`turn`: short decision fragment/i);
  assert.doesNotMatch(writing, /outcome: string/);
  assert.match(component, /item\.turn\s*\|\|\s*item\.outcome/);
  assert.match(mock, /"turn": "raw SQLite, no wiki"/);
});

test('vibe card retrieval finds small user voice, not a correction audit', async () => {
  const pattern = await read('skill-doc/references/recap/pattern3-vibe.md');
  const writing = await read('skill-doc/references/recap/writing3-vibe.md');

  assert.match(pattern, /catchphrases/i);
  assert.match(pattern, /visible user messages/i);
  assert.match(pattern, /COALESCE\(m\.is_meta,0\)=0/);
  assert.match(pattern, /not a correction log/i);
  assert.match(pattern, /not bracketed runtime/i);
  assert.match(writing, /A short character study\./);
  assert.match(writing, /这太丑了/);
  assert.match(writing, /可以/);
  assert.match(writing, /你在干什么/);
  assert.match(writing, /voice_lines\[\]\.text.*exact user words/i);
  assert.match(writing, /meter is not a diagnosis/i);
  assert.match(writing, /Do not use `\[Request interrupted by user\]`/);
});

test('vibe card schema uses voice_lines instead of observations', async () => {
  const writing = await read('skill-doc/references/recap/writing3-vibe.md');
  const component = await read('app/src/renderer/src/components/recap/VibeCard.vue');
  const detail = await read('app/src/renderer/src/views/RecapDetail.vue');
  const mock = await read('app/src/renderer/src/mock/recap-2026-W24.json');

  assert.match(writing, /voice_lines: Array/);
  assert.match(writing, /"voice_lines": \[/);
  assert.match(writing, /voice_lines\[\]\.label/);
  assert.doesNotMatch(writing, /observations: Array/);
  assert.match(component, /voiceLines:\s*Array/);
  assert.match(component, /voiceLines\s*\|\|\s*observations/);
  assert.match(detail, /vibe\.voice_lines\s*\|\|\s*vibe\.observations/);
  assert.match(mock, /"voice_lines": \[/);
});

test('workflow card retrieval scopes real workflow runs and user reactions', async () => {
  const pattern = await read('skill-doc/references/recap/pattern4-workflow.md');
  const writing = await read('skill-doc/references/recap/writing4-workflow.md');

  assert.match(pattern, /workflows\.timestamp/);
  assert.match(pattern, /workflows\(\{ project: .* after, before/i);
  assert.match(pattern, /Do not derive workflow counts only from `sessions\(\{ after, before \}\)`/i);
  assert.match(pattern, /Do not scope workflow lookup by exact `project_path`/i);
  assert.match(pattern, /user message immediately following/i);
  assert.match(pattern, /rank rows by the strength of the user reaction/i);
  assert.match(pattern, /not by agent count/i);
  assert.match(pattern, /actual workflow_name/i);
  assert.match(writing, /Three workflows\. Forty-two agents\./);
  assert.match(writing, /hono-plugin-review/);
  assert.match(writing, /vue-migration/);
  assert.match(writing, /split-render-js/);
  assert.match(writing, /完美/);
  assert.match(writing, /你这页面完全和之前的不一样/);
  assert.match(writing, /Mostly tolerated\./);
  assert.match(writing, /reaction.*user reaction/i);
  assert.match(writing, /Agent counts belong only in `title` or `stats`/i);
  assert.match(writing, /`13 agents, the big build`[\s\S]*invalid/i);
  assert.doesNotMatch(writing, /tiny factual verdict/i);
  assert.match(writing, /omit the row rather than write an implementation result/i);
});

test('workflow card uses reaction instead of outcome for row copy', async () => {
  const pattern = await read('skill-doc/references/recap/pattern4-workflow.md');
  const writing = await read('skill-doc/references/recap/writing4-workflow.md');
  const component = await read('app/src/renderer/src/components/recap/WorkflowCard.vue');
  const mock = await read('app/src/renderer/src/mock/recap-2026-W24.json');

  assert.match(pattern, /items\[\]\.reaction/i);
  assert.match(writing, /reaction: string/);
  assert.match(writing, /"reaction": "完美"/);
  assert.match(writing, /items\[\]\.reaction/);
  assert.doesNotMatch(writing, /items\[\]\.outcome/);
  assert.doesNotMatch(writing, /"outcome": "完美"/);
  assert.match(component, /item\.reaction\s*\|\|\s*item\.outcome/);
  assert.match(mock, /"reaction": "完美"/);
});

test('workflow card schema uses deck instead of summary for the visible line', async () => {
  const writing = await read('skill-doc/references/recap/writing4-workflow.md');
  const component = await read('app/src/renderer/src/components/recap/WorkflowCard.vue');
  const detail = await read('app/src/renderer/src/views/RecapDetail.vue');
  const mock = await read('app/src/renderer/src/mock/recap-2026-W24.json');

  assert.match(writing, /deck\?: string/);
  assert.match(writing, /"deck": "你召唤了机器军团。结果各有不同。"/);
  assert.match(writing, /`deck`: optional second line/i);
  assert.doesNotMatch(writing, /summary\?: string/);
  assert.match(component, /deck:\s*String/);
  assert.match(component, /deck\s*\|\|\s*summary/);
  assert.match(detail, /workflow\.deck\s*\|\|\s*workflow\.summary/);
  assert.match(mock, /"deck": "你召唤了机器军团。结果各有不同。"/);
});

test('closing card retrieval and writing keep a small personal receipt', async () => {
  const pattern = await read('skill-doc/references/recap/pattern5-closing.md');
  const writing = await read('skill-doc/references/recap/writing5-closing.md');

  assert.match(pattern, /same period and source scope/i);
  assert.match(pattern, /streak/i);
  assert.match(pattern, /most said phrase/i);
  assert.match(pattern, /consistent metric/i);
  assert.match(pattern, /not a second summary/i);
  assert.match(writing, /19 days/);
  assert.match(writing, /847 messages exchanged/);
  assert.match(writing, /好的开始做吧/);
  assert.match(writing, /See you next week\./);
  assert.match(writing, /not a naked number/i);
  assert.match(writing, /quiet goodbye/i);
  assert.match(writing, /at most two `receipts`/i);
});

test('closing card schema uses receipts instead of stats', async () => {
  const pattern = await read('skill-doc/references/recap/pattern5-closing.md');
  const writing = await read('skill-doc/references/recap/writing5-closing.md');
  const component = await read('app/src/renderer/src/components/recap/ClosingCard.vue');
  const detail = await read('app/src/renderer/src/views/RecapDetail.vue');
  const mock = await read('app/src/renderer/src/mock/recap-2026-W24.json');

  assert.match(pattern, /one or two compact receipts/i);
  assert.doesNotMatch(pattern, /receipt stats/);
  assert.match(writing, /receipts: string\[\]/);
  assert.match(writing, /"receipts": \["847 messages exchanged", "12 corrections · 47 approvals"\]/);
  assert.match(writing, /`receipts`: at most two/i);
  assert.doesNotMatch(writing, /stats: string\[\]/);
  assert.match(component, /receipts:\s*Array/);
  assert.match(component, /receipts\s*\|\|\s*stats/);
  assert.match(detail, /closing\.receipts\s*\|\|\s*closing\.stats/);
  assert.match(mock, /"receipts": \["847 messages exchanged", "12 corrections · 47 approvals"\]/);
});

test('split recap writing keeps mixed-language rhythm and plain speech', async () => {
  const overview = await read('skill-doc/references/recap/overview.md');
  const writingDocs = await Promise.all(
    cards.map(([n, name]) => read(`skill-doc/references/recap/writing${n}-${name}.md`)),
  );
  const combined = [overview, ...writingDocs].join('\n');

  assert.match(combined, /not a translation task/i);
  assert.match(combined, /English chrome/i);
  assert.match(combined, /source language/i);
  assert.match(combined, /chat bubble/i);
  assert.match(combined, /If it sounds like a topic list or report heading/i);
  assert.match(combined, /one plain claim/i);
  assert.match(combined, /exact user words/i);
});
