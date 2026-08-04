import { performance } from 'node:perf_hooks';
import { closeSync, mkdtempSync, openSync, rmSync, statSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { parse } from '../packages/core/src/providers/codex.ts';

function option(name, fallback = null) {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find(value => value.startsWith(prefix));
  return argument === undefined ? fallback : argument.slice(prefix.length);
}

function positiveInteger(name, fallback) {
  const value = Number(option(name, String(fallback)));
  if (!Number.isInteger(value) || value <= 0) throw new Error(`--${name} must be a positive integer`);
  return value;
}

function syntheticFixture(compactionMb, compactions) {
  const dir = mkdtempSync(join(tmpdir(), 'obelisk-codex-bench-'));
  const path = join(dir, 'rollout.jsonl');
  const id = '019eb000-0000-7000-8000-000000000001';
  const fd = openSync(path, 'w');
  const repeatedChunk = 'x'.repeat(64 * 1024);
  const contextBytes = compactionMb * 1024 * 1024;
  const writeLine = value => writeSync(fd, `${JSON.stringify(value)}\n`);
  try {
    writeLine({
      type: 'session_meta',
      timestamp: '2026-08-04T00:00:00Z',
      payload: { id, timestamp: '2026-08-04T00:00:00Z', cwd: '/benchmark' },
    });
    for (let index = 0; index < compactions; index++) {
      writeLine({
        type: 'event_msg',
        timestamp: `2026-08-04T00:00:${String(index).padStart(2, '0')}Z`,
        payload: { type: 'user_message', message: `evidence ${index}` },
      });
      const timestamp = `2026-08-04T00:01:${String(index).padStart(2, '0')}Z`;
      writeSync(fd, `{"type":"compacted","timestamp":${JSON.stringify(timestamp)},"payload":{"message":${JSON.stringify(`summary ${index}`)},"replacement_history":[{"type":"message","role":"developer","content":[{"type":"input_text","text":"`);
      let remaining = contextBytes;
      while (remaining >= repeatedChunk.length) {
        writeSync(fd, repeatedChunk);
        remaining -= repeatedChunk.length;
      }
      if (remaining > 0) writeSync(fd, repeatedChunk.slice(0, remaining));
      writeSync(fd, `"}]}],"window_number":${index + 1},"previous_window_id":${JSON.stringify(index === 0 ? null : `window-${index - 1}`)},"window_id":${JSON.stringify(`window-${index}`)}}}\n`);
    }
  } finally {
    closeSync(fd);
  }
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const requestedFile = option('file');
const fixture = requestedFile === null
  ? syntheticFixture(positiveInteger('compaction-mb', 28), positiveInteger('compactions', 1))
  : { path: resolve(requestedFile), cleanup: () => {} };

try {
  globalThis.gc?.();
  const memoryBefore = process.memoryUsage();
  const started = performance.now();
  const counts = {};
  let records = 0;
  const generator = parse({ key: fixture.path, sessionId: '' }, null);
  let step = generator.next();
  while (!step.done) {
    records++;
    counts[step.value.kind] = (counts[step.value.kind] ?? 0) + 1;
    step = generator.next();
  }
  const elapsedMs = performance.now() - started;
  const memoryBeforeGc = process.memoryUsage();
  globalThis.gc?.();
  const memoryAfterGc = process.memoryUsage();
  const bytes = statSync(fixture.path).size;
  process.stdout.write(`${JSON.stringify({
    fileBytes: bytes,
    elapsedMs: Math.round(elapsedMs * 100) / 100,
    throughputMiBps: Math.round((bytes / 1024 / 1024) / (elapsedMs / 1000) * 100) / 100,
    rssBeforeMiB: Math.round(memoryBefore.rss / 1024 / 1024 * 100) / 100,
    rssBeforeGcMiB: Math.round(memoryBeforeGc.rss / 1024 / 1024 * 100) / 100,
    rssAfterGcMiB: Math.round(memoryAfterGc.rss / 1024 / 1024 * 100) / 100,
    heapUsedBeforeMiB: Math.round(memoryBefore.heapUsed / 1024 / 1024 * 100) / 100,
    heapUsedBeforeGcMiB: Math.round(memoryBeforeGc.heapUsed / 1024 / 1024 * 100) / 100,
    heapUsedAfterGcMiB: Math.round(memoryAfterGc.heapUsed / 1024 / 1024 * 100) / 100,
    maxRssMiB: Math.round(process.resourceUsage().maxRSS / 1024 * 100) / 100,
    records,
    counts,
    cursor: step.value,
  })}\n`);
} finally {
  fixture.cleanup();
}
