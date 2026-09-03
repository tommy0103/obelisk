// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { acquireWriterLease } from '../packages/core/src/writer-lease.ts';
import { makeTempDir } from './temp-dirs.mjs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

class SqliteCompatDatabase {
  constructor(dbFile) {
    this.db = new DatabaseSync(dbFile);
  }
  pragma(statement) { this.db.exec(`PRAGMA ${statement}`); }
  exec(sql) { return this.db.exec(sql); }
  close() { return this.db.close(); }
  prepare(sql) {
    const stmt = this.db.prepare(sql);
    return {
      all: (...params) => stmt.all(...params),
      get: (...params) => stmt.get(...params),
      run: (...params) => stmt.run(...params),
    };
  }
}

// The app main process is now an ES module. It runs side-effectfully on import
// (registers ipcMain handlers, opens windows, etc.) and has no exports, so we
// mock its ESM dependencies with node:test's `mock.module` and load it via a
// cache-busted dynamic import.
//
// `mock.module` keys mocks by the *resolved* module URL. The app's dependencies
// live in `app/node_modules`, so they are NOT resolvable from this test file's
// directory, and bare specifiers ('electron', ...) would either fail to resolve
// here or resolve to a different entry than the main module sees (a package's
// "exports" map can give ESM and CJS importers different files). We instead
// resolve each bare specifier exactly as the main module sees it (ESM resolution
// relative to the main module's directory) and mock that URL. Relative deps are
// resolved against the main module URL directly.
const mainUrl = new URL('../app/src/main/index.ts', import.meta.url);
const mainPath = fileURLToPath(mainUrl);
const mainDir = fileURLToPath(new URL('.', mainUrl));

function esmResolve(specifier) {
  return execFileSync(
    process.execPath,
    ['--input-type=module', '-e', `process.stdout.write(import.meta.resolve(${JSON.stringify(specifier)}))`],
    { cwd: mainDir, encoding: 'utf8' },
  ).trim();
}

const ELECTRON_URL = esmResolve('electron');
const DATABASE_URL = esmResolve('better-sqlite3');
const WATCHER_URL = new URL('../../../packages/adaptive-watcher/src/index.ts', mainUrl).href;
const INDEXER_URL = new URL('./indexer.ts', mainUrl).href;
const INDEXER_SERVICE_URL = new URL('./indexer-service.ts', mainUrl).href;
const INDEXER_WORKER_URL = new URL('./indexer-worker-client.ts', mainUrl).href;

let importCounter = 0;

// Registers the given [specifier, options] mocks and returns a restore fn.
function registerMocks(defs) {
  const contexts = defs.map(([spec, opts]) => mock.module(spec, opts));
  return () => {
    for (const ctx of contexts) ctx.restore();
    mock.reset();
  };
}

// Fresh evaluation of the main module every call (cache-busted query string).
async function importMain() {
  await import(`${mainUrl.href}?t=${++importCounter}-${Date.now()}`);
  await new Promise(resolve => setImmediate(resolve));
}

// Electron named-export namespace. ESM named imports are validated at load time,
// so every export the app imports ('app', 'BrowserWindow', 'ipcMain', 'clipboard',
// 'dialog', 'nativeImage', 'shell') must be present, even if unused by a test.
function electronNamespace({ app, BrowserWindow, ipcMain }) {
  return {
    app: app ?? { whenReady: () => Promise.resolve(), on() {}, quit() {} },
    BrowserWindow,
    ipcMain: ipcMain ?? { handle() {} },
    clipboard: {},
    dialog: {},
    nativeImage: {},
    shell: {},
  };
}

