// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Recap files and recap card capture (PNG export / clipboard). Electron objects
// are injected rather than imported; see session-queries.ts for why.

import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow as BrowserWindowClass, Clipboard, Dialog, IpcMain } from 'electron';
import { buildRecapExportQuery } from './recap-capture-query.ts';

interface RecapHandlerDeps {
  ipcMain: Pick<IpcMain, 'handle'>;
  BrowserWindow: typeof BrowserWindowClass;
  clipboard: Pick<Clipboard, 'writeImage'>;
  dialog: Pick<Dialog, 'showSaveDialog'>;
  recapDir: string;
  preloadPath: string;
  rendererIndexPath: string;
}

export function registerRecapHandlers({
  ipcMain,
  BrowserWindow,
  clipboard,
  dialog,
  recapDir,
  preloadPath,
  rendererIndexPath,
}: RecapHandlerDeps): void {
  const EXPORT_WIDTH = 540;
  const EXPORT_HEIGHT = 675;

  async function createExportCapture(query: string) {
    const exportWin = new BrowserWindow({
      width: EXPORT_WIDTH,
      height: EXPORT_HEIGHT,
      show: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        offscreen: true,
        deviceScaleFactor: 2,
      } as Electron.WebPreferences,
    });

    const isDev = process.argv.includes('--dev') || !!process.env.ELECTRON_RENDERER_URL;
    const url = isDev
      ? `${process.env.ELECTRON_RENDERER_URL || 'http://localhost:5173'}/#/recap-export?${query}`
      : `file://${rendererIndexPath}#/recap-export?${query}`;

    await exportWin.loadURL(url);
    await waitForExportReady(exportWin.webContents);

    const image = await exportWin.webContents.capturePage({
      x: 0, y: 0, width: EXPORT_WIDTH, height: EXPORT_HEIGHT,
    });
    exportWin.close();
    return image;
  }

  async function waitForExportReady(webContents: Electron.WebContents, timeoutMs = 2500) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try {
        const ready = await webContents.executeJavaScript('window.__OBELISK_RECAP_EXPORT_READY__ === true', true);
        if (ready) return true;
      } catch {
        // The export page is still loading; poll until the timeout.
      }
      await new Promise(r => setTimeout(r, 50));
    }
    return false;
  }

  ipcMain.handle('capture:export', async (event, { cardIdx, archetype, filename } = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;
    const query = buildRecapExportQuery({ cardIdx, archetype, filename });
    const image = await createExportCapture(query);
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
    const image = await createExportCapture(query);
    clipboard.writeImage(image);
    return true;
  });

  ipcMain.handle('recap:list', () => {
    if (!fs.existsSync(recapDir)) return [];
    return fs.readdirSync(recapDir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse();
  });

  ipcMain.handle('recap:read', (_, filename) => {
    const filePath = path.join(recapDir, path.basename(filename));
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch { return null; }
  });
}
