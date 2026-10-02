// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { setTimeout as delay } from 'node:timers/promises';
import { loadSparkleBridge } from 'electron-sparkle-updater';
import electronUpdater from 'electron-updater';
import type { UpdateBackend, UpdateEvent } from '../shared/update-types.ts';

const releaseBase = 'https://github.com/tommy0103/obelisk/releases/latest/download';
export async function createMacUpdateBackend(receive: (event: UpdateEvent) => void,
  { resourcesPath = process.resourcesPath, log = console.warn }: { resourcesPath?: string; log?: (message: string) => void } = {},
): Promise<UpdateBackend> {
  // Select once, before checking. Feed/download/signature failures never switch
  // to another backend, which would weaken the selected verifier's boundary.
  let bridge: ReturnType<typeof loadSparkleBridge> = null;
  let failedAt = 0;
  let active = true;
  try {
    bridge = loadSparkleBridge({ isPackaged: true, resourcesPath, log });
    if (bridge) {
      bridge.setEventHandler(event => {
        const types = { checking: 'checking', 'update-available': 'available', 'download-progress': 'progress',
          'update-downloaded': 'downloaded', 'update-not-available': 'current', error: 'error' } as const;
        const type = types[event.type as keyof typeof types];
        if (type === 'error') failedAt = Date.now();
        if (type) receive({ type, version: event.version, releaseNotes: event.releaseNotes, percent: event.percent, message: event.message });
      });
      if (bridge.init({ appcastUrl: `${releaseBase}/appcast-${process.arch}.xml` })) {
        bridge.setAutomaticChecks(true);
        return { kind: 'sparkle', check: async () => {
          // Sparkle reports failure before its native session has dismissed.
          // A same-turn retry is ignored by checkForUpdates; let it settle.
          const remaining = 600 - (Date.now() - failedAt);
          if (remaining > 0) await delay(remaining);
          if (active) bridge!.checkForUpdates();
        }, install: () => bridge!.installUpdateNow(),
          stop: () => { active = false; bridge!.setAutomaticChecks(false); bridge!.setEventHandler(() => {}); } };
      }
      bridge.setAutomaticChecks(false);
      bridge.setEventHandler(() => {});
    }
  } catch (error) {
    try { bridge?.setAutomaticChecks(false); bridge?.setEventHandler(() => {}); } catch {}
    log(`Sparkle initialization failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  log('Using electron-updater because the Sparkle bridge could not initialize');
  const { autoUpdater } = electronUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.channel = 'latest';
  // The channel setter enables downgrades; keep this override after it.
  autoUpdater.allowDowngrade = false;
  const notes = (value: unknown) => typeof value === 'string' ? value : Array.isArray(value)
    ? value.map(item => typeof item?.note === 'string' ? item.note : '').filter(Boolean).join('\n\n') : '';
  const listeners: [Parameters<typeof autoUpdater.on>[0], (...args: any[]) => void][] = [
    ['checking-for-update', () => receive({ type: 'checking' })],
    ['update-available', info => receive({ type: 'available', version: info.version, releaseNotes: notes(info.releaseNotes) })],
    ['download-progress', info => receive({ type: 'progress', percent: info.percent })],
    ['update-downloaded', info => receive({ type: 'downloaded', version: info.version, releaseNotes: notes(info.releaseNotes) })],
    ['update-not-available', () => receive({ type: 'current' })],
    ['error', error => receive({ type: 'error', message: error.message || String(error) })],
  ];
  for (const [name, listener] of listeners) autoUpdater.on(name, listener);
  return { kind: 'electron-updater', check: () => autoUpdater.checkForUpdates(), install: () => autoUpdater.quitAndInstall(false, true),
    stop: () => { for (const [name, listener] of listeners) autoUpdater.removeListener(name, listener); } };
}
