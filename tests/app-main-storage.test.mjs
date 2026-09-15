// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { makeTempDir } from './temp-dirs.mjs';

const mainUrl = new URL('../app/src/main/index.ts', import.meta.url);
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
const ADAPTIVE_WATCHER_URL = new URL('../packages/adaptive-watcher/src/index.ts', import.meta.url).href;
const INDEXER_URL = new URL('./indexer.ts', mainUrl).href;
const INDEXER_SERVICE_URL = new URL('./indexer-service.ts', mainUrl).href;
const INDEXER_WORKER_URL = new URL('./indexer-worker-client.ts', mainUrl).href;

let importCounter = 0;

function electronNamespace({ app, BrowserWindow, ipcMain }) {
  return {
    app,
    BrowserWindow,
    ipcMain,
    clipboard: {},
    dialog: {},
    nativeImage: {},
    shell: {},
  };
}

function registerMocks(defs) {
  const contexts = defs.map(([specifier, options]) => mock.module(specifier, options));
  return () => {
    for (const context of contexts) context.restore();
    mock.reset();
  };
}

test('Electron main uses custom config and data paths from the shared resolver', async () => {
  const home = makeTempDir('obelisk-app-main-storage-');
  const customHome = join(home, 'portable', 'obelisk');
  const dbPath = join(customHome, 'obelisk.sqlite');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(customHome, { recursive: true });
  writeFileSync(dbPath, '');

  const originalEnv = Object.fromEntries([
    'HOME',
    'USERPROFILE',
    'OBELISK_HOME',
    'OBELISK_USE_XDG',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'PI_CODING_AGENT_DIR',
    'PI_CODING_AGENT_SESSION_DIR',
    'KIMI_CODE_HOME',
  ].map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    OBELISK_HOME: join('~', 'portable', 'obelisk'),
    OBELISK_USE_XDG: '',
    XDG_CONFIG_HOME: '',
    XDG_DATA_HOME: '',
    PI_CODING_AGENT_DIR: '',
    PI_CODING_AGENT_SESSION_DIR: '',
    KIMI_CODE_HOME: '',
  });

  const ipcHandlers = new Map();
  const watchPaths = [];
  const windows = [];

  class FakeDatabase {
    constructor(path) {
      this.path = path;
    }
    pragma() {}
    exec() {}
    close() {}
    prepare() {
      return {
        all: () => [],
        get: () => null,
        run: () => ({}),
      };
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
        send() {},
      };
      windows.push(this);
    }
    loadFile() {}
    loadURL() {}
    close() {}
    static getAllWindows() { return windows; }
    static fromWebContents() { return null; }
  }

  const fakeApp = {
    whenReady: () => Promise.resolve(),
    on() {},
    quit() {},
    getVersion: () => '9.9.9-test',
  };
  const fakeIpcMain = {
    handle(channel, handler) {
      ipcHandlers.set(channel, handler);
    },
  };
  const fakeAdaptiveWatcher = ({ targets }) => {
    for (const target of targets) watchPaths.push(target.path);
    return { close() {} };
  };

  const restore = registerMocks([
    [ELECTRON_URL, {
      namedExports: electronNamespace({
        app: fakeApp,
        BrowserWindow: FakeBrowserWindow,
        ipcMain: fakeIpcMain,
      }),
    }],
    [DATABASE_URL, { defaultExport: FakeDatabase }],
    [ADAPTIVE_WATCHER_URL, { namedExports: { createAdaptiveWatcher: fakeAdaptiveWatcher } }],
    [INDEXER_URL, { namedExports: { writeHeartbeat() {} } }],
    [INDEXER_SERVICE_URL, {
      namedExports: {
        createIndexerService: () => ({
          start() {},
          stop() {},
          idle: async () => {},
          runBuildNow() { return Promise.resolve(); },
        }),
      },
    }],
    [INDEXER_WORKER_URL, {
      namedExports: {
        createWorkerBuildIndex: () => ({
          buildIndex: async () => ({ files: 0, affectedSessionIds: [] }),
          stop() {},
        }),
      },
    }],
  ]);

  try {
    await import(`${mainUrl.href}?storage-test=${++importCounter}-${Date.now()}`);
    await new Promise(resolve => setImmediate(resolve));

    const settings = await ipcHandlers.get('settings:get')();
    assert.equal(settings.configDir, customHome);
    assert.equal(settings.dataDir, customHome);
    assert.equal(settings.settingsPath, join(customHome, 'settings.json'));
    assert.equal(settings.dbPath, dbPath);
    assert.equal(settings.recapDir, join(customHome, 'recap'));
    assert.deepEqual(watchPaths, [customHome]);

    await ipcHandlers.get('settings:set')(null, 'editorScheme', 'cursor');
    assert.deepEqual(
      JSON.parse(readFileSync(join(customHome, 'settings.json'), 'utf8')),
      { editorScheme: 'cursor' },
    );
    assert.equal(existsSync(join(home, '.obelisk', 'settings.json')), false);
  } finally {
    restore();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
});
