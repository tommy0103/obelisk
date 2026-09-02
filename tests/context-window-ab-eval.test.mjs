// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_EVAL_POLICY,
  buildArmPatch,
  parseSessionJsonl,
  qualifyRun,
  summarizeSession,
  validatePolicy,
} from '../scripts/context-window-ab-eval-lib.mjs';
import { recoverRunSlot, resolveDshBin } from '../scripts/context-window-ab-eval.mjs';

test('A/B arms share a 200K normal-budget boundary while selecting one pressure policy', () => {
  const compact = buildArmPatch({ arm: 'compact', sessionsRoot: '/tmp/compact' });
  const rollover = buildArmPatch({ arm: 'rollover', sessionsRoot: '/tmp/rollover' });

  assert.match(compact, /contextWindow: 200000/u);
  assert.match(compact, /thresholdRatio: 0\.8/u);
  assert.match(compact, /retainTokens: 32000/u);
  assert.doesNotMatch(compact, /obelisk-context-window/u);

  assert.match(rollover, /contextWindow: 200000/u);
  assert.match(rollover, /auto: false/u);
  assert.match(rollover, /obelisk-context-window/u);
  assert.match(rollover, /fallbackReserveTokens: 24000/u);
  assert.match(rollover, /outputReserveTokens: 16000/u);
});

test('policy validation refuses comparisons with unequal normal budgets', () => {
  assert.throws(() => validatePolicy({ ...DEFAULT_EVAL_POLICY, normalBudget: 159_999 }), {
    message: /normalBudget must equal/u,
  });
});

test('session metrics distinguish compaction, model rollover, forced rollover, and provider usage', () => {
  const lines = [
    { type: 'session', version: 0, id: 'eval' },
    { type: 'request/context', data: { provider: 'p', model: 'm', contextWindow: 200_000 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'compaction/start', data: {} },
    { type: 'compaction/summary', data: { usage: { inputTokens: 10, outputTokens: 5 } } },
    { type: 'compaction/end', data: {} },
    {
      type: 'assistant/message',
      data: { usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: 5, cacheReadTokens: 40 } },
    },
    { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"obelisk search test"}' } },
    { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"obelisk search test"}' } },
    {
      type: 'user/message',
      data: { source: { kind: 'obelisk-context-pressure', phase: 'reminder' } },
    },
    {
      type: 'user/message',
      data: { source: { kind: 'obelisk-context-handoff', trigger: { kind: 'model' }, handoffStatus: 'present' } },
    },
    {
      type: 'user/message',
      data: { source: { kind: 'obelisk-context-handoff', trigger: { kind: 'hard-limit' }, handoffStatus: 'missing' } },
    },
    { type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ];
  const events = parseSessionJsonl(lines.map(line => JSON.stringify(line)).join('\n'));
  const summary = summarizeSession(events);

  assert.equal(summary.completed, true);
  assert.equal(summary.totalProviderTokens, 175);
  assert.equal(summary.usage.inputTokens, 110);
  assert.equal(summary.policyBoundaries, 3);
  assert.deepEqual(summary.observedContextWindows, [200_000]);
  assert.deepEqual(summary.compaction, { starts: 1, summaries: 1, ends: 1 });
  assert.deepEqual(summary.rollover, {
    reminders: 1,
    fallbacks: 0,
    handoffs: 2,
    modelRequested: 1,
    forced: 1,
    missingHandoffs: 1,
  });
  assert.equal(summary.obeliskCalls, 2);
  assert.equal(summary.repeatedBashCalls, 1);
});

test('200K runs using at least 450K and crossing two boundaries qualify without a cache-read ceiling', () => {
  const qualified = { policyBoundaries: 2, totalProviderTokens: 500_000, observedContextWindows: [200_000] };
  assert.deepEqual(qualifyRun(qualified), {
    crossedAtLeastTwoBoundaries: true,
    reachedMinimumProviderUsage: true,
    observedRequiredContext: true,
    eligible: true,
  });
  assert.equal(qualifyRun({ ...qualified, policyBoundaries: 1 }).eligible, false);
  assert.equal(qualifyRun({ ...qualified, totalProviderTokens: 200_000 }).eligible, false);
  assert.equal(qualifyRun({ ...qualified, totalProviderTokens: 150_000_000 }).eligible, true);
  assert.equal(qualifyRun({ ...qualified, observedContextWindows: [128_000] }).eligible, false);
});

test('CLI dry-run materializes an auditable plan without invoking a model', () => {
  const root = mkdtempSync(join(tmpdir(), 'obelisk-context-window-eval-'));
  const dshRoot = join(root, 'deepseek-harness');
  const output = join(root, 'plan');
  mkdirSync(dshRoot);
  try {
    const result = spawnSync(process.execPath, [
      'scripts/context-window-ab-eval.mjs',
      '--output', output,
      '--dsh-root', dshRoot,
    ], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(readFileSync(join(output, 'plan.json'), 'utf8'));
    assert.equal(plan.mode, 'dry-run');
    assert.deepEqual(plan.arms, ['compact', 'rollover']);
    assert.equal(plan.policy.contextWindow, 200_000);
    assert.equal(plan.fairness.oracleTestsInjectedAfterAgentStops, true);
    const resumed = spawnSync(process.execPath, [
      'scripts/context-window-ab-eval.mjs',
      '--output', output,
      '--dsh-root', dshRoot,
    ], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    assert.equal(resumed.status, 0, resumed.stderr);
    const originalPatch = readFileSync(join(output, 'compact.patch.yml'), 'utf8');
    const conflicting = spawnSync(process.execPath, [
      'scripts/context-window-ab-eval.mjs',
      '--output', output,
      '--dsh-root', dshRoot,
      '--model', 'different-model',
    ], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    assert.notEqual(conflicting.status, 0);
    assert.equal(readFileSync(join(output, 'compact.patch.yml'), 'utf8'), originalPatch);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an interrupted run directory is cleared while an atomic result is reused', () => {
  const output = mkdtempSync(join(tmpdir(), 'obelisk-context-window-resume-'));
  const run = join(output, 'compact-01');
  try {
    mkdirSync(run);
    writeFileSync(join(run, 'partial.log'), 'interrupted');
    assert.equal(recoverRunSlot(output, run), undefined);
    assert.equal(existsSync(run), false);

    mkdirSync(run);
    writeFileSync(join(run, 'result.json'), '{"completed":true}\n');
    assert.deepEqual(recoverRunSlot(output, run), { completed: true });
    assert.equal(existsSync(run), true);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test('real execution uses the built DSH CLI instead of candidate-scoped tsx resolution', () => {
  const root = mkdtempSync(join(tmpdir(), 'obelisk-dsh-bin-'));
  const built = join(root, 'apps', 'cli', 'lib', 'bin.js');
  try {
    mkdirSync(join(root, 'apps', 'cli', 'lib'), { recursive: true });
    mkdirSync(join(root, 'apps', 'cli', 'src'), { recursive: true });
    writeFileSync(built, '');
    writeFileSync(join(root, 'apps', 'cli', 'src', 'bin.ts'), '');
    assert.equal(resolveDshBin(root), built);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
