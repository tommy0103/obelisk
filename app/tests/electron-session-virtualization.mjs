// Production renderer integration test for the dynamic SessionDetail timeline.
// Run: npm run test:electron:timeline
import { app, BrowserWindow, ipcMain, nativeImage } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createSessionPatch } from '../src/shared/session-patch.mjs';
import { assembleSessionDetail } from '../src/shared/session-detail-assembly.mjs';
import { rendererTaskMetrics } from './renderer-trace-metrics.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const sessionId = 'test-session';
const messageCount = Number(process.env.OBELISK_TIMELINE_MESSAGE_COUNT || 2000);
const coldOpenOnly = process.argv.includes('--cold-open-only');
const focusMessageIndex = Math.floor(messageCount * 0.75);
const focusMessageUuid = `message-${focusMessageIndex}`;
const stationaryAppendRuns = 3;
const firstStationaryAppendIndex = messageCount;
const scrollingAppendIndex = messageCount + stationaryAppendRuns;
const nearTailEscapeAppendIndex = scrollingAppendIndex + 1;
const tailAppendIndex = nearTailEscapeAppendIndex + 1;
const channels = [
  'db:getSessions',
  'db:getSessionMessages',
  'db:getSessionToolCalls',
  'db:getSessionToolResults',
  'db:getSessionPatch',
  'db:getSessionSubagents',
  'db:getSessionWorkflows',
  'db:getSessionSummaries',
  'db:getMessageFullText',
  'db:getMemories',
  'db:getProjects',
  'db:getStats',
  'settings:get',
];

let failures = 0;
let firstSessionListRead = true;
let nextPatchDelayMs = 0;
let scrollingContentUuid = null;
let scrollingContentText = null;
let stressGlobalCatalogue = false;
let currentSessionTitle = 'Virtualized timeline integration';
const ipcReads = {
  messages: 0,
  toolCalls: 0,
  toolResults: 0,
  subagents: 0,
  workflows: 0,
  summaries: 0,
  patches: 0,
  patchMessageRows: [],
};
const globalReads = {
  sessions: 0,
  memories: 0,
  projects: 0,
  stats: 0,
};
const messages = Array.from({ length: messageCount }, (_, index) => ({
  uuid: `message-${index}`,
  type: index % 2 === 0 ? 'user' : 'assistant',
  timestamp: new Date(Date.UTC(2026, 6, 14, 0, 0, index)).toISOString(),
  text: index === 1
    ? ''
    : `Message ${index} ${'dynamic-height content '.repeat((index % 7) + 1)}`,
  content_type: index === 1 ? 'tool_use' : 'text',
  is_meta: 0,
}));
for (const startIndex of [96, 196]) {
  for (let index = startIndex; index < startIndex + 8; index++) {
    messages[index].text = Array.from(
      { length: 120 },
      (_, paragraph) => `Unmeasured paragraph ${paragraph} for message ${index} stays visible while scrolling.`,
    ).join('\n\n');
  }
}
messages[focusMessageIndex].type = 'assistant';
messages[focusMessageIndex].text = `Truncated preview ${'indexed content '.repeat(700)}`;
const fullTextSentinel = `FULL TEXT SENTINEL ${'complete content '.repeat(80)}`;
const codexExecSource = 'const result = { ok: true };\nreturn result;';
const liveBashToolInput = {
  command: "cat > /tmp/q_jul15b.mjs <<'EOF'\nconst codex = sessions({ source: 'codex', project: '%quiet-zero%', limit: 3 });\n\nconst tail = sql(`\n  SELECT substr(text, 1, 500) as snippet, timestamp, role\n  FROM messages\n  WHERE session_id = ?\n    AND timestamp > '2026-07-14T18:20:00'\n    AND text IS NOT NULL\n    AND COALESCE(is_meta, 0) = 0\n    AND length(text) > 30\n  ORDER BY timestamp DESC\n  LIMIT 5\n`, codex[0]?.id);\n\n// Any new codex sessions for quiet-zero\nconst newer = sql(`\n  SELECT id, title, started_at, ended_at, message_count\n  FROM sessions\n  WHERE COALESCE(source,'claude') = 'codex'\n    AND project LIKE '%quiet-zero%'\n    AND started_at > '2026-07-14T18:00:00'\n  ORDER BY started_at DESC\n  LIMIT 5\n`);\n\nreturn {\n  main: { id: codex[0]?.id, ended: codex[0]?.ended_at, msgs: codex[0]?.message_count },\n  afterLastSync: tail,\n  newerSessions: newer,\n};\nEOF\nobelisk --query /tmp/q_jul15b.mjs",
  description: 'Query for activity since last sync',
};
let codexExecOutput = JSON.stringify([{
  type: 'input_text',
  text: 'Script completed\nWall time 0.1 seconds\nOutput:\n{"ok":true}',
}]);
const toolCalls = [{
  id: 'call-1',
  message_uuid: 'message-1',
  name: 'Bash',
  input_json: JSON.stringify({ command: 'printf virtualized' }),
}, {
  id: 'call-codex-exec',
  message_uuid: focusMessageUuid,
  name: 'exec',
  input_json: JSON.stringify(codexExecSource),
}];
const toolResults = [{
  tool_use_id: 'call-1',
  content: `${'virtualized output\n'.repeat(80)}`,
  is_error: 0,
}, {
  tool_use_id: 'call-codex-exec',
  message_uuid: focusMessageUuid,
  content: codexExecOutput,
  is_error: 0,
}];

function sessionSummary() {
  return {
    id: sessionId,
    title: currentSessionTitle,
    project: 'quiet-zero',
    project_path: '/tmp/quiet-zero',
    source: 'claude',
    started_at: '2026-07-14T00:00:00.000Z',
    ended_at: '2026-07-14T01:00:00.000Z',
    message_count: messages.length,
    git_branch: 'main',
  };
}

function sessionSummaries() {
  return [sessionSummary(), ...Array.from({ length: 999 }, (_, index) => ({
    ...sessionSummary(),
    id: `background-session-${index}`,
    title: `Background session ${index}`,
    project: `project-${index % 250}`,
    project_path: `/tmp/project-${index % 250}`,
    message_count: index % 200,
  }))];
}

function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else {
    failures++;
    console.error(`FAIL: ${message}`);
  }
}

async function waitFor(webContents, expression, message, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await webContents.executeJavaScript(`Boolean(${expression})`, true)) return;
    await delay(40);
  }
  console.error('TIMELINE TIMEOUT', message, JSON.stringify({ ipcReads, scrollingContentUuid, storedText: messages.find(row => row.uuid === scrollingContentUuid)?.text, renderer: await webContents.executeJavaScript(`({ scrollTop: document.querySelector('.detail-wrap')?.scrollTop, rows: [...document.querySelectorAll('.virtual-timeline-row [data-uuid]')].map(row => ({ uuid: row.dataset.uuid, text: row.textContent.slice(0, 80) })) })`) }));
  throw new Error(`Timed out waiting for ${message}`);
}

