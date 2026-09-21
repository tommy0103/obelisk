// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const DEFAULT_SCHEMA_URL = new URL('../packages/core/src/schema.sql', import.meta.url);

export function coreSchemaAssetPlugin({ schemaUrl = DEFAULT_SCHEMA_URL } = {}) {
  const schemaPath = fileURLToPath(schemaUrl);
  return {
    name: 'obelisk-core-schema-asset',
    buildStart() {
      this.addWatchFile(schemaPath);
    },
    async generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'schema.sql',
        source: await readFile(schemaUrl, 'utf8'),
      });
    },
  };
}
