// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { app, BrowserWindow, ipcMain } from 'electron';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// Synthetic application metadata, not approximations of provider transcripts.
const sessions = Array.from({ length: 100_005 }, (_, i) => ({
  id: `catalogue-${i}`,
  title: i === 0 ? 'Oldest searchable session' : i === 1 ? 'Deep searchable title' : i % 10 === 0 ? null : `Catalogue session ${i}`,
  project: i < 5 ? 'older-only' : 'active',
  source: i % 2 ? 'codex' : 'claude',
  started_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
  message_count: 1,
  git_branch: 'main',
})).reverse();
const channels = [];
const calls = [];
const pageBytes = [];
let releaseCatalogue;
let pageGate = Promise.resolve();
let releasePageGate;
let releaseActivityMonth;
let activityMonthGate = Promise.resolve();
let activityMonthReplies = 0;
const today = new Date();
const firstDay = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
const activityDay = { id: 'activity-first-day', title: 'Selected first-day session', project: 'active',
  started_at: `${firstDay}T12:00:00Z`, message_count: 1, has_earlier: 1 };
const activityOtherDay = { ...activityDay, id: 'activity-other-day', title: 'Other-day session',
  started_at: `${firstDay.slice(0, 8)}02T12:00:00Z` };
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

async function checkActivityDayRefresh(win) {
  await win.webContents.executeJavaScript("window.location.hash = '#/activity'");
  await check(win, `document.querySelector('.session-activity')?.textContent.includes('Other-day session')`,
    'Activity initially displays the monthly ledger');
  await win.webContents.executeJavaScript("document.querySelector('.heatmap .heatmap-cell.level-4').dispatchEvent(new MouseEvent('click', { bubbles: true }))");
  const dayLedger = `document.querySelector('.session-activity')?.textContent`;
  await check(win, `${dayLedger}?.includes('Selected first-day session') && !${dayLedger}?.includes('Other-day session')`,
    'selecting the first day restricts the ledger to that day');

  activityMonthGate = new Promise(resolve => { releaseActivityMonth = resolve; });
  activityDay.title = 'Refreshed first-day session';
  const repliesBefore = activityMonthReplies;
  win.webContents.send('obelisk:index-updated', {});
  await check(win, `${dayLedger}?.includes('Refreshed first-day session')`,
    'the daily refresh settles while its monthly refresh is pending');
  releaseActivityMonth();
  activityMonthGate = Promise.resolve();
  const deadline = Date.now() + 10_000;
  while (activityMonthReplies === repliesBefore && Date.now() < deadline) await delay(30);
  assert.ok(activityMonthReplies > repliesBefore, 'the delayed monthly refresh completes');
  await delay(200);
  const ledger = await win.webContents.executeJavaScript(`({
    text: ${dayLedger}, count: document.querySelector('.activity-month-count')?.textContent,
  })`);
  assert.ok(ledger.text.includes('Refreshed first-day session') && !ledger.text.includes('Other-day session'),
    'a late monthly refresh cannot put other dates into the selected-day ledger');
  assert.equal(ledger.count, '1 session', 'a late monthly refresh cannot change the selected-day count');
  console.log('PASS: selected first-day activity survives a late monthly refresh');
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
  handle('db:getSessionCatalogue', async (_event, opts = {}) => {
    calls.push(['catalogue', opts]);
    await catalogueReady;
    await pageGate;
    assert.ok(opts.limit > 0 && opts.limit <= 100 && opts.offset >= 0);
    const q = (opts.query || '').trim().toLowerCase();
    const matches = sessions.filter(s => (opts.source === 'all' || (s.source || 'claude') === (opts.source || 'claude'))
      && (!opts.project || opts.project === 'all' || opts.project === s.project)
      && Boolean(!s.title) === Boolean(opts.quiet)
      && (!q || [s.title, s.project, s.git_branch].some(value => value?.toLowerCase().includes(q))));
    if (opts.descending === false) matches.reverse();
    const result = { rows: matches.slice(opts.offset, opts.offset + opts.limit), total: matches.length };
    assert.ok(result.rows.length <= 100);
    pageBytes.push(Buffer.byteLength(JSON.stringify(result)));
    return result;
  });
  handle('db:getSessionMessages', (_event, id) => sessions.some(s => s.id === id) ? [{
    uuid: `${id}-message`, type: 'user', role: 'user', timestamp: '2026-01-01T00:00:00Z',
    text: `Evidence for ${id}`, content_type: 'text', visibility: 'visible',
  }] : []);
  for (const name of ['ToolCalls', 'ToolResults', 'Subagents', 'Workflows', 'Summaries']) {
    handle(`db:getSession${name}`, () => []);
  }
  handle('db:getMemories', () => []);
  handle('db:getUsageStats', () => ({ daily: [
    { day: firstDay, tokens: 1 }, { day: activityOtherDay.started_at.slice(0, 10), tokens: 0 },
  ], totalTokens: 1 }));
  handle('db:getActivitySessions', async (_event, opts) => {
    if (opts.from.includes('T')) return { rows: [{ ...activityDay }], total: 1 };
    await activityMonthGate;
    activityMonthReplies++;
    return { rows: [{ ...activityDay }, activityOtherDay], total: 2 };
  });
  handle('db:getStats', (_event, opts) => {
    calls.push(['stats', opts]);
    return { sessions: opts?.source === 'all' ? sessions.length : 50_003 };
  });
  handle('db:getProjects', (_event, opts) => {
    calls.push(['projects', opts]);
    return [{ project: 'active', session_count: 100_000 }, { project: 'older-only', session_count: 5 }];
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
  await check(win, `${badge} === '100005'`, 'the Sessions badge counts all 100005 indexed sessions');
  assert.ok(!calls.some(([kind, opts]) => kind === 'sessions' && opts?.limit === null));
  assert.ok(calls.some(([kind, opts]) => kind === 'stats' && opts?.source === 'all'));
  assert.ok(calls.some(([kind, opts]) => kind === 'projects' && opts?.source === 'all'));
  const browseStart = performance.now();
  await win.webContents.executeJavaScript("window.location.hash = '#/sessions'");
  await check(win, `document.querySelector('.srow')?.dataset.sessionId === 'catalogue-100004'`,
    'newest-first sorting covers the complete history');
  const browseMs = performance.now() - browseStart;
  await win.webContents.executeJavaScript("document.querySelector('.session-scroll').scrollTop = 200000");
  await check(win, `${rows}.length > 0 && [...${rows}].some(el => Number(el.dataset.sessionId.split('-')[1]) < 99000)`,
    'scrolling reaches sessions beyond the first 1000');
  const browseRows = await win.webContents.executeJavaScript(`${rows}.length`);
  assert.ok(browseRows < 80, 'DOM row count remains bounded while browsing');
  const anchor = await win.webContents.executeJavaScript(`(() => {
    const scroll = document.querySelector('.session-scroll');
    const top = scroll.getBoundingClientRect().top;
    const row = [...document.querySelectorAll('.srow[data-session-id]')].find(el => el.getBoundingClientRect().bottom > top);
    return { id: row.dataset.sessionId, offset: row.getBoundingClientRect().top - top, scrollTop: scroll.scrollTop };
  })()`);
  const catalogueReadsBeforeRefresh = calls.filter(([kind]) => kind === 'catalogue').length;
  pageGate = new Promise(resolve => { releasePageGate = resolve; });
  win.webContents.send('obelisk:index-updated', {});
  await waitFor(win, 'true', 'renderer remains responsive during refresh');
  const refreshDeadline = Date.now() + 10_000;
  while (calls.filter(([kind]) => kind === 'catalogue').length === catalogueReadsBeforeRefresh && Date.now() < refreshDeadline) await delay(10);
  assert.ok(calls.filter(([kind]) => kind === 'catalogue').length > catalogueReadsBeforeRefresh, 'background refresh requests new pages');
  const anchorPosition = `(() => {
    const scroll = document.querySelector('.session-scroll');
    const row = document.querySelector('[data-session-id="${anchor.id}"]');
    return row ? { offset: row.getBoundingClientRect().top - scroll.getBoundingClientRect().top, scrollTop: scroll.scrollTop } : null;
  })()`;
  const duringRefresh = await win.webContents.executeJavaScript(anchorPosition);
  assert.ok(duringRefresh && Math.abs(duringRefresh.offset - anchor.offset) <= 2,
    'background catalogue refresh keeps the visible reader anchor while IPC is pending');
  releasePageGate();
  pageGate = Promise.resolve();
  await delay(100);
  const afterRefresh = await win.webContents.executeJavaScript(anchorPosition);
  assert.ok(afterRefresh && Math.abs(afterRefresh.offset - anchor.offset) <= 2
    && Math.abs(afterRefresh.scrollTop - anchor.scrollTop) <= 2,
    'background catalogue refresh does not move the reader after pages settle');
  console.log('PASS: background catalogue refresh preserves the visible reader anchor');
  await win.webContents.executeJavaScript("document.querySelector('#sort-toggle').click()");
  await check(win, `document.querySelector('.srow')?.dataset.sessionId === 'catalogue-0'`,
    'oldest-first sorting reaches the actual oldest session');

  await search(win, 'Oldest searchable');
  await check(win, `${rows}.length === 1 && document.querySelector('.srow')?.dataset.sessionId === 'catalogue-0'`,
    'metadata search finds a titled session beyond the former cutoff');
  await search(win, 'Deep searchable title');
  await check(win, `document.querySelector('.srow')?.dataset.sessionId === 'catalogue-1'`,
    'database search reaches another old session');
  if (process.env.OBELISK_CATALOGUE_SCREENSHOT) {
    await writeFile(process.env.OBELISK_CATALOGUE_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
  }
  await search(win, '');
  await check(win, `document.querySelector('.srow')?.dataset.sessionId === 'catalogue-0'`, 'clearing search restores oldest-first order');
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
  await win.webContents.executeJavaScript("window.location.hash = '#/sessions'");
  await check(win, `document.querySelector('.project-crumb')`, 'returning from detail retains the project filter');
  const updated = sessions.find(session => session.id === 'catalogue-1');
  updated.title = 'Updated inactive session title';
  updated.git_branch = 'updated-branch';
  win.webContents.send('obelisk:session-updated', { sessionId: updated.id });
  win.webContents.send('obelisk:index-updated', {});
  await check(win, `document.querySelector('[data-session-id="catalogue-1"]')?.textContent.includes('Updated inactive session title')`,
    'an inactive session update refreshes its catalogue row');
  await win.webContents.executeJavaScript(`document.querySelector('[data-session-id="catalogue-1"]').click()`);
  await check(win, `document.querySelector('.session-header')?.textContent.includes('Updated inactive session title')`,
    'reopening an updated session refreshes the detail metadata');
  await win.webContents.executeJavaScript("window.location.hash = '#/sessions'");
  await check(win, `document.querySelector('.project-crumb')`, 'return from refreshed detail');

  await win.webContents.executeJavaScript("document.querySelector('.breadcrumb .crumb').click()");
  await win.webContents.executeJavaScript("document.querySelector('.source-filter-wrap .filter-btn').click()");
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('.fd-row')].find(el => el.textContent.includes('Claude')).click()`);
  await search(win, '');
  await check(win, `document.querySelector('.srow')?.dataset.sessionId === 'catalogue-0'`, 'all-project list reloads');
  await win.webContents.executeJavaScript("document.querySelector('.session-scroll').scrollTop = document.querySelector('.session-scroll').scrollHeight");
  await check(win, `document.querySelector('.fold-banner')`, 'quiet fold is reachable without mounting the whole list');
  await win.webContents.executeJavaScript("document.querySelector('.fold-banner').click()");
  await win.webContents.executeJavaScript("document.querySelector('.session-scroll').scrollTop = document.querySelector('.session-scroll').scrollHeight");
  await check(win, `${rows}.length > 0 && ${rows}.length < 80 && document.querySelector('.srow.noise')`,
    'expanded quiet sessions are virtualized and reachable');
  const quietRows = await win.webContents.executeJavaScript(`${rows}.length`);
  const quietId = await win.webContents.executeJavaScript(`(() => {
    const row = document.querySelector('.srow.noise');
    const id = row.dataset.sessionId;
    row.click();
    return id;
  })()`);
  await check(win, `document.querySelector('[data-uuid="${quietId}-message"]')`, 'expanded quiet session opens its detail');
  assert.ok(calls.filter(([kind]) => kind === 'catalogue').every(([, opts]) => opts.limit <= 100), 'catalogue IPC stays bounded');
  assert.ok(Math.max(...pageBytes) < 100_000, 'no catalogue response transfers an unbounded IPC payload');
  if (process.env.OBELISK_CATALOGUE_BENCH) {
    const sample = sessions.slice(0, 100);
    const measureClone = value => {
      const timings = [];
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        structuredClone(value);
        timings.push(Math.round(performance.now() - start));
      }
      return timings.sort((a, b) => a - b)[2];
    };
    const bareDomMs = await win.webContents.executeJavaScript(`(() => {
      const start = performance.now();
      const container = document.createElement('div');
      for (let i = 0; i < 100005; i++) {
        const row = document.createElement('div');
        row.className = 'srow';
        row.textContent = 'Catalogue session ' + i;
        container.appendChild(row);
      }
      const elapsed = performance.now() - start;
      container.remove();
      return Math.round(elapsed);
    })()`);
    console.log(`BENCH 100005 rows: full IPC=${Buffer.byteLength(JSON.stringify(sessions))} bytes / clone median=${measureClone(sessions)} ms; page IPC max=${Math.max(...pageBytes)} bytes / clone median=${measureClone(sample)} ms; bare DOM construction=${bareDomMs} ms / virtual DOM rows browsing=${browseRows} quiet=${quietRows}; list navigation=${Math.round(browseMs)} ms`);
  }
  await checkActivityDayRefresh(win);
  assert.deepEqual(errors, [], 'renderer has no console errors');
  win.destroy();
}

app.whenReady().then(run).catch(error => {
  failed = true;
  console.error(error.stack || error);
}).finally(() => {
  releaseCatalogue();
  releasePageGate?.();
  releaseActivityMonth?.();
  for (const channel of channels) ipcMain.removeHandler(channel);
  app.exit(failed ? 1 : 0);
});
