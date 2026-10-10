// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

export type UpdatePhase = 'disabled' | 'idle' | 'checking' | 'current' | 'downloading' | 'ready' | 'preparing' | 'installing' | 'error';
export interface UpdateState {
  revision: number;
  phase: UpdatePhase;
  backend: 'sparkle' | 'electron-updater' | null;
  currentVersion: string;
  version: string | null;
  releaseNotes: string;
  progress: number | null;
  error: string | null;
  lastChecked: string | null;
}
export interface UpdateEvent {
  type: 'checking' | 'available' | 'progress' | 'downloaded' | 'current' | 'error';
  version?: string;
  releaseNotes?: string;
  percent?: number;
  message?: string;
}
export interface UpdateBackend {
  kind: 'sparkle' | 'electron-updater';
  check(): Promise<unknown> | void;
  install(): Promise<unknown> | void;
  stop(): void;
}
