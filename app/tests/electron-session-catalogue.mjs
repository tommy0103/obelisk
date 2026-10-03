// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { app, BrowserWindow, ipcMain } from 'electron';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// Synthetic application metadata, not approximations of provider transcripts.
const sessions = Array.from({ length: 1105 }, (_, i) => ({
  id: `catalogue-${i}`,
  title: i === 0 ? 'Oldest searchable session' : `Catalogue session ${i}`,
  project: i < 5 ? 'older-only' : 'active',
  source: i % 2 ? 'codex' : 'claude',
  started_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
  message_count: 1,
  git_branch: 'main',
})).reverse();
const channels = [];
const calls = [];
let releaseCatalogue;
const catalogueReady = new Promise(resolve => { releaseCatalogue = resolve; });
let catalogueReleased = false;
const errors = [];
let failed = false;

function handle(channel, callback) {
  channels.push(channel);
  ipcMain.handle(channel, callback);
}

async function waitFor(win, expression, label) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript(`Boolean(${expression})`)) return;
    await delay(30);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function check(win, expression, label) {
  await waitFor(win, expression, label);
  console.log(`PASS: ${label}`);
}

const badge = `[...document.querySelectorAll('.sidebar-item')].find(el => el.querySelector('.label')?.textContent === 'Sessions')?.querySelector('.badge')?.textContent`;
const rows = `document.querySelectorAll('.srow[data-session-id]')`;

async function search(win, text) {
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#search');
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
}

async function run() {
  handle('db:getSessions', async (_event, opts = {}) => {
    calls.push(['sessions', opts]);
    if (opts.sessionId === undefined) await catalogueReady;
    let rows = sessions.filter(s => (opts.source === 'all' || s.source === (opts.source || 'claude'))
      && (opts.sessionId === undefined || s.id === opts.sessionId));
    if (opts.limit !== null) rows = rows.slice(0, opts.limit ?? 200);
    return rows;
  });
  handle('db:getSessionMessages', (_event, id) => sessions.some(s => s.id === id) ? [{
    uuid: `${id}-message`, type: 'user', role: 'user', timestamp: '2026-01-01T00:00:00Z',
    text: `Evidence for ${id}`, content_type: 'text', visibility: 'visible',
  }] : []);
  for (const name of ['ToolCalls', 'ToolResults', 'Subagents', 'Workflows', 'Summaries']) {
    handle(`db:getSession${name}`, () => []);
  }
  handle('db:getMemories', () => []);
  handle('db:getStats', (_event, opts) => {
    calls.push(['stats', opts]);
    return { sessions: opts?.source === 'all' ? sessions.length : 553 };
  });
  handle('db:getProjects', (_event, opts) => {
    calls.push(['projects', opts]);
    return [{ project: 'active', session_count: 1100 }, { project: 'older-only', session_count: 5 }];
  });
  handle('settings:get', () => ({ sources: [
    { id: 'claude', label: 'Claude Code', status: 'connected' },
    { id: 'codex', label: 'Codex', status: 'connected' },
  ] }));
  handle('updates:getState', () => ({ status: 'disabled' }));
  const win = new BrowserWindow({
    width: 1200, height: 800, show: true,
    webPreferences: {
      preload: join(appRoot, 'out/preload/index.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  win.webContents.on('console-message', details => {
    if (details.level === 'error') errors.push(details.message);
  });
  await win.loadFile(join(appRoot, 'out/renderer/index.html'), { hash: '/sessions/catalogue-0' });
  await check(win, `document.querySelector('[data-uuid="catalogue-0-message"]')`,
    'direct opening loads an old session while the global catalogue is still pending');
  assert.equal(catalogueReleased, false);
  assert.ok(calls.some(([kind, opts]) => kind === 'sessions' && opts.sessionId === 'catalogue-0'));
  await check(win, `document.querySelector('.session-header')?.textContent.includes('Oldest searchable session')`,
    'direct opening loads the session metadata as well as its messages');

  catalogueReleased = true;
  releaseCatalogue();
  await check(win, `${badge} === '1105'`, 'the Sessions badge counts all 1105 indexed sessions');
  assert.ok(calls.some(([kind, opts]) => kind === 'sessions' && opts?.source === 'all' && opts.limit === null));
  assert.ok(calls.some(([kind, opts]) => kind === 'stats' && opts?.source === 'all'));
  assert.ok(calls.some(([kind, opts]) => kind === 'projects' && opts?.source === 'all'));
  await win.webContents.executeJavaScript("window.location.hash = '#/sessions'");
  await check(win, `${rows}.length === 1105`, 'browsing includes every session beyond the first 1000');
  await check(win, `document.querySelector('.srow')?.dataset.sessionId === 'catalogue-1104'`,
    'newest-first sorting covers the complete history');
  await win.webContents.executeJavaScript("document.querySelector('#sort-toggle').click()");
  await check(win, `document.querySelector('.srow')?.dataset.sessionId === 'catalogue-0'`,
    'oldest-first sorting reaches the actual oldest session');

  await search(win, 'Oldest searchable');
  await check(win, `${rows}.length === 1 && document.querySelector('.srow')?.dataset.sessionId === 'catalogue-0'`,
    'metadata search finds a titled session beyond the former cutoff');
  if (process.env.OBELISK_CATALOGUE_SCREENSHOT) {
    await writeFile(process.env.OBELISK_CATALOGUE_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
  }
  await search(win, '');
  await check(win, `${rows}.length === 1105`, 'clearing the search restores the full catalogue');
  const oldProject = `[...document.querySelectorAll('#sidebar-projects .sidebar-item')].find(el => el.textContent.includes('older-only'))`;
  await check(win, `${oldProject}?.querySelector('.badge')?.textContent === '5'`, 'an older-only project remains visible with its full count');
  await win.webContents.executeJavaScript(`${oldProject}.click()`);
  await check(win, `${rows}.length === 5`, 'project filtering reaches all older-only sessions');
  await win.webContents.executeJavaScript(`document.querySelector('.source-filter-wrap .filter-btn').click()`);
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('.fd-row')].find(el => el.textContent.includes('Codex')).click()`);
  await check(win, `${rows}.length === 2 && [...${rows}].every(el => ['catalogue-1', 'catalogue-3'].includes(el.dataset.sessionId))`,
    'source and project filters intersect across the complete history');
  await win.webContents.executeJavaScript(`document.querySelector('[data-session-id="catalogue-1"]').click()`);
  await check(win, `document.querySelector('[data-uuid="catalogue-1-message"]')`,
    'an older result opens its real session detail');
  assert.deepEqual(errors, [], 'renderer has no console errors');
  win.destroy();
}

app.whenReady().then(run).catch(error => {
  failed = true;
  console.error(error.stack || error);
}).finally(() => {
  releaseCatalogue();
  for (const channel of channels) ipcMain.removeHandler(channel);
  app.exit(failed ? 1 : 0);
});
