import { app, BrowserWindow, ipcMain, clipboard, dialog, shell, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import chokidar from 'chokidar';
import { writeHeartbeat } from './indexer.ts';
import { createIndexerService } from './indexer-service.ts';
import { createWorkerBuildIndex } from './indexer-worker-client.ts';
import { buildRecapExportQuery } from './recap-capture-query.ts';
import { acquireWriterLease, writerLockPathFor } from '../../../packages/core/src/writer-lease.ts';
import { migrateCoreSchemaColumns, migrateFtsTokenizer, resolveFtsTokenizer } from '../../../packages/core/src/schema-migrations.ts';
import { createBuiltinProviderRegistry } from '../../../packages/core/src/providers/builtins.ts';
import {
  buildSourceCatalog,
  resolveProviderRoots,
  setPersistedSetting,
} from './provider-settings.ts';
import type {
  SessionPatchCursor,
  SessionPatchSnapshot,
  SessionMetadata,
  SourceQueryOptions,
} from '../shared/ipc-types.ts';
import type {
  SessionDetailAssemblyInput,
  SessionMessageRow,
  SessionSubagentRow,
  SessionSummaryRow,
  SessionToolCallRow,
  SessionToolResultRow,
  SessionWorkflowRow,
} from '../shared/session-detail-types.ts';
import { createSessionPatch } from '../shared/session-patch.mjs';
import { assembleSessionDetail } from '../shared/session-detail-assembly.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
    } catch {}
  }
  // Fallback: native Windows path (for future native Claude Code on Windows)
  return path.join(os.homedir(), '.claude');
}

const DEFAULT_CLAUDE_DIR = detectClaudeDir();
const DEFAULT_CODEX_DIR = path.join(os.homedir(), '.codex');

let db;
let indexerService;
let indexerWorker;

type WriterLeaseMode = 'acquire' | 'caller-held';

function acquireAppWriterLease(dbPath: string, waitMs = 0) {
  return acquireWriterLease({
    lockPath: writerLockPathFor(dbPath),
    openDb: lockPath => new Database(lockPath),
    waitMs,
  });
}

function getRuntimePaths(persisted = loadPersistedSettings()) {
  const defaultRegistry = createBuiltinProviderRegistry({
    claude: DEFAULT_CLAUDE_DIR,
    codex: DEFAULT_CODEX_DIR,
  });
  const providerRoots = resolveProviderRoots(defaultRegistry, persisted);
  const providerRegistry = createBuiltinProviderRegistry(providerRoots);
  const claudeDir = providerRoots['claude'] ?? DEFAULT_CLAUDE_DIR;
  const codexDir = providerRoots['codex'] ?? DEFAULT_CODEX_DIR;
  return {
    providerRoots,
    providerRegistry,
    claudeDir,
    codexDir,
    dbPath: path.join(OBELISK_DIR, 'obelisk.sqlite'),
    projectsDir: path.join(claudeDir, 'projects'),
  };
}

function migrateLegacyDbIfNeeded(
  paths = getRuntimePaths(),
  { writerLeaseMode = 'acquire' }: { writerLeaseMode?: WriterLeaseMode } = {},
) {
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
    console.warn?.(`Obelisk legacy DB migration skipped: ${(error as Error).message}`);
    return false;
  } finally {
    lease?.release();
  }
}

function rebuildTempDbPath(dbPath) {
  return path.join(
    path.dirname(dbPath),
    `${path.basename(dbPath)}.rebuild-${process.pid}-${Date.now()}.tmp`,
  );
}

function dbFileSet(dbPath) {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
}

function cleanupDbFiles(dbPath) {
  for (const filePath of dbFileSet(dbPath)) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {}
  }
}

