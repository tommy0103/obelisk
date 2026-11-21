// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { app, BrowserWindow, ipcMain, clipboard, dialog, shell } from 'electron';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { writeHeartbeat } from './indexer.ts';
import { createIndexerService } from './indexer-service.ts';
import { createAdaptiveWatcher } from '../../../packages/adaptive-watcher/src/index.ts';
import { createWorkerBuildIndex } from './indexer-worker-client.ts';
import { registerSessionQueryHandlers, querySessionFileRoots } from './session-queries.ts';
import { registerRecapHandlers } from './recap-handlers.ts';
import { cleanupDbFiles, rebuildTempDbPath, replaceDbWithTemp } from './rebuild-db-files.ts';
import { isSameDocumentNavigation, isSameOrigin, safeProtocol } from './window-navigation.ts';
import { buildEditorUrl, DEFAULT_EDITOR_SCHEME, resolveFileReference } from './file-reference.ts';
import { createDeferredQuit } from './quit-teardown.ts';
import { createUpdateLifecycle } from './update-lifecycle.ts';
import { createUpdateService } from './update-service.ts';
import { acquireWriterLease, writerLockPathFor } from '../../../packages/core/src/writer-lease.ts';
import { migrateCoreSchemaColumns } from '../../../packages/core/src/schema-migrations.ts';
import { createBuiltinProviderRegistry } from '../../../packages/core/src/providers/builtins.ts';
import { defaultCodexHome } from '../../../packages/core/src/providers/codex.ts';
import {
  createConfiguredBuiltinProviderRuntime,
  getCopilotEditions,
  hasExplicitProviderRoot,
  readPersistedProviderSettings,
  resolveCodexConfiguredRoots,
  type PersistedProviderSettings,
} from '../../../packages/core/src/provider-settings.ts';
import {
  resolveObeliskPaths,
  warnLegacyStorageIgnored,
} from '../../../packages/core/src/paths.ts';
import {
  buildSourceCatalog,
  setPersistedSetting,
  type ProviderSourceIssue,
} from './provider-settings.ts';
import { preserveRejectedSettings } from './settings-preservation.ts';
import type { WindowControlAction } from '../shared/ipc-types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OBELISK_PATHS = resolveObeliskPaths();
const OBELISK_DIR = OBELISK_PATHS.dataDir;
const RECAP_DIR = OBELISK_PATHS.recapDir;
const SETTINGS_PATH = OBELISK_PATHS.settingsPath;
let legacyStorageWarningShown = false;

function detectClaudeDir() {
  // macOS / Linux: ~/.claude
  if (process.platform !== 'win32') {
    return path.join(os.homedir(), '.claude');
  }
  // Windows: Claude Code runs in WSL, data lives at \\wsl.localhost\<distro>\home\<user>\.claude
  const distros = ['Ubuntu', 'Ubuntu-24.04', 'Ubuntu-22.04', 'Debian', 'openSUSE-Leap', 'kali-linux'];
  for (const distro of distros) {
    const homePath = path.join('\\\\wsl.localhost', distro, 'home');
    if (!fs.existsSync(homePath)) continue;
    try {
      const users = fs.readdirSync(homePath);
      for (const user of users) {
        const claudeDir = path.join(homePath, user, '.claude');
        if (fs.existsSync(claudeDir)) return claudeDir;
      }
    } catch {
      // Unreadable WSL home: try the next distro.
    }
  }
  // Fallback: native Windows path (for future native Claude Code on Windows)
  return path.join(os.homedir(), '.claude');
}

const DEFAULT_CLAUDE_DIR = detectClaudeDir();

let db: Database.Database | null = null;
let indexerService: ReturnType<typeof createIndexerService> | null = null;
let indexerWorker: ReturnType<typeof createWorkerBuildIndex> | null = null;
let latestSourceIssues: ProviderSourceIssue[] = [];
let latestSettingsError: string | null = null;
// A recovery notice is deliberately kept apart from latestSettingsError: that variable
// also gates the indexer (startIndexerService, migrations, rebuildIndex all treat a
// non-null value as "settings unusable"). Once a corrupt file has been moved aside the
// settings ARE usable again, so the notice must not block those paths.
let latestSettingsRecovery: string | null = null;

type WriterLeaseMode = 'acquire' | 'caller-held';

