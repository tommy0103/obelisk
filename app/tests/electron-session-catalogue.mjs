// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only
import { app, BrowserWindow, ipcMain } from 'electron';
import Database from 'better-sqlite3';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { querySessionCatalogue } from '../out/main/session-catalogue.js';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new Database(':memory:');
db.exec(readFileSync(join(appRoot, '../packages/core/src/schema.sql'), 'utf8'));
const insert = db.prepare('INSERT INTO sessions (id, title, project, started_at, source, message_count) VALUES (?, ?, ?, ?, ?, 1)');
for (let i = 0; i < 1105; i++) {
  insert.run(`session-${String(i).padStart(4, '0')}`, i === 0 ? 'Older history ÉCOLE 100%_' : `Conversation ${i}`,
    i < 5 ? 'older-only' : 'current', new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), i % 2 ? 'codex' : 'claude');
}
db.exec("INSERT INTO messages (uuid, session_id, type, role, text, timestamp, content_type) VALUES ('old-message', 'session-0000', 'user', 'user', 'Historical message from beyond the first thousand sessions.', '2026-01-01T00:00:00.000Z', 'text')");
let queries = 0;
let queryDelay = 0;
let failNext = false;
let failures = 0;
const metadataReads = [];
function assert(ok, message) {
  console[ok ? 'log' : 'error'](`${ok ? 'PASS' : 'FAIL'}: ${message}`);
  if (!ok) failures++;
}
function registerHandlers() {
  ipcMain.handle('db:getSessions', () => db.prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT 100').all());
  ipcMain.handle('db:getSessionCatalogue', async (_event, opts) => {
    queries++;
    if (failNext) { failNext = false; throw new Error('Fixture read failed'); }
    const result = querySessionCatalogue(db, opts);
    const wait = queryDelay;
    queryDelay = 0;
    if (wait) await delay(wait);
    return result;
  });
  ipcMain.handle('db:getSessionMetadata', (_event, id) => { metadataReads.push(id); return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) || null; });
  ipcMain.handle('db:getSessionMessages', (_event, id) => db.prepare('SELECT * FROM messages WHERE session_id = ?').all(id));
  for (const name of ['ToolCalls', 'ToolResults', 'Subagents', 'Workflows', 'Summaries']) ipcMain.handle(`db:getSession${name}`, () => []);
  ipcMain.handle('db:getMemories', () => [{ id: 'old-memory', session_id: 'session-0000', project: 'older-only', path: '/tmp/old-memory.md', summary: 'Memory pointing to old history', created_at: '2026-01-01T00:00:00.000Z' }]);
  ipcMain.handle('db:readMemoryFile', () => '# Saved memory');
  ipcMain.handle('db:getProjects', (_event, opts) => {
    assert(opts?.source === 'all', 'project counts explicitly include all sources');
    return db.prepare('SELECT project, COUNT(*) AS session_count FROM sessions GROUP BY project ORDER BY MAX(started_at) DESC').all();
  });
  ipcMain.handle('db:getStats', (_event, opts) => {
    assert(opts?.source === 'all', 'session total explicitly includes all sources');
    return { sessions: db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n };
  });
  ipcMain.handle('settings:get', () => ({ sources: [
    { id: 'claude', name: 'Claude', enabled: true, status: 'ready', sessionCount: 553 },
    { id: 'codex', name: 'Codex', enabled: true, status: 'ready', sessionCount: 552 },
  ] }));
}
async function js(win, code) { return win.webContents.executeJavaScript(code, true); }
async function waitFor(win, expression, name, timeout = 10000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await js(win, `Boolean(${expression})`)) return;
    await delay(30);
  }
  throw new Error(`Timeout: ${name}`);
}
async function settled(win) {
  await waitFor(win, `document.querySelector('.session-list-wrap')?.getAttribute('aria-busy') === 'false'`, 'list settled');
  await delay(40);
}
async function search(win, value) {
  await js(win, `(() => { const input = document.querySelector('#search'); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await delay(350);
  await settled(win);
}
async function navigate(win, hash) {
  await js(win, `location.hash = ${JSON.stringify(hash)}`);
  await delay(100);
}
async function anchor(win) {
  return js(win, `(() => {
    const wrap = document.querySelector('.session-list-wrap');
    const top = wrap.getBoundingClientRect().top;
    const row = [...wrap.querySelectorAll('[data-session-id]')].find(r => r.getBoundingClientRect().bottom > top);
    return { id: row?.dataset.sessionId, offset: row?.getBoundingClientRect().top - top, scroll: wrap.scrollTop };
  })()`);
}
async function run() {
  registerHandlers();
  const win = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { preload: join(appRoot, 'out/preload/index.js'), contextIsolation: true, nodeIntegration: false } });
  try {
    await win.loadFile(join(appRoot, 'out/renderer/index.html'), { hash: '/sessions' });
    await waitFor(win, `document.querySelectorAll('.srow').length === 100`, 'initial page');
    await settled(win);
    assert(await js(win, `[...document.querySelectorAll('.badge')].some(e => e.textContent === '1105')`), 'Sessions badge shows all 1,105 indexed sessions');
    assert(await js(win, `document.querySelector('.sidebar-list')?.textContent.includes('older-only')`), 'older-only project is visible before its sessions load');
    assert(!await js(win, `Boolean(document.querySelector('[data-session-id="session-0000"]'))`), 'old session is outside the initial page');
    if (process.env.OBELISK_TEST_ARTIFACTS) {
      mkdirSync(process.env.OBELISK_TEST_ARTIFACTS, { recursive: true });
      await js(win, `const list = document.querySelector('.session-list-wrap'); list.scrollTop = list.scrollHeight`);
      await delay(50);
      writeFileSync(join(process.env.OBELISK_TEST_ARTIFACTS, 'catalogue-load-more.png'), (await win.webContents.capturePage()).toPNG());
    }
    for (let count = 200; count <= 1200; count += 100) {
      await js(win, `document.querySelector('.load-more').click()`);
      await waitFor(win, `document.querySelectorAll('.srow').length === ${Math.min(count, 1105)}`, 'next page');
      await settled(win);
    }
    const ids = await js(win, `[...document.querySelectorAll('.srow')].map(r => r.dataset.sessionId)`);
    assert(ids.length === 1105 && new Set(ids).size === 1105 && ids.at(-1) === 'session-0000', 'all 1,105 sessions can be browsed without duplicates');
    await search(win, 'école 100%_');
    assert(await js(win, `document.querySelectorAll('.srow').length === 1 && document.querySelector('.srow').dataset.sessionId === 'session-0000'`), 'literal Unicode metadata search reaches old history');
    await search(win, '');
    await js(win, `document.querySelector('#sort-toggle').click()`);
    await delay(80); await settled(win);
    assert(await js(win, `document.querySelector('.srow').dataset.sessionId === 'session-0000'`), 'oldest-first begins at the oldest indexed session');
    await js(win, `[...document.querySelectorAll('.sidebar-item')].find(e => e.textContent.includes('older-only')).click()`);
    await delay(80); await settled(win);
    assert(await js(win, `document.querySelectorAll('.srow').length === 5`), 'older-only project filter reaches all five sessions');
    await js(win, `document.querySelector('.filter-btn').click(); [...document.querySelectorAll('.fd-row')].find(e => e.textContent.includes('Codex')).click()`);
    await delay(80); await settled(win);
    assert(await js(win, `document.querySelectorAll('.srow').length === 2`), 'source filter applies across the full project');
    await js(win, `document.querySelector('.filter-btn').click(); [...document.querySelectorAll('.fd-row')].find(e => e.textContent.includes('All sources')).click()`);
    await js(win, `document.querySelector('.breadcrumb button.crumb').click()`);
    await delay(80); await settled(win);
    await js(win, `document.querySelector('#sort-toggle').click()`);
    await delay(80); await settled(win);
    await js(win, `document.querySelector('.session-list-wrap').scrollTop = 1600`);
    await delay(80);
    const before = await anchor(win);
    await js(win, `window.__retainedRow = document.querySelector('[data-session-id="${before.id}"]')`);
    insert.run('new-session', 'New arriving conversation', 'current', '2027-01-01T00:00:00.000Z', 'codex');
    win.webContents.send('obelisk:index-updated', { affectedSessionIds: ['new-session'] });
    await waitFor(win, `document.querySelector('[data-session-id="new-session"]')`, 'automatic insertion');
    await settled(win);
    const after = await anchor(win);
    assert(before.id === after.id && Math.abs(before.offset - after.offset) < 2, 'live insertion preserves the reading row and its screen position');
    assert(await js(win, `window.__retainedRow === document.querySelector('[data-session-id="${before.id}"]')`), 'unchanged rows retain their existing DOM nodes');
    queryDelay = 300;
    const priorQueries = queries;
    db.prepare('UPDATE sessions SET ended_at = ?, title = ? WHERE id = ?').run('2028-01-01T00:00:00.000Z', 'Updated older conversation', 'session-0001');
    win.webContents.send('obelisk:index-updated', { affectedSessionIds: ['session-0001'] });
    for (let i = 0; i < 50 && queries === priorQueries; i++) await delay(10);
    await js(win, `document.querySelector('.session-list-wrap').scrollTop -= 400`);
    const during = await anchor(win);
    await waitFor(win, `document.querySelector('[data-session-id="session-0001"]')`, 'automatic reorder');
    await settled(win);
    const moved = await anchor(win);
    assert(during.id === moved.id && Math.abs(during.offset - moved.offset) < 2, 'live reordering preserves the reader position reached while a request was in flight');
    const saved = await anchor(win);
    await navigate(win, '/memory/old-memory');
    await waitFor(win, `document.querySelector('.session-link')`, 'memory source button');
    await waitFor(win, `document.querySelector('.session-link')?.textContent.includes('Older history')`, 'old session title');
    await js(win, `document.querySelector('.session-link').click()`);
    await waitFor(win, `document.body.textContent.includes('Historical message from beyond')`, 'old session detail');
    assert(metadataReads.includes('session-0000'), 'Memory opens an old session by ID before it appears in the list');
    await navigate(win, '/sessions');
    await settled(win);
    const returned = await anchor(win);
    assert(saved.id === returned.id && Math.abs(saved.offset - returned.offset) < 2, 'returning from detail restores the prior list position');
    failNext = true;
    win.webContents.send('obelisk:index-updated', {});
    await waitFor(win, `document.querySelector('[role="alert"]')`, 'load error');
    assert(await js(win, `document.querySelectorAll('.srow').length > 0`), 'a failed refresh leaves the readable list in place');
    await js(win, `document.querySelector('[role="alert"] button').click()`);
    await waitFor(win, `!document.querySelector('[role="alert"]')`, 'retry');
    await settled(win);
    const output = process.env.OBELISK_TEST_ARTIFACTS;
    if (output) {
      mkdirSync(output, { recursive: true });
      await js(win, `document.querySelector('.session-list-wrap').scrollTop = 0`);
      writeFileSync(join(output, 'catalogue-wide.png'), (await win.webContents.capturePage()).toPNG());
    }
    win.setSize(800, 600);
    await delay(150);
    assert(await js(win, `(() => { const w = document.querySelector('.session-list-wrap'); return w.scrollWidth <= w.clientWidth + 1; })()`), 'list fits the narrower window without horizontal clipping');
    if (output) writeFileSync(join(output, 'catalogue-narrow.png'), (await win.webContents.capturePage()).toPNG());
  } finally { win.destroy(); db.close(); }
  console.log(`Catalogue suite: ${failures} failures`);
  app.exit(failures ? 1 : 0);
}
app.whenReady().then(run).catch(error => { console.error(error); app.exit(1); });
