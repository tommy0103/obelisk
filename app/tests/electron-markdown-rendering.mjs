// Renders transcript Markdown through the built renderer: real formatting
// survives, and markup that would run script is gone before it reaches the DOM.

import { app, BrowserWindow, ipcMain } from 'electron';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const sessionId = 'markdown-rendering';
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
const dataSvg = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

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
  return new Promise(resolve => {
    const server = createServer((request, response) => {
      if (request.url === '/remote.svg') {
        response.writeHead(200, { 'Content-Type': 'image/svg+xml' });
        response.end(svg);
        return;
      }
      response.writeHead(404);
      response.end();
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

// Each payload, if it ran, would set window.__xss to its own name.
const payloads = {
  script: '<script>window.__xss = "script"</script>',
  doubleQuotedHandler: '<img src="missing.png" onerror="window.__xss = \'doubleQuotedHandler\'">',
  singleQuotedHandler: "<img src='missing.png' onerror='window.__xss = \"singleQuotedHandler\"'>",
  unquotedHandler: '<img src=missing.png onerror=window.__xss=1>',
  svgOnload: '<svg onload="window.__xss = \'svgOnload\'"><rect width="1" height="1"/></svg>',
  detailsToggle: '<details open ontoggle="window.__xss = \'detailsToggle\'"><summary>s</summary>x</details>',
  iframe: '<iframe srcdoc="<script>parent.__xss = \'iframe\'</script>"></iframe>',
  objectData: '<object data="data:text/html,<script>parent.__xss=1</script>"></object>',
  // void: a javascript: URL that yields a string replaces the whole document.
  javascriptLink: '[click me](javascript:void(window.__xss="javascriptLink"))',
  rawJavascriptLink: '<a href="javascript:void(window.__xss=\'rawJavascriptLink\')">raw click</a>',
  sessionImageSource: '<obelisk-session-image src="javascript:window.__xss=1" alt="forged"></obelisk-session-image>',
  style: '<style>.virtual-timeline-row { display: none !important; }</style>',
};

function buildMessages({ baseUrl, localImageUrl }) {
  const markdown = [
    '## Heading two',
    '',
    'Some **bold**, _emphasis_, `inline code` and a [docs link](https://example.com/docs).',
    '',
    '- [x] done task',
    '- [ ] open task',
    '',
    '| col a | col b |',
    '| ----- | ----- |',
    '| 1     | 2     |',
    '',
    '```js',
    'const answer = 42;',
    '```',
    '',
    '> quoted',
    '',
    `![Remote image](${baseUrl}/remote.svg)`,
    '',
    `![Local image](${localImageUrl})`,
    '',
    `![Data image](${dataSvg})`,
  ].join('\n');
  return [
    {
      uuid: 'message-formatting',
      type: 'assistant',
      timestamp: '2026-07-30T00:00:00.000Z',
      text: markdown,
      content_type: 'text',
      is_meta: 0,
    },
    ...Object.entries(payloads).map(([name, payload], index) => ({
      uuid: `message-payload-${name}`,
      type: index % 2 ? 'user' : 'assistant',
      timestamp: new Date(Date.UTC(2026, 6, 30, 0, index + 1)).toISOString(),
      text: `Payload ${name}\n\n${payload}`,
      content_type: 'text',
      is_meta: 0,
    })),
  ];
}

function registerHandlers(messages) {
  const summary = {
    id: sessionId,
    title: 'Markdown rendering',
    project: 'markdown-fixture',
    project_path: '/tmp/markdown-fixture',
    source: 'codex',
    started_at: '2026-07-30T00:00:00.000Z',
    ended_at: '2026-07-30T00:30:00.000Z',
    message_count: messages.length,
    git_branch: 'main',
  };
  ipcMain.handle('db:getSessions', () => [summary]);
  ipcMain.handle('db:getSessionCatalogue', (_event, opts) => ({
    rows: opts.quiet || opts.offset ? [] : [summary], total: opts.quiet ? 0 : 1,
  }));
  ipcMain.handle('db:getSessionMessages', () => messages);
  ipcMain.handle('db:getSessionToolCalls', () => []);
  ipcMain.handle('db:getSessionToolResults', () => []);
  ipcMain.handle('db:getSessionSubagents', () => []);
  ipcMain.handle('db:getSessionWorkflows', () => []);
  ipcMain.handle('db:getSessionSummaries', () => []);
  ipcMain.handle('db:getMemories', () => []);
  ipcMain.handle('db:getProjects', () => [{ project: 'markdown-fixture', session_count: 1 }]);
  ipcMain.handle('db:getStats', () => ({ sessions: 1 }));
  ipcMain.handle('settings:get', () => ({}));
}

async function run() {
  const { server, baseUrl } = await startServer();
  const dir = mkdtempSync(join(tmpdir(), 'obelisk-markdown-'));
  const localImagePath = join(dir, 'local.svg');
  writeFileSync(localImagePath, svg);
  const messages = buildMessages({ baseUrl, localImageUrl: pathToFileURL(localImagePath).href });
  let win = null;
  try {
    registerHandlers(messages);
    win = new BrowserWindow({
      show: true,
      width: 1200,
      height: 4000,
      webPreferences: {
        preload: join(appRoot, 'out', 'preload', 'index.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const navigations = [];
    win.webContents.on('will-navigate', (event, url) => {
      navigations.push(url);
      event.preventDefault();
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      navigations.push(url);
      return { action: 'deny' };
    });

    await win.loadFile(join(appRoot, 'out', 'renderer', 'index.html'), { hash: '/sessions' });
    await waitFor(win.webContents, `document.body.textContent.includes('Markdown rendering')`, 'session list');
    await win.webContents.executeJavaScript(`window.location.hash = ${JSON.stringify(`/sessions/${sessionId}`)}`, true);
    await waitFor(
      win.webContents,
      `document.querySelectorAll('[data-uuid^="message-"]').length === ${messages.length}`,
      'every message row mounted',
    );
    await waitFor(
      win.webContents,
      `[...document.querySelectorAll('[data-uuid="message-formatting"] obelisk-session-image')]
        .every(host => host.shadowRoot?.querySelector('.is-loaded'))`,
      'remote, local and data images loaded',
    );

    const formatting = await win.webContents.executeJavaScript(`(() => {
      const root = document.querySelector('[data-uuid="message-formatting"]');
      return {
        heading: root.querySelector('h2')?.textContent,
        bold: root.querySelector('strong')?.textContent,
        emphasis: root.querySelector('em')?.textContent,
        inlineCode: root.querySelector('p code')?.textContent,
        link: root.querySelector('a[href="https://example.com/docs"]')?.textContent,
        tasks: [...root.querySelectorAll('li input[type="checkbox"]')].map(box => box.checked),
        tableCells: [...root.querySelectorAll('table td')].map(cell => cell.textContent.trim()),
        codeBlock: root.querySelector('pre code')?.textContent,
        quote: root.querySelector('blockquote')?.textContent.trim(),
        images: [...root.querySelectorAll('obelisk-session-image')].map(host => ({
          src: host.getAttribute('src'),
          alt: host.getAttribute('alt'),
          loaded: Boolean(host.shadowRoot?.querySelector('.is-loaded')),
        })),
      };
    })()`, true);
    assert(formatting.heading === 'Heading two', 'heading renders');
    assert(formatting.bold === 'bold' && formatting.emphasis === 'emphasis', 'bold and emphasis render');
    assert(formatting.inlineCode === 'inline code', 'inline code renders');
    assert(formatting.link === 'docs link', 'https link keeps its href');
    assert(JSON.stringify(formatting.tasks) === '[true,false]', `task list renders checkboxes (${JSON.stringify(formatting.tasks)})`);
    assert(JSON.stringify(formatting.tableCells) === '["1","2"]', `GFM table renders (${JSON.stringify(formatting.tableCells)})`);
    assert(formatting.codeBlock === 'const answer = 42;\n', 'fenced code block renders');
    assert(formatting.quote === 'quoted', 'blockquote renders');
    assert(
      formatting.images.length === 3 && formatting.images.every(image => image.src && image.loaded),
      `remote, file: and data: images keep their source and load (${JSON.stringify(formatting.images)})`,
    );

    // Give handlers that would fire on load or error a chance to run, then
    // click every link a payload could have planted.
    await delay(500);
    await win.webContents.executeJavaScript(`(() => {
      for (const link of document.querySelectorAll('[data-uuid^="message-payload-"] a')) link.click();
    })()`, true);
    await delay(300);

    const residue = await win.webContents.executeJavaScript(`(() => {
      const rows = [...document.querySelectorAll('[data-uuid^="message-payload-"]')];
      const elements = rows.flatMap(row => [...row.querySelectorAll('*')]);
      return {
        xss: window.__xss ?? null,
        payloadTextVisible: rows.every(row => row.textContent.includes('Payload ')),
        handlerAttributes: elements.flatMap(el => [...el.attributes].filter(attr => /^on/i.test(attr.name)).map(attr => el.localName + '[' + attr.name + ']')),
        activeElements: elements.filter(el => ['script', 'iframe', 'object', 'embed', 'style'].includes(el.localName)).map(el => el.localName),
        javascriptUrls: elements.flatMap(el => ['href', 'src', 'data'].map(name => el.getAttribute(name)).filter(value => /^\\s*javascript:/i.test(value || ''))),
        timelineVisible: rows.length > 0 && getComputedStyle(rows[0]).display !== 'none',
      };
    })()`, true);
    assert(residue.xss === null, `no payload ran (window.__xss = ${JSON.stringify(residue.xss)})`);
    assert(residue.payloadTextVisible, 'payload messages still render their text');
    assert(residue.handlerAttributes.length === 0, `no inline handler survives (${residue.handlerAttributes.join(', ')})`);
    assert(residue.activeElements.length === 0, `no script, iframe, object, embed or style element survives (${residue.activeElements.join(', ')})`);
    assert(residue.javascriptUrls.length === 0, `no javascript: URL survives (${residue.javascriptUrls.join(', ')})`);
    assert(residue.timelineVisible, 'a payload <style> cannot restyle the app');
    assert(!navigations.some(url => /^javascript:/i.test(url)), `no javascript: navigation (${navigations.join(', ')})`);
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
