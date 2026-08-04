import { fileURLToPath, URL } from 'node:url';

import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

import anchorCheck from './plugins/anchor-check.mjs';
import bookMarkdown from './plugins/book-markdown.mjs';

const src = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
  // Relative base so the built site works from a subdirectory or from file://.
  base: './',
  plugins: [vue(), bookMarkdown(), anchorCheck(`${src}/chapters`)],
  resolve: {
    alias: { '@': src },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 900,
  },
});
