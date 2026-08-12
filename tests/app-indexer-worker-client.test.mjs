// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
import { createWorkerBuildIndex } from '../app/src/main/indexer-worker-client.ts';

test('worker build client resolves build results from a worker thread', async () => {
  const instances = [];
  class MockWorker {
    constructor(workerPath) {
      this.workerPath = workerPath;
      this.handlers = {};
      this.messages = [];
      this.terminated = false;
      instances.push(this);
    }

    on(event, handler) {
      this.handlers[event] = handler;
      return this;
    }

    postMessage(message) {
      this.messages.push(message);
      queueMicrotask(() => {
        this.handlers.message({
          id: message.id,
          result: { files: 1, reason: message.args.reason },
        });
      });
    }

    terminate() {
      this.terminated = true;
    }
  }

  const client = createWorkerBuildIndex({ WorkerImpl: MockWorker, workerPath: '/tmp/indexer-worker.js' });
  const result = await client.buildIndex({ reason: 'watch' });

  assert.equal(instances.length, 1);
  assert.equal(instances[0].workerPath, '/tmp/indexer-worker.js');
  assert.deepEqual(result, { files: 1, reason: 'watch' });

  client.stop();
  assert.equal(instances[0].terminated, true);
});

test('worker build client rejects pending builds when worker exits cleanly', async () => {
  class MockWorker {
    constructor() {
      this.handlers = {};
    }

    on(event, handler) {
      this.handlers[event] = handler;
      return this;
    }

    postMessage() {
      queueMicrotask(() => {
        this.handlers.exit(0);
      });
    }
  }

  const client = createWorkerBuildIndex({ WorkerImpl: MockWorker, workerPath: '/tmp/indexer-worker.js' });

  await assert.rejects(
    client.buildIndex({ reason: 'startup' }),
    /Indexer worker exited with code 0/,
  );
});
