// The renderer's Content-Security-Policy, checked in the built app: normal use
// raises no violation, and script the app did not ship never runs.

import { app, BrowserWindow, ipcMain } from 'electron';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const sessionId = 'csp-session';
const channels = [
  'db:getSessions',
  'db:getSessionCatalogue',
  'db:getSessionMessages',
  'db:getSessionToolCalls',
  'db:getSessionToolResults',
  'db:getSessionSubagents',
  'db:getSessionWorkflows',
  'db:getSessionSummaries',
  'db:getMemories',
  'db:getProjects',
  'db:getStats',
  'settings:get',
];
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#22c55e"/></svg>';

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

function startServer() {
  const requests = [];
  return new Promise(resolve => {
    const server = createServer((request, response) => {
      requests.push(request.url);
      if (request.url === '/remote.svg') {
        response.writeHead(200, { 'Content-Type': 'image/svg+xml' });
        response.end(svg);
        return;
      }
      if (request.url === '/remote.js') {
        response.writeHead(200, { 'Content-Type': 'text/javascript' });
        response.end('window.__remoteScript = true;');
        return;
      }
      response.writeHead(404);
      response.end();
    });
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      requests,
    }));
  });
}

function registerHandlers({ baseUrl, localImageUrl }) {
  const messages = [{
    uuid: 'message-images',
    type: 'assistant',
    timestamp: '2026-07-30T00:00:00.000Z',
    text: [
      '## Images',
      '',
      `![Remote](${baseUrl}/remote.svg)`,
      '',
      `![Local](${localImageUrl})`,
      '',
      `![Data](data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')})`,
    ].join('\n'),
    content_type: 'text',
    is_meta: 0,
  }, {
    uuid: 'message-tools',
    type: 'assistant',
    timestamp: '2026-07-30T00:01:00.000Z',
    text: 'Reading files',
    content_type: 'text',
    is_meta: 0,
  }];
  const toolCalls = [{
    id: 'call-read',
    message_uuid: 'message-tools',
    name: 'Read',
    input_json: JSON.stringify({ file_path: '/tmp/csp-fixture/long.txt' }),
  }, {
    id: 'call-fetch',
    message_uuid: 'message-tools',
    name: 'WebFetch',
    input_json: JSON.stringify({ prompt: `Summarize ${'the long prompt '.repeat(12)}` }),
  }];
  const toolResults = [{
    tool_use_id: 'call-read',
    message_uuid: 'message-tools',
    content: Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n'),
    is_error: 0,
  }, {
    tool_use_id: 'call-fetch',
    message_uuid: 'message-tools',
    content: 'fetched',
    is_error: 0,
  }];
  const summary = {
    id: sessionId,
    title: 'CSP session',
    project: 'csp-fixture',
    project_path: '/tmp/csp-fixture',
    source: 'claude',
    started_at: '2026-07-30T00:00:00.000Z',
    ended_at: '2026-07-30T00:05:00.000Z',
    message_count: messages.length,
    git_branch: 'main',
  };
  ipcMain.handle('db:getSessions', () => [summary]);
  ipcMain.handle('db:getSessionCatalogue', (_event, opts) => ({
    rows: opts.quiet || opts.offset ? [] : [summary], total: opts.quiet ? 0 : 1,
  }));
  ipcMain.handle('db:getSessionMessages', () => messages);
  ipcMain.handle('db:getSessionToolCalls', () => toolCalls);
  ipcMain.handle('db:getSessionToolResults', () => toolResults);
  ipcMain.handle('db:getSessionSubagents', () => []);
  ipcMain.handle('db:getSessionWorkflows', () => []);
  ipcMain.handle('db:getSessionSummaries', () => []);
  ipcMain.handle('db:getMemories', () => []);
  ipcMain.handle('db:getProjects', () => [{ project: 'csp-fixture', session_count: 1 }]);
  ipcMain.handle('db:getStats', () => ({ sessions: 1 }));
  ipcMain.handle('settings:get', () => ({}));
}