async function probeOrdinaryScrollGeometry(win, { startIndex, direction }) {
  await win.webContents.executeJavaScript(
    `window.location.hash = '#/sessions/${sessionId}?focus=message-${startIndex}'`,
    true,
  );
  await waitFor(
    win.webContents,
    `document.querySelector('[data-uuid="message-${startIndex}"].is-focused')`,
    `ordinary-scroll geometry start ${startIndex}`,
  );
  await delay(100);
  return win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const wrap = document.querySelector('.detail-wrap');
    const direction = ${direction};
    const originalScrollTo = wrap.scrollTo.bind(wrap);
    const blockAutomaticScrollEnd = event => event.stopImmediatePropagation();
    let programmaticScrolls = 0;
    let maxVisibleOverlaps = 0;
    let overlapExample = null;
    let previousGeometry = null;
    let maxResidualMotion = 0;
    let residualExample = null;
    let stopped = false;
    const cleanup = () => {
      stopped = true;
      clearTimeout(deadline);
      wrap.scrollTo = originalScrollTo;
      wrap.removeEventListener('scrollend', blockAutomaticScrollEnd, true);
    };
    const deadline = setTimeout(() => {
      cleanup();
      reject(new Error('Ordinary-scroll geometry probe timed out'));
    }, 8000);
    wrap.addEventListener('scrollend', blockAutomaticScrollEnd, true);
    wrap.scrollTo = (...args) => {
      programmaticScrolls++;
      return originalScrollTo(...args);
    };
    wrap.dispatchEvent(new WheelEvent('wheel', { deltaY: direction * 70, bubbles: true }));
    const startedAt = performance.now();
    function frame(now) {
      if (stopped) return;
      try { sampleFrame(now); }
      catch (error) { cleanup(); reject(error); }
    }
    function sampleFrame(now) {
      wrap.scrollTop += direction * 100;
      const wrapRect = wrap.getBoundingClientRect();
      const scrollTop = wrap.scrollTop;
      const rows = [...document.querySelectorAll('.virtual-timeline-row')]
        .map(row => {
          const rect = row.getBoundingClientRect();
          return {
            index: Number(row.dataset.index),
            uuid: row.querySelector('[data-uuid]')?.getAttribute('data-uuid'),
            rect,
          };
        })
        .filter(({ rect }) => rect.bottom > wrapRect.top && rect.top < wrapRect.bottom)
        .sort((left, right) => left.index - right.index);
      let overlaps = 0;
      for (let index = 1; index < rows.length; index++) {
        if (rows[index].rect.top < rows[index - 1].rect.bottom - 1) overlaps++;
      }
      if (overlaps > maxVisibleOverlaps) {
        maxVisibleOverlaps = overlaps;
        overlapExample = rows.slice(0, 5).map(row => ({
          index: row.index,
          top: row.rect.top,
          bottom: row.rect.bottom,
        }));
      }
      const geometry = new Map(rows.filter(row => row.uuid).map(row => [
        row.uuid,
        row.rect.top - wrapRect.top,
      ]));
      if (previousGeometry) {
        for (const [uuid, top] of geometry) {
          if (!previousGeometry.rows.has(uuid)) continue;
          const screenDelta = top - previousGeometry.rows.get(uuid);
          const scrollDelta = scrollTop - previousGeometry.scrollTop;
          const residual = screenDelta + scrollDelta;
          if (Math.abs(residual) > Math.abs(maxResidualMotion)) {
            maxResidualMotion = residual;
            residualExample = { uuid, screenDelta, scrollDelta, residual };
          }
        }
      }
      previousGeometry = { rows: geometry, scrollTop };
      if (now - startedAt < 2000) {
        requestAnimationFrame(frame);
        return;
      }
      cleanup();
      wrap.dispatchEvent(new Event('scrollend'));
      resolve({
        programmaticScrolls,
        maxVisibleOverlaps,
        overlapExample,
        maxResidualMotion,
        residualExample,
      });
    }
    requestAnimationFrame(frame);
  })`, true);
}

async function startRendererTrace(win, { captureScreenshots = false } = {}) {
  const traceEvents = [];
  let completeTrace;
  const traceComplete = new Promise(resolve => { completeTrace = resolve; });
  const onMessage = (_event, method, params = {}) => {
    if (method === 'Tracing.dataCollected') traceEvents.push(...(params.value || []));
    if (method === 'Tracing.tracingComplete') completeTrace();
  };
  const ownsDebugger = !win.webContents.debugger.isAttached();
  if (ownsDebugger) win.webContents.debugger.attach('1.3');
  win.webContents.debugger.on('message', onMessage);
  await win.webContents.debugger.sendCommand('Tracing.start', {
    categories: [
      'devtools.timeline',
      'disabled-by-default-devtools.timeline',
      'blink.user_timing',
      'toplevel',
      captureScreenshots ? 'disabled-by-default-devtools.screenshot' : '',
      captureScreenshots ? 'viz' : '',
    ].filter(Boolean).join(','),
    options: 'record-as-much-as-possible',
    transferMode: 'ReportEvents',
  });
  return async () => {
    await win.webContents.debugger.sendCommand('Tracing.end');
    await traceComplete;
    win.webContents.debugger.removeListener('message', onMessage);
    if (ownsDebugger) win.webContents.debugger.detach();
    return traceEvents;
  };
}

function screenshotContentDeviation(event) {
  const image = nativeImage.createFromBuffer(Buffer.from(event.args.snapshot, 'base64'));
  const size = image.getSize();
  const crop = image.crop({
    x: Math.floor(size.width * 0.32),
    y: Math.floor(size.height * 0.2),
    width: Math.max(1, Math.floor(size.width * 0.5)),
    height: Math.max(1, Math.floor(size.height * 0.6)),
  });
  const bitmap = crop.toBitmap();
  let sum = 0;
  let sumSquares = 0;
  let samples = 0;
  for (let offset = 0; offset + 3 < bitmap.length; offset += 4) {
    const value = (bitmap[offset] + bitmap[offset + 1] + bitmap[offset + 2]) / 3;
    sum += value;
    sumSquares += value * value;
    samples++;
  }
  const mean = sum / samples;
  return Math.sqrt(Math.max(0, sumSquares / samples - mean * mean)) / 255;
}

let wheelTraceRun = 0;
async function traceWheelPaintContinuity(win, { updateTool = false } = {}) {
  const runId = wheelTraceRun++;
  const startMark = `obelisk-wheel-${runId}-start`;
  const endMark = `obelisk-wheel-${runId}-end`;
  // Compositor frame cadence is a foreground-window contract. Merely showing
  // an inactive window does not establish the native activation prerequisite.
  win.show();
  app.focus({ steal: true });
  win.focus();
  for (let attempt = 0; attempt < 40 && !win.isFocused(); attempt++) await delay(20);
  if (!win.isVisible() || !win.isFocused()) {
    throw new Error('Wheel paint probe requires a visible, focused native window');
  }
  await delay(180);
  await win.webContents.executeJavaScript(`(() => {
    const tool = document.querySelector('[data-view-key="tool:call-1"]');
    if (tool && !tool.classList.contains('open')) tool.querySelector('.toolcall-toggle')?.click();
  })()`, true);
  await delay(120);
  const before = await win.webContents.executeJavaScript(
    `document.querySelector('.detail-wrap')?.scrollTop || 0`,
    true,
  );
  const stopRendererTrace = await startRendererTrace(win, { captureScreenshots: true });
  await win.webContents.executeJavaScript(`(() => {
    const wrap = document.querySelector('.detail-wrap');
    const tool = document.querySelector('[data-view-key="tool:call-1"]');
    const probe = {
      gaps: [],
      previous: performance.now(),
      stop: false,
      wheels: 0,
      wheelDistance: 0,
      updateVisibleAtWheel: null,
      maxVisibleOverlaps: 0,
      overlapExample: null,
    };
    const recordWheel = event => {
      probe.wheels++;
      if (probe.wheels === 1) probe.previous = performance.now();
      probe.wheelDistance += Math.abs(event.deltaY);
      if (probe.wheels === 3 && ${JSON.stringify(updateTool)}) {
        void window.obelisk.getSessionSummaries('wheel-bash-update-probe');
      }
    };
    const observer = new MutationObserver(() => {
      if (
        probe.updateVisibleAtWheel === null
        && tool?.querySelector('.prompt-cmd')?.textContent.includes('/tmp/q_jul15b.mjs')
      ) probe.updateVisibleAtWheel = probe.wheels;
    });
    wrap?.addEventListener('wheel', recordWheel, { passive: true });
    if (tool) observer.observe(tool, { childList: true, characterData: true, subtree: true });
    let deadline;
    probe.cleanup = () => {
      clearTimeout(deadline);
      wrap?.removeEventListener('wheel', recordWheel);
      observer.disconnect();
    };
    window.__wheelFrameProbe = probe;
    probe.finish = error => {
      probe.error = error?.message || null;
      probe.stop = true;
      probe.after = wrap.scrollTop;
      performance.mark(${JSON.stringify(endMark)});
      probe.cleanup();
    };
    deadline = setTimeout(() => probe.finish(new Error('Continuous wheel probe timed out')), 8000);
    function samplePaintedRows() {
      const wrapRect = wrap.getBoundingClientRect();
      const rows = [...document.querySelectorAll('.virtual-timeline-row')]
        .map(row => ({
          index: Number(row.dataset.index),
          rect: row.getBoundingClientRect(),
        }))
        .filter(({ rect }) => rect.bottom > wrapRect.top && rect.top < wrapRect.bottom)
        .sort((left, right) => left.index - right.index);
      let overlaps = 0;
      for (let index = 1; index < rows.length; index++) {
        if (rows[index].rect.top < rows[index - 1].rect.bottom - 1) overlaps++;
      }
      if (overlaps > probe.maxVisibleOverlaps) {
        probe.maxVisibleOverlaps = overlaps;
        probe.overlapExample = rows.slice(0, 6).map(row => ({
          index: row.index,
          top: row.rect.top,
          bottom: row.rect.bottom,
        }));
      }
    }
    function frame(now) {
      if (probe.stop) return;
      if (probe.wheels > 0) {
        probe.gaps.push(now - probe.previous);
        probe.previous = now;
      }
      const complete = probe.wheelDistance >= 960 - 0.001;
      // rAF runs before layout/paint. Reading every row there forced a layout
      // inside the benchmark itself. Sample painted geometry in the next task.
      setTimeout(() => {
        if (probe.stop) return;
        try {
          samplePaintedRows();
          if (complete) probe.finish();
        } catch (error) { probe.finish(error); }
      }, 0);
      if (!complete) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  })()`, true);
  if (updateTool) {
    nextPatchDelayMs = 80;
    replaceToolInput(win, 'call-1', liveBashToolInput, { notify: false });
  }
  await win.webContents.executeJavaScript(
    `performance.mark(${JSON.stringify(startMark)})`,
    true,
  );
  // Chromium owns the continuous gesture instead of eight main-process
  // timers. Notify after the third real wheel event, while the gesture is live.
  let gestureDeadline;
  try {
    await Promise.race([
      win.webContents.debugger.sendCommand('Input.synthesizeScrollGesture', {
        x: 800, y: 400, yDistance: -960, speed: 2400,
        gestureSourceType: 'mouse', preventFling: true,
      }),
      new Promise((_, reject) => {
        gestureDeadline = setTimeout(() => reject(new Error('Continuous wheel input timed out')), 8000);
      }),
    ]);
  } finally {
    clearTimeout(gestureDeadline);
  }
  await waitFor(win.webContents, 'window.__wheelFrameProbe?.stop === true', 'final continuous wheel frame');
  const frameProbe = await win.webContents.executeJavaScript(`(() => {
    const probe = window.__wheelFrameProbe;
    if (probe.error) throw new Error(probe.error);
    delete window.__wheelFrameProbe;
    return {
      gaps: probe.gaps,
      after: probe.after,
      wheels: probe.wheels,
      updateVisibleAtWheel: probe.updateVisibleAtWheel,
      maxVisibleOverlaps: probe.maxVisibleOverlaps,
      overlapExample: probe.overlapExample,
    };
  })()`, true);
  const traceEvents = await stopRendererTrace();
  const screenshots = traceEvents
    .filter(event => event.name === 'Screenshot' && event.args?.snapshot);
  const deviations = screenshots.map(screenshotContentDeviation);
  const taskMetrics = rendererTaskMetrics(traceEvents, startMark, endMark);
  const start = traceEvents.find(event => event.name === startMark);
  const end = traceEvents.find(event => event.name === endMark);
  const drawTimes = traceEvents
    .filter(event => event.name === 'Display::DrawAndSwap' && event.ph === 'X'
      && event.ts >= start.ts && event.ts <= end.ts)
    .map(event => event.ts).sort((left, right) => left - right);
  const compositorGaps = drawTimes.slice(1).map((time, index) => (time - drawTimes[index]) / 1000);
  return {
    before,
    after: frameProbe.after,
    wheels: frameProbe.wheels,
    screenshots: screenshots.length,
    minDeviation: Math.min(Infinity, ...deviations),
    maxFrameGap: Math.max(0, ...frameProbe.gaps),
    compositorFrames: drawTimes.length,
    maxCompositorFrameGap: compositorGaps.length ? Math.max(...compositorGaps) : null,
    slowestTaskCpuMs: taskMetrics.slowestTaskCpuMs,
    maxTaskMs: taskMetrics.maxTaskMs,
    maxTaskWorkMs: taskMetrics.maxTaskWorkMs,
    tasksWithoutCpu: taskMetrics.tasksWithoutCpu,
    maxFunctionWorkMs: taskMetrics.maxFunctionWorkMs,
    maxFunctionCallMs: taskMetrics.maxFunctionCallMs,
    updateVisibleAtWheel: frameProbe.updateVisibleAtWheel,
    maxVisibleOverlaps: frameProbe.maxVisibleOverlaps,
    overlapExample: frameProbe.overlapExample,
    slowestChildren: taskMetrics.slowestChildren,
    // A blank content crop is almost uniform (< 0.035); rendered fixture rows
    // stay comfortably above 0.06 even while the compositor is scrolling.
    blankFrames: deviations.filter(value => value < 0.035).length,
  };
}

// A stationary commit must start after navigation, focus highlighting and
// virtual-row measurement have settled, rather than a fixed host-side delay.
async function waitForStationaryLayout(win) {
  await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Timeline did not settle before stationary trace')), 8000);
    let previous = null;
    let stableSince = performance.now();
    function sample(now) {
      const wrap = document.querySelector('.detail-wrap');
      const geometry = JSON.stringify([wrap?.scrollTop, wrap?.scrollHeight,
        ...[...document.querySelectorAll('.virtual-timeline-row')].map(row => {
          const rect = row.getBoundingClientRect();
          return [row.dataset.index, rect.top, rect.height];
        })]);
      if (geometry !== previous || document.querySelector('.is-focused, .flap-slot.flipping')) stableSince = now;
      previous = geometry;
      if (now - stableSince >= 500) { clearTimeout(deadline); resolve(true); }
      else requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  })`, true);
}

