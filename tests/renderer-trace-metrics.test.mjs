import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rendererTaskMetrics, stationaryTimingVerdict, wheelTimingVerdict } from '../app/tests/renderer-trace-metrics.mjs';

// Actual Electron 43.2.0 trace, 2026-10-02: 2,000-message timeline, native
// 960px wheel gesture, 24x CPU stress. Only renderer task/function durations
// and marks are retained; no transcript content, paths, or screenshots.
const trace = JSON.parse(readFileSync(new URL('./fixtures/renderer-wheel-trace.json', import.meta.url), 'utf8'));
const start = trace[0];
const end = trace.at(-1);
const recordedTask = trace.find(event => /RunTask$/.test(event.name) && event.tdur > 0);
const measure = events => rendererTaskMetrics(events, start.name, end.name);
const task = (dur, tdur) => ({ ...recordedTask, dur, tdur });

test('recorded renderer CPU stalls still exceed the shared-runner long-task budget', () => {
  const metrics = measure(trace);
  assert.ok(metrics.maxTaskWorkMs > 50, 'a real CPU stall must still fail the 50ms gate');
});

test('scheduler waiting alone is reported without being charged as renderer CPU work', () => {
  const metrics = measure([start, task(120000, 5000), end]);
  assert.equal(metrics.maxTaskMs, 120);
  assert.equal(metrics.maxTaskWorkMs, 5);
});

test('a slow waiting task cannot hide a different task with excessive CPU work', () => {
  const metrics = measure([start, task(120000, 1000), task(60000, 60000), end]);
  assert.equal(metrics.slowestTaskCpuMs, 1);
  assert.equal(metrics.maxTaskWorkMs, 60, 'the gate examines all tasks, not just the wall-clock winner');
});

test('missing CPU duration conservatively charges the complete wall duration', () => {
  const event = task(60000, undefined);
  const metrics = measure([start, event, end]);
  assert.equal(metrics.maxTaskWorkMs, 60);
  assert.equal(metrics.tasksWithoutCpu, 1);
});

test('invalid trace durations fail measurement instead of passing a budget', () => {
  assert.throws(() => measure([start, task(NaN, 5), end]), /duration/i);
  assert.throws(() => measure([start, task(1000, -1), end]), /duration/i);
});

test('work on other threads or outside the probe cannot distort its CPU budget', () => {
  const metrics = measure([
    start, task(1000, 1000),
    { ...task(900000, 900000), tid: start.tid + 1 },
    { ...task(900000, 900000), ts: end.ts + 1 },
    end,
  ]);
  assert.equal(metrics.maxTaskWorkMs, 1);
  assert.equal(metrics.tasks, 1);
});

test('missing trace marks and missing renderer tasks fail measurement', () => {
  assert.throws(() => measure([]), /Missing renderer trace marks/);
  assert.throws(() => measure([start, end]), /no RunTask/);
});

const gesture = (maxTaskWorkMs, maxFrameGap, maxFunctionWorkMs = 1) => ({ maxTaskWorkMs, maxFrameGap, maxFunctionWorkMs });

test('one catastrophic wheel stall fails although the other gestures are smooth', () => {
  const baselines = [gesture(3, 30), gesture(3, 30), gesture(3, 30)];
  const verdict = wheelTimingVerdict(baselines, [gesture(3, 310), gesture(3, 30), gesture(3, 31)]);
  assert.equal(verdict.stall, false);
  assert.equal(verdict.longTask, true);
});

test('one long task fails although the other gestures stay short', () => {
  const baselines = [gesture(3, 30), gesture(3, 30), gesture(3, 30)];
  const verdict = wheelTimingVerdict(baselines, [gesture(65, 30), gesture(22, 30), gesture(23, 30)]);
  assert.equal(verdict.longTask, false);
  assert.equal(verdict.stall, true);
});

test('patch preparation holds its 2ms budget for the median, not a single noisy gesture', () => {
  const baselines = [gesture(3, 30, 1), gesture(3, 30, 1), gesture(3, 30, 8)];
  assert.equal(wheelTimingVerdict(baselines, [gesture(3, 30, 6), gesture(3, 30, 1), gesture(3, 30, 1.5)]).patchPreparation, true);
  assert.equal(wheelTimingVerdict(baselines, [gesture(3, 30, 6), gesture(3, 30, 4), gesture(3, 30, 1.5)]).patchPreparation, false);
});

test('one stationary commit with a long task fails although the median is inside 120Hz', () => {
  const verdict = stationaryTimingVerdict([{ maxTaskWorkMs: 60 }, { maxTaskWorkMs: 2 }, { maxTaskWorkMs: 2 }]);
  assert.equal(verdict.longTask, false);
  assert.equal(verdict.budget, true);
});

test('stationary commits that all exceed 120Hz fail the work budget', () => {
  assert.equal(stationaryTimingVerdict([{ maxTaskWorkMs: 9 }, { maxTaskWorkMs: 40 }, { maxTaskWorkMs: 2 }]).budget, false);
  assert.equal(stationaryTimingVerdict([{ maxTaskWorkMs: 17 }, { maxTaskWorkMs: 17 }, { maxTaskWorkMs: 17 }]).budget, false);
});