function replaceDbWithTemp(tempDbPath, dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      fs.rmSync(sidecar, { force: true });
    } catch {}
  }
  fs.renameSync(tempDbPath, dbPath);
  for (const suffix of ['-wal', '-shm']) {
    const tempSidecar = `${tempDbPath}${suffix}`;
    if (!fs.existsSync(tempSidecar)) continue;
    fs.renameSync(tempSidecar, `${dbPath}${suffix}`);
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

function migrateDb(db) {
  if (typeof db.exec !== 'function' || typeof db.prepare !== 'function') return;
  migrateCoreSchemaColumns(db);
  const schemaPath = resolveSchemaPath();
  if (schemaPath) db.exec(fs.readFileSync(schemaPath, 'utf8'));
  migrateCoreSchemaColumns(db);
  migrateFtsTokenizer(db, resolveFtsTokenizer());
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

function runAppDbWrite(work: () => void): boolean {
  if (!db) return false;
  const lease = acquireAppWriterLease(getRuntimePaths().dbPath, 250);
  if (!lease) {
    throw new Error('Obelisk index writer is busy; memory change was not applied');
  }
  try {
    work();
    return true;
  } finally {
    lease.release();
  }
}

function notifyIndexUpdated(result: { affectedSessionIds?: unknown } = {}) {
  const affectedSessionIds = Array.isArray(result.affectedSessionIds)
    ? [...new Set(result.affectedSessionIds.filter(Boolean))]
    : [];
  const payload = { affectedSessionIds };
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('obelisk:index-updated', payload);
    for (const sessionId of affectedSessionIds) {
      win.webContents.send('obelisk:session-updated', { sessionId });
    }
  }
}

function sourceWhereClause(opts: SourceQueryOptions = {}, column = "source"): { sql: string; params: unknown[] } {
  if (opts.source === 'all') return { sql: '', params: [] };
  if (opts.source) return { sql: `COALESCE(${column}, 'claude') = ?`, params: [opts.source] };
  return { sql: `COALESCE(${column}, 'claude') = 'claude'`, params: [] };
}

function appendWhere(sql, params, clause) {
  if (!clause) return sql;
  return `${sql}${sql.includes(' WHERE ') ? ' AND ' : ' WHERE '}${clause}`;
}

function startIndexerService({ buildOnStart = false } = {}) {
  const paths = getRuntimePaths();
  migrateLegacyDbIfNeeded(paths);
  indexerService = createIndexerService({
    projectsDir: paths.projectsDir,
    watchDirs: paths.providerRegistry.watchRoots(paths.providerRoots),
    buildIndex: async ({ reason, changedPaths }) => {
      const result = await indexerWorker.buildIndex({
        reason,
        changedPaths,
        providerRoots: paths.providerRoots,
        claudeDir: paths.claudeDir,
        codexDir: paths.codexDir,
        projectsDir: paths.projectsDir,
        dbPath: paths.dbPath,
      });
      if (result?.deferred) {
        if (Array.isArray(result.affectedSessionIds) && result.affectedSessionIds.length) {
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
  indexerService.start({ buildOnStart });
  return indexerService;
}

function startBackgroundResources({ runStartupBuild = false } = {}) {
  if (!indexerWorker) indexerWorker = createWorkerBuildIndex();
  const paths = getRuntimePaths();
  migrateLegacyDbIfNeeded(paths);
  openDb(paths.dbPath);
  if (!indexerService) {
    const service = startIndexerService({ buildOnStart: false });
    if (runStartupBuild) service.runBuildNow('startup');
  }
  if (!obeliskWatcher) startObeliskWatcher();
}

async function stopIndexerServiceAndWait({ waitForIdle = true } = {}) {
  const service = indexerService;
  if (!service) return;
  service.stop();
  if (waitForIdle && typeof service.idle === 'function') await service.idle();
  if (indexerService === service) indexerService = null;
}

async function stopBackgroundResources({ stopWorker = false } = {}) {
  await stopIndexerServiceAndWait();
  if (stopWorker && indexerWorker) {
    indexerWorker.stop();
    indexerWorker = null;
  }
  if (obeliskWatcher) {
    const watcher = obeliskWatcher;
    obeliskWatcher = null;
    if (typeof watcher.close === 'function') await Promise.resolve(watcher.close());
  }
  closeDb();
}

function createWindow() {
  const isDev = process.argv.includes('--dev') || !!process.env.ELECTRON_RENDERER_URL;
  const shouldOpenDevTools = process.argv.includes('--devtools');

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 10 },
    backgroundColor: '#0a0b14',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: isDev || shouldOpenDevTools,
    },
  });

  // Prevent Electron's built-in zoom so Cmd+=/- reaches the renderer
  win.webContents.on('before-input-event', (event, input) => {
    if ((input.meta || input.control) && ['+', '=', '-', '0'].includes(input.key)) {
      win.webContents.setZoomLevel(0);
    }
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

const OBELISK_DIR = path.join(os.homedir(), '.obelisk');
const RECAP_DIR = path.join(OBELISK_DIR, 'recap');
let obeliskWatcher: import("chokidar").FSWatcher | null = null;

function startObeliskWatcher() {
  if (obeliskWatcher) return obeliskWatcher;
  if (!fs.existsSync(OBELISK_DIR)) {
    fs.mkdirSync(OBELISK_DIR, { recursive: true });
  }
  obeliskWatcher = chokidar.watch(OBELISK_DIR, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    ignored: (p, stats) => {
      if (stats?.isDirectory()) return false;
      if (!stats) return false;
      return !p.endsWith('.md') && !p.endsWith('.json');
    },
  });
  obeliskWatcher.on('add', onObeliskChange);
  obeliskWatcher.on('change', onObeliskChange);
  obeliskWatcher.on('unlink', onObeliskChange);
  return obeliskWatcher;
}

function onObeliskChange(filePath) {
  if (filePath.startsWith(RECAP_DIR)) {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('obelisk:recap-updated', filePath);
    }
  }
}

app.whenReady().then(() => {
  startBackgroundResources({ runStartupBuild: true });
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      startBackgroundResources({ runStartupBuild: true });
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  void stopBackgroundResources({ stopWorker: true });
});

app.on('window-all-closed', () => {
  void stopBackgroundResources({ stopWorker: true });
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC Handlers ---

function querySessionMessages(sessionId: string): SessionMessageRow[] {
  if (!db) return [];
  return db.prepare(`
    SELECT m.uuid, m.session_id, m.type, m.parent_uuid, m.timestamp, m.role, m.text, m.model,
           m.is_sidechain, m.agent_id, m.input_tokens, m.output_tokens, m.cwd, m.skill, m.turn_duration_ms,
           m.content_type, m.is_meta, m.visibility, m.source
    FROM messages m WHERE m.session_id = ? AND m.agent_id IS NULL ORDER BY m.timestamp, m.uuid
  `).all(sessionId) as SessionMessageRow[];
}

function querySessionToolCalls(sessionId: string): SessionToolCallRow[] {
  if (!db) return [];
  return db.prepare(`SELECT * FROM tool_calls WHERE session_id = ?`).all(sessionId) as SessionToolCallRow[];
}

function querySessionToolResults(sessionId: string): SessionToolResultRow[] {
  if (!db) return [];
  return db.prepare(`SELECT * FROM tool_results WHERE session_id = ?`).all(sessionId) as SessionToolResultRow[];
}

function querySessionSubagents(sessionId: string): SessionSubagentRow[] {
  if (!db) return [];
  return db.prepare(`SELECT * FROM subagents WHERE session_id = ?`).all(sessionId) as SessionSubagentRow[];
}

function querySessionWorkflows(sessionId: string): SessionWorkflowRow[] {
  if (!db) return [];
  const workflows = db.prepare(`SELECT * FROM workflows WHERE session_id = ?`).all(sessionId) as SessionWorkflowRow[];
  for (const workflow of workflows) {
    workflow.agents = db.prepare(`SELECT * FROM workflow_agents WHERE run_id = ?`).all(workflow.run_id) as SessionWorkflowRow['agents'];
  }
  return workflows;
}

function querySessionSummaries(sessionId: string): SessionSummaryRow[] {
  if (!db) return [];
  return db.prepare(`SELECT * FROM summaries WHERE session_id = ?`).all(sessionId) as SessionSummaryRow[];
}

function querySessionSnapshot(sessionId: string): SessionDetailAssemblyInput {
  return {
    messages: querySessionMessages(sessionId),
    toolCalls: querySessionToolCalls(sessionId),
    toolResults: querySessionToolResults(sessionId),
    subagents: querySessionSubagents(sessionId),
    workflows: querySessionWorkflows(sessionId),
    summaries: querySessionSummaries(sessionId),
  };
}

function querySessionDisplaySnapshot(sessionId: string): SessionPatchSnapshot {
  const snapshot = querySessionSnapshot(sessionId);
  const detail = assembleSessionDetail(snapshot);
  return {
    messages: detail.messages,
    workflows: detail.workflows,
    summaries: detail.summaries,
  };
}

const SESSION_METADATA_COLUMNS = [
  'id',
  'title',
  'project',
  'project_path',
  'started_at',
  'ended_at',
  'git_branch',
  'version',
  'message_count',
  'jsonl_path',
  'source',
].join(', ');

function querySessionMetadata(sessionId: string): SessionMetadata | null {
  if (!db) return null;
  return (
    db.prepare(`SELECT ${SESSION_METADATA_COLUMNS} FROM sessions WHERE id = ?`).get(sessionId) as SessionMetadata | undefined
  ) || null;
}

ipcMain.handle('db:getSessions', (_, opts = {}) => {
  if (!db) return [];
  const { project, limit = 200 } = opts;
  let sql = `SELECT ${SESSION_METADATA_COLUMNS} FROM sessions`;
  const params: unknown[] = [];
  const sourceFilter = sourceWhereClause(opts);
  if (sourceFilter.sql) {
    sql = appendWhere(sql, params, sourceFilter.sql);
    params.push(...sourceFilter.params);
  }
  if (project) { sql = appendWhere(sql, params, `project LIKE ?`); params.push(project); }
  sql += ` ORDER BY COALESCE(ended_at, started_at) DESC LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params);
});

ipcMain.handle('db:getSessionMessages', (_, sessionId) => {
  return querySessionMessages(sessionId);
});

ipcMain.handle('db:getSessionToolCalls', (_, sessionId) => {
  return querySessionToolCalls(sessionId);
});

ipcMain.handle('db:getSessionToolResults', (_, sessionId) => {
  return querySessionToolResults(sessionId);
});

ipcMain.handle('db:getSessionSubagents', (_, sessionId) => {
  return querySessionSubagents(sessionId);
});

ipcMain.handle('db:getSessionWorkflows', (_, sessionId) => {
  return querySessionWorkflows(sessionId);
});

ipcMain.handle('db:getSessionPatch', (
  _event: IpcMainInvokeEvent,
  sessionId: string,
  cursor: SessionPatchCursor,
) => {
  if (!db) return null;
  return {
    ...createSessionPatch(querySessionDisplaySnapshot(sessionId), cursor),
    session: querySessionMetadata(sessionId),
  };
});

ipcMain.handle('db:getSubagentMessages', (_, agentId) => {
  if (!db) return [];
  return db.prepare(`
    SELECT m.uuid, m.session_id, m.type, m.parent_uuid, m.timestamp, m.role, m.text, m.model,
           m.is_sidechain, m.agent_id, m.input_tokens, m.output_tokens, m.cwd, m.skill, m.turn_duration_ms,
           m.content_type, m.is_meta, m.visibility, m.source
    FROM messages m WHERE m.agent_id = ? ORDER BY m.timestamp, m.uuid
  `).all(agentId);
});

ipcMain.handle('db:getSubagentToolCalls', (_, agentId) => {
  if (!db) return [];
  return db.prepare(`
    SELECT tc.* FROM tool_calls tc
    JOIN messages m ON m.uuid = tc.message_uuid
    WHERE m.agent_id = ?
  `).all(agentId);
});

ipcMain.handle('db:getSubagentToolResults', (_, agentId) => {
  if (!db) return [];
  return db.prepare(`
    SELECT tr.* FROM tool_results tr
    JOIN messages m ON m.uuid = tr.message_uuid
    WHERE m.agent_id = ?
  `).all(agentId);
});

ipcMain.handle('db:getSessionSummaries', (_, sessionId) => {
  return querySessionSummaries(sessionId);
});

ipcMain.handle('db:getMemories', () => {
  if (!db) return [];
  return db.prepare(`
    SELECT id, session_id, project, message_start, message_end, path, anchors, summary, created_at, deleted_at, deleted_reason
    FROM memories ORDER BY created_at DESC
  `).all();
});

ipcMain.handle('db:getMessageFullText', (_, uuid) => {
  if (!db) return null;
  const msg = db.prepare('SELECT * FROM messages WHERE uuid=?').get(uuid);
  if (!msg) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(msg.session_id) ?? null;
  const subagent = msg.agent_id
    ? db.prepare('SELECT * FROM subagents WHERE agent_id=?').get(msg.agent_id) ?? null
    : null;
  const workflowAgent = msg.agent_id
    ? db.prepare('SELECT * FROM workflow_agents WHERE agent_id=?').get(msg.agent_id) ?? null
    : null;
  const paths = getRuntimePaths();
  const raw = paths.providerRegistry.raw({
    source: msg.source || session?.source || 'claude',
    messageUuid: String(uuid),
    session,
    agentId: msg.agent_id || null,
    subagent,
    workflowAgent,
  });
  return raw?.messageText ?? msg.text ?? null;
});

ipcMain.handle('db:readMemoryFile', (_, filePath) => {
  try {
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf-8');
    return null;
  } catch { return null; }
});

ipcMain.handle('db:archiveMemory', (_, id, reason) => {
  return runAppDbWrite(() => {
    db.prepare(`UPDATE memories SET deleted_at = ?, deleted_reason = ? WHERE id = ?`)
      .run(new Date().toISOString(), reason || 'Archived via panel', id);
  });
});

ipcMain.handle('db:restoreMemory', (_, id) => {
  return runAppDbWrite(() => {
    db.prepare(`UPDATE memories SET deleted_at = NULL, deleted_reason = NULL WHERE id = ?`).run(id);
  });
});

ipcMain.handle('db:getProjects', (_, opts = {}) => {
  if (!db) return [];
  const sourceFilter = sourceWhereClause(opts);
  const where = sourceFilter.sql ? `WHERE ${sourceFilter.sql}` : '';
  return db.prepare(`
    SELECT project, project_path, COUNT(*) as session_count,
           MAX(COALESCE(ended_at, started_at)) as last_active
    FROM sessions ${where ? `${where} AND` : 'WHERE'} project IS NOT NULL
    GROUP BY project ORDER BY last_active DESC
  `).all(...sourceFilter.params);
});

ipcMain.handle('db:getStats', (_, opts = {}) => {
  if (!db) return { sessions: 0, memories: 0, memoriesArchived: 0 };
  const sourceFilter = sourceWhereClause(opts);
  const where = sourceFilter.sql ? `WHERE ${sourceFilter.sql}` : '';
  const sessions = db.prepare(`SELECT COUNT(*) as c FROM sessions ${where}`).get(...sourceFilter.params)?.c || 0;
  const memories = db.prepare('SELECT COUNT(*) as c FROM memories WHERE deleted_at IS NULL').get()?.c || 0;
  const memoriesArchived = db.prepare('SELECT COUNT(*) as c FROM memories WHERE deleted_at IS NOT NULL').get()?.c || 0;
  return { sessions, memories, memoriesArchived };
});

ipcMain.handle('db:getUsageStats', (_, opts = {}) => {
  if (!db) return { daily: [], totalTokens: 0, peakDay: null, longestTurn: null };
  const sourceFilter = sourceWhereClause(opts, 'source');
  const sourceSql = sourceFilter.sql ? `AND ${sourceFilter.sql}` : '';

  const daily = db.prepare(`
    SELECT DATE(timestamp) as day,
           SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)) as tokens
    FROM messages
    WHERE timestamp IS NOT NULL AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL)
      ${sourceSql}
    GROUP BY DATE(timestamp)
    ORDER BY day
  `).all(...sourceFilter.params);

  const totalTokens = db.prepare(`
    SELECT SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)) as total
    FROM messages
    ${sourceFilter.sql ? `WHERE ${sourceFilter.sql}` : ''}
  `).get(...sourceFilter.params)?.total || 0;

  const peakDay = db.prepare(`
    SELECT DATE(timestamp) as day,
           SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)) as tokens
    FROM messages
    WHERE timestamp IS NOT NULL AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL)
      ${sourceSql}
    GROUP BY DATE(timestamp)
    ORDER BY tokens DESC
    LIMIT 1
  `).get(...sourceFilter.params) || null;

  const longestTurn = db.prepare(`
    SELECT turn_duration_ms, uuid, session_id, timestamp
    FROM messages
    WHERE turn_duration_ms IS NOT NULL
      ${sourceSql}
    ORDER BY turn_duration_ms DESC
    LIMIT 1
  `).get(...sourceFilter.params) || null;

  return { daily, totalTokens, peakDay, longestTurn };
});

// --- Capture ---

const EXPORT_WIDTH = 540;
const EXPORT_HEIGHT = 675;

async function createExportCapture(parentWin, query) {
  const exportWin = new BrowserWindow({
    width: EXPORT_WIDTH,
    height: EXPORT_HEIGHT,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true,
      deviceScaleFactor: 2,
    } as Electron.WebPreferences,
  });

  const isDev = process.argv.includes('--dev') || !!process.env.ELECTRON_RENDERER_URL;
  const url = isDev
    ? `${process.env.ELECTRON_RENDERER_URL || 'http://localhost:5173'}/#/recap-export?${query}`
    : `file://${path.join(__dirname, '..', 'renderer', 'index.html')}#/recap-export?${query}`;

  await exportWin.loadURL(url);
  await waitForExportReady(exportWin.webContents);

  const image = await exportWin.webContents.capturePage({
    x: 0, y: 0, width: EXPORT_WIDTH, height: EXPORT_HEIGHT,
  });
  exportWin.close();
  return image;
}