async function traceStationaryAppend(win, index, expectedTotal, runIndex) {
  const startMark = `obelisk-live-commit-${runIndex}-start`;
  const endMark = `obelisk-live-commit-${runIndex}-end`;
  const stopRendererTrace = await startRendererTrace(win);
  await win.webContents.executeJavaScript(`(() => {
    const expected = ${JSON.stringify(String(expectedTotal))};
    const counter = document.querySelector('.flap-number');
    performance.mark(${JSON.stringify(startMark)});
    window.__obeliskLiveCommitObserved = new Promise((resolve, reject) => {
      let observer = null;
      const deadline = setTimeout(() => {
        observer?.disconnect();
        reject(new Error('Stationary live commit did not publish its counter'));
      }, 8000);
      const finish = () => requestAnimationFrame(() => {
        clearTimeout(deadline);
        performance.mark(${JSON.stringify(endMark)});
        resolve(true);
      });
      if (counter?.getAttribute('aria-label') === expected) {
        finish();
        return;
      }
      if (!counter) { clearTimeout(deadline); reject(new Error('Missing live counter')); return; }
      observer = new MutationObserver(() => {
        if (counter.getAttribute('aria-label') !== expected) return;
        observer.disconnect();
        finish();
      });
      observer.observe(counter, { attributes: true, attributeFilter: ['aria-label'] });
    });
    return true;
  })()`, true);
  appendMessage(win, index);
  await win.webContents.executeJavaScript('window.__obeliskLiveCommitObserved', true);
  await win.webContents.executeJavaScript('delete window.__obeliskLiveCommitObserved', true);
  return rendererTaskMetrics(await stopRendererTrace(), startMark, endMark);
}

function registerHandlers() {
  ipcMain.handle('db:getSessions', async () => {
    globalReads.sessions++;
    if (firstSessionListRead) {
      firstSessionListRead = false;
      await delay(120);
    }
    return stressGlobalCatalogue ? sessionSummaries() : [sessionSummary()];
  });
  ipcMain.handle('db:getSessionMessages', () => { ipcReads.messages++; return messages; });
  ipcMain.handle('db:getSessionToolCalls', () => { ipcReads.toolCalls++; return toolCalls; });
  ipcMain.handle('db:getSessionToolResults', () => { ipcReads.toolResults++; return toolResults; });
  ipcMain.handle('db:getSessionPatch', async (_event, _sessionId, cursor) => {
    ipcReads.patches++;
    const delayMs = nextPatchDelayMs;
    nextPatchDelayMs = 0;
    if (delayMs > 0) await delay(delayMs);
    const patch = createSessionPatch({
      messages: assembleSessionDetail({ messages, toolCalls, toolResults, subagents: [], workflows: [] }).messages,
      workflows: [],
    }, cursor);
    ipcReads.patchMessageRows.push(patch.changes.messages.length);
    return { ...patch, session: sessionSummary() };
  });
  ipcMain.handle('db:getSessionSubagents', () => { ipcReads.subagents++; return []; });
  ipcMain.handle('db:getSessionWorkflows', () => { ipcReads.workflows++; return []; });
  ipcMain.handle('db:getSessionSummaries', (event, id) => {
    if (id === 'wheel-bash-update-probe') {
      // One daemon build invalidates the catalogue and the current session.
      event.sender.send('obelisk:index-updated', { affectedSessionIds: [sessionId] });
      event.sender.send('obelisk:session-updated', { sessionId });
      return [];
    }
    if (id === 'content-gesture-probe') {
      setTimeout(() => replaceMessageText({ webContents: event.sender }, scrollingContentUuid, scrollingContentText), 200);
      return [];
    }
    if (id === 'scroll-gesture-probe') {
      // Start the live append only after the renderer has begun its gesture.
      setTimeout(() => appendMessage({ webContents: event.sender }, scrollingAppendIndex), 250);
      return [];
    }
    if (id === 'cold-open-layout-probe') {
      event.sender.send('obelisk:session-updated', { sessionId });
      return [];
    }
    ipcReads.summaries++; return [];
  });
  ipcMain.handle('db:getMessageFullText', (_event, uuid) => uuid === focusMessageUuid ? fullTextSentinel : null);
  ipcMain.handle('db:getMemories', () => { globalReads.memories++; return []; });
  ipcMain.handle('db:getProjects', () => {
    globalReads.projects++;
    return [{ project: 'quiet-zero', count: 1 }];
  });
  ipcMain.handle('db:getStats', () => { globalReads.stats++; return {}; });
  ipcMain.handle('settings:get', () => ({}));
}

function appendMessage(win, index) {
  messages.push({
    uuid: `message-${index}`,
    type: index % 2 === 0 ? 'user' : 'assistant',
    timestamp: new Date().toISOString(),
    text: `Live message ${index}`,
    content_type: 'text',
    is_meta: 0,
  });
  win.webContents.send('obelisk:session-updated', { sessionId });
}

function replaceMessageText(win, uuid, text) {
  const index = messages.findIndex(message => message.uuid === uuid);
  if (index < 0) throw new Error(`Cannot update missing message ${uuid}`);
  messages[index] = { ...messages[index], text };
  win.webContents.send('obelisk:session-updated', { sessionId });
}

function replaceToolResult(win, toolUseId, content) {
  const index = toolResults.findIndex(result => result.tool_use_id === toolUseId);
  if (index < 0) throw new Error(`Cannot update missing tool result ${toolUseId}`);
  toolResults[index] = { ...toolResults[index], content };
  win.webContents.send('obelisk:session-updated', { sessionId });
}

function replaceToolInput(win, toolUseId, input, { notify = true } = {}) {
  const index = toolCalls.findIndex(toolCall => toolCall.id === toolUseId);
  if (index < 0) throw new Error(`Cannot update missing tool call ${toolUseId}`);
  toolCalls[index] = { ...toolCalls[index], input_json: JSON.stringify(input) };
  if (notify) win.webContents.send('obelisk:session-updated', { sessionId });
}