// Assigning undefined to process.env leaves the literal string "undefined"
// instead of removing the variable — restore must delete in that case.
function restoreEnvVar(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

// Captures app event handlers so a test can fire window-all-closed, which is
// what makes the main module close its database handle.
function captureAppHandlers(map) {
  return {
    whenReady: () => Promise.resolve(),
    on(event, handler) { map.set(event, handler); },
    quit() {},
  };
}

// Windows refuses to unlink an open SQLite file; fire window-all-closed and
// let the async close land before removing the temp home.
async function closeMainProcessDb(appHandlers) {
  appHandlers.get('window-all-closed')?.();
  await new Promise((resolve) => setTimeout(resolve, 50));
}

function noopWatcher() {
  return {
    createAdaptiveWatcher: () => ({
      close() { return Promise.resolve(); },
    }),
  };
}

function defaultIndexerService() {
  return {
    createIndexerService: () => ({
      start() {},
      stop() {},
      idle: async () => {},
      runBuildNow() { return Promise.resolve(); },
    }),
  };
}

function defaultIndexerWorkerClient() {
  return {
    createWorkerBuildIndex: () => ({
      buildIndex: async () => ({ files: 0, affectedSessionIds: [] }),
      stop() {},
    }),
  };
}

async function loadMainForWindowFlags(flags, { settingsText } = {}) {
  const originalArgv = process.argv;
  const originalHome = process.env.HOME;
  const originalProfile = process.env.USERPROFILE;
  const home = makeTempDir(`obelisk-window-flags-${Date.now()}-${Math.random()}`);
  mkdirSync(join(home, '.obelisk'), { recursive: true });
  writeFileSync(join(home, '.obelisk', 'obelisk.sqlite'), '');
  if (settingsText !== undefined) {
    writeFileSync(join(home, '.obelisk', 'settings.json'), settingsText);
  }
  process.env.HOME = home;
  process.env.USERPROFILE = home; // os.homedir() reads USERPROFILE on Windows
  process.argv = [originalArgv[0] || 'node', originalArgv[1] || 'electron', ...flags];

  const windows = [];

  class FakeDatabase {
    pragma() {}
    exec() {}
    close() {}
    prepare() {
      return { get: () => null, all: () => [], run: () => ({}) };
    }
  }

  class FakeBrowserWindow {
    constructor(options) {
      this.options = options;
      this.loadedURL = null;
      this.loadedFile = null;
      this.devToolsOpened = false;
      this.webContents = {
        on() {},
        setWindowOpenHandler() {},
        getURL() { return ''; },
        setZoomLevel() {},
        openDevTools: () => { this.devToolsOpened = true; },
        send() {},
      };
      windows.push(this);
    }
    loadFile(filePath) { this.loadedFile = filePath; }
    loadURL(url) { this.loadedURL = url; return Promise.resolve(); }
    close() {}
    static getAllWindows() { return windows; }
    static fromWebContents() { return null; }
  }

  const restore = registerMocks([
    [ELECTRON_URL, { namedExports: electronNamespace({ BrowserWindow: FakeBrowserWindow }) }],
    [DATABASE_URL, { defaultExport: FakeDatabase }],
    [WATCHER_URL, { namedExports: noopWatcher() }],
    [INDEXER_URL, { namedExports: { writeHeartbeat() {} } }],
    [INDEXER_SERVICE_URL, { namedExports: defaultIndexerService() }],
    [INDEXER_WORKER_URL, { namedExports: defaultIndexerWorkerClient() }],
  ]);

  try {
    await importMain();
    return windows;
  } finally {
    restore();
    process.argv = originalArgv;
    restoreEnvVar('HOME', originalHome);
    restoreEnvVar('USERPROFILE', originalProfile);
    rmSync(home, { recursive: true, force: true });
  }
}

test('dev mode does not open DevTools unless explicitly requested', async () => {
  const packagedWindows = await loadMainForWindowFlags([]);
  assert.equal(packagedWindows.length, 1);
  assert.equal(packagedWindows[0].loadedURL, null);
  assert.equal(packagedWindows[0].options.webPreferences.devTools, false);
  assert.equal(packagedWindows[0].devToolsOpened, false);

  const devWindows = await loadMainForWindowFlags(['--dev']);
  assert.equal(devWindows.length, 1);
  assert.equal(devWindows[0].loadedURL, 'http://localhost:5173');
  assert.equal(devWindows[0].options.webPreferences.devTools, true);
  assert.equal(devWindows[0].devToolsOpened, false);

  const devtoolsWindows = await loadMainForWindowFlags(['--dev', '--devtools']);
  assert.equal(devtoolsWindows.length, 1);
  assert.equal(devtoolsWindows[0].loadedURL, 'http://localhost:5173');
  assert.equal(devtoolsWindows[0].devToolsOpened, true);
});

test('malformed settings keep the desktop recovery window available', async () => {
  const windows = await loadMainForWindowFlags([], { settingsText: '{broken' });
  assert.equal(windows.length, 1);
});

test('main process watches every root declared by the built-in provider registry', async () => {
  const originalHome = process.env.HOME;
  const originalProfile = process.env.USERPROFILE;
  const home = makeTempDir(`obelisk-main-watch-dirs-${Date.now()}`);
  const claudeDir = join(home, '.claude');
  const codexDir = join(home, '.codex');
  mkdirSync(join(claudeDir, 'projects'), { recursive: true });
  mkdirSync(join(codexDir, 'sessions'), { recursive: true });
  mkdirSync(join(home, '.kimi-code', 'sessions'), { recursive: true });
  mkdirSync(join(home, '.obelisk'), { recursive: true });
  writeFileSync(join(home, '.obelisk', 'obelisk.sqlite'), '');
  process.env.HOME = home;
  process.env.USERPROFILE = home; // os.homedir() reads USERPROFILE on Windows

  const serviceOptions = [];
  const workerCalls = [];

  class FakeDatabase {
    pragma() {}
    exec() {}
    close() {}
    prepare() {
      return { get: () => null, all: () => [], run: () => ({}) };
    }
  }

  class FakeBrowserWindow {
    constructor() {
      this.webContents = { on() {}, setWindowOpenHandler() {}, getURL() { return ''; }, setZoomLevel() {}, openDevTools() {}, send() {} };
    }
    loadFile() {}
    loadURL() {}
    close() {}
    static getAllWindows() { return []; }
    static fromWebContents() { return null; }
  }

  const restore = registerMocks([
    [ELECTRON_URL, { namedExports: electronNamespace({ BrowserWindow: FakeBrowserWindow }) }],
    [DATABASE_URL, { defaultExport: FakeDatabase }],
    [WATCHER_URL, { namedExports: noopWatcher() }],
    [INDEXER_URL, { namedExports: { writeHeartbeat() {} } }],
    [INDEXER_SERVICE_URL, {
      namedExports: {
        createIndexerService: (options) => {
          serviceOptions.push(options);
          return {
            start() {},
            stop() {},
            idle: async () => {},
            runBuildNow() { return Promise.resolve(); },
          };
        },
      },
    }],
    [INDEXER_WORKER_URL, {
      namedExports: {
        createWorkerBuildIndex: () => ({
          buildIndex: async (args) => {
            workerCalls.push(args);
            return { files: 0, affectedSessionIds: [], complete: true };
          },
          stop() {},
        }),
      },
    }],
  ]);

  try {
    await importMain();

    assert.equal(serviceOptions.length, 1);
    assert.deepEqual(serviceOptions[0].watchTargets, [
      { kind: 'tree', path: join(claudeDir, 'projects') },
      { kind: 'file', path: join(claudeDir, 'history.jsonl') },
      { kind: 'tree', path: join(codexDir, 'sessions') },
      { kind: 'tree', path: join(codexDir, 'archived_sessions') },
      { kind: 'file', path: join(codexDir, 'session_index.jsonl') },
      { kind: 'tree', path: join(home, '.dsh', 'sessions') },
      { kind: 'tree', path: join(home, '.kimi-code', 'sessions') },
      { kind: 'file', path: join(home, '.kimi-code', 'session_index.jsonl') },
      { kind: 'tree', path: join(home, '.omp', 'agent', 'sessions') },
      { kind: 'tree', path: join(home, '.pi', 'agent', 'sessions') },
    ]);
    assert.equal(serviceOptions[0].watchTargets.some((t) => t.path === codexDir), false);
    await serviceOptions[0].buildIndex({ reason: 'settings-transfer' });
    assert.deepEqual(workerCalls[0].providerSettings, {});
  } finally {
    restore();
    restoreEnvVar('HOME', originalHome);
    restoreEnvVar('USERPROFILE', originalProfile);
    rmSync(home, { recursive: true, force: true });
  }
});

test('main process forwards committed IDs without reopening after a deferred build', async () => {
  const originalHome = process.env.HOME;
  const originalProfile = process.env.USERPROFILE;
  const home = makeTempDir(`obelisk-main-deferred-build-${Date.now()}`);
  mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
  mkdirSync(join(home, '.codex', 'sessions'), { recursive: true });
  mkdirSync(join(home, '.obelisk'), { recursive: true });
  writeFileSync(join(home, '.obelisk', 'obelisk.sqlite'), '');
  process.env.HOME = home;
  process.env.USERPROFILE = home; // os.homedir() reads USERPROFILE on Windows

  let databaseOpens = 0;
  let serviceOptions;
  let notifications = 0;
  const sent = [];

  class FakeDatabase {
    constructor() { databaseOpens += 1; }
    pragma() {}
    exec() {}
    close() {}
    prepare() { return { get: () => null, all: () => [], run: () => ({}) }; }
  }

  class FakeBrowserWindow {
    constructor() {
      this.webContents = { on() {}, setWindowOpenHandler() {}, getURL() { return ''; }, setZoomLevel() {}, openDevTools() {}, send() { notifications += 1; } };
    }
    loadFile() {}
    loadURL() {}
    close() {}
    static getAllWindows() {
      return [{
        webContents: {
          send(channel, payload) {
            notifications += 1;
            sent.push({ channel, payload });
          },
        },
      }];
    }
    static fromWebContents() { return null; }
  }

  const restore = registerMocks([
    [ELECTRON_URL, { namedExports: electronNamespace({ BrowserWindow: FakeBrowserWindow }) }],
    [DATABASE_URL, { defaultExport: FakeDatabase }],
    [WATCHER_URL, { namedExports: noopWatcher() }],
    [INDEXER_URL, { namedExports: { writeHeartbeat() {} } }],
    [INDEXER_SERVICE_URL, {
      namedExports: {
        createIndexerService: (options) => {
          serviceOptions = options;
          return { start() {}, stop() {}, idle: async () => {}, runBuildNow() { return Promise.resolve(); } };
        },
      },
    }],
    [INDEXER_WORKER_URL, {
      namedExports: {
        createWorkerBuildIndex: () => ({
          buildIndex: async ({ reason }) => reason === 'inventory'
            ? {
                deferred: true,
                complete: false,
                reason: 'database_busy',
                affectedSessionIds: [],
                inventoryIssues: [{
                  provider: 'pi',
                  path: '/tmp/pi/locked',
                  error: 'EACCES: permission denied',
                }],
              }
            : { deferred: true, reason: 'database_busy', affectedSessionIds: ['session-1'] },
          stop() {},
        }),
      },
    }],
  ]);

  try {
    await importMain();
    const opensBeforeBuild = databaseOpens;
    const notificationsBeforeBuild = notifications;
    const result = await serviceOptions.buildIndex({ reason: 'writer-lease' });

    assert.equal(result.deferred, true);
    assert.equal(databaseOpens, opensBeforeBuild);
    assert.equal(notifications, notificationsBeforeBuild + 2);

    const beforeInventoryNotification = notifications;
    await serviceOptions.buildIndex({ reason: 'inventory' });
    assert.equal(databaseOpens, opensBeforeBuild);
    assert.equal(notifications, beforeInventoryNotification + 1);
    assert.deepEqual(sent.at(-1), {
      channel: 'obelisk:index-updated',
      payload: {
        affectedSessionIds: [],
        sourceIssues: [{
          provider: 'pi',
          path: '/tmp/pi/locked',
          error: 'EACCES: permission denied',
        }],
      },
    });
  } finally {
    restore();
    restoreEnvVar('HOME', originalHome);
    restoreEnvVar('USERPROFILE', originalProfile);
    rmSync(home, { recursive: true, force: true });
  }
});

test('session IPC hides Codex rows by default and supports explicit source opt-in', async () => {
  const originalHome = process.env.HOME;
  const originalProfile = process.env.USERPROFILE;
  const home = makeTempDir(`obelisk-main-source-filter-${Date.now()}`);
  mkdirSync(join(home, '.obelisk'), { recursive: true });
  writeFileSync(join(home, '.obelisk', 'obelisk.sqlite'), '');
  process.env.HOME = home;
  process.env.USERPROFILE = home; // os.homedir() reads USERPROFILE on Windows

  const ipcHandlers = new Map();
  const queries = [];

  class FakeDatabase {
    pragma() {}
    exec() {}
    close() {}
    prepare(sql) {
      return {
        all: (...params) => {
          queries.push({ sql, params });
          return [];
        },
        get: (...params) => {
          queries.push({ sql, params });
          return null;
        },
        run: () => ({}),
      };
    }
  }

  class FakeBrowserWindow {
    constructor() {
      this.webContents = { on() {}, setWindowOpenHandler() {}, getURL() { return ''; }, setZoomLevel() {}, openDevTools() {}, send() {} };
    }
    loadFile() {}
    loadURL() {}
    close() {}
    static getAllWindows() { return []; }
    static fromWebContents() { return null; }
  }

  const restore = registerMocks([
    [ELECTRON_URL, {
      namedExports: electronNamespace({
        app: {
          whenReady: () => Promise.resolve(),
          on() {},
          quit() {},
          getVersion: () => '9.8.7-test',
        },
        BrowserWindow: FakeBrowserWindow,
        ipcMain: {
          handle(channel, handler) {
            ipcHandlers.set(channel, handler);
          },
        },
      }),
    }],
    [DATABASE_URL, { defaultExport: FakeDatabase }],
    [WATCHER_URL, { namedExports: noopWatcher() }],
    [INDEXER_URL, { namedExports: { writeHeartbeat() {} } }],
    [INDEXER_SERVICE_URL, { namedExports: defaultIndexerService() }],
    [INDEXER_WORKER_URL, { namedExports: defaultIndexerWorkerClient() }],
  ]);

  try {
    await importMain();

    ipcHandlers.get('db:getSessions')(null, {});
    assert.match(queries.at(-1).sql, /COALESCE\(source, 'claude'\) = 'claude'/);

    ipcHandlers.get('db:getProjects')(null, {});
    assert.match(queries.at(-1).sql, /COALESCE\(source, 'claude'\) = 'claude'/);

    ipcHandlers.get('db:getSessions')(null, { source: 'all' });
    assert.doesNotMatch(queries.at(-1).sql, /COALESCE\(source, 'claude'\) = 'claude'/);

    ipcHandlers.get('db:getSessions')(null, { source: 'codex' });
    assert.match(queries.at(-1).sql, /COALESCE\(source, 'claude'\) = \?/);
    assert.ok(queries.at(-1).params.includes('codex'));

    const settings = await ipcHandlers.get('settings:get')();
    assert.equal(settings.version, '9.8.7-test');
    assert.ok(
      queries.some(q => /GROUP BY COALESCE\(source, 'claude'\)/.test(q.sql)),
    );
  } finally {
    restore();
    restoreEnvVar('HOME', originalHome);
    restoreEnvVar('USERPROFILE', originalProfile);
    rmSync(home, { recursive: true, force: true });
  }
});

test('usage IPC aggregates normalized tokens across all indexed providers', async () => {
  const originalHome = process.env.HOME;
  const originalProfile = process.env.USERPROFILE;
  const home = makeTempDir(`obelisk-main-usage-${Date.now()}`);
  const obeliskDir = join(home, '.obelisk');
  mkdirSync(obeliskDir, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home; // os.homedir() reads USERPROFILE on Windows

  const dbPath = join(obeliskDir, 'obelisk.sqlite');
  const setup = new DatabaseSync(dbPath);
  setup.exec(readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8'));
  setup.prepare(`
    INSERT INTO messages (
      uuid, session_id, type, timestamp, role, text,
      input_tokens, output_tokens, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('claude-message', 'claude-session', 'assistant', '2026-07-10T10:00:00Z', 'assistant', 'ok', 60, 5, 'claude');
  setup.prepare(`
    INSERT INTO messages (
      uuid, session_id, type, timestamp, role, text,
      input_tokens, output_tokens, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('codex-message', 'codex:session', 'assistant', '2026-07-10T11:00:00Z', 'assistant', 'ok', 100, 10, 'codex');
  setup.prepare(`
    INSERT INTO messages (
      uuid, session_id, type, role, text,
      input_tokens, output_tokens, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('claude-undated-message', 'claude-session', 'assistant', 'assistant', 'ok', 7, 0, 'claude');
  setup.prepare('INSERT INTO sessions (id,source) VALUES (?,?)')
    .run('pi:session', 'pi');
  setup.prepare(`
    INSERT INTO summaries (
      id, session_id, timestamp, source, content, visibility, input_tokens, output_tokens
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('pi-summary', 'pi:session', '2026-07-10T12:00:00Z', 'pi:compaction', 'summary', 'inactive', 30, 5);
  setup.prepare(`
    INSERT INTO messages (
      uuid, session_id, type, role, text, timestamp, visibility, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('pi-hidden-main', 'pi:session', 'assistant', 'assistant', 'inactive main', '2026-07-10T12:01:00Z', 'inactive', 'pi');
  setup.prepare(`
    INSERT INTO messages (
      uuid, session_id, type, role, text, timestamp, visibility, source, agent_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('pi-hidden-agent', 'pi:session', 'assistant', 'assistant', 'inactive agent', '2026-07-10T12:02:00Z', 'inactive', 'pi', 'pi:hidden-agent');
  setup.prepare(`
    INSERT INTO messages (
      uuid, session_id, type, role, text, timestamp, visibility, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('pi-visible-main', 'pi:session', 'assistant', 'assistant', 'visible main', '2026-07-10T12:03:00Z', 'visible', 'pi');
  setup.prepare(`
    INSERT INTO messages (
      uuid, session_id, type, role, text, timestamp, visibility, source, agent_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('pi-visible-agent', 'pi:session', 'assistant', 'assistant', 'visible agent', '2026-07-10T12:04:00Z', 'visible', 'pi', 'pi:visible-agent');
  setup.prepare(`
    INSERT INTO tool_calls (id, message_uuid, session_id, name, input_json)
    VALUES (?, ?, ?, ?, ?)
  `).run('pi-hidden-main-call', 'pi-hidden-main', 'pi:session', 'read', '{"path":"secret"}');
  setup.prepare(`
    INSERT INTO tool_calls (id, message_uuid, session_id, name, input_json)
    VALUES (?, ?, ?, ?, ?)
  `).run('pi-hidden-agent-call', 'pi-hidden-agent', 'pi:session', 'read', '{"path":"secret"}');
  setup.prepare(`
    INSERT INTO tool_calls (id, message_uuid, session_id, name, input_json)
    VALUES (?, ?, ?, ?, ?)
  `).run('pi-visible-main-call', 'pi-visible-main', 'pi:session', 'read', '{"path":"main"}');
  setup.prepare(`
    INSERT INTO tool_calls (id, message_uuid, session_id, name, input_json)
    VALUES (?, ?, ?, ?, ?)
  `).run('pi-visible-agent-call', 'pi-visible-agent', 'pi:session', 'read', '{"path":"agent"}');
  setup.prepare(`
    INSERT INTO tool_results (tool_use_id, message_uuid, session_id, content)
    VALUES (?, ?, ?, ?)
  `).run('pi-hidden-main-call', 'pi-hidden-main', 'pi:session', 'hidden result');
  setup.prepare(`
    INSERT INTO tool_results (tool_use_id, message_uuid, session_id, content)
    VALUES (?, ?, ?, ?)
  `).run('pi-hidden-agent-call', 'pi-hidden-agent', 'pi:session', 'hidden result');
  setup.prepare(`
    INSERT INTO tool_results (tool_use_id, message_uuid, session_id, content)
    VALUES (?, ?, ?, ?)
  `).run('pi-visible-main-call', 'pi-visible-main', 'pi:session', 'main result');
  setup.prepare(`
    INSERT INTO tool_results (tool_use_id, message_uuid, session_id, content)
    VALUES (?, ?, ?, ?)
  `).run('pi-visible-agent-call', 'pi-visible-agent', 'pi:session', 'agent result');
  setup.close();

  const ipcHandlers = new Map();
  const appHandlers = new Map();

  class FakeBrowserWindow {
    constructor() {
      this.webContents = { on() {}, setWindowOpenHandler() {}, getURL() { return ''; }, setZoomLevel() {}, openDevTools() {}, send() {} };
    }
    loadFile() {}
    loadURL() {}
    close() {}
    static getAllWindows() { return []; }
    static fromWebContents() { return null; }
  }

  const restore = registerMocks([
    [ELECTRON_URL, {
      namedExports: electronNamespace({
        app: captureAppHandlers(appHandlers),
        BrowserWindow: FakeBrowserWindow,
        ipcMain: {
          handle(channel, handler) {
            ipcHandlers.set(channel, handler);
          },
        },
      }),
    }],
    [DATABASE_URL, { defaultExport: SqliteCompatDatabase }],
    [WATCHER_URL, { namedExports: noopWatcher() }],
    [INDEXER_URL, { namedExports: { writeHeartbeat() {} } }],
    [INDEXER_SERVICE_URL, { namedExports: defaultIndexerService() }],
    [INDEXER_WORKER_URL, { namedExports: defaultIndexerWorkerClient() }],
  ]);

  try {
    await importMain();

    assert.deepEqual(ipcHandlers.get('db:getSessionSummaries')(null, 'pi:session'), []);
    assert.deepEqual(
      ipcHandlers.get('db:getSessionMessages')(null, 'pi:session').map(row => row.uuid),
      ['pi-visible-main'],
    );
    assert.deepEqual(
      ipcHandlers.get('db:getSessionToolCalls')(null, 'pi:session').map(row => row.id),
      ['pi-visible-main-call'],
    );
    assert.deepEqual(
      ipcHandlers.get('db:getSessionToolResults')(null, 'pi:session').map(row => row.tool_use_id),
      ['pi-visible-main-call'],
    );
    assert.deepEqual(ipcHandlers.get('db:getSubagentMessages')(null, 'pi:hidden-agent'), []);
    assert.deepEqual(ipcHandlers.get('db:getSubagentToolCalls')(null, 'pi:hidden-agent'), []);
    assert.deepEqual(ipcHandlers.get('db:getSubagentToolResults')(null, 'pi:hidden-agent'), []);
    assert.deepEqual(
      ipcHandlers.get('db:getSubagentMessages')(null, 'pi:visible-agent').map(row => row.uuid),
      ['pi-visible-agent'],
    );
    assert.deepEqual(
      ipcHandlers.get('db:getSubagentToolCalls')(null, 'pi:visible-agent').map(row => row.id),
      ['pi-visible-agent-call'],
    );
    assert.deepEqual(
      ipcHandlers.get('db:getSubagentToolResults')(null, 'pi:visible-agent').map(row => row.tool_use_id),
      ['pi-visible-agent-call'],
    );
    const patch = ipcHandlers.get('db:getSessionPatch')(null, 'pi:session', {});
    assert.equal(patch.changes.messages[0].tool_calls[0].result.content, 'main result');
    assert.equal(JSON.stringify(patch).includes('agent result'), false);
    assert.equal(ipcHandlers.get('db:getMessageFullText')(null, 'pi-hidden-main'), null);

    const claudeOnly = ipcHandlers.get('db:getUsageStats')(null, {});
    assert.equal(claudeOnly.totalTokens, 72);
    assert.equal(claudeOnly.daily[0].tokens, 65);

    const allSources = ipcHandlers.get('db:getUsageStats')(null, { source: 'all' });
    assert.equal(allSources.totalTokens, 217);
    assert.equal(allSources.daily[0].tokens, 210);
    assert.equal(allSources.peakDay.tokens, 210);

    const piOnly = ipcHandlers.get('db:getUsageStats')(null, { source: 'pi' });
    assert.equal(piOnly.totalTokens, 35);
  } finally {
    restore();
    restoreEnvVar('HOME', originalHome);
    restoreEnvVar('USERPROFILE', originalProfile);
    await closeMainProcessDb(appHandlers);
    rmSync(home, { recursive: true, force: true });
  }
});

test('main process migrates an existing app database before source-filtered IPC queries', async () => {
  const originalHome = process.env.HOME;
  const originalProfile = process.env.USERPROFILE;
  const home = makeTempDir(`obelisk-main-db-migration-${Date.now()}`);
  const obeliskDir = join(home, '.obelisk');
  mkdirSync(obeliskDir, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home; // os.homedir() reads USERPROFILE on Windows

  const { DatabaseSync } = require('node:sqlite');
  const dbPath = join(obeliskDir, 'obelisk.sqlite');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, title TEXT, project TEXT, project_path TEXT,
      started_at TEXT, ended_at TEXT, git_branch TEXT, version TEXT,
      message_count INTEGER DEFAULT 0, jsonl_path TEXT
    );
    CREATE TABLE messages (
      uuid TEXT PRIMARY KEY, session_id TEXT, type TEXT, parent_uuid TEXT,
      timestamp TEXT, role TEXT, text TEXT, content_type TEXT,
      is_meta INTEGER DEFAULT 0, model TEXT,
      is_sidechain INTEGER DEFAULT 0, agent_id TEXT,
      input_tokens INTEGER, output_tokens INTEGER,
      cwd TEXT, skill TEXT, turn_duration_ms INTEGER
    );
    CREATE TABLE memories (
      id TEXT PRIMARY KEY, session_id TEXT, project TEXT,
      message_start TEXT, message_end TEXT,
      path TEXT, anchors TEXT, summary TEXT, created_at TEXT,
      deleted_at TEXT, deleted_reason TEXT
    );
    INSERT INTO sessions (id, title, project, started_at, message_count)
    VALUES ('legacy-session', 'Legacy session', 'quiet-zero', '2026-06-10T10:00:00Z', 1);
  `);
  legacy.close();

  const ipcHandlers = new Map();
  const appHandlers = new Map();

  class FakeBrowserWindow {
    constructor() {
      this.webContents = { on() {}, setWindowOpenHandler() {}, getURL() { return ''; }, setZoomLevel() {}, openDevTools() {}, send() {} };
    }
    loadFile() {}
    loadURL() {}
    close() {}
    static getAllWindows() { return []; }
    static fromWebContents() { return null; }
  }

  const restore = registerMocks([
    [ELECTRON_URL, {
      namedExports: electronNamespace({
        app: captureAppHandlers(appHandlers),
        BrowserWindow: FakeBrowserWindow,
        ipcMain: {
          handle(channel, handler) {
            ipcHandlers.set(channel, handler);
          },
        },
      }),
    }],
    [DATABASE_URL, { defaultExport: SqliteCompatDatabase }],
    [WATCHER_URL, { namedExports: noopWatcher() }],
    [INDEXER_URL, { namedExports: { writeHeartbeat() {} } }],
    [INDEXER_SERVICE_URL, { namedExports: defaultIndexerService() }],
    [INDEXER_WORKER_URL, { namedExports: defaultIndexerWorkerClient() }],
  ]);

  try {
    await importMain();

    const sessions = ipcHandlers.get('db:getSessions')(null, {});
    assert.equal(sessions[0].id, 'legacy-session');
    assert.equal(sessions[0].source, 'claude');
    assert.deepEqual(ipcHandlers.get('db:getStats')(null, {}), {
      sessions: 1,
      memories: 0,
      memoriesArchived: 0,
    });
  } finally {
    restore();
    restoreEnvVar('HOME', originalHome);
    restoreEnvVar('USERPROFILE', originalProfile);
    await closeMainProcessDb(appHandlers);
    rmSync(home, { recursive: true, force: true });
  }
});

test('main process keeps schema and memory mutations behind the writer lease', async () => {
  const originalHome = process.env.HOME;
  const originalProfile = process.env.USERPROFILE;
  const home = makeTempDir(`obelisk-main-migration-lease-${Date.now()}`);
  const obeliskDir = join(home, '.obelisk');
  const dbPath = join(obeliskDir, 'obelisk.sqlite');
  mkdirSync(obeliskDir, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home; // os.homedir() reads USERPROFILE on Windows

  const legacy = new DatabaseSync(dbPath);
  legacy.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)');
  legacy.close();

  const holder = acquireWriterLease({
    lockPath: join(obeliskDir, 'writer.lock.sqlite'),
    openDb: lockPath => new DatabaseSync(lockPath),
  });
  assert.ok(holder);
  const ipcHandlers = new Map();
  const appHandlers = new Map();

  class FakeBrowserWindow {
    constructor() {
      this.webContents = { on() {}, setWindowOpenHandler() {}, getURL() { return ''; }, setZoomLevel() {}, openDevTools() {}, send() {} };
    }
    loadFile() {}
    loadURL() {}
    close() {}
    static getAllWindows() { return []; }
    static fromWebContents() { return null; }
  }

  const restore = registerMocks([
    [ELECTRON_URL, {
      namedExports: electronNamespace({
        app: captureAppHandlers(appHandlers),
        BrowserWindow: FakeBrowserWindow,
        ipcMain: {
          handle(channel, handler) { ipcHandlers.set(channel, handler); },
        },
      }),
    }],
    [DATABASE_URL, { defaultExport: SqliteCompatDatabase }],
    [WATCHER_URL, { namedExports: noopWatcher() }],
    [INDEXER_URL, { namedExports: { writeHeartbeat() {} } }],
    [INDEXER_SERVICE_URL, { namedExports: defaultIndexerService() }],
    [INDEXER_WORKER_URL, { namedExports: defaultIndexerWorkerClient() }],
  ]);

  try {
    await importMain();
    const check = new DatabaseSync(dbPath, { readOnly: true });
    const columns = check.prepare('PRAGMA table_info(sessions)').all().map(column => column.name);
    check.close();
    assert.deepEqual(columns, ['id']);
    assert.throws(
      () => ipcHandlers.get('db:archiveMemory')(null, 'memory-1', 'test'),
      /writer is busy/i,
    );
  } finally {
    restore();
    holder.release();
    restoreEnvVar('HOME', originalHome);
    restoreEnvVar('USERPROFILE', originalProfile);
    await closeMainProcessDb(appHandlers);
    rmSync(home, { recursive: true, force: true });
  }
});

test('closing the last macOS window releases background resources until activation', async () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalHome = process.env.HOME;
  const originalProfile = process.env.USERPROFILE;
  const home = makeTempDir(`obelisk-main-window-${Date.now()}`);
  mkdirSync(join(home, '.obelisk'), { recursive: true });
  writeFileSync(join(home, '.obelisk', 'obelisk.sqlite'), '');
  process.env.HOME = home;
  process.env.USERPROFILE = home; // os.homedir() reads USERPROFILE on Windows
  Object.defineProperty(process, 'platform', { value: 'darwin' });

  const appHandlers = new Map();
  const serviceEvents = [];
  const workers = [];
  const watchers = [];
  const windows = [];
  let quitCalled = false;

  class FakeDatabase {
    pragma() {}
    exec() {}
    close() { serviceEvents.push('db-close'); }
    prepare() {
      return { get: () => null, all: () => [], run: () => ({}) };
    }
  }

  class FakeBrowserWindow {
    constructor() {
      this.webContents = { on() {}, setWindowOpenHandler() {}, getURL() { return ''; }, setZoomLevel() {}, openDevTools() {}, send() {} };
      windows.push(this);
    }
    loadFile() {}
    loadURL() {}
    close() {}
    static getAllWindows() { return windows; }
    static fromWebContents() { return null; }
  }

  const restore = registerMocks([
    [ELECTRON_URL, {
      namedExports: electronNamespace({
        app: {
          whenReady: () => Promise.resolve(),
          on(event, handler) { appHandlers.set(event, handler); },
          quit() { quitCalled = true; },
        },
        BrowserWindow: FakeBrowserWindow,
      }),
    }],
    [DATABASE_URL, { defaultExport: FakeDatabase }],
    [WATCHER_URL, {
      namedExports: {
        createAdaptiveWatcher: () => {
          const watcher = {
            close() { serviceEvents.push('watcher-close'); return Promise.resolve(); },
          };
          watchers.push(watcher);
          return watcher;
        },
      },
    }],
    [INDEXER_URL, { namedExports: { writeHeartbeat() {} } }],
    [INDEXER_SERVICE_URL, {
      namedExports: {
        createIndexerService: () => ({
          start() { serviceEvents.push('service-start'); },
          stop() { serviceEvents.push('service-stop'); },
          idle: async () => { serviceEvents.push('service-idle'); },
          runBuildNow() { serviceEvents.push('service-build'); return Promise.resolve(); },
        }),
      },
    }],
    [INDEXER_WORKER_URL, {
      namedExports: {
        createWorkerBuildIndex: () => {
          const worker = { stop() { serviceEvents.push('worker-stop'); } };
          workers.push(worker);
          return worker;
        },
      },
    }],
  ]);

  try {
    await importMain();

    assert.equal(windows.length, 1);
    assert.equal(workers.length, 1);
    assert.equal(watchers.length, 1);

    windows.length = 0;
    appHandlers.get('window-all-closed')();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(quitCalled, false);
    assert.ok(serviceEvents.includes('service-stop'));
    assert.ok(serviceEvents.includes('worker-stop'));
    assert.ok(serviceEvents.includes('watcher-close'));
    assert.ok(serviceEvents.includes('db-close'));

    appHandlers.get('activate')();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(windows.length, 1);
    assert.equal(workers.length, 2);
    assert.equal(watchers.length, 2);
    assert.equal(serviceEvents.filter(e => e === 'service-start').length, 2);
  } finally {
    restore();
    restoreEnvVar('HOME', originalHome);
    restoreEnvVar('USERPROFILE', originalProfile);
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    rmSync(home, { recursive: true, force: true });
  }
});

test('settings rebuild reopens the database from the configured Claude path', async () => {
  const home = makeTempDir(`obelisk-main-settings-${Date.now()}`);
  const defaultClaudeDir = join(home, '.claude');
  const customClaudeDir = join(home, 'custom-claude');
  const customCodexDir = join(home, 'custom-codex');
  mkdirSync(defaultClaudeDir, { recursive: true });
  mkdirSync(customClaudeDir, { recursive: true });
  mkdirSync(customCodexDir, { recursive: true });
  mkdirSync(join(home, '.obelisk'), { recursive: true });
  writeFileSync(join(defaultClaudeDir, 'obelisk.sqlite'), '');
  writeFileSync(join(customClaudeDir, 'obelisk.sqlite'), 'legacy custom db');
  writeFileSync(join(home, '.obelisk', 'settings.json'), JSON.stringify({
    claudeDir: customClaudeDir,
    codexDir: customCodexDir,
  }));

  const originalHome = process.env.HOME;

  const originalProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home; // os.homedir() reads USERPROFILE on Windows

  const ipcHandlers = new Map();
  const openedDbPaths = [];
  const buildCalls = [];
  const serviceEvents = [];
  const sent = [];
  const promotedHints = [];
  let competingLeaseDuringBuild;
  let publishRebuild = false;

  class FakeDatabase {
    constructor(dbPath) {
      this.lockDb = dbPath.endsWith('writer.lock.sqlite') ? new DatabaseSync(dbPath) : null;
      openedDbPaths.push(dbPath);
    }
    pragma() {}
    exec(sql) { return this.lockDb?.exec(sql); }
    close() { this.lockDb?.close(); }
    prepare() {
      return { get: () => null, all: () => [], run: () => ({}) };
    }
  }

  class FakeBrowserWindow {
    constructor() {
      this.webContents = {
        on() {},
        setWindowOpenHandler() {},
        getURL() { return ''; },
        setZoomLevel() {},
        openDevTools() {},
        send(channel, payload) { sent.push({ channel, payload }); },
      };
    }
    loadFile() {}
    loadURL() {}
    close() {}
    static getAllWindows() { return [new FakeBrowserWindow()]; }
    static fromWebContents() { return null; }
  }

  const restore = registerMocks([
    [ELECTRON_URL, {
      namedExports: electronNamespace({
        BrowserWindow: FakeBrowserWindow,
        ipcMain: {
          handle(channel, handler) {
            ipcHandlers.set(channel, handler);
          },
        },
      }),
    }],
    [DATABASE_URL, { defaultExport: FakeDatabase }],
    [WATCHER_URL, { namedExports: noopWatcher() }],
    [INDEXER_URL, { namedExports: { writeHeartbeat() {} } }],
    [INDEXER_SERVICE_URL, {
      namedExports: {
        createIndexerService: () => ({
          start() { serviceEvents.push('start'); },
          stop() { serviceEvents.push('stop'); },
          idle: async () => { serviceEvents.push('idle'); },
          runBuildNow() { serviceEvents.push('runBuildNow'); return Promise.resolve(); },
          promoteWatchHints(hints) { promotedHints.push(hints); },
        }),
      },
    }],
    [INDEXER_WORKER_URL, {
      namedExports: {
        createWorkerBuildIndex: () => ({
          buildIndex: async (args) => {
            serviceEvents.push('build');
            buildCalls.push(args);
            const competingLease = acquireWriterLease({
              lockPath: args.writerLeasePath,
              openDb: lockPath => new DatabaseSync(lockPath),
            });
            competingLeaseDuringBuild = Boolean(competingLease);
            competingLease?.release();
            writeFileSync(args.dbPath, 'rebuilt temp db');
            return {
              files: 2,
              affectedSessionIds: ['session-1', 'session-2'],
              complete: publishRebuild,
              reason: publishRebuild ? undefined : 'incomplete_snapshot',
              inventoryIssues: [],
              skippedFiles: publishRebuild
                ? []
                : [{
                    provider: 'pi',
                    path: '/tmp/pi/structurally-invalid.jsonl',
                    error: 'Malformed Pi message at line 2',
                  }],
              watchHints: publishRebuild ? ['/hint/live-session.jsonl'] : [],
            };
          },
          stop() { return Promise.resolve(); },
        }),
      },
    }],
  ]);

  try {
    await importMain();

    const rebuild = ipcHandlers.get('settings:rebuildIndex');
    assert.equal(typeof rebuild, 'function');
    const liveDbPath = join(home, '.obelisk', 'obelisk.sqlite');
    const beforeIncomplete = require('node:fs').readFileSync(liveDbPath, 'utf8');
    const incomplete = await rebuild();
    assert.equal(incomplete.complete, false);
    assert.ok(
      serviceEvents.includes('runBuildNow'),
      'a rebuild without hints schedules a reconciling build to reseed the hot set',
    );
    assert.deepEqual(sent.findLast(message => message.channel === 'obelisk:index-updated'), {
      channel: 'obelisk:index-updated',
      payload: {
        affectedSessionIds: ['session-1', 'session-2'],
        sourceIssues: [{
          provider: 'pi',
          path: '/tmp/pi/structurally-invalid.jsonl',
          error: 'Malformed Pi message at line 2',
        }],
      },
    });
    assert.equal(
      require('node:fs').readFileSync(liveDbPath, 'utf8'),
      beforeIncomplete,
      'an incomplete temp database must not replace the live database',
    );

    publishRebuild = true;
    await rebuild();
    assert.deepEqual(
      sent.findLast(message => message.channel === 'obelisk:index-updated').payload.sourceIssues,
      [],
    );

    assert.equal(buildCalls.at(-1).claudeDir, customClaudeDir);
    assert.equal(buildCalls.at(-1).projectsDir, join(customClaudeDir, 'projects'));
    assert.equal(buildCalls.at(-1).codexDir, customCodexDir);
    assert.notEqual(buildCalls.at(-1).dbPath, liveDbPath);
    assert.equal(buildCalls.at(-1).preserveDbPath, liveDbPath);
    assert.equal(buildCalls.at(-1).writerLeasePath, join(home, '.obelisk', 'writer.lock.sqlite'));
    assert.equal(buildCalls.at(-1).writerLeaseMode, 'caller-held');
    assert.equal(competingLeaseDuringBuild, false);
    assert.equal(openedDbPaths.at(-1), liveDbPath);
    assert.equal(
      require('node:fs').readFileSync(liveDbPath, 'utf8'),
      'rebuilt temp db',
    );
    assert.ok(serviceEvents.indexOf('build') > serviceEvents.indexOf('stop'));
    assert.deepEqual(promotedHints, [['/hint/live-session.jsonl']],
      'a successful rebuild seeds the recreated watcher with its watch hints');
    const postRebuildLease = acquireWriterLease({
      lockPath: join(home, '.obelisk', 'writer.lock.sqlite'),
      openDb: lockPath => new DatabaseSync(lockPath),
    });
    assert.ok(postRebuildLease);
    postRebuildLease.release();
  } finally {
    restore();
    restoreEnvVar('HOME', originalHome);
    restoreEnvVar('USERPROFILE', originalProfile);
    rmSync(home, { recursive: true, force: true });
  }
});

test('settings rebuild keeps the existing database after a worker failure', async () => {
  const home = makeTempDir(`obelisk-main-settings-rebuild-failure-${Date.now()}`);
  const customClaudeDir = join(home, 'custom-claude');
  const customCodexDir = join(home, 'custom-codex');
  mkdirSync(customClaudeDir, { recursive: true });
  mkdirSync(customCodexDir, { recursive: true });
  mkdirSync(join(home, '.obelisk'), { recursive: true });
  writeFileSync(join(customClaudeDir, 'obelisk.sqlite'), 'legacy custom db');
  writeFileSync(join(home, '.obelisk', 'settings.json'), JSON.stringify({
    claudeDir: customClaudeDir,
    codexDir: customCodexDir,
  }));

  const originalHome = process.env.HOME;

  const originalProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home; // os.homedir() reads USERPROFILE on Windows

  const ipcHandlers = new Map();
  const openedDbPaths = [];
  const closedDbPaths = [];
  const serviceEvents = [];

  class FakeDatabase {
    constructor(dbPath) {
      this.dbPath = dbPath;
      this.lockDb = dbPath.endsWith('writer.lock.sqlite') ? new DatabaseSync(dbPath) : null;
      if (!this.lockDb) openedDbPaths.push(dbPath);
    }
    pragma() {}
    exec(sql) { return this.lockDb?.exec(sql); }
    close() {
      if (this.lockDb) this.lockDb.close();
      else closedDbPaths.push(this.dbPath);
    }
    prepare() {
      return { get: () => null, all: () => [], run: () => ({}) };
    }
  }

  class FakeBrowserWindow {
    constructor() {
      this.webContents = { on() {}, setWindowOpenHandler() {}, getURL() { return ''; }, setZoomLevel() {}, openDevTools() {}, send() {} };
    }
    loadFile() {}
    loadURL() {}
    close() {}
    static getAllWindows() { return []; }
    static fromWebContents() { return null; }
  }

  const restore = registerMocks([
    [ELECTRON_URL, {
      namedExports: electronNamespace({
        BrowserWindow: FakeBrowserWindow,
        ipcMain: {
          handle(channel, handler) {
            ipcHandlers.set(channel, handler);
          },
        },
      }),
    }],
    [DATABASE_URL, { defaultExport: FakeDatabase }],
    [WATCHER_URL, { namedExports: noopWatcher() }],
    [INDEXER_URL, { namedExports: { writeHeartbeat() {} } }],
    [INDEXER_SERVICE_URL, {
      namedExports: {
        createIndexerService: () => ({
          start() { serviceEvents.push('start'); },
          stop() { serviceEvents.push('stop'); },
          idle: async () => { serviceEvents.push('idle'); },
          runBuildNow() { serviceEvents.push('runBuildNow'); return Promise.resolve(); },
        }),
      },
    }],
    [INDEXER_WORKER_URL, {
      namedExports: {
        createWorkerBuildIndex: () => ({
          buildIndex: async () => {
            serviceEvents.push('build');
            throw new Error('worker exploded');
          },
          stop() {},
        }),
      },
    }],
  ]);

  try {
    await importMain();

    const rebuild = ipcHandlers.get('settings:rebuildIndex');
    const openCountBeforeRebuild = openedDbPaths.length;
    await assert.rejects(() => rebuild(), /worker exploded/);

    const expectedDbPath = join(home, '.obelisk', 'obelisk.sqlite');
    assert.equal(openedDbPaths.at(-1), expectedDbPath);
    assert.equal(openedDbPaths.length, openCountBeforeRebuild);
    assert.equal(closedDbPaths.includes(expectedDbPath), false);
    assert.equal(
      require('node:fs').readFileSync(expectedDbPath, 'utf8'),
      'legacy custom db',
    );
    assert.ok(serviceEvents.indexOf('build') > serviceEvents.indexOf('stop'));
    assert.ok(serviceEvents.lastIndexOf('start') > serviceEvents.indexOf('build'));
  } finally {
    restore();
    restoreEnvVar('HOME', originalHome);
    restoreEnvVar('USERPROFILE', originalProfile);
    rmSync(home, { recursive: true, force: true });
  }
});

test('settings rebuild cancels an in-flight background build instead of waiting for it', async () => {
  const home = makeTempDir(`obelisk-main-settings-rebuild-cancel-${Date.now()}`);
  const customClaudeDir = join(home, 'custom-claude');
  const customCodexDir = join(home, 'custom-codex');
  mkdirSync(customClaudeDir, { recursive: true });
  mkdirSync(customCodexDir, { recursive: true });
  mkdirSync(join(home, '.obelisk'), { recursive: true });
  writeFileSync(join(customClaudeDir, 'obelisk.sqlite'), 'legacy custom db');
  writeFileSync(join(home, '.obelisk', 'settings.json'), JSON.stringify({
    claudeDir: customClaudeDir,
    codexDir: customCodexDir,
  }));

  const originalHome = process.env.HOME;

  const originalProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home; // os.homedir() reads USERPROFILE on Windows

  const ipcHandlers = new Map();
  const serviceEvents = [];
  let buildIndexCalls = 0;

  class FakeDatabase {
    constructor(dbPath) {
      this.lockDb = dbPath.endsWith('writer.lock.sqlite') ? new DatabaseSync(dbPath) : null;
    }
    pragma() {}
    exec(sql) { return this.lockDb?.exec(sql); }
    close() { this.lockDb?.close(); }
    prepare() {
      return { get: () => null, all: () => [], run: () => ({}) };
    }
  }

  class FakeBrowserWindow {
    constructor() {
      this.webContents = { on() {}, setWindowOpenHandler() {}, getURL() { return ''; }, setZoomLevel() {}, openDevTools() {}, send() {} };
    }
    loadFile() {}
    loadURL() {}
    close() {}
    static getAllWindows() { return []; }
    static fromWebContents() { return null; }
  }

  const restore = registerMocks([
    [ELECTRON_URL, {
      namedExports: electronNamespace({
        BrowserWindow: FakeBrowserWindow,
        ipcMain: {
          handle(channel, handler) {
            ipcHandlers.set(channel, handler);
          },
        },
      }),
    }],
    [DATABASE_URL, { defaultExport: FakeDatabase }],
    [WATCHER_URL, { namedExports: noopWatcher() }],
    [INDEXER_URL, { namedExports: { writeHeartbeat() {} } }],
    [INDEXER_SERVICE_URL, {
      namedExports: {
        createIndexerService: () => ({
          start() { serviceEvents.push('start'); },
          stop() { serviceEvents.push('stop'); },
          idle: async () => new Promise(() => {}),
          runBuildNow() { serviceEvents.push('runBuildNow'); return Promise.resolve(); },
        }),
      },
    }],
    [INDEXER_WORKER_URL, {
      namedExports: {
        createWorkerBuildIndex: () => ({
          buildIndex: async (args) => {
            serviceEvents.push(`build-${++buildIndexCalls}`);
            writeFileSync(args.dbPath, 'rebuilt temp db');
            return { files: 2, affectedSessionIds: [], complete: true };
          },
          stop() {
            serviceEvents.push('worker-stop');
            return Promise.resolve();
          },
        }),
      },
    }],
  ]);

  try {
    await importMain();

    const rebuild = ipcHandlers.get('settings:rebuildIndex');
    const outcome = await Promise.race([
      rebuild().then(() => 'done'),
      new Promise(resolve => setTimeout(() => resolve('timeout'), 20)),
    ]);

    assert.equal(outcome, 'done');
    assert.ok(serviceEvents.indexOf('worker-stop') > serviceEvents.indexOf('stop'));
    assert.ok(serviceEvents.some(event => event.startsWith('build-')));
  } finally {
    restore();
    restoreEnvVar('HOME', originalHome);
    restoreEnvVar('USERPROFILE', originalProfile);
    rmSync(home, { recursive: true, force: true });
  }
});

test('settings changes during rebuild keep one watcher and re-enable with a catch-up build', async () => {
  const home = makeTempDir(`obelisk-main-settings-rebuild-race-${Date.now()}`);
  mkdirSync(join(home, '.obelisk'), { recursive: true });
  writeFileSync(join(home, '.obelisk', 'obelisk.sqlite'), '');
  writeFileSync(join(home, '.obelisk', 'settings.json'), JSON.stringify({ autoRefresh: true }));
  const originalHome = process.env.HOME;
  const originalProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home; // os.homedir() reads USERPROFILE on Windows

  const ipcHandlers = new Map();
  const services = [];
  let finishRebuild;

  class FakeDatabase {
    constructor(dbPath) {
      this.lockDb = dbPath.endsWith('writer.lock.sqlite') ? new DatabaseSync(dbPath) : null;
    }
    pragma() {}
    exec(sql) { return this.lockDb?.exec(sql); }
    close() { this.lockDb?.close(); }
    prepare() {
      return { get: () => null, all: () => [], run: () => ({}) };
    }
  }

  class FakeBrowserWindow {
    constructor() {
      this.webContents = { on() {}, setWindowOpenHandler() {}, getURL() { return ''; }, setZoomLevel() {}, openDevTools() {}, send() {} };
    }
    loadFile() {}
    loadURL() {}
    close() {}
    static getAllWindows() { return []; }
    static fromWebContents() { return null; }
  }

  const restore = registerMocks([
    [ELECTRON_URL, {
      namedExports: electronNamespace({
        BrowserWindow: FakeBrowserWindow,
        ipcMain: {
          handle(channel, handler) {
            ipcHandlers.set(channel, handler);
          },
        },
      }),
    }],
    [DATABASE_URL, { defaultExport: FakeDatabase }],
    [WATCHER_URL, { namedExports: noopWatcher() }],
    [INDEXER_URL, { namedExports: { writeHeartbeat() {} } }],
    [INDEXER_SERVICE_URL, {
      namedExports: {
        createIndexerService: () => {
          const service = {
            starts: [],
            stops: 0,
            start(options) { this.starts.push(options); },
            stop() { this.stops += 1; },
            idle: async () => {},
            runBuildNow() { return Promise.resolve(); },
          };
          services.push(service);
          return service;
        },
      },
    }],
    [INDEXER_WORKER_URL, {
      namedExports: {
        createWorkerBuildIndex: () => ({
          buildIndex: () => new Promise(resolve => {
            finishRebuild = () => resolve({
              files: 0,
              affectedSessionIds: [],
              complete: false,
              deferred: false,
              inventoryIssues: [],
              skippedFiles: [],
              reason: 'incomplete_snapshot',
            });
          }),
          stop() { return Promise.resolve(); },
        }),
      },
    }],
  ]);

  try {
    await importMain();
    assert.equal(services.length, 1);

    const rebuildPromise = ipcHandlers.get('settings:rebuildIndex')();
    await new Promise(resolve => setImmediate(resolve));
    await ipcHandlers.get('settings:set')(null, 'autoRefresh', false);
    await ipcHandlers.get('settings:set')(null, 'autoRefresh', true);

    assert.equal(services.length, 2);
    assert.deepEqual(services[1].starts, [{ buildOnStart: true }]);
    finishRebuild();
    await rebuildPromise;

    assert.equal(services.length, 2, 'the rebuild finally block reused the current service');
    assert.equal(services[0].stops, 1);
    assert.equal(services[1].stops, 0);
  } finally {
    restore();
    restoreEnvVar('HOME', originalHome);
    restoreEnvVar('USERPROFILE', originalProfile);
    rmSync(home, { recursive: true, force: true });
  }
});


test('main process watches OBELISK_DIR as a tree target and debounces recap notifications', async () => {
  const originalHome = process.env.HOME;
  const originalProfile = process.env.USERPROFILE;
  const home = makeTempDir(`obelisk-watch-retry-${Date.now()}`);
  mkdirSync(join(home, '.obelisk'), { recursive: true });
  writeFileSync(join(home, '.obelisk', 'obelisk.sqlite'), '');
  process.env.HOME = home;
  process.env.USERPROFILE = home; // os.homedir() reads USERPROFILE on Windows

  let watcherOptions = null;
  const windows = [];
  const sent = [];

  class FakeDatabase {
    pragma() {}
    exec() {}
    close() {}
    prepare() {
      return { get: () => null, all: () => [], run: () => ({}) };
    }
  }

  class FakeBrowserWindow {
    constructor() {
      this.webContents = {
        on() {}, setWindowOpenHandler() {}, getURL() { return ''; }, setZoomLevel() {}, openDevTools() {},
        send(channel, payload) { sent.push({ channel, payload }); },
      };
      windows.push(this);
    }
    loadFile() {}
    loadURL() {}
    close() {}
    static getAllWindows() { return windows; }
    static fromWebContents() { return null; }
  }

  mock.timers.enable({ apis: ['setTimeout'] });
  const restore = registerMocks([
    [ELECTRON_URL, { namedExports: electronNamespace({ BrowserWindow: FakeBrowserWindow }) }],
    [DATABASE_URL, { defaultExport: FakeDatabase }],
    [WATCHER_URL, {
      namedExports: {
        createAdaptiveWatcher: (options) => {
          watcherOptions = options;
          return { close() { return Promise.resolve(); } };
        },
      },
    }],
    [INDEXER_URL, { namedExports: { writeHeartbeat() {} } }],
    [INDEXER_SERVICE_URL, { namedExports: defaultIndexerService() }],
    [INDEXER_WORKER_URL, { namedExports: defaultIndexerWorkerClient() }],
  ]);

  try {
    await importMain();
    assert.ok(watcherOptions, 'the OBELISK_DIR watcher was created');
    // Retry/recovery lives inside the package now; the app only declares the
    // target. The package's own tests prove the retry loop repeats.
    assert.deepEqual(watcherOptions.targets, [{ kind: 'tree', path: join(home, '.obelisk') }]);

    // A recap markdown invalidation notifies windows after the writes settle:
    // true trailing debounce — the timer resets on every event.
    const recapFile = join(home, '.obelisk', 'recap', 'week.md');
    watcherOptions.onInvalidate({ type: 'paths', paths: [recapFile] });
    mock.timers.tick(200);
    watcherOptions.onInvalidate({ type: 'paths', paths: [recapFile] });
    mock.timers.tick(299);
    assert.equal(sent.length, 0, 'a continuous write burst has not notified yet');
    mock.timers.tick(1);
    assert.equal(sent.length, 1, 'notification fires 300 ms after the LAST event, not the first');
    assert.equal(sent[0].channel, 'obelisk:recap-updated');
    assert.equal(sent[0].payload, recapFile);

    // Non-recap extensions never notify.
    watcherOptions.onInvalidate({ type: 'paths', paths: [join(home, '.obelisk', 'notes.txt')] });
    mock.timers.tick(1000);
    assert.equal(sent.length, 1, 'a .txt change does not notify');
  } finally {
    restore();
    mock.timers.reset();
    restoreEnvVar('HOME', originalHome);
    restoreEnvVar('USERPROFILE', originalProfile);
    rmSync(home, { recursive: true, force: true });
  }
});