async function run() {
  const { server, baseUrl, requests } = await startServer();
  const dir = mkdtempSync(join(tmpdir(), 'obelisk-csp-'));
  const localImagePath = join(dir, 'local.svg');
  writeFileSync(localImagePath, svg);
  let win = null;
  try {
    registerHandlers({ baseUrl, localImageUrl: pathToFileURL(localImagePath).href });
    win = new BrowserWindow({
      show: true,
      width: 1200,
      height: 900,
      webPreferences: {
        preload: join(appRoot, 'out', 'preload', 'index.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    // Chromium reports every CSP violation on the console from the first
    // byte, before any page listener could be installed.
    const cspMessages = [];
    win.webContents.on('console-message', event => {
      if (/Content Security Policy/i.test(event.message)) cspMessages.push(event.message);
    });

    await win.loadFile(join(appRoot, 'out', 'renderer', 'index.html'), { hash: '/sessions' });
    const policy = await win.webContents.executeJavaScript(
      `document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? ''`,
      true,
    );
    assert(/script-src 'self'(;|$)/.test(policy), `the built page carries the policy (${policy})`);
    await win.webContents.executeJavaScript(`(() => {
      window.__violations = [];
      document.addEventListener('securitypolicyviolation', event => {
        window.__violations.push(event.effectiveDirective + ' ' + (event.blockedURI || ''));
      });
    })()`, true);
    await waitFor(win.webContents, `document.body.textContent.includes('CSP session')`, 'session list');

    // Normal use: every route, a session with remote, file: and data: images,
    // and the tool output toggles.
    for (const route of ['/memory', '/activity', '/recap', '/settings', '/sessions']) {
      await win.webContents.executeJavaScript(`window.location.hash = ${JSON.stringify(route)}`, true);
      await delay(300);
    }
    await win.webContents.executeJavaScript(`window.location.hash = ${JSON.stringify(`/sessions/${sessionId}`)}`, true);
    await waitFor(
      win.webContents,
      `[...document.querySelectorAll('[data-uuid="message-images"] obelisk-session-image')]
        .filter(host => host.shadowRoot?.querySelector('.is-loaded')).length === 3`,
      'remote, local and data images loaded',
    );
    await win.webContents.executeJavaScript(`(() => {
      for (const toggle of document.querySelectorAll('[data-uuid="message-tools"] .toolcall-toggle')) toggle.click();
    })()`, true);
    await waitFor(win.webContents, `document.querySelector('.file-content-expand')`, 'collapsed Read output');
    const toggles = await win.webContents.executeJavaScript(`(async () => {
      const expand = document.querySelector('.file-content-expand');
      const body = expand.previousElementSibling;
      const long = document.querySelector('.lit-string-long');
      const before = { collapsed: body.classList.contains('collapsed'), label: expand.textContent, open: long.classList.contains('open') };
      expand.click();
      long.querySelector('.more-btn').click();
      const expanded = { collapsed: body.classList.contains('collapsed'), label: expand.textContent, open: long.classList.contains('open') };
      expand.click();
      return { before, expanded, collapsedAgain: { collapsed: body.classList.contains('collapsed'), label: expand.textContent } };
    })()`, true);
    assert(
      toggles.before.collapsed && toggles.before.label === 'Show all 30 lines'
        && !toggles.expanded.collapsed && toggles.expanded.label === 'Collapse'
        && toggles.collapsedAgain.collapsed && toggles.collapsedAgain.label === 'Show all 30 lines',
      `long tool output expands and collapses (${JSON.stringify(toggles)})`,
    );
    assert(!toggles.before.open && toggles.expanded.open, 'a long string literal expands');
    await delay(200);
    const normalUse = await win.webContents.executeJavaScript('window.__violations.slice()', true);
    assert(normalUse.length === 0, `normal use raises no CSP violation (${normalUse.join(', ')})`);
    assert(cspMessages.length === 0, `no CSP message on the console during normal use (${cspMessages.join(' | ')})`);

    // Script the app did not ship.
    const blocked = await win.webContents.executeJavaScript(`(async () => {
      const inline = document.createElement('script');
      inline.textContent = 'window.__inlineScript = true';
      document.head.append(inline);

      const remote = document.createElement('script');
      const remoteSettled = new Promise(resolve => {
        remote.onload = () => resolve('load');
        remote.onerror = () => resolve('error');
      });
      remote.src = ${JSON.stringify(`${baseUrl}/remote.js`)};
      document.head.append(remote);

      const handler = document.createElement('button');
      handler.setAttribute('onclick', 'window.__inlineHandler = true');
      document.body.append(handler);
      handler.click();
      handler.remove();

      let evalBlocked = false;
      try { new Function('return 1')(); } catch (error) { evalBlocked = error instanceof EvalError; }

      const remoteResult = await remoteSettled;
      await new Promise(resolve => setTimeout(resolve, 100));
      return {
        inlineScript: window.__inlineScript ?? false,
        remoteScript: window.__remoteScript ?? false,
        remoteResult,
        inlineHandler: window.__inlineHandler ?? false,
        evalBlocked,
        violations: window.__violations.slice(),
      };
    })()`, true);
    assert(blocked.inlineScript === false, 'an inline <script> does not run');
    assert(blocked.remoteScript === false && blocked.remoteResult === 'error', `a remote <script> does not run (${blocked.remoteResult})`);
    assert(!requests.includes('/remote.js'), 'a remote <script> is never fetched');
    assert(blocked.inlineHandler === false, 'an inline event handler does not run');
    assert(blocked.evalBlocked, 'eval-like code generation is blocked');
    const directives = blocked.violations.map(entry => entry.split(' ')[0]);
    assert(
      ['script-src-elem', 'script-src-attr', 'script-src'].every(directive => directives.includes(directive)),
      `each blocked attempt reports a violation (${blocked.violations.join(', ')})`,
    );
    assert(cspMessages.length > 0, `the console reports them too, so the normal-use console check can fail (${cspMessages.length})`);
  } finally {
    win?.destroy();
    rmSync(dir, { recursive: true, force: true });
    await new Promise(resolve => server.close(resolve));
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
