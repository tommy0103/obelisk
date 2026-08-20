// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import vue from '@vitejs/plugin-vue';
import { coreSchemaAssetPlugin } from './electron-vite.schema-plugin.mjs';

// The app main/preload/renderer are TypeScript + ESM. Each main-process module
// is its own rollup input so it is emitted to out/main/<name>.js and the
// relative imports between them (and `new Worker(__dirname/indexer-worker.js)`)
// resolve to the built .js at runtime.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), coreSchemaAssetPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'file-reference': resolve('src/main/file-reference.ts'),
          indexer: resolve('src/main/indexer.ts'),
          'indexer-service': resolve('src/main/indexer-service.ts'),
          'indexer-worker': resolve('src/main/indexer-worker.ts'),
          'indexer-worker-client': resolve('src/main/indexer-worker-client.ts'),
          'recap-capture-query': resolve('src/main/recap-capture-query.ts'),
          watcher: resolve('src/main/watcher.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // Electron sandbox does not support ESM preload — emit CJS index.js
        // (main loads ../preload/index.js) even though the project is ESM.
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  renderer: {
    plugins: [vue()],
  },
});