function acquireAppWriterLease(dbPath: string, waitMs = 0) {
  return acquireWriterLease({
    lockPath: writerLockPathFor(dbPath),
    openDb: lockPath => new Database(lockPath),
    waitMs,
  });
}

function getRuntimePaths(persisted = loadPersistedSettings()) {
  const runtime = createConfiguredBuiltinProviderRuntime(persisted, {
    baseRoots: {
      claude: DEFAULT_CLAUDE_DIR,
    },
    openCopilotChronicle: sourcePath => new Database(sourcePath, {
      readonly: true,
      fileMustExist: true,
    }),
    openZcodeDatabase: sourcePath => new Database(sourcePath, {
      readonly: true,
      fileMustExist: true,
      timeout: 500,
    }),
    openKiroDatabase: sourcePath => new Database(sourcePath, {
      readonly: true,
      fileMustExist: true,
      timeout: 500,
    }),
  });
  const providerRoots = runtime.roots;
  const providerRegistry = runtime.registry;
  const claudeDir = providerRoots['claude'] ?? DEFAULT_CLAUDE_DIR;
  const codexDir = providerRoots['codex'] ?? defaultCodexHome();
  return {
    providerRoots,
    providerSettings: persisted,
    providerRegistry,
    claudeDir,
    codexDir,
    configDir: OBELISK_PATHS.configDir,
    dataDir: OBELISK_PATHS.dataDir,
    settingsPath: OBELISK_PATHS.settingsPath,
    dbPath: OBELISK_PATHS.dbPath,
    projectsDir: path.join(claudeDir, 'projects'),
  };
}

function migrateLegacyDbIfNeeded(
  paths = getRuntimePaths(),
  { writerLeaseMode = 'acquire' }: { writerLeaseMode?: WriterLeaseMode } = {},
) {
  if (OBELISK_PATHS.layout !== 'legacy') {
    if (!legacyStorageWarningShown) {
      legacyStorageWarningShown = warnLegacyStorageIgnored(OBELISK_PATHS) !== null;
    }
    return false;
  }
  if (fs.existsSync(paths.dbPath)) return;
  const legacyDbPath = path.join(paths.claudeDir, 'obelisk.sqlite');
  if (!fs.existsSync(legacyDbPath)) return;
  const lease = writerLeaseMode === 'acquire' ? acquireAppWriterLease(paths.dbPath) : null;
  if (writerLeaseMode === 'acquire' && !lease) return false;
  try {
    if (fs.existsSync(paths.dbPath)) return true;
    fs.mkdirSync(path.dirname(paths.dbPath), { recursive: true });
    fs.copyFileSync(legacyDbPath, paths.dbPath);
    return true;
  } catch (error) {
    console.warn(`Obelisk legacy DB migration skipped: ${(error as Error).message}`);
    return false;
  } finally {
    lease?.release();
  }
}

function resolveSchemaPath() {
  const candidates = [
    path.join(__dirname, 'schema.sql'),
    path.join(__dirname, '..', '..', '..', 'packages', 'core', 'src', 'schema.sql'),
    path.join(__dirname, '..', 'scripts', 'schema.sql'),
    process.resourcesPath ? path.join(process.resourcesPath, 'scripts', 'schema.sql') : null,
  ].filter((c): c is string => Boolean(c));
  return candidates.find(p => fs.existsSync(p));
}

function migrateDb(db: Database.Database) {
  if (typeof db.exec !== 'function' || typeof db.prepare !== 'function') return;
  migrateCoreSchemaColumns(db);
  const schemaPath = resolveSchemaPath();
  if (schemaPath) db.exec(fs.readFileSync(schemaPath, 'utf8'));
  migrateCoreSchemaColumns(db);
}

function closeDb() {
  if (db) db.close();
  db = null;
}

function openDb(
  dbPath = getRuntimePaths().dbPath,
  { writerLeaseMode = 'acquire' }: { writerLeaseMode?: WriterLeaseMode } = {},
) {
  closeDb();
  if (!fs.existsSync(dbPath)) return null;
  db = new Database(dbPath, { readonly: false });
  db.pragma('busy_timeout = 5000');
  // Match the catalogue's original JavaScript substring semantics, including
  // Unicode case conversion and literal %, _ and backslashes.
  db.function('catalogue_contains', { deterministic: true },
    (title: string | null, project: string | null, branch: string | null, query: string) =>
      title?.toLowerCase().includes(query) || project?.toLowerCase().includes(query)
        || branch?.toLowerCase().includes(query) ? 1 : 0);
  const lease = writerLeaseMode === 'acquire' ? acquireAppWriterLease(dbPath) : null;
  if (writerLeaseMode === 'caller-held' || lease) {
    try {
      db.pragma('journal_mode = WAL');
      migrateDb(db);
    } finally {
      lease?.release();
    }
  }
  return db;
}

