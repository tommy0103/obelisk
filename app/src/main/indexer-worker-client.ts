// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface WorkerMessage {
  id: number;
  result?: unknown;
  error?: { message: string; stack?: string };
}

interface PendingBuild {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface WorkerBuildIndexOptions {
  workerPath?: string;
  WorkerImpl?: typeof Worker;
}

function createWorkerBuildIndex({
  // indexer-worker.js is the built worker output emitted next to this module.
  workerPath = path.join(__dirname, 'indexer-worker.js'),
  WorkerImpl = Worker,
}: WorkerBuildIndexOptions = {}) {
  let worker: Worker | null = null;
  let nextId = 1;
  const pending = new Map<number, PendingBuild>();

  const rejectPending = (error: Error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };

  const ensureWorker = (): Worker => {
    if (worker) return worker;
    const active = new WorkerImpl(workerPath, { type: 'module' } as ConstructorParameters<typeof Worker>[1]);
    worker = active;
    active.on('message', (message: WorkerMessage) => {
      const current = pending.get(message.id);
      if (!current) return;
      pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message);
        error.stack = message.error.stack;
        current.reject(error);
      } else {
        current.resolve(message.result);
      }
    });
    active.on('error', (error: Error) => {
      rejectPending(error);
      worker = null;
    });
    active.on('exit', (code: number) => {
      if (pending.size) rejectPending(new Error(`Indexer worker exited with code ${code}`));
      worker = null;
    });
    return active;
  };

  const buildIndex = (args: Record<string, unknown> = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ensureWorker().postMessage({ id, args });
  });

  const stop = () => {
    const current = worker;
    worker = null;
    const termination = current?.terminate ? Promise.resolve(current.terminate()) : Promise.resolve();
    rejectPending(new Error('Indexer worker stopped'));
    return termination;
  };

  return { buildIndex, stop };
}

export { createWorkerBuildIndex };