async function run() {
  registerHandlers();
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: {
      preload: join(appRoot, 'out', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // This hidden fixture exercises foreground animation/frame behavior.
      backgroundThrottling: false,
    },
  });

  await win.loadFile(join(appRoot, 'out', 'renderer', 'index.html'), {
    hash: '/sessions',
  });
  await waitFor(
    win.webContents,
    `document.body.textContent.includes('Virtualized timeline integration')`,
    'the session list before cold open',
  );
  // This suite asserts the full-motion flap transition; do not inherit a CI
  // host's accessibility setting. Keep the emulation session through traces.
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  assert(!await win.webContents.executeJavaScript(`matchMedia('(prefers-reduced-motion: reduce)').matches`), 'the animation fixture runs with explicit full-motion preference');
  await win.webContents.executeJavaScript(`(() => {
    const probe = {
      maxOverlaps: 0,
      framesWithOverlap: 0,
      samples: 0,
      examples: [],
      stop: false,
    };
    window.__coldOpenOverlapProbe = probe;
    function sample() {
      if (probe.stop) return;
      const timeline = document.querySelector('.virtual-timeline');
      const rows = timeline && getComputedStyle(timeline).visibility !== 'hidden'
        ? [...timeline.querySelectorAll('.virtual-timeline-row')]
        .map(row => row.getBoundingClientRect())
        .filter(rect => rect.height > 0)
        : [];
      let overlaps = 0;
      for (let index = 1; index < rows.length; index++) {
        if (rows[index].top < rows[index - 1].bottom - 1) overlaps++;
      }
      probe.maxOverlaps = Math.max(probe.maxOverlaps, overlaps);
      if (overlaps > 0) {
        probe.framesWithOverlap++;
        if (probe.examples.length < 2) {
          probe.examples.push({
            overlaps,
            totalSize: document.querySelector('.virtual-timeline')?.style.height,
            rows: [...document.querySelectorAll('.virtual-timeline-row')].slice(0, 4).map(row => ({
              index: row.dataset.index,
              transform: row.style.transform,
              top: row.getBoundingClientRect().top,
              height: row.getBoundingClientRect().height,
            })),
          });
        }
      }
      probe.samples++;
      requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
    // Fire after the snapshot commits but while cold layout is still hidden.
    // A fixed timer can fire before this lazily loaded view mounts on CI.
    const coldObserver = new MutationObserver(() => {
      const timeline = document.querySelector('.virtual-timeline');
      if (!timeline || document.querySelector('.flap-number')?.getAttribute('aria-label') !== '${messageCount}') return;
      coldObserver.disconnect();
      window.__coldUpdateVisibility = getComputedStyle(timeline).visibility;
      void window.obelisk.getSessionSummaries('cold-open-layout-probe');
    });
    coldObserver.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-label'] });
    window.location.hash = ${JSON.stringify(`/sessions/${sessionId}`)};
  })()`, true);
  await waitFor(
    win.webContents,
    `document.querySelector('.flap-number')?.getAttribute('aria-label') === '${messageCount}'`,
    'the cold-start session snapshot',
  );
  // The notification and patch cross IPC and the renderer's reload queue.
  // Wait for that event with the same bounded deadline as the DOM probe.
  const coldPatchDeadline = Date.now() + 8000;
  while (ipcReads.patches === 0 && Date.now() < coldPatchDeadline) {
    await delay(40);
  }
  await waitFor(win.webContents, `(() => {
    const timeline = document.querySelector('.virtual-timeline');
    return timeline && getComputedStyle(timeline).visibility === 'visible' && !document.querySelector('.first-open-loading');
  })()`, 'cold-open layout recovery');
  const coldOpenPatchReads = ipcReads.patches;
  const coldOpenVisibility = await win.webContents.executeJavaScript(`(() => {
    const header = document.querySelector('.session-header');
    const timeline = document.querySelector('.virtual-timeline');
    return {
      total: Number(document.querySelector('.flap-number')?.getAttribute('aria-label')),
      loading: Boolean(document.querySelector('.first-open-loading')),
      headerVisibility: header ? getComputedStyle(header).visibility : null,
      timelineVisibility: timeline ? getComputedStyle(timeline).visibility : null,
      visibleRows: [...document.querySelectorAll('.virtual-timeline-row')]
        .filter(row => getComputedStyle(row).visibility !== 'hidden').length,
      patchReads: ${coldOpenPatchReads},
      notificationVisibility: window.__coldUpdateVisibility,
    };
  })()`, true);
  const coldOpenRecovered = coldOpenVisibility.total === messageCount
    && coldOpenVisibility.patchReads > 0
    && coldOpenVisibility.notificationVisibility === 'hidden'
    && !coldOpenVisibility.loading
    && coldOpenVisibility.headerVisibility === 'visible'
    && coldOpenVisibility.timelineVisibility === 'visible'
    && coldOpenVisibility.visibleRows > 0;
  assert(
    coldOpenRecovered,
    `a live update during cold-open layout cannot strand populated session content hidden (${JSON.stringify(coldOpenVisibility)})`,
  );
  if (!coldOpenRecovered) {
    win.destroy();
    return;
  }
  ipcReads.patches = 0;
  ipcReads.patchMessageRows.length = 0;
  await delay(100);
  const coldOpenOverlap = await win.webContents.executeJavaScript(`(() => {
    const probe = window.__coldOpenOverlapProbe;
    probe.stop = true;
    delete window.__coldOpenOverlapProbe;
    return probe;
  })()`, true);
  assert(
    coldOpenOverlap.maxOverlaps === 0,
    `cold-open timeline never paints intersecting message rows (${JSON.stringify(coldOpenOverlap)})`,
  );
  if (coldOpenOnly) {
    win.destroy();
    return;
  }

  const initial = await win.webContents.executeJavaScript(`(() => ({
    current: Number(document.querySelector('.msg-nav-current')?.textContent),
    total: Number(document.querySelector('.flap-number')?.getAttribute('aria-label')),
    rows: document.querySelectorAll('.virtual-timeline-row').length,
    roots: document.querySelectorAll('.msg[data-uuid], .wf-card[data-uuid], .skill-card[data-uuid]').length,
    scrollTop: document.querySelector('.detail-wrap')?.scrollTop,
    scrollHeight: document.querySelector('.detail-wrap')?.scrollHeight,
  }))()`, true);
  assert(initial.scrollTop < 2 && initial.current < 100, `cold start stays at the beginning (scrollTop ${initial.scrollTop}, item ${initial.current})`);
  assert(initial.total === messageCount, `timeline exposes all ${messageCount} items (got ${initial.total})`);
  assert(initial.rows < 60 && initial.roots === initial.rows, `only ${initial.rows} virtual rows are mounted`);

  const disclosure = await win.webContents.executeJavaScript(`(async () => {
    const toggle = document.querySelector('.toolcall-toggle');
    const row = toggle?.closest('.virtual-timeline-row');
    const before = row?.getBoundingClientRect().height || 0;
    toggle?.click();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const after = row?.getBoundingClientRect().height || 0;
    const wrap = document.querySelector('.detail-wrap');
    const requestedScrollTop = wrap.scrollHeight * 0.55;
    wrap.scrollTop = requestedScrollTop;
    await new Promise(resolve => setTimeout(resolve, 250));
    const mountedIndexes = [...document.querySelectorAll('.virtual-timeline-row')].map(element => Number(element.dataset.index));
    const unmountState = {
      requestedScrollTop, scrollTop: wrap.scrollTop, scrollHeight: wrap.scrollHeight,
      firstMounted: Math.min(...mountedIndexes), lastMounted: Math.max(...mountedIndexes),
      current: document.querySelector('.msg-nav-current')?.textContent,
      translate: document.querySelector('.virtual-timeline')?.style.translate,
    };
    const unmounted = !document.querySelector('[data-view-key="tool:call-1"]');
    document.querySelector('button[title="First"]')?.click();
    // A hidden Linux window can publish the jump before Vue remounts rows.
    // Wait for remount, then assert the state separately so a closed row fails.
    const remountDeadline = performance.now() + 8000;
    while (!document.querySelector('[data-view-key="tool:call-1"]')) {
      if (performance.now() > remountDeadline) throw new Error('First navigation did not remount the tool row');
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    return {
      before,
      after,
      unmounted, unmountState,
      restored: Boolean(document.querySelector('[data-view-key="tool:call-1"].open')),
      restoreState: { scrollTop: wrap.scrollTop, mounted: Boolean(document.querySelector('[data-view-key="tool:call-1"]')),
        current: document.querySelector('.msg-nav-current')?.textContent,
        translate: document.querySelector('.virtual-timeline')?.style.translate },
    };
  })()`, true);
  assert(disclosure.after > disclosure.before, `expanded tool row remeasures from ${disclosure.before}px to ${disclosure.after}px`);
  assert(disclosure.unmounted, `the expanded tool row unmounts outside overscan (${JSON.stringify(disclosure.unmountState)})`);
  assert(disclosure.restored, `disclosure state survives unmount and remount (${JSON.stringify(disclosure.restoreState)})`);

  const passiveScrollSettlement = await win.webContents.executeJavaScript(`new Promise(resolve => {
    const wrap = document.querySelector('.detail-wrap');
    const originalScrollTo = wrap.scrollTo.bind(wrap);
    const blockAutomaticScrollEnd = event => event.stopImmediatePropagation();
    let phase = 'scrolling';
    let postScrollEndWrites = 0;
    wrap.addEventListener('scrollend', blockAutomaticScrollEnd, true);
    wrap.scrollTo = (...args) => {
      if (phase === 'settled') postScrollEndWrites++;
      return originalScrollTo(...args);
    };
    wrap.dispatchEvent(new WheelEvent('wheel', { deltaY: 70, bubbles: true }));
    const startedAt = performance.now();
    function frame(now) {
      wrap.scrollTop += 55;
      if (now - startedAt < 600) {
        requestAnimationFrame(frame);
        return;
      }
      const beforeScrollEnd = wrap.scrollTop;
      phase = 'settled';
      wrap.removeEventListener('scrollend', blockAutomaticScrollEnd, true);
      wrap.dispatchEvent(new Event('scrollend'));
      setTimeout(() => {
        const afterScrollEnd = wrap.scrollTop;
        wrap.scrollTo = originalScrollTo;
        resolve({ beforeScrollEnd, afterScrollEnd, postScrollEndWrites });
      }, 120);
    }
    requestAnimationFrame(frame);
  })`, true);
  assert(
    passiveScrollSettlement.postScrollEndWrites === 0
      && Math.abs(passiveScrollSettlement.afterScrollEnd - passiveScrollSettlement.beforeScrollEnd) < 1,
    `ordinary scrolling settles without rollback (${JSON.stringify(passiveScrollSettlement)})`,
  );
  await win.webContents.executeJavaScript(`document.querySelector('button[title="First"]')?.click()`, true);
  await delay(350);

  const wheelBaseline = await traceWheelPaintContinuity(win);
  await win.webContents.executeJavaScript(`document.querySelector('button[title="First"]')?.click()`, true);
  await delay(350);
  const globalReadsBeforeWheelUpdate = { ...globalReads };
  stressGlobalCatalogue = true;
  const wheelPaint = await traceWheelPaintContinuity(win, { updateTool: true });
  stressGlobalCatalogue = false;
  assert(
    Math.abs(wheelPaint.after - wheelPaint.before) > 500
      && wheelPaint.wheels >= 8 && wheelPaint.screenshots >= 4,
    `wheel trace exercises compositor scrolling (${JSON.stringify(wheelPaint)})`,
  );
  assert(
    wheelPaint.blankFrames === 0,
    `fast wheel scrolling never presents a blank timeline frame (${JSON.stringify(wheelPaint)})`,
  );
  assert(
    wheelBaseline.maxVisibleOverlaps === 0,
    `ordinary wheel scrolling never overlaps visible rows (${JSON.stringify(wheelBaseline.overlapExample)})`,
  );
  assert(
    wheelPaint.maxTaskWorkMs < 50,
    `Bash tool update avoids a 50ms renderer CPU long task while scrolling (${JSON.stringify(wheelPaint)})`,
  );
  assert(
    wheelPaint.maxFrameGap < 250,
    `native wheel scrolling avoids catastrophic stalls (${wheelPaint.maxFrameGap.toFixed(1)}ms; native draw gap ${wheelPaint.maxCompositorFrameGap}ms)`,
  );
  assert(
    wheelPaint.maxFunctionWorkMs <= wheelBaseline.maxFunctionWorkMs + 2,
    `Bash patch preparation stays off the scrolling renderer task budget (baseline ${wheelBaseline.maxFunctionWorkMs.toFixed(2)}ms, update ${wheelPaint.maxFunctionWorkMs.toFixed(2)}ms)`,
  );
  assert(
    wheelPaint.updateVisibleAtWheel === null,
    `Bash tool update stays out of the timeline DOM for the complete wheel burst (became visible after wheel ${wheelPaint.updateVisibleAtWheel})`,
  );
  assert(
    JSON.stringify(globalReads) === JSON.stringify(globalReadsBeforeWheelUpdate),
    `conversation updates do not reload global catalogues while scrolling (${JSON.stringify(globalReads)})`,
  );
  await waitFor(
    win.webContents,
    `Boolean(document.querySelector('[data-view-key="tool:call-1"] .prompt-cmd')?.textContent.includes('/tmp/q_jul15b.mjs'))`,
    'post-scroll Bash tool update',
  );

  await win.webContents.executeJavaScript(`window.location.hash = '#/sessions'`, true);
  await waitFor(win.webContents, `!document.querySelector('.virtual-timeline')`, 'session detail deactivation');
  for (let attempt = 0; attempt < 100 && globalReads.sessions === globalReadsBeforeWheelUpdate.sessions; attempt++) {
    await delay(20);
  }
  const expectedGlobalReadsAfterLeaving = Object.fromEntries(
    Object.entries(globalReadsBeforeWheelUpdate).map(([key, value]) => [key, value + 1]),
  );
  assert(
    JSON.stringify(globalReads) === JSON.stringify(expectedGlobalReadsAfterLeaving),
    `leaving conversation detail flushes one coalesced global refresh (${JSON.stringify(globalReads)})`,
  );
  await win.webContents.executeJavaScript(`(async () => {
    const search = document.querySelector('#search');
    search.value = 'SENTINEL';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 300));
  })()`, true);
  await win.webContents.executeJavaScript(
    `window.location.hash = '#/sessions/${sessionId}?focus=${focusMessageUuid}'`,
    true,
  );
  await waitFor(
    win.webContents,
    `document.querySelector('[data-uuid="${focusMessageUuid}"].is-focused')`,
    'offscreen UUID focus',
  );
  const focusState = await win.webContents.executeJavaScript(`(() => {
    const target = document.querySelector('[data-uuid="${focusMessageUuid}"].is-focused');
    const wrap = document.querySelector('.detail-wrap');
    const targetRect = target.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    return {
      current: Number(document.querySelector('.msg-nav-current')?.textContent),
      visible: targetRect.bottom > wrapRect.top && targetRect.top < wrapRect.bottom,
    };
  })()`, true);
  assert(focusState.visible, `UUID navigation mounts and reveals ${focusMessageUuid} (viewport ends at item ${focusState.current})`);
  const codexDisplayState = await win.webContents.executeJavaScript(`(async () => {
    const tool = document.querySelector('[data-view-key="tool:call-codex-exec"]');
    tool?.querySelector('.toolcall-toggle')?.click();
    tool?.querySelector('.raw-toggle')?.click();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      open: tool?.classList.contains('open'),
      raw: tool?.querySelector('.raw-toggle')?.classList.contains('active'),
    };
  })()`, true);
  assert(codexDisplayState.open && codexDisplayState.raw, 'Codex exec disclosure and Raw state update without rebuilding its presentation');
  codexExecOutput = JSON.stringify([{
    type: 'input_text',
    text: 'Script completed\nWall time 0.1 seconds\nOutput:\n{"ok":true,"revision":2}',
  }]);
  replaceToolResult(win, 'call-codex-exec', codexExecOutput);
  await waitFor(
    win.webContents,
    `document.querySelector('[data-view-key="tool:call-codex-exec"] .toolcall-raw')?.textContent.includes('revision')`,
    'updated Codex exec result',
  );
  const updatedCodexDisplayState = await win.webContents.executeJavaScript(`(() => {
    const tool = document.querySelector('[data-view-key="tool:call-codex-exec"]');
    return {
      open: tool?.classList.contains('open'),
      raw: tool?.querySelector('.raw-toggle')?.classList.contains('active'),
    };
  })()`, true);
  assert(updatedCodexDisplayState.open && updatedCodexDisplayState.raw, 'Codex exec disclosure and Raw state survive a result update');

  await win.webContents.executeJavaScript(
    `document.querySelector('[data-uuid="${focusMessageUuid}"] .truncated-btn')?.click()`,
    true,
  );
  await waitFor(
    win.webContents,
    `document.querySelector('[data-uuid="${focusMessageUuid}"]')?.textContent.includes('FULL TEXT SENTINEL')`,
    'expanded full message text',
  );
  const fullTextSearchState = await win.webContents.executeJavaScript(`(() => {
    const target = document.querySelector('[data-uuid="${focusMessageUuid}"]');
    return {
      highlighted: [...target.querySelectorAll('mark')].some(mark => mark.textContent === 'SENTINEL'),
      truncatedButtonRemoved: !target.querySelector('.truncated-btn'),
    };
  })()`, true);
  assert(
    fullTextSearchState.highlighted && fullTextSearchState.truncatedButtonRemoved,
    'full-text expansion re-renders the row and preserves search highlighting',
  );
  await delay(250);

  // Stress asynchronous row measurement without changing any frame budget.
  await win.webContents.debugger.sendCommand('Emulation.setCPUThrottlingRate', { rate: 2 });
  const downwardGeometry = await probeOrdinaryScrollGeometry(win, {
    startIndex: 40,
    direction: 1,
  });
  const upwardGeometry = await probeOrdinaryScrollGeometry(win, {
    startIndex: 260,
    direction: -1,
  });
  for (const [label, geometry] of [
    ['downward', downwardGeometry],
    ['upward', upwardGeometry],
  ]) {
    assert(
      geometry.maxVisibleOverlaps === 0,
      `long rows never overlap during ordinary ${label} scrolling (${JSON.stringify(geometry.overlapExample)})`,
    );
    assert(
      geometry.programmaticScrolls === 0,
      `ordinary ${label} scrolling performs no programmatic scrollTo writes`,
    );
    assert(
      Math.abs(geometry.maxResidualMotion) < 1.5,
      `ordinary ${label} scrolling keeps visible messages fixed to scroll input (${JSON.stringify(geometry.residualExample)})`,
    );
  }
  await win.webContents.debugger.sendCommand('Emulation.setCPUThrottlingRate', { rate: 1 });
  const originalContentSize = win.getContentSize();
  win.setContentSize(1024, 656);
  await delay(250);
  for (const [label, startIndex, direction] of [
    ['downward', 40, 1],
    ['upward', 260, -1],
  ]) {
    const geometry = await probeOrdinaryScrollGeometry(win, { startIndex, direction });
    assert(
      geometry.maxVisibleOverlaps === 0,
      `small-window ${label} scrolling never overlaps long rows (${JSON.stringify(geometry.overlapExample)})`,
    );
    assert(
      geometry.programmaticScrolls === 0,
      `small-window ${label} scrolling performs no programmatic scrollTo writes`,
    );
    assert(
      Math.abs(geometry.maxResidualMotion) < 1.5,
      `small-window ${label} scrolling keeps visible messages fixed to scroll input (${JSON.stringify(geometry.residualExample)})`,
    );
  }
  win.setContentSize(...originalContentSize);
  // This scenario starts after the preceding gesture and resize have settled.
  await waitForStationaryLayout(win);
  await win.webContents.executeJavaScript(
    `window.location.hash = '#/sessions/${sessionId}?focus=${focusMessageUuid}'`,
    true,
  );
  await waitFor(
    win.webContents,
    `document.querySelector('[data-uuid="${focusMessageUuid}"].is-focused')`,
    'restored offscreen UUID focus',
  );
  await delay(250);

  await win.webContents.executeJavaScript(`(() => {
    const original = window.marked.parse;
    const originalJsonParse = JSON.parse;
    const codexExecOutput = ${JSON.stringify(codexExecOutput)};
    const trackedPrefixes = [...document.querySelectorAll('.virtual-timeline-row [data-uuid]')]
      .map(element => element.getAttribute('data-uuid'))
      .filter(uuid => /^message-\d+$/.test(uuid))
      .map(uuid => 'Message ' + uuid.slice('message-'.length) + ' ');
    let calls = 0;
    let codexExecCalls = 0;
    window.marked.parse = function timelineMarkdownProbe(...args) {
      const text = String(args[0] || '');
      if (trackedPrefixes.some(prefix => text.startsWith(prefix))) calls++;
      return original.apply(this, args);
    };
    JSON.parse = function timelineJsonProbe(value, ...args) {
      if (value === codexExecOutput) codexExecCalls++;
      return originalJsonParse.call(this, value, ...args);
    };
    window.__timelineMarkdownProbe = {
      calls: () => calls,
      codexExecCalls: () => codexExecCalls,
      restore: () => {
        window.marked.parse = original;
        JSON.parse = originalJsonParse;
      },
    };
  })()`, true);
  await waitForStationaryLayout(win);
  const restoredFocus = await win.webContents.executeJavaScript(`(() => {
    const target = document.querySelector('[data-uuid="${focusMessageUuid}"]');
    const row = target?.closest('.virtual-timeline-row');
    const wrap = document.querySelector('.detail-wrap');
    if (!row || !wrap) return { visible: false, mounted: Boolean(row) };
    const rect = row.getBoundingClientRect();
    const viewport = wrap.getBoundingClientRect();
    return {
      visible: rect.bottom > viewport.top && rect.top < viewport.bottom,
      scrollTop: wrap.scrollTop, rowTop: rect.top, rowBottom: rect.bottom,
      viewportTop: viewport.top, viewportBottom: viewport.bottom,
      translate: document.querySelector('.virtual-timeline')?.style.translate,
      current: document.querySelector('.msg-nav-current')?.textContent,
    };
  })()`, true);
  assert(restoredFocus.visible, `restored UUID navigation reveals the requested message after the preceding gesture settles (${JSON.stringify(restoredFocus)})`);
  const stationaryAnchorBefore = await win.webContents.executeJavaScript(`(() => {
    const wrap = document.querySelector('.detail-wrap');
    const wrapRect = wrap.getBoundingClientRect();
    const anchorRow = [...document.querySelectorAll('.virtual-timeline-row')]
      .find(row => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > wrapRect.top && rect.top < wrapRect.bottom;
      });
    const anchorElement = anchorRow?.querySelector('[data-uuid]');
    return anchorElement && {
      uuid: anchorElement.getAttribute('data-uuid'),
      offset: anchorRow.getBoundingClientRect().top - wrapRect.top,
    };
  })()`, true);
  const stationaryWindowBefore = await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('.virtual-timeline-row')].map(row => row.dataset.index)`, true,
  );
  await win.webContents.executeJavaScript(`(() => {
    window.__stationaryCounterSlots = [...document.querySelectorAll('.flap-number .flap-slot')];
  })()`, true);
  const stationaryTraces = [];
  for (let runIndex = 0; runIndex < stationaryAppendRuns; runIndex++) {
    stationaryTraces.push(await traceStationaryAppend(
      win,
      firstStationaryAppendIndex + runIndex,
      messageCount + runIndex + 1,
      runIndex,
    ));
    await delay(250);
  }
  const stationaryWindowAfter = await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('.virtual-timeline-row')].map(row => row.dataset.index)`, true,
  );
  assert(
    JSON.stringify(stationaryWindowBefore) === JSON.stringify(stationaryWindowAfter),
    `tail appends preserve the settled reader window (${stationaryWindowBefore.length} -> ${stationaryWindowAfter.length} mounted rows)`,
  );
  const counterSlotsRetained = await win.webContents.executeJavaScript(`(() => {
    const previous = window.__stationaryCounterSlots;
    delete window.__stationaryCounterSlots;
    const current = [...document.querySelectorAll('.flap-number .flap-slot')];
    return previous.length > 0 && current.length === previous.length
      && current.every((element, index) => element === previous[index]);
  })()`, true);
  assert(counterSlotsRetained, 'tail appends retain all counter paint containers, including changing digits');
  const liveHeaderMetadata = await win.webContents.executeJavaScript(`(() => ({
    text: document.querySelector('.session-meta-inline')?.textContent || '',
  }))()`, true);
  assert(
    liveHeaderMetadata.text.includes(`${messageCount + stationaryAppendRuns} messages`),
    `session header metadata follows incremental patches without a global refresh (${liveHeaderMetadata.text.trim()})`,
  );
  const stationaryAnchorSelector = `[data-uuid="${stationaryAnchorBefore?.uuid}"]`;
  const stationaryAnchorAfter = await win.webContents.executeJavaScript(`(() => {
    const wrap = document.querySelector('.detail-wrap');
    const target = document.querySelector(${JSON.stringify(stationaryAnchorSelector)});
    const row = target?.closest('.virtual-timeline-row');
    return target && {
      uuid: target.getAttribute('data-uuid'),
      offset: row.getBoundingClientRect().top - wrap.getBoundingClientRect().top,
    };
  })()`, true);
  const unchangedRowRenderCalls = await win.webContents.executeJavaScript(`(() => {
    const calls = {
      markdown: window.__timelineMarkdownProbe.calls(),
      codexExec: window.__timelineMarkdownProbe.codexExecCalls(),
    };
    window.__timelineMarkdownProbe.restore();
    delete window.__timelineMarkdownProbe;
    return calls;
  })()`, true);
  assert(unchangedRowRenderCalls.markdown === 0, `three tail appends perform zero Markdown formatting calls for unchanged mounted rows (got ${unchangedRowRenderCalls.markdown})`);
  assert(unchangedRowRenderCalls.codexExec === 0, `three tail appends perform zero Codex exec JSON decodes for an unchanged mounted row (got ${unchangedRowRenderCalls.codexExec})`);
  assert(
    stationaryAnchorBefore?.uuid === stationaryAnchorAfter?.uuid
      && Math.abs(stationaryAnchorBefore.offset - stationaryAnchorAfter.offset) < 2,
    `stationary live commits preserve reader anchor ${stationaryAnchorBefore?.uuid}`,
  );
  for (const [runIndex, trace] of stationaryTraces.entries()) {
    if (trace.maxTaskMs >= 8.33) console.log(`SLOWEST RENDERER TASK ${runIndex + 1}: ${JSON.stringify(trace.slowestChildren)}`);
    assert(trace.maxTaskWorkMs < 8.33, `stationary live commit ${runIndex + 1} stays inside a 120Hz renderer work budget (${trace.maxTaskWorkMs.toFixed(2)}ms work, ${trace.maxTaskMs.toFixed(2)}ms wall across ${trace.tasks} tasks)`);
  }

  await win.webContents.executeJavaScript(`(() => {
    const probe = { minRows: Infinity, zeroFrames: 0, samples: 0, stop: false };
    window.__liveTimelineRowProbe = probe;
    function sample() {
      if (probe.stop) return;
      const rows = document.querySelectorAll('.virtual-timeline-row').length;
      probe.minRows = Math.min(probe.minRows, rows);
      if (rows === 0) probe.zeroFrames++;
      probe.samples++;
      requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  })()`, true);
  // Slow only the gesture/settlement path: stale navigation and deferred row
  // measurement must preserve the reader even when renderer callbacks lag.
  // Stationary commit performance is still measured at normal CPU speed.
  await win.webContents.debugger.sendCommand('Emulation.setCPUThrottlingRate', { rate: 12 });
  currentSessionTitle = 'Live metadata title';
  const scrollProbe = await win.webContents.executeJavaScript(`new Promise(resolve => {
    const wrap = document.querySelector('.detail-wrap');
    const totalBeforeGesture = Number(document.querySelector('.flap-number')?.getAttribute('aria-label'));
    const originalScrollTo = wrap.scrollTo.bind(wrap);
    let programmaticScrolls = 0;
    let postScrollEndWrites = 0;
    let phase = 'scrolling';
    // Capture the short animation inside the renderer instead of racing it
    // with a later IPC poll on a loaded CI host.
    window.__postScrollFlapObserved = false;
    const flapObserver = new MutationObserver(() => {
      if (phase === 'settled' && document.querySelector('.flap-slot.flipping')) {
        window.__postScrollFlapObserved = true;
        flapObserver.disconnect();
      }
    });
    flapObserver.observe(document.querySelector('.flap-number'), { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    const blockAutomaticScrollEnd = event => event.stopImmediatePropagation();
    wrap.addEventListener('scrollend', blockAutomaticScrollEnd, true);
    wrap.scrollTo = (...args) => {
      if (phase === 'scrolling') programmaticScrolls++;
      else postScrollEndWrites++;
      return originalScrollTo(...args);
    };
    const gaps = [];
    const startedAt = performance.now();
    let previous = startedAt;
    let previousGeometry = null;
    let maxResidualMotion = 0;
    let residualExample = null;
    wrap.dispatchEvent(new WheelEvent('wheel', { deltaY: -70, bubbles: true }));
    void window.obelisk.getSessionSummaries('scroll-gesture-probe');
    function sampleGeometry(now) {
      const wrapRect = wrap.getBoundingClientRect();
      const scrollTop = wrap.scrollTop;
      const rows = new Map([...document.querySelectorAll('.virtual-timeline-row')]
        .map(row => {
          const rect = row.getBoundingClientRect();
          const uuid = row.querySelector('[data-uuid]')?.getAttribute('data-uuid');
          return uuid && rect.bottom > wrapRect.top && rect.top < wrapRect.bottom
            ? [uuid, rect.top - wrapRect.top]
            : null;
        })
        .filter(Boolean));
      if (previousGeometry) {
        for (const [uuid, top] of rows) {
          if (!previousGeometry.rows.has(uuid)) continue;
          const screenDelta = top - previousGeometry.rows.get(uuid);
          const scrollDelta = scrollTop - previousGeometry.scrollTop;
          const residual = screenDelta + scrollDelta;
          if (Math.abs(residual) > Math.abs(maxResidualMotion)) {
            maxResidualMotion = residual;
            residualExample = { now: now - startedAt, uuid, screenDelta, scrollDelta, residual };
          }
        }
      }
      previousGeometry = { rows, scrollTop };
    }
    function frame(now) {
      gaps.push(now - previous);
      previous = now;
      // Model a continuing physical gesture with wheel packets, rather than
      // relying on a single packet's 450ms watchdog surviving CI frame gaps.
      if (now - startedAt < 1200) wrap.dispatchEvent(new WheelEvent('wheel', { deltaY: -70, bubbles: true }));
      if (now - startedAt >= 400) wrap.scrollTop -= 70;
      sampleGeometry(now);
      if (now - startedAt < 1200) requestAnimationFrame(frame);
      else {
        const wrapRect = wrap.getBoundingClientRect();
        const anchorRow = [...document.querySelectorAll('.virtual-timeline-row')]
          .find(row => {
            const rect = row.getBoundingClientRect();
            return rect.bottom > wrapRect.top && rect.top < wrapRect.bottom;
        });
        const anchorElement = anchorRow?.querySelector('[data-uuid]');
        const totalBeforeScrollEnd = Number(document.querySelector('.flap-number')?.getAttribute('aria-label'));
        const flapBeforeScrollEnd = Boolean(document.querySelector('.flap-slot.flipping'));
        phase = 'settled';
        window.__scrollGeometryWriteProbe = {
          read: () => postScrollEndWrites,
          restore: () => { wrap.scrollTo = originalScrollTo; },
        };
        wrap.removeEventListener('scrollend', blockAutomaticScrollEnd, true);
        wrap.dispatchEvent(new Event('scrollend'));
        resolve({
          totalBeforeGesture,
          totalBeforeScrollEnd,
          flapBeforeScrollEnd,
          programmaticScrolls,
          maxResidualMotion,
          residualExample,
          maxFrameGap: Math.max(...gaps),
          frames: gaps.length,
          rows: document.querySelectorAll('.virtual-timeline-row').length,
          distanceFromTail: wrap.scrollHeight - wrap.clientHeight - wrap.scrollTop,
          anchor: anchorElement && {
            uuid: anchorElement.getAttribute('data-uuid'),
            offset: anchorRow.getBoundingClientRect().top - wrapRect.top,
          },
        });
      }
    }
    requestAnimationFrame(frame);
  })`, true);
  assert(scrollProbe.totalBeforeGesture === messageCount + stationaryAppendRuns, 'the live append starts after the renderer gesture begins');
  console.log(`SCROLL GESTURE: ${JSON.stringify(scrollProbe)}`);
  await waitFor(
    win.webContents,
    `document.querySelector('.flap-number')?.getAttribute('aria-label') === '${messageCount + stationaryAppendRuns + 1}'`,
    'reader-position live update',
  );
  await waitFor(
    win.webContents,
    `window.__postScrollFlapObserved === true`,
    'post-scrollend flap animation',
  );
  await waitFor(
    win.webContents,
    `document.title.includes('Live metadata title') && document.querySelector('.breadcrumb')?.textContent.includes('Live metadata title')`,
    'shared route metadata update',
  );
  const postScrollEndWrites = await win.webContents.executeJavaScript(`(() => {
    const probe = window.__scrollGeometryWriteProbe;
    const writes = probe?.read() ?? -1;
    probe?.restore();
    delete window.__scrollGeometryWriteProbe;
    return writes;
  })()`, true);
  const sharedMetadataState = await win.webContents.executeJavaScript(`(() => ({
    windowTitle: document.title.includes('Live metadata title'),
    breadcrumb: document.querySelector('.breadcrumb')?.textContent.includes('Live metadata title'),
  }))()`, true);
  assert(
    sharedMetadataState.windowTitle && sharedMetadataState.breadcrumb,
    'session title patch updates the breadcrumb and window title without a catalogue reload',
  );
  const liveTimelineContinuity = await win.webContents.executeJavaScript(`(() => {
    const probe = window.__liveTimelineRowProbe;
    probe.stop = true;
    delete window.__liveTimelineRowProbe;
    return { minRows: probe.minRows, zeroFrames: probe.zeroFrames, samples: probe.samples };
  })()`, true);
  const readerState = await win.webContents.executeJavaScript(`(() => {
    const wrap = document.querySelector('.detail-wrap');
    const anchorElement = document.querySelector(
      ${JSON.stringify(`[data-uuid="${scrollProbe.anchor?.uuid}"]`)},
    );
    const anchorRow = anchorElement?.closest('.virtual-timeline-row');
    return {
      current: Number(document.querySelector('.msg-nav-current')?.textContent),
      anchor: anchorElement && {
        uuid: anchorElement.getAttribute('data-uuid'),
        offset: anchorRow.getBoundingClientRect().top - wrap.getBoundingClientRect().top,
      },
    };
  })()`, true);
  assert(scrollProbe.rows < 80, `live scrolling keeps mounted rows bounded (${scrollProbe.rows})`);
  assert(
    liveTimelineContinuity.minRows > 0 && liveTimelineContinuity.zeroFrames === 0,
    `live update never clears the mounted timeline (${JSON.stringify(liveTimelineContinuity)})`,
  );
  assert(
    scrollProbe.totalBeforeScrollEnd === scrollProbe.totalBeforeGesture,
    `wheel-to-scrollend freezes the visible timeline (${scrollProbe.totalBeforeGesture} -> ${scrollProbe.totalBeforeScrollEnd})`,
  );
  assert(
    scrollProbe.programmaticScrolls === 0,
    `wheel-to-scrollend performs zero programmatic scrollTo calls (got ${scrollProbe.programmaticScrolls})`,
  );
  assert(
    Math.abs(scrollProbe.maxResidualMotion) < 1.5,
    `wheel-to-scrollend keeps visible messages fixed to scroll input (${JSON.stringify(scrollProbe.residualExample)})`,
  );
  assert(
    postScrollEndWrites <= 1,
    `scrollend batches deferred measurements into at most one anchor sync (got ${postScrollEndWrites})`,
  );
  assert(!scrollProbe.flapBeforeScrollEnd, 'wheel-to-scrollend does not start the flap animation');
  assert(scrollProbe.anchor, 'reader anchor is captured before the deferred live commit');
  assert(
    scrollProbe.distanceFromTail > 1000
      && readerState.current < messageCount + stationaryAppendRuns + 1
      && readerState.anchor?.uuid === scrollProbe.anchor?.uuid
      && Math.abs(readerState.anchor.offset - scrollProbe.anchor.offset) < 2,
    `live append preserves reader anchor ${scrollProbe.anchor?.uuid} (${scrollProbe.anchor?.offset}px -> ${readerState.anchor?.offset}px)`,
  );
  assert(scrollProbe.maxFrameGap < 250, `live scroll has no catastrophic long frame (${scrollProbe.maxFrameGap.toFixed(1)}ms)`);

  await win.webContents.debugger.sendCommand('Emulation.setCPUThrottlingRate', { rate: 1 });

  await waitFor(win.webContents, `!document.querySelector('.flap-slot.flipping')`, 'tail append flap settlement');
  const updatedReaderText = `Updated ${scrollProbe.anchor.uuid} ${'content identity '.repeat(20)}`;
  await win.webContents.executeJavaScript(`(() => {
    const original = window.marked.parse;
    const targetUuid = ${JSON.stringify(scrollProbe.anchor.uuid)};
    const targetText = ${JSON.stringify(updatedReaderText)};
    const unchangedPrefixes = [...document.querySelectorAll('.virtual-timeline-row [data-uuid]')]
      .map(element => element.getAttribute('data-uuid'))
      .filter(uuid => uuid !== targetUuid && /^message-\d+$/.test(uuid))
      .map(uuid => 'Message ' + uuid.slice('message-'.length) + ' ');
    let targetCalls = 0;
    let unchangedCalls = 0;
    window.marked.parse = function timelineContentIdentityProbe(value, ...args) {
      const text = String(value || '');
      if (text === targetText) targetCalls++;
      if (unchangedPrefixes.some(prefix => text.startsWith(prefix))) unchangedCalls++;
      return original.call(this, value, ...args);
    };
    window.__timelineContentIdentityProbe = {
      calls: () => ({ target: targetCalls, unchanged: unchangedCalls }),
      restore: () => { window.marked.parse = original; },
    };
  })()`, true);
  scrollingContentUuid = scrollProbe.anchor.uuid;
  scrollingContentText = updatedReaderText;
  const existingUpdateProbe = await win.webContents.executeJavaScript(`new Promise(resolve => {
    const wrap = document.querySelector('.detail-wrap');
    const targetUuid = ${JSON.stringify(scrollProbe.anchor.uuid)};
    const targetText = ${JSON.stringify(updatedReaderText.slice(0, 40))};
    const originalScrollTo = wrap.scrollTo.bind(wrap);
    const blockAutomaticScrollEnd = event => event.stopImmediatePropagation();
    let programmaticScrolls = 0;
    let previousGeometry = null;
    let maxResidualMotion = 0;
    let residualExample = null;
    let steps = 0;
    wrap.addEventListener('scrollend', blockAutomaticScrollEnd, true);
    wrap.scrollTo = (...args) => {
      programmaticScrolls++;
      return originalScrollTo(...args);
    };
    wrap.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true }));
    void window.obelisk.getSessionSummaries('content-gesture-probe');
    const startedAt = performance.now();
    function frame(now) {
      if (now - startedAt < 700) wrap.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true }));
      if (now - startedAt >= 250 && steps < 3) {
        wrap.scrollTop -= 40;
        steps++;
      }
      const wrapRect = wrap.getBoundingClientRect();
      const scrollTop = wrap.scrollTop;
      const rows = new Map([...document.querySelectorAll('.virtual-timeline-row')]
        .map(row => {
          const rect = row.getBoundingClientRect();
          const uuid = row.querySelector('[data-uuid]')?.getAttribute('data-uuid');
          return uuid && rect.bottom > wrapRect.top && rect.top < wrapRect.bottom
            ? [uuid, rect.top - wrapRect.top]
            : null;
        })
        .filter(Boolean));
      if (previousGeometry) {
        for (const [uuid, top] of rows) {
          if (!previousGeometry.rows.has(uuid)) continue;
          const screenDelta = top - previousGeometry.rows.get(uuid);
          const scrollDelta = scrollTop - previousGeometry.scrollTop;
          const residual = screenDelta + scrollDelta;
          if (Math.abs(residual) > Math.abs(maxResidualMotion)) {
            maxResidualMotion = residual;
            residualExample = { uuid, screenDelta, scrollDelta, residual };
          }
        }
      }
      previousGeometry = { rows, scrollTop };
      if (now - startedAt < 700) {
        requestAnimationFrame(frame);
        return;
      }
      const anchorRow = [...document.querySelectorAll('.virtual-timeline-row')]
        .find(row => {
          const rect = row.getBoundingClientRect();
          return rect.bottom > wrapRect.top && rect.top < wrapRect.bottom;
        });
      const anchorElement = anchorRow?.querySelector('[data-uuid]');
      const targetVisibleBeforeScrollEnd = Boolean(
        document.querySelector('[data-uuid="' + targetUuid + '"]')?.textContent.includes(targetText),
      );
      wrap.scrollTo = originalScrollTo;
      wrap.removeEventListener('scrollend', blockAutomaticScrollEnd, true);
      wrap.dispatchEvent(new Event('scrollend'));
      resolve({
        targetVisibleBeforeScrollEnd,
        programmaticScrolls,
        maxResidualMotion,
        residualExample,
        anchor: anchorElement && {
          uuid: anchorElement.getAttribute('data-uuid'),
          offset: anchorRow.getBoundingClientRect().top - wrapRect.top,
        },
      });
    }
    requestAnimationFrame(frame);
  })`, true);
  await waitFor(
    win.webContents,
    `document.querySelector('[data-uuid=${JSON.stringify(scrollProbe.anchor.uuid)}]')?.textContent.includes(${JSON.stringify(updatedReaderText.slice(0, 40))})`,
    'visible message content update',
  );
  await waitForStationaryLayout(win);
  const updatedReaderState = await win.webContents.executeJavaScript(`(() => {
    const wrap = document.querySelector('.detail-wrap');
    const anchorElement = document.querySelector(
      ${JSON.stringify(`[data-uuid="${existingUpdateProbe.anchor?.uuid}"]`)},
    );
    const anchorRow = anchorElement?.closest('.virtual-timeline-row');
    const calls = window.__timelineContentIdentityProbe.calls();
    window.__timelineContentIdentityProbe.restore();
    delete window.__timelineContentIdentityProbe;
    return {
      calls,
      anchor: anchorElement && {
        uuid: anchorElement.getAttribute('data-uuid'),
        offset: anchorRow.getBoundingClientRect().top - wrap.getBoundingClientRect().top,
      },
    };
  })()`, true);
  assert(!existingUpdateProbe.targetVisibleBeforeScrollEnd, 'existing message update stays out of the timeline until scrollend');
  assert(existingUpdateProbe.programmaticScrolls === 0, 'existing message update performs no programmatic scroll during the gesture');
  assert(
    Math.abs(existingUpdateProbe.maxResidualMotion) < 1.5,
    `existing message update keeps visible messages fixed to scroll input (${JSON.stringify(existingUpdateProbe.residualExample)})`,
  );
  assert(
    existingUpdateProbe.anchor?.uuid === updatedReaderState.anchor?.uuid
      && Math.abs(existingUpdateProbe.anchor.offset - updatedReaderState.anchor.offset) < 2,
    `existing message update preserves reader anchor ${existingUpdateProbe.anchor?.uuid} (${existingUpdateProbe.anchor?.offset}px -> ${updatedReaderState.anchor?.offset}px)`,
  );
  assert(updatedReaderState.calls.target === 1, `updated mounted row recomputes its Markdown once (got ${updatedReaderState.calls.target})`);
  assert(updatedReaderState.calls.unchanged === 0, `updated mounted row leaves other mounted Markdown cached (got ${updatedReaderState.calls.unchanged})`);
  assert(
    ipcReads.messages === 1
      && ipcReads.toolCalls === 1
      && ipcReads.toolResults === 1
      && ipcReads.subagents === 1
      && ipcReads.workflows === 1
      && ipcReads.summaries === 1
      && ipcReads.patches === 7
      && ipcReads.patchMessageRows.every(count => count === 1),
    `live updates use seven single-message patches after one full snapshot (${JSON.stringify(ipcReads)})`,
  );

  await win.webContents.executeJavaScript(`document.querySelector('button[title="Last"]')?.click()`, true);
  await waitFor(
    win.webContents,
    `document.querySelector('.msg-nav-current')?.textContent === '${messageCount + stationaryAppendRuns + 1}'`,
    'last-item navigation',
  );
  await waitFor(
    win.webContents,
    `(() => { const wrap = document.querySelector('.detail-wrap'); return wrap.scrollHeight - wrap.clientHeight - wrap.scrollTop < 2; })()`,
    'last-item scroll settlement',
  );

  await win.webContents.executeJavaScript(`new Promise(resolve => {
    const wrap = document.querySelector('.detail-wrap');
    wrap.scrollTop = Math.max(0, wrap.scrollHeight - wrap.clientHeight - 20);
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  })`, true);
  await delay(200);
  await win.webContents.executeJavaScript(`(() => {
    const wrap = document.querySelector('.detail-wrap');
    wrap.dispatchEvent(new WheelEvent('wheel', { deltaY: -24, bubbles: true }));
  })()`, true);
  await delay(200);
  appendMessage(win, nearTailEscapeAppendIndex);
  await delay(150);
  const nearTailPending = await win.webContents.executeJavaScript(`(() => {
    const wrap = document.querySelector('.detail-wrap');
    return {
      total: Number(document.querySelector('.flap-number')?.getAttribute('aria-label')),
      distanceFromTail: wrap.scrollHeight - wrap.clientHeight - wrap.scrollTop,
    };
  })()`, true);
  assert(
    nearTailPending.total === messageCount + stationaryAppendRuns + 1,
    'near-tail upward intent keeps the append pending until scrollend',
  );
  await win.webContents.executeJavaScript(
    `document.querySelector('.detail-wrap')?.dispatchEvent(new Event('scrollend'))`,
    true,
  );
  await waitFor(
    win.webContents,
    `document.querySelector('.flap-number')?.getAttribute('aria-label') === '${messageCount + stationaryAppendRuns + 2}'`,
    'near-tail upward append settlement',
  );
  await delay(500);
  const nearTailSettled = await win.webContents.executeJavaScript(`(() => {
    const wrap = document.querySelector('.detail-wrap');
    return {
      current: Number(document.querySelector('.msg-nav-current')?.textContent),
      total: Number(document.querySelector('.flap-number')?.getAttribute('aria-label')),
      distanceFromTail: wrap.scrollHeight - wrap.clientHeight - wrap.scrollTop,
    };
  })()`, true);
  assert(
    nearTailSettled.current < nearTailSettled.total && nearTailSettled.distanceFromTail > 20,
    `near-tail upward intent is not pulled back to the tail (${JSON.stringify(nearTailSettled)})`,
  );

  await win.webContents.executeJavaScript(`document.querySelector('button[title="Last"]')?.click()`, true);
  await waitFor(
    win.webContents,
    `document.querySelector('.msg-nav-current')?.textContent === '${messageCount + stationaryAppendRuns + 2}'`,
    'last-item navigation after upward escape',
  );
  await waitFor(
    win.webContents,
    `(() => { const wrap = document.querySelector('.detail-wrap'); return wrap.scrollHeight - wrap.clientHeight - wrap.scrollTop < 2; })()`,
    'tail re-entry settlement',
  );
  // Enter the idle tail-follow scenario after navigation measurements and the
  // preceding gesture have settled, rather than racing their final commit.
  await waitForStationaryLayout(win);
  appendMessage(win, tailAppendIndex);
  await waitFor(
    win.webContents,
    `document.querySelector('.flap-number')?.getAttribute('aria-label') === '${messageCount + stationaryAppendRuns + 3}'`,
    'tail-follow total update',
  );
  await delay(1000);
  const tailState = await win.webContents.executeJavaScript(`(() => {
    const wrap = document.querySelector('.detail-wrap');
    return {
      current: Number(document.querySelector('.msg-nav-current')?.textContent),
      total: Number(document.querySelector('.flap-number')?.getAttribute('aria-label')),
      scrollTop: wrap.scrollTop,
      maxScrollTop: wrap.scrollHeight - wrap.clientHeight,
      distanceFromTail: wrap.scrollHeight - wrap.clientHeight - wrap.scrollTop,
    };
  })()`, true);
  assert(
    tailState.current === messageCount + stationaryAppendRuns + 3 && tailState.distanceFromTail < 2,
    `tail follow reaches item ${messageCount + stationaryAppendRuns + 3} (${JSON.stringify(tailState)})`,
  );

  const reduction = (1 - initial.rows / initial.total) * 100;
  console.log(`PERF: ${initial.total} timeline items -> ${initial.rows} mounted rows (${reduction.toFixed(2)}% fewer roots)`);
  console.log(`PERF: ${scrollProbe.frames} frames, max frame gap ${scrollProbe.maxFrameGap.toFixed(1)}ms during live scroll`);
  win.destroy();
}

app.whenReady()
  .then(run)
  .catch(error => {
    failures++;
    console.error(error.stack || error);
  })
  .finally(() => {
    for (const channel of channels) ipcMain.removeHandler(channel);
    app.exit(failures ? 1 : 0);
  });