function runAppDbWrite(work: (db: Database.Database) => void): boolean {
  updateLifecycle.assertWritable();
  if (!db) return false;
  const lease = acquireAppWriterLease(getRuntimePaths().dbPath, 250);
  if (!lease) {
    throw new Error('Obelisk index writer is busy; memory change was not applied');
  }
  try {
    work(db);
    return true;
  } finally {
    lease.release();
  }
}

function notifyIndexUpdated(result: {
  affectedSessionIds?: unknown;
  inventoryIssues?: unknown;
  skippedFiles?: unknown;
} = {}) {
  const affectedSessionIds = Array.isArray(result.affectedSessionIds)
    ? [...new Set(result.affectedSessionIds.filter(Boolean))]
    : [];
  const issueLists = [result.inventoryIssues, result.skippedFiles]
    .filter(Array.isArray)
    .flat();
  if (Array.isArray(result.inventoryIssues) || Array.isArray(result.skippedFiles)) {
    const unique = new Map<string, ProviderSourceIssue>();
    for (const value of issueLists) {
      const issue = value as Partial<ProviderSourceIssue> | null;
      if (
        issue !== null
        && typeof issue.provider === 'string'
        && typeof issue.path === 'string'
        && typeof issue.error === 'string'
      ) {
        unique.set(`${issue.provider}\0${issue.path}\0${issue.error}`, {
          provider: issue.provider,
          path: issue.path,
          error: issue.error,
        });
      }
    }
    latestSourceIssues = [...unique.values()];
  }
  const payload = { affectedSessionIds, sourceIssues: latestSourceIssues };
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('obelisk:index-updated', payload);
    for (const sessionId of affectedSessionIds) {
      win.webContents.send('obelisk:session-updated', { sessionId });
    }
  }
}

function startIndexerService({ buildOnStart = false } = {}) {
  if (updateLifecycle.isBlocked()) return null;
  if (indexerService) return indexerService;
  const paths = getRuntimePaths();
  if (latestSettingsError !== null) return null;
  migrateLegacyDbIfNeeded(paths);
  const service = createIndexerService({
    projectsDir: paths.projectsDir,
    watchTargets: paths.providerRegistry.watchTargets(paths.providerRoots),
    buildIndex: async ({ reason, changedPaths, retrySessionIds }) => {
      if (!indexerWorker) throw new Error('Obelisk indexer worker is not running');
      const result = await indexerWorker.buildIndex({
        reason,
        changedPaths,
        retrySessionIds,
        providerRoots: paths.providerRoots,
        providerSettings: paths.providerSettings,
        claudeDir: paths.claudeDir,
        codexDir: paths.codexDir,
        projectsDir: paths.projectsDir,
        dbPath: paths.dbPath,
      });
      if (result?.deferred) {
        if (
          (Array.isArray(result.affectedSessionIds) && result.affectedSessionIds.length)
          || (Array.isArray(result.inventoryIssues) && result.inventoryIssues.length)
          || (Array.isArray(result.skippedFiles) && result.skippedFiles.length)
        ) {
          notifyIndexUpdated(result);
        }
      } else {
        openDb(paths.dbPath);
        notifyIndexUpdated(result);
      }
      return result;
    },
    writeHeartbeat: () => writeHeartbeat({ dbPath: paths.dbPath }),
  });
  service.start({ buildOnStart });
  indexerService = service;
  return service;
}

function startBackgroundResources({ runStartupBuild = false, watchSources = true } = {}) {
  if (updateLifecycle.isBlocked()) return;
  if (!indexerWorker) indexerWorker = createWorkerBuildIndex();
  const paths = getRuntimePaths();
  if (latestSettingsError === null) migrateLegacyDbIfNeeded(paths);
  openDb(paths.dbPath);
  if (watchSources && !indexerService && latestSettingsError === null) {
    const service = startIndexerService({ buildOnStart: false });
    if (runStartupBuild) service?.runBuildNow('startup');
  }
  if (!obeliskWatcher) startObeliskWatcher();
}

