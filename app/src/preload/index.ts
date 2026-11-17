// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { contextBridge, ipcRenderer } from 'electron';
import { createObeliskApi } from './obelisk-api.ts';

contextBridge.exposeInMainWorld('obelisk', createObeliskApi(ipcRenderer, process.platform));
