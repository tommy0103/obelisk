// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  SessionPatch,
  SessionPatchCursor,
  UsageStatsOptions,
} from '../shared/ipc-types.ts';

contextBridge.exposeInMainWorld('obelisk', {
  getSessions: (opts?: unknown) => ipcRenderer.invoke('db:getSessions', opts),
  getSessionMessages: (id: string) => ipcRenderer.invoke('db:getSessionMessages', id),
  getSessionToolCalls: (id: string) => ipcRenderer.invoke('db:getSessionToolCalls', id),
  getSessionToolResults: (id: string) => ipcRenderer.invoke('db:getSessionToolResults', id),
  getSessionPatch: (id: string, cursor: SessionPatchCursor): Promise<SessionPatch | null> => (
    ipcRenderer.invoke('db:getSessionPatch', id, cursor)
  ),
  getSessionSubagents: (id: string) => ipcRenderer.invoke('db:getSessionSubagents', id),
  getSessionWorkflows: (id: string) => ipcRenderer.invoke('db:getSessionWorkflows', id),
  getSubagentMessages: (agentId: string) => ipcRenderer.invoke('db:getSubagentMessages', agentId),
  getSubagentToolCalls: (agentId: string) => ipcRenderer.invoke('db:getSubagentToolCalls', agentId),
  getSubagentToolResults: (agentId: string) => ipcRenderer.invoke('db:getSubagentToolResults', agentId),
  getSessionSummaries: (id: string) => ipcRenderer.invoke('db:getSessionSummaries', id),
  getMessageFullText: (uuid: string) => ipcRenderer.invoke('db:getMessageFullText', uuid),
  getMemories: () => ipcRenderer.invoke('db:getMemories'),
  readMemoryFile: (path: string) => ipcRenderer.invoke('db:readMemoryFile', path),
  openFileReference: (ref: { sessionId?: string | null; path: string; cwd?: string | null; line?: number | null; column?: number | null }) =>
    ipcRenderer.invoke('file-ref:open', ref),
  archiveMemory: (id: string, reason?: string) => ipcRenderer.invoke('db:archiveMemory', id, reason),
  restoreMemory: (id: string) => ipcRenderer.invoke('db:restoreMemory', id),
  getProjects: () => ipcRenderer.invoke('db:getProjects'),
  getStats: () => ipcRenderer.invoke('db:getStats'),
  getUsageStats: (opts?: UsageStatsOptions) => ipcRenderer.invoke('db:getUsageStats', opts),
  onIndexUpdated: (callback: (payload: unknown) => void) => {
    const listener = (_: IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on('obelisk:index-updated', listener);
    return () => ipcRenderer.removeListener('obelisk:index-updated', listener);
  },
  onSessionUpdated: (callback: (payload: unknown) => void) => {
    const listener = (_: IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on('obelisk:session-updated', listener);
    return () => ipcRenderer.removeListener('obelisk:session-updated', listener);
  },
  captureExport: (opts?: unknown) => ipcRenderer.invoke('capture:export', opts),
  copyImage: (opts?: unknown) => ipcRenderer.invoke('capture:copy', opts),
  recapList: () => ipcRenderer.invoke('recap:list'),
  recapRead: (filename: string) => ipcRenderer.invoke('recap:read', filename),
  onRecapUpdated: (callback: (filePath: unknown) => void) => {
    const listener = (_: IpcRendererEvent, filePath: unknown) => callback(filePath);
    ipcRenderer.on('obelisk:recap-updated', listener);
    return () => ipcRenderer.removeListener('obelisk:recap-updated', listener);
  },
  getSettings: () => ipcRenderer.invoke('settings:get'),
  browseFolder: () => ipcRenderer.invoke('settings:browseFolder'),
  setSetting: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', key, value),
  revealPath: (p: string) => ipcRenderer.invoke('settings:revealPath', p),
  rebuildIndex: () => ipcRenderer.invoke('settings:rebuildIndex'),
});