async function stopIndexerServiceAndWait({ waitForIdle = true } = {}) {
  const service = indexerService;
  if (!service) return;
  const closed = service.stop();
  const results = await Promise.allSettled([closed, waitForIdle ? service.idle() : undefined]);
  if (indexerService === service) indexerService = null;
  const failed = results.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}

let resourcesStop: Promise<void> | null = null;
async function stopBackgroundResources(options: { stopWorker?: boolean } = {}) {
  if (resourcesStop) return resourcesStop;
  resourcesStop = stopBackgroundResourcesNow(options);
  try { await resourcesStop; } finally { resourcesStop = null; }
}
async function stopBackgroundResourcesNow({ stopWorker = false } = {}) {
  // Close the ~/.obelisk watcher before the first await. close() flips its
  // `closed` flag synchronously and every parcel event callback guards on it,
  // so once this function yields, no teardown-time FSEvents delivery can
  // enter user code — even when the bounded quit path (#187) cuts the
  // remaining waits short. The service watcher's close() works the same way
  // inside service.stop().
  let watcherClosed: Promise<unknown> | null = null;
  if (obeliskWatcher) {
    const watcher = obeliskWatcher;
    obeliskWatcher = null;
    if (obeliskNotifyTimer) { clearTimeout(obeliskNotifyTimer); obeliskNotifyTimer = null; }
    pendingObeliskChanges.clear();
    watcherClosed = watcher.close();
    // Attach immediately so a rejection during service.idle() is observed.
    void watcherClosed.catch(() => {});
  }
  const results = await Promise.allSettled([stopIndexerServiceAndWait(), watcherClosed]);
  if (stopWorker && indexerWorker) {
    const worker = indexerWorker;
    const termination = await Promise.allSettled([Promise.resolve(worker.stop())]);
    results.push(...termination);
    if (indexerWorker === worker) indexerWorker = null;
  }
  closeDb();
  const failed = results.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}

function createWindow() {
  const isDev = process.argv.includes('--dev') || !!process.env.ELECTRON_RENDERER_URL;
  const shouldOpenDevTools = process.argv.includes('--devtools');
  const isLinux = process.platform === 'linux';

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    ...(isLinux ? {
      frame: false,
    } : {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 14, y: 10 },
    }),
    backgroundColor: '#0a0b14',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: isDev || shouldOpenDevTools,
    },
  });

  const pushWindowState = () => win.webContents.send('obelisk:window-state', { maximized: win.isMaximized() });
  win.on('maximize', pushWindowState);
  win.on('unmaximize', pushWindowState);

  // Prevent Electron's built-in zoom so Cmd+=/- reaches the renderer
  win.webContents.on('before-input-event', (event, input) => {
    if ((input.meta || input.control) && ['+', '=', '-', '0'].includes(input.key)) {
      win.webContents.setZoomLevel(0);
    }
  });

  // Keep the SPA in place: a Markdown link in a transcript must never replace the running
  // renderer. External http(s) targets are handed to the system browser instead.
  // Only genuinely external targets go to the browser. A same-origin URL is a local document
  // reference — in dev that would hand the system browser a Vite-served source file.
  const releaseNavigation = (url: string) => {
    if (!/^https?:$/i.test(safeProtocol(url))) return;
    if (isSameOrigin(url, win.webContents.getURL())) return;
    shell.openExternal(url).catch(() => {});
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    releaseNavigation(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isSameDocumentNavigation(url, win.webContents.getURL())) return;
    event.preventDefault();
    releaseNavigation(url);
  });

  if (isDev) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL || process.env.OBELISK_DEV_SERVER_URL || 'http://localhost:5173');
    if (shouldOpenDevTools) {
      win.webContents.openDevTools();
    }
  } else {
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }
}

let obeliskWatcher: ReturnType<typeof createAdaptiveWatcher> | null = null;
let obeliskNotifyTimer: ReturnType<typeof setTimeout> | null = null;
const pendingObeliskChanges = new Set<string>();

function flushObeliskChanges() {
  obeliskNotifyTimer = null;
  const changedPaths = [...pendingObeliskChanges];
  pendingObeliskChanges.clear();
  for (const changedPath of changedPaths) onObeliskChange(changedPath);
}

