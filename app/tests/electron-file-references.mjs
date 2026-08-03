// Covers the DOM half of file-references.mjs, which the node --test suite cannot reach:
// which references become links, which must be left alone, and what the click sends.
import { app, BrowserWindow, ipcMain } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createSessionPatch } from '../src/shared/session-patch.mjs';
import { assembleSessionDetail } from '../src/shared/session-detail-assembly.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const sessionId = 'file-ref-session';
const cwd = '/tmp/obelisk-file-ref-fixture';
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
  'settings:set',
  'file-ref:open',
];

let failures = 0;
const openCalls = [];
const settingCalls = [];

const messageText = [
  'Absolute link: [roadmap.md](/tmp/obelisk-file-ref-fixture/docs/roadmap.md:162)',
  '',
  'Inline relative: `src/app.ts:40`',
  '',
  'Plain inline code: `package.json` and `useState`',
  '',
  'Fenced block below must stay inert:',
  '',
  '```ts',
  'src/should-not-link.ts:99',
  '```',
].join('\n');

const messages = [{
  uuid: 'file-ref-message-0',
  session_id: sessionId,
  type: 'assistant',
  role: 'assistant',
  timestamp: '2026-07-16T00:00:00.000Z',
  text: messageText,
  content_type: 'text',
  is_meta: 0,
  cwd,
}];