async function waitForExportReady(webContents, timeoutMs = 2500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const ready = await webContents.executeJavaScript('window.__OBELISK_RECAP_EXPORT_READY__ === true', true);
      if (ready) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
}

ipcMain.handle('capture:export', async (event, { cardIdx, archetype, filename } = {}) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;
  const query = buildRecapExportQuery({ cardIdx, archetype, filename });
  const image = await createExportCapture(win, query);
  const { filePath } = await dialog.showSaveDialog(win, {
    defaultPath: `obelisk-recap-${cardIdx + 1}.png`,
    filters: [{ name: 'PNG', extensions: ['png'] }],
  });
  if (!filePath) return null;
  fs.writeFileSync(filePath, image.toPNG());
  return filePath;
});

ipcMain.handle('capture:copy', async (event, { cardIdx, archetype, filename } = {}) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  const query = buildRecapExportQuery({ cardIdx, archetype, filename });
  const image = await createExportCapture(win, query);
  clipboard.writeImage(image);
  return true;
});

// --- Recap files ---

ipcMain.handle('recap:list', () => {
  if (!fs.existsSync(RECAP_DIR)) return [];
  return fs.readdirSync(RECAP_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse();
});

ipcMain.handle('recap:read', (_, filename) => {
  const filePath = path.join(RECAP_DIR, path.basename(filename));
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch { return null; }
});

// --- Settings ---

const SETTINGS_PATH = path.join(OBELISK_DIR, 'settings.json');

function loadPersistedSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
  } catch {}
  return {};
}