function startObeliskWatcher() {
  if (obeliskWatcher) return obeliskWatcher;
  // Idempotent ensure, off the main thread (mkdir recursive does not need an
  // existence check). The watcher tolerates the directory appearing late —
  // that is what the probe + retry loop inside the package is for — so there
  // is no ordering dependency between the two.
  void fs.promises.mkdir(OBELISK_DIR, { recursive: true }).catch(() => {});
  obeliskWatcher = createAdaptiveWatcher({
    targets: [{ kind: 'tree', path: OBELISK_DIR }],
    onInvalidate: (invalidation) => {
      if (invalidation.type !== 'paths') return;
      for (const changedPath of invalidation.paths) {
        if (!changedPath.endsWith('.md') && !changedPath.endsWith('.json')) continue;
        // True trailing debounce — reset on every event so an actively written
        // file notifies only after its writes settle (the awaitWriteFinish
        // replacement). Without the reset this would be a throttle.
        pendingObeliskChanges.add(changedPath);
        if (obeliskNotifyTimer) clearTimeout(obeliskNotifyTimer);
        obeliskNotifyTimer = setTimeout(flushObeliskChanges, 300);
      }
    },
  });
  return obeliskWatcher;
}

function onObeliskChange(filePath: string) {
  if (filePath.startsWith(RECAP_DIR)) {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('obelisk:recap-updated', filePath);
    }
  }
}

let appQuitRequested = false;
const updateLifecycle = createUpdateLifecycle({
  stop: () => stopBackgroundResources({ stopWorker: true }),
  resume: () => { if (!appQuitRequested) startBackgroundResources({ watchSources: loadPersistedSettings().autoRefresh !== false }); },
});
// Only the shipped amd64 Debian target has a verified Linux update channel.
// AppImage/source builds and other architectures must not consume its feed.
const isDebInstall = app.isPackaged && process.platform === 'linux' && process.arch === 'x64' &&
  await fs.promises.readFile(path.join(process.resourcesPath, 'package-type'), 'utf8')
    .then(value => value.trim() === 'deb', () => false);
const updater = createUpdateService({
  enabled: app.isPackaged === true && (process.platform === 'darwin' || isDebInstall),
  version: app.getVersion(),
  createBackend: async receive => {
    const { createMacUpdateBackend, createDebUpdateBackend } = await import('./update-backends.ts');
    return process.platform === 'darwin' ? createMacUpdateBackend(receive) : createDebUpdateBackend(receive);
  },
  prepare: updateLifecycle.prepare,
  recover: updateLifecycle.recover,
  publish: state => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('obelisk:update-state', state);
    }
  },
});
ipcMain.handle('updates:getState', () => updater.getState());
ipcMain.handle('updates:check', () => updater.check());
ipcMain.handle('updates:install', () => updater.install());

app.whenReady().then(() => {
  startBackgroundResources({ runStartupBuild: true });
  createWindow();
  void updater.check();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      startBackgroundResources({ runStartupBuild: true });
      createWindow();
    }
  });
});

// Quit must not tear the JS environment down while a watcher is still live: a
// @parcel/watcher callback firing during CleanupHandles throws with no JS
// frame to catch it, and napi_throw fatals the process (#187). The stop is
// not cached: a macOS pause (window-all-closed) can be followed by activate →
// restart, and a later quit must stop the restarted singletons.
const deferOrdinaryQuit = createDeferredQuit({
  quit: () => app.quit(),
  stop: () => stopBackgroundResources({ stopWorker: true }),
});
app.on('before-quit', event => {
  appQuitRequested = true;
  if (updateLifecycle.isPrepared()) return;
  updater.stop();
  deferOrdinaryQuit(event);
});

app.on('window-all-closed', () => {
  if (!updateLifecycle.isBlocked()) void stopBackgroundResources({ stopWorker: true }).catch(error => console.warn('Obelisk cleanup failed:', error));
  if (process.platform !== 'darwin') app.quit();
});

registerSessionQueryHandlers({ ipcMain, getDb: () => db, getRuntimePaths, getIndexerWorker: () => indexerWorker, runAppDbWrite });