function summary() {
  return {
    id: sessionId,
    title: 'File reference fixture',
    project: 'quiet-zero',
    project_path: cwd,
    source: 'codex',
    started_at: '2026-07-16T00:00:00.000Z',
    ended_at: '2026-07-16T01:00:00.000Z',
    message_count: messages.length,
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
  ipcMain.handle('db:getSessions', () => [summary()]);
  ipcMain.handle('db:getSessionMessages', () => messages);
  ipcMain.handle('db:getSessionToolCalls', () => []);
  ipcMain.handle('db:getSessionToolResults', () => []);
  ipcMain.handle('db:getSessionPatch', (_event, id, cursor) => {
    const patch = createSessionPatch({
      messages: assembleSessionDetail({
        messages, toolCalls: [], toolResults: [], subagents: [], workflows: [],
      }).messages,
      workflows: [],
    }, cursor);
    return { ...patch, session: summary() };
  });
  ipcMain.handle('db:getSessionSubagents', () => []);
  ipcMain.handle('db:getSessionWorkflows', () => []);
  ipcMain.handle('db:getSessionSummaries', () => []);
  ipcMain.handle('db:getMessageFullText', () => null);
  ipcMain.handle('db:getMemories', () => []);
  ipcMain.handle('db:getProjects', () => [{ project: 'quiet-zero', count: 1 }]);
  ipcMain.handle('db:getStats', () => ({}));
  ipcMain.handle('settings:get', () => ({
    editorScheme: 'vscode',
    version: '9.8.7-test',
  }));
  ipcMain.handle('settings:set', (_event, key, value) => {
    settingCalls.push({ key, value });
    return true;
  });
  ipcMain.handle('file-ref:open', (_event, ref) => {
    openCalls.push(ref);
    return { opened: false };
  });
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
  await waitFor(win.webContents, `document.body.textContent.includes('File reference fixture')`, 'session list');

  await win.webContents.executeJavaScript(
    `window.location.hash = ${JSON.stringify(`#/sessions/${sessionId}`)}`, true,
  );
  await waitFor(win.webContents, `document.querySelectorAll('a.file-ref').length > 0`, 'marked references');
  await delay(200);

  const marks = await win.webContents.executeJavaScript(`(() => {
    const refs = [...document.querySelectorAll('a.file-ref')].map(el => ({
      path: el.dataset.filePath,
      line: el.dataset.fileLine || null,
      cwd: el.dataset.fileCwd || null,
      session: el.dataset.fileSession || null,
      inCode: Boolean(el.closest('code')),
      inPre: Boolean(el.closest('pre')),
    }));
    const preText = [...document.querySelectorAll('pre')].map(p => p.textContent).join('\\n');
    return { refs, preText, preRefCount: document.querySelectorAll('pre .file-ref').length };
  })()`, true);

  const link = marks.refs.find(r => r.path === '/tmp/obelisk-file-ref-fixture/docs/roadmap.md');
  assert(Boolean(link), `absolute markdown link becomes a reference (${JSON.stringify(marks.refs)})`);
  assert(link?.line === '162', 'absolute link keeps its line number');

  const inline = marks.refs.find(r => r.path === 'src/app.ts');
  assert(Boolean(inline), 'inline code with a line number becomes a reference');
  assert(inline?.line === '40', 'inline reference keeps its line number');
  assert(inline?.cwd === cwd, 'inline reference carries the message cwd');
  assert(inline?.session === sessionId, 'reference carries the session id');
  assert(inline?.inCode === true, 'inline reference stays inside its <code> element');

  assert(marks.preRefCount === 0, 'no reference is created inside a fenced block');
  assert(
    marks.preText.includes('src/should-not-link.ts:99'),
    'fenced block still shows its original path text',
  );
  assert(
    marks.refs.every(r => r.path !== 'package.json' && r.path !== 'useState'),
    'ordinary inline code is not turned into a reference',
  );
  assert(marks.refs.length === 2, `exactly two references are marked (got ${marks.refs.length})`);

  const navigatedAway = [];
  win.webContents.on('will-navigate', (_event, url) => navigatedAway.push(url));

  await win.webContents.executeJavaScript(
    `document.querySelector('a.file-ref[data-file-path="src/app.ts"]').click()`, true,
  );
  await delay(300);

  assert(openCalls.length === 1, `clicking a reference calls file-ref:open once (got ${openCalls.length})`);
  assert(openCalls[0]?.path === 'src/app.ts', 'click sends the parsed path');
  assert(openCalls[0]?.line === 40, 'click sends the line as a number');
  assert(openCalls[0]?.cwd === cwd, 'click sends the message cwd');
  assert(openCalls[0]?.sessionId === sessionId, 'click sends the session id');
  assert(navigatedAway.length === 0, 'clicking a reference never navigates the window');

  await win.webContents.executeJavaScript(`window.location.hash = '#/settings'`, true);
  await waitFor(
    win.webContents,
    `document.body.textContent.includes('Editor URL scheme')`,
    'settings editor control',
  );

  const settingsState = await win.webContents.executeJavaScript(`(() => {
    const trigger = document.querySelector('.editor-picker-trigger');
    const style = trigger ? getComputedStyle(trigger) : null;
    return {
      exists: Boolean(trigger),
      width: trigger?.getBoundingClientRect().width || null,
      backgroundColor: style?.backgroundColor || null,
      color: style?.color || null,
      expanded: trigger?.getAttribute('aria-expanded') || null,
      label: trigger?.textContent?.trim() || null,
      nativeSelects: document.querySelectorAll('select').length,
      version: document.querySelector('.version-text')?.textContent?.trim() || null,
    };
  })()`, true);

  assert(settingsState.exists, 'Settings renders the themed editor selector');
  assert(settingsState.width === 180, `editor picker stays compact (${settingsState.width}px)`);
  assert(
    settingsState.backgroundColor !== 'rgb(255, 255, 255)',
    `editor picker keeps the dark Settings surface (${settingsState.backgroundColor})`,
  );
  assert(settingsState.color !== 'rgb(0, 0, 0)', `editor picker keeps themed text (${settingsState.color})`);
  assert(settingsState.expanded === 'false', 'editor picker starts collapsed');
  assert(settingsState.label.includes('VS Code'), `editor picker uses a readable label (${settingsState.label})`);
  assert(settingsState.nativeSelects === 0, 'Settings does not fall back to a native select');
  assert(settingsState.version === 'Obelisk 9.8.7-test', `Settings renders the IPC app version (${settingsState.version})`);

  await win.webContents.executeJavaScript(
    `document.querySelector('.editor-picker-trigger').click()`, true,
  );
  await waitFor(
    win.webContents,
    `document.querySelector('.editor-picker-menu.show [role="option"]')`,
    'editor picker menu',
  );
  const openPicker = await win.webContents.executeJavaScript(`(() => ({
    expanded: document.querySelector('.editor-picker-trigger')?.getAttribute('aria-expanded'),
    menuWidth: document.querySelector('.editor-picker-menu')?.getBoundingClientRect().width,
    options: [...document.querySelectorAll('.editor-picker-option')].map(option => ({
      label: option.textContent.trim(),
      selected: option.getAttribute('aria-selected'),
    })),
  }))()`, true);
  assert(openPicker.expanded === 'true', 'editor picker exposes its expanded state');
  assert(openPicker.menuWidth === 180, `editor picker menu matches trigger width (${openPicker.menuWidth}px)`);
  assert(openPicker.options.length === 5, `editor picker exposes five editors (${openPicker.options.length})`);
  assert(openPicker.options.some(option => option.label.includes('VS Code') && option.selected === 'true'), 'current editor is marked selected');

  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('.editor-picker-option')].find(option => option.textContent.includes('Cursor')).click()`, true,
  );
  await delay(100);
  assert(
    settingCalls.some(call => call.key === 'editorScheme' && call.value === 'cursor'),
    `editor picker persists the selected scheme (${JSON.stringify(settingCalls)})`,
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
