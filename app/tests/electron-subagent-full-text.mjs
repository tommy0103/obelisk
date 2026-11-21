// A truncated subagent message loads its full text in place.

import { app, BrowserWindow, ipcMain } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const channels = [
  'db:getSessions',
  'db:getSessionCatalogue',
  'db:getMemories',
  'db:getProjects',
  'db:getStats',
  'settings:get',
  'db:getSubagentMessages',
  'db:getSubagentToolCalls',
  'db:getSubagentToolResults',
  'db:getMessageFullText',
];
const truncated = `Truncated head ${'x'.repeat(10_000)}`;
const full = `${truncated} and the full tail`;

let failures = 0;

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

async function run() {
  const fullTextRequests = [];
  ipcMain.handle('db:getSessions', () => []);
  ipcMain.handle('db:getSessionCatalogue', () => ({ rows: [], total: 0 }));
  ipcMain.handle('db:getMemories', () => []);
  ipcMain.handle('db:getProjects', () => []);
  ipcMain.handle('db:getStats', () => ({}));
  ipcMain.handle('settings:get', () => ({}));
  ipcMain.handle('db:getSubagentMessages', () => [{
    uuid: 'subagent-message',
    type: 'assistant',
    timestamp: '2026-07-30T00:00:00.000Z',
    text: truncated,
    content_type: 'text',
    is_meta: 0,
  }]);
  ipcMain.handle('db:getSubagentToolCalls', () => []);
  ipcMain.handle('db:getSubagentToolResults', () => []);
  ipcMain.handle('db:getMessageFullText', (_event, uuid) => {
    fullTextRequests.push(uuid);
    return full;
  });

  const win = new BrowserWindow({
    show: true,
    width: 1000,
    height: 800,
    webPreferences: {
      preload: join(appRoot, 'out', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  try {
    await win.loadFile(join(appRoot, 'out', 'renderer', 'index.html'), { hash: '/sessions/parent/agent/agent-1' });
    await waitFor(win.webContents, `document.querySelector('[data-uuid="subagent-message"] .truncated-btn')`, 'truncated message');
    await win.webContents.executeJavaScript(`document.querySelector('[data-uuid="subagent-message"] .truncated-btn').click()`, true);
    await waitFor(win.webContents, `document.querySelector('[data-uuid="subagent-message"]').textContent.includes('and the full tail')`, 'full text');
    const after = await win.webContents.executeJavaScript(`(() => {
      const row = document.querySelector('[data-uuid="subagent-message"]');
      return {
        button: Boolean(row.querySelector('.truncated-btn')),
        markdownBodies: row.querySelectorAll('.markdown-msg').length,
      };
    })()`, true);
    assert(JSON.stringify(fullTextRequests) === '["subagent-message"]', `full text is requested once for the message (${JSON.stringify(fullTextRequests)})`);
    assert(!after.button, 'the load button goes away once the full text is shown');
    assert(after.markdownBodies === 1, `the full text replaces the truncated body (${after.markdownBodies} bodies)`);
  } finally {
    win.destroy();
  }
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
