// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { parentPort } from 'node:worker_threads';
import { buildIndex } from './indexer.ts';

if (!parentPort) throw new Error('indexer-worker must run as a worker thread');
const port = parentPort;

port.on('message', ({ id, args }: { id: number; args?: Record<string, unknown> }) => {
  try {
    const result = buildIndex(args || {});
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