ipcMain.handle('file-ref:open', async (_, ref) => {
  const { sessionId, path: rawPath, cwd, line, column } = ref || {};
  const roots = querySessionFileRoots(db, sessionId);
  // The renderer-supplied cwd only counts if this session actually recorded it.
  const scopedCwd = typeof cwd === 'string' && roots.includes(cwd) ? cwd : null;
  const filePath = resolveFileReference({ rawPath, cwd: scopedCwd, roots });
  if (!filePath) return { opened: false };
  const { editorScheme } = loadPersistedSettings();
  try {
    await shell.openExternal(buildEditorUrl({
      scheme: typeof editorScheme === 'string' ? editorScheme : undefined,
      filePath,
      line,
      column,
    }));
    return { opened: true, path: filePath };
  } catch {
    return { opened: false, path: filePath };
  }
});

registerRecapHandlers({
  ipcMain,
  BrowserWindow,
  clipboard,
  dialog,
  recapDir: RECAP_DIR,
  preloadPath: path.join(__dirname, '..', 'preload', 'index.js'),
  rendererIndexPath: path.join(__dirname, '..', 'renderer', 'index.html'),
});

ipcMain.handle('win:control', (event, action: WindowControlAction) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;
  switch (action) {
    case 'minimize': win.minimize(); return null;
    case 'toggle-maximize':
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
      return null;
    case 'close': win.close(); return null;
    default: throw new Error(`win:control accepts 'minimize', 'toggle-maximize', or 'close'; received "${String(action)}"`);
  }
});

function pathExists(filePath: string): Promise<boolean> {
  return fs.promises.access(filePath).then(() => true, () => false);
}

function loadPersistedSettings(result = readPersistedProviderSettings(SETTINGS_PATH)) {
  latestSettingsError = result.ok ? null : result.error ?? 'Obelisk settings are unavailable';
  if (latestSettingsError !== null) console.warn(latestSettingsError);
  return result.settings;
}

async function savePersistedSettings(settings: PersistedProviderSettings) {
  await fs.promises.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  const temporaryPath = `${SETTINGS_PATH}.${process.pid}.tmp`;
  try {
    await fs.promises.writeFile(temporaryPath, JSON.stringify(settings, null, 2));
    await fs.promises.rename(temporaryPath, SETTINGS_PATH);
    latestSettingsError = null;
  } catch (error) {
    try {
      await fs.promises.unlink(temporaryPath);
    } catch {
      // The temp file may never have been written; report the original error.
    }
    throw error;
  }
}

