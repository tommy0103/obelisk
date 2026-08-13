import { app, BrowserWindow, ipcMain } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createSessionPatch } from '../src/shared/session-patch.mjs';
import { assembleSessionDetail } from '../src/shared/session-detail-assembly.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const sessionA = 'reader-session-a';
const sessionB = 'reader-session-b';
const focusUuid = 'a-message-180';
const expandedTextSentinel = 'RESTORED FULL TEXT SENTINEL';
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
let nextFullTextDelayMs = 0;

function makeMessages(prefix, count) {
  return Array.from({ length: count }, (_, index) => ({
    uuid: `${prefix}-message-${index}`,
    type: index % 2 === 0 ? 'user' : 'assistant',
    timestamp: new Date(Date.UTC(2026, 6, 16, 0, 0, index)).toISOString(),
    text: `Session ${prefix.toUpperCase()} message ${index} ${'dynamic reader content '.repeat((index % 5) + 1)}`,
    content_type: 'text',
    is_meta: 0,
  }));
}

const fixtures = {
  [sessionA]: {
    title: 'Reader state A',
    messages: makeMessages('a', 240),
    toolCalls: [{
      id: 'a-tool-call',
      message_uuid: 'a-message-1',
      name: 'Bash',
      input_json: JSON.stringify({ command: 'printf reader-state-a' }),
    }],
    toolResults: [{
      tool_use_id: 'a-tool-call',
      content: 'reader state output',
      is_error: 0,
    }],
  },
  [sessionB]: {
    title: 'Reader state B',
    messages: makeMessages('b', 160),
    toolCalls: [],
    toolResults: [],
  },
};
fixtures[sessionA].messages[2].text = `Truncated preview ${'indexed content '.repeat(700)}`;
fixtures[sessionA].messages[3].type = 'assistant';
fixtures[sessionA].messages[3].content_type = 'thinking';
fixtures[sessionA].messages[3].text = 'Standalone reasoning block';

function summary(sessionId) {
  const fixture = fixtures[sessionId];
  return {
    id: sessionId,
    title: fixture.title,
    project: 'quiet-zero',
    project_path: '/tmp/quiet-zero',
    source: 'claude',
    started_at: '2026-07-16T00:00:00.000Z',
    ended_at: '2026-07-16T01:00:00.000Z',
    message_count: fixture.messages.length,
    git_branch: 'main',
  };
}

function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else {
    failures++;
    console.error(`FAIL: ${message}`);
  }
}

async function waitFor(webContents, expression, message, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await webContents.executeJavaScript(`Boolean(${expression})`, true)) return;
    await delay(40);
  }
  throw new Error(`Timed out waiting for ${message}`);
}

function registerHandlers() {
  ipcMain.handle('db:getSessions', () => [summary(sessionA), summary(sessionB)]);
  ipcMain.handle('db:getSessionMessages', (_event, sessionId) => fixtures[sessionId]?.messages || []);
  ipcMain.handle('db:getSessionToolCalls', (_event, sessionId) => fixtures[sessionId]?.toolCalls || []);
  ipcMain.handle('db:getSessionToolResults', (_event, sessionId) => fixtures[sessionId]?.toolResults || []);
  ipcMain.handle('db:getSessionPatch', (_event, sessionId, cursor) => {
    const fixture = fixtures[sessionId];
    const patch = createSessionPatch({
      messages: assembleSessionDetail({
        messages: fixture.messages,
        toolCalls: fixture.toolCalls,
        toolResults: fixture.toolResults,
        subagents: [],
        workflows: [],
      }).messages,
      workflows: [],
    }, cursor);
    return { ...patch, session: summary(sessionId) };
  });
  ipcMain.handle('db:getSessionSubagents', () => []);
  ipcMain.handle('db:getSessionWorkflows', () => []);
  ipcMain.handle('db:getSessionSummaries', () => []);
  ipcMain.handle('db:getMessageFullText', async (_event, messageUuid) => {
    const delayMs = nextFullTextDelayMs;
    nextFullTextDelayMs = 0;
    if (delayMs > 0) await delay(delayMs);
    return messageUuid === 'a-message-2' ? `${expandedTextSentinel} complete message` : null;
  });
  ipcMain.handle('db:getMemories', () => []);
  ipcMain.handle('db:getProjects', () => [{ project: 'quiet-zero', count: 2 }]);
  ipcMain.handle('db:getStats', () => ({}));
  ipcMain.handle('settings:get', () => ({}));
}

