// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Rebuild the sanitized real-Codex fixture from a local rollout with
// structure-preserving, differentiated placeholders. The original source is
// never committed; only the sanitized output is.
//
// Rules:
// - String values at keys `type` and `role` are kept (parser branch fields).
// - Every other string value becomes a stable placeholder `p-NNNN` assigned
//   by first occurrence: the same original string always maps to the same
//   placeholder, a different string to a different one. This preserves the
//   duplicate-pair structure that the canonical event/response dedup and the
//   cross-boundary Bloom check depend on — a uniform "[redacted]" placeholder
//   collapsed all digests and forced every split onto the snapshot path.
// - Numbers become 0; booleans, null, arrays, and object shapes are kept.
//
//   node --experimental-strip-types scripts/sanitize-codex-fixture.mjs \
//     --source ~/.codex/sessions/2026/.../rollout-....jsonl \
//     --lines 120 --prefix 60 \
//     --out-full tests/fixtures/codex/real-rollout-structural-sanitized.jsonl \
//     --out-prefix tests/fixtures/codex/real-rollout-structural-sanitized-prefix.jsonl

import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const source = flag('source');
const lineCount = Number(flag('lines') ?? 120);
const prefixCount = flag('prefix') !== undefined ? Number(flag('prefix')) : undefined;
const outFull = flag('out-full');
const outPrefix = flag('out-prefix');
if (!source || !outFull || (prefixCount !== undefined && !outPrefix)) {
  throw new Error('usage: --source <rollout.jsonl> --out-full <path> [--lines 120] [--prefix 60 --out-prefix <path>]');
}

const placeholderByValue = new Map();
function sanitize(value, key) {
  if (Array.isArray(value)) return value.map(item => sanitize(item));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [entryKey, entryValue] of Object.entries(value)) out[entryKey] = sanitize(entryValue, entryKey);
    return out;
  }
  if (typeof value === 'string') {
    if (key === 'type' || key === 'role') return value;
    if (value === '') return '';
    let placeholder = placeholderByValue.get(value);
    if (placeholder === undefined) {
      placeholder = `p-${String(placeholderByValue.size + 1).padStart(4, '0')}`;
      placeholderByValue.set(value, placeholder);
    }
    return placeholder;
  }
  if (typeof value === 'number') return 0;
  return value;
}

const lines = readFileSync(source, 'utf8').split('\n').filter(Boolean);
if (lines.length < lineCount) throw new Error(`source has ${lines.length} lines, need at least ${lineCount}`);
const sanitized = lines.slice(0, lineCount).map(line => JSON.stringify(sanitize(JSON.parse(line))));
writeFileSync(outFull, `${sanitized.join('\n')}\n`);
if (prefixCount !== undefined) {
  if (!Number.isInteger(prefixCount) || prefixCount < 1 || prefixCount >= lineCount) {
    throw new Error(`--prefix must be an integer within (0, ${lineCount})`);
  }
  writeFileSync(outPrefix, `${sanitized.slice(0, prefixCount).join('\n')}\n`);
}
console.log(`wrote ${sanitized.length} lines to ${outFull}`
  + `${prefixCount !== undefined ? ` and ${prefixCount} prefix lines to ${outPrefix}` : ''}`
  + ` (${placeholderByValue.size} distinct placeholders)`);
