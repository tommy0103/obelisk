// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import path from 'node:path';

function cleanRecapFilename(filename?: string | null): string {
  if (!filename) return '';
  return path.basename(String(filename));
}

interface RecapExportQueryOptions {
  cardIdx?: number | string;
  archetype?: string;
  filename?: string;
}

function buildRecapExportQuery({ cardIdx = 0, archetype = '', filename = '' }: RecapExportQueryOptions = {}): string {
  const params = new URLSearchParams();
  const cardNumber = Number(cardIdx);
  params.set('card', Number.isFinite(cardNumber) ? String(cardNumber) : '0');
  if (archetype) params.set('arch', String(archetype));
  const safeFilename = cleanRecapFilename(filename);
  if (safeFilename) params.set('file', safeFilename);
  return params.toString();
}

export { buildRecapExportQuery, cleanRecapFilename };