function savePersistedSettings(settings) {
  if (!fs.existsSync(OBELISK_DIR)) fs.mkdirSync(OBELISK_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

ipcMain.handle('settings:get', () => {
  const persisted = loadPersistedSettings();
  const paths = getRuntimePaths(persisted);
  const { providerRoots, providerRegistry, claudeDir, codexDir, dbPath: dbFile } = paths;
  const recapDir = persisted.recapDir || RECAP_DIR;
  let memoryCount = 0;
  const sourceStats = new Map<string, { sessionCount: number; lastIndexed: string }>();

  if (db) {
    try {
      const rows = db.prepare(`
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
      memoryCount = db.prepare('SELECT COUNT(*) as c FROM memories WHERE deleted_at IS NULL').get()?.c || 0;
    } catch {}
  }
  const sources = buildSourceCatalog({
    registry: providerRegistry,
    roots: providerRoots,
    stats: sourceStats,
    pathExists: fs.existsSync,
  });
  const sessionCount = sources.reduce((sum, source) => sum + source.sessionCount, 0);
  const lastIndexed = sources.map((source) => source.lastIndexed).filter(Boolean).sort().at(-1) || '';
  const connected = sources.some((source) => source.status !== 'error');

  return {
    providerRoots,
    claudeDir,
    codexDir,
    dbPath: dbFile,
    recapDir,
    autoRefresh: persisted.autoRefresh !== false,
    sources,
    memoryCount,
    sessionCount,
    lastIndexed,
    status: connected ? 'ok' : 'error',
    statusText: connected ? 'Connected' : 'No source folders found',
  };
});

ipcMain.handle('settings:set', async (_, key, value) => {
  const persisted = loadPersistedSettings();
  const providerRootChanged = setPersistedSetting(persisted, key, value);
  savePersistedSettings(persisted);

  if (key === 'autoRefresh') {
    if (value === false && indexerService) {
      await stopIndexerServiceAndWait();
    } else if (value !== false && indexerService) {
      await stopIndexerServiceAndWait();
      startIndexerService({ buildOnStart: false });
    }
  }

  const knownLegacyRootChanged = createBuiltinProviderRegistry({
    claude: DEFAULT_CLAUDE_DIR,
    codex: DEFAULT_CODEX_DIR,
  }).catalog().some((provider) => key === `${provider.id}Dir`);
  if (providerRootChanged || knownLegacyRootChanged) {
    await stopIndexerServiceAndWait();
    const paths = getRuntimePaths(persisted);
    migrateLegacyDbIfNeeded(paths);
    openDb(paths.dbPath);
    if (persisted.autoRefresh !== false) {
      startIndexerService({ buildOnStart: true });
    }
    notifyIndexUpdated();
  }
  return true;
});

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

ipcMain.handle('settings:revealPath', (_, p) => {
  if (fs.existsSync(p)) shell.showItemInFolder(p);
});

ipcMain.handle('settings:rebuildIndex', async () => {
  if (!indexerWorker) return null;
  const persisted = loadPersistedSettings();
  const paths = getRuntimePaths(persisted);
  const tempDbPath = rebuildTempDbPath(paths.dbPath);
  const shouldRestartWatcher = persisted.autoRefresh !== false;
  await stopIndexerServiceAndWait({ waitForIdle: false });
  if (indexerWorker) {
    await Promise.resolve(indexerWorker.stop());
    indexerWorker = createWorkerBuildIndex();
  }
  cleanupDbFiles(tempDbPath);
  let writerLease: ReturnType<typeof acquireWriterLease> = null;
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
        reason: 'writer_busy',
      };
    }
    migrateLegacyDbIfNeeded(paths, { writerLeaseMode: 'caller-held' });
    const result = await indexerWorker.buildIndex({
      reason: 'manual-rebuild',
      force: true,
      providerRoots: paths.providerRoots,
      claudeDir: paths.claudeDir,
      codexDir: paths.codexDir,
      projectsDir: paths.projectsDir,
      dbPath: tempDbPath,
      preserveDbPath: fs.existsSync(paths.dbPath) ? paths.dbPath : null,
      writerLeasePath,
      writerLeaseMode: 'caller-held',
    });
    if (result?.deferred) return result;
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
          console.warn?.(`Obelisk DB reopen after rebuild failed: ${(error as Error).message}`);
        }
      }
    } finally {
      writerLease?.release();
      if (shouldRestartWatcher) startIndexerService({ buildOnStart: false });
    }
  }
});