async function navigate(win, sessionId, query = '') {
  await win.webContents.executeJavaScript(
    `window.location.hash = ${JSON.stringify(`#/sessions/${sessionId}${query}`)}`,
    true,
  );
  await waitFor(
    win.webContents,
    `document.querySelector('.flap-number')?.getAttribute('aria-label') === '${fixtures[sessionId].messages.length}'`,
    `${sessionId} timeline`,
  );
  await delay(650);
}

async function scrollState(win, fraction = null) {
  return win.webContents.executeJavaScript(`(async () => {
    const wrap = document.querySelector('.detail-wrap');
    ${fraction === null ? '' : `wrap.scrollTop = (wrap.scrollHeight - wrap.clientHeight) * ${fraction};`}
    await new Promise(resolve => setTimeout(resolve, 500));
    const wrapRect = wrap.getBoundingClientRect();
    const anchorRow = [...document.querySelectorAll('.virtual-timeline-row')]
      .find(row => row.getBoundingClientRect().bottom > wrapRect.top);
    const anchorRect = anchorRow?.getBoundingClientRect();
    return {
      current: Number(document.querySelector('.msg-nav-current')?.textContent),
      total: Number(document.querySelector('.flap-number')?.getAttribute('aria-label')),
      scrollTop: wrap.scrollTop,
      anchorUuid: anchorRow?.querySelector('[data-message-uuid]')?.dataset.messageUuid || null,
      anchorOffset: anchorRect ? anchorRect.top - wrapRect.top : null,
    };
  })()`, true);
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
    },
  });

  await win.loadFile(join(appRoot, 'out', 'renderer', 'index.html'), { hash: '/sessions' });
  await waitFor(win.webContents, `document.body.textContent.includes('Reader state A')`, 'session list');
  await win.webContents.executeJavaScript(
    `localStorage.removeItem('obelisk:session-content-visibility')`,
    true,
  );

  await navigate(win, sessionA);
  await win.webContents.executeJavaScript(
    `document.querySelector('[data-view-key="tool:a-tool-call"] .toolcall-toggle')?.click()`,
    true,
  );
  await win.webContents.executeJavaScript(
    `document.querySelector('[data-uuid="a-message-2"] .truncated-btn')?.click()`,
    true,
  );
  await waitFor(
    win.webContents,
    `document.querySelector('[data-uuid="a-message-2"]')?.textContent.includes('${expandedTextSentinel}')`,
    'expanded full message text in session A',
  );
  const aPosition = await scrollState(win, 0.46);
  assert(aPosition.current > 60, `session A reaches a mid-session reader position (${JSON.stringify(aPosition)})`);

  await navigate(win, sessionB);
  const bInitial = await scrollState(win);
  assert(bInitial.current < 10, `session B starts with its own progress (${JSON.stringify(bInitial)})`);
  const bPosition = await scrollState(win, 0.68);
  assert(bPosition.current > 60, `session B records an independent reader position (${JSON.stringify(bPosition)})`);

  fixtures[sessionA].messages.push({
    uuid: 'a-message-live',
    type: 'assistant',
    timestamp: new Date().toISOString(),
    text: 'Hidden-session live update',
    content_type: 'text',
    is_meta: 0,
  });
  win.webContents.send('obelisk:session-updated', { sessionId: sessionA });

  await navigate(win, sessionA);
  const restoredA = await scrollState(win);
  assert(
    restoredA.anchorUuid === aPosition.anchorUuid
      && Math.abs(restoredA.anchorOffset - aPosition.anchorOffset) <= 2
      && Math.abs(restoredA.current - aPosition.current) <= 3,
    `session A restores its semantic reader anchor after a hidden live update (${JSON.stringify({ aPosition, restoredA })})`,
  );

  await win.webContents.executeJavaScript(`document.querySelector('button[title="First"]')?.click()`, true);
  await delay(450);
  const disclosureRestored = await win.webContents.executeJavaScript(
    `Boolean(document.querySelector('[data-view-key="tool:a-tool-call"].open'))`,
    true,
  );
  assert(disclosureRestored, 'session A restores its expanded tool disclosure');
  const expandedTextRestored = await win.webContents.executeJavaScript(
    `Boolean(document.querySelector('[data-uuid="a-message-2"]')?.textContent.includes('${expandedTextSentinel}'))`,
    true,
  );
  assert(expandedTextRestored, 'session A restores expanded full-message state without caching its text');

  await navigate(win, sessionB);
  const restoredB = await scrollState(win);
  assert(
    restoredB.anchorUuid === bPosition.anchorUuid
      && Math.abs(restoredB.anchorOffset - bPosition.anchorOffset) <= 2
      && Math.abs(restoredB.current - bPosition.current) <= 3,
    `session B restores its own semantic reader anchor (${JSON.stringify({ bPosition, restoredB })})`,
  );

  await win.webContents.executeJavaScript(`document.querySelector('button[title="Last"]')?.click()`, true);
  await waitFor(
    win.webContents,
    `document.querySelector('.msg-nav-current')?.textContent === '${fixtures[sessionB].messages.length}'`,
    'session B tail position',
  );
  await navigate(win, sessionA);
  fixtures[sessionB].messages.push({
    uuid: 'b-message-live',
    type: 'assistant',
    timestamp: new Date().toISOString(),
    text: 'Hidden tail update',
    content_type: 'text',
    is_meta: 0,
  });
  win.webContents.send('obelisk:session-updated', { sessionId: sessionB });
  await navigate(win, sessionB);
  const restoredTail = await win.webContents.executeJavaScript(`(() => {
    const wrap = document.querySelector('.detail-wrap');
    return {
      current: Number(document.querySelector('.msg-nav-current')?.textContent),
      total: Number(document.querySelector('.flap-number')?.getAttribute('aria-label')),
      distanceFromTail: wrap.scrollHeight - wrap.clientHeight - wrap.scrollTop,
    };
  })()`, true);
  assert(
    restoredTail.current === restoredTail.total && restoredTail.distanceFromTail < 2,
    `session B tail mode follows a hidden-session append (${JSON.stringify(restoredTail)})`,
  );

  await navigate(win, sessionA, `?focus=${focusUuid}`);
  await waitFor(
    win.webContents,
    `document.querySelector('[data-uuid="${focusUuid}"].is-focused')`,
    'explicit focus target',
  );
  const focused = await scrollState(win);
  assert(focused.current > 150, `explicit UUID focus overrides cached reader state (${JSON.stringify(focused)})`);

  await win.webContents.executeJavaScript(
    `window.location.hash = '#/sessions/${sessionA}?focus=a-message-20'`,
    true,
  );
  await waitFor(
    win.webContents,
    `document.querySelector('[data-uuid="a-message-20"].is-focused')`,
    'same-session focus target',
  );
  const sameSessionFocus = await scrollState(win);
  assert(
    sameSessionFocus.current < 50,
    `same-session query focus is observed without a remount (${JSON.stringify(sameSessionFocus)})`,
  );

  await navigate(win, sessionB);
  nextFullTextDelayMs = 400;
  await win.webContents.executeJavaScript(
    `window.location.hash = '#/sessions/${sessionA}'`,
    true,
  );
  await waitFor(
    win.webContents,
    `document.querySelector('.flap-number')?.getAttribute('aria-label') === '${fixtures[sessionA].messages.length}'`,
    'session A preparing a cached restore',
  );
  await win.webContents.executeJavaScript(
    `window.location.hash = '#/sessions/${sessionB}'`,
    true,
  );
  await waitFor(
    win.webContents,
    `document.querySelector('.flap-number')?.getAttribute('aria-label') === '${fixtures[sessionB].messages.length}'`,
    'session B after interrupting restore',
  );
  await delay(450);
  await navigate(win, sessionA);
  const afterInterruptedRestore = await scrollState(win);
  assert(
    afterInterruptedRestore.anchorUuid === sameSessionFocus.anchorUuid
      && Math.abs(afterInterruptedRestore.anchorOffset - sameSessionFocus.anchorOffset) <= 2,
    `leaving during restore does not overwrite the cached reader anchor (${JSON.stringify({ sameSessionFocus, afterInterruptedRestore })})`,
  );

  await win.webContents.executeJavaScript(`document.querySelector('button[title="First"]')?.click()`, true);
  await delay(350);
  await win.webContents.executeJavaScript(
    `document.querySelector('.session-view-filter-trigger')?.click()`,
    true,
  );
  await waitFor(
    win.webContents,
    `document.querySelector('.session-view-filter-panel')`,
    'session content filter panel',
  );
  await win.webContents.executeJavaScript(
    `document.querySelector('.session-view-filter-option[data-filter="tools"]')?.click()`,
    true,
  );
  await waitFor(
    win.webContents,
    `document.querySelector('.session-view-filter-option[data-filter="tools"]')?.getAttribute('aria-checked') === 'false'`,
    'tool content hidden',
  );
  const toolContentHidden = await win.webContents.executeJavaScript(
    `!document.querySelector('[data-view-key="tool:a-tool-call"]')`,
    true,
  );
  assert(toolContentHidden, 'tool calls can be removed from mixed message rows');

  await win.webContents.executeJavaScript(
    `document.querySelector('.session-view-filter-option[data-filter="thinking"]')?.click()`,
    true,
  );
  await waitFor(
    win.webContents,
    `document.querySelector('.flap-number')?.getAttribute('aria-label') === '${fixtures[sessionA].messages.length - 1}'`,
    'thinking root removed from timeline navigation',
  );
  const compactView = await win.webContents.executeJavaScript(`(() => ({
    thinkingVisible: Boolean(document.querySelector('[data-uuid="a-message-3"]')),
    hiddenCount: document.querySelector('.session-view-filter-count')?.textContent,
    persisted: JSON.parse(localStorage.getItem('obelisk:session-content-visibility')),
  }))()`, true);
  assert(
    !compactView.thinkingVisible
      && compactView.hiddenCount === '2'
      && compactView.persisted.tools === false
      && compactView.persisted.thinking === false,
    `compact timeline view hides both extra types and persists the choice (${JSON.stringify(compactView)})`,
  );

  await win.webContents.executeJavaScript(
    `document.querySelector('.session-view-filter-head button')?.click()`,
    true,
  );
  await waitFor(
    win.webContents,
    `document.querySelector('.flap-number')?.getAttribute('aria-label') === '${fixtures[sessionA].messages.length}'`,
    'timeline content filter reset',
  );
  const filterReset = await win.webContents.executeJavaScript(`(() => ({
    allOptionsChecked: [...document.querySelectorAll('.session-view-filter-option')]
      .every(option => option.getAttribute('aria-checked') === 'true'),
    hiddenCountRemoved: !document.querySelector('.session-view-filter-count'),
  }))()`, true);
  assert(
    filterReset.allOptionsChecked && filterReset.hiddenCountRemoved,
    `timeline content filter restores the complete reader view (${JSON.stringify(filterReset)})`,
  );

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