ipcMain.handle('settings:get', async () => {
  const persisted = loadPersistedSettings();
  const paths = getRuntimePaths(persisted);
  const copilotEditions = getCopilotEditions(persisted);
  const copilotCustomRoot = hasExplicitProviderRoot(persisted, 'copilot');
  const {
    providerRoots,
    providerRegistry,
    claudeDir,
    codexDir,
    configDir,
    dataDir,
    settingsPath,
    dbPath: dbFile,
  } = paths;
  const recapDir = persisted.recapDir || RECAP_DIR;
  let memoryCount = 0;
  let indexError: string | null = null;
  const sourceStats = new Map<string, { sessionCount: number; lastIndexed: string }>();

  if (db) {
    try {
      const rows = db.prepare<[], { source: string; session_count: number; last_indexed: string | null }>(`
        SELECT COALESCE(source, 'claude') AS source,
               COUNT(*) AS session_count,
               MAX(started_at) AS last_indexed
        FROM sessions
        GROUP BY COALESCE(source, 'claude')
      `).all();
      for (const row of rows) {
        sourceStats.set(row.source, {
          sessionCount: row.session_count || 0,
          lastIndexed: row.last_indexed || '',
        });
      }
      memoryCount = db.prepare<[], { c: number }>('SELECT COUNT(*) as c FROM memories WHERE deleted_at IS NULL').get()?.c || 0;
    } catch (error) {
      // Settings stays usable so the user can repoint sources or rebuild; the zero counts
      // must not pass for an empty index.
      indexError = `Index database could not be read: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const selectedCopilotEditions = copilotEditions.filter((edition) => edition.enabled);
  const codexConfiguredRoots = resolveCodexConfiguredRoots(persisted);
  const sourcePaths = new Set([
    ...(codexConfiguredRoots ?? []),
    ...providerRegistry.catalog().map((provider) => providerRoots[provider.id] ?? provider.defaultRoot),
    ...(!copilotCustomRoot ? selectedCopilotEditions.map((edition) => edition.path) : []),
  ]);
  const existingPaths = new Set((await Promise.all([...sourcePaths].map(async (sourcePath) => {
    try {
      await fs.promises.access(sourcePath);
      return sourcePath;
    } catch {
      return null;
    }
  }))).filter((sourcePath): sourcePath is string => sourcePath !== null));
  const copilotCatalogRoot = selectedCopilotEditions.find((edition) => existingPaths.has(edition.path))
    ?? selectedCopilotEditions[0];
  const codexCatalogRoot = codexConfiguredRoots?.find((root) => existingPaths.has(root))
    ?? codexConfiguredRoots?.[0];
  const sources = buildSourceCatalog({
    registry: providerRegistry,
    roots: {
      ...providerRoots,
      ...(!copilotCustomRoot ? { copilot: copilotCatalogRoot?.path ?? '' } : {}),
      ...(codexCatalogRoot !== undefined ? { codex: codexCatalogRoot } : {}),
    },
    stats: sourceStats,
    sourceIssues: latestSourceIssues,
    pathExists: (sourcePath) => existingPaths.has(sourcePath),
  }).map((source) => {
    if (source.id !== 'copilot' || copilotCustomRoot) return source;
    if (selectedCopilotEditions.length === 0) {
      return { ...source, exists: false, status: 'warn', statusText: 'No folders selected' };
    }
    return source;
  });
  const sessionCount = sources.reduce((sum, source) => sum + source.sessionCount, 0);
  const lastIndexed = sources.map((source) => source.lastIndexed).filter(Boolean).sort().at(-1) || '';
  const connected = latestSettingsError === null
    && sources.some((source) => source.status !== 'error');

  return {
    version: app.getVersion(),
    providerRoots,
    copilotEditions,
    copilotCustomRoot,
    claudeDir,
    codexDir,
    configDir,
    dataDir,
    settingsPath,
    dbPath: dbFile,
    recapDir,
    autoRefresh: persisted.autoRefresh !== false,
    editorScheme: persisted.editorScheme || DEFAULT_EDITOR_SCHEME,
    sources,
    memoryCount,
    sessionCount,
    lastIndexed,
    status: connected ? 'ok' : 'error',
    statusText: latestSettingsError ?? (connected ? 'Connected' : 'No source folders found'),
    settingsRecovery: latestSettingsRecovery,
    indexError,
  };
});

// A save yields while preserving a rejected file. Keep the complete read/backup/write
// sequence ordered so another save cannot overwrite a stale snapshot or race its backup.
// updateLifecycle still tracks queued saves immediately so update cleanup waits for them.
let settingsWriteTail: Promise<unknown> = Promise.resolve();
ipcMain.handle('settings:set', (_, key, value) => updateLifecycle.mutate(() => {
  const write = settingsWriteTail.then(async () => {
    const currentRead = readPersistedProviderSettings(SETTINGS_PATH);
    const persisted = loadPersistedSettings(currentRead);
    // Preserve a file the shared reader rejected before the write below replaces it. Runs
    // before the save, using this queued write's fresh read rather than latestSettingsError,
    // so a stale flag from an earlier settings:get cannot skip or repeat it. Throwing here is the
    // point: with no preserved copy the overwrite is the silent #42 loss.
    const backupPath = await preserveRejectedSettings(SETTINGS_PATH, {
      rename: (from, to) => fs.promises.rename(from, to),
      copyFile: (from, to) => fs.promises.copyFile(from, to),
    }, currentRead);
    const providerRootChanged = setPersistedSetting(persisted, key, value);
    await savePersistedSettings(persisted);
    if (backupPath !== null) {
      latestSettingsRecovery = `Previous settings could not be read. They were preserved at ${backupPath}`;
      console.warn(latestSettingsRecovery);
    }

    if (key === 'autoRefresh') {
      if (value === false && indexerService) {
        await stopIndexerServiceAndWait();
      } else if (value !== false) {
        if (indexerService) await stopIndexerServiceAndWait();
        startIndexerService({ buildOnStart: true });
      }
    }

    const knownLegacyRootChanged = createBuiltinProviderRegistry({
      claude: DEFAULT_CLAUDE_DIR,
    }).catalog().some((provider) => key === `${provider.id}Dir`);
    if (providerRootChanged || knownLegacyRootChanged) {
      await stopIndexerServiceAndWait();
      const paths = getRuntimePaths(persisted);
      migrateLegacyDbIfNeeded(paths);
      openDb(paths.dbPath);
      if (persisted.autoRefresh !== false) {
        startIndexerService({ buildOnStart: true });
      }
      notifyIndexUpdated({ inventoryIssues: [] });
    }
    // The save is what moves a rejected file aside, so the notice is returned here as well as
    // from settings:get: the paths that save without reloading settings (editor, recap
    // directory, auto-refresh) would otherwise never see it.
    return { settingsRecovery: latestSettingsRecovery };
  });
  // A refused save must not prevent a later retry after the file becomes writable.
  settingsWriteTail = write.catch(() => {});
  return write;
}));

ipcMain.handle('settings:browseFolder', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;
  const { filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: 'Select session data folder',
  });
  if (filePaths && filePaths[0]) return filePaths[0];
  return null;
});

ipcMain.handle('settings:revealPath', async (_, p) => {
  if (await pathExists(p)) shell.showItemInFolder(p);
});

ipcMain.handle('settings:rebuildIndex', () => updateLifecycle.mutate(async () => {
  if (!indexerWorker) return null;
  const persisted = loadPersistedSettings();
  if (latestSettingsError !== null) throw new Error(latestSettingsError);
  const paths = getRuntimePaths(persisted);
  const tempDbPath = rebuildTempDbPath(paths.dbPath);
  await stopIndexerServiceAndWait({ waitForIdle: false });
  if (indexerWorker) {
    await Promise.resolve(indexerWorker.stop());
    indexerWorker = createWorkerBuildIndex();
  }
  let writerLease: ReturnType<typeof acquireWriterLease> = null;
  let rebuildWatchHints: string[] = [];
  try {
    const writerLeasePath = writerLockPathFor(paths.dbPath);
    writerLease = acquireWriterLease({
      lockPath: writerLeasePath,
      openDb: lockPath => new Database(lockPath),
      waitMs: 2000,
    });
    if (!writerLease) {
      return {
        files: 0,
        latestSourceMtime: 0,
        affectedSessionIds: [],
        ftsRebuilt: false,
        skipped: 0,
        skippedFiles: [],
        deferred: true,
        complete: false,
        incompleteProviders: [],
        inventoryIssues: [],
        reason: 'writer_busy',
      };
    }
    migrateLegacyDbIfNeeded(paths, { writerLeaseMode: 'caller-held' });
    const result = await indexerWorker.buildIndex({
      reason: 'manual-rebuild',
      force: true,
      providerRoots: paths.providerRoots,
      providerSettings: paths.providerSettings,
      claudeDir: paths.claudeDir,
      codexDir: paths.codexDir,
      projectsDir: paths.projectsDir,
      dbPath: tempDbPath,
      preserveDbPath: await pathExists(paths.dbPath) ? paths.dbPath : null,
      writerLeasePath,
      writerLeaseMode: 'caller-held',
    });
    rebuildWatchHints = result?.watchHints ?? [];
    if (result?.deferred || result?.complete !== true) {
      notifyIndexUpdated(result);
      return result;
    }
    closeDb();
    replaceDbWithTemp(tempDbPath, paths.dbPath);
    openDb(paths.dbPath, { writerLeaseMode: 'caller-held' });
    notifyIndexUpdated(result);
    return result;
  } finally {
    try {
      cleanupDbFiles(tempDbPath);
      if (!db) {
        try {
          openDb(paths.dbPath, {
            writerLeaseMode: writerLease ? 'caller-held' : 'acquire',
          });
        } catch (error) {
          console.warn(`Obelisk DB reopen after rebuild failed: ${(error as Error).message}`);
        }
      }
    } finally {
      writerLease?.release();
      if (loadPersistedSettings().autoRefresh !== false) {
        const service = startIndexerService({ buildOnStart: false });
        if (rebuildWatchHints.length) {
          // The rebuild bypassed the service's own build path, so seed the
          // hot set from its hints here.
          service?.promoteWatchHints?.(rebuildWatchHints);
        } else {
          // A failed/deferred rebuild produced no hints and the old hot set
          // died with the old watcher. Run one reconciling build through the
          // service — its deferral retry absorbs writer-busy — so long-open
          // transcripts are re-seeded now, not at the next 5-min reconcile.
          service?.runBuildNow('reconcile');
        }
      }
    }
  }
}));
