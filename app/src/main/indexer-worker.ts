// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { parentPort } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { buildIndex } from './indexer.ts';
import { createHermesProvider } from '../../../packages/core/src/providers/hermes.ts';
import { createZcodeProvider } from '../../../packages/core/src/providers/zcode.ts';
import type { RawLookup } from '../../../packages/core/src/providers/types.ts';

if (!parentPort) throw new Error('indexer-worker must run as a worker thread');
const port = parentPort;
const hermesProvider = createHermesProvider({
  openStore: sourcePath => new Database(sourcePath, { readonly: true, fileMustExist: true }),
});
const zcodeProvider = createZcodeProvider({
  openDatabase: sourcePath => new Database(sourcePath, {
    readonly: true,
    fileMustExist: true,
    timeout: 500,
  }),
});

port.on('message', ({ id, operation, args }: { id: number; operation?: string; args?: Record<string, unknown> }) => {
  try {
    const result = operation === 'readHermesMessageText'
      ? hermesProvider.raw(args as unknown as RawLookup)?.messageText ?? null
      : operation === 'readZcodeMessageText'
        ? zcodeProvider.raw(args as unknown as RawLookup)?.messageText ?? null
        : buildIndex(args || {});
    port.postMessage({ id, result });
  } catch (error) {
    port.postMessage({
      id,
      error: {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
    });
  }
});
