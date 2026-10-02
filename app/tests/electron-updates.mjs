// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Exercise update IPC, actual renderer interactions and reader-anchor stability.
import { app, BrowserWindow, ipcMain } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createSessionPatch } from '../src/shared/session-patch.mjs';
import { assembleSessionDetail } from '../src/shared/session-detail-assembly.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const sessionId = 'update-reader-session';
const cwd = '/tmp/obelisk-update-reader-fixture';
const channels = [
  'updates:getState', 'updates:check', 'updates:install',
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

const messages = Array.from({ length: 180 }, (_, index) => ({
  uuid: `update-reader-${index}`,
  session_id: sessionId,
  type: 'assistant',
  role: 'assistant',
  timestamp: '2026-07-16T00:00:00.000Z',
  text: `${index}: ${messageText}\n`.repeat(3),
  content_type: 'text',
  is_meta: 0,
  cwd,
}));

function summary() {
  return {
    id: sessionId,
    title: 'Update reader fixture',
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

let update = { revision: 0, phase: 'idle', currentVersion: '0.2.3', version: null, progress: null, error: null, releaseNotes: '', lastChecked: null };
let installCalls = 0, checkCalls = 0;
const openedLinks = [];
const setUpdate = (win, patch) => { update = { ...update, ...patch, revision: update.revision + 1 }; win.webContents.send('obelisk:update-state', update); };
async function run() {
  registerHandlers();
  ipcMain.handle('updates:getState', () => update);
  ipcMain.handle('updates:check', () => { checkCalls++; return update; });
  ipcMain.handle('updates:install', () => { installCalls++; });
  const win = new BrowserWindow({ show: false, width: 1200, height: 800,
    webPreferences: { preload: join(appRoot, 'out/preload/index.js'), contextIsolation: true, nodeIntegration: false } });
  win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') console.error('Renderer:', details.message); });
  win.webContents.setWindowOpenHandler(({ url }) => { openedLinks.push(url); return { action: 'deny' }; });
  win.webContents.on('render-process-gone', (_event, details) => { throw new Error(`Renderer exited: ${details.reason}`); });
  await win.loadFile(join(appRoot, 'out/renderer/index.html'), { hash: `/sessions/${sessionId}` });
  await waitFor(win.webContents, `document.querySelector('.detail-wrap') && document.querySelector('[data-uuid]')`, 'session reader');
  await delay(400);
  const evaluate = code => win.webContents.executeJavaScript(code, true);
  await evaluate(`document.querySelector('.detail-wrap').scrollTop = document.querySelector('.detail-wrap').scrollHeight * .5`);
  await waitFor(win.webContents, `(() => {
    const wrap = document.querySelector('.detail-wrap');
    const timeline = document.querySelector('.virtual-timeline');
    if (!wrap || !timeline || getComputedStyle(timeline).visibility === 'hidden' || document.querySelector('.first-open-loading')) return false;
    const bounds = wrap.getBoundingClientRect();
    return [...document.querySelectorAll('.virtual-timeline-row')].some(row => row.getBoundingClientRect().top >= bounds.top && row.getBoundingClientRect().top < bounds.bottom && row.querySelector('[data-uuid]'));
  })()`, 'a visible mid-session reader anchor');
  const anchor = await evaluate(`(() => {
    const wrap = document.querySelector('.detail-wrap');
    const row = [...document.querySelectorAll('.virtual-timeline-row')].find(el => el.getBoundingClientRect().top >= wrap.getBoundingClientRect().top);
    return { uuid: row.querySelector('[data-uuid]').dataset.uuid, offset: row.getBoundingClientRect().top, scroll: wrap.scrollTop };
  })()`);
  setUpdate(win, { phase: 'downloading', version: '0.2.4', progress: 37,
    releaseNotes: '# Reader improvements\n\n- Keeps your position.\n\n[Release details](https://github.com/tommy0103/obelisk/releases/tag/v0.2.4)\n<img src="https://invalid.example/track" onerror="window.updateXss=1"><svg onload="window.updateXss=2"></svg><a href="javascript:window.updateXss=3">Bad link</a><script>window.updateXss=4</script>' });
  await waitFor(win.webContents, `document.querySelector('.update-notice progress')?.value === 37`, 'download progress');
  assert(!await evaluate(`!![...document.querySelectorAll('.update-notice button')].find(el => el.textContent.includes('restart'))`), 'downloading never offers premature installation');
  const checkAnchor = async label => {
    const after = await evaluate(`(() => { const row = document.querySelector('[data-uuid="${anchor.uuid}"]').closest('.virtual-timeline-row'); return { offset: row.getBoundingClientRect().top, scroll: document.querySelector('.detail-wrap').scrollTop }; })()`);
    assert(Math.abs(after.offset - anchor.offset) < 2 && Math.abs(after.scroll - anchor.scroll) < 2, label);
  };
  await checkAnchor('download notice preserves the visible reader anchor');
  await evaluate(`document.querySelector('.update-notice .update-link').click()`);
  await waitFor(win.webContents, `document.querySelector('.update-dialog')?.open`, 'release notes modal');
  assert(await evaluate(`document.querySelector('.update-notes-content h1')?.textContent === 'Reader improvements'`), 'View changes renders the supplied release notes inside the app');
  assert(!await evaluate(`!!document.querySelector('.update-notes-content img, .update-notes-content svg, .update-notes-content script, .update-notes-content [onerror], .update-notes-content a[href^="javascript:"]') || !!window.updateXss`), 'untrusted release notes cannot execute script or load media');
  assert(await evaluate(`document.activeElement.closest('.update-dialog') != null`), 'release notes receive keyboard focus');
  assert(openedLinks.length === 0, 'release notes do not open links automatically');
  await evaluate(`document.querySelector('.update-notes-content a[href^="https:"]').click()`);
  await delay(50);
  assert(openedLinks[0] === 'https://github.com/tommy0103/obelisk/releases/tag/v0.2.4', 'only a user-initiated HTTPS release link reaches the browser boundary');
  await delay(120);
  await win.webContents.capturePage().then(image => image.toPNG()).then(bytes => import('node:fs/promises').then(fs => fs.writeFile('/private/tmp/obelisk-update-notes.png', bytes)));
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await waitFor(win.webContents, `!document.querySelector('.update-dialog')?.open`, 'closed release notes');
  await checkAnchor('opening and closing release notes preserves the reader anchor');
  setUpdate(win, { phase: 'ready', progress: 100 });
  await waitFor(win.webContents, `document.querySelector('.update-notice .primary')`, 'ready action');
  await delay(120);
  await win.webContents.capturePage().then(image => image.toPNG()).then(bytes => import('node:fs/promises').then(fs => fs.writeFile('/private/tmp/obelisk-update-ready.png', bytes)));
  await evaluate(`document.querySelector('.update-notice .subtle').click()`);
  await waitFor(win.webContents, `!document.querySelector('.update-notice')`, 'Later dismissal');
  assert(installCalls === 0, 'Later keeps the app running without installing');
  setUpdate(win, { phase: 'ready', version: '0.2.5' });
  await waitFor(win.webContents, `!!document.querySelector('.update-notice')`, 'new version after dismissal');
  setUpdate(win, { phase: 'preparing' });
  await waitFor(win.webContents, `document.querySelector('.update-notice .primary')?.disabled`, 'disabled restart');
  assert(await evaluate(`document.querySelector('.update-notice .subtle').disabled`), 'preparing prevents duplicate restart and dismissal');
  setUpdate(win, { phase: 'ready', error: 'Watcher close failed' });
  await waitFor(win.webContents, `document.querySelector('.update-notice [role="alert"]')?.textContent.includes('Watcher')`, 'retry error');
  await evaluate(`document.querySelector('.update-notice .primary').click()`);
  await delay(50); assert(installCalls === 1, 'Update & restart reaches the main-process command');
  await evaluate(`window.location.hash = '#/settings'`);
  await waitFor(win.webContents, `document.querySelector('.update-panel')`, 'About update controls');
  assert(await evaluate(`document.querySelector('.update-panel').textContent.includes('Watcher close failed')`), 'About retains the current update error');
  setUpdate(win, { phase: 'current', version: null, error: null });
  await waitFor(win.webContents, `document.querySelector('.update-panel').textContent.includes('up to date')`, 'up-to-date state');
  await evaluate(`document.querySelector('.update-panel .update-button').click()`);
  await delay(50); assert(checkCalls === 1, 'About manual check reaches the updater');
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
