import { app, BrowserWindow, ipcMain } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const codexSessionId = 'codex:019f6392-0dba-7f13-be12-541db3645a69';
const providerNeutralSessionId = 'claude-session-id';
const untitledSessionId = 'codex:untitled-session';
const missingSessionId = 'codex:00000000-0000-0000-0000-000000000000';
const fencedOnlySessionId = 'codex:fenced-code-only';
const memoryId = 'memory-session-links';
const memoryMarkdown = `# Linked memory

The implementation came from \`${codexSessionId}\`.

Another provider can work without a renderer format rule: \`${providerNeutralSessionId}\`.

An untitled session keeps its exact identity visible: \`${untitledSessionId}\`.

An unknown value stays code: \`${missingSessionId}\`.

Ordinary inline code also stays code: \`npm test\`.

~~~text
${fencedOnlySessionId}
~~~
`;

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
  'db:readMemoryFile',
  'db:getProjects',
  'db:getStats',
  'settings:get',
];

let failures = 0;
let exactLookupIds = [];

const sessions = [
  {
    id: codexSessionId,
    title: 'MR review session',
    project: 'tcode',
    project_path: '/tmp/tcode',
    source: 'codex',
    started_at: '2026-07-15T02:19:04.014Z',
    ended_at: '2026-07-15T03:00:00.000Z',
    message_count: 1,
    git_branch: 'main',
  },
  {
    id: providerNeutralSessionId,
    title: 'Provider-neutral session',
    project: 'tcode',
    project_path: '/tmp/tcode',
    source: 'claude',
    started_at: '2026-07-14T02:19:04.014Z',
    ended_at: '2026-07-14T03:00:00.000Z',
    message_count: 1,
    git_branch: 'main',
  },
  {
    id: untitledSessionId,
    title: null,
    project: 'tcode',
    project_path: '/tmp/tcode',
    source: 'codex',
    started_at: '2026-07-13T02:19:04.014Z',
    ended_at: '2026-07-13T03:00:00.000Z',
    message_count: 1,
    git_branch: 'main',
  },
];

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
  ipcMain.handle('db:getSessions', (_event, opts = {}) => {
    if (!Array.isArray(opts.ids)) return sessions;
    exactLookupIds = [...opts.ids];
    return sessions.filter(session => opts.ids.includes(session.id));
  });
  ipcMain.handle('db:getSessionMessages', (_event, sessionId) => [{
    uuid: `${sessionId}:000001`,
    session_id: sessionId,
    type: 'assistant',
    role: 'assistant',
    timestamp: '2026-07-15T02:20:00.000Z',
    text: 'Linked session detail',
    content_type: 'text',
    is_meta: 0,
  }]);
  ipcMain.handle('db:getSessionToolCalls', () => []);
  ipcMain.handle('db:getSessionToolResults', () => []);
  ipcMain.handle('db:getSessionSubagents', () => []);
  ipcMain.handle('db:getSessionWorkflows', () => []);
  ipcMain.handle('db:getSessionPatch', () => null);
  ipcMain.handle('db:getSessionSummaries', () => []);
  ipcMain.handle('db:getMessageFullText', () => null);
  ipcMain.handle('db:getMemories', () => [{
    id: memoryId,
    session_id: codexSessionId,
    project: 'tcode',
    message_start: null,
    message_end: null,
    path: '/tmp/linked-memory.md',
    anchors: null,
    summary: 'A Memory containing inline-code session IDs.',
    created_at: '2026-07-30T04:55:28.011Z',
    deleted_at: null,
    deleted_reason: null,
  }]);
  ipcMain.handle('db:readMemoryFile', () => memoryMarkdown);
  ipcMain.handle('db:getProjects', () => [{ project: 'tcode', count: 1 }]);
  ipcMain.handle('db:getStats', () => ({}));
  ipcMain.handle('settings:get', () => ({}));
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

  await win.loadFile(join(appRoot, 'out', 'renderer', 'index.html'), {
    hash: `/memory/${memoryId}`,
  });
  await waitFor(
    win.webContents,
    `document.querySelectorAll('.markdown-session-link').length === 3`,
    'resolved inline-code sessions',
  );

  const rendered = await win.webContents.executeJavaScript(`(() => {
    const links = [...document.querySelectorAll('.markdown-session-link')];
    const inlineCodes = [...document.querySelectorAll('.markdown-body code')]
      .filter(node => !node.closest('pre'))
      .map(node => node.textContent.trim());
    const fencedCodes = [...document.querySelectorAll('.markdown-body pre code')]
      .map(node => node.textContent.trim());
    return {
      linkIds: links.map(link => link.dataset.sessionId),
      linkTexts: links.map(link => link.textContent.trim()),
      hoverTitles: links.map(link => link.title),
      ariaLabels: links.map(link => link.getAttribute('aria-label')),
      linkTags: links.map(link => link.tagName),
      allReuseSessionStyle: links.every(link => link.classList.contains('session-link')),
      allHaveIcons: links.every(link => Boolean(link.querySelector('svg'))),
      headerLink: (() => {
        const link = document.querySelector('.detail-meta .session-link');
        return link && {
          text: link.textContent.trim(),
          title: link.title,
          ariaLabel: link.getAttribute('aria-label'),
        };
      })(),
      inlineCodes,
      fencedCodes,
    };
  })()`, true);

  assert(
    JSON.stringify(rendered.linkIds) === JSON.stringify([codexSessionId, providerNeutralSessionId, untitledSessionId]),
    `only exact DB matches become links (${JSON.stringify(rendered)})`,
  );
  assert(rendered.linkTexts.includes('MR review session'), 'resolved link displays the human-readable session title');
  assert(rendered.linkTexts.includes('Provider-neutral session'), 'linking does not assume a provider-specific ID shape');
  assert(rendered.linkTexts.includes(untitledSessionId), 'untitled session falls back to its full ID');
  assert(
    JSON.stringify(rendered.hoverTitles) === JSON.stringify(rendered.linkIds.map(id => `Session ID: ${id}`)),
    'native hover text exposes the exact session ID',
  );
  assert(
    JSON.stringify(rendered.ariaLabels) === JSON.stringify([
      'Open session: MR review session',
      'Open session: Provider-neutral session',
      `Open session: ${untitledSessionId}`,
    ]),
    'session buttons have meaningful accessible labels',
  );
  assert(
    rendered.headerLink?.text === 'MR review session'
      && rendered.headerLink?.title === `Session ID: ${codexSessionId}`
      && rendered.headerLink?.ariaLabel === 'Open session: MR review session',
    'Memory header and body session links share title-first labels and UUID hover text',
  );
  assert(rendered.linkTags.every(tag => tag === 'BUTTON'), 'resolved references use internal navigation buttons');
  assert(rendered.allReuseSessionStyle && rendered.allHaveIcons, 'links reuse the existing session-link visual language');
  assert(rendered.inlineCodes.includes(missingSessionId), 'unknown session ID remains ordinary inline code');
  assert(rendered.inlineCodes.includes('npm test'), 'unrelated inline code remains ordinary code');
  assert(rendered.fencedCodes.includes(fencedOnlySessionId), 'session ID inside a fenced block remains code');
  assert(exactLookupIds.includes(missingSessionId) && exactLookupIds.includes('npm test'), 'the DB lookup, not a format regex, decides which candidates resolve');
  assert(!exactLookupIds.includes(fencedOnlySessionId), 'fenced code is excluded from exact lookup candidates');

  await win.webContents.executeJavaScript(
    `document.querySelector('.markdown-session-link').click()`,
    true,
  );
  await waitFor(
    win.webContents,
    `window.location.hash.includes('/sessions/') && document.body.textContent.includes('Linked session detail')`,
    'internal Session Detail navigation',
  );
  const route = await win.webContents.executeJavaScript('window.location.hash', true);
  assert(decodeURIComponent(route).includes(codexSessionId), `click opens the requested session inside Obelisk (${route})`);

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
