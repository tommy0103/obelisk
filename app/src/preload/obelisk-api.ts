// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import type { UpdateState } from '../shared/update-types.ts';
import type {
  SessionPatch,
  SessionPatchCursor,
  SessionCatalogueOptions,
  ActivitySessionsOptions,
  SessionsQueryOptions,
  SourceQueryOptions,
  UsageStatsOptions,
  WindowControlAction,
  WindowState,
  SessionUpdatedEvent,
} from '../shared/ipc-types.ts';

// The preload bridge without Electron imports, so the renderer can type
// window.obelisk without pulling Node globals into its program.
interface IpcBridge {
  invoke(channel: string, ...args: unknown[]): Promise<any>;
  on(channel: string, listener: (event: unknown, ...args: any[]) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, ...args: any[]) => void): unknown;
}

export function createObeliskApi(ipc: IpcBridge, platform: string) {
  return {
    platform,
    getUpdateState: (): Promise<UpdateState> => ipc.invoke('updates:getState'),
    checkForUpdates: (): Promise<UpdateState> => ipc.invoke('updates:check'),
    installUpdate: (): Promise<void> => ipc.invoke('updates:install'),
    onUpdateState: (callback: (state: UpdateState) => void) => {
      const listener = (_: unknown, state: UpdateState) => callback(state);
      ipc.on('obelisk:update-state', listener);
      return () => ipc.removeListener('obelisk:update-state', listener);
    },
    getSessions: (opts?: SessionsQueryOptions) => ipc.invoke('db:getSessions', opts),
    getSessionCatalogue: (opts?: SessionCatalogueOptions) => ipc.invoke('db:getSessionCatalogue', opts),
    getActivitySessions: (opts: ActivitySessionsOptions) => ipc.invoke('db:getActivitySessions', opts),
    getSessionMessages: (id: string) => ipc.invoke('db:getSessionMessages', id),
    getSessionToolCalls: (id: string) => ipc.invoke('db:getSessionToolCalls', id),
    getSessionToolResults: (id: string) => ipc.invoke('db:getSessionToolResults', id),
    getSessionPatch: async (id: string, cursor: SessionPatchCursor | string): Promise<SessionPatch | null> => (
      ipc.invoke('db:getSessionPatch', id, typeof cursor === 'string' ? JSON.parse(cursor) : cursor)
    ),
    getSessionSubagents: (id: string) => ipc.invoke('db:getSessionSubagents', id),
    getSessionWorkflows: (id: string) => ipc.invoke('db:getSessionWorkflows', id),
    getSubagentMessages: (agentId: string) => ipc.invoke('db:getSubagentMessages', agentId),
    getSubagentToolCalls: (agentId: string) => ipc.invoke('db:getSubagentToolCalls', agentId),
    getSubagentToolResults: (agentId: string) => ipc.invoke('db:getSubagentToolResults', agentId),
    getSessionSummaries: (id: string) => ipc.invoke('db:getSessionSummaries', id),
    getMessageFullText: (uuid: string) => ipc.invoke('db:getMessageFullText', uuid),
    getMemories: () => ipc.invoke('db:getMemories'),
    readMemoryFile: (path: string) => ipc.invoke('db:readMemoryFile', path),
    openFileReference: (ref: { sessionId?: string | null; path: string; cwd?: string | null; line?: number | null; column?: number | null }) =>
      ipc.invoke('file-ref:open', ref),
    archiveMemory: (id: string, reason?: string) => ipc.invoke('db:archiveMemory', id, reason),
    restoreMemory: (id: string) => ipc.invoke('db:restoreMemory', id),
    getProjects: (opts?: SourceQueryOptions) => ipc.invoke('db:getProjects', opts),
    getStats: (opts?: SourceQueryOptions) => ipc.invoke('db:getStats', opts),
    getUsageStats: (opts?: UsageStatsOptions) => ipc.invoke('db:getUsageStats', opts),
    onWindowState: (callback: (payload: WindowState) => void) => {
      const listener = (_: unknown, payload: WindowState) => callback(payload);
      ipc.on('obelisk:window-state', listener);
      return () => ipc.removeListener('obelisk:window-state', listener);
    },
    onIndexUpdated: (callback: (payload: unknown) => void) => {
      const listener = (_: unknown, payload: unknown) => callback(payload);
      ipc.on('obelisk:index-updated', listener);
      return () => ipc.removeListener('obelisk:index-updated', listener);
    },
    onSessionUpdated: (callback: (payload: SessionUpdatedEvent) => void) => {
      const listener = (_: unknown, payload: SessionUpdatedEvent) => callback(payload);
      ipc.on('obelisk:session-updated', listener);
      return () => ipc.removeListener('obelisk:session-updated', listener);
    },
    windowControl: (action: WindowControlAction) => ipc.invoke('win:control', action),
    captureExport: (opts?: unknown) => ipc.invoke('capture:export', opts),
    copyImage: (opts?: unknown) => ipc.invoke('capture:copy', opts),
    recapList: () => ipc.invoke('recap:list'),
    recapRead: (filename: string) => ipc.invoke('recap:read', filename),
    onRecapUpdated: (callback: (filePath: string) => void) => {
      const listener = (_: unknown, filePath: string) => callback(filePath);
      ipc.on('obelisk:recap-updated', listener);
      return () => ipc.removeListener('obelisk:recap-updated', listener);
    },
    getSettings: () => ipc.invoke('settings:get'),
    browseFolder: () => ipc.invoke('settings:browseFolder'),
    setSetting: (key: string, value: unknown) => ipc.invoke('settings:set', key, value),
    revealPath: (p: string) => ipc.invoke('settings:revealPath', p),
    rebuildIndex: () => ipc.invoke('settings:rebuildIndex'),
  };
}

export type ObeliskApi = ReturnType<typeof createObeliskApi>;
